import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostBinding,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject, Subscription, forkJoin, of, firstValueFrom } from 'rxjs';
import { debounceTime, distinctUntilChanged, catchError } from 'rxjs/operators';
import Hls from 'hls.js';

import { ApiService, ArteProgram, ArteSection, IaProgram, IaSection, TvChannel, TvCountry, TvEpgNow, TvEpgProgramme, TvEpgSearchHit, TvRecording, TvRecordingStatus } from '../services/api.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { TvPlayerService } from '../services/tv-player.service';
import {
  isArteReplayVod,
  isArteVirtual,
  isCanalGroupVirtual,
  isFranceTvVirtual,
  internetArchiveIdFromVirtualUrl,
  isInternetArchiveVirtual,
  isKeepAliveVirtualLive,
  isM6GroupVirtual,
  isProgressiveVod,
  isRadioFranceVirtual,
  isTf1Virtual,
  resolveTvStreamUrl
} from './tv-stream.util';
import {
  formatTvPlayErrorDisplay,
  resolveTvStreamErrorMessage
} from './tv-stream-error.util';
import { groupIconEmoji, groupIconFaClass, groupI18nKey } from './tv-group-icon.util';
import { epgLookupKey, resolveEpgChannelId } from './tv-epg.util';
import {
  attachTvHlsLiveSyncWatchdog,
  createTvHlsConfig,
  isTvHlsForbiddenError,
  resyncTvHlsAv,
  tryRecoverTvHlsError,
  type TvHlsRecoverAttempts
} from './tv-hls-config';
import {
  FranceTvTokenKeeper,
  startFranceTvTokenKeeper
} from './tv-francetv-refresh';
import { bustVirtualLiveCache, preflightVirtualLive, virtualLiveKeepAliveFromUrl } from './tv-virtual-live-keepalive';
import { MediaCatalogCacheToolbarComponent } from '../shared/media-catalog-cache-toolbar/media-catalog-cache-toolbar.component';
import { TvEpgBrowserComponent } from './tv-epg-browser.component';

type TvListMode = 'catalog' | 'favorites' | 'recordings' | 'arte' | 'ia';

@Component({
  selector: 'app-tv-watcher',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, MediaCatalogCacheToolbarComponent, TvEpgBrowserComponent],
  templateUrl: './tv-watcher.component.html',
  styleUrls: ['./tv-watcher.component.css']
})
export class TvWatcherComponent implements OnInit, OnDestroy {
  @ViewChild('videoEl')
  set videoElRef(ref: ElementRef<HTMLVideoElement> | undefined) {
    this.videoEl = ref;
    this.bindLandscapeVideoFsListener(ref?.nativeElement || null);
  }
  videoEl?: ElementRef<HTMLVideoElement>;

  countries: TvCountry[] = [];
  channels: TvChannel[] = [];
  groups: string[] = [];
  favorites: TvChannel[] = [];
  favoriteIds = new Set<string>();
  recordings: TvRecording[] = [];

  listMode: TvListMode = 'favorites';
  selectedCountry = 'all';
  selectedGroup = '';
  /** Filter by channel name / group / country. */
  channelQuery = '';
  /** Filter by EPG programme title (server-side search). */
  programQuery = '';
  selectedChannel: TvChannel | null = null;
  /** Playback of a finished recording (mutually exclusive with live channel stream). */
  playingRecording: TvRecording | null = null;
  /** Hint when « all countries » is selected but the query is too short. */
  worldwideSearchHint = false;
  countryMenuOpen = false;
  countryFilter = '';
  /** Collapse state of the filters panel, remembered per tab. */
  private filtersCollapsedByMode: Record<TvListMode, boolean> = {
    catalog: true,
    favorites: true,
    recordings: true,
    arte: false,
    ia: false
  };

  /** ARTE replay catalog (proxied EMAC). */
  arteSections: ArteSection[] = [];
  arteSection = 'MOST_RECENT';
  artePage = 1;
  artePages = 1;
  arteTotal = 0;
  isLoadingArte = false;
  arteError = '';
  private arteMetaById = new Map<string, ArteProgram>();

  /** Internet Archive movie catalog. */
  iaSections: IaSection[] = [];
  iaSection = 'RECENT';
  iaPage = 1;
  iaPages = 1;
  iaTotal = 0;
  isLoadingIa = false;
  iaError = '';
  private iaMetaById = new Map<string, IaProgram>();

  isLoadingCountries = false;
  isLoadingChannels = false;
  isLoadingFavorites = false;
  favoriteBusyId = '';
  playError = '';
  channelsError = '';
  countriesError = '';
  favoritesError = '';
  favoritesHint = '';
  recordingsError = '';
  recordingsHint = '';
  isLoadingRecordings = false;
  recordingBusy = false;
  recordingStatus: TvRecordingStatus | null = null;
  /** True after the first capability probe (success or error). */
  recordingStatusLoaded = false;
  /** Browser-side capture in progress (MediaRecorder). */
  clientRecordingActive = false;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private clientRecordStartedAt = 0;
  private clientRecordChannel: TvChannel | null = null;
  private recordAutoStopTimer: ReturnType<typeof setTimeout> | null = null;
  /** Requested max duration when starting a recording (seconds). */
  recordDurationSec = 300;
  readonly recordDurationOptions = [
    { sec: 60, labelKey: 'TV.RECORD_DUR_1M' },
    { sec: 300, labelKey: 'TV.RECORD_DUR_5M' },
    { sec: 600, labelKey: 'TV.RECORD_DUR_10M' },
    { sec: 900, labelKey: 'TV.RECORD_DUR_15M' },
    { sec: 1800, labelKey: 'TV.RECORD_DUR_30M' }
  ];
  isMuted = false;
  /** 0–100, mirrored to HTMLVideoElement.volume */
  volumePercent = 100;
  isBuffering = false;
  tf1Configured: boolean | null = null;
  isPipActive = false;
  pipSupported = TvPlayerService.supportsVideoPictureInPicture();
  /** Channel bar + native controls: auto-hide after idle, show on hover. */
  chromeVisible = true;
  /** Share menu (WhatsApp / copy / native). */
  shareMenuOpen = false;
  epgBrowserOpen = false;
  shareFeedback = '';
  /** Brief status after manual A/V resync. */
  resyncFeedback = '';
  /** Brief on-video toast when france.tv Akamai token was renewed silently. */
  tokenRenewedToast = false;
  private tokenRenewedToastTimer: ReturnType<typeof setTimeout> | null = null;
  /** When true, leaving the page keeps playback in the floating player. */
  keepAliveOnNavigate = true;
  readonly canNativeShare =
    typeof navigator !== 'undefined' && typeof (navigator as Navigator).share === 'function';

  /** Total catalog size for the current country (or worldwide when country=all). */
  catalogTotalCount = 0;
  isLoadingCatalogCount = false;
  /** Exact match count for worldwide search (may exceed the truncated list length). */
  searchMatchTotal: number | null = null;
  searchListTruncated = false;

  /**
   * Mobile landscape: immersive TV stage (CSS + best-effort native fullscreen).
   * Set via HostBinding so the player can cover the viewport even if Fullscreen API is blocked.
   */
  @HostBinding('class.tv-landscape-fs') landscapeFullscreen = false;

  /** EPG now/next keyed by lowercase XMLTV id. */
  epgById: Record<string, TvEpgNow> = {};
  isLoadingEpg = false;

  /** Server-side programme search results. */
  programSearchHits: TvEpgSearchHit[] = [];
  private programSearchEpgIds = new Set<string>();
  isLoadingProgramSearch = false;

  /** Full EPG schedule panel for the selected channel. */
  guideOpen = false;
  guideProgrammes: TvEpgProgramme[] = [];
  isLoadingGuide = false;
  guideError = '';

  private catalogCountSub?: Subscription;
  private hls: Hls | null = null;
  private detachHlsLiveSync: (() => void) | null = null;
  private franceTvKeeper: FranceTvTokenKeeper | null = null;
  private channelSearch$ = new Subject<string>();
  private programSearch$ = new Subject<string>();
  private channelSearchSub?: Subscription;
  private programSearchSub?: Subscription;
  private channelsSub?: Subscription;
  private resumeSub?: Subscription;
  private lastChannelSaveSub?: Subscription;
  private epgSub?: Subscription;
  private programSearchHttpSub?: Subscription;
  private guideSub?: Subscription;
  private recordingsPollTimer: ReturnType<typeof setInterval> | null = null;
  private epgRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private restoredLastChannel = false;
  private chromeHideTimer: ReturnType<typeof setTimeout> | null = null;
  private shareFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Deep-link channel id waiting for catalog load. */
  private pendingShareChannelId = '';
  private playGeneration = 0;
  private hlsRecoverAttempts: TvHlsRecoverAttempts = { network: 0, media: 0 };
  /** One auto re-resolve per play attempt when france.tv Akamai token returns 403. */
  private franceTvTokenRefreshAttempted = false;
  private static readonly CHROME_HIDE_MS = 2000;
  private static readonly LAST_CHANNEL_STORAGE_KEY = 'pattool.tv.last-channel';
  private static readonly KEEP_ALIVE_STORAGE_KEY = 'pattool.tv.keep-alive';
  private static readonly CATALOG_COUNT_STORAGE_KEY = 'pattool.tv.catalog-count';
  /** Max length for virtual stream tokens in share links (not full http URLs). */
  private static readonly SHARE_STREAM_MAX_LEN = 80;
  private static readonly EPG_REFRESH_MS = 5 * 60 * 1000;
  private static readonly LANDSCAPE_FS_BODY_CLASS = 'tv-landscape-fs';

  /** User dismissed immersive FS while still landscape — wait until portrait before auto-reentering. */
  private landscapeFsUserDismissed = false;
  private landscapeFsNativeRequested = false;
  private landscapeFsNativeActive = false;
  private landscapeFsSuppressDismiss = false;
  private landscapeOrientationMql: MediaQueryList | null = null;
  private landscapeFsVideoBound: HTMLVideoElement | null = null;
  private readonly onLandscapeOrientationMedia = (): void => this.syncLandscapeFullscreen();
  private readonly onLandscapeFsChange = (): void => this.onLandscapeNativeFullscreenChange();
  private readonly onLandscapeWebkitFsEnd = (): void => this.onLandscapeNativeFullscreenChange();

  constructor(
    private api: ApiService,
    private keycloak: KeycloakService,
    private tvPlayer: TvPlayerService,
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute,
    private translate: TranslateService
  ) {}

  get isAllCountries(): boolean {
    return (this.selectedCountry || '').toLowerCase() === 'all';
  }

  get filtersCollapsed(): boolean {
    return !!this.filtersCollapsedByMode[this.listMode];
  }

  /** True when search/group inputs are non-empty (for collapsed indicator). */
  get hasFilterInputs(): boolean {
    if (this.channelQuery.trim() || this.programQuery.trim()) {
      return true;
    }
    if (this.listMode === 'catalog' && this.selectedGroup) {
      return true;
    }
    if (this.listMode === 'arte' && this.arteSection && this.arteSection !== 'MOST_RECENT') {
      return true;
    }
    if (this.listMode === 'ia' && this.iaSection && this.iaSection !== 'RECENT') {
      return true;
    }
    return false;
  }

  get filteredCountries(): TvCountry[] {
    const q = this.countryFilter.trim().toLowerCase();
    if (!q) {
      return this.countries;
    }
    return this.countries.filter((c) => {
      const name = (c.name || '').toLowerCase();
      const code = (c.code || '').toLowerCase();
      return name.includes(q) || code.includes(q);
    });
  }

  get isLoggedIn(): boolean {
    return this.keycloak.isLoggedIn();
  }

  get isFloatingOpen(): boolean {
    return this.tvPlayer.isOpen;
  }

  get displayedChannels(): TvChannel[] {
    if (this.listMode === 'recordings') {
      return [];
    }
    if (this.listMode === 'arte' || this.listMode === 'ia') {
      // Server already filters by section / search query.
      return this.channels;
    }
    const source = this.listMode === 'favorites' ? this.favorites : this.channels;
    const channelQ = this.channelQuery.trim().toLowerCase();
    const programQ = this.programQuery.trim().toLowerCase();
    if (!channelQ && !programQ) {
      return source;
    }
    return source.filter((ch) => {
      if (channelQ && !this.matchesChannelQuery(ch, channelQ)) {
        return false;
      }
      if (programQ && !this.matchesProgramQuery(ch, programQ)) {
        return false;
      }
      return true;
    });
  }

  get activeRecording(): TvRecording | null {
    if (!this.clientRecordingActive) {
      return null;
    }
    return {
      id: 'local-recording',
      channelId: this.clientRecordChannel?.id,
      channelName: this.clientRecordChannel?.name || 'TV',
      channelLogo: this.clientRecordChannel?.logo,
      country: this.clientRecordChannel?.country,
      status: 'RUNNING',
      startedAt: new Date(this.clientRecordStartedAt).toISOString(),
      durationSec: this.recordDurationSec
    };
  }

  get supportsBrowserRecording(): boolean {
    if (typeof MediaRecorder === 'undefined') {
      return false;
    }
    const proto = HTMLVideoElement?.prototype as HTMLVideoElement & {
      captureStream?: () => MediaStream;
    };
    return typeof proto?.captureStream === 'function';
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
    if (!this.supportsBrowserRecording) {
      return 'TV.ERR_RECORD_UNAVAILABLE';
    }
    if (this.recordingStatusLoaded && this.recordingStatus?.enabled === false) {
      return 'TV.ERR_RECORD_UNAVAILABLE';
    }
    return 'TV.RECORD';
  }

