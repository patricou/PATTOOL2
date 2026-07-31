import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslateModule } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { HttpClient } from '@angular/common/http';

import { ApiService, BookItem, BookSection } from '../services/api.service';

type BookSource = 'openlibrary' | 'gutenberg' | 'librivox';

@Component({
  selector: 'app-book-watcher',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './book-watcher.component.html',
  styleUrls: ['./book-watcher.component.css']
})
export class BookWatcherComponent implements OnInit, OnDestroy {
  @ViewChild('audioEl') audioEl?: ElementRef<HTMLAudioElement>;
  @ViewChild('readerEl') readerEl?: ElementRef<HTMLElement>;
  @ViewChild('readerStage') readerStage?: ElementRef<HTMLElement>;

  source: BookSource = 'openlibrary';
  query = '';
  authorQuery = '';
  language = '';
  languageOptions: Array<{ value: string; label: string }> = [];
  genre = '';
  /** Stable list — labels via i18n keys BOOK.GENRE_* */
  readonly genreOptions: Array<{ value: string; labelKey: string }> = [
    { value: 'adventure', labelKey: 'BOOK.GENRE_ADVENTURE' },
    { value: 'mystery', labelKey: 'BOOK.GENRE_MYSTERY' },
    { value: 'crime', labelKey: 'BOOK.GENRE_CRIME' },
    { value: 'scifi', labelKey: 'BOOK.GENRE_SCIFI' },
    { value: 'fantasy', labelKey: 'BOOK.GENRE_FANTASY' },
    { value: 'romance', labelKey: 'BOOK.GENRE_ROMANCE' },
    { value: 'horror', labelKey: 'BOOK.GENRE_HORROR' },
    { value: 'thriller', labelKey: 'BOOK.GENRE_THRILLER' },
    { value: 'history', labelKey: 'BOOK.GENRE_HISTORY' },
    { value: 'historical', labelKey: 'BOOK.GENRE_HISTORICAL' },
    { value: 'poetry', labelKey: 'BOOK.GENRE_POETRY' },
    { value: 'children', labelKey: 'BOOK.GENRE_CHILDREN' },
    { value: 'biography', labelKey: 'BOOK.GENRE_BIOGRAPHY' },
    { value: 'philosophy', labelKey: 'BOOK.GENRE_PHILOSOPHY' },
    { value: 'humor', labelKey: 'BOOK.GENRE_HUMOR' },
    { value: 'war', labelKey: 'BOOK.GENRE_WAR' },
    { value: 'western', labelKey: 'BOOK.GENRE_WESTERN' },
    { value: 'drama', labelKey: 'BOOK.GENRE_DRAMA' },
    { value: 'fairy', labelKey: 'BOOK.GENRE_FAIRY' },
    { value: 'mythology', labelKey: 'BOOK.GENRE_MYTHOLOGY' }
  ];

  books: BookItem[] = [];
  total = 0;
  offset = 0;
  page = 1;
  readonly pageSize = 20;

  selected: BookItem | null = null;
  selectedSection: BookSection | null = null;

  isLoading = false;
  isLoadingContent = false;
  isLoadingAudio = false;
  listError = '';
  contentError = '';
  playError = '';

  readerMode: 'text' | 'html' | 'iframe' | 'audio' | 'none' = 'none';
  readerText = '';
  readerHtmlUrl: SafeResourceUrl | null = null;
  private lastIframeUrl = '';
  audioUrl = '';
  isPlaying = false;

  isFullscreen = false;
  readonly speechSupported =
    typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined';
  isSpeaking = false;
  isSpeechPaused = false;
  isPreparingSpeech = false;
  speechError = '';
  private speechChunks: string[] = [];
  private speechChunkIndex = 0;
  private ttsText = '';

  private search$ = new Subject<string>();
  private searchSub?: Subscription;
  private listSub?: Subscription;
  private contentSub?: Subscription;
  private ttsSub?: Subscription;

  constructor(
    private api: ApiService,
    private http: HttpClient,
    private sanitizer: DomSanitizer
  ) {}

