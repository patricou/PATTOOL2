import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  SecurityContext,
  TemplateRef,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml, SafeResourceUrl } from '@angular/platform-browser';
import { NgbModal, NgbModalRef, NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { environment } from '../../environments/environment';
import { Evenement } from '../model/evenement';
import {
  ApiService,
  ArchiveAudioCollection,
  ArchiveCodeLabel,
  ArchiveFile,
  ArchiveItem,
  ArchiveItemDetail,
  WaybackSnapshot
} from '../services/api.service';
import { EvenementsService, StreamedEvent } from '../services/evenements.service';
import { FileService } from '../services/file.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { MembersService } from '../services/members.service';
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
  country?: string;
  page?: number;
  waybackUrl?: string;
  selectedCollectionId?: string;
}

@Component({
  selector: 'app-archive-watcher',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule],
  providers: [EvenementsService],
  templateUrl: './archive-watcher.component.html',
  styleUrls: ['./archive-watcher.component.css']
})
export class ArchiveWatcherComponent implements OnInit, OnDestroy {
  @ViewChild('videoEl') videoEl?: ElementRef<HTMLVideoElement>;
  @ViewChild('audioEl') audioEl?: ElementRef<HTMLAudioElement>;
  @ViewChild('detailStage') detailStage?: ElementRef<HTMLElement>;
  @ViewChild('insertImageInEventModal') insertImageInEventModal?: TemplateRef<unknown>;

  viewMode: ArchiveViewMode = 'catalog';
  mediatype = 'movies';
  section = 'RECENT';
  sort = 'downloads';
  query = '';
  creator = '';
  language = '';
  country = '';

  mediatypes: ArchiveCodeLabel[] = [];
  sections: ArchiveCodeLabel[] = [];
  sorts: ArchiveCodeLabel[] = [];

  items: ArchiveItem[] = [];
  /** Client-side filter on the current results page only (does not re-query Archive.org). */
  listFilter = '';
  recentItems: ArchiveItem[] = [];
  /** Shared audio collections (public list). */
  playlistCollections: ArchiveAudioCollection[] = [];
  /** Currently opened collection (with items). */
  selectedCollection: ArchiveAudioCollection | null = null;
  selectedCollectionId = '';
  /** Items of the opened collection (convenience). */
  playlistItems: ArchiveItem[] = [];
  newCollectionName = '';
  showCreateCollection = false;
  addToCollectionId = '';
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
  /** Zoom factor for image player (1 = fit). */
  imageZoom = 1;
  imagePanX = 0;
  imagePanY = 0;
  imageDragging = false;
  readonly imageZoomMin = 0.5;
  readonly imageZoomMax = 6;
  private readonly imageZoomStep = 0.25;
  private imageDragStartX = 0;
  private imageDragStartY = 0;
  private imagePanAtDragStartX = 0;
  private imagePanAtDragStartY = 0;
  /** Original filename for the image currently shown (upload to activity). */
  imageSourceName = '';

  /** Insert current Archive image into an activity (Mongo / GridFS), like photo reader. */
  insertImageEventsList: Evenement[] = [];
  insertImageEventsFilter = '';
  insertImageEventsTypeFilter = '';
  insertImageEventsLoading = false;
  insertImageEventsError = false;
  insertImageUploadingEventId: string | null = null;
  insertImageFeedbackKey: string | null = null;
  insertImageFeedbackParams: { name?: string } = {};
  insertImageFeedbackKind: 'success' | 'error' | null = null;
  readonly insertImageEventTypeOptions: ReadonlyArray<{ value: string; labelKey: string }> = [
    { value: '11', labelKey: 'EVENTCREATION.TYPE.DOCUMENTS' },
    { value: '12', labelKey: 'EVENTCREATION.TYPE.FICHE' },
    { value: '3', labelKey: 'EVENTCREATION.TYPE.RUN' },
    { value: '6', labelKey: 'EVENTCREATION.TYPE.PARTY' },
    { value: '4', labelKey: 'EVENTCREATION.TYPE.WALK' },
    { value: '10', labelKey: 'EVENTCREATION.TYPE.PHOTOS' },
    { value: '9', labelKey: 'EVENTCREATION.TYPE.RANDO' },
    { value: '2', labelKey: 'EVENTCREATION.TYPE.SKI' },
    { value: '7', labelKey: 'EVENTCREATION.TYPE.VACATION' },
    { value: '5', labelKey: 'EVENTCREATION.TYPE.BIKE' },
    { value: '8', labelKey: 'EVENTCREATION.TYPE.TRAVEL' },
    { value: '1', labelKey: 'EVENTCREATION.TYPE.VTT' },
    { value: '13', labelKey: 'EVENTCREATION.TYPE.WINE' },
    { value: '14', labelKey: 'EVENTCREATION.TYPE.OTHER' },
    { value: '15', labelKey: 'EVENTCREATION.TYPE.VISIT' },
    { value: '16', labelKey: 'EVENTCREATION.TYPE.WORK' },
    { value: '17', labelKey: 'EVENTCREATION.TYPE.FAMILY' },
    { value: '18', labelKey: 'EVENTCREATION.TYPE.CINEMA' },
    { value: '19', labelKey: 'EVENTCREATION.TYPE.MUSIQUE' },
    { value: '20', labelKey: 'EVENTCREATION.TYPE.CUISINE' }
  ];
  private insertImageModalRef: NgbModalRef | null = null;
  private insertImageEventsStreamSub?: Subscription;
  private insertImageUploadSub?: Subscription;
  private insertImageFeedbackTimer?: ReturnType<typeof setTimeout>;
  private static readonly INSERT_IMAGE_FEEDBACK_AUTO_CLOSE_MS = 1800;

