import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostBinding,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  TemplateRef,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModal, NgbModalRef, NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { Subscription } from 'rxjs';

import {
  ApiService,
  TvRecording,
  TvRecordingStatus,
  YoutubeItem,
  YoutubeItemKind,
  YoutubeSearchPage
} from '../services/api.service';
import { YoutubePlayerService } from '../services/youtube-player.service';
import { EvenementsService, StreamedEvent } from '../services/evenements.service';
import { MembersService } from '../services/members.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { Evenement } from '../model/evenement';
import { UrlEvent } from '../model/url-event';
import { isYoutubeVideoId, parseYoutubeVideoId, youtubeWatchUrl } from '../shared/youtube-video-id.util';
import { openWhatsAppTextShare } from '../shared/share-whatsapp-image.util';
import {
  VideoshowModalComponent,
  VideoshowVideoSource
} from '../shared/videoshow-modal/videoshow-modal.component';

interface YoutubeRegionOption {
  code: string;
  label: string;
}

type YoutubeSortKey = 'relevance' | 'date' | 'views' | 'duration' | 'title' | 'channel';
type YoutubeSortDir = 'asc' | 'desc';
type YoutubeListMode = 'catalog' | 'favorites';

@Component({
  selector: 'app-youtube-watcher',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, VideoshowModalComponent],
  providers: [EvenementsService],
  templateUrl: './youtube-watcher.component.html',
  styleUrls: ['./youtube-watcher.component.css']
})
export class YoutubeWatcherComponent implements OnInit, OnDestroy {
  readonly types: YoutubeItemKind[] = ['video', 'playlist', 'channel'];
  readonly sortKeys: YoutubeSortKey[] = ['relevance', 'date', 'views', 'duration', 'title', 'channel'];
  readonly regions: YoutubeRegionOption[] = [
    { code: 'FR', label: 'France' },
    { code: 'BE', label: 'Belgique' },
    { code: 'CH', label: 'Suisse' },
    { code: 'CA', label: 'Canada' },
    { code: 'US', label: 'United States' },
    { code: 'GB', label: 'United Kingdom' },
    { code: 'DE', label: 'Deutschland' },
    { code: 'ES', label: 'España' },
    { code: 'IT', label: 'Italia' },
    { code: 'PT', label: 'Portugal' },
    { code: 'NL', label: 'Nederland' },
    { code: 'BR', label: 'Brasil' },
    { code: 'JP', label: '日本' },
    { code: 'IN', label: 'भारत' },
    { code: 'KR', label: '한국' },
    { code: 'IL', label: 'ישראל' },
    { code: 'SA', label: 'السعودية' },
    { code: 'GR', label: 'Ελλάδα' },
    { code: 'RU', label: 'Россия' },
    { code: 'CN', label: '中国' }
  ];

  query = '';
  type: YoutubeItemKind = 'video';
  regionCode = 'FR';
  channelId = '';
  channelFilterTitle = '';
  recentSearches: string[] = [];
  recentOpen = false;
  recentActiveIndex = -1;
  items: YoutubeItem[] = [];
  selected: YoutubeItem | null = null;
  embedUrl: SafeResourceUrl | null = null;
  playerOpen = false;
  nextPageToken: string | null = null;
  resultKind: 'search' | 'popular' | string = 'popular';
  total = 0;
  listMode: YoutubeListMode = 'catalog';
  favorites: YoutubeItem[] = [];
  favoriteKeys = new Set<string>();
  favoriteBusyKey = '';
  isLoadingFavorites = false;
  favoritesError = '';
  favoritesHint = '';

  searching = false;
  loadingMore = false;
  searched = false;
  errorMessage = '';
  missingKey = false;

  tickerEnabled = true;
  readonly tickerRepeats = [0, 1, 2, 3, 4, 5];
  tickerDurationSec = 40;
  sortKey: YoutubeSortKey = 'relevance';
  sortDir: YoutubeSortDir = 'asc';

  /**
   * Mobile landscape: immersive player (CSS + best-effort native fullscreen).
   * HostBinding keeps the iframe covering the viewport if Fullscreen API is blocked.
   */
  @HostBinding('class.yt-landscape-fs') landscapeFullscreen = false;
  @ViewChild('playerFrame') playerFrame?: ElementRef<HTMLElement>;
  @ViewChild('linkToEventModal') linkToEventModal?: TemplateRef<unknown>;
  @ViewChild('recordingsModal') recordingsModal?: TemplateRef<unknown>;
  @ViewChild('videoshowModalComponent') videoshowModalComponent?: VideoshowModalComponent;

  private searchSub?: Subscription;
  private favoritesSub?: Subscription;
  private readonly subs: Subscription[] = [];
  private readonly itemSourceOrder = new WeakMap<YoutubeItem, number>();
  private itemSourceSeq = 0;

  private static readonly LANDSCAPE_FS_BODY_CLASS = 'yt-landscape-fs';
  private static readonly PAGE_THEME_BODY_CLASS = 'yt-page-theme';
  private static readonly TICKER_STORAGE_KEY = 'pattool.youtube.ticker-enabled';
  private static readonly RECENT_SEARCHES_KEY = 'pattool.youtube.recent-searches';
  private static readonly RECENT_SEARCHES_MAX = 8;

  private landscapeFsUserDismissed = false;
  private landscapeFsNativeRequested = false;
  private landscapeFsNativeActive = false;
  private landscapeFsSuppressDismiss = false;
  private landscapeOrientationMql: MediaQueryList | null = null;
  private readonly onLandscapeOrientationMedia = (): void => this.syncLandscapeFullscreen();
  private readonly onLandscapeFsChange = (): void => this.onLandscapeNativeFullscreenChange();

  linkEventsList: Evenement[] = [];
  linkEventsFilter = '';
  linkEventsTypeFilter = '';
  linkEventsLoading = false;
  linkEventsError = false;
  linkSavingEventId: string | null = null;
  linkFeedbackKey: string | null = null;
  linkFeedbackParams: { name?: string } = {};
  linkFeedbackKind: 'success' | 'error' | null = null;
  readonly linkEventTypeOptions: ReadonlyArray<{ value: string; labelKey: string }> = [
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
  linkTarget: YoutubeItem | null = null;
  private linkModalRef: NgbModalRef | null = null;
  private recordingsModalRef: NgbModalRef | null = null;
  private linkEventsStreamSub?: Subscription;
  private linkSaveSub?: Subscription;
  private linkFeedbackTimer?: ReturnType<typeof setTimeout>;
  private scrollTopTimer?: ReturnType<typeof setTimeout>;
  private static readonly LINK_FEEDBACK_AUTO_CLOSE_MS = 1800;
  private videoshowRestorePip = false;

  playbackCurrentSec = 0;
  playbackDurationSec = 0;
  playAllActive = false;
  playbackPaused = false;
  recordings: TvRecording[] = [];
  recordingsError = '';
  recordingsLoading = false;
  playingRecording: TvRecording | null = null;
  playingRecordingUrl = '';
  playingRecordingSafeUrl: SafeResourceUrl | null = null;
  clipLoading = false;
  recordingStatus: TvRecordingStatus | null = null;
  recordingStatusLoaded = false;
  clientRecordingActive = false;
  recordingElapsedSec = 0;
  recordingBytes = 0;
  recordingBusy = false;
  recordErrorKey = '';
  recordDurationSec = 0;
  downloadingRecordingId = '';
  readonly recordDurationOptions = [
    { sec: 0, labelKey: 'YOUTUBE.RECORD_UNTIL_STOP' },
    { sec: 60, labelKey: 'TV.RECORD_DUR_1M' },
    { sec: 300, labelKey: 'TV.RECORD_DUR_5M' },
    { sec: 600, labelKey: 'TV.RECORD_DUR_10M' },
    { sec: 900, labelKey: 'TV.RECORD_DUR_15M' },
    { sec: 1800, labelKey: 'TV.RECORD_DUR_30M' }
  ];
  @ViewChild('clipPlayer') clipPlayer?: ElementRef<HTMLVideoElement>;
  private clipVideoEl: HTMLVideoElement | null = null;
  private clipObjectUrl = '';
  private clipAutoplayDone = false;
  private clipTeardown = false;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private displayStream: MediaStream | null = null;
  private recordOutputStream: MediaStream | null = null;
  private recordCropVideo: HTMLVideoElement | null = null;
  private recordCropRaf?: number;
  private clientRecordStartedAt = 0;
  private clientRecordItem: YoutubeItem | null = null;
  private recordAutoStopTimer?: ReturnType<typeof setTimeout>;
  private recordStatsTimer?: ReturnType<typeof setInterval>;
  private recordFinalizing = false;
  private recordDidFinalize = false;
  private destroyed = false;
  private ytApiListening = false;
  private ytProgressTimer?: ReturnType<typeof setInterval>;
  private ignoreQueueEndedUntil = 0;
  private embedGeneration = 0;
  private landscapeSyncTimer?: ReturnType<typeof setTimeout>;
  private landscapeSuppressTimer?: ReturnType<typeof setTimeout>;
  private scrollTopRaf?: number;
  private scrollTopFollowTimer?: ReturnType<typeof setTimeout>;
  private recentBlurTimer?: ReturnType<typeof setTimeout>;
  private readonly onWindowYtMessage = (event: MessageEvent): void => {
    this.onYoutubeProgressMessage(event);
  };

  constructor(
    private api: ApiService,
    private youtubePlayer: YoutubePlayerService,
    private translate: TranslateService,
    private sanitizer: DomSanitizer,
    private route: ActivatedRoute,
    private router: Router,
    private evenementsService: EvenementsService,
    private membersService: MembersService,
    private keycloak: KeycloakService,
    private modalService: NgbModal,
    private ngZone: NgZone,
    private host: ElementRef<HTMLElement>,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    const params = this.route.snapshot.queryParamMap;
    this.regionCode = this.normalizeRegion(
      params.get('region') || this.regionFromUiLang(this.translate.currentLang)
    );
    this.type = this.normalizeType(params.get('type'));
    this.query = (params.get('q') || '').trim();
    this.channelId = (params.get('channel') || '').trim();
    this.tickerEnabled = this.readTickerPreference();
    this.recentSearches = this.readRecentSearches();
    this.sortKey = this.normalizeSort(params.get('sort'));
    this.sortDir = this.normalizeSortDir(params.get('dir'), this.sortKey);

    this.subs.push(
      this.youtubePlayer.state$.subscribe((s) => {
        this.playerOpen = s.open;
        if (s.open) {
          this.stopYoutubeProgressWatch();
        }
        if (s.item) {
          this.selected = this.decodeYoutubeItem(s.item);
        }
        this.syncLandscapeFullscreen();
      })
    );

    this.subs.push(
      this.youtubePlayer.ended$.subscribe(() => {
        this.ngZone.run(() => this.onQueueVideoEnded());
      })
    );

    this.subs.push(
      this.youtubePlayer.paused$.subscribe((paused) => {
        if (this.playerOpen) {
          this.playbackPaused = paused;
        }
      })
    );

    document.body.classList.add(YoutubeWatcherComponent.PAGE_THEME_BODY_CLASS);
    this.setupLandscapeFullscreenWatchers();
    this.syncLandscapeFullscreen();
    this.ngZone.runOutsideAngular(() => {
      window.addEventListener('message', this.onWindowYtMessage);
    });
    this.loadRecordingCapability();
    if (this.isLoggedIn) {
      this.loadRecordings();
      this.loadFavorites();
    }

    if (this.query || this.channelId) {
      this.runSearch(params.get('id'));
    } else {
      this.loadPopular(params.get('id'));
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.searchSub?.unsubscribe();
    this.favoritesSub?.unsubscribe();
    this.subs.forEach((s) => s.unsubscribe());
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.onWindowYtMessage);
    }
    this.teardownLandscapeFullscreenWatchers();
    this.exitLandscapeFullscreen(false);
    document.body.classList.remove(YoutubeWatcherComponent.PAGE_THEME_BODY_CLASS);
    this.closeLinkToEventModal();
    this.closeRecordingsModal();
    this.linkEventsStreamSub?.unsubscribe();
    this.linkSaveSub?.unsubscribe();
    if (this.linkFeedbackTimer !== undefined) {
      clearTimeout(this.linkFeedbackTimer);
      this.linkFeedbackTimer = undefined;
    }
    this.clearLandscapeTimers();
    this.clearScrollTopTimers();
    if (this.recentBlurTimer !== undefined) {
      clearTimeout(this.recentBlurTimer);
      this.recentBlurTimer = undefined;
    }
    this.unloadPageEmbed();
    this.stopPlayAll();
    this.abortClientRecording(false);
    this.stopClipPlayback();
  }