  get filteredRecordings(): TvRecording[] {
    const q = this.channelQuery.trim().toLowerCase();
    if (!q) {
      return this.recordings;
    }
    return this.recordings.filter((r) => {
      const name = (r.channelName || '').toLowerCase();
      const status = (r.status || '').toLowerCase();
      return name.includes(q) || status.includes(q);
    });
  }

  /** Number of channels matching the current list mode + filters. */
  get filteredChannelCount(): number {
    return this.displayedChannels.length;
  }

  /**
   * Count shown on the « Toutes les TV » tab — always the catalog size for the
   * current country (or filtered catalog list), never the Favorites count.
   */
  get catalogTabCount(): number {
    if (this.listMode === 'favorites') {
      return this.catalogTotalCount > 0 ? this.catalogTotalCount : 0;
    }
    if (this.isAllCountries) {
      const searching =
        this.channelQuery.trim().length >= 2
        || this.programQuery.trim().length >= 2
        || !!this.selectedGroup;
      if (!searching && this.catalogTotalCount > 0) {
        return this.catalogTotalCount;
      }
      if (searching && this.searchMatchTotal != null && this.searchMatchTotal >= 0) {
        return this.searchMatchTotal;
      }
    }
    // Country catalog: prefer server total when the list is unfiltered.
    if (
      !this.isAllCountries
      && this.catalogTotalCount > 0
      && !this.channelQuery.trim()
      && !this.programQuery.trim()
      && !this.selectedGroup
    ) {
      return this.catalogTotalCount;
    }
    return this.filteredChannelCount;
  }

  /** Exact TV count shown in the list header (catalog total or search match total). */
  get listHeaderChannelCount(): number {
    if (this.isAllCountries) {
      const idle =
        !this.channelQuery.trim() && !this.programQuery.trim() && !this.selectedGroup;
      if (idle) {
        return this.catalogTotalCount > 0 ? this.catalogTotalCount : 0;
      }
      if (this.searchMatchTotal != null) {
        return this.searchMatchTotal;
      }
    }
    if (
      !this.isAllCountries
      && this.catalogTotalCount > 0
      && !this.channelQuery.trim()
      && !this.programQuery.trim()
      && !this.selectedGroup
    ) {
      return this.catalogTotalCount;
    }
    return this.filteredChannelCount;
  }

  /** True when country/group/search filters narrow the catalog list. */
  get hasActiveFilters(): boolean {
    if (this.listMode !== 'catalog') {
      return !!(this.channelQuery.trim() || this.programQuery.trim());
    }
    return !!(
      this.channelQuery.trim()
      || this.programQuery.trim()
      || this.selectedGroup
      || this.isAllCountries
    );
  }

  /** Match channel name / group / country. */
  matchesChannelQuery(channel: TvChannel, queryLower: string): boolean {
    const q = (queryLower || '').trim().toLowerCase();
    if (!q || !channel) {
      return true;
    }
    if ((channel.name || '').toLowerCase().includes(q)) {
      return true;
    }
    if ((channel.group || '').toLowerCase().includes(q)) {
      return true;
    }
    if ((channel.country || '').toLowerCase().includes(q)) {
      return true;
    }
    return false;
  }

  /** Match EPG programme via server search hits (full guide window). */
  matchesProgramQuery(channel: TvChannel, queryLower: string): boolean {
    const q = (queryLower || '').trim().toLowerCase();
    if (!q || !channel) {
      return true;
    }
    if (q.length < 2) {
      return true;
    }
    const epgId = resolveEpgChannelId(channel);
    if (epgId && this.programSearchEpgIds.has(epgLookupKey(epgId))) {
      return true;
    }
    // Fallback while search loads / for favorites without a hit yet.
    const epg = this.epgFor(channel);
    if ((epg?.now?.title || '').toLowerCase().includes(q)) {
      return true;
    }
    if ((epg?.next?.title || '').toLowerCase().includes(q)) {
      return true;
    }
    return false;
  }

  ngOnInit(): void {
    this.keepAliveOnNavigate = this.readKeepAlivePreference();
    this.channelSearchSub = this.channelSearch$
      .pipe(debounceTime(280), distinctUntilChanged())
      .subscribe(() => {
        if (this.listMode === 'arte') {
          this.artePage = 1;
          this.loadArtePrograms();
        } else if (this.listMode === 'ia') {
          this.iaPage = 1;
          this.loadIaPrograms();
        } else if (this.listMode === 'catalog' && this.isAllCountries) {
          this.loadChannels();
        } else {
          this.cdr.markForCheck();
        }
      });
    this.programSearchSub = this.programSearch$
      .pipe(debounceTime(320), distinctUntilChanged())
      .subscribe((q) => {
        this.runProgramSearch(q);
      });

    this.resumeSub = this.tvPlayer.resumeOnPage$.subscribe((channel) => {
      this.resumePagePlayback(channel);
    });
    const pending = this.tvPlayer.consumePendingResume();
    if (this.tvPlayer.isOsPipActive()) {
      // Back on the TV page while OS PiP still runs — keep one stream only.
      this.tvPlayer.detachPipHostOnly();
      this.selectedChannel =
        this.tvPlayer.osPipChannel || this.tvPlayer.snapshot.channel || this.selectedChannel;
      this.isPipActive = true;
      this.restoredLastChannel = true;
    } else if (pending) {
      this.restoredLastChannel = true;
      this.resumePagePlayback(pending);
    } else if (this.tvPlayer.isOpen && this.tvPlayer.snapshot.channel) {
      this.selectedChannel = this.tvPlayer.snapshot.channel;
      this.restoredLastChannel = true;
    }

    this.loadCountries();
    this.loadFavorites();
    this.loadTf1Status();
    this.loadRecordingCapability();
    this.loadIaTabCount();
    if (this.isLoggedIn) {
      this.loadRecordings();
    }
    // Worldwide count scans ~180 IPTV playlists — never warm it while Favorites is open
    // (it saturates the backend and makes « Chargement des favoris… » crawl).
    this.hydrateCatalogCountFromStorage();
    if (this.listMode === 'catalog') {
      this.loadCatalogCount();
      this.loadChannels();
    }
    this.epgRefreshTimer = setInterval(() => this.refreshEpg(), TvWatcherComponent.EPG_REFRESH_MS);
    if (!this.tryOpenSharedChannelFromQuery()) {
      this.restoreLastWatchedChannel();
    }
    this.setupLandscapeFullscreenWatchers();
    this.syncLandscapeFullscreen();
  }

  ngOnDestroy(): void {
    this.teardownLandscapeFullscreenWatchers();
    this.exitLandscapeFullscreen(false);
    this.clearChromeHideTimer();
    this.clearShareFeedbackTimer();
    this.clearResyncFeedbackTimer();
    this.stopRecordingsPoll();
    this.abortClientRecording(false);
    if (this.epgRefreshTimer != null) {
      clearInterval(this.epgRefreshTimer);
      this.epgRefreshTimer = null;
    }
    this.epgSub?.unsubscribe();
    this.programSearchHttpSub?.unsubscribe();
    this.guideSub?.unsubscribe();
    this.channelSearchSub?.unsubscribe();
    this.programSearchSub?.unsubscribe();
    this.channelsSub?.unsubscribe();
    this.catalogCountSub?.unsubscribe();
    this.resumeSub?.unsubscribe();
    this.lastChannelSaveSub?.unsubscribe();
    this.applyLeavePagePlaybackPolicy();
    this.destroyPlayer();
  }

  /**
   * Keep-alive ON + OS PiP active: hand the stream to a hidden shell host so PiP survives navigation.
   * Keep-alive OFF: stop page + floating playback (PiP ends with the page video).
   * Keep-alive ON without PiP: do not open the floating window — playback simply stops.
   */
  private applyLeavePagePlaybackPolicy(): void {
    if (!this.keepAliveOnNavigate) {
      if (this.tvPlayer.isOpen) {
        this.tvPlayer.close({ resumeOnPage: false });
      }
      this.tvPlayer.stopOsPip();
      this.exitPictureInPictureIfOwned();
      return;
    }
    if (this.tvPlayer.isPopoutActive || this.tvPlayer.isOpen) {
      // External pop-out or an already-open float already owns playback.
      return;
    }
    const ch = this.selectedChannel || this.tvPlayer.osPipChannel;
    const pipOwned = this.tvPlayer.isOsPipActive();
    if (!ch || this.playError || !pipOwned) {
      return;
    }
    this.persistLastWatchedChannel(ch);
    // Carrier already holds the stream + OS PiP; only register an invisible host.
    this.tvPlayer.openFloating(ch, { pipHostOnly: true });
  }

  private exitPictureInPictureIfOwned(): void {
    const video = this.videoEl?.nativeElement;
    if (video && document.pictureInPictureElement === video) {
      document.exitPictureInPicture().catch(() => undefined);
    }
  }

  /** Exit immersive landscape TV (portrait, floating handoff, or explicit dismiss). */
  exitLandscapeFullscreen(markDismissed = true): void {
    if (markDismissed && this.landscapeFullscreen) {
      this.landscapeFsUserDismissed = true;
    }
    if (!this.landscapeFullscreen && !document.body.classList.contains(TvWatcherComponent.LANDSCAPE_FS_BODY_CLASS)) {
      this.landscapeFsSuppressDismiss = true;
      this.exitOwnedNativeFullscreen();
      this.landscapeFsSuppressDismiss = false;
      return;
    }
    this.landscapeFullscreen = false;
    document.body.classList.remove(TvWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
    this.landscapeFsSuppressDismiss = true;
    this.exitOwnedNativeFullscreen();
    // fullscreenchange is sync-ish on most browsers; clear on next tick.
    setTimeout(() => {
      this.landscapeFsSuppressDismiss = false;
    }, 0);
    // Landscape used showChrome(false) (sticky). Re-arm auto-hide for portrait.
    if (this.selectedChannel) {
      this.showChrome(true);
    } else {
      this.cdr.markForCheck();
    }
  }

  @HostListener('window:orientationchange')
  @HostListener('window:resize')
  onViewportOrientationMaybeChanged(): void {
    this.syncLandscapeFullscreen();
  }

  private setupLandscapeFullscreenWatchers(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    this.landscapeOrientationMql = window.matchMedia('(orientation: landscape)');
    if (typeof this.landscapeOrientationMql.addEventListener === 'function') {
      this.landscapeOrientationMql.addEventListener('change', this.onLandscapeOrientationMedia);
    } else {
      // Safari < 14
      (this.landscapeOrientationMql as MediaQueryList & {
        addListener?: (cb: () => void) => void;
      }).addListener?.(this.onLandscapeOrientationMedia);
    }
    document.addEventListener('fullscreenchange', this.onLandscapeFsChange);
    document.addEventListener('webkitfullscreenchange', this.onLandscapeFsChange);
    this.bindLandscapeVideoFsListener(this.videoEl?.nativeElement || null);
  }

  private bindLandscapeVideoFsListener(video: HTMLVideoElement | null): void {
    if (this.landscapeFsVideoBound === video) {
      return;
    }
    if (this.landscapeFsVideoBound) {
      this.landscapeFsVideoBound.removeEventListener('webkitendfullscreen', this.onLandscapeWebkitFsEnd);
      this.landscapeFsVideoBound = null;
    }
    if (video) {
      video.addEventListener('webkitendfullscreen', this.onLandscapeWebkitFsEnd);
      this.landscapeFsVideoBound = video;
    }
  }

  private teardownLandscapeFullscreenWatchers(): void {
    if (this.landscapeOrientationMql) {
      if (typeof this.landscapeOrientationMql.removeEventListener === 'function') {
        this.landscapeOrientationMql.removeEventListener('change', this.onLandscapeOrientationMedia);
      } else {
        (this.landscapeOrientationMql as MediaQueryList & {
          removeListener?: (cb: () => void) => void;
        }).removeListener?.(this.onLandscapeOrientationMedia);
      }
      this.landscapeOrientationMql = null;
    }
    document.removeEventListener('fullscreenchange', this.onLandscapeFsChange);
    document.removeEventListener('webkitfullscreenchange', this.onLandscapeFsChange);
    this.bindLandscapeVideoFsListener(null);
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
      this.isMobileLikeViewport()
      && this.isLandscapeOrientation()
      && !!this.selectedChannel
      && !this.isFloatingOpen
      && !this.tvPlayer.isPopoutActive
      && !this.landscapeFsUserDismissed
    );
  }

  private syncLandscapeFullscreen(): void {
    if (!this.isLandscapeOrientation()) {
      this.landscapeFsUserDismissed = false;
      this.exitLandscapeFullscreen(false);
      return;
    }
    if (this.canEnterLandscapeFullscreen()) {
      this.enterLandscapeFullscreen();
      return;
    }
    if (this.landscapeFullscreen && (!this.selectedChannel || this.isFloatingOpen || this.tvPlayer.isPopoutActive)) {
      this.exitLandscapeFullscreen(false);
    }
  }