  get imageZoomPercent(): number {
    return Math.round(this.imageZoom * 100);
  }

  get imageTransform(): string {
    return `translate(${this.imagePanX}px, ${this.imagePanY}px) scale(${this.imageZoom})`;
  }

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

  /** Values match Archive.org {@code country} / {@code coverage} metadata (mostly English names). */
  readonly countryOptions: Array<{ value: string; label: string }> = [
    { value: '', label: '—' },
    { value: 'Argentina', label: 'Argentina' },
    { value: 'Australia', label: 'Australia' },
    { value: 'Austria', label: 'Austria' },
    { value: 'Belgium', label: 'Belgium' },
    { value: 'Brazil', label: 'Brazil' },
    { value: 'Canada', label: 'Canada' },
    { value: 'China', label: 'China' },
    { value: 'Denmark', label: 'Denmark' },
    { value: 'Egypt', label: 'Egypt' },
    { value: 'Finland', label: 'Finland' },
    { value: 'France', label: 'France' },
    { value: 'Germany', label: 'Germany' },
    { value: 'Greece', label: 'Greece' },
    { value: 'India', label: 'India' },
    { value: 'Indonesia', label: 'Indonesia' },
    { value: 'Ireland', label: 'Ireland' },
    { value: 'Israel', label: 'Israel' },
    { value: 'Italy', label: 'Italy' },
    { value: 'Japan', label: 'Japan' },
    { value: 'Mexico', label: 'Mexico' },
    { value: 'Morocco', label: 'Morocco' },
    { value: 'Netherlands', label: 'Netherlands' },
    { value: 'Norway', label: 'Norway' },
    { value: 'Poland', label: 'Poland' },
    { value: 'Portugal', label: 'Portugal' },
    { value: 'Russia', label: 'Russia' },
    { value: 'South Africa', label: 'South Africa' },
    { value: 'South Korea', label: 'South Korea' },
    { value: 'Spain', label: 'Spain' },
    { value: 'Sweden', label: 'Sweden' },
    { value: 'Switzerland', label: 'Switzerland' },
    { value: 'Turkey', label: 'Turkey' },
    { value: 'United Kingdom', label: 'United Kingdom' },
    { value: 'United States', label: 'United States' }
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
    private archiveQueue: ArchiveAudioQueueService,
    private modalService: NgbModal,
    private membersService: MembersService,
    private fileService: FileService,
    private evenementsService: EvenementsService
  ) {}

  get isLoggedIn(): boolean {
    return this.keycloak.isLoggedIn();
  }

  get recentCount(): number {
    return this.recentItems.length;
  }

  get playlistCount(): number {
    return this.playlistCollections.length;
  }

  get ownedCollections(): ArchiveAudioCollection[] {
    return this.playlistCollections.filter((c) => !!c.ownedByMe);
  }

  get canManageSelectedCollection(): boolean {
    return !!this.isLoggedIn && !!this.selectedCollection?.ownedByMe;
  }

  /** Audio / concert rows on the current catalog page — used by « Tout lire ». */
  get catalogAudioItems(): ArchiveItem[] {
    return this.items.filter((i) => this.isAudioItem(i));
  }

  /** Current catalog page items after the local list filter. */
  get filteredItems(): ArchiveItem[] {
    return this.filterDisplayedItems(this.items, this.listFilter);
  }

  get canPlayAllCatalog(): boolean {
    return !this.isLoading && this.catalogAudioItems.length > 0;
  }

  clearListFilter(): void {
    this.listFilter = '';
  }

  private filterDisplayedItems(source: ArchiveItem[], rawFilter: string): ArchiveItem[] {
    const term = (rawFilter || '').trim().toLowerCase();
    if (!term) {
      return source;
    }
    return source.filter((item) => {
      const hay = [item.title, item.subtitle, item.creator, item.identifier, item.mediatype]
        .filter((v) => !!v)
        .join(' ')
        .toLowerCase();
      return hay.includes(term);
    });
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
    return this.isAudioItem(this.selected) && this.ownedCollections.length > 0;
  }