  ngOnInit(): void {
    this.refreshLanguageOptions();
    if (this.speechSupported) {
      // Chrome loads voices asynchronously.
      window.speechSynthesis.getVoices();
    }
    this.searchSub = this.search$.pipe(debounceTime(400), distinctUntilChanged()).subscribe(() => {
      this.offset = 0;
      this.page = 1;
      this.loadBooks();
    });
    if (this.source === 'openlibrary') {
      this.query = 'shakespeare';
    }
    this.loadBooks();
  }

  ngOnDestroy(): void {
    this.searchSub?.unsubscribe();
    this.listSub?.unsubscribe();
    this.contentSub?.unsubscribe();
    this.ttsSub?.unsubscribe();
    this.stopSpeech();
    this.stopAudio();
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    }
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    const stage = this.readerStage?.nativeElement;
    this.isFullscreen = !!stage && document.fullscreenElement === stage;
  }

  get canSpeak(): boolean {
    if (!this.speechSupported || !this.selected) {
      return false;
    }
    if (this.readerMode === 'audio' || this.readerMode === 'none') {
      return false;
    }
    return true;
  }

  async toggleFullscreen(): Promise<void> {
    const stage = this.readerStage?.nativeElement;
    if (!stage) {
      return;
    }
    try {
      if (!document.fullscreenElement) {
        const anyEl = stage as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
        if (stage.requestFullscreen) {
          await stage.requestFullscreen();
        } else if (anyEl.webkitRequestFullscreen) {
          await Promise.resolve(anyEl.webkitRequestFullscreen());
        }
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // Browser denied fullscreen — ignore.
    }
  }

  toggleSpeech(): void {
    if (!this.speechSupported) {
      this.speechError = 'BOOK.ERR_SPEECH_UNSUPPORTED';
      return;
    }
    this.speechError = '';
    if (this.isSpeaking && !this.isSpeechPaused) {
      window.speechSynthesis.pause();
      this.isSpeechPaused = true;
      return;
    }
    if (this.isSpeaking && this.isSpeechPaused) {
      window.speechSynthesis.resume();
      this.isSpeechPaused = false;
      return;
    }
    void this.startSpeech();
  }

  stopSpeech(): void {
    this.ttsSub?.unsubscribe();
    this.isPreparingSpeech = false;
    if (this.speechSupported) {
      window.speechSynthesis.cancel();
    }
    this.isSpeaking = false;
    this.isSpeechPaused = false;
    this.speechChunks = [];
    this.speechChunkIndex = 0;
  }

  private async startSpeech(): Promise<void> {
    const text = await this.resolveSpeechText();
    if (!text?.trim()) {
      this.speechError = 'BOOK.ERR_SPEECH_NO_TEXT';
      return;
    }
    if (this.speechSupported) {
      window.speechSynthesis.cancel();
    }
    this.speechChunks = this.chunkTextForSpeech(text);
    this.speechChunkIndex = 0;
    if (!this.speechChunks.length) {
      this.speechError = 'BOOK.ERR_SPEECH_NO_TEXT';
      return;
    }
    this.isSpeaking = true;
    this.isSpeechPaused = false;
    this.speakNextChunk();
  }

  private async resolveSpeechText(): Promise<string> {
    if (this.readerText.trim()) {
      return this.readerText;
    }
    if (this.ttsText.trim()) {
      return this.ttsText;
    }
    const url = this.selected?.textUrl?.trim();
    if (!url) {
      return '';
    }
    this.isPreparingSpeech = true;
    try {
      const proxy = this.api.bookContentProxyUrl(url);
      const body = await new Promise<string>((resolve, reject) => {
        this.ttsSub?.unsubscribe();
        this.ttsSub = this.http.get(proxy, { responseType: 'text' }).subscribe({
          next: (t) => resolve(t || ''),
          error: (err) => reject(err)
        });
      });
      if (!body.trim()) {
        return '';
      }
      if (this.looksLikeHtmlOrCss(body)) {
        const plain = this.htmlToPlainText(body);
        if (plain.length < 400) {
          return '';
        }
        this.ttsText = plain;
        return plain;
      }
      this.ttsText = body;
      return body;
    } catch {
      return '';
    } finally {
      this.isPreparingSpeech = false;
    }
  }

  private htmlToPlainText(html: string): string {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('script, style, noscript, svg').forEach((n) => n.remove());
      const text = doc.body?.textContent || '';
      return text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    } catch {
      return '';
    }
  }

  private chunkTextForSpeech(text: string): string[] {
    const cleaned = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!cleaned) {
      return [];
    }
    const maxLen = 1400;
    const chunks: string[] = [];
    let remaining = cleaned;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      let cut = remaining.lastIndexOf('\n\n', maxLen);
      if (cut < maxLen * 0.4) {
        cut = remaining.lastIndexOf('. ', maxLen);
        if (cut >= maxLen * 0.4) {
          cut += 1;
        }
      }
      if (cut < maxLen * 0.4) {
        cut = remaining.lastIndexOf(' ', maxLen);
      }
      if (cut < maxLen * 0.3) {
        cut = maxLen;
      }
      chunks.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    return chunks.filter((c) => c.length > 0);
  }

  private speakNextChunk(): void {
    if (!this.speechSupported || this.speechChunkIndex >= this.speechChunks.length) {
      this.isSpeaking = false;
      this.isSpeechPaused = false;
      return;
    }
    const utter = new SpeechSynthesisUtterance(this.speechChunks[this.speechChunkIndex]);
    utter.lang = this.speechLang();
    utter.rate = 1;
    const voice = this.pickVoice(utter.lang);
    if (voice) {
      utter.voice = voice;
    }
    utter.onend = () => {
      this.speechChunkIndex += 1;
      this.speakNextChunk();
    };
    utter.onerror = () => {
      this.isSpeaking = false;
      this.isSpeechPaused = false;
      this.speechError = 'BOOK.ERR_SPEECH';
    };
    window.speechSynthesis.speak(utter);
  }

  private speechLang(): string {
    const raw = (this.selected?.language || this.language || '').toLowerCase();
    if (raw.startsWith('fr') || raw === 'fre') {
      return 'fr-FR';
    }
    if (raw.startsWith('de') || raw === 'ger' || raw === 'deu') {
      return 'de-DE';
    }
    if (raw.startsWith('es') || raw === 'spa') {
      return 'es-ES';
    }
    if (raw.startsWith('it') || raw === 'ita') {
      return 'it-IT';
    }
    if (raw.startsWith('en') || raw === 'eng') {
      return 'en-US';
    }
    // Default: UI language guess from browser
    const nav = (navigator.language || 'en').toLowerCase();
    if (nav.startsWith('fr')) {
      return 'fr-FR';
    }
    if (nav.startsWith('de')) {
      return 'de-DE';
    }
    return 'en-US';
  }

  private pickVoice(lang: string): SpeechSynthesisVoice | null {
    try {
      const voices = window.speechSynthesis.getVoices() || [];
      const prefix = lang.slice(0, 2).toLowerCase();
      return (
        voices.find((v) => v.lang?.toLowerCase() === lang.toLowerCase()) ||
        voices.find((v) => v.lang?.toLowerCase().startsWith(prefix)) ||
        null
      );
    } catch {
      return null;
    }
  }

  setSource(source: BookSource): void {
    if (this.source === source) {
      return;
    }
    this.source = source;
    this.books = [];
    this.total = 0;
    this.offset = 0;
    this.page = 1;
    this.language = '';
    this.listError = '';
    this.clearReader();
    this.refreshLanguageOptions();
    if (!this.query.trim() && !this.genre) {
      if (source === 'openlibrary') {
        this.query = 'hugo';
      } else if (source === 'gutenberg') {
        this.query = 'verne';
      } else {
        this.query = '';
      }
    }
    this.loadBooks();
  }

  onQueryChange(): void {
    this.search$.next(this.searchSignature());
  }

  /** Language / genre changes should reload immediately (not wait for search debounce). */
  onLanguageChange(): void {
    this.offset = 0;
    this.page = 1;
    this.clearReader();
    this.loadBooks();
  }

  onGenreChange(): void {
    this.offset = 0;
    this.page = 1;
    this.clearReader();
    this.loadBooks();
  }

  private searchSignature(): string {
    return [this.source, this.query.trim(), this.authorQuery.trim(), this.language, this.genre].join('\0');
  }

  private refreshLanguageOptions(): void {
    // Stable array identity — recreating options every CD rebinds <select> and loops NG0103.
    if (this.source === 'gutenberg') {
      this.languageOptions = [
        { value: 'en', label: 'English' },
        { value: 'fr', label: 'Français' },
        { value: 'de', label: 'Deutsch' },
        { value: 'es', label: 'Español' },
        { value: 'it', label: 'Italiano' }
      ];
      return;
    }
    this.languageOptions = [
      { value: 'eng', label: 'English' },
      { value: 'fre', label: 'Français' },
      { value: 'ger', label: 'Deutsch' },
      { value: 'spa', label: 'Español' },
      { value: 'ita', label: 'Italiano' }
    ];
  }

  clearSearch(): void {
    this.query = '';
    this.authorQuery = '';
    this.offset = 0;
    this.page = 1;
    this.clearReader();
    // Keep genre/language filters — reload catalog instead of leaving an empty list.
    this.loadBooks();
  }

  loadBooks(): void {
    this.listSub?.unsubscribe();
    const q = this.query.trim();
    const genre = this.genre.trim() || undefined;
    if (this.source === 'librivox') {
      // Empty query browses the LibriVox catalog; title/author search needs ≥2 chars each when set.
    } else if (q.length < 2 && this.source === 'openlibrary' && !genre) {
      this.books = [];
      this.total = 0;
      this.isLoading = false;
      return;
    }
    // Gutenberg: empty query browses popular titles (or by genre)

    this.isLoading = true;
    this.listError = '';

    if (this.source === 'openlibrary') {
      this.listSub = this.api
        .searchOpenLibraryBooks(q, this.pageSize, this.offset, this.language || undefined, genre)
        .subscribe({
          next: (page) => {
            this.books = page.books || [];
            this.total = page.total || 0;
            this.isLoading = false;
          },
          error: () => {
            this.books = [];
            this.total = 0;
            this.isLoading = false;
            this.listError = 'BOOK.ERR_SEARCH';
          }
        });
    } else if (this.source === 'gutenberg') {
      this.listSub = this.api
        .searchGutenbergBooks(q, this.language || undefined, this.page, genre)
        .subscribe({
          next: (page) => {
            this.books = page.books || [];
            this.total = page.total || 0;
            this.offset = page.offset || 0;
            this.isLoading = false;
          },
          error: () => {
            this.books = [];
            this.total = 0;
            this.isLoading = false;
            this.listError = 'BOOK.ERR_SEARCH';
          }
        });
    } else {
      this.listSub = this.api
        .searchLibriVoxBooks(q, this.authorQuery.trim() || undefined, this.pageSize, this.offset, genre)
        .subscribe({
          next: (page) => {
            this.books = page.books || [];
            this.total = page.total || 0;
            this.isLoading = false;
          },
          error: () => {
            this.books = [];
            this.total = 0;
            this.isLoading = false;
            this.listError = 'BOOK.ERR_SEARCH';
          }
        });
    }
  }

  get currentPageLabel(): number {
    if (this.source === 'gutenberg') {
      return this.page;
    }
    return Math.floor(this.offset / this.pageSize) + 1;
  }

  get canPrev(): boolean {
    if (this.source === 'gutenberg') {
      return this.page > 1;
    }
    return this.offset > 0;
  }

  get canNext(): boolean {
    if (this.source === 'gutenberg') {
      return this.offset + this.books.length < this.total;
    }
    return this.offset + this.books.length < this.total;
  }

  prevPage(): void {
    if (!this.canPrev) {
      return;
    }
    if (this.source === 'gutenberg') {
      this.page = Math.max(1, this.page - 1);
    } else {
      this.offset = Math.max(0, this.offset - this.pageSize);
    }
    this.loadBooks();
  }

  nextPage(): void {
    if (!this.canNext) {
      return;
    }
    if (this.source === 'gutenberg') {
      this.page += 1;
    } else {
      this.offset += this.pageSize;
    }
    this.loadBooks();
  }

  selectBook(book: BookItem): void {
    this.clearReader();
    this.selected = book;
    this.playError = '';
    this.contentError = '';

    if (book.source === 'librivox') {
      this.readerMode = 'audio';
      // Prefer detailed fetch for full section list
      if (!book.sections?.length && book.id) {
        this.isLoadingContent = true;
        this.contentSub = this.api.getLibriVoxBook(book.id).subscribe({
          next: (detail) => {
            this.selected = detail;
            this.isLoadingContent = false;
            const first = detail.sections?.[0];
            if (first) {
              this.playSection(first);
            }
          },
          error: () => {
            this.isLoadingContent = false;
            this.contentError = 'BOOK.ERR_DETAIL';
          }
        });
      } else if (book.sections?.length) {
        this.playSection(book.sections[0]);
      }
      return;
    }

    // Text sources: Gutenberg / Open Library
    // Open Library / Archive.org: iframe first — /stream/..._djvu.txt often returns HTML/CSS.
    if (book.source === 'openlibrary') {
      if (book.htmlUrl) {
        this.openIframe(book.htmlUrl);
        return;
      }
      if (book.homepage) {
        this.openIframe(book.homepage);
        return;
      }
      if (book.textUrl) {
        this.loadTextContent(book.textUrl);
        return;
      }
      this.contentError = 'BOOK.ERR_NO_CONTENT';
      this.readerMode = 'none';
      return;
    }

    if (book.textUrl) {
      this.loadTextContent(book.textUrl);
      return;
    }
    if (book.htmlUrl) {
      if (book.source === 'gutenberg') {
        this.loadHtmlContent(book.htmlUrl);
      } else {
        this.openIframe(book.htmlUrl);
      }
      return;
    }
    if (book.homepage) {
      this.openIframe(book.homepage);
      return;
    }
    this.contentError = 'BOOK.ERR_NO_CONTENT';
    this.readerMode = 'none';
  }

  playSection(section: BookSection): void {
    if (!section?.listenUrl) {
      this.playError = 'BOOK.ERR_PLAY';
      return;
    }
    this.stopSpeech();
    this.selectedSection = section;
    this.readerMode = 'audio';
    this.playError = '';
    this.isLoadingAudio = true;
    this.audioUrl = this.api.bookStreamProxyUrl(section.listenUrl);
    setTimeout(() => {
      const audio = this.audioEl?.nativeElement;
      if (!audio) {
        this.isLoadingAudio = false;
        return;
      }
      audio.load();
      audio
        .play()
        .then(() => {
          this.isPlaying = true;
          this.isLoadingAudio = false;
        })
        .catch(() => {
          this.isPlaying = false;
          this.isLoadingAudio = false;
          this.playError = 'BOOK.ERR_PLAY';
        });
    }, 0);
  }

  onAudioPlay(): void {
    this.isPlaying = true;
    this.isLoadingAudio = false;
  }

  onAudioPause(): void {
    this.isPlaying = false;
  }

  onAudioError(): void {
    this.isPlaying = false;
    this.isLoadingAudio = false;
    this.playError = 'BOOK.ERR_PLAY';
  }

  onAudioEnded(): void {
    this.isPlaying = false;
    const sections = this.selected?.sections || [];
    if (!this.selectedSection || !sections.length) {
      return;
    }
    const idx = sections.findIndex((s) => s.id === this.selectedSection?.id);
    if (idx >= 0 && idx + 1 < sections.length) {
      this.playSection(sections[idx + 1]);
    }
  }

  stopAudio(): void {
    const audio = this.audioEl?.nativeElement;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    this.audioUrl = '';
    this.isPlaying = false;
    this.selectedSection = null;
  }

  openExternal(url?: string): void {
    if (!url) {
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  formatDuration(secs?: number): string {
    if (secs == null || secs < 0) {
      return '';
    }
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  trackByBookId(_: number, book: BookItem): string {
    return `${book.source}-${book.id}`;
  }

  trackBySectionId(_: number, section: BookSection): string {
    return section.id || section.listenUrl || section.title || String(_);
  }

  private loadTextContent(url: string): void {
    this.isLoadingContent = true;
    this.contentError = '';
    this.readerMode = 'text';
    this.readerText = '';
    const proxy = this.api.bookContentProxyUrl(url);
    this.contentSub?.unsubscribe();
    this.contentSub = this.http.get(proxy, { responseType: 'text' }).subscribe({
      next: (text) => {
        const body = text || '';
        this.isLoadingContent = false;
        // Archive.org / mislabelled URLs sometimes return an HTML page (CSS/JS) instead of plain text.
        if (this.looksLikeHtmlOrCss(body)) {
          if (this.selected?.htmlUrl) {
            this.openIframe(this.selected.htmlUrl);
          } else if (this.selected?.homepage) {
            this.openIframe(this.selected.homepage);
          } else {
            this.contentError = 'BOOK.ERR_NO_CONTENT';
            this.readerMode = 'none';
          }
          return;
        }
        this.readerText = body;
        this.ttsText = body;
        if (!this.readerText.trim()) {
          this.contentError = 'BOOK.ERR_NO_CONTENT';
        } else {
          setTimeout(() => this.readerEl?.nativeElement?.scrollTo({ top: 0 }), 0);
        }
      },
      error: () => {
        this.isLoadingContent = false;
        if (this.selected?.htmlUrl) {
          this.openIframe(this.selected.htmlUrl);
        } else if (this.selected?.homepage) {
          this.openIframe(this.selected.homepage);
        } else {
          this.contentError = 'BOOK.ERR_CONTENT';
          this.readerMode = 'none';
        }
      }
    });
  }

  /** True when a "text" payload is actually a web page / stylesheet dump. */
  private looksLikeHtmlOrCss(body: string): boolean {
    const sample = (body || '').slice(0, 4000).trim().toLowerCase();
    if (!sample) {
      return false;
    }
    if (sample.startsWith('<!doctype') || sample.startsWith('<html') || sample.startsWith('<head')) {
      return true;
    }
    if (sample.includes('<html') || sample.includes('<style') || sample.includes('<script')) {
      return true;
    }
    // Archive.org stream wrapper often dumps CSS rules like ".media-menu {".
    if (/^\s*\.[a-z0-9_-]+\s*\{/m.test(sample) || sample.includes('{') && sample.includes('}') && sample.includes('overflow')) {
      const cssHits = (sample.match(/\{[^}]*\}/g) || []).length;
      const textLength = sample.replace(/\s+/g, ' ').length;
      if (cssHits >= 3 && textLength < 3500) {
        return true;
      }
    }
    return false;
  }

  private loadHtmlContent(url: string): void {
    // Serve HTML via proxy URL in an iframe (same-origin)
    this.readerMode = 'html';
    this.readerHtmlUrl = this.sanitizer.bypassSecurityTrustResourceUrl(
      this.api.bookContentProxyUrl(url)
    );
    this.isLoadingContent = false;
  }

  private openIframe(url: string): void {
    const target = (url || '').trim();
    if (!target) {
      this.contentError = 'BOOK.ERR_NO_CONTENT';
      this.readerMode = 'none';
      return;
    }
    this.readerMode = 'iframe';
    this.isLoadingContent = false;
    // Avoid new SafeResourceUrl on every call with the same URL (can loop CD with iframe).
    if (this.lastIframeUrl === target && this.readerHtmlUrl) {
      return;
    }
    this.lastIframeUrl = target;
    this.readerHtmlUrl = this.sanitizer.bypassSecurityTrustResourceUrl(target);
  }

  private clearReader(): void {
    this.contentSub?.unsubscribe();
    this.stopSpeech();
    this.stopAudio();
    this.selected = null;
    this.readerMode = 'none';
    this.readerText = '';
    this.ttsText = '';
    this.readerHtmlUrl = null;
    this.lastIframeUrl = '';
    this.contentError = '';
    this.playError = '';
    this.speechError = '';
    this.isLoadingContent = false;
  }
}