  private enterLandscapeFullscreen(): void {
    if (!this.landscapeFullscreen) {
      this.landscapeFullscreen = true;
      document.body.classList.add(TvWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
      this.showChrome(false);
      this.cdr.markForCheck();
    } else {
      document.body.classList.add(TvWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
    }
    // Best-effort native FS (often blocked without a gesture — CSS mode still covers the screen).
    void this.requestLandscapeNativeFullscreen();
  }

  private async requestLandscapeNativeFullscreen(): Promise<void> {
    const video = this.videoEl?.nativeElement;
    if (!video || this.isFloatingOpen) {
      return;
    }
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      return;
    }
    const anyVideo = video as HTMLVideoElement & {
      webkitDisplayingFullscreen?: boolean;
      webkitEnterFullscreen?: () => void;
    };
    if (anyVideo.webkitDisplayingFullscreen) {
      return;
    }
    this.landscapeFsNativeRequested = true;
    try {
      if (typeof anyVideo.webkitEnterFullscreen === 'function') {
        anyVideo.webkitEnterFullscreen();
        return;
      }
      const wrap = video.closest('.tv-video-wrap') as HTMLElement | null;
      const target = wrap || video;
      const req =
        target.requestFullscreen?.bind(target)
        || (target as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void })
            .webkitRequestFullscreen?.bind(target);
      if (req) {
        await Promise.resolve(req());
      }
    } catch {
      // CSS immersive mode remains active.
    }
  }

  private exitOwnedNativeFullscreen(): void {
    const video = this.videoEl?.nativeElement as
      | (HTMLVideoElement & { webkitDisplayingFullscreen?: boolean; webkitExitFullscreen?: () => void })
      | undefined;
    try {
      if (video?.webkitDisplayingFullscreen && typeof video.webkitExitFullscreen === 'function') {
        video.webkitExitFullscreen();
      }
    } catch {
      /* ignore */
    }
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    const fsEl = document.fullscreenElement || doc.webkitFullscreenElement;
    if (!fsEl) {
      this.landscapeFsNativeRequested = false;
      return;
    }
    const wrap = video?.closest('.tv-video-wrap');
    const owned = this.landscapeFsNativeRequested || fsEl === video || (!!wrap && (fsEl === wrap || wrap.contains(fsEl)));
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
    const video = this.videoEl?.nativeElement as
      | (HTMLVideoElement & { webkitDisplayingFullscreen?: boolean })
      | undefined;
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const fsEl = document.fullscreenElement || doc.webkitFullscreenElement || null;
    const wrap = video?.closest('.tv-video-wrap');
    const ours = !!(
      video?.webkitDisplayingFullscreen
      || (fsEl && (fsEl === video || (wrap && (fsEl === wrap || wrap.contains(fsEl)))))
    );
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
    // User left native FS while still landscape → don't auto-reenter until portrait.
    if (this.isLandscapeOrientation() && this.landscapeFullscreen) {
      this.exitLandscapeFullscreen(true);
    }
  }

  setKeepAliveOnNavigate(enabled: boolean): void {
    this.keepAliveOnNavigate = !!enabled;
    this.writeKeepAlivePreference(this.keepAliveOnNavigate);
    this.cdr.markForCheck();
  }

  private readKeepAlivePreference(): boolean {
    try {
      const raw = localStorage.getItem(TvWatcherComponent.KEEP_ALIVE_STORAGE_KEY);
      if (raw === null) {
        return true;
      }
      return raw === '1' || raw === 'true';
    } catch {
      return true;
    }
  }