  get isSelectedInTargetCollection(): boolean {
    const id = this.selected?.identifier;
    if (!id || !this.addToCollectionId) {
      return false;
    }
    if (this.selectedCollection?.id === this.addToCollectionId) {
      return this.playlistItems.some((i) => i.identifier === id);
    }
    return false;
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

  /** Plain text with search terms wrapped in {@code <mark>} for the item info modal. */
  highlightSearchText(value: string | null | undefined): SafeHtml {
    const escaped = this.escapeHtml(value ?? '');
    return this.sanitizer.bypassSecurityTrustHtml(this.applySearchHighlight(escaped));
  }

  /** Sanitize description HTML, then highlight search terms in text nodes only. */
  toHighlightedHtml(value: string | null | undefined): SafeHtml {
    const cleaned = this.sanitizer.sanitize(SecurityContext.HTML, value ?? '') ?? '';
    return this.sanitizer.bypassSecurityTrustHtml(this.applySearchHighlight(cleaned, true));
  }

  /** Exposed for template (search-driven layout). */
  searchHighlightTermsPublic(): string[] {
    return this.searchHighlightTerms();
  }

  /** Whether a chip/label contains any current search term (for subject chips). */
  hasSearchHit(value: string | null | undefined): boolean {
    const terms = this.searchHighlightTerms();
    if (!terms.length || !value) {
      return false;
    }
    const lower = value.toLowerCase();
    return terms.some((t) => lower.includes(t.toLowerCase()));
  }

  /** Visible excerpts so the match is obvious even when buried in a long description. */
  searchMatchExcerpts(): Array<{ fieldKey: string; excerpt: string }> {
    const terms = this.searchHighlightTerms();
    const detail = this.infoDetail;
    if (!terms.length || !detail) {
      return [];
    }
    const fields: Array<{ fieldKey: string; value: string | null | undefined }> = [
      { fieldKey: 'ARCHIVE.INFO_DESCRIPTION', value: this.stripHtml(detail.description) },
      { fieldKey: 'ARCHIVE.INFO_IDENTIFIER', value: detail.identifier },
      { fieldKey: 'ARCHIVE.CREATOR', value: detail.creator },
      { fieldKey: 'ARCHIVE.ITEM_INFO_TITLE', value: detail.title },
      {
        fieldKey: 'ARCHIVE.INFO_SUBJECTS',
        value: detail.subjects?.length ? detail.subjects.join(', ') : detail.subject
      }
    ];
    const out: Array<{ fieldKey: string; excerpt: string }> = [];
    for (const field of fields) {
      const excerpt = this.excerptAroundTerms(field.value, terms);
      if (excerpt) {
        out.push({ fieldKey: field.fieldKey, excerpt });
      }
    }
    return out;
  }

  private searchHighlightTerms(): string[] {
    const raw = `${this.query || ''} ${this.creator || ''}`.trim();
    if (!raw) {
      return [];
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of raw.split(/\s+/)) {
      const t = part.trim();
      if (t.length < 2) {
        continue;
      }
      const key = t.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(t);
    }
    return out;
  }

  private applySearchHighlight(htmlOrText: string, preserveTags = false): string {
    const terms = this.searchHighlightTerms();
    if (!terms.length || !htmlOrText) {
      return htmlOrText;
    }
    const pattern = terms
      .slice()
      .sort((a, b) => b.length - a.length)
      .map((t) => this.escapeRegExp(t))
      .join('|');
    const re = new RegExp(`(${pattern})`, 'gi');
    // Inline styles: injected HTML is outside Angular view encapsulation.
    const wrap = (chunk: string) =>
      chunk.replace(
        re,
        '<mark class="ia-search-hit" style="background:#ff9800;color:#111;font-weight:700;padding:0 0.15em;border-radius:2px">$1</mark>'
      );
    if (!preserveTags) {
      return wrap(htmlOrText);
    }
    return htmlOrText.replace(/(<[^>]+>)|([^<]+)/g, (_m, tag: string | undefined, text: string | undefined) =>
      tag ? tag : wrap(text ?? '')
    );
  }

  private excerptAroundTerms(value: string | null | undefined, terms: string[]): string | null {
    const text = (value ?? '').replace(/\s+/g, ' ').trim();
    if (!text || !terms.length) {
      return null;
    }
    const lower = text.toLowerCase();
    let best = -1;
    let termLen = 0;
    for (const t of terms) {
      const idx = lower.indexOf(t.toLowerCase());
      if (idx >= 0 && (best < 0 || idx < best)) {
        best = idx;
        termLen = t.length;
      }
    }
    if (best < 0) {
      return null;
    }
    const start = Math.max(0, best - 42);
    const end = Math.min(text.length, best + termLen + 42);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    return prefix + text.slice(start, end).trim() + suffix;
  }

  private stripHtml(value: string | null | undefined): string {
    if (!value) {
      return '';
    }
    return value
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    this.loadPlaylistCollections(true);
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
    this.insertImageEventsStreamSub?.unsubscribe();
    this.insertImageUploadSub?.unsubscribe();
    if (this.insertImageFeedbackTimer !== undefined) {
      clearTimeout(this.insertImageFeedbackTimer);
    }
    this.insertImageModalRef?.dismiss();
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
      this.playlistHint = '';
      this.loadPlaylistCollections(false);
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

  onCountryChange(): void {
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
    this.country = '';
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
        country: this.country,
        page: this.page,
        waybackUrl: this.waybackUrl,
        selectedCollectionId: this.selectedCollectionId
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
      if (typeof state.country === 'string') {
        this.country = state.country;
      }
      if (typeof state.page === 'number' && Number.isFinite(state.page) && state.page >= 1) {
        this.page = Math.floor(state.page);
      }
      if (typeof state.waybackUrl === 'string') {
        this.waybackUrl = state.waybackUrl;
      }
      if (typeof state.selectedCollectionId === 'string') {
        this.selectedCollectionId = state.selectedCollectionId;
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
    const collectionId = this.addToCollectionId || this.ownedCollections[0]?.id;
    if (!collectionId) {
      this.playlistError = 'ARCHIVE.PLAYLIST_CREATE_FIRST';
      return;
    }
    const teaser = this.toTeaser(this.selected);
    const mt = (teaser.mediatype || '').toLowerCase();
    if (mt !== 'audio' && mt !== 'etree') {
      teaser.mediatype = 'audio';
    }
    this.playlistSub?.unsubscribe();
    this.playlistSub = this.api.addArchiveAudioCollectionItem(collectionId, teaser).subscribe({
      next: (res) => {
        this.applyCollectionDetail(res);
        this.refreshCollectionTeaser(res);
        this.addToCollectionId = collectionId;
      },
      error: () => {
        this.playlistError = 'ARCHIVE.ERR_PLAYLIST_SAVE';
      }
    });
  }

  removePlaylistItem(event: Event, item: ArchiveItem): void {
    event.stopPropagation();
    if (!this.canManageSelectedCollection || !item?.identifier || !this.selectedCollectionId) {
      return;
    }
    this.playlistSub?.unsubscribe();
    this.playlistSub = this.api
      .removeArchiveAudioCollectionItem(this.selectedCollectionId, item.identifier)
      .subscribe({
        next: (res) => {
          this.applyCollectionDetail(res);
          this.refreshCollectionTeaser(res);
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

  openCollection(col: ArchiveAudioCollection): void {
    if (!col?.id) {
      return;
    }
    this.selectedCollectionId = col.id;
    this.persistFilters();
    this.loadCollectionDetail(col.id, false);
  }

  backToCollections(): void {
    this.selectedCollection = null;
    this.selectedCollectionId = '';
    this.playlistItems = [];
    this.persistFilters();
  }

  toggleCreateCollection(): void {
    this.showCreateCollection = !this.showCreateCollection;
    this.playlistError = '';
  }

  createCollection(): void {
    if (!this.isLoggedIn) {
      this.playlistHint = 'ARCHIVE.PLAYLIST_LOGIN_CREATE';
      return;
    }
    const name = (this.newCollectionName || '').trim();
    if (!name) {
      this.playlistError = 'ARCHIVE.PLAYLIST_NAME_REQUIRED';
      return;
    }
    this.playlistSub?.unsubscribe();
    this.playlistSub = this.api.createArchiveAudioCollection({ name }).subscribe({
      next: (res) => {
        this.newCollectionName = '';
        this.showCreateCollection = false;
        this.playlistCollections = [res, ...this.playlistCollections.filter((c) => c.id !== res.id)];
        this.openCollection(res);
      },
      error: (err) => {
        const code = err?.error?.error;
        this.playlistError =
          code === 'too_many_collections'
            ? 'ARCHIVE.ERR_PLAYLIST_TOO_MANY'
            : 'ARCHIVE.ERR_PLAYLIST_SAVE';
      }
    });
  }

  renameSelectedCollection(): void {
    if (!this.canManageSelectedCollection || !this.selectedCollection) {
      return;
    }
    const name = window.prompt(
      this.translate.instant('ARCHIVE.PLAYLIST_RENAME_PROMPT'),
      this.selectedCollection.name || ''
    );
    if (name == null) {
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      this.playlistError = 'ARCHIVE.PLAYLIST_NAME_REQUIRED';
      return;
    }
    this.playlistSub?.unsubscribe();
    this.playlistSub = this.api
      .updateArchiveAudioCollection(this.selectedCollection.id, {
        name: trimmed,
        description: this.selectedCollection.description
      })
      .subscribe({
        next: (res) => {
          this.applyCollectionDetail(res);
          this.refreshCollectionTeaser(res);
        },
        error: () => {
          this.playlistError = 'ARCHIVE.ERR_PLAYLIST_SAVE';
        }
      });
  }

  deleteSelectedCollection(): void {
    if (!this.canManageSelectedCollection || !this.selectedCollection) {
      return;
    }
    const ok = window.confirm(
      this.translate.instant('ARCHIVE.PLAYLIST_DELETE_CONFIRM', {
        name: this.selectedCollection.name
      })
    );
    if (!ok) {
      return;
    }
    const id = this.selectedCollection.id;
    this.playlistSub?.unsubscribe();
    this.playlistSub = this.api.deleteArchiveAudioCollection(id).subscribe({
      next: () => {
        this.playlistCollections = this.playlistCollections.filter((c) => c.id !== id);
        if (this.queueSource === 'playlist') {
          this.clearQueue();
        }
        this.backToCollections();
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
      this.imageSourceName = (file.name || '').trim() || this.guessFileNameFromUrl(file.downloadUrl);
      this.resetImageZoom();
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
    if (!this.selected?.identifier) {
      return;
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    }
    // Always reload full metadata: list/detail cache may have truncated description.
    this.openItemInfoForIdentifier(this.selected.identifier, this.selected);
  }

  /** Icon-only info on catalog / recent / playlist rows — does not change playback. */
  openItemInfoFromList(event: Event, item: ArchiveItem): void {
    event.stopPropagation();
    event.preventDefault();
    if (!item?.identifier) {
      return;
    }
    this.openItemInfoForIdentifier(item.identifier, item);
  }

  private openItemInfoForIdentifier(identifier: string, preview?: ArchiveItem | ArchiveItemDetail): void {
    this.infoDetail = preview ?? null;
    // Keep spinner until full metadata arrives so truncated list descriptions are not shown as final.
    this.isLoadingItemInfo = true;
    this.showItemInfoModal = true;
    this.infoSub?.unsubscribe();
    this.infoSub = this.api.getArchiveOrgItem(identifier).subscribe({
      next: (detail) => {
        this.infoDetail = detail;
        this.isLoadingItemInfo = false;
        this.cdr.markForCheck();
        this.scheduleScrollToSearchHit();
      },
      error: () => {
        this.isLoadingItemInfo = false;
        if (!this.infoDetail) {
          this.showItemInfoModal = false;
          this.infoDetail = null;
        }
        this.cdr.markForCheck();
        this.scheduleScrollToSearchHit();
      }
    });
  }

  private scheduleScrollToSearchHit(): void {
    if (!this.searchHighlightTerms().length) {
      return;
    }
    setTimeout(() => {
      const modal = document.querySelector('.ia-item-info-modal');
      const hit =
        (modal?.querySelector('.ia-search-match-banner .ia-search-hit') as HTMLElement | null) ||
        (modal?.querySelector('.ia-search-hit') as HTMLElement | null);
      hit?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 120);
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

  zoomImageIn(): void {
    this.setImageZoom(this.imageZoom + this.imageZoomStep);
  }

  zoomImageOut(): void {
    this.setImageZoom(this.imageZoom - this.imageZoomStep);
  }

  resetImageZoom(): void {
    this.imageZoom = 1;
    this.imagePanX = 0;
    this.imagePanY = 0;
    this.imageDragging = false;
  }

  onImageWheel(event: WheelEvent): void {
    if (this.playerMode !== 'image') {
      return;
    }
    event.preventDefault();
    const delta = event.deltaY > 0 ? -this.imageZoomStep : this.imageZoomStep;
    this.setImageZoom(this.imageZoom + delta);
  }

  onImagePointerDown(event: PointerEvent): void {
    if (this.playerMode !== 'image' || event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('.ia-image-zoom-controls, .ia-player-fs')) {
      return;
    }
    this.imageDragging = true;
    this.imageDragStartX = event.clientX;
    this.imageDragStartY = event.clientY;
    this.imagePanAtDragStartX = this.imagePanX;
    this.imagePanAtDragStartY = this.imagePanY;
    try {
      (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    } catch {
      /* ignore */
    }
    event.preventDefault();
  }

  onImagePointerMove(event: PointerEvent): void {
    if (!this.imageDragging) {
      return;
    }
    this.imagePanX = this.imagePanAtDragStartX + (event.clientX - this.imageDragStartX);
    this.imagePanY = this.imagePanAtDragStartY + (event.clientY - this.imageDragStartY);
  }

  onImagePointerUp(event: PointerEvent): void {
    if (!this.imageDragging) {
      return;
    }
    this.imageDragging = false;
    try {
      (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
    } catch {
      /* ignore */
    }
  }

  private setImageZoom(next: number): void {
    const z = Math.round(next * 100) / 100;
    this.imageZoom = Math.min(this.imageZoomMax, Math.max(this.imageZoomMin, z));
    if (this.imageZoom <= 1) {
      this.imagePanX = 0;
      this.imagePanY = 0;
    }
  }

  /** Opens activity picker and uploads the current Archive image into Mongo (GridFS), like the photo reader. */
  openSendImageToActivity(): void {
    if (this.playerMode !== 'image' || !this.mediaUrl) {
      return;
    }
    if (!this.isLoggedIn) {
      this.playError = 'ARCHIVE.SEND_TO_ACTIVITY_LOGIN';
      this.cdr.markForCheck();
      return;
    }
    if (!this.insertImageInEventModal) {
      return;
    }
    // Modal is appended to <body>; browser fullscreen would keep it behind the image stage.
    if (document.fullscreenElement) {
      const exiting = document.exitFullscreen?.();
      if (exiting) {
        void exiting.finally(() => this.openInsertImageInEventModal());
        return;
      }
    }
    this.openInsertImageInEventModal();
  }

  private openInsertImageInEventModal(): void {
    if (!this.insertImageInEventModal) {
      return;
    }
    this.insertImageEventsList = [];
    this.insertImageEventsFilter = '';
    this.insertImageEventsTypeFilter = '';
    this.insertImageEventsLoading = true;
    this.insertImageEventsError = false;
    this.insertImageUploadingEventId = null;
    this.insertImageFeedbackKey = null;
    this.insertImageFeedbackParams = {};
    this.insertImageFeedbackKind = null;
    if (this.insertImageFeedbackTimer !== undefined) {
      clearTimeout(this.insertImageFeedbackTimer);
      this.insertImageFeedbackTimer = undefined;
    }

    this.insertImageModalRef = this.modalService.open(this.insertImageInEventModal, {
      size: 'lg',
      centered: true,
      windowClass: 'archive-insert-image-modal',
      backdropClass: 'archive-insert-image-modal-backdrop',
      modalDialogClass: 'archive-insert-image-modal-dialog'
    });
    this.insertImageModalRef.dismissed.subscribe(() => this.onInsertImageModalClosed());
    this.insertImageModalRef.closed.subscribe(() => this.onInsertImageModalClosed());
    this.cdr.markForCheck();
    this.streamEventsForInsertImage();
  }

  cancelInsertImageInEventModal(): void {
    this.insertImageModalRef?.dismiss();
  }

  insertImageFilteredEvents(): Evenement[] {
    const term = (this.insertImageEventsFilter ?? '').trim().toLowerCase();
    const typeFilter = (this.insertImageEventsTypeFilter ?? '').trim();
    const list = this.insertImageEventsList;
    let out = !term
      ? list
      : list.filter((e) => (e.evenementName ?? '').toLowerCase().includes(term));
    if (typeFilter) {
      out = out.filter((e) => (e.type ?? '') === typeFilter);
    }
    out = [...out].sort((a, b) => {
      const dA = a?.beginEventDate ? new Date(a.beginEventDate).getTime() : 0;
      const dB = b?.beginEventDate ? new Date(b.beginEventDate).getTime() : 0;
      return dB - dA;
    });
    return out;
  }

  insertImageEventTypeLabelKey(typeId: string | undefined | null): string {
    const id = (typeId ?? '').trim();
    if (!id) {
      return '';
    }
    const found = this.insertImageEventTypeOptions.find((o) => o.value === id);
    return found ? found.labelKey : id;
  }

  insertImageEventDateLabel(ev: Evenement): string {
    const d = ev?.beginEventDate ? new Date(ev.beginEventDate) : null;
    if (!d || Number.isNaN(d.getTime())) {
      return '';
    }
    try {
      return d.toLocaleDateString(this.numberLocale(), {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch {
      return d.toISOString().slice(0, 10);
    }
  }

  canSubmitInsertForEvent(ev: Evenement): boolean {
    return this.insertImageUploadingEventId == null && !!ev?.id;
  }

  async onSelectEventForInsert(ev: Evenement): Promise<void> {
    if (!this.canSubmitInsertForEvent(ev)) {
      return;
    }
    const user = this.membersService.getUser();
    if (!user?.id) {
      this.setInsertImageFeedback('error', 'ASSISTANT.INSERT_IMG_IN_EVENT_NO_USER');
      return;
    }

    this.insertImageUploadingEventId = ev.id;
    this.insertImageFeedbackKey = null;
    this.insertImageFeedbackKind = null;
    this.cdr.markForCheck();

    try {
      const file = await this.fetchCurrentImageAsFile();
      if (!file) {
        this.insertImageUploadingEventId = null;
        this.setInsertImageFeedback('error', 'ASSISTANT.INSERT_IMG_IN_EVENT_FILE_ERROR');
        return;
      }

      const formData = new FormData();
      formData.append('file', file, file.name);
      // Same default as photo reader when compression is on: backend may downscale before Mongo.
      formData.append('allowOriginal', 'false');

      const uploadUrl = `${environment.API_URL4FILE}/${user.id}/${ev.id}`;
      this.insertImageUploadSub?.unsubscribe();
      this.insertImageUploadSub = this.fileService.postFileToUrl(formData, user, uploadUrl).subscribe({
        next: () => {
          this.insertImageUploadingEventId = null;
          this.setInsertImageFeedback('success', 'ASSISTANT.INSERT_IMG_IN_EVENT_SUCCESS', {
            name: ev.evenementName ?? ''
          });
          this.scheduleInsertModalAutoClose();
          this.cdr.markForCheck();
        },
        error: () => {
          this.insertImageUploadingEventId = null;
          this.setInsertImageFeedback('error', 'ASSISTANT.INSERT_IMG_IN_EVENT_UPLOAD_ERROR');
          this.cdr.markForCheck();
        }
      });
    } catch {
      this.insertImageUploadingEventId = null;
      this.setInsertImageFeedback('error', 'ASSISTANT.INSERT_IMG_IN_EVENT_FILE_ERROR');
      this.cdr.markForCheck();
    }
  }

  private streamEventsForInsertImage(): void {
    this.insertImageEventsStreamSub?.unsubscribe();
    const user = this.membersService.getUser();
    const userId = user?.id ?? '';

    this.insertImageEventsStreamSub = this.evenementsService.streamEvents('*', userId).subscribe({
      next: (s: StreamedEvent) => {
        if (s.type === 'event' && s.data && typeof s.data === 'object' && 'id' in s.data) {
          const incoming = s.data as Evenement;
          const existsIdx = this.insertImageEventsList.findIndex((e) => e.id === incoming.id);
          if (existsIdx === -1) {
            this.insertImageEventsList = [...this.insertImageEventsList, incoming];
          }
          this.cdr.markForCheck();
        } else if (s.type === 'complete') {
          this.insertImageEventsLoading = false;
          this.cdr.markForCheck();
        }
      },
      error: () => {
        this.insertImageEventsLoading = false;
        this.insertImageEventsError = true;
        this.cdr.markForCheck();
      },
      complete: () => {
        this.insertImageEventsLoading = false;
        this.cdr.markForCheck();
      }
    });
  }

  private onInsertImageModalClosed(): void {
    this.insertImageEventsStreamSub?.unsubscribe();
    this.insertImageEventsStreamSub = undefined;
    this.insertImageUploadSub?.unsubscribe();
    this.insertImageUploadSub = undefined;
    this.insertImageModalRef = null;
    this.insertImageUploadingEventId = null;
    if (this.insertImageFeedbackTimer !== undefined) {
      clearTimeout(this.insertImageFeedbackTimer);
      this.insertImageFeedbackTimer = undefined;
    }
  }

  private setInsertImageFeedback(
    kind: 'success' | 'error',
    key: string,
    params: { name?: string } = {}
  ): void {
    this.insertImageFeedbackKind = kind;
    this.insertImageFeedbackKey = key;
    this.insertImageFeedbackParams = params;
    this.cdr.markForCheck();
  }

  private scheduleInsertModalAutoClose(): void {
    if (this.insertImageFeedbackTimer !== undefined) {
      clearTimeout(this.insertImageFeedbackTimer);
    }
    this.insertImageFeedbackTimer = setTimeout(() => {
      this.insertImageModalRef?.close();
      this.insertImageFeedbackTimer = undefined;
    }, ArchiveWatcherComponent.INSERT_IMAGE_FEEDBACK_AUTO_CLOSE_MS);
  }

  private async fetchCurrentImageAsFile(): Promise<File | null> {
    const src = (this.mediaUrl || '').trim();
    if (!src) {
      return null;
    }
    // Proxy via backend to avoid archive.org CORS when reading bytes for upload.
    const fetchUrl = this.api.tvStreamProxyUrl(src);
    const res = await fetch(fetchUrl);
    if (!res.ok) {
      return null;
    }
    const blob = await res.blob();
    if (!blob || blob.size <= 0) {
      return null;
    }
    const name =
      (this.imageSourceName || '').trim() ||
      this.guessFileNameFromUrl(src) ||
      `archive-image-${Date.now()}.jpg`;
    const type =
      blob.type && blob.type.startsWith('image/')
        ? blob.type
        : this.guessImageMimeFromName(name);
    return new File([blob], name, { type });
  }

  private guessFileNameFromUrl(url: string): string {
    try {
      const path = new URL(url).pathname;
      const last = path.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(last).trim();
    } catch {
      const last = (url || '').split('?')[0].split('/').filter(Boolean).pop() || '';
      try {
        return decodeURIComponent(last).trim();
      } catch {
        return last.trim();
      }
    }
  }

  private guessImageMimeFromName(name: string): string {
    const lower = (name || '').toLowerCase();
    if (lower.endsWith('.png')) {
      return 'image/png';
    }
    if (lower.endsWith('.gif')) {
      return 'image/gif';
    }
    if (lower.endsWith('.webp')) {
      return 'image/webp';
    }
    if (lower.endsWith('.tif') || lower.endsWith('.tiff')) {
      return 'image/tiff';
    }
    return 'image/jpeg';
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

  trackByCollectionId(_: number, col: ArchiveAudioCollection): string {
    return col?.id || String(_);
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

  private loadPlaylistCollections(openRestored: boolean, silent = false): void {
    if (!silent) {
      this.isLoadingPlaylist = true;
    }
    this.playlistError = '';
    this.playlistHint = '';
    this.playlistSub?.unsubscribe();
    this.playlistSub = this.api.listArchiveAudioCollections().subscribe({
      next: (list) => {
        this.playlistCollections = Array.isArray(list) ? list : [];
        this.isLoadingPlaylist = false;
        if (!this.addToCollectionId) {
          this.addToCollectionId = this.ownedCollections[0]?.id || '';
        } else if (!this.ownedCollections.some((c) => c.id === this.addToCollectionId)) {
          this.addToCollectionId = this.ownedCollections[0]?.id || '';
        }
        const restoreId = this.selectedCollectionId;
        if (restoreId && this.playlistCollections.some((c) => c.id === restoreId)) {
          this.loadCollectionDetail(restoreId, false);
        } else if (openRestored) {
          this.selectedCollection = null;
          this.selectedCollectionId = '';
          this.playlistItems = [];
        }
      },
      error: () => {
        this.playlistCollections = [];
        this.isLoadingPlaylist = false;
        this.playlistError = 'ARCHIVE.ERR_PLAYLIST_LOAD';
      }
    });
  }

  private loadCollectionDetail(id: string, startPlayback: boolean): void {
    this.isLoadingPlaylist = true;
    this.playlistError = '';
    this.playlistSub?.unsubscribe();
    this.playlistSub = this.api.getArchiveAudioCollection(id).subscribe({
      next: (res) => {
        this.applyCollectionDetail(res);
        this.refreshCollectionTeaser(res);
        this.isLoadingPlaylist = false;
        if (
          startPlayback &&
          this.viewMode === 'playlist' &&
          this.playerMode === 'none' &&
          !this.archiveQueue.isActive &&
          this.playlistItems.length > 0
        ) {
          this.playPlaylistFrom(0);
        }
      },
      error: () => {
        this.isLoadingPlaylist = false;
        this.selectedCollection = null;
        this.playlistItems = [];
        this.playlistError = 'ARCHIVE.ERR_PLAYLIST_LOAD';
      }
    });
  }

  private applyCollectionDetail(res: ArchiveAudioCollection | null | undefined): void {
    if (!res?.id) {
      this.selectedCollection = null;
      this.selectedCollectionId = '';
      this.playlistItems = [];
      return;
    }
    this.selectedCollection = res;
    this.selectedCollectionId = res.id;
    this.playlistItems = res.items || [];
  }

  private refreshCollectionTeaser(res: ArchiveAudioCollection): void {
    if (!res?.id) {
      return;
    }
    const teaser: ArchiveAudioCollection = {
      ...res,
      items: undefined,
      itemCount: res.items?.length ?? res.itemCount ?? 0
    };
    const idx = this.playlistCollections.findIndex((c) => c.id === res.id);
    if (idx >= 0) {
      this.playlistCollections = [
        ...this.playlistCollections.slice(0, idx),
        teaser,
        ...this.playlistCollections.slice(idx + 1)
      ];
    } else {
      this.playlistCollections = [teaser, ...this.playlistCollections];
    }
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

  isAudioItem(item: ArchiveItem | ArchiveItemDetail): boolean {
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
        country: this.country,
        sort: this.sort,
        page: this.page
      })
      .subscribe({
        next: (page) => {
          this.items = page.items || [];
          this.listFilter = '';
          this.total = page.total || 0;
          this.page = page.page || 1;
          this.pages = page.pages || 1;
          this.isLoading = false;
          this.showSearchOverlay = false;
        },
        error: () => {
          this.items = [];
          this.listFilter = '';
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
      this.imageSourceName = this.guessFileNameFromUrl(detail.playUrl) || `${detail.identifier || 'archive'}.jpg`;
      this.resetImageZoom();
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
      this.imageSourceName = this.guessFileNameFromUrl(detail.imageUrl) || `${detail.identifier || 'archive'}.jpg`;
      this.resetImageZoom();
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
    this.imageSourceName = '';
    this.resetImageZoom();
  }
}
