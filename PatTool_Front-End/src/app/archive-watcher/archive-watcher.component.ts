import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  SecurityContext,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml, SafeResourceUrl } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

import {
  ApiService,
  ArchiveCodeLabel,
  ArchiveFile,
  ArchiveItem,
  ArchiveItemDetail,
  WaybackSnapshot
} from '../services/api.service';

type ArchiveViewMode = 'catalog' | 'wayback';
type PlayerMode = 'none' | 'video' | 'audio' | 'image' | 'embed' | 'iframe';

const LOCALE_MAP: Record<string, string> = {
  fr: 'fr-FR',
  en: 'en-US',
  es: 'es-ES',
  de: 'de-DE',
  it: 'it-IT',
  ru: 'ru-RU',
  jp: 'ja-JP',
  cn: 'zh-CN',
  ar: 'ar-SA',
  el: 'el-GR',
  he: 'he-IL',
  in: 'hi-IN'
};

@Component({
  selector: 'app-archive-watcher',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './archive-watcher.component.html',
  styleUrls: ['./archive-watcher.component.css']
})
export class ArchiveWatcherComponent implements OnInit, OnDestroy {
  @ViewChild('videoEl') videoEl?: ElementRef<HTMLVideoElement>;
  @ViewChild('audioEl') audioEl?: ElementRef<HTMLAudioElement>;
  @ViewChild('detailStage') detailStage?: ElementRef<HTMLElement>;

  viewMode: ArchiveViewMode = 'catalog';
  mediatype = 'movies';
  section = 'RECENT';
  sort = 'downloads';
  query = '';
  creator = '';
  language = '';

  mediatypes: ArchiveCodeLabel[] = [];
  sections: ArchiveCodeLabel[] = [];
  sorts: ArchiveCodeLabel[] = [];

  items: ArchiveItem[] = [];
  total = 0;
  page = 1;
  pages = 1;

  selected: ArchiveItemDetail | null = null;
  selectedId = '';

  isLoading = false;
  isLoadingDetail = false;
  listError = '';
  detailError = '';
  playError = '';

  playerMode: PlayerMode = 'none';
  mediaUrl = '';
  embedUrl: SafeResourceUrl | null = null;
  iframeGen = 0;

  isFullscreen = false;
  showAllFiles = false;

  waybackUrl = '';
  waybackLoading = false;
  waybackError = '';
  waybackAvailable = false;
  waybackSnapshotUrl = '';
  waybackSnapshotSafe: SafeResourceUrl | null = null;
  waybackTimestamp = '';
  waybackSnapshots: WaybackSnapshot[] = [];

  readonly languageOptions: Array<{ value: string; label: string }> = [
    { value: '', label: '—' },
    { value: 'eng OR english', label: 'English' },
    { value: 'fra OR fre OR french', label: 'Français' },
    { value: 'ger OR deu OR german', label: 'Deutsch' },
    { value: 'spa OR spanish', label: 'Español' },
    { value: 'ita OR italian', label: 'Italiano' },
    { value: 'por OR portuguese', label: 'Português' },
    { value: 'dut OR nld OR dutch', label: 'Nederlands' },
    { value: 'rus OR russian', label: 'Русский' },
    { value: 'jpn OR japanese', label: '日本語' },
    { value: 'chi OR zho OR chinese', label: '中文' },
    { value: 'ara OR arabic', label: 'العربية' }
  ];

  private search$ = new Subject<string>();
  private searchSub?: Subscription;
  private listSub?: Subscription;
  private detailSub?: Subscription;
  private metaSub?: Subscription;
  private waybackSub?: Subscription;

  constructor(
    private api: ApiService,
    private sanitizer: DomSanitizer,
    private translate: TranslateService
  ) {}

  /** Archive.org descriptions often include HTML (&lt;br&gt;, links); sanitize then render. */
  toSafeHtml(value: string | null | undefined): SafeHtml {
    const raw = value ?? '';
    const cleaned = this.sanitizer.sanitize(SecurityContext.HTML, raw) ?? '';
    return this.sanitizer.bypassSecurityTrustHtml(cleaned);
  }

  ngOnInit(): void {
    this.searchSub = this.search$.pipe(debounceTime(450), distinctUntilChanged()).subscribe(() => {
      this.page = 1;
      this.loadItems();
    });
    this.loadMeta();
    this.loadItems();
  }

