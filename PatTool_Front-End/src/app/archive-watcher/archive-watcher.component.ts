import {
  ChangeDetectorRef,
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
import { Subscription, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import {
  ApiService,
  ArchiveCodeLabel,
  ArchiveFile,
  ArchiveItem,
  ArchiveItemDetail,
  WaybackSnapshot
} from '../services/api.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import {
  ArchiveAudioQueueService,
  ArchiveAudioQueueState,
  ArchiveQueueSource
} from '../services/archive-audio-queue.service';

type ArchiveViewMode = 'catalog' | 'recent' | 'playlist' | 'wayback';
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

/** Survives leaving Archive for another app page (same browser tab). */
const ARCHIVE_FILTERS_STORAGE_KEY = 'pat.archive.catalogFilters.v1';

interface ArchiveFiltersState {
  viewMode?: ArchiveViewMode;
  mediatype?: string;
  section?: string;
  sort?: string;
  query?: string;
  creator?: string;
  language?: string;
  page?: number;
  waybackUrl?: string;
}

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
  recentItems: ArchiveItem[] = [];
  playlistItems: ArchiveItem[] = [];
  total = 0;
  page = 1;
  pages = 1;

  selected: ArchiveItemDetail | null = null;
  selectedId = '';

  isLoading = false;
  isLoadingDetail = false;
  isLoadingRecent = false;
  isLoadingPlaylist = false;
  /** Full-screen spinner only for intentional search (Rechercher), not filter tabs. */
  showSearchOverlay = false;
  listError = '';
  detailError = '';
  playError = '';
  recentHint = '';
  recentError = '';
  playlistHint = '';
  playlistError = '';

  /** Sequential play-through queue (saved playlist, catalog page, or recent). */
  queueItems: ArchiveItem[] = [];
  queueSource: ArchiveQueueSource = 'none';
  playlistIndex = -1;
  playlistActive = false;
  /** Mirrors queue / &lt;audio&gt; paused state for the play/pause button. */
  audioIsPaused = true;
  queueCurrentTime = 0;
  queueDuration = 0;
  /** When true, start/resume the local &lt;audio&gt; element (non-queue playFile). */
  private wantAudioPlay = false;

  playerMode: PlayerMode = 'none';
  mediaUrl = '';
  embedUrl: SafeResourceUrl | null = null;
  iframeGen = 0;

  isFullscreen = false;
  showAllFiles = false;
  showItemInfoModal = false;
  isLoadingItemInfo = false;
  infoDetail: ArchiveItemDetail | null = null;

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

  private listSub?: Subscription;
  private detailSub?: Subscription;
  private infoSub?: Subscription;
  private metaSub?: Subscription;
  private waybackSub?: Subscription;
  private recentSub?: Subscription;
  private playlistSub?: Subscription;
  private queueSub?: Subscription;
  private queueUiRestored = false;

  constructor(
    private api: ApiService,
    private sanitizer: DomSanitizer,
    private translate: TranslateService,
    private keycloak: KeycloakService,
    private cdr: ChangeDetectorRef,
    private archiveQueue: ArchiveAudioQueueService
  ) {}

  get isLoggedIn(): boolean {
    return this.keycloak.isLoggedIn();
  }

  get recentCount(): number {
    return this.recentItems.length;
  }

  get playlistCount(): number {
    return this.playlistItems.length;
  }

  /** Audio / concert rows on the current catalog page — used by « Tout lire ». */
  get catalogAudioItems(): ArchiveItem[] {
    return this.items.filter((i) => this.isAudioItem(i));
  }

  get canPlayAllCatalog(): boolean {
    return !this.isLoading && this.catalogAudioItems.length > 0;
  }

  /** Audio / concert rows in recent — used by « Tout lire ». */
  get recentAudioItems(): ArchiveItem[] {
    return this.recentItems.filter((i) => this.isAudioItem(i));
  }

  get canPlayAllRecent(): boolean {
    return !this.isLoadingRecent && this.isLoggedIn && this.recentAudioItems.length > 0;
  }

  get canAddToPlaylist(): boolean {
    if (!this.isLoggedIn || !this.selected) {
      return false;
    }
    return this.isAudioItem(this.selected);
  }

  get isSelectedInPlaylist(): boolean {
    const id = this.selected?.identifier;
    if (!id) {
      return false;
    }
    return this.playlistItems.some((i) => i.identifier === id);
  }

  /** True while audio/video is mounted — keep the player alive across UI tab changes. */
  get isPlayingMedia(): boolean {
    return (this.playerMode === 'audio' || this.playerMode === 'video') && !!this.mediaUrl;
  }

  /** Archive.org descriptions often include HTML (&lt;br&gt;, links); sanitize then render. */
  toSafeHtml(value: string | null | undefined): SafeHtml {
    const raw = value ?? '';
    const cleaned = this.sanitizer.sanitize(SecurityContext.HTML, raw) ?? '';
    return this.sanitizer.bypassSecurityTrustHtml(cleaned);
  }

  ngOnInit(): void {
    const restoredFilters = this.restoreFilters();
    this.queueSub = this.archiveQueue.state$.subscribe((s) => this.applyQueueState(s));
    const snap = this.archiveQueue.snapshot;
    const reclaiming = snap.active;
    if (reclaiming && !this.queueUiRestored) {
      this.restoreQueueViewMode(snap.source);
      this.queueUiRestored = true;
    }
    this.archiveQueue.setPageAttached(true);
    this.loadMeta();
    // Do not steal the tab away from a reclaimed « Tout lire » session, or wipe a restored catalog tab.
    this.loadRecent(!reclaiming && !restoredFilters);
    this.loadPlaylist(false);
    if (this.viewMode === 'catalog') {
      this.loadItems();
    }
  }

  ngOnDestroy(): void {
    this.persistFilters();
    this.listSub?.unsubscribe();
    this.detailSub?.unsubscribe();
    this.infoSub?.unsubscribe();
    this.metaSub?.unsubscribe();
    this.waybackSub?.unsubscribe();
    this.recentSub?.unsubscribe();
    this.playlistSub?.unsubscribe();
    this.queueSub?.unsubscribe();
    this.archiveQueue.setPageAttached(false);
    // Keep persistent queue audio running across routes.
    if (!this.archiveQueue.isActive) {
      this.stopMedia();
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    }
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    this.isFullscreen = !!document.fullscreenElement;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.showItemInfoModal) {
      this.closeItemInfo();
    }
  }

  setViewMode(mode: ArchiveViewMode): void {
    if (this.viewMode === mode) {
      return;
    }
    this.viewMode = mode;
    this.persistFilters();
    this.recentHint = '';
    this.recentError = '';
    this.playlistHint = '';
    this.playlistError = '';
    if (mode === 'catalog' && this.items.length === 0 && !this.isLoading) {
      this.loadItems();
    }
    if (mode === 'recent') {
      if (!this.isLoggedIn) {
        this.recentHint = 'ARCHIVE.RECENT_LOGIN';
        this.recentItems = [];
      } else {
        // Already in DB / preloaded — show cache immediately, refresh quietly.
        this.loadRecent(false, this.recentItems.length > 0);
      }
    }
    if (mode === 'playlist') {
      if (!this.isLoggedIn) {
        this.playlistHint = 'ARCHIVE.PLAYLIST_LOGIN';
        this.playlistItems = [];
      } else {
        const hasCache = this.playlistItems.length > 0;
        const idle = this.playerMode === 'none' && !this.archiveQueue.isActive;
        // Do not interrupt whatever is already playing — only auto-start when idle.
        if (hasCache && idle) {
          this.playPlaylistFrom(0);
        }
        this.loadPlaylist(!hasCache && idle, hasCache);
      }
    }
  }

  setMediatype(code: string): void {
    if (this.mediatype === code) {
      return;
    }
    this.mediatype = code;
    this.section = 'RECENT';
    this.page = 1;
    this.persistFilters();
    this.loadSections();
  }

  onSectionChange(): void {
    this.page = 1;
    this.persistFilters();
  }

  onSortChange(): void {
    this.page = 1;
    this.persistFilters();
  }

  onLanguageChange(): void {
    this.page = 1;
    this.persistFilters();
  }

  runSearch(): void {
    this.page = 1;
    this.persistFilters();
    this.loadItems(true);
  }

  clearSearch(): void {
    this.query = '';
    this.creator = '';
    this.page = 1;
    this.persistFilters();
    this.loadItems(true);
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
    this.persistFilters();
    this.loadItems();
  }

  nextPage(): void {
    if (!this.canNext) {
      return;
    }
    this.page += 1;
    this.persistFilters();
    this.loadItems();
  }

  selectItem(item: ArchiveItem, fromPlaylist = false): void {
    if (!item?.identifier) {
      return;
    }
    // Same item already loaded/playing — leave playback alone.
    if (this.selectedId === item.identifier && this.selected && !this.isLoadingDetail) {
      return;
    }
    if (!fromPlaylist) {
      this.clearQueue();
    }
    this.selectedId = item.identifier;
    this.isLoadingDetail = true;
    this.detailError = '';
    this.playError = '';
    this.showAllFiles = false;
    this.showItemInfoModal = false;
    this.infoDetail = null;
    this.isLoadingItemInfo = false;
    this.stopMedia();
    this.detailSub?.unsubscribe();
    this.detailSub = this.api.getArchiveOrgItem(item.identifier).subscribe({
      next: (detail) => {
        this.selected = detail;
        this.isLoadingDetail = false;
        this.autoPlay(detail, false);
        // Queue / « Tout lire » must not pollute « Derniers ».
        if (!fromPlaylist) {
          this.persistRecentSelection(detail);
        }
        this.scrollDetailIntoViewOnMobile();
      },
      error: () => {
        this.selected = null;
        this.isLoadingDetail = false;
        this.detailError = 'ARCHIVE.ERROR_DETAIL';
      }
    });
  }

  playPlaylistFrom(index: number): void {
    this.archiveQueue.start(this.playlistItems, index, 'playlist');
  }

  /** Start sequential playback from any audio list (catalog / recent / playlist). */
  playFromQueue(index: number): void {
    if (index < 0 || index >= this.queueItems.length) {
      return;
    }
    if (this.archiveQueue.isActive && this.archiveQueue.snapshot.source === this.queueSource) {
      this.archiveQueue.playAt(index);
      return;
    }
    this.archiveQueue.start(this.queueItems, index, this.queueSource);
  }

  /** Start the whole audio playlist from the first track. */
  playAllPlaylist(): void {
    this.archiveQueue.start(this.playlistItems, 0, 'playlist');
  }

  /** Play every audio item on the current catalog page, one after another. */
  playAllCatalog(): void {
    const list = this.catalogAudioItems;
    if (list.length === 0) {
      return;
    }
    this.archiveQueue.start(list, 0, 'catalog');
  }

  /** Play every audio item in recent, one after another. */
  playAllRecent(): void {
    const list = this.recentAudioItems;
    if (list.length === 0) {
      return;
    }
    this.archiveQueue.start(list, 0, 'recent');
  }

  isQueuePlayingItem(item: ArchiveItem, source: ArchiveQueueSource): boolean {
    if (!this.playlistActive || this.queueSource !== source || this.playlistIndex < 0) {
      return false;
    }
    return this.queueItems[this.playlistIndex]?.identifier === item?.identifier;
  }

  get canQueuePrev(): boolean {
    return this.playlistActive && this.archiveQueue.hasPrev;
  }

  get canQueueNext(): boolean {
    return this.playlistActive && this.archiveQueue.hasNext;
  }

  get canQueuePrevAlbum(): boolean {
    return this.playlistActive && this.archiveQueue.hasPrevAlbum;
  }

  get canQueueNextAlbum(): boolean {
    return this.playlistActive && this.archiveQueue.hasNextAlbum;
  }

  get queueTrackIndex(): number {
    return this.archiveQueue.snapshot.trackIndex;
  }

  get queueTrackCount(): number {
    return this.archiveQueue.snapshot.trackCount;
  }

  get queueTrackName(): string {
    return this.archiveQueue.snapshot.trackName || '';
  }

  isQueuePlayingFile(file: ArchiveFile): boolean {
    if (!this.playlistActive || !file?.name || !this.queueTrackName) {
      return false;
    }
    return file.name === this.queueTrackName;
  }

  onAudioPlay(): void {
    this.audioIsPaused = false;
  }

  onAudioPause(): void {
    this.audioIsPaused = true;
  }

  queuePrev(): void {
    this.archiveQueue.prev();
  }

  queueNext(): void {
    this.archiveQueue.next();
  }

  queuePrevAlbum(): void {
    this.archiveQueue.prevAlbum();
  }

  queueNextAlbum(): void {
    this.archiveQueue.nextAlbum();
  }

  toggleQueuePause(): void {
    this.archiveQueue.togglePause();
  }

  seekQueue(event: Event): void {
    const value = Number((event.target as HTMLInputElement)?.value);
    if (!Number.isFinite(value)) {
      return;
    }
    this.archiveQueue.seekTo(value);
  }

  formatQueueTime(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) {
      return '0:00';
    }
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  onPlaylistAudioEnded(): void {
    /* Queue advancement is owned by ArchiveAudioQueueService. */
  }

  /** Retry play once the local &lt;audio&gt; element has enough data (non-queue). */
  onAudioCanPlay(): void {
    if (this.playlistActive || !this.wantAudioPlay) {
      return;
    }
    this.tryPlayAudioElement();
  }

  private applyQueueState(s: ArchiveAudioQueueState): void {
    this.audioIsPaused = s.paused;
    this.queueCurrentTime = s.currentTime;
    this.queueDuration = s.duration;

    if (!s.active) {
      const wasActive = this.playlistActive;
      this.playlistActive = false;
      this.playlistIndex = -1;
      this.queueSource = 'none';
      if (wasActive) {
        this.cdr.markForCheck();
      }
      return;
    }

    this.playlistActive = true;
    this.queueItems = s.queue;
    this.playlistIndex = s.index;
    this.queueSource = s.source;
    this.mediaUrl = s.mediaUrl || this.mediaUrl;
    if (s.mediaUrl) {
      this.playerMode = 'audio';
    }
    this.isLoadingDetail = s.loading;

    if (s.detail) {
      this.selected = s.detail;
      this.selectedId = s.detail.identifier;
      this.detailError = '';
      this.playError = '';
    } else if (s.current) {
      this.selectedId = s.current.identifier;
      // New item still loading — clear stale detail so the spinner shows.
      if (this.selected?.identifier !== s.current.identifier) {
        this.selected = null;
      }
    }
    this.cdr.markForCheck();
  }

  private restoreQueueViewMode(source: ArchiveQueueSource): void {
    if (source === 'playlist') {
      this.viewMode = 'playlist';
    } else if (source === 'recent') {
      this.viewMode = 'recent';
    } else if (source === 'catalog') {
      this.viewMode = 'catalog';
    }
  }

  private persistFilters(): void {
    try {
      const state: ArchiveFiltersState = {
        viewMode: this.viewMode,
        mediatype: this.mediatype,
        section: this.section,
        sort: this.sort,
        query: this.query,
        creator: this.creator,
        language: this.language,
        page: this.page,
        waybackUrl: this.waybackUrl
      };
      sessionStorage.setItem(ARCHIVE_FILTERS_STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore quota / private mode */
    }
  }

  /** @returns true when a previous filter snapshot was applied */
  private restoreFilters(): boolean {
    try {
      const raw = sessionStorage.getItem(ARCHIVE_FILTERS_STORAGE_KEY);
      if (!raw) {
        return false;
      }
      const state = JSON.parse(raw) as ArchiveFiltersState;
      if (!state || typeof state !== 'object') {
        return false;
      }
      const modes: ArchiveViewMode[] = ['catalog', 'recent', 'playlist', 'wayback'];
      if (state.viewMode && modes.includes(state.viewMode)) {
        this.viewMode = state.viewMode;
      }
      if (typeof state.mediatype === 'string' && state.mediatype.trim()) {
        this.mediatype = state.mediatype.trim();
      }
      if (typeof state.section === 'string' && state.section.trim()) {
        this.section = state.section.trim();
      }
      if (typeof state.sort === 'string' && state.sort.trim()) {
        this.sort = state.sort.trim();
      }
      if (typeof state.query === 'string') {
        this.query = state.query;
      }
      if (typeof state.creator === 'string') {
        this.creator = state.creator;
      }
      if (typeof state.language === 'string') {
        this.language = state.language;
      }
      if (typeof state.page === 'number' && Number.isFinite(state.page) && state.page >= 1) {
        this.page = Math.floor(state.page);
      }
      if (typeof state.waybackUrl === 'string') {
        this.waybackUrl = state.waybackUrl;
      }
      return true;
    } catch {
      return false;
    }
  }

  addSelectedToPlaylist(): void {
    if (!this.canAddToPlaylist || !this.selected) {
      return;
    }
    if (this.isSelectedInPlaylist) {
      return;
    }
    const teaser = this.toTeaser(this.selected);
    const mt = (teaser.mediatype || '').toLowerCase();
    if (mt !== 'audio' && mt !== 'etree') {
      teaser.mediatype = 'audio';
    }
    this.playlistSub?.unsubscribe();
    this.playlistSub = this.api.addArchiveAudioPlaylistItem(teaser).subscribe({
      next: (res) => {
        this.playlistItems = res?.items || [];
      },
      error: () => {
        this.playlistError = 'ARCHIVE.ERR_PLAYLIST_SAVE';
      }
    });
  }

  removePlaylistItem(event: Event, item: ArchiveItem): void {
    event.stopPropagation();
    if (!this.isLoggedIn || !item?.identifier) {
      return;
    }
    this.playlistSub?.unsubscribe();
    this.playlistSub = this.api.removeArchiveAudioPlaylistItem(item.identifier).subscribe({
      next: (res) => {
        this.playlistItems = res?.items || [];
        if (this.queueSource === 'playlist') {
          this.queueItems = [...this.playlistItems];
        }
        if (this.selectedId === item.identifier) {
          this.clearSelection();
        } else if (this.playlistIndex >= this.queueItems.length) {
          this.playlistIndex = this.queueItems.length - 1;
        }
      },
      error: () => {
        this.playlistError = 'ARCHIVE.ERR_PLAYLIST_SAVE';
      }
    });
  }

  removeRecentItem(event: Event, item: ArchiveItem): void {
    event.stopPropagation();
    if (!this.isLoggedIn || !item?.identifier) {
      return;
    }
    this.recentSub?.unsubscribe();
    this.recentSub = this.api.removeArchiveRecentItem(item.identifier).subscribe({
      next: (res) => {
        this.recentItems = res?.items || [];
        if (this.selectedId === item.identifier) {
          this.clearSelection();
        }
      },
      error: () => {
        this.recentError = 'ARCHIVE.ERR_RECENT_SAVE';
      }
    });
  }

  clearSelection(): void {
    this.selected = null;
    this.selectedId = '';
    this.detailError = '';
    this.playError = '';
    this.clearQueue();
    this.stopMedia();
  }

  playFile(file: ArchiveFile): void {
    if (!file?.downloadUrl) {
      return;
    }
    this.clearQueue();
    this.wantAudioPlay = true;
    const kind = (file.kind || '').toLowerCase();
    this.playError = '';
    this.stopMedia();
    if (kind === 'video') {
      this.playerMode = 'video';
      this.mediaUrl = this.api.tvStreamProxyUrl(file.downloadUrl);
      this.cdr.detectChanges();
      setTimeout(() => this.videoEl?.nativeElement?.play?.().catch(() => undefined), 0);
    } else if (kind === 'audio') {
      this.playerMode = 'audio';
      this.mediaUrl = this.api.tvStreamProxyUrl(file.downloadUrl);
      this.cdr.detectChanges();
      this.tryPlayAudioElement();
    } else if (kind === 'image') {
      this.wantAudioPlay = false;
      this.playerMode = 'image';
      this.mediaUrl = file.downloadUrl;
    } else if (kind === 'pdf' || kind === 'text') {
      this.wantAudioPlay = false;
      this.playerMode = 'iframe';
      this.embedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(file.downloadUrl);
      this.iframeGen += 1;
    } else if (file.downloadUrl) {
      this.wantAudioPlay = false;
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

  openItemInfo(): void {
    if (!this.selected) {
      return;
    }
    this.infoDetail = this.selected;
    this.isLoadingItemInfo = false;
    this.showItemInfoModal = true;
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    }
  }

  /** Icon-only info on catalog / recent / playlist rows — does not change playback. */
  openItemInfoFromList(event: Event, item: ArchiveItem): void {
    event.stopPropagation();
    event.preventDefault();
    if (!item?.identifier) {
      return;
    }
    if (this.selected?.identifier === item.identifier) {
      this.openItemInfo();
      return;
    }
    this.infoDetail = null;
    this.isLoadingItemInfo = true;
    this.showItemInfoModal = true;
    this.infoSub?.unsubscribe();
    this.infoSub = this.api.getArchiveOrgItem(item.identifier).subscribe({
      next: (detail) => {
        this.infoDetail = detail;
        this.isLoadingItemInfo = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.isLoadingItemInfo = false;
        this.showItemInfoModal = false;
        this.infoDetail = null;
        this.cdr.markForCheck();
      }
    });
  }

  closeItemInfo(): void {
    this.showItemInfoModal = false;
    this.isLoadingItemInfo = false;
    this.infoDetail = null;
    this.infoSub?.unsubscribe();
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

  private scrollDetailIntoViewOnMobile(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    if (!window.matchMedia('(max-width: 960px)').matches) {
      return;
    }
    const el = this.detailStage?.nativeElement;
    if (!el) {
      return;
    }
    setTimeout(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
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

  private loadRecent(preferTabIfAny: boolean, silent = false): void {
    if (!this.isLoggedIn) {
      this.recentItems = [];
      this.isLoadingRecent = false;
      if (preferTabIfAny) {
        this.loadItems();
      }
      return;
    }
    if (!silent) {
      this.isLoadingRecent = true;
    }
    this.recentError = '';
    this.recentHint = '';
    this.recentSub?.unsubscribe();
    this.recentSub = this.api.getArchiveRecent().subscribe({
      next: (res) => {
        this.recentItems = res?.items || [];
        this.isLoadingRecent = false;
        if (preferTabIfAny) {
          if (this.recentItems.length > 0) {
            this.viewMode = 'recent';
          } else {
            this.loadItems();
          }
        }
      },
      error: () => {
        this.recentItems = [];
        this.isLoadingRecent = false;
        this.recentError = 'ARCHIVE.ERR_RECENT_LOAD';
        if (preferTabIfAny) {
          this.loadItems();
        }
      }
    });
  }

  private persistRecentSelection(source: ArchiveItem | ArchiveItemDetail): void {
    if (!this.isLoggedIn || !source?.identifier) {
      return;
    }
    const teaser = this.toTeaser(source);
    this.api.touchArchiveRecentItem(teaser).subscribe({
      next: (res) => {
        this.recentItems = res?.items || [];
      },
      error: () => {
        /* non-blocking: selection still works without history sync */
      }
    });
  }

  private loadPlaylist(startPlayback: boolean, silent = false): void {
    if (!this.isLoggedIn) {
      this.playlistItems = [];
      this.isLoadingPlaylist = false;
      if (this.archiveQueue.snapshot.source === 'playlist') {
        this.clearQueue();
      }
      return;
    }
    if (!silent) {
      this.isLoadingPlaylist = true;
    }
    this.playlistError = '';
    this.playlistHint = '';
    this.playlistSub?.unsubscribe();
    this.playlistSub = this.api.getArchiveAudioPlaylist().subscribe({
      next: (res) => {
        this.playlistItems = res?.items || [];
        this.isLoadingPlaylist = false;
        if (
          startPlayback &&
          this.viewMode === 'playlist' &&
          this.playerMode === 'none' &&
          !this.archiveQueue.isActive
        ) {
          if (this.playlistItems.length > 0) {
            this.playPlaylistFrom(0);
          }
        }
      },
      error: () => {
        this.playlistItems = [];
        this.isLoadingPlaylist = false;
        this.playlistError = 'ARCHIVE.ERR_PLAYLIST_LOAD';
        if (this.archiveQueue.snapshot.source === 'playlist') {
          this.clearQueue();
        }
      }
    });
  }

  private clearQueue(): void {
    if (this.archiveQueue.isActive) {
      this.archiveQueue.stop();
    }
    this.playlistActive = false;
    this.playlistIndex = -1;
    this.queueItems = [];
    this.queueSource = 'none';
    this.wantAudioPlay = false;
    this.queueCurrentTime = 0;
    this.queueDuration = 0;
  }

  private tryPlayAudioElement(): void {
    if (!this.wantAudioPlay) {
      return;
    }
    const el = this.audioEl?.nativeElement;
    if (!el || !this.mediaUrl) {
      return;
    }
    try {
      if (el.paused || el.ended || el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        if (el.readyState < HTMLMediaElement.HAVE_METADATA) {
          el.load();
        }
      }
    } catch {
      /* ignore */
    }
    const playResult = el.play?.();
    if (playResult && typeof playResult.then === 'function') {
      void playResult
        .then(() => {
          this.wantAudioPlay = false;
          this.audioIsPaused = false;
        })
        .catch(() => {
          // Autoplay may be blocked until canplay; keep wantAudioPlay for retry.
        });
    }
  }

  private isAudioItem(item: ArchiveItem | ArchiveItemDetail): boolean {
    const mt = (item.mediatype || '').toLowerCase();
    if (mt === 'audio' || mt === 'etree') {
      return true;
    }
    const kind = ((item as ArchiveItemDetail).playKind || '').toLowerCase();
    return kind === 'audio';
  }

  private toTeaser(source: ArchiveItem | ArchiveItemDetail): ArchiveItem {
    return {
      id: source.id || source.identifier,
      identifier: source.identifier,
      title: source.title || source.identifier,
      subtitle: source.subtitle,
      description: source.description,
      creator: source.creator,
      mediatype: source.mediatype,
      year: source.year,
      date: source.date,
      language: source.language,
      subject: source.subject,
      collection: source.collection,
      downloads: source.downloads,
      avgRating: source.avgRating,
      imageUrl: source.imageUrl,
      detailsUrl: source.detailsUrl,
      embedUrl: source.embedUrl,
      playable: source.playable
    };
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

  private loadItems(showOverlay = false): void {
    this.isLoading = true;
    this.showSearchOverlay = showOverlay;
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
          this.showSearchOverlay = false;
        },
        error: () => {
          this.items = [];
          this.total = 0;
          this.isLoading = false;
          this.showSearchOverlay = false;
          this.listError = 'ARCHIVE.ERROR_LIST';
        }
      });
  }

  private autoPlay(detail: ArchiveItemDetail, forcePlay = false): void {
    const kind = (detail.playKind || '').toLowerCase();
    const mt = (detail.mediatype || '').toLowerCase();
    if (detail.dark) {
      this.playError = 'ARCHIVE.ITEM_DARK';
      return;
    }

    // Persistent queue owns its own HTMLAudioElement — never mount a second player.
    if (this.playlistActive || this.archiveQueue.isActive) {
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
      if (forcePlay) {
        this.wantAudioPlay = true;
        this.cdr.detectChanges();
        this.tryPlayAudioElement();
        setTimeout(() => this.tryPlayAudioElement(), 0);
        setTimeout(() => this.tryPlayAudioElement(), 120);
      }
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
    this.audioIsPaused = true;
  }
}