  private writeKeepAlivePreference(enabled: boolean): void {
    try {
      localStorage.setItem(TvWatcherComponent.KEEP_ALIVE_STORAGE_KEY, enabled ? '1' : '0');
    } catch {
      /* private mode / quota */
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    let changed = false;
    let closedOverlay = false;
    if (this.shareMenuOpen && !target?.closest?.('.tv-share-wrap')) {
      this.shareMenuOpen = false;
      changed = true;
      closedOverlay = true;
    }
    if (this.countryMenuOpen && !target?.closest?.('.tv-country-picker')) {
      this.countryMenuOpen = false;
      changed = true;
    }
    if (changed) {
      this.cdr.markForCheck();
    }
    if (closedOverlay) {
      this.scheduleChromeHide();
    }
  }

  onTvPointerEnter(): void {
    // Touch devices fire synthetic mouseenter that would keep the chrome sticky.
    if (this.isMobileLikeViewport()) {
      return;
    }
    this.showChrome(true);
  }

  onTvPointerMove(): void {
    if (this.isMobileLikeViewport()) {
      return;
    }
    if (!this.chromeVisible) {
      this.showChrome(true);
    } else {
      this.scheduleChromeHide();
    }
  }

  onTvPointerLeave(): void {
    if (this.isMobileLikeViewport()) {
      return;
    }
    this.scheduleChromeHide(800);
  }

  /** Mobile: tap the TV to show controls, then auto-hide after 2s. */
  onTvTouchStart(event?: TouchEvent): void {
    const target = event?.target as HTMLElement | null;
    // Touches on interactive chrome controls already keep the bar via their handlers.
    if (target?.closest?.('.tv-now-action, .tv-volume-slider-wrap, .tv-record-duration, .tv-share-wrap, .tv-keep-alive, .tv-epg-guide-toggle, .tv-epg-guide, a, button, input, select, label')) {
      this.scheduleChromeHide();
      return;
    }
    this.showChrome(true);
  }

  private showChrome(scheduleHide: boolean): void {
    this.chromeVisible = true;
    this.cdr.detectChanges();
    if (scheduleHide) {
      this.scheduleChromeHide();
    } else {
      this.clearChromeHideTimer();
    }
  }

  private scheduleChromeHide(delayMs = TvWatcherComponent.CHROME_HIDE_MS): void {
    this.clearChromeHideTimer();
    // Keep the bar while the share menu / EPG guide is open.
    if (!this.selectedChannel || this.shareMenuOpen || this.guideOpen) {
      return;
    }
    this.chromeHideTimer = setTimeout(() => {
      this.chromeHideTimer = null;
      if (this.shareMenuOpen || this.guideOpen || !this.selectedChannel) {
        return;
      }
      this.hideChrome();
    }, delayMs);
  }

  /** Hide player chrome without leaving focus inside an aria-hidden ancestor. */
  private hideChrome(): void {
    if (!this.chromeVisible) {
      return;
    }
    this.blurFocusInsideChrome();
    this.chromeVisible = false;
    this.cdr.detectChanges();
  }

  private blurFocusInsideChrome(): void {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (!(active instanceof HTMLElement)) {
      return;
    }
    if (active.closest('.tv-chrome, .tv-program-panel')) {
      active.blur();
    }
  }

  private clearChromeHideTimer(): void {
    if (this.chromeHideTimer != null) {
      clearTimeout(this.chromeHideTimer);
      this.chromeHideTimer = null;
    }
  }

  setListMode(mode: TvListMode): void {
    this.listMode = mode;
    this.channelsError = '';
    this.favoritesHint = '';
    this.recordingsHint = '';
    this.arteError = '';
    this.iaError = '';
    this.countryMenuOpen = false;
    if (mode === 'favorites' && !this.isLoggedIn) {
      this.favoritesHint = 'TV.FAVORITES_LOGIN';
    }
    if (mode === 'recordings') {
      if (!this.isLoggedIn) {
        this.recordingsHint = 'TV.RECORD_LOGIN';
      } else {
        this.loadRecordings();
      }
    }
    if (mode === 'catalog') {
      this.loadCatalogCount();
      // Always reload: channels may still hold ARTE programmes from the replay tab.
      this.loadChannels();
      if (!this.filtersCollapsed && this.isAllCountries && !this.groups.length) {
        this.ensureWorldwideGroups();
      }
    }
    if (mode === 'arte') {
      this.channelQuery = '';
      this.programQuery = '';
      if (!this.arteSections.length) {
        this.loadArteSections();
      }
      this.loadArtePrograms();
    }
    if (mode === 'ia') {
      this.channelQuery = '';
      this.programQuery = '';
      if (!this.iaSections.length) {
        this.loadIaSections();
      }
      this.loadIaPrograms();
    }
    this.refreshEpg();
    if (mode !== 'arte' && mode !== 'ia' && this.programQuery.trim().length >= 2) {
      this.runProgramSearch(this.programQuery.trim().toLowerCase());
    }
    this.cdr.markForCheck();
  }

  toggleFiltersCollapsed(event?: Event): void {
    event?.stopPropagation();
    this.filtersCollapsedByMode[this.listMode] = !this.filtersCollapsedByMode[this.listMode];
    if (this.filtersCollapsed) {
      this.countryMenuOpen = false;
    } else if (this.listMode === 'catalog' && this.isAllCountries) {
      this.ensureWorldwideGroups();
    }
    this.cdr.markForCheck();
  }

  onCountryChange(): void {
    this.selectedGroup = '';
    this.groups = [];
    this.worldwideSearchHint = false;
    this.countryMenuOpen = false;
    this.loadCatalogCount();
    this.loadChannels();
    if (this.programQuery.trim().length >= 2) {
      this.runProgramSearch(this.programQuery.trim().toLowerCase());
    }
  }

  toggleCountryMenu(event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    this.countryMenuOpen = !this.countryMenuOpen;
    this.shareMenuOpen = false;
    if (this.countryMenuOpen) {
      this.countryFilter = '';
    }
    this.cdr.markForCheck();
  }

  selectCountry(code: string, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    this.selectedCountry = code || 'all';
    this.countryFilter = '';
    this.onCountryChange();
  }

  /** ISO code for flag-icons CSS ({@code fi fi-xx}). */
  countryFlagCode(code: string | null | undefined): string {
    const c = (code || '').trim().toLowerCase();
    if (!c || c === 'all' || c === '*') {
      return '';
    }
    // flag-icons uses "gb" for UK; keep catalog codes as-is otherwise.
    return c === 'uk' ? 'gb' : c;
  }

  selectedCountryName(): string {
    if (this.isAllCountries) {
      return this.translate.instant('TV.COUNTRY_ALL');
    }
    const found = this.countries.find(
      (x) => (x.code || '').toLowerCase() === (this.selectedCountry || '').toLowerCase()
    );
    return found?.name || (this.selectedCountry || '').toUpperCase();
  }

  onGroupChange(): void {
    this.loadChannels();
  }

  onChannelSearchInput(value: string): void {
    this.channelQuery = value;
    this.channelSearch$.next(value.trim().toLowerCase());
  }

  onProgramSearchInput(value: string): void {
    this.programQuery = value;
    this.programSearch$.next(value.trim().toLowerCase());
  }

  clearChannelSearch(): void {
    this.channelQuery = '';
    this.worldwideSearchHint = false;
    this.channelSearch$.next('');
  }

  clearProgramSearch(): void {
    this.programQuery = '';
    this.clearProgramSearchState();
    this.programSearch$.next('');
    if (this.listMode === 'catalog' && this.isAllCountries && !this.channelQuery.trim()) {
      this.loadChannels();
    }
  }

  /** Matched programme title from server search for list hints. */
  programSearchTitle(channel: TvChannel | null | undefined): string {
    if (!channel || !this.programQuery.trim()) {
      return '';
    }
    const epgId = resolveEpgChannelId(channel);
    if (!epgId) {
      return '';
    }
    const key = epgLookupKey(epgId);
    const hit = this.programSearchHits.find((h) => epgLookupKey(h.channelId) === key);
    return (hit?.programme?.title || '').trim();
  }

  /** Label + title shown under each channel in the sidebar. */
  channelListEpgLine(channel: TvChannel | null | undefined): { labelKey: string; title: string } | null {
    const hit = this.programSearchTitle(channel);
    if (hit) {
      return { labelKey: 'TV.SEARCH_PROGRAM', title: hit };
    }
    const now = this.epgNowTitle(channel);
    if (now) {
      return { labelKey: 'TV.EPG_NOW', title: now };
    }
    return null;
  }

  toggleGuide(): void {
    if (this.guideOpen) {
      this.closeGuide();
      return;
    }
    this.guideOpen = true;
    this.showChrome(true);
    this.loadGuideSchedule();
  }

  closeGuide(): void {
    this.guideOpen = false;
    this.guideError = '';
    this.guideSub?.unsubscribe();
    this.scheduleChromeHide();
    this.cdr.markForCheck();
  }

  openEpgBrowser(): void {
    this.epgBrowserOpen = true;
    this.shareMenuOpen = false;
    this.countryMenuOpen = false;
    this.cdr.markForCheck();
  }

  closeEpgBrowser(): void {
    this.epgBrowserOpen = false;
    this.cdr.markForCheck();
  }

  onEpgBrowserPlay(channel: TvChannel): void {
    if (!channel) {
      return;
    }
    this.closeEpgBrowser();
    this.selectChannel(channel);
  }

  isProgrammeLive(programme: TvEpgProgramme | null | undefined): boolean {
    if (!programme?.start || !programme?.stop) {
      return false;
    }
    const start = new Date(programme.start).getTime();
    const stop = new Date(programme.stop).getTime();
    const now = Date.now();
    return !Number.isNaN(start) && !Number.isNaN(stop) && start <= now && now < stop;
  }

  formatEpgDay(iso: string | null | undefined): string {
    if (!iso) {
      return '';
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return '';
    }
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  private loadGuideSchedule(): void {
    const channel = this.selectedChannel;
    const epgId = resolveEpgChannelId(channel);
    if (!channel || !epgId) {
      this.guideProgrammes = [];
      this.guideError = 'TV.EPG_GUIDE_EMPTY';
      this.isLoadingGuide = false;
      this.cdr.markForCheck();
      return;
    }
    let cc = (channel.country || this.selectedCountry || 'fr').toLowerCase();
    if (!cc || cc === 'all' || cc.length !== 2) {
      cc = 'fr';
    }
    this.guideSub?.unsubscribe();
    this.isLoadingGuide = true;
    this.guideError = '';
    this.guideSub = this.api.getTvEpgSchedule(cc, epgId).subscribe({
      next: (schedule) => {
        this.guideProgrammes = schedule?.programmes || [];
        this.isLoadingGuide = false;
        if (!this.guideProgrammes.length) {
          this.guideError = 'TV.EPG_GUIDE_EMPTY';
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.guideProgrammes = [];
        this.isLoadingGuide = false;
        this.guideError = 'TV.EPG_GUIDE_ERROR';
        this.cdr.markForCheck();
      }
    });
  }

  private clearProgramSearchState(): void {
    this.programSearchHits = [];
    this.programSearchEpgIds = new Set();
    this.isLoadingProgramSearch = false;
    this.programSearchHttpSub?.unsubscribe();
  }

  private runProgramSearch(queryLower: string): void {
    const q = (queryLower || '').trim();
    if (q.length < 2) {
      this.clearProgramSearchState();
      if (this.listMode === 'catalog' && this.isAllCountries && !this.channelQuery.trim()) {
        this.channels = [];
        this.worldwideSearchHint = true;
        this.isLoadingChannels = false;
      }
      this.cdr.markForCheck();
      return;
    }

    const country =
      this.listMode === 'favorites'
        ? 'all'
        : this.isAllCountries
          ? 'all'
          : (this.selectedCountry || 'fr');

    this.programSearchHttpSub?.unsubscribe();
    this.isLoadingProgramSearch = true;
    this.worldwideSearchHint = false;
    this.cdr.markForCheck();

    this.programSearchHttpSub = this.api.getTvEpgSearch(country, q, 50).subscribe({
      next: (hits) => {
        this.programSearchHits = hits || [];
        const ids = new Set<string>();
        for (const hit of this.programSearchHits) {
          const id = epgLookupKey(hit.channelId);
          if (id) {
            ids.add(id);
          }
        }
        this.programSearchEpgIds = ids;
        this.isLoadingProgramSearch = false;

        if (this.listMode === 'catalog' && this.isAllCountries && !this.channelQuery.trim()) {
          if (!this.selectedGroup) {
            this.applyWorldwideProgramHits(this.programSearchHits);
          }
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.programSearchHits = [];
        this.programSearchEpgIds = new Set();
        this.isLoadingProgramSearch = false;
        if (this.listMode === 'catalog' && this.isAllCountries && !this.channelQuery.trim()) {
          this.channels = [];
        }
        this.cdr.markForCheck();
      }
    });
  }

  /** Build the worldwide channel list from EPG search hits that include catalog channels. */
  private applyWorldwideProgramHits(hits: TvEpgSearchHit[]): void {
    const seen = new Set<string>();
    const merged: TvChannel[] = [];
    for (const hit of hits || []) {
      const ch = hit.channel;
      if (!ch) {
        continue;
      }
      const key = (ch.id || ch.streamUrl || ch.name || '').toLowerCase();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(ch);
    }
    this.channels = this.sortChannelsByName(merged);
    this.searchMatchTotal = merged.length;
    this.searchListTruncated = false;
    this.isLoadingChannels = false;
    this.applyPendingShareChannel();
    this.refreshEpg();
  }

  countryLabel(code: string | null | undefined): string {
    const c = (code || '').trim().toLowerCase();
    if (!c) {
      return '';
    }
    const found = this.countries.find((x) => (x.code || '').toLowerCase() === c);
    if (found) {
      return found.name;
    }
    return c.toUpperCase();
  }

  /** Country code for a list row (channel field, else current country filter when not worldwide). */
  channelCountryCode(ch: TvChannel | null | undefined): string {
    const fromCh = (ch?.country || '').trim().toLowerCase();
    if (fromCh && fromCh !== 'all') {
      return fromCh;
    }
    if (!this.isAllCountries) {
      const sel = (this.selectedCountry || '').trim().toLowerCase();
      if (sel && sel !== 'all') {
        return sel;
      }
    }
    return '';
  }

  selectChannel(channel: TvChannel): void {
    this.selectedChannel = channel;
    this.playError = '';
    this.isBuffering = true;
    this.franceTvTokenRefreshAttempted = false;
    this.showChrome(true);
    this.persistLastWatchedChannel(channel);
    // Leave ARTE / IA replay list when switching to a live catalog channel.
    if (this.listMode === 'arte' && !this.isArteChannel(channel)) {
      this.listMode = 'catalog';
      this.loadChannels();
    }
    if (this.listMode === 'ia' && !this.usesInternetArchive(channel)) {
      this.listMode = 'catalog';
      this.loadChannels();
    }
    if (!this.epgFor(channel)) {
      this.refreshEpg();
    }
    if (this.guideOpen) {
      this.loadGuideSchedule();
    }
    // If floating window is already open, switch channel there and keep navigating freely.
    if (this.tvPlayer.isOpen) {
      this.destroyPlayer();
      this.isBuffering = false;
      this.tvPlayer.setChannel(channel);
      this.exitLandscapeFullscreen(false);
      this.cdr.detectChanges();
      return;
    }
    this.cdr.detectChanges();
    this.playChannel(channel);
    this.syncLandscapeFullscreen();
  }

  /** Detach playback into a floating window that survives route changes. */
  openInFloatingWindow(channel?: TvChannel | null): void {
    const ch = channel || this.selectedChannel;
    if (!ch) {
      this.playError = 'TV.FLOAT_NEED_CHANNEL';
      return;
    }
    this.destroyPlayer();
    this.isBuffering = false;
    this.playError = '';
    this.selectedChannel = ch;
    this.persistLastWatchedChannel(ch);
    this.tvPlayer.openFloating(ch);
    this.exitLandscapeFullscreen(false);
    this.cdr.markForCheck();
  }

  closeFloatingWindow(): void {
    this.tvPlayer.close();
    this.syncLandscapeFullscreen();
  }

  openExternalWindow(channel?: TvChannel | null): void {
    const ch = channel || this.selectedChannel;
    if (!ch) {
      this.playError = 'TV.FLOAT_NEED_CHANNEL';
      return;
    }
    this.destroyPlayer();
    this.isBuffering = false;
    this.playError = '';
    this.selectedChannel = ch;
    this.persistLastWatchedChannel(ch);
    this.tvPlayer.openExternalWindow(ch);
    this.cdr.markForCheck();
  }

  async togglePictureInPicture(): Promise<void> {
    const video = this.videoEl?.nativeElement;
    if (!video || !this.pipSupported || !this.selectedChannel) {
      return;
    }
    // Floating UI owns playback unless we are only hosting OS PiP keep-alive.
    if (this.isFloatingOpen && !this.tvPlayer.isOsPipActive()) {
      return;
    }
    try {
      if (this.tvPlayer.isOsPipActive()) {
        const returned = await this.tvPlayer.exitOsPipToPage(video);
        this.hls = returned.hls;
        this.detachHlsLiveSync = returned.detachLiveSync;
        this.isPipActive = false;
        this.cdr.markForCheck();
        return;
      }
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
        this.isPipActive = false;
        this.cdr.markForCheck();
        return;
      }
      // Move HLS/native playback onto a body-level carrier so PiP survives route changes.
      const hls = this.hls;
      const detach = this.detachHlsLiveSync;
      this.hls = null;
      this.detachHlsLiveSync = null;
      try {
        await this.tvPlayer.enterOsPipFromPage({
          channel: this.selectedChannel,
          pageVideo: video,
          hls,
          detachLiveSync: detach,
          labels: {
            fullscreen: this.translate.instant('TV.POPOUT_FULLSCREEN'),
            fullscreenExit: this.translate.instant('TV.POPOUT_FULLSCREEN_EXIT'),
            close: this.translate.instant('TV.PIP_EXIT')
          }
        });
        this.isPipActive = true;
        this.cdr.markForCheck();
      } catch (err) {
        try {
          const returned = await this.tvPlayer.exitOsPipToPage(video);
          this.hls = returned.hls ?? hls;
          this.detachHlsLiveSync = returned.detachLiveSync ?? detach;
          if (!returned.hls && this.hls) {
            this.hls.attachMedia(video);
          }
          await video.play().catch(() => undefined);
        } catch {
          this.hls = hls;
          this.detachHlsLiveSync = detach;
        }
        throw err;
      }
    } catch {
      this.playError = 'TV.ERR_PIP';
      this.showChrome(true);
      this.cdr.markForCheck();
    }
  }

  @HostListener('document:enterpictureinpicture')
  onEnterPip(): void {
    this.isPipActive =
      this.tvPlayer.isOsPipActive() ||
      document.pictureInPictureElement === this.videoEl?.nativeElement;
    this.cdr.markForCheck();
  }

  @HostListener('document:leavepictureinpicture', ['$event'])
  onLeavePip(event: Event): void {
    const left = event?.target as Node | null;
    const pageVideo = this.videoEl?.nativeElement;
    this.isPipActive = false;
    // Carrier leave is owned by TvPlayerService (stop + single resume) — do not start a 2nd stream.
    if (left && pageVideo && left !== pageVideo) {
      this.cdr.markForCheck();
      return;
    }
    if (this.tvPlayer.isOsPipActive()) {
      this.cdr.markForCheck();
      return;
    }
    // Classic in-page video left PiP — resume if needed.
    if (!this.isFloatingOpen && this.selectedChannel) {
      const video = pageVideo;
      if (video?.src || this.hls) {
        video?.play().catch(() => {
          this.resumePagePlayback(this.selectedChannel!);
        });
      } else {
        this.resumePagePlayback(this.selectedChannel);
      }
    }
    this.cdr.markForCheck();
  }

  /** Resume HLS on the page player after floating / pop-out / PiP ends. */
  private resumePagePlayback(channel: TvChannel | null | undefined): void {
    if (!channel || this.tvPlayer.isOpen || this.tvPlayer.isOsPipActive()) {
      return;
    }
    this.tvPlayer.clearPendingResume();
    this.selectedChannel = channel;
    this.persistLastWatchedChannel(channel);
    this.playError = '';
    this.isBuffering = true;
    this.showChrome(true);
    this.cdr.detectChanges();
    setTimeout(() => {
      if (
        !this.tvPlayer.isOpen &&
        !this.tvPlayer.isOsPipActive() &&
        this.selectedChannel?.id === channel.id
      ) {
        this.playChannel(channel);
        this.syncLandscapeFullscreen();
      }
    }, 0);
  }

  private restoreLastWatchedChannel(): void {
    if (this.restoredLastChannel || this.selectedChannel || this.tvPlayer.isOpen) {
      return;
    }
    const apply = (channel: TvChannel | null | undefined) => {
      if (this.restoredLastChannel || this.selectedChannel || this.tvPlayer.isOpen) {
        return;
      }
      if (!channel?.name || (!channel.streamUrl && !channel.id)) {
        return;
      }
      this.restoredLastChannel = true;
      const normalized: TvChannel = {
        ...channel,
        streamUrl: resolveTvStreamUrl(channel)
      };
      // Keep catalog country filter on its default (« Tous les pays »);
      // restoring playback must not switch the sidebar filter to the channel country.
      this.selectChannel(normalized);
    };

    if (this.isLoggedIn) {
      this.api.getTvLastChannel().subscribe({
        next: (channel) => {
          if (channel) {
            apply(channel);
            return;
          }
          apply(this.readLastChannelFromStorage());
        },
        error: () => apply(this.readLastChannelFromStorage())
      });
      return;
    }
    apply(this.readLastChannelFromStorage());
  }

  private persistLastWatchedChannel(channel: TvChannel | null | undefined): void {
    if (!channel?.name || (!channel.streamUrl && !channel.id)) {
      return;
    }
    const payload: TvChannel = {
      ...channel,
      streamUrl: resolveTvStreamUrl(channel)
    };
    this.writeLastChannelToStorage(payload);
    if (!this.isLoggedIn) {
      return;
    }
    this.lastChannelSaveSub?.unsubscribe();
    this.lastChannelSaveSub = this.api.saveTvLastChannel(payload).subscribe({
      error: () => { /* localStorage already updated */ }
    });
  }

  private readLastChannelFromStorage(): TvChannel | null {
    try {
      const raw = localStorage.getItem(TvWatcherComponent.LAST_CHANNEL_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as TvChannel;
      if (!parsed?.name || (!parsed.streamUrl && !parsed.id)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private writeLastChannelToStorage(channel: TvChannel): void {
    try {
      localStorage.setItem(TvWatcherComponent.LAST_CHANNEL_STORAGE_KEY, JSON.stringify(channel));
    } catch {
      /* private mode */
    }
  }

  isFavorite(channel: TvChannel): boolean {
    return !!channel?.id && this.favoriteIds.has(channel.id);
  }

  /** True when this channel is played via the official france.tv live workaround. */
  usesFranceTvWorkaround(channel: TvChannel | null | undefined): boolean {
    return isFranceTvVirtual(resolveTvStreamUrl(channel));
  }

  /** True when this channel is played via the official TF1 mediainfo workaround. */
  usesTf1Workaround(channel: TvChannel | null | undefined): boolean {
    return isTf1Virtual(resolveTvStreamUrl(channel));
  }

  /** True when this channel is played via Canal group (CNews/CStar) Dailymotion live. */
  usesCanalGroupWorkaround(channel: TvChannel | null | undefined): boolean {
    return isCanalGroupVirtual(resolveTvStreamUrl(channel));
  }

  /** True when this channel is played via Radio France official HLS. */
  usesRadioFranceWorkaround(channel: TvChannel | null | undefined): boolean {
    return isRadioFranceVirtual(resolveTvStreamUrl(channel));
  }

  /** True when M6 / W9 / 6ter / Gulli use public IPTV mirror probe (official is DRM). */
  usesM6GroupWorkaround(channel: TvChannel | null | undefined): boolean {
    return isM6GroupVirtual(resolveTvStreamUrl(channel));
  }

  /** True when this item is an ARTE replay / live virtual stream. */
  usesArteReplay(channel: TvChannel | null | undefined): boolean {
    return isArteVirtual(resolveTvStreamUrl(channel));
  }

  /** True when this item is an Internet Archive movie virtual stream. */
  usesInternetArchive(channel: TvChannel | null | undefined): boolean {
    return isInternetArchiveVirtual(resolveTvStreamUrl(channel));
  }

  /** Show ARTE Replay tab only while watching an ARTE channel (live IPTV or arte: stream). */
  get showArteReplayTab(): boolean {
    return this.isArteChannel(this.selectedChannel);
  }

  isArteChannel(channel: TvChannel | null | undefined): boolean {
    if (!channel) {
      return false;
    }
    if (this.usesArteReplay(channel)) {
      return true;
    }
    if ((channel.country || '').trim().toLowerCase() === 'arte') {
      return true;
    }
    const name = (channel.name || '').trim().toLowerCase();
    // ARTE, ARTE HD, ARTE FHD, ARTE (1080p), …
    if (/^arte(\b|[\s\-_.(]|hd|fhd|sd|uhd|4k)/i.test(name)) {
      return true;
    }
    const url = (channel.streamUrl || '').toLowerCase();
    return url.includes('arte.tv') || url.includes('arte:');
  }

  usesOfficialWorkaround(channel: TvChannel | null | undefined): boolean {
    return this.usesFranceTvWorkaround(channel)
      || this.usesTf1Workaround(channel)
      || this.usesCanalGroupWorkaround(channel)
      || this.usesRadioFranceWorkaround(channel)
      || this.usesM6GroupWorkaround(channel)
      || this.usesArteReplay(channel)
      || this.usesInternetArchive(channel);
  }

  workaroundBadgeKey(channel: TvChannel | null | undefined): string {
    if (this.usesInternetArchive(channel)) {
      return 'TV.WORKAROUND_BADGE_IA';
    }
    if (this.usesArteReplay(channel)) {
      return 'TV.WORKAROUND_BADGE_ARTE';
    }
    if (this.usesTf1Workaround(channel)) {
      return 'TV.WORKAROUND_BADGE_TF1';
    }
    if (this.usesCanalGroupWorkaround(channel)) {
      return 'TV.WORKAROUND_BADGE_CANAL';
    }
    if (this.usesRadioFranceWorkaround(channel)) {
      return 'TV.WORKAROUND_BADGE_RADIO';
    }
    if (this.usesM6GroupWorkaround(channel)) {
      return 'TV.WORKAROUND_BADGE_M6';
    }
    return 'TV.WORKAROUND_BADGE';
  }

  workaroundHintKey(channel: TvChannel | null | undefined): string {
    if (this.usesInternetArchive(channel)) {
      return 'TV.WORKAROUND_HINT_IA';
    }
    if (this.usesArteReplay(channel)) {
      return 'TV.WORKAROUND_HINT_ARTE';
    }
    if (this.usesTf1Workaround(channel)) {
      return 'TV.WORKAROUND_HINT_TF1';
    }
    if (this.usesCanalGroupWorkaround(channel)) {
      return 'TV.WORKAROUND_HINT_CANAL';
    }
    if (this.usesRadioFranceWorkaround(channel)) {
      return 'TV.WORKAROUND_HINT_RADIO';
    }
    if (this.usesM6GroupWorkaround(channel)) {
      return 'TV.WORKAROUND_HINT_M6';
    }
    return 'TV.WORKAROUND_HINT';
  }

  workaroundActiveKey(channel: TvChannel | null | undefined): string {
    if (this.usesInternetArchive(channel)) {
      return 'TV.WORKAROUND_ACTIVE_IA';
    }
    if (this.usesArteReplay(channel)) {
      return 'TV.WORKAROUND_ACTIVE_ARTE';
    }
    if (this.usesTf1Workaround(channel)) {
      return 'TV.WORKAROUND_ACTIVE_TF1';
    }
    if (this.usesCanalGroupWorkaround(channel)) {
      return 'TV.WORKAROUND_ACTIVE_CANAL';
    }
    if (this.usesRadioFranceWorkaround(channel)) {
      return 'TV.WORKAROUND_ACTIVE_RADIO';
    }
    if (this.usesM6GroupWorkaround(channel)) {
      return 'TV.WORKAROUND_ACTIVE_M6';
    }
    return 'TV.WORKAROUND_ACTIVE';
  }

  toggleFavorite(channel: TvChannel, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    if (!channel?.id) {
      return;
    }
    if (!this.isLoggedIn) {
      this.favoritesHint = 'TV.FAVORITES_LOGIN';
      this.cdr.markForCheck();
      return;
    }
    if (this.favoriteBusyId) {
      return;
    }
    this.favoritesHint = '';
    this.favoritesError = '';
    this.favoriteBusyId = channel.id;
    const removing = this.isFavorite(channel);
    const payload: TvChannel = {
      ...channel,
      streamUrl: resolveTvStreamUrl(channel)
    };
    const req$ = removing
      ? this.api.removeTvFavorite(channel.id)
      : this.api.addTvFavorite(payload);

    req$.subscribe({
      next: (fav) => {
        this.applyFavorites(fav?.channels || []);
        this.favoriteBusyId = '';
        this.cdr.markForCheck();
      },
      error: () => {
        this.favoriteBusyId = '';
        this.favoritesError = 'TV.ERR_FAVORITES_SAVE';
        this.cdr.markForCheck();
      }
    });
  }

  toggleShareMenu(event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    if (!this.selectedChannel) {
      return;
    }
    this.shareMenuOpen = !this.shareMenuOpen;
    this.shareFeedback = '';
    if (this.shareMenuOpen) {
      this.showChrome(false);
    }
    this.cdr.markForCheck();
  }

  async shareViaNative(event?: Event): Promise<void> {
    event?.stopPropagation();
    event?.preventDefault();
    const channel = this.selectedChannel;
    if (!channel) {
      return;
    }
    const { title, text, url } = this.buildSharePayload(channel);
    const nav = navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>;
    };
    if (typeof nav.share !== 'function') {
      return;
    }
    try {
      // Put the URL in `text` as well: many targets (WhatsApp) ignore `url` and only send text.
      await nav.share({ title, text, url });
      this.shareMenuOpen = false;
      this.cdr.markForCheck();
    } catch (err) {
      const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
      if (name === 'AbortError') {
        return;
      }
      await this.shareViaWhatsApp(event);
    }
  }

  async shareViaWhatsApp(event?: Event): Promise<void> {
    event?.stopPropagation();
    event?.preventDefault();
    const channel = this.selectedChannel;
    if (!channel) {
      return;
    }
    // URL first on its own line — WhatsApp linkifies more reliably than trailing URLs.
    const { text } = this.buildSharePayload(channel, { urlFirst: true });
    window.open(
      `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`,
      '_blank',
      'noopener,noreferrer'
    );
    this.shareMenuOpen = false;
    this.cdr.markForCheck();
  }

  async shareCopyLink(event?: Event): Promise<void> {
    event?.stopPropagation();
    event?.preventDefault();
    const channel = this.selectedChannel;
    if (!channel) {
      return;
    }
    const url = this.buildShareDeepLink(channel);
    const ok = await this.copyTextToClipboard(url);
    this.shareFeedback = ok ? 'TV.SHARE_COPIED' : 'TV.SHARE_COPY_FAILED';
    this.shareMenuOpen = false;
    this.clearShareFeedbackTimer();
    this.shareFeedbackTimer = setTimeout(() => {
      this.shareFeedback = '';
      this.shareFeedbackTimer = null;
      this.cdr.markForCheck();
    }, 2500);
    this.cdr.markForCheck();
  }

  trackByChannelId(_: number, ch: TvChannel): string {
    return ch.id;
  }

  /** Display play errors: translate {@code TV.*} keys, show API/backend text as-is. */
  formatPlayError(message: string | null | undefined): string {
    return formatTvPlayErrorDisplay(message, (key) => this.translate.instant(key));
  }

  groupIconClass(group: string | null | undefined): string {
    return groupIconFaClass(group);
  }

  groupEmoji(group: string | null | undefined): string {
    return groupIconEmoji(group);
  }

  /**
   * ngx-translate key for known categories, otherwise the raw API name
   * (pipe falls back to the string itself when no key exists).
   */
  groupLabelKey(group: string | null | undefined): string {
    const raw = (group || '').trim();
    if (!raw) {
      return 'TV.GROUP_ALL';
    }
    return groupI18nKey(raw) || raw;
  }

  /**
   * Opens a channel from {@code ?ch=&c=&n=&s=} (shared link via {@code tv-link.html}).
   * @returns true if a share deep-link was handled (skip last-channel restore).
   */
  private tryOpenSharedChannelFromQuery(): boolean {
    const p = this.route.snapshot.queryParamMap;
    const id = (p.get('ch') || '').trim();
    const stream = (p.get('s') || '').trim();
    const name = (p.get('n') || '').trim();
    const country = (p.get('c') || '').trim().toLowerCase();
    if (!id && !stream) {
      return false;
    }
    if (country) {
      this.selectedCountry = country;
    }
    const draft: TvChannel = {
      id: id || `shared-${(stream || name || 'tv').slice(0, 48)}`,
      name: name || id || 'TV',
      country: country || this.selectedCountry,
      streamUrl: stream || '',
      group: '',
      logo: undefined,
      quality: undefined
    };
    draft.streamUrl = resolveTvStreamUrl(draft) || stream;
    if (draft.streamUrl) {
      this.restoredLastChannel = true;
      this.selectChannel(draft);
      return true;
    }
    if (id) {
      this.pendingShareChannelId = id;
      this.restoredLastChannel = true;
      return true;
    }
    return false;
  }

  private applyPendingShareChannel(): void {
    const id = this.pendingShareChannelId;
    if (!id || this.selectedChannel) {
      return;
    }
    const found = this.channels.find((ch) => ch.id === id)
      || this.favorites.find((ch) => ch.id === id);
    if (!found) {
      return;
    }
    this.pendingShareChannelId = '';
    this.selectChannel({
      ...found,
      streamUrl: resolveTvStreamUrl(found)
    });
  }

  /**
   * Shareable URL without hash in the path (WhatsApp-friendly), via static redirect page.
   * Keep the query short and free of nested http(s) — messengers then auto-link reliably.
   */
  private buildShareDeepLink(channel: TvChannel): string {
    const u = new URL(window.location.href);
    let path = u.pathname || '/';
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    const marker = '/assets/tv-link.html';
    const at = path.indexOf(marker);
    let basePath: string;
    if (at >= 0) {
      basePath = path.substring(0, at);
    } else if (path === '/') {
      basePath = '';
    } else if (path.endsWith('/index.html')) {
      basePath = path.slice(0, -'/index.html'.length);
      if (basePath === '/') {
        basePath = '';
      }
    } else {
      // Hash-routed SPA: pathname is the deploy base (e.g. /pattool), not the Angular route.
      basePath = path;
    }
    const params = new URLSearchParams();
    if (channel.id) {
      params.set('ch', channel.id);
    }
    const country = (channel.country || this.selectedCountry || '').trim();
    if (country) {
      params.set('c', country);
    }
    const name = (channel.name || '').trim();
    if (name && name.length <= 80) {
      params.set('n', name);
    }
    // Only short virtual tokens (francetv:…, tf1:…). Full http(s) stream URLs nested in
    // ?s= break WhatsApp / iMessage auto-link (they see a second https inside the query).
    const stream = resolveTvStreamUrl(channel);
    if (stream && TvWatcherComponent.isShareSafeStreamToken(stream)) {
      params.set('s', stream);
    }
    // Prefer %20 over + — some messengers stop linkifying at +.
    const qs = params.toString().replace(/\+/g, '%20');
    return `${u.origin}${basePath}/assets/tv-link.html?${qs}`;
  }

  /**
   * True for short non-URL stream tokens safe to put in a WhatsApp share link.
   * Rejects anything that looks like http(s):// (even encoded).
   */
  private static isShareSafeStreamToken(stream: string): boolean {
    const s = (stream || '').trim();
    if (!s || s.length > TvWatcherComponent.SHARE_STREAM_MAX_LEN) {
      return false;
    }
    if (/^https?:\/\//i.test(s) || s.includes('://')) {
      return false;
    }
    if (/%3A%2F%2F/i.test(s) || /https?%3A/i.test(s)) {
      return false;
    }
    return true;
  }

  /** Message + URL formatted so WhatsApp / iMessage make the link tappable. */
  private buildSharePayload(
    channel: TvChannel,
    opts?: { urlFirst?: boolean }
  ): { title: string; text: string; url: string } {
    const url = this.buildShareDeepLink(channel);
    const title = channel.name || this.translate.instant('TV.TITLE');
    const intro = this.translate.instant('TV.SHARE_TEXT', { name: channel.name || title });
    // Blank line isolates the URL so messengers detect a single clean link.
    const text = opts?.urlFirst ? `${url}\n\n${intro}` : `${intro}\n\n${url}`;
    return { title, text, url };
  }

  private async copyTextToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  private clearShareFeedbackTimer(): void {
    if (this.shareFeedbackTimer != null) {
      clearTimeout(this.shareFeedbackTimer);
      this.shareFeedbackTimer = null;
    }
  }

  private clearResyncFeedbackTimer(): void {
    if (this.resyncFeedbackTimer != null) {
      clearTimeout(this.resyncFeedbackTimer);
      this.resyncFeedbackTimer = null;
    }
  }

  /** Force A/V resync (live edge seek + MediaSource recover). */
  resyncAudioVideo(event?: Event): void {
    event?.stopPropagation();
    const video = this.videoEl?.nativeElement;
    if (!video || !this.selectedChannel || this.isFloatingOpen) {
      return;
    }
    this.isBuffering = true;
    this.resyncFeedback = 'TV.RESYNC_AV_DONE';
    this.clearResyncFeedbackTimer();
    resyncTvHlsAv(this.hls, video);
    this.showChrome(true);
    this.cdr.markForCheck();
    // Brief buffering pulse then clear status.
    window.setTimeout(() => {
      this.isBuffering = false;
      this.cdr.markForCheck();
    }, 400);
    this.resyncFeedbackTimer = setTimeout(() => {
      this.resyncFeedback = '';
      this.resyncFeedbackTimer = null;
      this.cdr.markForCheck();
    }, 2200);
  }

  /** Tear down HLS/media and reconnect to the current channel from scratch. */
  restartStream(event?: Event): void {
    event?.stopPropagation();
    const channel = this.selectedChannel;
    if (!channel || this.isFloatingOpen) {
      return;
    }
    this.playError = '';
    this.isBuffering = true;
    this.franceTvTokenRefreshAttempted = false;
    this.resyncFeedback = 'TV.RESTART_STREAM_DONE';
    this.clearResyncFeedbackTimer();
    this.showChrome(true);
    this.cdr.markForCheck();
    this.playChannel(channel);
    this.resyncFeedbackTimer = setTimeout(() => {
      this.resyncFeedback = '';
      this.resyncFeedbackTimer = null;
      this.cdr.markForCheck();
    }, 2200);
  }

  private loadCountries(): void {
    this.isLoadingCountries = true;
    this.countriesError = '';
    this.api.getTvCountries().subscribe({
      next: (list) => {
        this.countries = [...(list || [])].sort((a, b) => {
          const pin = (code?: string) => {
            const c = (code || '').toLowerCase();
            if (c === 'fr') return 0;
            if (c === 'ch') return 1;
            return 100;
          };
          const d = pin(a.code) - pin(b.code);
          if (d !== 0) {
            return d;
          }
          return (a?.name || '').localeCompare(b?.name || '', undefined, { sensitivity: 'base' });
        });
        this.isLoadingCountries = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.countries = [];
        this.countriesError = 'TV.ERR_COUNTRIES';
        this.isLoadingCountries = false;
        this.cdr.markForCheck();
      }
    });
  }

  /** Total TVs for the selected country (or worldwide). Used by the catalog tab badge. */
  private loadCatalogCount(opts?: { silent?: boolean }): void {
    this.catalogCountSub?.unsubscribe();
    const silent = !!opts?.silent;
    if (!silent) {
      this.isLoadingCatalogCount = true;
    }
    const country = this.isAllCountries ? 'all' : (this.selectedCountry || 'fr');
    this.catalogCountSub = this.api.getTvChannelCount(country).subscribe({
      next: (res) => {
        this.catalogTotalCount = Math.max(0, Number(res?.count) || 0);
        this.isLoadingCatalogCount = false;
        if (this.isAllCountries && this.catalogTotalCount > 0) {
          this.persistCatalogCount(this.catalogTotalCount);
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.isLoadingCatalogCount = false;
        this.cdr.markForCheck();
      }
    });
  }

  private hydrateCatalogCountFromStorage(): void {
    if (!this.isAllCountries || this.catalogTotalCount > 0) {
      return;
    }
    try {
      const raw = localStorage.getItem(TvWatcherComponent.CATALOG_COUNT_STORAGE_KEY);
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) {
        this.catalogTotalCount = Math.floor(n);
      }
    } catch {
      /* ignore */
    }
  }

  private persistCatalogCount(count: number): void {
    try {
      localStorage.setItem(TvWatcherComponent.CATALOG_COUNT_STORAGE_KEY, String(count));
    } catch {
      /* ignore */
    }
  }

  private loadChannels(): void {
    this.isLoadingChannels = true;
    this.channelsError = '';
    this.worldwideSearchHint = false;
    this.channelsSub?.unsubscribe();
    const country = this.selectedCountry || 'fr';
    const channelQ = (this.channelQuery || '').trim();
    const programQ = (this.programQuery || '').trim();
    const group = (this.selectedGroup || '').trim();

    if (country.toLowerCase() === 'all') {
      // Groups are heavy (scan all playlists) — load only when filters are open.
      if (!this.filtersCollapsed) {
        this.ensureWorldwideGroups();
      }
      if (channelQ.length >= 2 || group) {
        this.channelsSub = this.api
          .getTvChannelsWorldwide(channelQ.length >= 2 ? channelQ : undefined, group || undefined)
          .subscribe({
          next: (page) => {
            this.channels = this.sortChannelsByName(page?.channels || []);
            this.searchMatchTotal = Math.max(0, Number(page?.total) || 0);
            this.searchListTruncated = !!page?.truncated;
            this.isLoadingChannels = false;
            this.applyPendingShareChannel();
            this.refreshEpg();
            this.cdr.markForCheck();
          },
          error: () => {
            this.channels = [];
            this.searchMatchTotal = null;
            this.searchListTruncated = false;
            this.isLoadingChannels = false;
            this.channelsError = 'TV.ERR_CHANNELS';
            this.cdr.markForCheck();
          }
        });
        return;
      }
      if (programQ.length >= 2) {
        // Channel list is filled by runProgramSearch → applyWorldwideProgramHits.
        this.isLoadingChannels = this.isLoadingProgramSearch;
        this.cdr.markForCheck();
        return;
      }
      this.channels = [];
      this.searchMatchTotal = null;
      this.searchListTruncated = false;
      this.isLoadingChannels = false;
      this.worldwideSearchHint = true;
      this.cdr.markForCheck();
      return;
    }

    this.searchMatchTotal = null;
    this.searchListTruncated = false;

    this.api.getTvGroups(country).subscribe({
      next: (g) => {
        this.groups = g || [];
        this.cdr.markForCheck();
      },
      error: () => {
        this.groups = [];
      }
    });

    this.channelsSub = this.api.getTvChannels(country, undefined, this.selectedGroup).subscribe({
      next: (list) => {
        this.channels = this.sortChannelsByName(list || []);
        this.isLoadingChannels = false;
        this.applyPendingShareChannel();
        this.refreshEpg();
        this.cdr.markForCheck();
      },
      error: () => {
        this.channels = [];
        this.isLoadingChannels = false;
        this.channelsError = 'TV.ERR_CHANNELS';
        this.cdr.markForCheck();
      }
    });
  }

  /** Load category list for worldwide mode (union of all country groups). */
  private ensureWorldwideGroups(): void {
    if (this.groups.length > 0 || !this.isAllCountries) {
      return;
    }
    this.loadWorldwideGroups();
  }

  private loadWorldwideGroups(): void {
    this.api.getTvGroups('all').subscribe({
      next: (g) => {
        this.groups = g || [];
        this.cdr.markForCheck();
      },
      error: () => {
        this.groups = [];
        this.cdr.markForCheck();
      }
    });
  }

  /** Fetch now/next EPG for the channel pool (batched). */
  private refreshEpg(): void {
    if (this.listMode === 'arte' || this.listMode === 'ia' || this.listMode === 'recordings') {
      return;
    }
    const pool =
      this.listMode === 'favorites' ? this.favorites || [] : this.channels || [];
    const byCountry = new Map<string, string[]>();
    const addChannel = (ch: TvChannel | null | undefined) => {
      if (!ch) {
        return;
      }
      const epgId = resolveEpgChannelId(ch);
      if (!epgId) {
        return;
      }
      let cc = (ch.country || this.selectedCountry || 'fr').toLowerCase();
      if (!cc || cc === 'all' || cc.length !== 2) {
        cc = 'fr';
      }
      const list = byCountry.get(cc) || [];
      if (!list.includes(epgId)) {
        list.push(epgId);
      }
      byCountry.set(cc, list);
    };
    for (const ch of pool) {
      addChannel(ch);
    }
    addChannel(this.selectedChannel);

    if (!byCountry.size) {
      return;
    }

    const chunkSize = 80;
    const requests = [];
    for (const [cc, ids] of byCountry.entries()) {
      for (let i = 0; i < ids.length; i += chunkSize) {
        requests.push(
          this.api.getTvEpgNow(cc, ids.slice(i, i + chunkSize)).pipe(
            catchError(() => of({} as Record<string, TvEpgNow>))
          )
        );
      }
    }

    this.epgSub?.unsubscribe();
    this.isLoadingEpg = true;
    this.epgSub = forkJoin(requests).subscribe({
      next: (maps) => {
        const merged: Record<string, TvEpgNow> = { ...this.epgById };
        for (const map of maps) {
          for (const [id, value] of Object.entries(map || {})) {
            merged[epgLookupKey(id)] = value;
          }
        }
        this.epgById = merged;
        this.isLoadingEpg = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.isLoadingEpg = false;
        this.cdr.markForCheck();
      }
    });
  }

  epgFor(channel: TvChannel | null | undefined): TvEpgNow | null {
    const id = resolveEpgChannelId(channel);
    if (!id) {
      return null;
    }
    return this.epgById[epgLookupKey(id)] || null;
  }

  epgNowTitle(channel: TvChannel | null | undefined): string {
    return (this.epgFor(channel)?.now?.title || '').trim();
  }

  epgNextTitle(channel: TvChannel | null | undefined): string {
    return (this.epgFor(channel)?.next?.title || '').trim();
  }

  formatEpgClock(iso: string | null | undefined): string {
    if (!iso) {
      return '';
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return '';
    }
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  private loadFavorites(): void {
    if (!this.isLoggedIn) {
      this.favorites = [];
      this.favoriteIds = new Set();
      return;
    }
    this.isLoadingFavorites = true;
    this.favoritesError = '';
    this.api.getTvFavorites().subscribe({
      next: (fav) => {
        this.applyFavorites(fav?.channels || []);
        this.isLoadingFavorites = false;
        this.applyPendingShareChannel();
        if (this.listMode === 'favorites') {
          this.refreshEpg();
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.isLoadingFavorites = false;
        this.favorites = [];
        this.favoriteIds = new Set();
        this.favoritesError = 'TV.ERR_FAVORITES_LOAD';
        this.cdr.markForCheck();
      }
    });
  }

  private loadTf1Status(): void {
    this.api.getTvTf1Status().subscribe({
      next: (s) => {
        this.tf1Configured = !!s?.configured;
        this.cdr.markForCheck();
      },
      error: () => {
        this.tf1Configured = null;
      }
    });
  }

  onArteSectionChange(): void {
    this.artePage = 1;
    this.loadArtePrograms();
  }

  artePrevPage(): void {
    if (this.artePage <= 1 || this.isLoadingArte) {
      return;
    }
    this.artePage -= 1;
    this.loadArtePrograms();
  }

  arteNextPage(): void {
    if (this.artePage >= this.artePages || this.isLoadingArte) {
      return;
    }
    this.artePage += 1;
    this.loadArtePrograms();
  }

  arteMetaFor(channel: TvChannel | null | undefined): ArteProgram | null {
    if (!channel?.id) {
      return null;
    }
    return this.arteMetaById.get(channel.id) || null;
  }

  private loadArteSections(): void {
    this.api.getArteSections('fr').subscribe({
      next: (res) => {
        this.arteSections = res?.sections || [];
        this.cdr.markForCheck();
      },
      error: () => {
        this.arteSections = [
          { code: 'MOST_RECENT', label: 'Plus récentes' },
          { code: 'MOST_VIEWED', label: 'Plus vues' },
          { code: 'LAST_CHANCE', label: 'Dernière chance' }
        ];
        this.cdr.markForCheck();
      }
    });
  }

  private loadArtePrograms(): void {
    this.isLoadingArte = true;
    this.arteError = '';
    const q = this.channelQuery.trim();
    this.api.getArtePrograms({
      lang: 'fr',
      section: this.arteSection || 'MOST_RECENT',
      q: q.length >= 2 ? q : undefined,
      page: this.artePage
    }).subscribe({
      next: (res) => {
        this.artePage = res?.page || 1;
        this.artePages = Math.max(1, res?.pages || 1);
        this.arteTotal = res?.total || 0;
        this.arteMetaById.clear();
        const programs = res?.programs || [];
        this.channels = programs.map((p) => {
          this.arteMetaById.set(p.id, p);
          return this.arteProgramToChannel(p);
        });
        this.isLoadingArte = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.channels = [];
        this.arteTotal = 0;
        this.artePages = 1;
        this.isLoadingArte = false;
        this.arteError = 'TV.ARTE_ERR_LOAD';
        this.cdr.markForCheck();
      }
    });
  }

  private arteProgramToChannel(p: ArteProgram): TvChannel {
    const metaBits = [p.durationLabel, p.genre].filter(Boolean).join(' · ');
    return {
      id: p.id || `arte-${p.programId}`,
      name: p.title,
      logo: p.imageUrl,
      group: metaBits || 'ARTE',
      country: 'arte',
      streamUrl: p.streamUrl || `arte:${p.programId}`,
      quality: p.live ? 'LIVE' : (p.durationLabel || undefined)
    };
  }

  onIaSectionChange(): void {
    this.iaPage = 1;
    this.loadIaPrograms();
  }

  iaPrevPage(): void {
    if (this.iaPage <= 1 || this.isLoadingIa) {
      return;
    }
    this.iaPage -= 1;
    this.loadIaPrograms();
  }

  iaNextPage(): void {
    if (this.iaPage >= this.iaPages || this.isLoadingIa) {
      return;
    }
    this.iaPage += 1;
    this.loadIaPrograms();
  }

  iaMetaFor(channel: TvChannel | null | undefined): IaProgram | null {
    if (!channel?.id) {
      return null;
    }
    return this.iaMetaById.get(channel.id) || null;
  }

  private loadIaSections(): void {
    this.api.getIaSections().subscribe({
      next: (res) => {
        this.iaSections = res?.sections || [];
        this.cdr.markForCheck();
      },
      error: () => {
        this.iaSections = [
          { code: 'RECENT', label: 'Ajouts récents' },
          { code: 'FEATURE_FILMS', label: 'Films (feature films)' },
          { code: 'CLASSIC_FILMS', label: 'Classiques' },
          { code: 'MOST_DOWNLOADED', label: 'Les plus téléchargés' }
        ];
        this.cdr.markForCheck();
      }
    });
  }

  /** Warm the Archive.org tab badge without replacing the current channel list. */
  private loadIaTabCount(): void {
    if (this.listMode === 'ia' || this.iaTotal > 0) {
      return;
    }
    this.api.getIaPrograms({
      section: this.iaSection || 'RECENT',
      page: 1
    }).subscribe({
      next: (res) => {
        if (this.listMode === 'ia') {
          return;
        }
        this.iaTotal = Math.max(0, Number(res?.total) || 0);
        this.cdr.markForCheck();
      },
      error: () => { /* badge stays hidden */ }
    });
  }

  private loadIaPrograms(): void {
    this.isLoadingIa = true;
    this.iaError = '';
    const q = this.channelQuery.trim();
    this.api.getIaPrograms({
      section: this.iaSection || 'RECENT',
      q: q.length >= 2 ? q : undefined,
      page: this.iaPage
    }).subscribe({
      next: (res) => {
        this.iaPage = res?.page || 1;
        this.iaPages = Math.max(1, res?.pages || 1);
        this.iaTotal = res?.total || 0;
        this.iaMetaById.clear();
        const programs = res?.programs || [];
        this.channels = programs.map((p) => {
          this.iaMetaById.set(p.id, p);
          return this.iaProgramToChannel(p);
        });
        this.isLoadingIa = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.channels = [];
        this.iaTotal = 0;
        this.iaPages = 1;
        this.isLoadingIa = false;
        this.iaError = 'TV.IA_ERR_LOAD';
        this.cdr.markForCheck();
      }
    });
  }

  private iaProgramToChannel(p: IaProgram): TvChannel {
    const metaBits = [p.durationLabel, p.subtitle || p.genre].filter(Boolean).join(' · ');
    return {
      id: p.id || `ia-${p.programId}`,
      name: p.title,
      logo: p.imageUrl,
      group: metaBits || 'Archive.org',
      country: 'ia',
      streamUrl: p.streamUrl || `ia:${p.programId}`,
      quality: p.durationLabel || undefined
    };
  }

  private applyFavorites(list: TvChannel[]): void {
    this.favorites = this.sortChannelsByName(
      (list || []).map((ch) => ({
        ...ch,
        streamUrl: resolveTvStreamUrl(ch)
      }))
    );
    this.favoriteIds = new Set(this.favorites.map((c) => c.id).filter(Boolean));
  }

  private loadRecordingCapability(): void {
    this.api.getTvRecordingStatus().subscribe({
      next: (s) => {
        this.recordingStatus = s || null;
        this.recordingStatusLoaded = true;
        if (s?.defaultDurationSec && s.defaultDurationSec > 0) {
          this.recordDurationSec = s.defaultDurationSec;
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.recordingStatus = null;
        this.recordingStatusLoaded = false;
        this.cdr.markForCheck();
      }
    });
  }

  private loadRecordings(): void {
    if (!this.isLoggedIn) {
      this.recordings = [];
      this.stopRecordingsPoll();
      return;
    }
    this.isLoadingRecordings = true;
    this.recordingsError = '';
    this.api.getTvRecordings().subscribe({
      next: (list) => {
        this.recordings = list || [];
        this.isLoadingRecordings = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.isLoadingRecordings = false;
        this.recordingsError = 'TV.ERR_RECORDINGS_LOAD';
        this.cdr.markForCheck();
      }
    });
  }

  private syncRecordingsPoll(): void {
    // Browser recording has no server-side RUNNING job to poll.
    this.stopRecordingsPoll();
  }

  private startRecordingsPoll(): void {
    /* no-op — kept for compatibility */
  }

  private stopRecordingsPoll(): void {
    if (this.recordingsPollTimer != null) {
      clearInterval(this.recordingsPollTimer);
      this.recordingsPollTimer = null;
    }
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

  startRecording(event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    if (!this.isLoggedIn) {
      this.recordingsHint = 'TV.RECORD_LOGIN';
      this.setListMode('recordings');
      this.showChrome(true);
      this.cdr.markForCheck();
      return;
    }
    if (!this.supportsBrowserRecording) {
      this.playError = 'TV.ERR_RECORD_UNAVAILABLE';
      this.showChrome(true);
      this.cdr.markForCheck();
      return;
    }
    if (this.recordingStatusLoaded && this.recordingStatus?.enabled === false) {
      this.playError = 'TV.ERR_RECORD_UNAVAILABLE';
      this.showChrome(true);
      this.cdr.markForCheck();
      return;
    }
    const channel = this.selectedChannel;
    const video = this.videoEl?.nativeElement;
    if (!channel?.streamUrl || !video || this.recordingBusy || this.clientRecordingActive || this.playingRecording) {
      return;
    }
    if (video.paused || video.readyState < 2) {
      this.playError = 'TV.ERR_RECORD_NEED_PLAY';
      this.showChrome(true);
      this.cdr.markForCheck();
      return;
    }

    let stream: MediaStream;
    try {
      const capturable = video as HTMLVideoElement & { captureStream: () => MediaStream };
      stream = capturable.captureStream();
    } catch (e) {
      this.playError = 'TV.ERR_RECORD_UNAVAILABLE';
      this.showChrome(true);
      this.cdr.markForCheck();
      return;
    }
    if (!stream || stream.getTracks().length === 0) {
      this.playError = 'TV.ERR_RECORD_UNAVAILABLE';
      this.showChrome(true);
      this.cdr.markForCheck();
      return;
    }

    const mimeType = this.pickRecorderMimeType();
    try {
      this.recordedChunks = [];
      this.mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 })
        : new MediaRecorder(stream, { videoBitsPerSecond: 2_500_000 });
    } catch {
      this.playError = 'TV.ERR_RECORD_UNAVAILABLE';
      this.showChrome(true);
      this.cdr.markForCheck();
      return;
    }

    this.mediaRecorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) {
        this.recordedChunks.push(ev.data);
      }
    };
    this.mediaRecorder.onerror = () => {
      this.playError = 'TV.ERR_RECORD_START';
      this.abortClientRecording(false);
      this.cdr.markForCheck();
    };

    this.clientRecordChannel = channel;
    this.clientRecordStartedAt = Date.now();
    this.clientRecordingActive = true;
    this.playError = '';
    this.mediaRecorder.start(1000);

    if (this.recordAutoStopTimer != null) {
      clearTimeout(this.recordAutoStopTimer);
    }
    this.recordAutoStopTimer = setTimeout(() => {
      this.recordAutoStopTimer = null;
      if (this.clientRecordingActive) {
        this.stopActiveRecording();
      }
    }, Math.max(5, this.recordDurationSec) * 1000);

    this.showChrome(true);
    this.cdr.markForCheck();
  }

  stopActiveRecording(event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    if (!this.clientRecordingActive || !this.mediaRecorder) {
      return;
    }
    if (this.recordingBusy) {
      return;
    }
    const recorder = this.mediaRecorder;
    const channel = this.clientRecordChannel;
    const startedAt = this.clientRecordStartedAt;
    const mimeType = recorder.mimeType || this.pickRecorderMimeType() || 'video/webm';

    this.recordingBusy = true;
    if (this.recordAutoStopTimer != null) {
      clearTimeout(this.recordAutoStopTimer);
      this.recordAutoStopTimer = null;
    }

    recorder.onstop = () => {
      const durationSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const blob = new Blob(this.recordedChunks, { type: mimeType.split(';')[0] || 'video/webm' });
      this.recordedChunks = [];
      this.mediaRecorder = null;
      this.clientRecordingActive = false;
      this.clientRecordChannel = null;

      if (!blob.size || blob.size < 1024) {
        this.recordingBusy = false;
        this.playError = 'TV.ERR_RECORD_START';
        this.cdr.markForCheck();
        return;
      }
      if (!channel) {
        this.recordingBusy = false;
        this.cdr.markForCheck();
        return;
      }

      const ext = mimeType.includes('mp4') ? '.mp4' : '.webm';
      this.api
        .uploadTvRecording(
          blob,
          {
            channelId: channel.id,
            channelName: channel.name,
            channelLogo: channel.logo,
            country: channel.country,
            streamUrl: resolveTvStreamUrl(channel),
            durationSec
          },
          `tv-${(channel.name || 'rec').replace(/[^\w.-]+/g, '_').slice(0, 40)}${ext}`
        )
        .subscribe({
          next: (rec) => {
            this.recordingBusy = false;
            if (rec) {
              this.recordings = [rec, ...this.recordings.filter((r) => r.id !== rec.id)];
            }
            this.setListMode('recordings');
            this.showChrome(true);
            this.cdr.markForCheck();
          },
          error: (err) => {
            this.recordingBusy = false;
            const code = err?.error?.error || '';
            if (code === 'file_too_large') {
              this.playError = 'TV.ERR_RECORD_TOO_LARGE';
            } else if (code === 'tv_recording_disabled') {
              this.playError = 'TV.ERR_RECORD_UNAVAILABLE';
            } else {
              this.playError = 'TV.ERR_RECORD_START';
            }
            this.showChrome(true);
            this.cdr.markForCheck();
          }
        });
    };

    try {
      if (recorder.state !== 'inactive') {
        recorder.stop();
      } else {
        recorder.onstop(new Event('stop') as BlobEvent);
      }
    } catch {
      this.recordingBusy = false;
      this.abortClientRecording(false);
      this.playError = 'TV.ERR_RECORD_STOP';
      this.cdr.markForCheck();
    }
  }

  private abortClientRecording(upload: boolean): void {
    if (this.recordAutoStopTimer != null) {
      clearTimeout(this.recordAutoStopTimer);
      this.recordAutoStopTimer = null;
    }
    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.onstop = null;
        this.mediaRecorder.stop();
      }
    } catch {
      /* ignore */
    }
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.clientRecordingActive = false;
    this.clientRecordChannel = null;
    if (!upload) {
      this.recordingBusy = false;
    }
  }

  playRecording(rec: TvRecording, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    if (rec.status !== 'DONE') {
      return;
    }
    // Sync token so <video src> stays inside the click gesture (Bearer cannot be set on media elements).
    const token = this.keycloak.getTokenSync();
    const url = this.api.tvRecordingMediaUrl(rec, token || undefined);
    if (!url) {
      return;
    }
    const video = this.videoEl?.nativeElement;
    if (!video) {
      return;
    }
    if (this.tvPlayer.isOsPipActive()) {
      this.tvPlayer.stopOsPip();
      this.isPipActive = false;
    }
    this.destroyPlayer();
    this.playingRecording = rec;
    this.selectedChannel = {
      id: rec.channelId || rec.id,
      name: rec.channelName || 'Recording',
      logo: rec.channelLogo,
      country: rec.country,
      streamUrl: url,
      group: 'Recording'
    };
    this.playError = '';
    this.isBuffering = true;
    this.applyAudioToVideo(video, { muted: false, ensureVolume: true });
    video.src = url;
    video.load();
    const tryPlay = (allowMuteFallback = true) => {
      this.applyAudioToVideo(video, { muted: allowMuteFallback ? false : true, ensureVolume: true });
      const p = video.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          this.isBuffering = false;
          this.syncMuteFromVideo();
          this.cdr.markForCheck();
        }).catch((err: unknown) => {
          const name =
            err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
          if (name === 'AbortError') {
            return;
          }
          if (allowMuteFallback && name === 'NotAllowedError') {
            tryPlay(false);
            return;
          }
          this.isBuffering = false;
          this.playError = 'TV.ERR_RECORD_PLAY';
          this.cdr.markForCheck();
        });
      } else {
        this.isBuffering = false;
      }
    };
    tryPlay(true);
    this.showChrome(true);
    this.cdr.markForCheck();
  }

  deleteRecording(rec: TvRecording, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    if (!rec?.id || this.recordingBusy) {
      return;
    }
    this.recordingBusy = true;
    this.api.deleteTvRecording(rec.id).subscribe({
      next: () => {
        this.recordingBusy = false;
        this.recordings = this.recordings.filter((r) => r.id !== rec.id);
        if (this.playingRecording?.id === rec.id) {
          this.playingRecording = null;
          this.destroyPlayer();
        }
        this.syncRecordingsPoll();
        this.cdr.markForCheck();
      },
      error: () => {
        this.recordingBusy = false;
        this.recordingsError = 'TV.ERR_RECORD_DELETE';
        this.cdr.markForCheck();
      }
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
    return d.toLocaleString(undefined, {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  trackByRecordingId(_index: number, rec: TvRecording): string {
    return rec?.id || String(_index);
  }

  /** Alphabetical order by channel name (locale-aware, case-insensitive). */
  private sortChannelsByName(list: TvChannel[]): TvChannel[] {
    return [...list].sort((a, b) =>
      (a?.name || '').localeCompare(b?.name || '', undefined, { sensitivity: 'base', numeric: true })
    );
  }

  private playChannel(channel: TvChannel): void {
    const video = this.videoEl?.nativeElement;
    if (!video || !channel?.streamUrl) {
      return;
    }

    this.playingRecording = null;

    if (this.clientRecordingActive) {
      this.abortClientRecording(false);
    }

    if (this.tvPlayer.isOsPipActive()) {
      this.tvPlayer.stopOsPip();
      this.isPipActive = false;
    }

    this.destroyPlayer();
    this.playError = '';
    this.isBuffering = true;
    const playGen = ++this.playGeneration;
    this.hlsRecoverAttempts = { network: 0, media: 0 };
    this.applyAudioToVideo(video, { muted: false, ensureVolume: true });
    const streamUrl = resolveTvStreamUrl(channel);
    const proxyUrl = this.api.tvStreamProxyUrl(streamUrl);

    void this.startPlaybackAfterPreflight(channel, video, streamUrl, proxyUrl, playGen);
  }

  private async startPlaybackAfterPreflight(
    channel: TvChannel,
    video: HTMLVideoElement,
    streamUrl: string,
    proxyUrl: string,
    playGen: number
  ): Promise<void> {
    let effectiveStreamUrl = streamUrl;
    let effectiveProxyUrl = proxyUrl;

    if (isInternetArchiveVirtual(streamUrl)) {
      const identifier = internetArchiveIdFromVirtualUrl(streamUrl);
      if (!identifier) {
        this.isBuffering = false;
        this.playError = 'TV.ERR_STREAM';
        this.showChrome(true);
        this.cdr.markForCheck();
        return;
      }
      try {
        const resolved = await firstValueFrom(this.api.resolveInternetArchiveItem(identifier));
        if (playGen !== this.playGeneration) {
          return;
        }
        if (!resolved?.streamUrl) {
          this.isBuffering = false;
          this.playError = 'TV.IA_ERR_RESOLVE';
          this.showChrome(true);
          this.cdr.markForCheck();
          return;
        }
        effectiveStreamUrl = resolved.streamUrl;
        // archive.org serves CORS * — play MP4 directly (avoid proxying multi‑GB files).
        effectiveProxyUrl = resolved.streamUrl;
      } catch {
        if (playGen !== this.playGeneration) {
          return;
        }
        this.isBuffering = false;
        this.playError = 'TV.IA_ERR_RESOLVE';
        this.showChrome(true);
        this.cdr.markForCheck();
        return;
      }
    }

    if (isKeepAliveVirtualLive(streamUrl)) {
      const pre = await preflightVirtualLive(streamUrl, this.api);
      if (playGen !== this.playGeneration) {
        return;
      }
      if (!pre.ok) {
        this.isBuffering = false;
        this.playError = pre.detail
          ? `TV.ERR_STREAM\n${pre.detail}`
          : 'TV.ERR_STREAM';
        this.showChrome(true);
        this.cdr.markForCheck();
        return;
      }
    }

    const tryPlay = (allowMuteFallback = true) => {
      if (playGen !== this.playGeneration) {
        return;
      }
      this.applyAudioToVideo(video, { muted: this.isMuted, ensureVolume: true });
      const p = video.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          if (playGen !== this.playGeneration) {
            return;
          }
          this.isBuffering = false;
          this.syncMuteFromVideo();
          this.cdr.markForCheck();
        }).catch((err: unknown) => {
          if (playGen !== this.playGeneration) {
            return;
          }
          const name =
            err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
          // AbortError is normal when switching channel / destroying the player mid-play().
          if (name === 'AbortError') {
            return;
          }
          if (allowMuteFallback && !this.isMuted) {
            // Autoplay with sound blocked (async HLS loses user gesture) — start muted.
            // Still auto-hide chrome: unmute uses the on-video hint, not a sticky bar.
            this.applyAudioToVideo(video, { muted: true, ensureVolume: true });
            this.showChrome(true);
            tryPlay(false);
            return;
          }
          this.isBuffering = false;
          this.playError = isInternetArchiveVirtual(streamUrl) || isProgressiveVod(effectiveStreamUrl)
            ? 'TV.IA_ERR_PLAY'
            : 'TV.ERR_PLAY';
          this.showChrome(true);
          this.cdr.markForCheck();
        });
      } else {
        this.isBuffering = false;
      }
    };

    // Progressive MP4 (Internet Archive) — do not feed through hls.js.
    if (isProgressiveVod(effectiveStreamUrl) || isInternetArchiveVirtual(streamUrl)) {
      video.src = effectiveProxyUrl;
      video.playbackRate = 1;
      const onNativeError = () => {
        if (playGen !== this.playGeneration) {
          return;
        }
        this.isBuffering = false;
        this.playError = 'TV.IA_ERR_PLAY';
        this.showChrome(true);
        this.cdr.markForCheck();
      };
      video.addEventListener('error', onNativeError, { once: true });
      video.addEventListener('loadeddata', () => tryPlay(), { once: true });
      tryPlay();
      return;
    }

    // Prefer hls.js whenever available. Chromium/Electron often reports
    // canPlayType('application/vnd.apple.mpegurl') as "maybe" without real native
    // HLS — that path hangs on proxied ARTE CMAF (demuxed) VOD.
    if (Hls.isSupported()) {
      const vod = isArteReplayVod(streamUrl);
      this.hls = new Hls(createTvHlsConfig(vod ? 'vod' : 'live'));
      this.hls.loadSource(effectiveProxyUrl);
      this.hls.attachMedia(video);
      video.playbackRate = 1;
      // Never attach live-edge seek on ARTE replay — it jumps straight to the end.
      this.detachHlsLiveSync = vod
        ? null
        : attachTvHlsLiveSyncWatchdog(this.hls, video);
      this.bindWatcherHlsHandlers(this.hls, channel, effectiveProxyUrl, playGen, tryPlay);
      this.startFranceTvKeeperIfNeeded(channel, effectiveProxyUrl, playGen, tryPlay);
      return;
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = effectiveProxyUrl;
      const onNativeError = () => {
        void this.reportPlayStreamError(effectiveProxyUrl, playGen);
      };
      video.addEventListener('error', onNativeError, { once: true });
      tryPlay();
      return;
    }

    this.isBuffering = false;
    this.playError = 'TV.ERR_UNSUPPORTED';
    this.showChrome(true);
    this.cdr.markForCheck();
  }

  private bindWatcherHlsHandlers(
    instance: Hls,
    channel: TvChannel,
    proxyUrl: string,
    playGen: number,
    tryPlay: (allowMuteFallback?: boolean) => void
  ): void {
    instance.on(Hls.Events.MANIFEST_PARSED, () => {
      tryPlay();
    });
    instance.on(Hls.Events.ERROR, (_event, data) => {
      if (!data?.fatal) {
        return;
      }
      const streamUrl = resolveTvStreamUrl(channel);
      if (
        playGen === this.playGeneration &&
        !this.franceTvTokenRefreshAttempted &&
        isKeepAliveVirtualLive(streamUrl) &&
        isTvHlsForbiddenError(data)
      ) {
        this.franceTvTokenRefreshAttempted = true;
        this.isBuffering = true;
        this.cdr.markForCheck();
        void bustVirtualLiveCache(streamUrl, this.api).finally(() => {
          if (playGen === this.playGeneration) {
            this.playChannel(channel);
          }
        });
        return;
      }
      if (this.hls && tryRecoverTvHlsError(this.hls, data, this.hlsRecoverAttempts)) {
        this.isBuffering = true;
        this.cdr.markForCheck();
        tryPlay(false);
        return;
      }
      if (
        playGen === this.playGeneration &&
        !this.franceTvTokenRefreshAttempted &&
        isKeepAliveVirtualLive(streamUrl)
      ) {
        this.franceTvTokenRefreshAttempted = true;
        this.isBuffering = true;
        this.cdr.markForCheck();
        void bustVirtualLiveCache(streamUrl, this.api).finally(() => {
          if (playGen === this.playGeneration) {
            this.playChannel(channel);
          }
        });
        return;
      }
      try {
        this.hls?.destroy();
      } catch {
        /* ignore */
      }
      this.hls = null;
      void this.reportPlayStreamError(proxyUrl, playGen, data);
    });
  }

  private startFranceTvKeeperIfNeeded(
    channel: TvChannel,
    proxyUrl: string,
    playGen: number,
    tryPlay: (allowMuteFallback?: boolean) => void
  ): void {
    const streamUrl = resolveTvStreamUrl(channel);
    const keepAlive = virtualLiveKeepAliveFromUrl(streamUrl, this.api);
    if (!keepAlive) {
      return;
    }
    this.franceTvKeeper?.stop();
    this.franceTvKeeper = startFranceTvTokenKeeper({
      slug: keepAlive.slug,
      proxyUrl,
      getHls: () => this.hls,
      getVideo: () => this.videoEl?.nativeElement || null,
      isCancelled: () => playGen !== this.playGeneration,
      resolveMeta: keepAlive.resolveMeta,
      onRenewed: () => {
        if (playGen !== this.playGeneration) {
          return;
        }
        this.showTokenRenewedToast();
      },
      onHlsSwapped: (next, media) => {
        if (playGen !== this.playGeneration) {
          try {
            next.destroy();
          } catch {
            /* ignore */
          }
          return;
        }
        try {
          this.detachHlsLiveSync?.();
        } catch {
          /* ignore */
        }
        this.hls = next;
        this.detachHlsLiveSync = isArteReplayVod(resolveTvStreamUrl(channel))
          ? null
          : attachTvHlsLiveSyncWatchdog(next, media);
        this.bindWatcherHlsHandlers(next, channel, proxyUrl, playGen, tryPlay);
      }
    });
  }

  private showTokenRenewedToast(): void {
    this.tokenRenewedToast = true;
    if (this.tokenRenewedToastTimer != null) {
      clearTimeout(this.tokenRenewedToastTimer);
    }
    this.tokenRenewedToastTimer = setTimeout(() => {
      this.tokenRenewedToast = false;
      this.tokenRenewedToastTimer = null;
      this.cdr.markForCheck();
    }, 1000);
    this.cdr.markForCheck();
  }

  private async reportPlayStreamError(
    proxyUrl: string,
    playGen: number,
    hlsData?: Parameters<typeof resolveTvStreamErrorMessage>[1]
  ): Promise<void> {
    if (playGen !== this.playGeneration) {
      return;
    }
    this.isBuffering = false;
    this.cdr.markForCheck();
    const message = await resolveTvStreamErrorMessage(proxyUrl, hlsData);
    if (playGen !== this.playGeneration) {
      return;
    }
    this.playError = message;
    this.showChrome(true);
    this.cdr.markForCheck();
  }

  /** Keep component mute/volume flags in sync with the real media element. */
  onVideoVolumeChange(): void {
    this.syncMuteFromVideo();
    this.cdr.markForCheck();
  }

  private syncMuteFromVideo(): void {
    const video = this.videoEl?.nativeElement;
    if (!video) {
      return;
    }
    this.isMuted = !!video.muted || video.volume === 0;
    if (!video.muted && video.volume > 0) {
      this.volumePercent = Math.round(video.volume * 100);
    }
  }

  private applyAudioToVideo(
    video: HTMLVideoElement,
    opts: { muted: boolean; ensureVolume: boolean }
  ): void {
    if (opts.ensureVolume && this.volumePercent <= 0) {
      this.volumePercent = 100;
    }
    video.volume = Math.min(1, Math.max(0, this.volumePercent / 100));
    video.muted = opts.muted;
    this.isMuted = opts.muted || this.volumePercent <= 0;
  }

  toggleMute(): void {
    const video = this.videoEl?.nativeElement;
    if (!video) {
      return;
    }
    if (video.muted || this.isMuted || this.volumePercent <= 0) {
      this.ensureSound();
      return;
    }
    this.applyAudioToVideo(video, { muted: true, ensureVolume: false });
    this.showChrome(true);
    this.cdr.markForCheck();
  }

  /**
   * Force audible playback after a user gesture (required by browser autoplay rules
   * once HLS has loaded asynchronously).
   */
  ensureSound(event?: Event): void {
    event?.stopPropagation();
    const video = this.videoEl?.nativeElement;
    if (!video || !this.selectedChannel || this.isFloatingOpen) {
      return;
    }
    // Already audible — do nothing (avoids fighting the mute button).
    if (!video.muted && video.volume > 0 && !this.isMuted && this.volumePercent > 0) {
      return;
    }
    this.volumePercent = this.volumePercent > 0 ? this.volumePercent : 100;
    this.applyAudioToVideo(video, { muted: false, ensureVolume: true });
    const p = video.play();
    if (p && typeof p.then === 'function') {
      p.catch(() => { /* ignore */ });
    }
    this.scheduleChromeHide();
    this.cdr.markForCheck();
  }

  setVolumePercent(value: number | string): void {
    const video = this.videoEl?.nativeElement;
    if (!video) {
      return;
    }
    const pct = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
    this.volumePercent = pct;
    video.volume = pct / 100;
    if (pct > 0) {
      video.muted = false;
      this.isMuted = false;
    } else {
      video.muted = true;
      this.isMuted = true;
    }
    this.scheduleChromeHide();
    this.cdr.markForCheck();
  }

  private destroyPlayer(): void {
    this.franceTvKeeper?.stop();
    this.franceTvKeeper = null;
    if (this.tokenRenewedToastTimer != null) {
      clearTimeout(this.tokenRenewedToastTimer);
      this.tokenRenewedToastTimer = null;
    }
    this.tokenRenewedToast = false;
    if (this.detachHlsLiveSync) {
      this.detachHlsLiveSync();
      this.detachHlsLiveSync = null;
    }
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        /* ignore */
      }
      this.hls = null;
    }
    const video = this.videoEl?.nativeElement;
    // Do not touch the OS PiP carrier — it lives outside this view.
    if (video && document.pictureInPictureElement !== video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }
}