  ngOnDestroy(): void {
    this.searchSub?.unsubscribe();
    this.listSub?.unsubscribe();
    this.detailSub?.unsubscribe();
    this.metaSub?.unsubscribe();
    this.waybackSub?.unsubscribe();
    this.stopMedia();
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    }
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    this.isFullscreen = !!document.fullscreenElement;
  }

  setViewMode(mode: ArchiveViewMode): void {
    if (this.viewMode === mode) {
      return;
    }
    this.viewMode = mode;
    if (mode === 'catalog' && this.items.length === 0 && !this.isLoading) {
      this.loadItems();
    }
  }

  setMediatype(code: string): void {
    if (this.mediatype === code) {
      return;
    }
    this.mediatype = code;
    this.section = 'RECENT';
    this.page = 1;
    this.clearSelection();
    this.loadSections();
    this.loadItems();
  }

  onSectionChange(): void {
    this.page = 1;
    this.clearSelection();
    this.loadItems();
  }

  onSortChange(): void {
    this.page = 1;
    this.loadItems();
  }

  onLanguageChange(): void {
    this.page = 1;
    this.loadItems();
  }

  onQueryChange(): void {
    this.search$.next(`${this.query}|${this.creator}`);
  }

  runSearch(): void {
    this.page = 1;
    this.loadItems();
  }

  clearSearch(): void {
    this.query = '';
    this.creator = '';
    this.page = 1;
    this.loadItems();
  }

  get canPrev(): boolean {
    return this.page > 1 && !this.isLoading;
  }

  get canNext(): boolean {
    return this.page < this.pages && !this.isLoading;
  }

  prevPage(): void {
    if (!this.canPrev) {
      return;
    }
    this.page -= 1;
    this.loadItems();
  }

  nextPage(): void {
    if (!this.canNext) {
      return;
    }
    this.page += 1;
    this.loadItems();
  }

  selectItem(item: ArchiveItem): void {
    if (!item?.identifier) {
      return;
    }
    this.selectedId = item.identifier;
    this.isLoadingDetail = true;
    this.detailError = '';
    this.playError = '';
    this.showAllFiles = false;
    this.stopMedia();
    this.detailSub?.unsubscribe();
    this.detailSub = this.api.getArchiveOrgItem(item.identifier).subscribe({
      next: (detail) => {
        this.selected = detail;
        this.isLoadingDetail = false;
        this.autoPlay(detail);
      },
      error: () => {
        this.selected = null;
        this.isLoadingDetail = false;
        this.detailError = 'ARCHIVE.ERROR_DETAIL';
      }
    });
  }

  clearSelection(): void {
    this.selected = null;
    this.selectedId = '';
    this.detailError = '';
    this.playError = '';
    this.stopMedia();
  }

  playFile(file: ArchiveFile): void {
    if (!file?.downloadUrl) {
      return;
    }
    const kind = (file.kind || '').toLowerCase();
    this.playError = '';
    this.stopMedia();
    if (kind === 'video') {
      this.playerMode = 'video';
      this.mediaUrl = this.api.tvStreamProxyUrl(file.downloadUrl);
      setTimeout(() => this.videoEl?.nativeElement?.play?.().catch(() => undefined), 50);
    } else if (kind === 'audio') {
      this.playerMode = 'audio';
      this.mediaUrl = this.api.tvStreamProxyUrl(file.downloadUrl);
      setTimeout(() => this.audioEl?.nativeElement?.play?.().catch(() => undefined), 50);
    } else if (kind === 'image') {
      this.playerMode = 'image';
      this.mediaUrl = file.downloadUrl;
    } else if (kind === 'pdf' || kind === 'text') {
      this.playerMode = 'iframe';
      this.embedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(file.downloadUrl);
      this.iframeGen += 1;
    } else if (file.downloadUrl) {
      window.open(file.downloadUrl, '_blank', 'noopener');
    }
  }

  openEmbed(): void {
    if (!this.selected?.embedUrl) {
      return;
    }
    this.stopMedia();
    this.playerMode = 'embed';
    this.embedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.selected.embedUrl);
    this.iframeGen += 1;
  }

  openDetailsExternal(): void {
    if (this.selected?.detailsUrl) {
      window.open(this.selected.detailsUrl, '_blank', 'noopener');
    }
  }

  toggleFullscreen(): void {
    const el = this.detailStage?.nativeElement;
    if (!el) {
      return;
    }
    if (!document.fullscreenElement) {
      void el.requestFullscreen?.();
    } else {
      void document.exitFullscreen?.();
    }
  }

  formatSize(size?: number): string {
    if (size == null || size <= 0) {
      return '';
    }
    if (size < 1024) {
      return `${this.formatInteger(size)} B`;
    }
    if (size < 1024 * 1024) {
      return `${this.formatInteger(Math.round(size / 1024))} KB`;
    }
    if (size < 1024 * 1024 * 1024) {
      return `${this.formatDecimal(size / (1024 * 1024), 1)} MB`;
    }
    return `${this.formatDecimal(size / (1024 * 1024 * 1024), 2)} GB`;
  }

  /** Full integer with locale thousand separators (e.g. 1 234 567). */
  formatInteger(n?: number | null): string {
    if (n == null || !Number.isFinite(n)) {
      return '';
    }
    return Math.round(n).toLocaleString(this.numberLocale(), { maximumFractionDigits: 0 });
  }

  formatDownloads(n?: number): string {
    return this.formatInteger(n);
  }

  private formatDecimal(n: number, digits: number): string {
    return n.toLocaleString(this.numberLocale(), {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits
    });
  }

  private numberLocale(): string {
    const lang = (this.translate.currentLang || this.translate.getDefaultLang() || 'en')
      .trim()
      .toLowerCase();
    return LOCALE_MAP[lang] || 'en-US';
  }

  mediatypeIcon(code?: string): string {
    switch ((code || '').toLowerCase()) {
      case 'movies':
        return 'fa-film';
      case 'texts':
        return 'fa-book';
      case 'audio':
        return 'fa-music';
      case 'etree':
        return 'fa-microphone';
      case 'software':
        return 'fa-gamepad';
      case 'image':
        return 'fa-picture-o';
      case 'data':
        return 'fa-database';
      case 'web':
        return 'fa-globe';
      case 'collection':
        return 'fa-folder-open';
      case 'wayback':
        return 'fa-history';
      default:
        return 'fa-archive';
    }
  }

  get visibleFiles(): ArchiveFile[] {
    const files = this.selected?.files || [];
    if (this.showAllFiles || files.length <= 12) {
      return files;
    }
    return files.filter((f) => f.playable).slice(0, 12);
  }

  get hasMoreFiles(): boolean {
    return (this.selected?.files?.length || 0) > this.visibleFiles.length;
  }

  trackByIdentifier(_: number, item: ArchiveItem): string {
    return item.identifier || item.id;
  }

  trackByFile(_: number, file: ArchiveFile): string {
    return file.name;
  }

  trackBySnapshot(_: number, snap: WaybackSnapshot): string {
    return snap.timestamp + (snap.snapshotUrl || '');
  }

  runWayback(): void {
    const url = (this.waybackUrl || '').trim();
    if (!url) {
      this.waybackError = 'ARCHIVE.WAYBACK_EMPTY';
      return;
    }
    this.waybackLoading = true;
    this.waybackError = '';
    this.waybackAvailable = false;
    this.waybackSnapshotUrl = '';
    this.waybackSnapshotSafe = null;
    this.waybackTimestamp = '';
    this.waybackSnapshots = [];
    this.waybackSub?.unsubscribe();
    this.waybackSub = this.api.getWaybackAvailable(url).subscribe({
      next: (avail) => {
        this.waybackAvailable = !!avail.available;
        this.waybackSnapshotUrl = avail.snapshotUrl || '';
        this.waybackTimestamp = avail.timestamp || '';
        if (this.waybackSnapshotUrl) {
          const httpsUrl = this.waybackSnapshotUrl.replace(/^http:\/\//i, 'https://');
          this.waybackSnapshotSafe = this.sanitizer.bypassSecurityTrustResourceUrl(httpsUrl);
        }
        if (avail.error && !avail.available) {
          this.waybackError = 'ARCHIVE.WAYBACK_ERROR';
        }
        this.api.getWaybackCdx(url, 25).subscribe({
          next: (cdx) => {
            this.waybackSnapshots = cdx.snapshots || [];
            this.waybackLoading = false;
          },
          error: () => {
            this.waybackLoading = false;
          }
        });
      },
      error: () => {
        this.waybackLoading = false;
        this.waybackError = 'ARCHIVE.WAYBACK_ERROR';
      }
    });
  }

  private loadMeta(): void {
    this.metaSub?.unsubscribe();
    this.metaSub = this.api.getArchiveMediatypes().subscribe({
      next: (res) => {
        this.mediatypes = res.mediatypes || [];
      },
      error: () => {
        this.mediatypes = [
          { code: 'all', label: 'All' },
          { code: 'movies', label: 'Movies' },
          { code: 'texts', label: 'Texts' },
          { code: 'audio', label: 'Audio' },
          { code: 'etree', label: 'Live music' },
          { code: 'software', label: 'Software' },
          { code: 'image', label: 'Images' },
          { code: 'data', label: 'Data' },
          { code: 'web', label: 'Web' },
          { code: 'collection', label: 'Collections' }
        ];
      }
    });
    this.api.getArchiveSorts().subscribe({
      next: (res) => {
        this.sorts = res.sorts || [];
      },
      error: () => {
        this.sorts = [
          { code: 'downloads', label: 'Downloads' },
          { code: 'recent', label: 'Recent' },
          { code: 'title', label: 'Title' },
          { code: 'creator', label: 'Creator' },
          { code: 'rating', label: 'Rating' },
          { code: 'date', label: 'Date' }
        ];
      }
    });
    this.loadSections();
  }

  private loadSections(): void {
    this.api.getArchiveSections(this.mediatype).subscribe({
      next: (res) => {
        this.sections = res.sections || [];
        if (this.sections.length && !this.sections.some((s) => s.code === this.section)) {
          this.section = this.sections[0].code;
        }
      },
      error: () => {
        this.sections = [{ code: 'RECENT', label: 'Recent' }];
      }
    });
  }

  private loadItems(): void {
    this.isLoading = true;
    this.listError = '';
    this.listSub?.unsubscribe();
    this.listSub = this.api
      .searchArchiveOrg({
        mediatype: this.mediatype,
        section: this.section,
        q: this.query,
        creator: this.creator,
        language: this.language,
        sort: this.sort,
        page: this.page
      })
      .subscribe({
        next: (page) => {
          this.items = page.items || [];
          this.total = page.total || 0;
          this.page = page.page || 1;
          this.pages = page.pages || 1;
          this.isLoading = false;
        },
        error: () => {
          this.items = [];
          this.total = 0;
          this.isLoading = false;
          this.listError = 'ARCHIVE.ERROR_LIST';
        }
      });
  }

  private autoPlay(detail: ArchiveItemDetail): void {
    const kind = (detail.playKind || '').toLowerCase();
    const mt = (detail.mediatype || '').toLowerCase();
    if (detail.dark) {
      this.playError = 'ARCHIVE.ITEM_DARK';
      return;
    }
    if (kind === 'video' && detail.playUrl) {
      this.playerMode = 'video';
      this.mediaUrl = this.api.tvStreamProxyUrl(detail.playUrl);
      return;
    }
    if (kind === 'audio' && detail.playUrl) {
      this.playerMode = 'audio';
      this.mediaUrl = this.api.tvStreamProxyUrl(detail.playUrl);
      return;
    }
    if (kind === 'image' && detail.playUrl) {
      this.playerMode = 'image';
      this.mediaUrl = detail.playUrl;
      return;
    }
    if ((kind === 'pdf' || kind === 'text') && detail.playUrl) {
      this.playerMode = 'iframe';
      this.embedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(detail.playUrl);
      this.iframeGen += 1;
      return;
    }
    if (mt === 'texts' || mt === 'software' || mt === 'movies' || mt === 'audio' || kind === 'embed') {
      if (detail.embedUrl) {
        this.playerMode = 'embed';
        this.embedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(detail.embedUrl);
        this.iframeGen += 1;
        return;
      }
    }
    if (mt === 'image' && detail.imageUrl) {
      this.playerMode = 'image';
      this.mediaUrl = detail.imageUrl;
    }
  }

  private stopMedia(): void {
    try {
      this.videoEl?.nativeElement?.pause?.();
    } catch {
      /* ignore */
    }
    try {
      this.audioEl?.nativeElement?.pause?.();
    } catch {
      /* ignore */
    }
    this.playerMode = 'none';
    this.mediaUrl = '';
    this.embedUrl = null;
  }
}