  onQueryChanged(): void {
    this.clearChannelFilter();
    this.recentActiveIndex = -1;
    this.recentOpen = this.filteredRecentSearches().length > 0;
  }

  onQueryFocus(): void {
    if (this.recentBlurTimer !== undefined) {
      clearTimeout(this.recentBlurTimer);
      this.recentBlurTimer = undefined;
    }
    this.recentOpen = this.filteredRecentSearches().length > 0;
  }

  onQueryBlur(): void {
    if (this.recentBlurTimer !== undefined) {
      clearTimeout(this.recentBlurTimer);
    }
    this.recentBlurTimer = setTimeout(() => {
      this.recentBlurTimer = undefined;
      if (!this.destroyed) {
        this.recentOpen = false;
        this.recentActiveIndex = -1;
      }
    }, 120);
  }

  filteredRecentSearches(): string[] {
    const q = this.query.trim().toLowerCase();
    if (!q) {
      return this.recentSearches;
    }
    return this.recentSearches.filter(
      (term) => term.toLowerCase().includes(q) && term.toLowerCase() !== q
    );
  }

  applyRecentSearch(term: string): void {
    const value = (term || '').trim();
    if (!value) {
      return;
    }
    this.query = value;
    this.recentOpen = false;
    this.recentActiveIndex = -1;
    this.clearChannelFilter();
    this.runSearch();
  }

  removeRecentSearch(term: string, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.recentSearches = this.recentSearches.filter((item) => item !== term);
    this.writeRecentSearches(this.recentSearches);
    this.recentOpen = this.filteredRecentSearches().length > 0;
    if (this.recentActiveIndex >= this.filteredRecentSearches().length) {
      this.recentActiveIndex = this.filteredRecentSearches().length - 1;
    }
  }

