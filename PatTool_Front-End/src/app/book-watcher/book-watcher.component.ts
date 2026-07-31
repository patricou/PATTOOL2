import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml, SafeResourceUrl } from '@angular/platform-browser';
import { TranslateModule } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { HttpClient } from '@angular/common/http';

import { ApiService, BookItem, BookSection } from '../services/api.service';

type BookSource =
  | 'openlibrary'
  | 'gutenberg'
  | 'librivox'
  | 'archive'
  | 'googlebooks'
  | 'standardebooks';

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

  infoBook: BookItem | null = null;
  infoOpen = false;
  isLoadingInfo = false;
  infoError = '';

  isLoading = false;
  isLoadingContent = false;
  isLoadingAudio = false;
  listError = '';
  contentError = '';
  playError = '';

  readerMode: 'text' | 'html' | 'iframe' | 'external' | 'audio' | 'none' = 'none';
  readerText = '';
  readerHtmlUrl: SafeResourceUrl | null = null;
  /** In-page HTML (no iframe — avoids frame-bust that reloads PATTOOL). */
  readerHtmlSafe: SafeHtml | null = null;
  /** Bumps on each iframe navigation so the element is destroyed/recreated (avoids stale IA embed). */
  iframeGen = 0;
  iframeReferrerPolicy: 'no-referrer' | 'strict-origin-when-cross-origin' = 'no-referrer';
  /** Sites that cannot be embedded (framebust / cookies) — open in a new tab via CTA. */
  isArchiveExternal = false;
  externalBookUrl = '';
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
  private infoSub?: Subscription;

  constructor(
    private api: ApiService,
    private http: HttpClient,
    private sanitizer: DomSanitizer,
    private cdr: ChangeDetectorRef
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
    // Defer past the first CD / Forms select bind so ngModel init cannot flip
    // [disabled]="isLoading" mid-cycle (NG0100 on the search button).
    setTimeout(() => this.loadBooks(), 0);
    // Surface last crash after an unexpected full reload (Keycloak redirect, etc.).
    try {
      const last = sessionStorage.getItem('pattool.book.lastError');
      if (last) {
        this.contentError = last;
        sessionStorage.removeItem('pattool.book.lastError');
      }
    } catch {
      // ignore
    }
  }

  ngOnDestroy(): void {
    this.searchSub?.unsubscribe();
    this.listSub?.unsubscribe();
    this.contentSub?.unsubscribe();
    this.ttsSub?.unsubscribe();
    this.infoSub?.unsubscribe();
    this.stopSpeech();
    this.stopAudio();
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.infoOpen) {
      this.closeBookInfo();
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

  /**
   * Start (or restart) TTS from the clicked position in the reader.
   * Ignores link clicks and text selections.
   */
  onReaderClick(event: MouseEvent): void {
    if (!this.canSpeak) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('a')) {
      return;
    }
    const root = event.currentTarget as HTMLElement | null;
    if (!root) {
      return;
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && root.contains(sel.anchorNode)) {
      return;
    }
    const fromText = this.textFromClickToEnd(event, root);
    if (!fromText?.trim()) {
      return;
    }
    this.speechError = '';
    void this.startSpeech(fromText);
  }

  private async startSpeech(fromText?: string): Promise<void> {
    const text = fromText?.trim() ? fromText : await this.resolveSpeechText();
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

  /** Plain text from the caret under the click to the end of the reader. */
  private textFromClickToEnd(event: MouseEvent, root: HTMLElement): string | null {
    const caret = this.caretRangeFromPoint(event.clientX, event.clientY);
    if (!caret || !root.contains(caret.startContainer)) {
      return null;
    }
    this.snapRangeToWordStart(caret);
    const endRange = document.createRange();
    endRange.selectNodeContents(root);
    endRange.setStart(caret.startContainer, caret.startOffset);
    const text = endRange.toString().replace(/\r\n/g, '\n');
    return text.trim() ? text : null;
  }

  private caretRangeFromPoint(x: number, y: number): Range | null {
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    if (typeof doc.caretRangeFromPoint === 'function') {
      return doc.caretRangeFromPoint(x, y);
    }
    if (typeof doc.caretPositionFromPoint === 'function') {
      const pos = doc.caretPositionFromPoint(x, y);
      if (!pos) {
        return null;
      }
      const range = document.createRange();
      try {
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
        return range;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Avoid starting mid-word when the user clicks inside a word. */
  private snapRangeToWordStart(range: Range): void {
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) {
      return;
    }
    const text = node.textContent || '';
    let offset = range.startOffset;
    while (offset > 0 && !/\s/.test(text.charAt(offset - 1))) {
      offset--;
    }
    try {
      range.setStart(node, offset);
    } catch {
      // ignore invalid offsets
    }
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
    this.listError = '';
    this.clearReader();
    this.refreshLanguageOptions();
    // Keep title / author / genre / language across providers (map lang codes when needed).
    this.language = this.mapLanguageForSource(this.language, source);
    // Seed a default browse query only when every filter is empty.
    if (!this.query.trim() && !this.authorQuery.trim() && !this.genre && !this.language) {
      if (source === 'openlibrary' || source === 'googlebooks') {
        this.query = 'hugo';
      } else if (source === 'gutenberg' || source === 'archive') {
        this.query = 'verne';
      }
    }
    this.loadBooks();
  }

  /** Map ISO-639 language codes between Gutenberg/Google (en) and Open Library/Archive (eng). */
  private mapLanguageForSource(lang: string, source: BookSource): string {
    if (!lang) {
      return '';
    }
    const shortCodes = source === 'gutenberg' || source === 'googlebooks';
    const toShort: Record<string, string> = {
      eng: 'en',
      fre: 'fr',
      ger: 'de',
      spa: 'es',
      ita: 'it',
      en: 'en',
      fr: 'fr',
      de: 'de',
      es: 'es',
      it: 'it'
    };
    const toLong: Record<string, string> = {
      en: 'eng',
      fr: 'fre',
      de: 'ger',
      es: 'spa',
      it: 'ita',
      eng: 'eng',
      fre: 'fre',
      ger: 'ger',
      spa: 'spa',
      ita: 'ita'
    };
    const mapped = shortCodes ? toShort[lang] : toLong[lang];
    if (!mapped || !this.languageOptions.some((o) => o.value === mapped)) {
      return '';
    }
    return mapped;
  }

  onQueryChange(): void {
    this.search$.next(this.searchSignature());
  }

  /** Explicit search / refresh (title, author, genre, language). */
  runSearch(): void {
    this.offset = 0;
    this.page = 1;
    this.clearReader();
    this.loadBooks();
  }

  /** Language / genre: native (change) only — ngModelChange fires on Forms init and caused NG0100. */
  onLanguageChange(): void {
    this.runSearch();
  }

  onGenreChange(): void {
    this.runSearch();
  }

  get resultCountKey(): string {
    if (this.source === 'librivox' || this.source === 'standardebooks') {
      return this.canNext ? 'BOOK.RESULT_COUNT_LIBRIVOX_MORE' : 'BOOK.RESULT_COUNT_LIBRIVOX';
    }
    return 'BOOK.RESULT_COUNT';
  }

  get resultCountParams(): { count: number; page?: number } {
    if (this.source === 'librivox' || this.source === 'standardebooks') {
      return { count: this.books.length, page: this.currentPageLabel };
    }
    return { count: this.total };
  }

  private searchSignature(): string {
    return [this.source, this.query.trim(), this.authorQuery.trim(), this.language, this.genre].join('\0');
  }

  private refreshLanguageOptions(): void {
    // Stable array identity — recreating options every CD rebinds <select> and loops NG0103.
    if (this.source === 'gutenberg' || this.source === 'googlebooks') {
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

  openBookInfo(book: BookItem, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    this.infoSub?.unsubscribe();
    this.infoBook = { ...book };
    this.infoOpen = true;
    this.infoError = '';
    this.isLoadingInfo = true;

    const source = book.source;
    const id = book.id;
    if (!id) {
      this.isLoadingInfo = false;
      return;
    }

    if (source === 'openlibrary') {
      this.infoSub = this.api.getOpenLibraryWork(id).subscribe({
        next: (detail) => {
          this.infoBook = this.mergeBookInfo(book, detail);
          this.isLoadingInfo = false;
        },
        error: () => {
          this.isLoadingInfo = false;
          this.infoError = 'BOOK.ERR_DETAIL';
        }
      });
      return;
    }
    if (source === 'gutenberg') {
      this.infoSub = this.api.getGutenbergBook(id).subscribe({
        next: (detail) => {
          this.infoBook = this.mergeBookInfo(book, detail);
          this.isLoadingInfo = false;
        },
        error: () => {
          this.isLoadingInfo = false;
          this.infoError = 'BOOK.ERR_DETAIL';
        }
      });
      return;
    }
    if (source === 'librivox') {
      this.infoSub = this.api.getLibriVoxBook(id).subscribe({
        next: (detail) => {
          this.infoBook = this.mergeBookInfo(book, detail);
          this.isLoadingInfo = false;
        },
        error: () => {
          this.isLoadingInfo = false;
          this.infoError = 'BOOK.ERR_DETAIL';
        }
      });
      return;
    }
    if (source === 'archive') {
      this.infoSub = this.api.getArchiveBook(id).subscribe({
        next: (detail) => {
          this.infoBook = this.mergeBookInfo(book, detail);
          this.isLoadingInfo = false;
        },
        error: () => {
          this.isLoadingInfo = false;
          this.infoError = 'BOOK.ERR_DETAIL';
        }
      });
      return;
    }
    if (source === 'googlebooks') {
      this.infoSub = this.api.getGoogleBook(id).subscribe({
        next: (detail) => {
          this.infoBook = this.mergeBookInfo(book, detail);
          this.isLoadingInfo = false;
        },
        error: () => {
          this.isLoadingInfo = false;
          this.infoError = 'BOOK.ERR_DETAIL';
        }
      });
      return;
    }
    if (source === 'standardebooks') {
      this.infoSub = this.api.getStandardEbook(id).subscribe({
        next: (detail) => {
          this.infoBook = this.mergeBookInfo(book, detail);
          this.isLoadingInfo = false;
        },
        error: () => {
          this.isLoadingInfo = false;
          this.infoError = 'BOOK.ERR_DETAIL';
        }
      });
      return;
    }
    this.isLoadingInfo = false;
  }

  closeBookInfo(): void {
    this.infoSub?.unsubscribe();
    this.infoOpen = false;
    this.infoBook = null;
    this.isLoadingInfo = false;
    this.infoError = '';
  }

  openBookFromInfo(): void {
    if (!this.infoBook) {
      return;
    }
    const book = this.infoBook;
    this.closeBookInfo();
    this.selectBook(book);
  }

  private mergeBookInfo(base: BookItem, detail: BookItem): BookItem {
    return {
      ...base,
      ...detail,
      title: detail.title || base.title,
      authors: detail.authors || base.authors,
      coverUrl: detail.coverUrl || base.coverUrl,
      year: detail.year ?? base.year,
      language: detail.language || base.language,
      description: detail.description || base.description,
      subjects: detail.subjects || base.subjects,
      homepage: detail.homepage || base.homepage,
      textUrl: detail.textUrl || base.textUrl,
      htmlUrl: detail.htmlUrl || base.htmlUrl,
      epubUrl: detail.epubUrl || base.epubUrl,
      hasFulltext: detail.hasFulltext ?? base.hasFulltext,
      iaId: detail.iaId || base.iaId,
      totalTime: detail.totalTime || base.totalTime,
      totalTimeSecs: detail.totalTimeSecs ?? base.totalTimeSecs,
      sections: detail.sections?.length ? detail.sections : base.sections
    };
  }

  private setListLoading(loading: boolean): void {
    if (this.isLoading === loading) {
      return;
    }
    this.isLoading = loading;
    this.cdr.detectChanges();
  }

  loadBooks(): void {
    this.listSub?.unsubscribe();
    const q = this.query.trim();
    const author = this.authorQuery.trim();
    const genre = this.genre.trim() || undefined;
    if (this.source === 'librivox' || this.source === 'standardebooks') {
      // Empty query browses catalog / new releases; title/author search needs ≥2 chars when set.
    } else if (
      this.source === 'openlibrary' ||
      this.source === 'archive' ||
      this.source === 'googlebooks'
    ) {
      if (q.length < 2 && author.length < 2 && !genre) {
        this.books = [];
        this.total = 0;
        this.setListLoading(false);
        return;
      }
    }
    // Gutenberg: empty query browses popular titles (or by genre / author)

    this.setListLoading(true);
    this.listError = '';

    const onOk = (page: {
      books?: BookItem[];
      total?: number;
      offset?: number;
      rateLimited?: boolean;
    }) => {
      this.books = page.books || [];
      this.total = page.total || 0;
      if (page.offset != null) {
        this.offset = page.offset;
      }
      this.setListLoading(false);
      if (page.rateLimited) {
        this.listError = 'BOOK.ERR_GOOGLE_RATE_LIMIT';
      }
    };
    const onErr = () => {
      this.books = [];
      this.total = 0;
      this.setListLoading(false);
      this.listError =
        this.source === 'googlebooks' ? 'BOOK.ERR_GOOGLE_RATE_LIMIT' : 'BOOK.ERR_SEARCH';
    };

    if (this.source === 'openlibrary') {
      this.listSub = this.api
        .searchOpenLibraryBooks(
          q,
          this.pageSize,
          this.offset,
          this.language || undefined,
          genre,
          author || undefined
        )
        .subscribe({ next: onOk, error: onErr });
    } else if (this.source === 'gutenberg') {
      this.listSub = this.api
        .searchGutenbergBooks(
          q,
          this.language || undefined,
          this.page,
          genre,
          author || undefined
        )
        .subscribe({ next: onOk, error: onErr });
    } else if (this.source === 'archive') {
      this.listSub = this.api
        .searchArchiveBooks(
          q,
          this.pageSize,
          this.offset,
          this.language || undefined,
          genre,
          author || undefined
        )
        .subscribe({ next: onOk, error: onErr });
    } else if (this.source === 'googlebooks') {
      this.listSub = this.api
        .searchGoogleBooks(
          q,
          this.pageSize,
          this.offset,
          this.language || undefined,
          genre,
          author || undefined
        )
        .subscribe({ next: onOk, error: onErr });
    } else if (this.source === 'standardebooks') {
      this.listSub = this.api
        .searchStandardEbooks(q, this.pageSize, this.offset, genre, author || undefined, this.language || undefined)
        .subscribe({ next: onOk, error: onErr });
    } else {
      this.listSub = this.api
        .searchLibriVoxBooks(q, author || undefined, this.pageSize, this.offset, genre, this.language || undefined)
        .subscribe({ next: onOk, error: onErr });
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
    try {
      // Do not null `selected` here — that remounts the whole main pane and feels like a page reset.
      this.resetReaderContent();
      this.selected = book;
      this.playError = '';
      this.contentError = '';
      this.openSelectedBook(book);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        sessionStorage.setItem('pattool.book.lastError', 'BOOK select failed: ' + msg);
      } catch {
        // ignore
      }
      this.contentError = 'BOOK.ERR_CONTENT';
      console.error('[BOOK] selectBook failed', e);
    }
  }

  private openSelectedBook(book: BookItem): void {
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

    // Text sources: Gutenberg / Open Library / Archive / Google / Standard Ebooks
    // Never iframe Google / Archive / sites that frame-bust (they navigate the whole PATTOOL page away).
    if (book.source === 'openlibrary' || book.source === 'archive') {
      const candidate = book.htmlUrl || book.homepage || '';
      const isArchive =
        book.source === 'archive' || (candidate && this.isArchiveOrgUrl(candidate));

      if (book.source === 'archive' && book.id) {
        // Resolve real public text (or clear it for CDL/lending) via Archive metadata.
        this.isLoadingContent = true;
        this.contentError = '';
        this.contentSub?.unsubscribe();
        this.contentSub = this.api.getArchiveBook(book.id).subscribe({
          next: (detail) => {
            this.selected = this.mergeBookInfo(book, detail);
            if (detail.textUrl) {
              this.loadTextContent(detail.textUrl);
            } else {
              this.showExternalReader(detail.homepage || candidate, true);
            }
          },
          error: () => {
            if (book.textUrl) {
              this.loadTextContent(book.textUrl);
            } else {
              this.showExternalReader(candidate, true);
            }
          }
        });
        return;
      }

      if (isArchive) {
        // Open Library editions linked to IA: resolve real public text via IA metadata when possible.
        const iaId = book.iaId || this.extractArchiveId(candidate);
        if (iaId) {
          this.isLoadingContent = true;
          this.contentError = '';
          this.contentSub?.unsubscribe();
          this.contentSub = this.api.getArchiveBook(iaId).subscribe({
            next: (detail) => {
              this.selected = this.mergeBookInfo(book, {
                ...detail,
                source: book.source,
                id: book.id
              });
              if (detail.textUrl) {
                this.loadTextContent(detail.textUrl);
              } else {
                this.showExternalReader(detail.homepage || candidate, true);
              }
            },
            error: () => {
              if (book.textUrl) {
                this.loadTextContent(book.textUrl);
              } else {
                this.showExternalReader(candidate, true);
              }
            }
          });
          return;
        }
        if (book.textUrl) {
          this.loadTextContent(book.textUrl);
          return;
        }
        this.showExternalReader(candidate, true);
        return;
      }
      if (book.textUrl) {
        this.loadTextContent(book.textUrl);
        return;
      }
      if (candidate) {
        // openlibrary.org pages often frame-bust — open externally instead of iframe.
        this.showExternalReader(candidate, false);
        return;
      }
      this.contentError = 'BOOK.ERR_NO_CONTENT';
      this.readerMode = 'none';
      return;
    }

    if (book.source === 'googlebooks') {
      const url = book.htmlUrl || book.homepage || '';
      if (url) {
        // Google Books web reader frame-busts and replaces the whole SPA.
        this.showExternalReader(url, false);
        return;
      }
      this.contentError = 'BOOK.ERR_NO_CONTENT';
      this.readerMode = 'none';
      return;
    }

    if (book.source === 'standardebooks') {
      if (book.htmlUrl && book.hasFulltext !== false) {
        this.loadHtmlContent(book.htmlUrl);
        return;
      }
      if (book.homepage) {
        this.showExternalReader(book.homepage, false);
        return;
      }
      this.contentError = 'BOOK.ERR_NO_CONTENT';
      this.readerMode = 'none';
      return;
    }

    // Gutenberg (and any remaining text source)
    if (book.source === 'gutenberg') {
      if (book.textUrl) {
        this.loadTextContent(book.textUrl);
        return;
      }
      if (book.htmlUrl) {
        this.loadHtmlContent(book.htmlUrl);
        return;
      }
      if (book.homepage) {
        this.showExternalReader(book.homepage, false);
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
      this.loadHtmlContent(book.htmlUrl);
      return;
    }
    if (book.homepage) {
      this.showExternalReader(book.homepage, false);
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
    // Always force a new tab — never navigate the PATTOOL window (frame-bust / popup fallback).
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) {
      this.contentError = 'BOOK.ERR_POPUP_BLOCKED';
    }
  }

  /** Keep in-page HTML links from navigating the SPA away; otherwise start TTS from click. */
  onHtmlReaderClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest?.('a') as HTMLAnchorElement | null;
    if (!anchor) {
      this.onReaderClick(event);
      return;
    }
    const href = (anchor.getAttribute('href') || '').trim();
    if (!href || href.startsWith('#')) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    try {
      const abs = new URL(href, window.location.href).toString();
      this.openExternal(abs);
    } catch {
      this.openExternal(href);
    }
  }

  /**
   * Open Archive.org login, then the book page (same gesture = usually allowed by popup blockers).
   * Login must be top-level — Archive.org auth fails inside PATTOOL.
   */
  openArchiveLogin(): void {
    const returnTo = this.externalBookUrl || this.archiveBookUrl() || 'https://archive.org/';
    let loginUrl = 'https://archive.org/account/login';
    try {
      const u = new URL(loginUrl);
      u.searchParams.set('referer', returnTo);
      loginUrl = u.toString();
    } catch {
      // keep default
    }
    this.openExternal(loginUrl);
  }

  /** Login first, then open the book details page in a second tab. */
  openArchiveLoginThenBook(): void {
    this.openArchiveLogin();
    const bookUrl = this.externalBookUrl || this.archiveBookUrl();
    if (!bookUrl) {
      return;
    }
    // Slight delay so the login tab gets focus first; second open may still be blocked.
    setTimeout(() => this.openExternal(bookUrl), 350);
  }

  /**
   * Open the external book page in a new tab (Archive.org / Google Books / etc.).
   */
  openArchiveBook(): void {
    const url = this.externalBookUrl || this.archiveBookUrl();
    if (!url) {
      return;
    }
    this.openExternal(url);
  }

  /** Clean https://archive.org/details/{id} — strips embed/theater query params. */
  private archiveBookUrl(): string {
    const candidates = [
      this.selected?.homepage,
      this.selected?.iaId ? `https://archive.org/details/${this.selected.iaId}` : '',
      this.selected?.htmlUrl,
      this.externalBookUrl,
      this.lastIframeUrl
    ];
    for (const raw of candidates) {
      const clean = this.toArchiveDetailsUrl(raw);
      if (clean) {
        return clean;
      }
    }
    return '';
  }

  /**
   * Normalize any Archive.org book URL to /details/{id} without embed flags.
   */
  private toArchiveDetailsUrl(url?: string | null): string {
    const raw = (url || '').trim();
    if (!raw) {
      return '';
    }
    if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,200}$/.test(raw) && !raw.includes('://')) {
      return `https://archive.org/details/${encodeURIComponent(raw)}`;
    }
    try {
      const u = new URL(raw);
      const host = u.hostname.replace(/^www\./, '');
      if (host !== 'archive.org' && !host.endsWith('.archive.org')) {
        return '';
      }
      const m = u.pathname.match(/^\/(?:details|embed|stream)\/([^/?#]+)/i);
      if (m?.[1]) {
        return `https://archive.org/details/${encodeURIComponent(decodeURIComponent(m[1]))}`;
      }
    } catch {
      // ignore
    }
    return '';
  }

  /**
   * In-app CTA for books that must open in a first-party tab.
   * Do not auto-call window.open here (popup blockers / focus steal feel like a broken reload).
   */
  private showExternalReader(urlHint?: string, archive = false): void {
    this.readerMode = 'external';
    this.isArchiveExternal = archive;
    this.isLoadingContent = false;
    this.readerHtmlUrl = null;
    this.contentError = '';
    const details = archive
      ? this.toArchiveDetailsUrl(urlHint) ||
        this.toArchiveDetailsUrl(this.selected?.homepage) ||
        this.toArchiveDetailsUrl(this.selected?.iaId) ||
        this.toArchiveDetailsUrl(this.selected?.htmlUrl)
      : (urlHint || this.selected?.homepage || this.selected?.htmlUrl || '').trim();
    this.externalBookUrl = details;
    this.lastIframeUrl = details;
  }

  /** @deprecated use showExternalReader */
  private openArchiveExternal(urlHint?: string): void {
    this.showExternalReader(urlHint, true);
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
          this.openReadableFallback();
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
        this.openReadableFallback();
      }
    });
  }

  /** Prefer same-origin HTML proxy; only iframe third-party pages that allow embedding. */
  private openReadableFallback(): void {
    const htmlUrl = this.selected?.htmlUrl;
    const homepage = this.selected?.homepage;
    const source = this.selected?.source;
    if (htmlUrl && (source === 'gutenberg' || source === 'standardebooks')) {
      this.loadHtmlContent(htmlUrl);
      return;
    }
    if (htmlUrl && this.isArchiveOrgUrl(htmlUrl)) {
      this.showExternalReader(htmlUrl, true);
      return;
    }
    if (homepage && this.isArchiveOrgUrl(homepage)) {
      this.showExternalReader(homepage, true);
      return;
    }
    if (source === 'googlebooks') {
      this.showExternalReader(htmlUrl || homepage || '', false);
      return;
    }
    if (htmlUrl) {
      this.loadHtmlContent(htmlUrl);
      return;
    }
    if (homepage) {
      this.showExternalReader(homepage, false);
      return;
    }
    this.contentError = 'BOOK.ERR_NO_CONTENT';
    this.readerMode = 'none';
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
    // Fetch via backend proxy and render inline — never use an iframe.
    // Google/Gutenberg/SE pages in iframes frame-bust and reload the whole PATTOOL SPA.
    this.readerMode = 'html';
    this.isArchiveExternal = false;
    this.readerHtmlUrl = null;
    this.readerHtmlSafe = null;
    this.lastIframeUrl = '';
    this.isLoadingContent = true;
    this.contentError = '';
    const proxy = this.api.bookContentProxyUrl(url);
    this.contentSub?.unsubscribe();
    this.contentSub = this.http.get(proxy, { responseType: 'text' }).subscribe({
      next: (html) => {
        this.isLoadingContent = false;
        const cleaned = this.sanitizeBookHtml(html || '');
        if (!cleaned.trim()) {
          this.contentError = 'BOOK.ERR_NO_CONTENT';
          this.readerMode = 'none';
          return;
        }
        this.readerHtmlSafe = this.sanitizer.bypassSecurityTrustHtml(cleaned);
        // Plain-text extract for TTS when available
        this.ttsText = cleaned.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      },
      error: () => {
        this.isLoadingContent = false;
        this.contentError = 'BOOK.ERR_CONTENT';
        this.readerMode = 'none';
      }
    });
  }

  /**
   * Strip scripts / meta-refresh / target=_top so embedded book HTML cannot navigate PATTOOL away.
   */
  private sanitizeBookHtml(html: string): string {
    let out = html || '';
    out = out.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    out = out.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');
    out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    out = out.replace(/\s+target\s*=\s*("|')_?(top|parent)\1/gi, ' target="_blank"');
    out = out.replace(/<base\b[^>]*>/gi, '');
    // Keep body fragment when a full document is returned
    const bodyMatch = out.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch?.[1]) {
      out = bodyMatch[1];
    }
    return out;
  }

  private openIframe(url: string): void {
    // Iframes of third-party readers frame-bust (reload PATTOOL). Always use external CTA.
    const target = (url || '').trim();
    if (!target) {
      this.contentError = 'BOOK.ERR_NO_CONTENT';
      this.readerMode = 'none';
      return;
    }
    this.showExternalReader(target, this.isArchiveOrgUrl(target));
  }

  private isArchiveOrgUrl(url: string): boolean {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return host === 'archive.org' || host.endsWith('.archive.org');
    } catch {
      return false;
    }
  }

  /** Extract Archive.org item id from /details|embed|stream/{id} or a bare identifier. */
  private extractArchiveId(url?: string | null): string {
    const raw = (url || '').trim();
    if (!raw) {
      return '';
    }
    if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,200}$/.test(raw) && !raw.includes('://')) {
      return raw;
    }
    try {
      const u = new URL(raw);
      const host = u.hostname.replace(/^www\./, '');
      if (host !== 'archive.org' && !host.endsWith('.archive.org')) {
        return '';
      }
      const m = u.pathname.match(/^\/(?:details|embed|stream)\/([^/?#]+)/i);
      if (m?.[1]) {
        return decodeURIComponent(m[1]);
      }
    } catch {
      // ignore
    }
    return '';
  }

  private isGoogleBooksUrl(url: string): boolean {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return host === 'books.google.com'
        || (host.endsWith('.google.com') && url.toLowerCase().includes('/books'));
    } catch {
      return false;
    }
  }

  private normalizeIframeUrl(url: string): string {
    return (url || '').trim();
  }

  /** Reset reader pane without clearing the selected book (avoids main-pane remount). */
  private resetReaderContent(): void {
    this.contentSub?.unsubscribe();
    this.stopSpeech();
    this.stopAudio();
    this.isArchiveExternal = false;
    this.externalBookUrl = '';
    this.iframeReferrerPolicy = 'no-referrer';
    this.readerMode = 'none';
    this.readerText = '';
    this.ttsText = '';
    this.readerHtmlUrl = null;
    this.readerHtmlSafe = null;
    this.lastIframeUrl = '';
    this.iframeGen = 0;
    this.contentError = '';
    this.playError = '';
    this.speechError = '';
    this.isLoadingContent = false;
  }

  private clearReader(): void {
    this.resetReaderContent();
    this.selected = null;
  }
}