  onQueryKeydown(event: KeyboardEvent): void {
    const list = this.filteredRecentSearches();
    if (event.key === 'Escape') {
      this.recentOpen = false;
      this.recentActiveIndex = -1;
      return;
    }
    if (event.key === 'ArrowDown') {
      if (!list.length) {
        return;
      }
      event.preventDefault();
      this.recentOpen = true;
      this.recentActiveIndex = Math.min(this.recentActiveIndex + 1, list.length - 1);
      if (this.recentActiveIndex < 0) {
        this.recentActiveIndex = 0;
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      if (!this.recentOpen || !list.length) {
        return;
      }
      event.preventDefault();
      this.recentActiveIndex = this.recentActiveIndex <= 0 ? -1 : this.recentActiveIndex - 1;
      return;
    }
    if (event.key === 'Enter' && this.recentOpen && this.recentActiveIndex >= 0 && list[this.recentActiveIndex]) {
      event.preventDefault();
      this.applyRecentSearch(list[this.recentActiveIndex]);
    }
  }

  onTypeChanged(value: YoutubeItemKind | string): void {
    this.type = this.normalizeType(typeof value === 'string' ? value : String(value));
    if (this.type === 'channel') {
      this.clearChannelFilter();
    }
  }

  get canSubmitSearch(): boolean {
    if (this.query.trim()) {
      return true;
    }
    return !!this.channelId && (this.type === 'video' || this.type === 'playlist');
  }

  get needsTypeQuery(): boolean {
    return this.type !== 'video' && !this.query.trim() && !(this.channelId && this.type === 'playlist');
  }

  channelFilterLabelKey(): string {
    return this.type === 'playlist' ? 'YOUTUBE.CHANNEL_FILTER_PLAYLISTS' : 'YOUTUBE.CHANNEL_FILTER';
  }

  contextVisible(): boolean {
    return !!this.selected || this.searched || !!this.channelId;
  }

  contextLabelKey(): string {
    if (this.selected) {
      return this.playingContextKey();
    }
    return this.listContextKey();
  }

  playingContextKey(): string {
    if (this.playingRecording) {
      return 'YOUTUBE.CONTEXT_CLIP';
    }
    const kind = this.selected?.kind || 'video';
    if (kind === 'playlist') {
      return this.channelId ? 'YOUTUBE.CONTEXT_CHANNEL_PLAYLIST' : 'YOUTUBE.CONTEXT_PLAYLIST_VIDEO';
    }
    if (kind === 'channel') {
      return 'YOUTUBE.CONTEXT_CHANNEL';
    }
    if (this.channelId) {
      return 'YOUTUBE.CONTEXT_CHANNEL_VIDEO';
    }
    return 'YOUTUBE.CONTEXT_VIDEO';
  }

  listContextKey(): string {
    if (this.listMode === 'favorites') {
      return 'YOUTUBE.TAB_FAVORITES';
    }
    if (this.resultKind === 'popular' && !this.query.trim() && !this.channelId) {
      return 'YOUTUBE.POPULAR';
    }
    if (this.channelId) {
      return this.channelFilterLabelKey();
    }
    if (this.type === 'playlist') {
      return 'YOUTUBE.TYPE_PLAYLIST';
    }
    if (this.type === 'channel') {
      return 'YOUTUBE.TYPE_CHANNEL';
    }
    return 'YOUTUBE.TYPE_VIDEO';
  }

  contextKind(): YoutubeItemKind {
    const kind = this.selected?.kind || this.type;
    if (kind === 'playlist' || kind === 'channel') {
      return kind;
    }
    return 'video';
  }

  contextIconClass(): string {
    if (this.playingRecording) {
      return 'fa fa-film';
    }
    switch (this.contextKind()) {
      case 'playlist':
        return 'fa fa-list';
      case 'channel':
        return 'fa fa-user-circle';
      default:
        return 'fa fa-play-circle';
    }
  }

  contextName(): string {
    if (this.playingRecording) {
      return (this.playingRecording.channelName || '').trim();
    }
    if (this.selected?.kind === 'playlist') {
      return (this.selected.title || '').trim();
    }
    if (this.channelId) {
      return (this.channelFilterTitle || this.selected?.channelTitle || '').trim();
    }
    if (this.selected?.kind === 'channel') {
      return (this.selected.title || '').trim();
    }
    return '';
  }

  private clearChannelFilter(): void {
    this.channelId = '';
    this.channelFilterTitle = '';
  }

  get isLoggedIn(): boolean {
    return this.keycloak.isLoggedIn();
  }

  get displayedItems(): YoutubeItem[] {
    return this.listMode === 'favorites' ? this.favorites : this.items;
  }

  get showResultsHead(): boolean {
    return this.listMode === 'favorites' || this.searched || this.searching;
  }

  favoriteKey(item: YoutubeItem | null | undefined): string {
    if (!item?.id) {
      return '';
    }
    return `${item.kind || 'video'}|${item.id}`;
  }

  isFavorite(item: YoutubeItem | null | undefined): boolean {
    const key = this.favoriteKey(item);
    return !!key && this.favoriteKeys.has(key);
  }

  setListMode(mode: YoutubeListMode): void {
    if (this.listMode === mode) {
      return;
    }
    this.listMode = mode;
    this.favoritesHint = '';
    this.stopPlayAll();
    if (mode === 'favorites') {
      if (!this.isLoggedIn) {
        this.favoritesHint = 'YOUTUBE.FAVORITES_LOGIN';
        return;
      }
      if (!this.favorites.length && !this.isLoadingFavorites) {
        this.loadFavorites();
      } else {
        this.sortItems();
      }
      return;
    }
    if (!this.items.length && !this.searching) {
      this.loadPopular();
    }
  }

  toggleFavorite(item: YoutubeItem | null | undefined, event?: Event): void {
    event?.stopPropagation();
    if (!item?.id) {
      return;
    }
    if (!this.isLoggedIn) {
      this.favoritesHint = 'YOUTUBE.FAVORITES_LOGIN';
      this.listMode = 'favorites';
      return;
    }
    const key = this.favoriteKey(item);
    if (!key || this.favoriteBusyKey) {
      return;
    }
    this.favoritesHint = '';
    this.favoritesError = '';
    this.favoriteBusyKey = key;
    const removing = this.isFavorite(item);
    const req$ = removing
      ? this.api.removeYoutubeFavorite(item.id, item.kind || 'video')
      : this.api.addYoutubeFavorite(item);
    req$.subscribe({
      next: (fav) => {
        if (this.destroyed) {
          return;
        }
        this.applyFavorites(fav?.items || []);
        this.favoriteBusyKey = this.favoriteBusyKey === key ? '' : this.favoriteBusyKey;
      },
      error: () => {
        if (this.destroyed) {
          return;
        }
        this.favoritesError = 'YOUTUBE.ERR_FAVORITES_SAVE';
        this.favoriteBusyKey = this.favoriteBusyKey === key ? '' : this.favoriteBusyKey;
      }
    });
  }

  get supportsBrowserRecording(): boolean {
    return (
      typeof MediaRecorder !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getDisplayMedia
    );
  }

  get recordingAvailable(): boolean {
    if (!this.supportsBrowserRecording) {
      return false;
    }
    if (this.recordingStatusLoaded && this.recordingStatus?.enabled === false) {
      return false;
    }
    return true;
  }

  get recordButtonTitleKey(): string {
    if (!this.isLoggedIn) {
      return 'TV.RECORD_LOGIN';
    }
    if (!this.recordingAvailable) {
      return 'TV.ERR_RECORD_UNAVAILABLE';
    }
    return 'YOUTUBE.RECORD';
  }

  get recordingMaxUploadBytes(): number {
    const fromStatus = this.recordingStatus?.maxUploadBytes;
    if (typeof fromStatus === 'number' && fromStatus > 0) {
      return fromStatus;
    }
    return 800 * 1024 * 1024;
  }

  get recordingNearSizeLimit(): boolean {
    const max = this.recordingMaxUploadBytes;
    return max > 0 && this.recordingBytes >= max * 0.9;
  }

  get youtubeRecordings(): TvRecording[] {
    return this.recordings.filter((rec) => this.isYoutubeRecording(rec) && rec.ownedByMe === true);
  }

  get recordingStopping(): boolean {
    return this.recordFinalizing;
  }

  get showYoutubeStage(): boolean {
    if (this.playingRecording || this.clipLoading) {
      return true;
    }
    return !!this.selected && !!this.embedUrl && this.selected.kind !== 'channel';
  }

  canRecordNow(): boolean {
    return !!this.selected && !!this.embedUrl && !this.playerOpen && this.selected.kind !== 'channel';
  }

  async startRecording(event?: Event): Promise<void> {
    event?.preventDefault();
    event?.stopPropagation();
    this.recordErrorKey = '';
    if (!this.isLoggedIn) {
      this.recordErrorKey = 'TV.RECORD_LOGIN';
      return;
    }
    if (!this.recordingAvailable || this.recordingBusy || this.clientRecordingActive || !this.canRecordNow()) {
      if (!this.recordingAvailable) {
        this.recordErrorKey = 'TV.ERR_RECORD_UNAVAILABLE';
      }
      return;
    }
    const item = this.selected;
    if (!item?.id) {
      return;
    }
    let stream: MediaStream;
    try {
      const captureOpts: DisplayMediaStreamOptions & {
        preferCurrentTab?: boolean;
        selfBrowserSurface?: string;
        surfaceSwitching?: string;
        monitorTypeSurfaces?: string;
        systemAudio?: string;
      } = {
        video: { frameRate: 25, displaySurface: 'browser' } as MediaTrackConstraints,
        audio: true,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
        monitorTypeSurfaces: 'exclude',
        systemAudio: 'include'
      };
      const rawStream = await navigator.mediaDevices.getDisplayMedia(captureOpts);
      this.displayStream = rawStream;
      stream = await this.cropDisplayStreamToVideoArea(rawStream);
      this.recordOutputStream = stream === rawStream ? null : stream;
    } catch {
      this.releaseRecordingCapture();
      this.recordErrorKey = 'YOUTUBE.ERR_RECORD_SHARE';
      return;
    }
    if (this.destroyed || !this.canRecordNow()) {
      this.releaseRecordingCapture();
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      });
      return;
    }
    const mimeType = this.pickRecorderMimeType();
    try {
      this.recordedChunks = [];
      this.mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 })
        : new MediaRecorder(stream, { videoBitsPerSecond: 2_500_000 });
    } catch {
      this.releaseRecordingCapture();
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      });
      this.recordErrorKey = 'TV.ERR_RECORD_UNAVAILABLE';
      return;
    }
    this.displayStream?.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.clientRecordingActive && !this.recordFinalizing) {
        this.stopActiveRecording();
      }
    });
    this.mediaRecorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) {
        this.recordedChunks.push(ev.data);
        this.recordingBytes += ev.data.size;
        if (this.recordingBytes >= this.recordingMaxUploadBytes) {
          this.stopActiveRecording();
        }
      }
    };
    this.mediaRecorder.onerror = () => {
      if (this.clientRecordingActive && !this.recordFinalizing) {
        this.stopActiveRecording();
      }
    };
    this.mediaRecorder.onstop = () => this.finalizeClientRecording();
    this.clientRecordItem = { ...item };
    this.clientRecordStartedAt = Date.now();
    this.clientRecordingActive = true;
    this.recordFinalizing = false;
    this.recordDidFinalize = false;
    this.recordingElapsedSec = 0;
    this.recordingBytes = 0;
    this.mediaRecorder.start(1000);
    this.startRecordStatsTick();
    if (this.recordAutoStopTimer !== undefined) {
      clearTimeout(this.recordAutoStopTimer);
    }
    if (this.recordDurationSec > 0) {
      this.recordAutoStopTimer = setTimeout(() => {
        this.recordAutoStopTimer = undefined;
        if (this.clientRecordingActive) {
          this.stopActiveRecording();
        }
      }, Math.max(5, this.recordDurationSec) * 1000);
    }
  }

  stopActiveRecording(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!this.clientRecordingActive || this.recordFinalizing) {
      return;
    }
    this.recordFinalizing = true;
    this.recordingBusy = true;
    this.stopRecordStatsTick();
    if (this.recordAutoStopTimer !== undefined) {
      clearTimeout(this.recordAutoStopTimer);
      this.recordAutoStopTimer = undefined;
    }
    const recorder = this.mediaRecorder;
    if (!recorder) {
      this.finalizeClientRecording();
      return;
    }
    try {
      if (recorder.state !== 'inactive') {
        recorder.stop();
      } else {
        this.finalizeClientRecording();
      }
    } catch {
      this.finalizeClientRecording();
    }
  }

  playRecording(rec: TvRecording, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (rec.status !== 'DONE') {
      return;
    }
    if (this.playingRecording?.id === rec.id && this.playingRecordingSafeUrl) {
      this.stopClipPlayback();
      return;
    }
    this.startClipPlayback(rec);
  }

  private dismissRecordingsModal(): void {
    try {
      this.recordingsModalRef?.dismiss();
    } catch {
      /* already closed */
    }
    this.recordingsModalRef = null;
  }

  onClipVideoReady(video: HTMLVideoElement): void {
    this.clipVideoEl = video;
    this.clipLoading = false;
    if (this.clipAutoplayDone) {
      return;
    }
    this.clipAutoplayDone = true;
    const attempt = (muted: boolean) => {
      video.muted = muted;
      const play = video.play();
      if (play && typeof play.then === 'function') {
        play.catch((err: unknown) => {
          const name =
            err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
          if (name === 'NotAllowedError' && !muted) {
            attempt(true);
          }
        });
      }
    };
    attempt(false);
  }

  onClipVideoError(): void {
    if (this.clipTeardown || !this.playingRecording) {
      return;
    }
    this.clipLoading = false;
    this.recordingsError = 'TV.ERR_RECORD_PLAY';
  }

  stopClipPlayback(): void {
    this.clipTeardown = true;
    const video = this.clipVideoEl || this.clipPlayer?.nativeElement;
    if (video) {
      try {
        video.pause();
        video.removeAttribute('src');
      } catch {
        /* ignore */
      }
    }
    this.revokeClipObjectUrl();
    this.playingRecording = null;
    this.playingRecordingUrl = '';
    this.playingRecordingSafeUrl = null;
    this.clipVideoEl = null;
    this.clipLoading = false;
    this.clipAutoplayDone = false;
    this.clipTeardown = false;
  }

  private startClipPlayback(rec: TvRecording): void {
    this.stopClipPlayback();
    this.playingRecording = rec;
    this.clipLoading = true;
    this.clipAutoplayDone = false;
    this.recordingsError = '';
    if (this.playerOpen) {
      this.youtubePlayer.close();
    }
    this.dismissRecordingsModal();
    this.sendYoutubeCommand('pauseVideo');
    this.playbackPaused = true;
    this.scrollPageToTop();
    this.cdr.detectChanges();
    this.api.downloadTvRecordingBlob(rec).subscribe({
      next: (blob) => {
        if (this.destroyed || this.playingRecording?.id !== rec.id) {
          return;
        }
        this.revokeClipObjectUrl();
        const typed = blob.type ? blob : new Blob([blob], { type: 'video/webm' });
        this.clipObjectUrl = URL.createObjectURL(typed);
        this.playingRecordingUrl = this.clipObjectUrl;
        this.playingRecordingSafeUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.clipObjectUrl);
        this.clipLoading = false;
        this.cdr.detectChanges();
      },
      error: () => {
        if (this.playingRecording?.id !== rec.id) {
          return;
        }
        this.clipLoading = false;
        this.recordingsError = 'TV.ERR_RECORD_PLAY';
        this.cdr.detectChanges();
      }
    });
  }

  private revokeClipObjectUrl(): void {
    if (this.clipObjectUrl) {
      URL.revokeObjectURL(this.clipObjectUrl);
      this.clipObjectUrl = '';
    }
  }

  downloadRecording(rec: TvRecording, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!rec?.id || rec.status !== 'DONE' || this.downloadingRecordingId) {
      return;
    }
    this.downloadingRecordingId = rec.id;
    this.recordingsError = '';
    this.api.downloadTvRecordingBlob(rec).subscribe({
      next: (blob) => {
        this.downloadingRecordingId = '';
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = rec.fileName || `${(rec.channelName || 'youtube').replace(/[^\w.-]+/g, '_')}.webm`;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 1500);
      },
      error: () => {
        this.downloadingRecordingId = '';
        this.recordingsError = 'TV.ERR_RECORD_DOWNLOAD';
      }
    });
  }

  deleteRecording(rec: TvRecording, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!rec?.id || this.recordingBusy || rec.ownedByMe === false) {
      return;
    }
    this.recordingBusy = true;
    this.api.deleteTvRecording(rec.id).subscribe({
      next: () => {
        this.recordingBusy = false;
        this.recordings = this.recordings.filter((r) => r.id !== rec.id);
        if (this.playingRecording?.id === rec.id) {
          this.stopClipPlayback();
        }
      },
      error: () => {
        this.recordingBusy = false;
        this.recordingsError = 'TV.ERR_RECORD_DELETE';
      }
    });
  }

  formatRecordingClock(totalSec: number | undefined | null): string {
    const sec = Math.max(0, Math.floor(Number(totalSec) || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  formatRecordingSize(bytes: number | undefined | null): string {
    if (bytes == null || bytes <= 0) {
      return '';
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(0)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  formatRecordingWhen(iso: string | undefined | null): string {
    if (!iso) {
      return '';
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return '';
    }
    return d.toLocaleString(this.translate.currentLang || 'fr', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  recordingStatusLabelKey(status: string | undefined): string {
    switch (status) {
      case 'PENDING':
        return 'TV.RECORD_STATUS_PENDING';
      case 'RUNNING':
        return 'TV.RECORD_STATUS_RUNNING';
      case 'DONE':
        return 'TV.RECORD_STATUS_DONE';
      case 'FAILED':
        return 'TV.RECORD_STATUS_FAILED';
      case 'CANCELLED':
        return 'TV.RECORD_STATUS_CANCELLED';
      default:
        return 'TV.RECORD_STATUS_UNKNOWN';
    }
  }

  trackByRecordingId(_index: number, rec: TvRecording): string {
    return rec?.id || String(_index);
  }

  openRecordingsModal(): void {
    if (!this.isLoggedIn || !this.recordingsModal) {
      return;
    }
    this.loadRecordings();
    if (this.recordingsModalRef) {
      return;
    }
    this.recordingsModalRef = this.modalService.open(this.recordingsModal, {
      size: 'lg',
      centered: true,
      scrollable: true,
      windowClass: 'yt-recordings-modal',
      backdropClass: 'yt-recordings-modal-backdrop',
      modalDialogClass: 'yt-recordings-modal-dialog'
    });
    this.recordingsModalRef.dismissed.subscribe(() => this.onRecordingsModalClosed());
    this.recordingsModalRef.closed.subscribe(() => this.onRecordingsModalClosed());
  }

  closeRecordingsModal(): void {
    this.dismissRecordingsModal();
  }

  private onRecordingsModalClosed(): void {
    this.recordingsModalRef = null;
  }

  private loadRecordingCapability(): void {
    this.api.getTvRecordingStatus().subscribe({
      next: (s) => {
        this.recordingStatus = s || null;
        this.recordingStatusLoaded = true;
      },
      error: () => {
        this.recordingStatus = null;
        this.recordingStatusLoaded = false;
      }
    });
  }

  private loadRecordings(): void {
    if (!this.isLoggedIn) {
      this.recordings = [];
      return;
    }
    this.recordingsLoading = true;
    this.recordingsError = '';
    this.api.getTvRecordings().subscribe({
      next: (list) => {
        this.recordings = list || [];
        this.recordingsLoading = false;
      },
      error: () => {
        this.recordingsLoading = false;
        this.recordingsError = 'TV.ERR_RECORDINGS_LOAD';
      }
    });
  }

  private pickRecorderMimeType(): string {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4'
    ];
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return '';
  }

  private finalizeClientRecording(): void {
    if (this.recordDidFinalize) {
      return;
    }
    this.recordDidFinalize = true;
    const item = this.clientRecordItem;
    const startedAt = this.clientRecordStartedAt;
    const recorder = this.mediaRecorder;
    const mimeType = recorder?.mimeType || this.pickRecorderMimeType() || 'video/webm';
    const durationSec = Math.max(1, Math.round((Date.now() - (startedAt || Date.now())) / 1000));
    const blob = new Blob(this.recordedChunks, { type: mimeType.split(';')[0] || 'video/webm' });
    this.recordedChunks = [];
    this.mediaRecorder = null;
    this.clientRecordingActive = false;
    this.clientRecordItem = null;
    this.recordingElapsedSec = durationSec;
    this.recordingBytes = blob.size;
    this.releaseRecordingCapture();
    if (!blob.size || blob.size < 1024) {
      this.recordingBusy = false;
      this.recordFinalizing = false;
      this.recordErrorKey = 'TV.ERR_RECORD_START';
      return;
    }
    if (!item?.id) {
      this.recordingBusy = false;
      this.recordFinalizing = false;
      return;
    }
    const ext = mimeType.includes('mp4') ? '.mp4' : '.webm';
    const watchUrl = this.youtubeUrl(item) || `https://www.youtube.com/watch?v=${item.id}`;
    this.api
      .uploadTvRecording(
        blob,
        {
          channelId: item.id,
          channelName: item.title || item.channelTitle || 'YouTube',
          channelLogo: this.thumbUrl(item) || undefined,
          country: 'YT',
          streamUrl: watchUrl,
          durationSec,
          visibility: 'private'
        },
        `yt-${(item.title || 'rec').replace(/[^\w.-]+/g, '_').slice(0, 40)}${ext}`
      )
      .subscribe({
        next: (rec) => {
          this.recordingBusy = false;
          this.recordFinalizing = false;
          if (rec) {
            this.recordings = [rec, ...this.recordings.filter((r) => r.id !== rec.id)];
          }
        },
        error: (err) => {
          this.recordingBusy = false;
          this.recordFinalizing = false;
          const code = err?.error?.error || '';
          if (code === 'file_too_large' || err?.status === 413) {
            this.recordErrorKey = 'TV.ERR_RECORD_TOO_LARGE';
          } else if (code === 'tv_recording_disabled') {
            this.recordErrorKey = 'TV.ERR_RECORD_UNAVAILABLE';
          } else {
            this.recordErrorKey = 'TV.ERR_RECORD_START';
          }
        }
      });
  }

  private abortClientRecording(upload: boolean): void {
    this.stopRecordStatsTick();
    if (this.recordAutoStopTimer !== undefined) {
      clearTimeout(this.recordAutoStopTimer);
      this.recordAutoStopTimer = undefined;
    }
    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        if (upload) {
          this.stopActiveRecording();
          return;
        }
        this.mediaRecorder.onstop = null;
        this.mediaRecorder.onerror = null;
        this.mediaRecorder.stop();
      }
    } catch {
      /* ignore */
    }
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.clientRecordingActive = false;
    this.clientRecordItem = null;
    this.recordingElapsedSec = 0;
    this.recordingBytes = 0;
    this.recordFinalizing = false;
    this.recordingBusy = false;
    this.releaseRecordingCapture();
  }

  private releaseRecordingCapture(): void {
    this.stopRecordCropLoop();
    this.displayStream?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    });
    this.displayStream = null;
    if (this.recordOutputStream) {
      this.recordOutputStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      });
      this.recordOutputStream = null;
    }
  }

  private stopRecordCropLoop(): void {
    if (this.recordCropRaf !== undefined) {
      cancelAnimationFrame(this.recordCropRaf);
      this.recordCropRaf = undefined;
    }
    if (this.recordCropVideo) {
      try {
        this.recordCropVideo.pause();
        this.recordCropVideo.srcObject = null;
      } catch {
        /* ignore */
      }
      this.recordCropVideo = null;
    }
  }

  private async cropDisplayStreamToVideoArea(stream: MediaStream): Promise<MediaStream> {
    const el = this.getYoutubeIframe() || this.playerFrame?.nativeElement || null;
    const videoTrack = stream.getVideoTracks()[0] as
      | (MediaStreamTrack & {
          cropTo?: (target: unknown) => Promise<void>;
          restrictTo?: (target: unknown) => Promise<void>;
        })
      | undefined;
    if (!el || !videoTrack) {
      return stream;
    }
    const win = window as Window & {
      CropTarget?: { fromElement: (node: Element) => Promise<unknown> };
      RestrictionTarget?: { fromElement: (node: Element) => Promise<unknown> };
    };
    if (typeof win.RestrictionTarget?.fromElement === 'function' && typeof videoTrack.restrictTo === 'function') {
      try {
        const target = await win.RestrictionTarget.fromElement(el);
        await videoTrack.restrictTo(target);
        return stream;
      } catch {
        /* Region Capture / canvas fallback */
      }
    }
    if (typeof win.CropTarget?.fromElement === 'function' && typeof videoTrack.cropTo === 'function') {
      try {
        const target = await win.CropTarget.fromElement(el);
        await videoTrack.cropTo(target);
        return stream;
      } catch {
        /* canvas fallback */
      }
    }
    return this.cropDisplayStreamViaCanvas(stream, el);
  }

  private cropDisplayStreamViaCanvas(stream: MediaStream, el: HTMLElement): MediaStream {
    const source = document.createElement('video');
    source.setAttribute('playsinline', '');
    source.muted = true;
    source.playsInline = true;
    source.srcObject = stream;
    void source.play().catch(() => undefined);
    this.recordCropVideo = source;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return stream;
    }
    const draw = () => {
      this.recordCropRaf = requestAnimationFrame(draw);
      if (source.readyState < 2) {
        return;
      }
      const rect = el.getBoundingClientRect();
      const vw = source.videoWidth;
      const vh = source.videoHeight;
      if (!vw || !vh || rect.width < 2 || rect.height < 2) {
        return;
      }
      const scaleX = vw / Math.max(1, window.innerWidth);
      const scaleY = vh / Math.max(1, window.innerHeight);
      const sx = Math.max(0, rect.left * scaleX);
      const sy = Math.max(0, rect.top * scaleY);
      const sw = Math.min(vw - sx, rect.width * scaleX);
      const sh = Math.min(vh - sy, rect.height * scaleY);
      if (sw < 2 || sh < 2) {
        return;
      }
      const dw = Math.round(sw);
      const dh = Math.round(sh);
      if (canvas.width !== dw || canvas.height !== dh) {
        canvas.width = dw;
        canvas.height = dh;
      }
      ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
    };
    this.ngZone.runOutsideAngular(() => draw());
    const cropped = canvas.captureStream(25);
    stream.getAudioTracks().forEach((track) => cropped.addTrack(track));
    return cropped;
  }

  private startRecordStatsTick(): void {
    this.stopRecordStatsTick();
    this.tickRecordStats();
    this.ngZone.runOutsideAngular(() => {
      this.recordStatsTimer = setInterval(() => {
        this.ngZone.run(() => this.tickRecordStats());
      }, 1000);
    });
  }

  private stopRecordStatsTick(): void {
    if (this.recordStatsTimer !== undefined) {
      clearInterval(this.recordStatsTimer);
      this.recordStatsTimer = undefined;
    }
  }

  private tickRecordStats(): void {
    if (!this.clientRecordingActive || !this.clientRecordStartedAt) {
      return;
    }
    if (this.mediaRecorder && this.mediaRecorder.state === 'inactive' && !this.recordFinalizing) {
      this.stopActiveRecording();
      return;
    }
    this.recordingElapsedSec = Math.max(0, Math.floor((Date.now() - this.clientRecordStartedAt) / 1000));
  }

  private isYoutubeRecording(rec: TvRecording): boolean {
    const url = (rec.streamUrl || '').toLowerCase();
    const country = (rec.country || '').toUpperCase();
    return country === 'YT' || url.includes('youtube.com') || url.includes('youtu.be');
  }

  submitSearch(): void {
    if (!this.canSubmitSearch) {
      return;
    }
    this.listMode = 'catalog';
    this.runSearch();
  }

  clearSearch(): void {
    this.searchSub?.unsubscribe();
    this.query = '';
    this.clearChannelFilter();
    this.type = 'video';
    this.items = [];
    this.nextPageToken = null;
    this.searched = false;
    this.errorMessage = '';
    this.searching = false;
    this.loadingMore = false;
    this.resultKind = 'popular';
    this.listMode = 'catalog';
    this.stopPlayAll();
    this.syncUrl();
    this.loadPopular();
  }

  selectItem(item: YoutubeItem): void {
    if (!item?.id) {
      return;
    }
    if (this.clientRecordingActive) {
      this.stopActiveRecording();
    }
    this.stopClipPlayback();
    if (item.kind === 'channel' && item.id) {
      this.stopPlayAll();
      this.channelId = item.id;
      this.channelFilterTitle = (item.title || item.channelTitle || '').trim();
      this.query = '';
      this.type = 'video';
      this.runSearch();
      return;
    }
    this.selected = this.decodeYoutubeItem(item);
    this.resetPlaybackClock(this.selected);
    this.playbackPaused = false;
    if (this.playerOpen) {
      this.embedUrl = null;
      this.stopYoutubeProgressWatch();
      this.youtubePlayer.open(this.selected, { keepMinimized: this.playAllActive });
    } else {
      this.embedUrl = this.buildEmbedUrl(this.selected, true);
    }
    this.scrollPageToTop();
    void this.syncUrl().then(() => {
      if (!this.destroyed) {
        this.scrollPageToTop();
      }
    });
    this.scheduleLandscapeSync();
  }

  openInFloatingWindow(): void {
    if (!this.selected) {
      return;
    }
    if (this.clientRecordingActive) {
      this.stopActiveRecording();
    }
    this.exitLandscapeFullscreen(false);
    this.embedUrl = null;
    this.stopYoutubeProgressWatch();
    this.youtubePlayer.open(this.selected);
  }

  restorePlayer(): void {
    this.youtubePlayer.restore();
  }

  onTickerToggle(): void {
    this.writeTickerPreference(this.tickerEnabled);
  }

  onSortKeyChanged(): void {
    this.sortDir = this.defaultSortDir(this.sortKey);
    if (this.listMode !== 'favorites' && (this.query.trim() || this.channelId)) {
      this.runSearch();
      return;
    }
    this.sortItems();
    this.syncUrl();
  }

  toggleSortDir(): void {
    this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    this.sortItems();
    this.syncUrl();
  }

  get tickerItem(): YoutubeItem | null {
    return this.selected;
  }

    tickerModeLabelKey(): string {
    return this.playerOpen ? 'YOUTUBE.TICKER_MODE_PIP' : 'YOUTUBE.TICKER_MODE_PAGE';
  }

  get canPlayAll(): boolean {
    return this.queueItems().length > 0;
  }

  playAllIndex(): number {
    return this.queueIndexOf(this.selected);
  }

  playAllCount(): number {
    return this.queueItems().length;
  }

  get queuePaused(): boolean {
    if (!this.selected || (!this.embedUrl && !this.playerOpen)) {
      return true;
    }
    return this.playbackPaused;
  }

  playQueuePrev(): void {
    const list = this.queueItems();
    if (!list.length) {
      return;
    }
    const idx = this.queueIndexOf(this.selected);
    const prev = list[(idx <= 0 ? list.length : idx) - 1];
    this.playQueueItem(prev);
  }

  playQueueNext(): void {
    const list = this.queueItems();
    if (!list.length) {
      return;
    }
    const idx = this.queueIndexOf(this.selected);
    const next = list[(idx < 0 ? 0 : idx + 1) % list.length];
    this.playQueueItem(next);
  }

  togglePlaybackPause(): void {
    if (!this.selected || (!this.embedUrl && !this.playerOpen)) {
      this.startPlayAll();
      return;
    }
    const pause = !this.queuePaused;
    this.playbackPaused = pause;
    if (this.playerOpen) {
      this.youtubePlayer.sendCommand(pause ? 'pause' : 'play');
      return;
    }
    this.handshakeYoutubePlayer();
    this.sendYoutubeCommand(pause ? 'pauseVideo' : 'playVideo');
  }

  togglePlayAll(): void {
    if (this.playAllActive) {
      this.stopPlayAll();
      return;
    }
    this.startPlayAll();
  }

  private startPlayAll(): void {
    const list = this.queueItems();
    if (!list.length) {
      return;
    }
    this.playAllActive = true;
    this.playbackPaused = false;
    const currentIdx = this.queueIndexOf(this.selected);
    if (currentIdx >= 0 && (this.embedUrl || this.playerOpen)) {
      if (
        this.playbackDurationSec > 0 &&
        this.playbackCurrentSec >= this.playbackDurationSec - 0.5
      ) {
        this.onQueueVideoEnded();
      }
      return;
    }
    this.playQueueItem(list[currentIdx >= 0 ? currentIdx : 0]);
  }

  private stopPlayAll(): void {
    this.playAllActive = false;
  }

  private queueItems(): YoutubeItem[] {
    const seen = new Set<string>();
    const out: YoutubeItem[] = [];
    for (const item of this.displayedItems) {
      if (!this.isQueueItem(item)) {
        continue;
      }
      const key = `${item.kind || 'video'}:${item.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  private isQueueItem(item: YoutubeItem | null | undefined): boolean {
    if (!item?.id || item.kind === 'channel' || this.isLive(item)) {
      return false;
    }
    return item.kind === 'video' || item.kind === 'playlist' || !item.kind;
  }

  private queueIndexOf(item: YoutubeItem | null | undefined): number {
    if (!item?.id) {
      return -1;
    }
    const kind = item.kind || 'video';
    return this.queueItems().findIndex((it) => it.id === item.id && (it.kind || 'video') === kind);
  }

  private playQueueItem(item: YoutubeItem): void {
    this.ignoreQueueEndedUntil = Date.now() + 1500;
    this.selectItem(item);
  }

  private onQueueVideoEnded(): void {
    if (!this.playAllActive) {
      return;
    }
    if (Date.now() < this.ignoreQueueEndedUntil) {
      return;
    }
    const list = this.queueItems();
    if (!list.length) {
      this.stopPlayAll();
      return;
    }
    const idx = this.queueIndexOf(this.selected);
    const next = list[(idx < 0 ? 0 : idx + 1) % list.length];
    this.playQueueItem(next);
  }

  closePlayer(): void {
    const item = this.selected || this.youtubePlayer.currentItem;
    this.youtubePlayer.close();
    this.playerOpen = false;
    if (item) {
      this.selected = item;
      this.embedUrl = this.buildEmbedUrl(item, true);
    }
    this.scheduleLandscapeSync();
  }

  exitLandscapeFullscreen(markDismissed = true): void {
    if (markDismissed && this.landscapeFullscreen) {
      this.landscapeFsUserDismissed = true;
    }
    if (
      !this.landscapeFullscreen &&
      !document.body.classList.contains(YoutubeWatcherComponent.LANDSCAPE_FS_BODY_CLASS)
    ) {
      this.landscapeFsSuppressDismiss = true;
      this.exitOwnedNativeFullscreen();
      this.landscapeFsSuppressDismiss = false;
      return;
    }
    this.landscapeFullscreen = false;
    document.body.classList.remove(YoutubeWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
    this.landscapeFsSuppressDismiss = true;
    this.exitOwnedNativeFullscreen();
    if (this.landscapeSuppressTimer !== undefined) {
      clearTimeout(this.landscapeSuppressTimer);
    }
    this.landscapeSuppressTimer = setTimeout(() => {
      this.landscapeSuppressTimer = undefined;
      if (!this.destroyed) {
        this.landscapeFsSuppressDismiss = false;
      }
    }, 0);
  }

  @HostListener('window:orientationchange')
  @HostListener('window:resize')
  onViewportOrientationMaybeChanged(): void {
    this.syncLandscapeFullscreen();
  }

  loadMore(): void {
    if (!this.nextPageToken || this.loadingMore || this.searching) {
      return;
    }
    this.loadingMore = true;
    const token = this.nextPageToken;
    const req$ =
      this.resultKind === 'popular' && !this.query.trim() && !this.channelId
        ? this.api.getYoutubePopular({
            regionCode: this.regionCode,
            pageToken: token,
            maxResults: 12
          })
        : this.api.searchYoutube({
            q: this.query.trim() || undefined,
            type: this.type,
            regionCode: this.regionCode,
            relevanceLanguage: this.relevanceLang(),
            channelId: this.channelId || undefined,
            pageToken: token,
            maxResults: 12,
            order: this.youtubeApiOrder()
          });
    this.searchSub?.unsubscribe();
    this.searchSub = req$.subscribe({
      next: (page) => {
        this.loadingMore = false;
        this.applyPage(page, true);
      },
      error: () => {
        this.loadingMore = false;
        this.errorMessage = 'YOUTUBE.ERROR';
      }
    });
  }

  youtubeUrl(item: YoutubeItem | null): string | null {
    if (!item?.id) {
      return null;
    }
    if (item.kind === 'playlist') {
      return `https://www.youtube.com/playlist?list=${encodeURIComponent(item.id)}`;
    }
    if (item.kind === 'channel') {
      return `https://www.youtube.com/channel/${encodeURIComponent(item.id)}`;
    }
    return `https://www.youtube.com/watch?v=${encodeURIComponent(item.id)}`;
  }

  shareOnWhatsApp(item: YoutubeItem | null, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const url = this.youtubeUrl(item);
    if (!item || !url) {
      return;
    }
    const title = (item.title || '').trim();
    const channel = (item.channelTitle || '').trim();
    const lines = [title || url];
    if (channel) {
      lines.push(channel);
    }
    lines.push('', url);
    openWhatsAppTextShare(lines.join('\n'));
  }

  durationLabel(iso: string | null | undefined): string {
    if (!iso) {
      return '';
    }
    const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
    if (!match) {
      return '';
    }
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2] || 0);
    const seconds = Number(match[3] || 0);
    const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
    const ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  viewsLabel(count: number | null | undefined): string {
    if (count == null || !Number.isFinite(count)) {
      return '';
    }
    if (count >= 1_000_000) {
      return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)} M`;
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)} k`;
    }
    return String(count);
  }

  publishedLabel(iso: string | null | undefined): string {
    if (!iso) {
      return '';
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleDateString(this.translate.currentLang || 'fr', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  isLive(item: YoutubeItem | null | undefined): boolean {
    return (item?.liveBroadcast || '').toLowerCase() === 'live';
  }

  thumbUrl(item: YoutubeItem | null | undefined): string | null {
    return this.api.youtubeThumbUrl(item);
  }

  private loadFavorites(): void {
    if (!this.isLoggedIn) {
      this.favorites = [];
      this.favoriteKeys = new Set();
      this.favoritesHint = 'YOUTUBE.FAVORITES_LOGIN';
      this.isLoadingFavorites = false;
      return;
    }
    this.favoritesSub?.unsubscribe();
    this.isLoadingFavorites = true;
    this.favoritesError = '';
    this.favoritesHint = '';
    this.favoritesSub = this.api.getYoutubeFavorites().subscribe({
      next: (fav) => {
        if (this.destroyed) {
          return;
        }
        this.applyFavorites(fav?.items || []);
        this.isLoadingFavorites = false;
      },
      error: () => {
        if (this.destroyed) {
          return;
        }
        this.favoritesError = 'YOUTUBE.ERR_FAVORITES_LOAD';
        this.isLoadingFavorites = false;
      }
    });
  }

  private applyFavorites(items: YoutubeItem[]): void {
    const decoded = (items || []).map((item) => this.decodeYoutubeItem(item));
    decoded.forEach((item, index) => {
      this.itemSourceOrder.set(item, index);
    });
    this.favorites = decoded;
    this.favoriteKeys = new Set(decoded.map((item) => this.favoriteKey(item)).filter(Boolean));
    if (this.listMode === 'favorites') {
      this.sortItems();
    }
  }

  private loadPopular(preferId?: string | null): void {
    this.listMode = 'catalog';
    this.searchSub?.unsubscribe();
    this.searching = true;
    this.errorMessage = '';
    this.missingKey = false;
    this.resultKind = 'popular';
    this.searchSub = this.api
      .getYoutubePopular({ regionCode: this.regionCode, maxResults: 12 })
      .subscribe({
        next: (page) => {
          this.searching = false;
          this.searched = true;
          this.applyPage(page, false, preferId);
        },
        error: () => {
          this.searching = false;
          this.searched = true;
          this.items = [];
          this.errorMessage = 'YOUTUBE.ERROR';
        }
      });
  }

  private runSearch(preferId?: string | null): void {
    this.listMode = 'catalog';
    const q = this.query.trim();
    if (!q && !this.channelId) {
      if (this.type === 'video') {
        this.loadPopular(preferId);
        return;
      }
      this.searchSub?.unsubscribe();
      this.searching = false;
      this.searched = true;
      this.items = [];
      this.nextPageToken = null;
      this.total = 0;
      this.resultKind = 'search';
      this.errorMessage = '';
      this.syncUrl(preferId);
      return;
    }
    this.searchSub?.unsubscribe();
    this.searching = true;
    this.searched = true;
    this.errorMessage = '';
    this.missingKey = false;
    this.resultKind = 'search';
    this.syncUrl(preferId);
    if (q) {
      this.rememberRecentSearch(q);
    }
    this.searchSub = this.api
      .searchYoutube({
        q: q || undefined,
        type: this.type,
        regionCode: this.regionCode,
        relevanceLanguage: this.relevanceLang(),
        channelId: this.channelId || undefined,
        maxResults: 12,
        order: this.youtubeApiOrder()
      })
      .subscribe({
        next: (page) => {
          this.searching = false;
          this.applyPage(page, false, preferId);
        },
        error: () => {
          this.searching = false;
          this.items = [];
          this.errorMessage = 'YOUTUBE.ERROR';
        }
      });
  }

  private applyPage(page: YoutubeSearchPage, append: boolean, preferId?: string | null): void {
    if (page?.error === 'missing_api_key' || page?.configured === false) {
      this.missingKey = true;
      this.errorMessage = 'YOUTUBE.ERROR_API_KEY';
      this.items = [];
      this.nextPageToken = null;
      this.total = 0;
      return;
    }
    if (page?.error === 'quota_exceeded') {
      this.errorMessage = 'YOUTUBE.ERROR_QUOTA';
    } else if (page?.error === 'invalid_key') {
      this.errorMessage = 'YOUTUBE.ERROR_INVALID_KEY';
    } else if (page?.error) {
      this.errorMessage = 'YOUTUBE.ERROR';
    } else {
      this.errorMessage = '';
    }
    this.missingKey = false;
    const incoming = (page?.items || []).map((item) => this.decodeYoutubeItem(item));
    if (!append) {
      this.itemSourceSeq = 0;
    }
    incoming.forEach((item) => {
      this.itemSourceOrder.set(item, this.itemSourceSeq++);
    });
    this.items = append ? [...this.items, ...incoming] : incoming;
    if (this.channelId && !this.channelFilterTitle) {
      const named = incoming.find((item) => (item.channelTitle || '').trim());
      this.channelFilterTitle = (named?.channelTitle || '').trim();
    }
    this.sortItems();
    this.nextPageToken = page?.nextPageToken || null;
    this.total = page?.total || this.items.length;
    this.resultKind = page?.kind || this.resultKind;
    if (!append) {
      const preferred = preferId ? this.items.find((it) => it.id === preferId) : null;
      if (preferred && (preferred.kind === 'video' || preferred.kind === 'playlist')) {
        this.selectItem(preferred);
      } else if (this.youtubePlayer.currentItem) {
        this.selected = this.decodeYoutubeItem(this.youtubePlayer.currentItem);
      }
      if (this.playAllActive) {
        const list = this.queueItems();
        if (!list.length) {
          this.stopPlayAll();
        } else if (this.queueIndexOf(this.selected) < 0) {
          this.playQueueItem(list[0]);
        }
      }
    }
  }

  private buildEmbedUrl(item: YoutubeItem, autoplay = false): SafeResourceUrl | null {
    const id = item.id || '';
    const extra = autoplay ? '&autoplay=1&playsinline=1' : '&playsinline=1';
    const origin =
      typeof window !== 'undefined'
        ? `&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`
        : '';
    const gen = `&cb=${++this.embedGeneration}`;
    if (item.kind === 'playlist' && /^[a-zA-Z0-9_-]{10,64}$/.test(id)) {
      return this.sanitizer.bypassSecurityTrustResourceUrl(
        `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(id)}&rel=0${extra}${origin}${gen}`
      );
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(id)) {
      return this.sanitizer.bypassSecurityTrustResourceUrl(
        `https://www.youtube-nocookie.com/embed/${id}?rel=0${extra}${origin}${gen}`
      );
    }
    return null;
  }

  private readTickerPreference(): boolean {
    try {
      const raw = localStorage.getItem(YoutubeWatcherComponent.TICKER_STORAGE_KEY);
      if (raw == null) {
        return true;
      }
      return raw !== '0' && raw !== 'false';
    } catch {
      return true;
    }
  }

  private writeTickerPreference(enabled: boolean): void {
    try {
      localStorage.setItem(YoutubeWatcherComponent.TICKER_STORAGE_KEY, enabled ? '1' : '0');
    } catch {
      /* ignore quota / private mode */
    }
  }

  private rememberRecentSearch(term: string): void {
    const value = term.trim();
    if (value.length < 2) {
      return;
    }
    const lower = value.toLowerCase();
    const next = [
      value,
      ...this.recentSearches.filter((item) => item.toLowerCase() !== lower)
    ].slice(0, YoutubeWatcherComponent.RECENT_SEARCHES_MAX);
    this.recentSearches = next;
    this.writeRecentSearches(next);
  }

  private readRecentSearches(): string[] {
    try {
      const raw = sessionStorage.getItem(YoutubeWatcherComponent.RECENT_SEARCHES_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length >= 2)
        .slice(0, YoutubeWatcherComponent.RECENT_SEARCHES_MAX);
    } catch {
      return [];
    }
  }

  private writeRecentSearches(terms: string[]): void {
    try {
      sessionStorage.setItem(
        YoutubeWatcherComponent.RECENT_SEARCHES_KEY,
        JSON.stringify(terms)
      );
    } catch {
      /* ignore quota / private mode */
    }
  }

  private scrollPageToTop(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    if (active && this.host.nativeElement.contains(active) && typeof active.blur === 'function') {
      active.blur();
    }
    const jump = (): void => {
      window.scrollTo(0, 0);
      const se = document.scrollingElement as HTMLElement | null;
      if (se) {
        se.scrollTop = 0;
        se.scrollLeft = 0;
      }
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      let node: HTMLElement | null = this.host.nativeElement;
      while (node && node !== document.documentElement) {
        if (node.scrollTop) {
          node.scrollTop = 0;
        }
        node = node.parentElement;
      }
    };
    jump();
    this.clearScrollTopTimers();
    this.scrollTopTimer = setTimeout(() => {
      this.scrollTopTimer = undefined;
      if (this.destroyed) {
        return;
      }
      jump();
      this.scrollTopRaf = requestAnimationFrame(() => {
        this.scrollTopRaf = undefined;
        if (this.destroyed) {
          return;
        }
        jump();
        this.scrollTopFollowTimer = setTimeout(() => {
          this.scrollTopFollowTimer = undefined;
          if (!this.destroyed) {
            jump();
          }
        }, 80);
      });
    }, 0);
  }

  private clearScrollTopTimers(): void {
    if (this.scrollTopTimer !== undefined) {
      clearTimeout(this.scrollTopTimer);
      this.scrollTopTimer = undefined;
    }
    if (this.scrollTopFollowTimer !== undefined) {
      clearTimeout(this.scrollTopFollowTimer);
      this.scrollTopFollowTimer = undefined;
    }
    if (this.scrollTopRaf !== undefined) {
      cancelAnimationFrame(this.scrollTopRaf);
      this.scrollTopRaf = undefined;
    }
  }

  private setupLandscapeFullscreenWatchers(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    this.landscapeOrientationMql = window.matchMedia('(orientation: landscape)');
    if (typeof this.landscapeOrientationMql.addEventListener === 'function') {
      this.landscapeOrientationMql.addEventListener('change', this.onLandscapeOrientationMedia);
    } else {
      (
        this.landscapeOrientationMql as MediaQueryList & {
          addListener?: (cb: () => void) => void;
        }
      ).addListener?.(this.onLandscapeOrientationMedia);
    }
    document.addEventListener('fullscreenchange', this.onLandscapeFsChange);
    document.addEventListener('webkitfullscreenchange', this.onLandscapeFsChange);
  }

  private teardownLandscapeFullscreenWatchers(): void {
    if (this.landscapeOrientationMql) {
      if (typeof this.landscapeOrientationMql.removeEventListener === 'function') {
        this.landscapeOrientationMql.removeEventListener('change', this.onLandscapeOrientationMedia);
      } else {
        (
          this.landscapeOrientationMql as MediaQueryList & {
            removeListener?: (cb: () => void) => void;
          }
        ).removeListener?.(this.onLandscapeOrientationMedia);
      }
      this.landscapeOrientationMql = null;
    }
    document.removeEventListener('fullscreenchange', this.onLandscapeFsChange);
    document.removeEventListener('webkitfullscreenchange', this.onLandscapeFsChange);
  }

  private isMobileLikeViewport(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    const touch = (navigator.maxTouchPoints || 0) > 0;
    return coarse || (narrow && touch);
  }

  private isLandscapeOrientation(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    if (this.landscapeOrientationMql) {
      return this.landscapeOrientationMql.matches;
    }
    return window.matchMedia('(orientation: landscape)').matches;
  }

  private canEnterLandscapeFullscreen(): boolean {
    return (
      this.isMobileLikeViewport() &&
      this.isLandscapeOrientation() &&
      !!this.selected &&
      !!this.embedUrl &&
      !this.playerOpen &&
      !this.landscapeFsUserDismissed
    );
  }

  private syncLandscapeFullscreen(): void {
    if (this.destroyed) {
      return;
    }
    if (!this.isLandscapeOrientation()) {
      this.landscapeFsUserDismissed = false;
      this.exitLandscapeFullscreen(false);
      return;
    }
    if (this.canEnterLandscapeFullscreen()) {
      this.enterLandscapeFullscreen();
      return;
    }
    if (this.landscapeFullscreen && (!this.selected || !this.embedUrl || this.playerOpen)) {
      this.exitLandscapeFullscreen(false);
    }
  }

  private enterLandscapeFullscreen(): void {
    if (!this.landscapeFullscreen) {
      this.landscapeFullscreen = true;
      document.body.classList.add(YoutubeWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
    } else {
      document.body.classList.add(YoutubeWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
    }
    void this.requestLandscapeNativeFullscreen();
  }

  private async requestLandscapeNativeFullscreen(): Promise<void> {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      return;
    }
    const wrap = this.playerFrame?.nativeElement || null;
    if (!wrap) {
      return;
    }
    this.landscapeFsNativeRequested = true;
    try {
      const req =
        wrap.requestFullscreen?.bind(wrap) ||
        (
          wrap as HTMLElement & {
            webkitRequestFullscreen?: () => Promise<void> | void;
          }
        ).webkitRequestFullscreen?.bind(wrap);
      if (req) {
        await Promise.resolve(req());
      }
    } catch {
      // CSS immersive mode remains active.
    }
  }

  private exitOwnedNativeFullscreen(): void {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    const fsEl = document.fullscreenElement || doc.webkitFullscreenElement;
    if (!fsEl) {
      this.landscapeFsNativeRequested = false;
      return;
    }
    const wrap = this.playerFrame?.nativeElement || null;
    const owned = this.landscapeFsNativeRequested || (!!wrap && (fsEl === wrap || wrap.contains(fsEl)));
    if (!owned) {
      return;
    }
    try {
      if (document.exitFullscreen) {
        void document.exitFullscreen().catch(() => undefined);
      } else {
        doc.webkitExitFullscreen?.();
      }
    } catch {
      /* ignore */
    }
    this.landscapeFsNativeRequested = false;
  }

  private onLandscapeNativeFullscreenChange(): void {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const fsEl = document.fullscreenElement || doc.webkitFullscreenElement || null;
    const wrap = this.playerFrame?.nativeElement || null;
    const ours = !!(fsEl && wrap && (fsEl === wrap || wrap.contains(fsEl)));
    if (ours) {
      this.landscapeFsNativeActive = true;
      return;
    }
    const hadNative = this.landscapeFsNativeActive || this.landscapeFsNativeRequested;
    this.landscapeFsNativeActive = false;
    this.landscapeFsNativeRequested = false;
    if (this.landscapeFsSuppressDismiss || !hadNative) {
      return;
    }
    if (this.isLandscapeOrientation() && this.landscapeFullscreen) {
      this.exitLandscapeFullscreen(true);
    }
  }

  private relevanceLang(): string {
    const lang = (this.translate.currentLang || 'fr').toLowerCase();
    if (lang.startsWith('jp')) {
      return 'ja';
    }
    if (lang.startsWith('cn')) {
      return 'zh';
    }
    if (lang.startsWith('in')) {
      return 'hi';
    }
    return lang.slice(0, 2);
  }

  private regionFromUiLang(lang: string | undefined): string {
    const code = (lang || 'fr').toLowerCase();
    const map: Record<string, string> = {
      fr: 'FR',
      en: 'US',
      de: 'DE',
      es: 'ES',
      it: 'IT',
      ru: 'RU',
      jp: 'JP',
      cn: 'CN',
      ar: 'SA',
      he: 'IL',
      el: 'GR',
      in: 'IN'
    };
    return map[code] || 'FR';
  }

  private normalizeRegion(code: string | null): string {
    const value = (code || 'FR').toUpperCase();
    return this.regions.some((r) => r.code === value) ? value : 'FR';
  }

  private normalizeType(type: string | null): YoutubeItemKind {
    if (type === 'playlist' || type === 'channel' || type === 'video') {
      return type;
    }
    return 'video';
  }

  private normalizeSort(value: string | null): YoutubeSortKey {
    if (
      value === 'date' ||
      value === 'views' ||
      value === 'duration' ||
      value === 'title' ||
      value === 'channel' ||
      value === 'relevance'
    ) {
      return value;
    }
    return 'relevance';
  }

  private defaultSortDir(key: YoutubeSortKey): YoutubeSortDir {
    return key === 'title' || key === 'channel' || key === 'relevance' ? 'asc' : 'desc';
  }

  private normalizeSortDir(value: string | null, key: YoutubeSortKey): YoutubeSortDir {
    if (value === 'asc' || value === 'desc') {
      return value;
    }
    return this.defaultSortDir(key);
  }

  private youtubeApiOrder(): string | undefined {
    switch (this.sortKey) {
      case 'date':
        return 'date';
      case 'views':
        return 'viewCount';
      case 'title':
        return 'title';
      default:
        return undefined;
    }
  }

  private sortItems(): void {
    const dir = this.sortDir === 'asc' ? 1 : -1;
    const key = this.sortKey;
    const sortList = (list: YoutubeItem[]): YoutubeItem[] =>
      [...list].sort((a, b) => {
        const cmp = this.compareItems(a, b, key);
        if (cmp !== 0) {
          return cmp * dir;
        }
        return (this.itemSourceOrder.get(a) || 0) - (this.itemSourceOrder.get(b) || 0);
      });
    if (this.listMode === 'favorites') {
      this.favorites = sortList(this.favorites);
    } else {
      this.items = sortList(this.items);
    }
  }

  private compareItems(a: YoutubeItem, b: YoutubeItem, key: YoutubeSortKey): number {
    switch (key) {
      case 'date':
        return this.publishedTime(a) - this.publishedTime(b);
      case 'views':
        return (a.viewCount || 0) - (b.viewCount || 0);
      case 'duration':
        return this.durationSeconds(a.duration) - this.durationSeconds(b.duration);
      case 'title':
        return this.compareText(a.title, b.title);
      case 'channel':
        return this.compareText(a.channelTitle, b.channelTitle);
      default:
        return (this.itemSourceOrder.get(a) || 0) - (this.itemSourceOrder.get(b) || 0);
    }
  }

  private compareText(a: string | null | undefined, b: string | null | undefined): number {
    return (a || '').localeCompare(b || '', this.translate.currentLang || 'fr', {
      sensitivity: 'base',
      numeric: true
    });
  }

  private decodeYoutubeItem(item: YoutubeItem): YoutubeItem {
    return {
      ...item,
      title: this.decodeYoutubeHtml(item.title),
      description: this.decodeYoutubeHtml(item.description),
      channelTitle: this.decodeYoutubeHtml(item.channelTitle)
    };
  }

  /** YouTube sometimes returns titles with HTML entities (`&#39;`, `&amp;`, `&quot;`). */
  private decodeYoutubeHtml(value: string | null | undefined): string | undefined {
    if (value == null || value === '') {
      return value === '' ? '' : undefined;
    }
    if (!/&[#a-zA-Z0-9]+;/.test(value)) {
      return value;
    }
    let decoded = value;
    for (let i = 0; i < 2; i++) {
      const next =
        typeof DOMParser !== 'undefined'
          ? new DOMParser().parseFromString(decoded, 'text/html').documentElement.textContent || ''
          : decoded
              .replace(/&nbsp;/gi, ' ')
              .replace(/&amp;/gi, '&')
              .replace(/&quot;/gi, '"')
              .replace(/&apos;/gi, "'")
              .replace(/&#0*39;/g, "'")
              .replace(/&#x0*27;/gi, "'")
              .replace(/&lt;/gi, '<')
              .replace(/&gt;/gi, '>');
      if (next === decoded) {
        break;
      }
      decoded = next;
    }
    return decoded;
  }

  private publishedTime(item: YoutubeItem): number {
    const time = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
    return Number.isFinite(time) ? time : 0;
  }

  private durationSeconds(iso: string | null | undefined): number {
    if (!iso) {
      return 0;
    }
    const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
    if (!match) {
      return 0;
    }
    return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  }

  showPlaybackFooter(): boolean {
    return !!this.selected && (!!this.embedUrl || this.playbackDurationSec > 0 || this.isLive(this.selected));
  }

  playbackPercent(): number {
    if (this.playbackDurationSec <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, (this.playbackCurrentSec / this.playbackDurationSec) * 100));
  }

  playbackRemainingSec(): number {
    return Math.max(0, this.playbackDurationSec - this.playbackCurrentSec);
  }

  playbackClock(totalSec: number): string {
    const sec = Math.max(0, Math.floor(Number.isFinite(totalSec) ? totalSec : 0));
    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const seconds = sec % 60;
    const ss = String(seconds).padStart(2, '0');
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
    }
    return `${minutes}:${ss}`;
  }

  playbackAriaLabel(): string {
    return this.translate.instant('YOUTUBE.PROGRESS_ARIA', {
      elapsed: this.playbackClock(this.playbackCurrentSec),
      duration: this.playbackClock(this.playbackDurationSec),
      remaining: this.playbackClock(this.playbackRemainingSec())
    });
  }

  onYoutubeEmbedLoad(): void {
    this.startYoutubeProgressWatch();
  }

  onPlaybackSeek(event: MouseEvent): void {
    if (this.playbackDurationSec <= 0) {
      return;
    }
    const track = event.currentTarget as HTMLElement | null;
    if (!track) {
      return;
    }
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const time = ratio * this.playbackDurationSec;
    this.playbackCurrentSec = time;
    this.sendYoutubeCommand('seekTo', [time, true]);
  }

  private resetPlaybackClock(item: YoutubeItem | null): void {
    this.playbackCurrentSec = 0;
    this.playbackDurationSec = this.durationSeconds(item?.duration);
  }

  private startYoutubeProgressWatch(): void {
    this.stopYoutubeProgressWatch();
    if (this.destroyed || this.playerOpen || !this.embedUrl) {
      return;
    }
    this.ytApiListening = false;
    this.ngZone.runOutsideAngular(() => {
      this.handshakeYoutubePlayer();
      this.ytProgressTimer = setInterval(() => this.tickYoutubeProgressWatch(), 400);
    });
  }

  private tickYoutubeProgressWatch(): void {
    if (this.destroyed || this.playerOpen || !this.embedUrl) {
      this.stopYoutubeProgressWatch();
      return;
    }
    if (!this.ytApiListening) {
      this.handshakeYoutubePlayer();
    }
    this.sendYoutubeCommand('getCurrentTime');
    this.sendYoutubeCommand('getDuration');
  }

  private stopYoutubeProgressWatch(): void {
    if (this.ytProgressTimer !== undefined) {
      clearInterval(this.ytProgressTimer);
      this.ytProgressTimer = undefined;
    }
  }

  private unloadPageEmbed(): void {
    this.stopYoutubeProgressWatch();
    this.ytApiListening = false;
    const iframe = this.getYoutubeIframe();
    if (iframe) {
      try {
        iframe.src = 'about:blank';
      } catch {
        /* ignore */
      }
    }
    this.embedUrl = null;
  }

  private scheduleLandscapeSync(): void {
    if (this.landscapeSyncTimer !== undefined) {
      clearTimeout(this.landscapeSyncTimer);
    }
    this.landscapeSyncTimer = setTimeout(() => {
      this.landscapeSyncTimer = undefined;
      if (!this.destroyed) {
        this.syncLandscapeFullscreen();
      }
    }, 0);
  }

  private clearLandscapeTimers(): void {
    if (this.landscapeSyncTimer !== undefined) {
      clearTimeout(this.landscapeSyncTimer);
      this.landscapeSyncTimer = undefined;
    }
    if (this.landscapeSuppressTimer !== undefined) {
      clearTimeout(this.landscapeSuppressTimer);
      this.landscapeSuppressTimer = undefined;
    }
  }

  private handshakeYoutubePlayer(): void {
    this.postToYoutube({ event: 'listening', id: 'yt-page-embed' });
    if (!this.ytApiListening) {
      this.sendYoutubeCommand('addEventListener', ['onStateChange']);
    }
  }

  private getYoutubeIframe(): HTMLIFrameElement | null {
    const wrap = this.playerFrame?.nativeElement;
    const fromWrap = wrap?.querySelector('iframe.yt-page-embed') as HTMLIFrameElement | null;
    if (fromWrap) {
      return fromWrap;
    }
    if (typeof document === 'undefined') {
      return null;
    }
    return document.querySelector('iframe.yt-page-embed');
  }

  private postToYoutube(payload: object): void {
    const iframe = this.getYoutubeIframe();
    if (!iframe?.contentWindow) {
      return;
    }
    try {
      iframe.contentWindow.postMessage(JSON.stringify(payload), '*');
    } catch {
      /* ignore */
    }
  }

  private sendYoutubeCommand(func: string, args: unknown[] = []): void {
    this.postToYoutube({ event: 'command', func, args, id: 'yt-page-embed' });
  }

  private onYoutubeProgressMessage(event: MessageEvent): void {
    if (this.destroyed || this.playerOpen || !this.embedUrl) {
      return;
    }
    const origin = (event.origin || '').toLowerCase();
    if (!origin.includes('youtube.com') && !origin.includes('youtube-nocookie.com')) {
      return;
    }
    let data: unknown = event.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (!data || typeof data !== 'object') {
      return;
    }
    const payload = data as {
      event?: string;
      info?: number | Record<string, unknown>;
    };
    this.ytApiListening = true;
    this.ngZone.run(() => {
      if (this.destroyed || this.playerOpen || !this.embedUrl) {
        return;
      }
      if (payload.event === 'onStateChange' && typeof payload.info === 'number') {
        this.applyYoutubePlayerState(payload.info);
        return;
      }
      const info = payload.info;
      if (!info || typeof info !== 'object' || Array.isArray(info)) {
        return;
      }
      const playerState = info['playerState'];
      if (typeof playerState === 'number') {
        this.applyYoutubePlayerState(playerState);
        if (playerState === 0) {
          return;
        }
      }
      const currentTime = info['currentTime'];
      const duration = info['duration'];
      if (typeof currentTime === 'number' && Number.isFinite(currentTime)) {
        this.playbackCurrentSec = Math.max(0, currentTime);
      }
      if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
        this.playbackDurationSec = duration;
      }
    });
  }

  private applyYoutubePlayerState(state: number): void {
    if (state === 1 || state === 3) {
      this.playbackPaused = false;
    } else if (state === 2) {
      this.playbackPaused = true;
    }
    if (state !== 0) {
      return;
    }
    this.playbackPaused = true;
    if (this.playbackDurationSec > 0) {
      this.playbackCurrentSec = this.playbackDurationSec;
    }
    this.onQueueVideoEnded();
  }

  canLinkVideo(item: YoutubeItem | null | undefined): boolean {
    return item?.kind === 'video' && isYoutubeVideoId(item.id);
  }

  openInVideoshow(): void {
    const item = this.selected;
    if (!this.canLinkVideo(item) || !this.videoshowModalComponent) {
      return;
    }
    this.exitLandscapeFullscreen(false);
    this.videoshowRestorePip = this.playerOpen;
    this.stopPlayAll();
    if (this.clientRecordingActive) {
      this.stopActiveRecording();
    }
    this.embedUrl = null;
    this.stopYoutubeProgressWatch();
    if (this.playerOpen) {
      this.youtubePlayer.close();
    }
    const sources: VideoshowVideoSource[] = [];
    const seen = new Set<string>();
    for (const it of this.items) {
      const id = (it.id || '').trim();
      if (it.kind !== 'video' || !isYoutubeVideoId(id) || seen.has(id)) {
        continue;
      }
      seen.add(id);
      sources.push({ youtubeVideoId: id, fileName: it.title });
    }
    const selectedId = (item!.id || '').trim();
    let startIndex = sources.findIndex((source) => source.youtubeVideoId === selectedId);
    if (startIndex < 0) {
      sources.unshift({ youtubeVideoId: selectedId, fileName: item!.title });
      startIndex = 0;
    }
    this.videoshowModalComponent.open(sources, item!.title || '', false, 0, startIndex);
  }

  onVideoshowClosed(): void {
    const item = this.selected;
    const restorePip = this.videoshowRestorePip;
    this.videoshowRestorePip = false;
    if (!item) {
      return;
    }
    if (restorePip) {
      this.youtubePlayer.open(item);
      return;
    }
    this.embedUrl = this.buildEmbedUrl(item, true);
    this.scheduleLandscapeSync();
  }

  openLinkToEventModal(): void {
    if (!this.canLinkVideo(this.selected) || !this.linkToEventModal) {
      return;
    }
    this.linkTarget = this.selected;
    this.linkEventsList = [];
    this.linkEventsFilter = '';
    this.linkEventsTypeFilter = '';
    this.linkEventsLoading = true;
    this.linkEventsError = false;
    this.linkSavingEventId = null;
    this.linkFeedbackKey = null;
    this.linkFeedbackParams = {};
    this.linkFeedbackKind = null;
    if (this.linkFeedbackTimer !== undefined) {
      clearTimeout(this.linkFeedbackTimer);
      this.linkFeedbackTimer = undefined;
    }
    this.linkModalRef = this.modalService.open(this.linkToEventModal, {
      size: 'lg',
      centered: true,
      windowClass: 'yt-link-event-modal',
      backdropClass: 'yt-link-event-modal-backdrop',
      modalDialogClass: 'yt-link-event-modal-dialog'
    });
    this.linkModalRef.dismissed.subscribe(() => this.onLinkModalClosed());
    this.linkModalRef.closed.subscribe(() => this.onLinkModalClosed());
    this.streamEventsForLink();
  }

  cancelLinkToEventModal(): void {
    this.linkModalRef?.dismiss();
  }

  private closeLinkToEventModal(): void {
    try {
      this.linkModalRef?.dismiss();
    } catch {
      /* already closed */
    }
    this.onLinkModalClosed();
  }

  private onLinkModalClosed(): void {
    this.linkEventsStreamSub?.unsubscribe();
    this.linkEventsStreamSub = undefined;
    this.linkModalRef = null;
    this.linkSavingEventId = null;
    this.linkTarget = null;
  }

  filteredLinkEvents(): Evenement[] {
    const term = (this.linkEventsFilter ?? '').trim().toLowerCase();
    const typeFilter = (this.linkEventsTypeFilter ?? '').trim();
    const list = this.linkEventsList;
    let out = !term
      ? list
      : list.filter((e) => (e.evenementName ?? '').toLowerCase().includes(term));
    if (typeFilter) {
      out = out.filter((e) => (e.type ?? '') === typeFilter);
    }
    return [...out].sort((a, b) => {
      const dA = a?.beginEventDate ? new Date(a.beginEventDate).getTime() : 0;
      const dB = b?.beginEventDate ? new Date(b.beginEventDate).getTime() : 0;
      return dB - dA;
    });
  }

  linkEventTypeLabelKey(typeId: string | undefined | null): string {
    const id = (typeId ?? '').trim();
    if (!id) {
      return '';
    }
    const found = this.linkEventTypeOptions.find((o) => o.value === id);
    return found ? found.labelKey : id;
  }

  linkEventDateLabel(ev: Evenement): string {
    const d = ev?.beginEventDate ? new Date(ev.beginEventDate) : null;
    if (!d || Number.isNaN(d.getTime())) {
      return '';
    }
    try {
      return d.toLocaleDateString(this.translate.currentLang || 'fr', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch {
      return d.toISOString().slice(0, 10);
    }
  }

  canSubmitLinkForEvent(ev: Evenement): boolean {
    return !!ev?.id && this.linkSavingEventId == null && this.canLinkVideo(this.linkTarget);
  }

  onSelectEventForLink(ev: Evenement): void {
    const item = this.linkTarget;
    const eventId = ev?.id?.trim();
    if (!eventId || !this.canLinkVideo(item) || this.linkSavingEventId) {
      return;
    }
    const videoId = (item!.id || '').trim();
    if (this.eventAlreadyHasYoutube(ev, videoId)) {
      this.linkFeedbackKey = 'YOUTUBE.LINK_ALREADY';
      this.linkFeedbackParams = { name: ev.evenementName };
      this.linkFeedbackKind = 'error';
      return;
    }
    const user = this.membersService.getUser();
    const description = (item!.title || '').trim().slice(0, 200);
    const urlEvent = new UrlEvent(
      'YOUTUBE',
      new Date(),
      user?.userName || '',
      youtubeWatchUrl(videoId),
      description
    );
    this.linkSavingEventId = eventId;
    this.linkFeedbackKey = null;
    this.linkSaveSub?.unsubscribe();
    this.linkSaveSub = this.evenementsService.addUrlEvent(eventId, urlEvent).subscribe({
      next: (updated) => {
        this.ngZone.run(() => {
          this.linkSavingEventId = null;
          if (updated) {
            const idx = this.linkEventsList.findIndex((e) => e.id === eventId);
            if (idx >= 0) {
              this.linkEventsList = [
                ...this.linkEventsList.slice(0, idx),
                updated,
                ...this.linkEventsList.slice(idx + 1)
              ];
            }
          }
          this.linkFeedbackKey = 'YOUTUBE.LINK_SUCCESS';
          this.linkFeedbackParams = { name: ev.evenementName };
          this.linkFeedbackKind = 'success';
          if (this.linkFeedbackTimer !== undefined) {
            clearTimeout(this.linkFeedbackTimer);
          }
          this.linkFeedbackTimer = setTimeout(() => {
            this.linkModalRef?.close();
          }, YoutubeWatcherComponent.LINK_FEEDBACK_AUTO_CLOSE_MS);
        });
      },
      error: () => {
        this.ngZone.run(() => {
          this.linkSavingEventId = null;
          this.linkFeedbackKey = 'YOUTUBE.LINK_ERROR';
          this.linkFeedbackParams = { name: ev.evenementName };
          this.linkFeedbackKind = 'error';
        });
      }
    });
  }

  private eventAlreadyHasYoutube(ev: Evenement, videoId: string): boolean {
    return (ev.urlEvents || []).some((u) => parseYoutubeVideoId(u?.link) === videoId);
  }

  private streamEventsForLink(): void {
    this.linkEventsStreamSub?.unsubscribe();
    const userId = this.membersService.getUser()?.id ?? '';
    this.linkEventsStreamSub = this.evenementsService.streamEvents('*', userId).subscribe({
      next: (s: StreamedEvent) => {
        this.ngZone.run(() => {
          if (s.type === 'event' && s.data && typeof s.data === 'object' && 'id' in s.data) {
            const incoming = s.data as Evenement;
            const existsIdx = this.linkEventsList.findIndex((e) => e.id === incoming.id);
            if (existsIdx === -1) {
              this.linkEventsList = [...this.linkEventsList, incoming];
            }
          } else if (s.type === 'complete') {
            this.linkEventsLoading = false;
          }
        });
      },
      error: () => {
        this.ngZone.run(() => {
          this.linkEventsLoading = false;
          this.linkEventsError = true;
        });
      },
      complete: () => {
        this.ngZone.run(() => {
          this.linkEventsLoading = false;
        });
      }
    });
  }

  private syncUrl(preferId?: string | null): Promise<boolean> {
    const queryParams: Record<string, string | null> = {
      q: this.query.trim() || null,
      type: this.type !== 'video' ? this.type : null,
      region: this.regionCode !== this.regionFromUiLang(this.translate.currentLang) ? this.regionCode : null,
      channel: this.channelId || null,
      sort: this.sortKey !== 'relevance' ? this.sortKey : null,
      dir: this.sortDir !== this.defaultSortDir(this.sortKey) ? this.sortDir : null,
      id: preferId || this.selected?.id || null
    };
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      queryParamsHandling: '',
      replaceUrl: true
    });
  }
}
