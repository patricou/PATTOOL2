import {
  AfterViewInit,
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
import { ActivatedRoute, NavigationStart, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged, catchError, filter } from 'rxjs/operators';
import { of } from 'rxjs';
import Hls from 'hls.js';

import { ApiService, RadioCountry, RadioFrancePodcastEpisode, RadioFrancePodcastShow, RadioNowPlaying, RadioStation, RadioTrackImage } from '../services/api.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { RadioNowPlayingService } from '../services/radio-now-playing.service';
import { RadioPlayerService } from '../services/radio-player.service';
import { setDeviceMediaVolume, activeScreenKeepAliveOwner } from '../services/media-screen-keepalive';
import { createTvHlsConfig, resetTvMediaElement, tryRecoverTvHlsError } from '../tv-watcher/tv-hls-config';
import { attachRadioPlaybackGuard, bustRadioStreamUrl, RadioPlaybackGuard } from './radio-playback-guard';
import {
  adjacentRadioStation,
  claimRadioTune,
  publishRadioTrack,
  closeRadioDocPip,
  enterRadioPictureInPicture,
  isRadioDocPipOpen,
  stopRadioPipCarrier,
  supportsRadioPictureInPicture
} from './radio-pip.util';
import { MediaCatalogCacheToolbarComponent } from '../shared/media-catalog-cache-toolbar/media-catalog-cache-toolbar.component';
import { buildRadioShareLink } from '../shared/share-deep-link.util';
import {
  RadioFilterPreference,
  RadioGlobalFilterModalComponent
} from './radio-global-filter-modal.component';
import { readMediaSkin, writeMediaSkin } from '../services/media-skin';
import { YoutubeEqualizerService } from '../services/youtube-equalizer.service';
import { YoutubeEqualizerModalComponent } from '../youtube-watcher/youtube-equalizer-modal.component';

type RadioListMode = 'catalog' | 'favorites' | 'podcasts';
type PodcastBrowseLevel = 'shows' | 'episodes';
export type RadioSkin =
  | 'classic'
  | 'artdeco'
  | 'synthwave'
  | 'spaceage'
  | 'military'
  | 'steampunk'
  | 'aurora'
  | 'noir'
  | 'bamboo'
  | 'porcelain'
  | 'carbon'
  | 'candy'
  | 'espace'
  | 'kanizsa'
  | 'cafewall'
  | 'penrose'
  | 'scintille'
  | 'barber';

const RADIO_SKINS: readonly RadioSkin[] = [
  'classic',
  'artdeco',
  'synthwave',
  'spaceage',
  'military',
  'steampunk',
  'aurora',
  'noir',
  'bamboo',
  'porcelain',
  'carbon',
  'candy',
  'espace',
  'kanizsa',
  'cafewall',
  'penrose',
  'scintille',
  'barber'
];

@Component({
  selector: 'app-radio-watcher',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, MediaCatalogCacheToolbarComponent, RadioGlobalFilterModalComponent, YoutubeEqualizerModalComponent],
  templateUrl: './radio-watcher.component.html',
  styleUrls: ['./radio-watcher.component.css', './radio-skins.css']
})
export class RadioWatcherComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly onLiveVolume = (): void => this.onMediaVolumeChange();

  private get liveAudio(): HTMLAudioElement {
    return this.radioPlayer.audio;
  }
  @ViewChild('sidebarEl') sidebarEl?: ElementRef<HTMLElement>;
  /** Desktop only: sidebar fills from its top down to the bottom of the screen. */
  sidebarHeightPx: number | null = null;
  @ViewChild('playerPanel') playerPanelEl?: ElementRef<HTMLElement>;
  @ViewChild('eqModal') eqModal?: YoutubeEqualizerModalComponent;
  eqLive = false;
  private eqSourceLive = false;
  private eqSub?: Subscription;
  private playbackGesture: (() => void) | null = null;

  countries: RadioCountry[] = [];
  stations: RadioStation[] = [];
  tags: string[] = [];
  favorites: RadioStation[] = [];
  favoriteIds = new Set<string>();

  listMode: RadioListMode = 'favorites';
  selectedCountry = 'all';
  selectedTag = '';
  stationQuery = '';
  sidebarFilterQuery = '';
  sidebarCollapsed = false;
  selectedStation: RadioStation | null = null;
  nowPlayingLabel = '';
  /** Photos of the current track, inside the cabinet, on any skin. */
  sleeveOpen = false;
  trackImages: RadioTrackImage[] = [];
  trackImageIndex = 0;
  worldwideSearchHint = false;
  countryMenuOpen = false;
  countryFilter = '';

  /** Same model as TV: 50 rows per page, client slice (worldwide uses returned search page). */
  listPageSize = 50;
  catalogPage = 1;
  catalogPages = 1;
  favoritesPage = 1;
  podcastsPage = 1;

  globalFilterOpen = false;
  applyGlobalFilterToAllTabs = false;
  globalFilterPreference: RadioFilterPreference = {};

  podcastStations: Array<{ id: string; name: string }> = [];
  podcastStation = 'franceinter';
  podcastBrowse: PodcastBrowseLevel = 'shows';
  podcastShows: RadioFrancePodcastShow[] = [];
  podcastEpisodes: RadioFrancePodcastEpisode[] = [];
  selectedPodcastShow: RadioFrancePodcastShow | null = null;
  isLoadingPodcasts = false;
  podcastsError = '';
  private podcastShowsSub?: Subscription;
  private podcastEpisodesSub?: Subscription;

  isLoadingCountries = false;
  isLoadingStations = false;
  isLoadingFavorites = false;
  favoriteBusyId = '';
  playError = '';
  stationsError = '';
  countriesError = '';
  favoritesError = '';
  favoritesHint = '';
  isMuted = false;
  private followDeviceVolume = false;

  volumePercent = 100;
  isBuffering = false;
  /** Stream dropped; playback restarts when the network is back. */
  isReconnecting = false;
  chromeVisible = false;
  private pointerOverRadio = false;
  shareMenuOpen = false;
  shareFeedback = '';
  /** When true, leaving the page with keep-alive keeps World Receiver playing. */
  keepAliveOnNavigate = true;
  /** Off by default. When on, the current station keeps playing on other PatTool pages. */
  continueOnNavigate = false;
  readonly radioSkins = RADIO_SKINS;
  radioSkin: RadioSkin = 'classic';
  @HostBinding('class.radio-skin--classic') get skinClassic(): boolean { return this.radioSkin === 'classic'; }
  @HostBinding('class.radio-skin--artdeco') get skinArtdeco(): boolean { return this.radioSkin === 'artdeco'; }
  @HostBinding('class.radio-skin--synthwave') get skinSynthwave(): boolean { return this.radioSkin === 'synthwave'; }
  @HostBinding('class.radio-skin--spaceage') get skinSpaceage(): boolean { return this.radioSkin === 'spaceage'; }
  @HostBinding('class.radio-skin--military') get skinMilitary(): boolean { return this.radioSkin === 'military'; }
  @HostBinding('class.radio-skin--steampunk') get skinSteampunk(): boolean { return this.radioSkin === 'steampunk'; }
  @HostBinding('class.radio-skin--aurora') get skinAurora(): boolean { return this.radioSkin === 'aurora'; }
  @HostBinding('class.radio-skin--noir') get skinNoir(): boolean { return this.radioSkin === 'noir'; }
  @HostBinding('class.radio-skin--bamboo') get skinBamboo(): boolean { return this.radioSkin === 'bamboo'; }
  @HostBinding('class.radio-skin--porcelain') get skinPorcelain(): boolean { return this.radioSkin === 'porcelain'; }
  @HostBinding('class.radio-skin--carbon') get skinCarbon(): boolean { return this.radioSkin === 'carbon'; }
  @HostBinding('class.radio-skin--candy') get skinCandy(): boolean { return this.radioSkin === 'candy'; }
  @HostBinding('class.radio-skin--espace') get skinEspace(): boolean { return this.radioSkin === 'espace'; }
  @HostBinding('class.radio-skin--kanizsa') get skinKanizsa(): boolean { return this.radioSkin === 'kanizsa'; }
  @HostBinding('class.radio-skin--cafewall') get skinCafewall(): boolean { return this.radioSkin === 'cafewall'; }
  @HostBinding('class.radio-skin--penrose') get skinPenrose(): boolean { return this.radioSkin === 'penrose'; }
  @HostBinding('class.radio-skin--scintille') get skinScintille(): boolean { return this.radioSkin === 'scintille'; }
  @HostBinding('class.radio-skin--barber') get skinBarber(): boolean { return this.radioSkin === 'barber'; }
  /** Radio filling the page: menu and title hidden, not browser fullscreen. */
  @HostBinding('class.radio-focus') focusMode = false;
  /** Browser fullscreen, same idea as the TV stage. */
  @HostBinding('class.radio-stage-fs') stageFullscreen = false;
  /** Phone turned sideways: the receiver screen fills the display. */
  @HostBinding('class.radio-landscape-fs') landscapeFullscreen = false;
  skinMenuOpen = false;
  private skinChosenThisVisit = false;
  private skinLoadSub?: Subscription;
  private skinSaveSub?: Subscription;
  isPipActive = false;
  pipSupported = supportsRadioPictureInPicture();
  readonly canNativeShare =
    typeof navigator !== 'undefined' && typeof (navigator as Navigator).share === 'function';

  /** Total catalog size for the current country (or worldwide when country=all). */
  catalogTotalCount = 0;
  isLoadingCatalogCount = false;
  /** Exact match count for worldwide search (may equal list length from radio-browser). */
  searchMatchTotal: number | null = null;
  searchListTruncated = false;

  private catalogCountSub?: Subscription;
  private hls: Hls | null = null;
  private playbackGuard: RadioPlaybackGuard | null = null;
  private stationSearch$ = new Subject<string>();
  private stationSearchSub?: Subscription;
  private stationsSub?: Subscription;
  private resumeSub?: Subscription;
  private lastStationSaveSub?: Subscription;
  private navLeaveSub?: Subscription;
  private leavePolicyApplied = false;
  /** True only after the user clicked the PiP control (not browser auto-PiP). */
  private userOpenedPip = false;
  private restoredLastStation = false;
  private chromeHideTimer: ReturnType<typeof setTimeout> | null = null;
  private shareFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingShareStationId = '';
  private playGeneration = 0;
  private pageAlive = true;
  private playDeferTimer: ReturnType<typeof setTimeout> | null = null;
  private nowPlayingSub?: Subscription;
  private trackSlideTimer: ReturnType<typeof setInterval> | null = null;
  private nowPlayingTitle = '';
  private nowPlayingArtist = '';
  private nowPlayingAlbum = '';
  private static readonly CHROME_HIDE_MS = 4000;
  private static readonly LAST_STATION_STORAGE_KEY = 'pattool.radio.last-station';
  private static readonly KEEP_ALIVE_STORAGE_KEY = 'pattool.radio.keep-alive';
  private static readonly CONTINUE_STORAGE_KEY = 'pattool.radio.continue';
  private static readonly SKIN_STORAGE_KEY = 'pattool.radio.skin';
  private static readonly SLEEVE_STORAGE_KEY = 'pattool.radio.sleeve';
  private static readonly SIDEBAR_COLLAPSED_STORAGE_KEY = 'pattool.radio.sidebar-collapsed';
  private static readonly FOCUS_BODY_CLASS = 'radio-focus';
  private static readonly STAGE_FS_BODY_CLASS = 'radio-stage-fs';
  private static readonly LANDSCAPE_FS_BODY_CLASS = 'radio-landscape-fs';
  private landscapeOrientationMql: MediaQueryList | null = null;
  private landscapeFsUserDismissed = false;
  /** User asked for the cover or video on a phone, including in portrait. */
  private mediaFsPinned = false;
  private readonly onLandscapeOrientationMedia = (): void => {
    this.syncLandscapeFullscreen();
    this.cdr.detectChanges();
  };
  private static readonly SHARE_STREAM_MAX_LEN = 80;
  private static readonly PRESET_COUNT = 12;

  constructor(
    private api: ApiService,
    private keycloak: KeycloakService,
    private radioPlayer: RadioPlayerService,
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute,
    private router: Router,
    private translate: TranslateService,
    readonly equalizer: YoutubeEqualizerService,
    private nowPlaying: RadioNowPlayingService,
    private hostRef: ElementRef<HTMLElement>
  ) {
    this.eqSub = new Subscription();
    this.eqSub.add(this.equalizer.sourceKind$.subscribe((kind) => {
      this.eqSourceLive = kind !== 'none';
      this.refreshEqIndicator();
    }));
    this.eqSub.add(this.equalizer.settings$.subscribe(() => {
      this.refreshEqIndicator();
      this.onEqAudioPlaying();
    }));
  }

  get isAllCountries(): boolean {
    return (this.selectedCountry || '').toLowerCase() === 'all';
  }

  get filteredCountries(): RadioCountry[] {
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
    return this.radioPlayer.isOpen;
  }

  /** Pastille : le réglage enregistré est actif, même juste après un rechargement. */
  get eqActive(): boolean {
    return this.equalizer.wantsProcessing && (this.eqSourceLive || !!this.selectedStation);
  }

  private refreshEqIndicator(): void {
    this.eqLive = this.eqSourceLive;
    this.cdr.markForCheck();
  }

  private readonly onEqAudioPlaying = (): void => {
    if (!this.pageAlive || this.isFloatingOpen) {
      return;
    }
    const media = this.liveAudio;
    if (!media || media.paused) {
      return;
    }
    void this.engageEqualizer(media);
  };

  private async engageEqualizer(media: HTMLMediaElement): Promise<void> {
    if (!this.pageAlive || this.isFloatingOpen || !this.equalizer.wantsProcessing) {
      return;
    }
    void this.equalizer.resume();
    this.equalizer.engageMedia(media);
  }

  private armPlaybackGesture(station: RadioStation, gen: number, reload: boolean): void {
    this.clearPlaybackGesture();
    this.isBuffering = false;
    this.playError = '';
    const kick = () => {
      this.clearPlaybackGesture();
      if (!this.pageAlive || gen !== this.playGeneration) {
        return;
      }
      const media = this.liveAudio;
      if (!media) {
        return;
      }
      if (reload || media.error) {
        this.playStation(station, 'user');
        return;
      }
      media.muted = false;
      this.isMuted = false;
      const pending = media.play();
      void this.engageEqualizer(media);
      void pending.then(() => {
        if (gen !== this.playGeneration) {
          return;
        }
        this.isBuffering = false;
        this.isReconnecting = false;
        this.playError = '';
        this.cdr.markForCheck();
      }).catch(() => {
        if (gen !== this.playGeneration) {
          return;
        }
        this.playStation(station, 'user');
      });
    };
    this.playbackGesture = kick;
    document.addEventListener('pointerdown', kick, true);
    this.cdr.markForCheck();
  }

  private clearPlaybackGesture(): void {
    if (this.playbackGesture) {
      document.removeEventListener('pointerdown', this.playbackGesture, true);
      this.playbackGesture = null;
    }
  }

  openEqualizer(): void {
    const el = this.liveAudio;
    if (el && !this.isFloatingOpen) {
      this.equalizer.attachMediaElement(el);
    } else {
      void this.equalizer.resume();
    }
    this.eqModal?.open();
  }

  get displayedStations(): RadioStation[] {
    if (this.listMode === 'podcasts') {
      return [];
    }
    const unpaged = this.unpagedDisplayedStations;
    const page = this.listMode === 'favorites' ? this.favoritesPage : this.catalogPage;
    return this.sliceListPage(unpaged, page);
  }

  /** Filtered station rows before client-side pagination. */
  private get unpagedDisplayedStations(): RadioStation[] {
    let source = this.listMode === 'favorites' ? this.favorites : this.stations;
    const q = this.stationQuery.trim().toLowerCase();
    // Catalog: server already applied stationQuery (+ tag). Favorites: filter locally.
    if (this.listMode === 'favorites' && q) {
      source = source.filter((st) => this.matchesStationQuery(st, q));
    }
    const quick = this.sidebarFilterQuery.trim().toLowerCase();
    if (!quick) {
      return source;
    }
    // Worldwide catalog already applied sidebar text via catalogStationSearchQuery().
    if (this.listMode === 'catalog' && this.isAllCountries) {
      return source;
    }
    return source.filter((st) => this.matchesStationQuery(st, quick));
  }

  private sliceListPage(items: RadioStation[], page: number): RadioStation[] {
    const size = Math.max(1, this.listPageSize);
    const p = Math.max(1, page);
    const start = (p - 1) * size;
    return items.slice(start, start + size);
  }

  get favoritesPages(): number {
    if (this.listMode !== 'favorites') {
      return 1;
    }
    return Math.max(1, Math.ceil(this.unpagedDisplayedStations.length / Math.max(1, this.listPageSize)));
  }

  get effectiveCatalogPages(): number {
    return Math.max(1, Math.ceil(this.unpagedDisplayedStations.length / Math.max(1, this.listPageSize)));
  }

  get podcastsPages(): number {
    const total =
      this.podcastBrowse === 'episodes' ? this.podcastEpisodes.length : this.unpagedPodcastShows.length;
    return Math.max(1, Math.ceil(total / Math.max(1, this.listPageSize)));
  }

  get unpagedPodcastShows(): RadioFrancePodcastShow[] {
    const q = this.sidebarFilterQuery.trim().toLowerCase();
    if (!q) {
      return this.podcastShows;
    }
    return this.podcastShows.filter((s) => {
      const title = (s.title || '').toLowerCase();
      const station = (s.stationName || '').toLowerCase();
      return title.includes(q) || station.includes(q);
    });
  }

  get displayedPodcastShows(): RadioFrancePodcastShow[] {
    return this.sliceGenericPage(this.unpagedPodcastShows, this.podcastsPage);
  }

  get displayedPodcastEpisodes(): RadioFrancePodcastEpisode[] {
    const q = this.sidebarFilterQuery.trim().toLowerCase();
    let source = this.podcastEpisodes;
    if (q) {
      source = source.filter((ep) => (ep.title || '').toLowerCase().includes(q));
    }
    return this.sliceGenericPage(source, this.podcastsPage);
  }

  private sliceGenericPage<T>(items: T[], page: number): T[] {
    const size = Math.max(1, this.listPageSize);
    const p = Math.max(1, page);
    const start = (p - 1) * size;
    return items.slice(start, start + size);
  }

  get filteredStationCount(): number {
    if (this.listMode === 'podcasts') {
      if (this.podcastBrowse === 'episodes') {
        const q = this.sidebarFilterQuery.trim().toLowerCase();
        if (!q) {
          return this.podcastEpisodes.length;
        }
        return this.podcastEpisodes.filter((ep) => (ep.title || '').toLowerCase().includes(q)).length;
      }
      return this.unpagedPodcastShows.length;
    }
    if (this.listMode === 'catalog' && this.isAllCountries && this.searchMatchTotal != null) {
      const searching =
        this.stationQuery.trim().length >= 2
        || !!this.selectedTag
        || this.sidebarFilterQuery.trim().length >= 2;
      if (searching) {
        return this.searchMatchTotal;
      }
    }
    return this.unpagedDisplayedStations.length;
  }

  get podcastStationName(): string {
    const found = this.podcastStations.find((s) => s.id === this.podcastStation);
    return found?.name || this.podcastStation;
  }

  /**
   * Count shown on the « Toutes les radios » tab — always the catalog size for the
   * current country (or filtered catalog list), never the Favorites count.
   */
  get catalogTabCount(): number {
    if (this.listMode === 'favorites' || this.listMode === 'podcasts') {
      return this.catalogTotalCount > 0 ? this.catalogTotalCount : 0;
    }
    if (this.isAllCountries) {
      const searching =
        this.stationQuery.trim().length >= 2
        || !!this.selectedTag
        || this.sidebarFilterQuery.trim().length >= 2;
      if (!searching && this.catalogTotalCount > 0) {
        return this.catalogTotalCount;
      }
      if (searching && this.searchMatchTotal != null && this.searchMatchTotal >= 0) {
        return this.searchMatchTotal;
      }
    }
    if (
      !this.isAllCountries
      && this.catalogTotalCount > 0
      && !this.stationQuery.trim()
      && !this.selectedTag
      && !this.sidebarFilterQuery.trim()
    ) {
      return this.catalogTotalCount;
    }
    return this.filteredStationCount;
  }

  /** Exact station count shown in the list header. */
  get listHeaderStationCount(): number {
    if (this.isAllCountries) {
      const idle =
        !this.stationQuery.trim()
        && !this.selectedTag
        && !this.sidebarFilterQuery.trim();
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
      && !this.stationQuery.trim()
      && !this.selectedTag
      && !this.sidebarFilterQuery.trim()
    ) {
      return this.catalogTotalCount;
    }
    return this.unpagedDisplayedStations.length;
  }

  get hasActiveFilters(): boolean {
    if (this.listMode === 'podcasts') {
      return !!(
        this.stationQuery.trim()
        || this.sidebarFilterQuery.trim()
        || this.podcastStation !== 'franceinter'
      );
    }
    if (this.listMode !== 'catalog') {
      return !!(this.stationQuery.trim() || this.sidebarFilterQuery.trim());
    }
    return !!(
      this.stationQuery.trim()
      || this.sidebarFilterQuery.trim()
      || this.selectedTag
      || this.isAllCountries
    );
  }

  get hasActiveGlobalFilter(): boolean {
    return !!(
      this.stationQuery.trim()
      || this.selectedTag
      || (this.selectedCountry && this.selectedCountry !== 'all')
      || this.applyGlobalFilterToAllTabs
    );
  }

  get isLoadingStationList(): boolean {
    if (this.listMode === 'catalog') {
      return this.isLoadingStations;
    }
    if (this.listMode === 'favorites') {
      return this.isLoadingFavorites;
    }
    return this.isLoadingPodcasts;
  }

  get stationListLoadingKey(): string {
    if (this.listMode === 'favorites') {
      return 'RADIO.LOADING_FAVORITES';
    }
    if (this.listMode === 'podcasts') {
      return this.podcastBrowse === 'episodes'
        ? 'RADIO.LOADING_PODCAST_EPISODES'
        : 'RADIO.LOADING_PODCASTS';
    }
    return 'RADIO.LOADING';
  }

  matchesStationQuery(station: RadioStation, queryLower: string): boolean {
    const q = (queryLower || '').trim().toLowerCase();
    if (!q || !station) {
      return true;
    }
    if ((station.name || '').toLowerCase().includes(q)) {
      return true;
    }
    if ((station.tags || '').toLowerCase().includes(q)) {
      return true;
    }
    if ((station.country || '').toLowerCase().includes(q)) {
      return true;
    }
    if ((station.language || '').toLowerCase().includes(q)) {
      return true;
    }
    return false;
  }

  ngOnInit(): void {
    this.liveAudio.addEventListener('volumechange', this.onLiveVolume);
    this.liveAudio.addEventListener('playing', this.onEqAudioPlaying);
    this.onEqAudioPlaying();
    window.addEventListener('patradiotransport', this.onBluetoothTune);
    window.addEventListener('patmediavolumeui', this.onDeviceVolumeUi);
    this.keepAliveOnNavigate = this.readKeepAlivePreference();
    this.continueOnNavigate = this.readContinuePreference();
    this.sleeveOpen = this.readSleeveOpen();
    this.restoreSkinPreference();
    this.sidebarCollapsed = this.readSidebarCollapsedPreference();
    this.stationSearchSub = this.stationSearch$
      .pipe(debounceTime(280), distinctUntilChanged())
      .subscribe(() => {
        if (this.listMode === 'catalog') {
          this.loadStations();
        } else if (this.listMode === 'podcasts') {
          if (this.podcastBrowse === 'shows') {
            this.loadPodcastShows();
          } else {
            this.cdr.markForCheck();
          }
        } else {
          this.cdr.markForCheck();
        }
      });

    this.resumeSub = this.radioPlayer.resumeOnPage$.subscribe((station) => {
      this.resumePagePlayback(station);
    });
    this.nowPlayingSub = this.nowPlaying.state$.subscribe((state) => this.applyNowPlaying(state));
    const pending = this.radioPlayer.consumePendingResume();
    if (pending) {
      this.restoredLastStation = true;
      this.resumePagePlayback(pending);
    } else if (this.radioPlayer.isOpen && this.radioPlayer.snapshot.station) {
      const station = this.radioPlayer.snapshot.station;
      this.selectedStation = station;
      this.restoredLastStation = true;
      const media = this.liveAudio;
      if (media && this.radioPlayer.isLive(media, station)) {
        this.radioPlayer.close({ resumeOnPage: false, keepStream: true });
        this.continuePageLive(station, media);
      }
    }

    // Hand off during NavigationStart (still in the click gesture) so Document PiP
    // can reopen with the floating World Receiver instead of the simplified fallback.
    this.navLeaveSub = this.router.events
      .pipe(filter((e): e is NavigationStart => e instanceof NavigationStart))
      .subscribe((e) => {
        const next = (e.url || '').toLowerCase();
        if (next.includes('radio-watcher')) {
          return;
        }
        this.applyLeavePagePlaybackPolicy();
      });

    this.loadCountries();
    this.loadCatalogCount();
    this.loadFavorites();
    this.loadPodcastStations();
    if (!this.tryOpenSharedStationFromQuery()) {
      this.restoreLastPlayedStation();
    }
    this.setupLandscapeFullscreenWatchers();
    this.syncLandscapeFullscreen();
    // Tags + catalog stations: deferred — worldwide mode needs a search/tag first,
    // and tags are only useful once the filters panel is opened.
  }

  ngOnDestroy(): void {
    this.teardownLandscapeFullscreenWatchers();
    this.exitLandscapeFullscreen(false);
    window.removeEventListener('patradiotransport', this.onBluetoothTune);
    window.removeEventListener('patmediavolumeui', this.onDeviceVolumeUi);
    this.pageAlive = false;
    this.liveAudio.removeEventListener('volumechange', this.onLiveVolume);
    this.liveAudio.removeEventListener('playing', this.onEqAudioPlaying);
    this.eqSub?.unsubscribe();
    this.clearPlaybackGesture();
    this.eqModal?.close();
    this.handOffContinue();
    const keepLive = this.liveShouldSurviveLeave();
    this.clearChromeHideTimer();
    this.clearShareFeedbackTimer();
    this.clearPlayDeferTimer();
    this.stationSearchSub?.unsubscribe();
    this.stationsSub?.unsubscribe();
    this.catalogCountSub?.unsubscribe();
    this.podcastShowsSub?.unsubscribe();
    this.podcastEpisodesSub?.unsubscribe();
    this.resumeSub?.unsubscribe();
    this.lastStationSaveSub?.unsubscribe();
    this.skinLoadSub?.unsubscribe();
    this.navLeaveSub?.unsubscribe();
    this.nowPlayingSub?.unsubscribe();
    this.clearTrackSlide();
    this.exitFocusMode();
    void this.exitStageFullscreen();
    this.applyLeavePagePlaybackPolicy();
    if (!keepLive) {
      this.equalizer.detachMediaElement(this.liveAudio);
    }
    this.destroyPlayer(true, { keepLive });
  }

  /**
   * The floating bar stays if the user already opened it.
   * Continuer, when on, opens that bar for the station that is playing.
   */
  private applyLeavePagePlaybackPolicy(): void {
    if (this.leavePolicyApplied) {
      return;
    }
    this.leavePolicyApplied = true;
    if (this.radioPlayer.isOpen) {
      return;
    }
    this.handOffContinue();
    if (this.radioPlayer.isOpen) {
      return;
    }
    this.preventPageAutoPip();
    this.exitPictureInPictureIfOwned();
  }

  /** Block browser auto Picture-in-Picture on the page media during route leave. */
  private preventPageAutoPip(): void {
    const media = this.liveAudio;
    if (!media) {
      return;
    }
    try {
      if (media instanceof HTMLVideoElement) {
        media.disablePictureInPicture = true;
      }
      media.pause();
    } catch {
      /* ignore */
    }
  }

  private isPipElementOwned(): boolean {
    const pipEl = document.pictureInPictureElement;
    return (
      !!pipEl &&
      (pipEl === this.liveAudio ||
        pipEl === document.getElementById('pattool-radio-pip-carrier'))
    );
  }

  private exitPictureInPictureIfOwned(): void {
    closeRadioDocPip();
    if (this.isPipElementOwned()) {
      document.exitPictureInPicture().catch(() => undefined);
      stopRadioPipCarrier();
    }
    this.isPipActive = false;
    this.userOpenedPip = false;
  }

  async togglePictureInPicture(): Promise<void> {
    if (!this.pipSupported || !this.selectedStation) {
      return;
    }
    const media = this.liveAudio;
    if (!media) {
      return;
    }
    try {
      if (isRadioDocPipOpen() || this.isPipElementOwned()) {
        closeRadioDocPip();
        if (this.isPipElementOwned()) {
          await document.exitPictureInPicture().catch(() => undefined);
          stopRadioPipCarrier();
        }
        this.isPipActive = false;
        this.userOpenedPip = false;
        this.cdr.markForCheck();
        return;
      }
      await enterRadioPictureInPicture(media, {
        title: this.selectedStation.name || 'Radio',
        trackTitle: this.nowPlayingTitle,
        artist: this.nowPlayingArtist,
        album: this.nowPlayingAlbum,
        artworkUrl: this.trackImages[0]?.url || this.stationLogo(this.selectedStation),
        countryLabel: this.countryLabel(this.selectedStation.country),
        faceEl: this.playerPanelEl?.nativeElement || null,
        labels: {
          fullscreen: this.translate.instant('RADIO.FULLSCREEN'),
          fullscreenExit: this.translate.instant('RADIO.FULLSCREEN_EXIT'),
          close: this.translate.instant('RADIO.PIP_EXIT')
        },
        onClose: () => {
          this.userOpenedPip = false;
          if (!this.isPipActive) {
            return;
          }
          this.isPipActive = false;
          this.cdr.markForCheck();
        }
      });
      this.isPipActive = true;
      this.userOpenedPip = true;
      this.cdr.markForCheck();
    } catch {
      this.playError = 'RADIO.ERR_PIP';
      this.userOpenedPip = false;
      this.showChrome(true);
      this.cdr.markForCheck();
    }
  }

  @HostListener('document:enterpictureinpicture')
  onEnterPip(): void {
    this.isPipActive = isRadioDocPipOpen() || this.isPipElementOwned();
    this.cdr.markForCheck();
  }

  @HostListener('document:leavepictureinpicture')
  onLeavePip(): void {
    if (!isRadioDocPipOpen()) {
      this.isPipActive = false;
      this.userOpenedPip = false;
      stopRadioPipCarrier();
      this.cdr.markForCheck();
    }
  }

  setContinueOnNavigate(enabled: boolean): void {
    this.continueOnNavigate = !!enabled;
    try {
      localStorage.setItem(RadioWatcherComponent.CONTINUE_STORAGE_KEY, this.continueOnNavigate ? '1' : '0');
    } catch {
      /* private mode / quota */
    }
    this.cdr.markForCheck();
  }

  private readContinuePreference(): boolean {
    try {
      const raw = localStorage.getItem(RadioWatcherComponent.CONTINUE_STORAGE_KEY);
      return raw === '1' || raw === 'true';
    } catch {
      return false;
    }
  }

  /** Leave the live station on the floating receiver when Continuer is on. */
  private handOffContinue(): void {
    if (!this.continueOnNavigate || this.radioPlayer.isOpen || !this.selectedStation) {
      return;
    }
    const media = this.liveAudio;
    if (!media?.src || media.paused || media.ended || media.error) {
      return;
    }
    this.radioPlayer.openFloating(this.selectedStation, { minimized: true });
  }

  setKeepAliveOnNavigate(enabled: boolean): void {
    this.keepAliveOnNavigate = !!enabled;
    this.writeKeepAlivePreference(this.keepAliveOnNavigate);
    this.cdr.markForCheck();
  }

  private readKeepAlivePreference(): boolean {
    try {
      const raw = localStorage.getItem(RadioWatcherComponent.KEEP_ALIVE_STORAGE_KEY);
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
      localStorage.setItem(RadioWatcherComponent.KEEP_ALIVE_STORAGE_KEY, enabled ? '1' : '0');
    } catch {
      /* private mode / quota */
    }
  }

  toggleSidebarCollapsed(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    try {
      localStorage.setItem(RadioWatcherComponent.SIDEBAR_COLLAPSED_STORAGE_KEY, this.sidebarCollapsed ? '1' : '0');
    } catch {
      /* private mode / quota */
    }
    this.cdr.markForCheck();
    this.scheduleSidebarHeightUpdate();
  }

  ngAfterViewInit(): void {
    this.scheduleSidebarHeightUpdate();
  }

  @HostListener('window:resize')
  scheduleSidebarHeightUpdate(): void {
    requestAnimationFrame(() => this.updateSidebarHeight());
  }

  private updateSidebarHeight(): void {
    const el = this.sidebarEl?.nativeElement;
    let next: number | null = null;
    // ≤900px the sidebar sits under the player and is sized by CSS.
    if (el && window.innerWidth > 900) {
      const top = el.getBoundingClientRect().top + window.scrollY;
      next = Math.max(320, Math.round(window.innerHeight - top - 16));
    }
    if (next !== this.sidebarHeightPx) {
      this.sidebarHeightPx = next;
      this.cdr.markForCheck();
    }
  }

  private readSidebarCollapsedPreference(): boolean {
    try {
      const raw = localStorage.getItem(RadioWatcherComponent.SIDEBAR_COLLAPSED_STORAGE_KEY);
      return raw === '1' || raw === 'true';
    } catch {
      return false;
    }
  }

  private static readonly ILLUSION_SKINS: readonly RadioSkin[] = [
    'kanizsa',
    'cafewall',
    'penrose',
    'scintille',
    'barber'
  ];

  readonly illusionSkins = RadioWatcherComponent.ILLUSION_SKINS;

  get sortedRadioSkins(): RadioSkin[] {
    const pinned = new Set<RadioSkin>(RadioWatcherComponent.ILLUSION_SKINS);
    const lang = this.translate.currentLang || this.translate.defaultLang || 'fr';
    return this.radioSkins.filter((skin) => !pinned.has(skin)).sort((a, b) =>
      this.translate.instant(this.skinNameKey(a)).localeCompare(
        this.translate.instant(this.skinNameKey(b)),
        lang,
        { sensitivity: 'base' }
      )
    );
  }

  trackRadioSkin(_index: number, skin: RadioSkin): string {
    return skin;
  }

  skinNameKey(skin: RadioSkin): string {
    return `RADIO.SKIN_${skin.toUpperCase()}`;
  }

  skinDescKey(skin: RadioSkin): string {
    return `RADIO.SKIN_${skin.toUpperCase()}_DESC`;
  }

  toggleSkinMenu(event: Event): void {
    event.stopPropagation();
    this.skinMenuOpen = !this.skinMenuOpen;
    this.cdr.markForCheck();
  }

  /** The window covers the face while a photo is ready. Full screen always shows it. */
  get sleeveVisible(): boolean {
    return !this.isFloatingOpen && this.trackImages.length > 0 && (this.sleeveOpen || this.landscapeFullscreen);
  }

  toggleSleeve(): void {
    this.sleeveOpen = !this.sleeveOpen;
    this.writeSleeveOpen(this.sleeveOpen);
    this.cdr.markForCheck();
  }

  setRadioSkin(skin: RadioSkin): void {
    this.radioSkin = skin;
    this.skinMenuOpen = false;
    this.skinChosenThisVisit = true;
    this.writeLocalSkin(skin);
    this.saveRemoteSkin(skin);
    this.cdr.markForCheck();
  }

  private static isRadioSkin(value: string | null | undefined): value is RadioSkin {
    return !!value && (RADIO_SKINS as readonly string[]).includes(value);
  }

  private readSleeveOpen(): boolean {
    try {
      const skin = localStorage.getItem(RadioWatcherComponent.SKIN_STORAGE_KEY);
      if (skin === 'sleeve') {
        localStorage.removeItem(RadioWatcherComponent.SKIN_STORAGE_KEY);
        localStorage.setItem(RadioWatcherComponent.SLEEVE_STORAGE_KEY, '1');
        return true;
      }
      return localStorage.getItem(RadioWatcherComponent.SLEEVE_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  private writeSleeveOpen(open: boolean): void {
    try {
      localStorage.setItem(RadioWatcherComponent.SLEEVE_STORAGE_KEY, open ? '1' : '0');
    } catch {
      /* private mode / quota */
    }
    this.publishRadioLook();
  }

  private readLocalSkin(): RadioSkin | null {
    const raw = readMediaSkin(RadioWatcherComponent.SKIN_STORAGE_KEY);
    return RadioWatcherComponent.isRadioSkin(raw) ? raw : null;
  }

  private writeLocalSkin(skin: RadioSkin): void {
    writeMediaSkin(skin);
  }

  /** The outside-browser window and the in-app float read the same look. */
  private publishRadioLook(): void {
    try {
      window.dispatchEvent(new CustomEvent('patradiolook'));
    } catch {
      /* ignore */
    }
  }

  private saveRemoteSkin(skin: RadioSkin): void {
    if (!this.isLoggedIn) {
      return;
    }
    this.skinSaveSub?.unsubscribe();
    this.skinSaveSub = this.api.saveRadioSkin(skin).pipe(catchError(() => of(null))).subscribe();
  }

  /** Local value applies instantly; the account value (if any) wins once loaded, unless the user already picked one. */
  private restoreSkinPreference(): void {
    const local = this.readLocalSkin();
    this.radioSkin = local ?? 'classic';
    if (!this.isLoggedIn) {
      return;
    }
    this.skinLoadSub = this.api.getRadioSkin().pipe(catchError(() => of(null))).subscribe((remote) => {
      if (!this.pageAlive || this.skinChosenThisVisit) {
        return;
      }
      if (remote === 'sleeve') {
        this.sleeveOpen = true;
        this.writeSleeveOpen(true);
        this.cdr.markForCheck();
        return;
      }
      if (RadioWatcherComponent.isRadioSkin(remote)) {
        this.radioSkin = remote;
        this.writeLocalSkin(remote);
        this.cdr.markForCheck();
      } else if (local) {
        this.writeLocalSkin(local);
        this.saveRemoteSkin(local);
      }
    });
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.landscapeFullscreen) {
      this.exitLandscapeFullscreen(true);
      return;
    }
    if (this.skinMenuOpen) {
      this.skinMenuOpen = false;
      this.cdr.markForCheck();
      return;
    }
    if (this.stageFullscreen && !this.nativeFullscreenElement()) {
      void this.exitStageFullscreen();
      return;
    }
    if (this.focusMode && !this.stageFullscreen && !this.globalFilterOpen && !this.eqModal?.isOpen) {
      this.exitFocusMode();
    }
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  onStageFullscreenChange(): void {
    const current = this.nativeFullscreenElement();
    if (current === this.hostRef.nativeElement) {
      this.stageFullscreen = true;
      document.body.classList.add(RadioWatcherComponent.STAGE_FS_BODY_CLASS);
    } else if (!current && this.stageFullscreen) {
      this.stageFullscreen = false;
      document.body.classList.remove(RadioWatcherComponent.STAGE_FS_BODY_CLASS);
    }
    this.cdr.markForCheck();
  }

  toggleFocusMode(event?: Event): void {
    event?.stopPropagation();
    if (this.focusMode) {
      this.exitFocusMode();
      return;
    }
    this.enterFocusMode();
  }

  enterFocusMode(): void {
    if (this.landscapeFullscreen) {
      this.exitLandscapeFullscreen(true);
    }
    this.focusMode = true;
    document.body.classList.add(RadioWatcherComponent.FOCUS_BODY_CLASS);
    if (this.selectedStation) {
      this.showChrome(false);
    }
    this.cdr.markForCheck();
  }

  exitFocusMode(): void {
    if (!this.focusMode && !document.body.classList.contains(RadioWatcherComponent.FOCUS_BODY_CLASS)) {
      return;
    }
    this.focusMode = false;
    document.body.classList.remove(RadioWatcherComponent.FOCUS_BODY_CLASS);
    this.cdr.markForCheck();
    this.syncLandscapeFullscreen();
  }

  /** Leave the phone-landscape screen. Portrait clears the dismiss so the next turn fills the screen again. */
  exitLandscapeFullscreen(markDismissed = true, event?: Event): void {
    event?.stopPropagation();
    if (markDismissed && this.landscapeFullscreen) {
      this.landscapeFsUserDismissed = true;
    }
    if (!this.landscapeFullscreen && !document.body.classList.contains(RadioWatcherComponent.LANDSCAPE_FS_BODY_CLASS)) {
      return;
    }
    this.landscapeFullscreen = false;
    this.mediaFsPinned = false;
    document.body.classList.remove(RadioWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
    this.cdr.markForCheck();
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
    const mql = this.landscapeOrientationMql as MediaQueryList & {
      addListener?: (cb: () => void) => void;
    };
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', this.onLandscapeOrientationMedia);
    } else {
      mql.addListener?.(this.onLandscapeOrientationMedia);
    }
  }

  private teardownLandscapeFullscreenWatchers(): void {
    const mql = this.landscapeOrientationMql as (MediaQueryList & {
      removeListener?: (cb: () => void) => void;
    }) | null;
    if (mql) {
      if (typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', this.onLandscapeOrientationMedia);
      } else {
        mql.removeListener?.(this.onLandscapeOrientationMedia);
      }
      this.landscapeOrientationMql = null;
    }
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

  private hasLandscapeScreen(): boolean {
    return !!this.selectedStation && !this.isFloatingOpen;
  }

  private canEnterLandscapeFullscreen(): boolean {
    return (
      this.isMobileLikeViewport()
      && this.isLandscapeOrientation()
      && this.hasLandscapeScreen()
      && !this.landscapeFsUserDismissed
      && !this.focusMode
      && !this.stageFullscreen
    );
  }

  private syncLandscapeFullscreen(): void {
    if (!this.isLandscapeOrientation()) {
      this.landscapeFsUserDismissed = false;
      if (!this.mediaFsPinned) {
        this.exitLandscapeFullscreen(false);
      }
      return;
    }
    if (this.canEnterLandscapeFullscreen()) {
      this.enterLandscapeFullscreen();
      return;
    }
    if (this.landscapeFullscreen && !this.hasLandscapeScreen()) {
      this.exitLandscapeFullscreen(false);
    }
  }

  private enterLandscapeFullscreen(): void {
    const already = this.landscapeFullscreen;
    this.landscapeFullscreen = true;
    document.body.classList.add(RadioWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
    if (!already) {
      this.chromeVisible = false;
      this.clearChromeHideTimer();
      this.cdr.markForCheck();
    }
  }

  get mobileLayout(): boolean {
    return this.isMobileLikeViewport();
  }

  /** Phone: one control, and it shows only the cover. Desktop keeps the receiver fullscreen. */
  onFullscreenButton(event?: Event): void {
    if (this.isMobileLikeViewport()) {
      this.toggleMediaFullscreen(event);
      return;
    }
    void this.toggleStageFullscreen(event);
  }

  toggleMediaFullscreen(event?: Event): void {
    event?.stopPropagation();
    if (this.landscapeFullscreen) {
      this.exitLandscapeFullscreen(true);
      return;
    }
    this.mediaFsPinned = true;
    this.landscapeFsUserDismissed = false;
    this.enterLandscapeFullscreen();
  }

  async toggleStageFullscreen(event?: Event): Promise<void> {
    event?.stopPropagation();
    if (this.stageFullscreen) {
      await this.exitStageFullscreen();
      return;
    }
    await this.enterStageFullscreen();
  }

  async enterStageFullscreen(): Promise<void> {
    const host = this.hostRef.nativeElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    this.stageFullscreen = true;
    document.body.classList.add(RadioWatcherComponent.STAGE_FS_BODY_CLASS);
    if (this.selectedStation) {
      this.showChrome(false);
    }
    this.cdr.markForCheck();
    try {
      const req = host.requestFullscreen?.bind(host) || host.webkitRequestFullscreen?.bind(host);
      if (req) {
        await Promise.resolve(req());
      }
    } catch {
      /* The page still covers the viewport; the same button leaves it. */
    }
  }

  async exitStageFullscreen(): Promise<void> {
    const current = this.nativeFullscreenElement();
    if (current === this.hostRef.nativeElement) {
      const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
      try {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else {
          doc.webkitExitFullscreen?.();
        }
      } catch {
        /* already left */
      }
    }
    this.stageFullscreen = false;
    document.body.classList.remove(RadioWatcherComponent.STAGE_FS_BODY_CLASS);
    this.cdr.markForCheck();
  }

  private nativeFullscreenElement(): Element | null {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    return document.fullscreenElement || doc.webkitFullscreenElement || null;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    let changed = false;
    if (this.skinMenuOpen && !target?.closest?.('.radio-skin-picker')) {
      this.skinMenuOpen = false;
      changed = true;
    }
    if (this.shareMenuOpen && !target?.closest?.('.radio-share-wrap')) {
      this.shareMenuOpen = false;
      changed = true;
    }
    if (this.countryMenuOpen && !target?.closest?.('.radio-country-picker')) {
      this.countryMenuOpen = false;
      changed = true;
    }
    if (changed) {
      this.cdr.markForCheck();
    }
  }

  onRadioPointerEnter(): void {
    this.pointerOverRadio = true;
    this.clearChromeHideTimer();
    if (!this.chromeVisible) {
      this.chromeVisible = true;
      this.cdr.markForCheck();
    }
  }

  onRadioPointerMove(): void {
    this.onRadioPointerEnter();
  }

  onRadioPointerLeave(): void {
    this.pointerOverRadio = false;
    this.clearChromeHideTimer();
    if (!this.selectedStation || this.focusMode || this.stageFullscreen) {
      return;
    }
    this.shareMenuOpen = false;
    if (!this.chromeVisible) {
      return;
    }
    this.chromeVisible = false;
    this.cdr.markForCheck();
  }

  onRadioTouch(): void {
    this.pointerOverRadio = false;
    this.showChrome(true);
  }

  private showChrome(scheduleHide: boolean): void {
    this.chromeVisible = true;
    this.cdr.markForCheck();
    if (scheduleHide && !this.pointerOverRadio) {
      this.scheduleChromeHide();
    } else {
      this.clearChromeHideTimer();
    }
  }

  private scheduleChromeHide(delayMs = RadioWatcherComponent.CHROME_HIDE_MS): void {
    this.clearChromeHideTimer();
    if (!this.selectedStation || this.shareMenuOpen || this.focusMode || this.stageFullscreen || this.pointerOverRadio) {
      return;
    }
    this.chromeHideTimer = setTimeout(() => {
      if (this.shareMenuOpen) {
        this.chromeHideTimer = null;
        return;
      }
      this.chromeVisible = false;
      this.chromeHideTimer = null;
      this.cdr.markForCheck();
    }, delayMs);
  }

  private clearChromeHideTimer(): void {
    if (this.chromeHideTimer != null) {
      clearTimeout(this.chromeHideTimer);
      this.chromeHideTimer = null;
    }
  }

  private clearPlayDeferTimer(): void {
    if (this.playDeferTimer != null) {
      clearTimeout(this.playDeferTimer);
      this.playDeferTimer = null;
    }
  }

  private schedulePlayDefer(fn: () => void, ms: number): void {
    this.clearPlayDeferTimer();
    this.playDeferTimer = setTimeout(() => {
      this.playDeferTimer = null;
      if (!this.pageAlive) {
        return;
      }
      fn();
    }, ms);
  }

  openGlobalFilter(): void {
    this.globalFilterPreference = {
      applyToAllTabs: this.applyGlobalFilterToAllTabs,
      stationQuery: this.stationQuery,
      country: this.selectedCountry || 'all',
      tag: this.selectedTag || ''
    };
    this.ensureTagsLoaded();
    this.globalFilterOpen = true;
    this.shareMenuOpen = false;
    this.cdr.markForCheck();
  }

  closeGlobalFilter(): void {
    this.globalFilterOpen = false;
    this.cdr.markForCheck();
  }

  onGlobalFilterCountryChanged(country: string): void {
    this.ensureTagsLoaded((country || 'all').toLowerCase());
  }

  onGlobalFilterApplied(pref: RadioFilterPreference): void {
    this.applyFilterPreference(pref);
  }

  onGlobalFilterCleared(pref: RadioFilterPreference): void {
    this.applyFilterPreference(pref);
  }

  private applyFilterPreference(pref: RadioFilterPreference): void {
    this.applyGlobalFilterToAllTabs = !!pref.applyToAllTabs;
    this.stationQuery = pref.stationQuery || '';
    this.selectedTag = pref.tag || '';
    const nextCountry = (pref.country || 'all').toLowerCase();
    const countryChanged = this.selectedCountry !== nextCountry;
    this.selectedCountry = nextCountry;
    if (countryChanged) {
      this.tags = [];
      this.tagsLoadCountry = '';
      this.loadCatalogCount();
    }
    this.catalogPage = 1;
    this.favoritesPage = 1;
    this.podcastsPage = 1;
    this.globalFilterOpen = false;
    this.tagsLoadCountry = '';
    this.ensureTagsLoaded();
    this.loadStations();
    if (this.listMode === 'podcasts' && this.podcastBrowse === 'shows') {
      this.loadPodcastShows();
    }
    this.cdr.markForCheck();
  }

  onSidebarFilterChange(): void {
    this.catalogPage = 1;
    this.favoritesPage = 1;
    this.podcastsPage = 1;
    // Do not markForCheck here — ngModel already dirty-checks; marking every keystroke
    // plus debounce timers can trip NG0103 infinite CD in Angular 21.
    this.stationSearch$.next(this.catalogStationSearchQuery());
  }

  clearSidebarFilter(): void {
    if (!this.sidebarFilterQuery) {
      return;
    }
    this.sidebarFilterQuery = '';
    this.onSidebarFilterChange();
  }

  /** Station text sent to worldwide catalog search (global + sidebar). */
  private catalogStationSearchQuery(): string {
    const parts: string[] = [];
    const pushUnique = (value: string) => {
      const v = (value || '').trim();
      if (v.length < 2) {
        return;
      }
      if (parts.some((p) => p.toLowerCase() === v.toLowerCase())) {
        return;
      }
      parts.push(v);
    };
    pushUnique(this.stationQuery);
    pushUnique(this.sidebarFilterQuery);
    return parts.join(' ').trim();
  }

  setListMode(mode: RadioListMode): void {
    if (this.listMode === mode) {
      return;
    }
    this.listMode = mode;
    this.countryMenuOpen = false;
    this.catalogPage = 1;
    this.favoritesPage = 1;
    this.podcastsPage = 1;
    if (!this.applyGlobalFilterToAllTabs && mode !== 'catalog') {
      // Keep global station query only when apply-to-all is on.
    }
    if (mode === 'catalog') {
      this.ensureTagsLoaded();
      if (!this.stations.length && !this.isLoadingStations) {
        this.loadStations();
      }
    } else if (mode === 'podcasts') {
      if (!this.podcastStations.length) {
        this.loadPodcastStations();
      }
      if (this.podcastBrowse === 'shows') {
        this.loadPodcastShows();
      }
    }
    this.cdr.markForCheck();
  }

  onPodcastStationChange(): void {
    this.podcastBrowse = 'shows';
    this.selectedPodcastShow = null;
    this.podcastEpisodes = [];
    this.stationQuery = '';
    this.podcastsPage = 1;
    this.loadPodcastShows();
  }

  openPodcastShow(show: RadioFrancePodcastShow): void {
    if (!show?.slug) {
      return;
    }
    this.selectedPodcastShow = show;
    this.podcastBrowse = 'episodes';
    this.stationQuery = '';
    this.podcastsPage = 1;
    this.loadPodcastEpisodes(show);
  }

  backToPodcastShows(): void {
    this.podcastBrowse = 'shows';
    this.selectedPodcastShow = null;
    this.podcastEpisodes = [];
    this.podcastsError = '';
    this.podcastsPage = 1;
    this.loadPodcastShows();
  }

  selectPodcastEpisode(episode: RadioFrancePodcastEpisode): void {
    const station = this.episodeToRadioStation(episode);
    this.selectStation(station);
  }

  trackByPodcastShowId(_index: number, show: RadioFrancePodcastShow): string {
    return show.id || show.slug || String(_index);
  }

  trackByPodcastEpisodeId(_index: number, ep: RadioFrancePodcastEpisode): string {
    return ep.id || ep.streamUrl || String(_index);
  }

  formatPodcastDuration(sec?: number | null): string {
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0) {
      return '';
    }
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = Math.floor(n % 60);
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  formatPodcastDate(raw?: string | null): string {
    if (!raw) {
      return '';
    }
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      return raw;
    }
    try {
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return raw;
    }
  }

  episodeToRadioStation(episode: RadioFrancePodcastEpisode): RadioStation {
    const showTitle = episode.showTitle || this.selectedPodcastShow?.title || '';
    return {
      id: episode.id,
      name: episode.title,
      logo: episode.image || this.selectedPodcastShow?.image || '',
      tags: showTitle ? `Radio France,${showTitle}` : 'Radio France',
      country: 'fr',
      streamUrl: episode.streamUrl,
      codec: episode.codec || 'M4A',
      language: 'fr',
      homepage: episode.homepage || this.selectedPodcastShow?.homepage || ''
    };
  }

  private loadPodcastStations(): void {
    this.api.getRadioFrancePodcastStations().pipe(catchError(() => of([]))).subscribe((rows) => {
      if (!this.pageAlive) {
        return;
      }
      this.podcastStations = Array.isArray(rows) ? rows : [];
      if (!this.podcastStations.some((s) => s.id === this.podcastStation) && this.podcastStations.length) {
        this.podcastStation = this.podcastStations[0].id;
      }
      this.cdr.markForCheck();
    });
  }

  private loadPodcastShows(): void {
    this.podcastShowsSub?.unsubscribe();
    this.isLoadingPodcasts = true;
    this.podcastsError = '';
    this.cdr.markForCheck();
    const q = this.stationQuery.trim();
    this.podcastShowsSub = this.api
      .getRadioFrancePodcastShows(this.podcastStation, q || undefined)
      .pipe(
        catchError(() => {
          this.podcastsError = 'RADIO.ERR_PODCASTS';
          return of({ station: this.podcastStation, total: 0, shows: [] as RadioFrancePodcastShow[] });
        })
      )
      .subscribe((res) => {
        this.podcastShows = res?.shows || [];
        this.isLoadingPodcasts = false;
        this.cdr.markForCheck();
      });
  }

  private loadPodcastEpisodes(show: RadioFrancePodcastShow): void {
    this.podcastEpisodesSub?.unsubscribe();
    this.isLoadingPodcasts = true;
    this.podcastsError = '';
    this.podcastEpisodes = [];
    this.cdr.markForCheck();
    this.podcastEpisodesSub = this.api
      .getRadioFrancePodcastEpisodes(show.station || this.podcastStation, show.slug, 60)
      .pipe(
        catchError(() => {
          this.podcastsError = 'RADIO.ERR_PODCAST_EPISODES';
          return of({
            station: this.podcastStation,
            slug: show.slug,
            total: 0,
            episodes: [] as RadioFrancePodcastEpisode[],
            show
          });
        })
      )
      .subscribe((res) => {
        this.podcastEpisodes = res?.episodes || [];
        if (res?.show) {
          this.selectedPodcastShow = { ...show, ...res.show };
        }
        this.isLoadingPodcasts = false;
        this.cdr.markForCheck();
      });
  }

  toggleCountryMenu(event?: Event): void {
    event?.stopPropagation();
    this.countryMenuOpen = !this.countryMenuOpen;
    if (this.countryMenuOpen) {
      this.countryFilter = '';
    }
  }

  selectCountry(code: string, event?: Event): void {
    event?.stopPropagation();
    this.countryMenuOpen = false;
    const next = (code || 'all').toLowerCase();
    if (this.selectedCountry === next) {
      return;
    }
    this.selectedCountry = next;
    this.selectedTag = '';
    this.tags = [];
    this.tagsLoadCountry = '';
    this.catalogPage = 1;
    this.loadCatalogCount();
    this.loadStations();
    this.ensureTagsLoaded();
  }

  selectedCountryName(): string {
    if (this.isAllCountries) {
      return this.translate.instant('RADIO.COUNTRY_ALL');
    }
    const found = this.countries.find((c) => c.code === this.selectedCountry);
    return found?.name || this.selectedCountry.toUpperCase();
  }

  countryFlagCode(code?: string | null): string | null {
    const c = (code || '').trim().toLowerCase();
    return /^[a-z]{2}$/.test(c) ? c : null;
  }

  countryLabel(code?: string | null): string {
    const c = (code || '').trim().toLowerCase();
    if (!c) {
      return '';
    }
    const found = this.countries.find((x) => x.code === c);
    return found?.name || c.toUpperCase();
  }

  onTagChange(): void {
    this.catalogPage = 1;
    this.loadStations();
  }

  onStationSearchInput(value: string): void {
    this.stationQuery = value || '';
    this.catalogPage = 1;
    this.favoritesPage = 1;
    this.podcastsPage = 1;
    this.stationSearch$.next(this.catalogStationSearchQuery());
  }

  clearStationSearch(): void {
    this.stationQuery = '';
    this.catalogPage = 1;
    this.favoritesPage = 1;
    this.podcastsPage = 1;
    this.stationSearch$.next(this.catalogStationSearchQuery());
  }

  trackByStationId(_index: number, st: RadioStation): string {
    return st.id || st.streamUrl || String(_index);
  }

  /** Continuous 1-based index across paginated lists. */
  listItemNumber(indexZeroBased: number): number {
    const size = Math.max(1, this.listPageSize);
    if (this.listMode === 'favorites') {
      return (Math.max(1, this.favoritesPage) - 1) * size + indexZeroBased + 1;
    }
    if (this.listMode === 'podcasts') {
      return (Math.max(1, this.podcastsPage) - 1) * size + indexZeroBased + 1;
    }
    if (this.listMode === 'catalog') {
      return (Math.max(1, this.catalogPage) - 1) * size + indexZeroBased + 1;
    }
    return indexZeroBased + 1;
  }

  catalogPrevPage(): void {
    if (this.catalogPage <= 1 || this.isLoadingStations) {
      return;
    }
    this.catalogPage -= 1;
    this.cdr.markForCheck();
  }

  catalogNextPage(): void {
    if (this.catalogPage >= this.effectiveCatalogPages || this.isLoadingStations) {
      return;
    }
    this.catalogPage += 1;
    this.cdr.markForCheck();
  }

  favoritesPrevPage(): void {
    if (this.favoritesPage <= 1) {
      return;
    }
    this.favoritesPage -= 1;
    this.cdr.markForCheck();
  }

  favoritesNextPage(): void {
    if (this.favoritesPage >= this.favoritesPages) {
      return;
    }
    this.favoritesPage += 1;
    this.cdr.markForCheck();
  }

  podcastsPrevPage(): void {
    if (this.podcastsPage <= 1) {
      return;
    }
    this.podcastsPage -= 1;
    this.cdr.markForCheck();
  }

  podcastsNextPage(): void {
    if (this.podcastsPage >= this.podcastsPages) {
      return;
    }
    this.podcastsPage += 1;
    this.cdr.markForCheck();
  }

  primaryTag(station: RadioStation | null | undefined): string {
    if (!station?.tags) {
      return '';
    }
    return station.tags.split(',')[0]?.trim() || '';
  }

  stationLogo(station: RadioStation | null | undefined): string | null {
    const logo = (station?.logo || '').trim();
    if (!logo || logo === 'null' || logo === 'undefined') {
      return null;
    }
    if (!(logo.startsWith('http://') || logo.startsWith('https://'))) {
      return null;
    }
    return logo;
  }

  isFavorite(station: RadioStation): boolean {
    return !!station?.id && this.favoriteIds.has(station.id);
  }

  isFavoriteId(id?: string | null): boolean {
    return !!id && this.favoriteIds.has(id);
  }

  /** First N favorites mapped to physical-style preset buttons on the radio face. */
  get presetSlots(): (RadioStation | null)[] {
    const slots: (RadioStation | null)[] = [];
    for (let i = 0; i < RadioWatcherComponent.PRESET_COUNT; i++) {
      slots.push(this.favorites[i] || null);
    }
    return slots;
  }

  playPreset(station: RadioStation | null, event?: Event): void {
    event?.stopPropagation();
    if (!station) {
      if (!this.isLoggedIn) {
        this.favoritesHint = 'RADIO.FAVORITES_LOGIN';
      } else {
        this.setListMode('favorites');
      }
      this.cdr.markForCheck();
      return;
    }
    this.selectStation(station);
  }

  shortPresetName(station: RadioStation): string {
    const name = (station?.name || '').trim();
    if (!name) {
      return '—';
    }
    if (name.length <= 7) {
      return name;
    }
    return `${name.slice(0, 6)}…`;
  }

  presetTitle(station: RadioStation | null, index: number): string {
    const n = index + 1;
    if (station?.name) {
      return this.translate.instant('RADIO.PRESET_PLAY', { n, name: station.name });
    }
    return this.translate.instant('RADIO.PRESET_EMPTY', { n });
  }

  private readonly onDeviceVolumeUi = (event: Event): void => {
    const raw = Number((event as CustomEvent<number>).detail);
    if (!Number.isFinite(raw)) {
      return;
    }
    this.followDeviceVolume = true;
    this.volumePercent = Math.max(0, Math.min(100, Math.round(raw)));
    this.isMuted = this.volumePercent === 0;
    this.cdr.markForCheck();
  };

  canTune(direction: 'next' | 'previous'): boolean {
    return !!adjacentRadioStation(direction, this.selectedStation, this.favorites, this.stations);
  }

  tuneAdjacent(direction: 'next' | 'previous', event?: Event): void {
    event?.stopPropagation();
    const station = adjacentRadioStation(direction, this.selectedStation, this.favorites, this.stations);
    if (!station) {
      return;
    }
    this.selectStation(station as RadioStation);
  }

  private readonly onBluetoothTune = (event: Event): void => {
    const owner = activeScreenKeepAliveOwner();
    if (!this.pageAlive || this.radioPlayer.isOpen || owner === 'youtube' || owner === 'deezer' || owner === 'clip') {
      return;
    }
    const action = (event as CustomEvent<string>).detail;
    if (action !== 'next' && action !== 'previous') {
      return;
    }
    if (!claimRadioTune()) {
      return;
    }
    const station = adjacentRadioStation(action, this.selectedStation, this.favorites, this.stations);
    if (!station) {
      return;
    }
    this.selectStation(station as RadioStation);
  };

  selectStation(station: RadioStation): void {
    if (!station) {
      return;
    }
    if (this.isFloatingOpen) {
      this.radioPlayer.setStation(station);
      this.selectedStation = station;
      this.persistLastStation(station);
      this.syncLandscapeFullscreen();
      this.cdr.markForCheck();
      return;
    }
    this.selectedStation = station;
    this.playError = '';
    this.chromeVisible = this.pointerOverRadio || this.focusMode || this.stageFullscreen;
    this.persistLastStation(station);
    this.playStation(station);
    this.syncLandscapeFullscreen();
  }

  stopPlayback(): void {
    this.isReconnecting = false;
    this.destroyPlayer();
    this.selectedStation = null;
    this.playError = '';
    this.isBuffering = false;
    this.syncLandscapeFullscreen();
    this.cdr.markForCheck();
  }

  /** Artist and title of the track on air, for a YouTube search. */
  get youtubeSearchQuery(): string {
    const artist = this.nowPlayingArtist.trim();
    const title = this.nowPlayingTitle.trim();
    if (artist && title) {
      return title.toLowerCase().includes(artist.toLowerCase()) ? title : `${artist} ${title}`;
    }
    return artist || title;
  }

  openOnYoutube(): void {
    const q = this.youtubeSearchQuery;
    if (!q) {
      return;
    }
    void this.router.navigate(['/tools/youtube'], { queryParams: { q } });
  }

  openFloatingWindow(): void {
    if (!this.selectedStation) {
      return;
    }
    const station = this.selectedStation;
    this.playbackGuard?.dispose();
    this.playbackGuard = null;
    this.radioPlayer.openFloating(station);
    this.syncLandscapeFullscreen();
    this.cdr.markForCheck();
  }

  closeFloatingWindow(): void {
    this.radioPlayer.close();
    this.syncLandscapeFullscreen();
    this.cdr.markForCheck();
  }

  toggleMute(): void {
    const media = this.liveAudio;
    if (!media) {
      return;
    }
    if (media.muted || this.isMuted || this.volumePercent <= 0) {
      media.muted = false;
      this.isMuted = false;
      if (this.volumePercent <= 0) {
        this.volumePercent = 60;
        media.volume = 0.6;
      }
    } else {
      media.muted = true;
      this.isMuted = true;
    }
    this.showChrome(true);
    this.cdr.markForCheck();
  }

  onVolumeSlider(percent: number): void {
    const media = this.liveAudio;
    const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    this.volumePercent = p;
    if (setDeviceMediaVolume(p)) {
      this.followDeviceVolume = true;
      if (media) {
        media.muted = p === 0;
        media.volume = p === 0 ? 0 : 1;
        this.isMuted = media.muted;
      }
      this.showChrome(true);
      return;
    }
    if (media) {
      media.volume = p / 100;
      media.muted = p === 0;
      this.isMuted = media.muted;
    }
    this.showChrome(true);
  }

  onMediaVolumeChange(): void {
    if (this.followDeviceVolume) {
      return;
    }
    const media = this.liveAudio;
    if (!media) {
      return;
    }
    this.isMuted = !!media.muted;
    this.volumePercent = Math.round((media.muted ? 0 : media.volume) * 100);
    this.cdr.markForCheck();
  }

  private forceAudible(media: HTMLMediaElement): void {
    media.muted = false;
    this.isMuted = false;
    if (media.volume === 0 || this.volumePercent <= 0) {
      this.volumePercent = 80;
      media.volume = 0.8;
      return;
    }
    media.volume = this.volumePercent / 100;
  }

  ensureSound(event?: Event): void {
    event?.stopPropagation();
    const media = this.liveAudio;
    if (!media) {
      return;
    }
    media.muted = false;
    this.isMuted = false;
    if (media.volume === 0 || this.volumePercent === 0) {
      media.volume = 0.8;
      this.volumePercent = 80;
    }
    void media.play().catch(() => undefined);
    this.showChrome(true);
  }

  toggleFavorite(station: RadioStation, event?: Event): void {
    event?.stopPropagation();
    if (!station?.id) {
      return;
    }
    if (!this.isLoggedIn) {
      this.favoritesHint = 'RADIO.FAVORITES_LOGIN';
      this.cdr.markForCheck();
      return;
    }
    this.favoritesHint = '';
    this.favoriteBusyId = station.id;
    const busyId = station.id;
    const req = this.isFavorite(station)
      ? this.api.removeRadioFavorite(station.id)
      : this.api.addRadioFavorite(station);
    req.subscribe({
      next: (fav) => {
        if (!this.pageAlive) {
          return;
        }
        this.applyFavorites(fav?.stations || []);
        this.favoriteBusyId = this.favoriteBusyId === busyId ? '' : this.favoriteBusyId;
        this.cdr.markForCheck();
      },
      error: () => {
        if (!this.pageAlive) {
          return;
        }
        this.favoritesError = 'RADIO.ERR_FAVORITES_SAVE';
        this.favoriteBusyId = this.favoriteBusyId === busyId ? '' : this.favoriteBusyId;
        this.cdr.markForCheck();
      }
    });
  }

  toggleShareMenu(event?: Event): void {
    event?.stopPropagation();
    this.shareMenuOpen = !this.shareMenuOpen;
    this.showChrome(true);
  }

  async shareNative(): Promise<void> {
    if (!this.selectedStation || !this.canNativeShare) {
      return;
    }
    const url = this.buildShareUrl(this.selectedStation, { publicLink: true });
    const intro = this.translate.instant('RADIO.SHARE_TEXT', { name: this.selectedStation.name });
    // URL once in text only — ShareData.url would duplicate it in WhatsApp.
    const text = `${intro}\n\n${url}`;
    try {
      await navigator.share({ title: this.selectedStation.name, text });
      this.shareMenuOpen = false;
    } catch {
      // user cancelled
    }
  }

  shareWhatsApp(): void {
    if (!this.selectedStation) {
      return;
    }
    const url = this.buildShareUrl(this.selectedStation, { publicLink: true });
    const intro = this.translate.instant('RADIO.SHARE_TEXT', { name: this.selectedStation.name });
    const text = `${intro}\n\n${url}`;
    window.open(
      'https://wa.me/?text=' + encodeURIComponent(text),
      '_blank',
      'noopener'
    );
    this.shareMenuOpen = false;
  }

  async copyShareLink(): Promise<void> {
    if (!this.selectedStation) {
      return;
    }
    const url = this.buildShareUrl(this.selectedStation, { publicLink: true });
    try {
      await navigator.clipboard.writeText(url);
      this.setShareFeedback('RADIO.SHARE_COPIED');
    } catch {
      this.setShareFeedback('RADIO.SHARE_COPY_FAILED');
    }
    this.shareMenuOpen = false;
  }

  private setShareFeedback(key: string): void {
    this.shareFeedback = key;
    this.clearShareFeedbackTimer();
    this.shareFeedbackTimer = setTimeout(() => {
      this.shareFeedback = '';
      this.shareFeedbackTimer = null;
      this.cdr.markForCheck();
    }, 2200);
    this.cdr.markForCheck();
  }

  private clearShareFeedbackTimer(): void {
    if (this.shareFeedbackTimer != null) {
      clearTimeout(this.shareFeedbackTimer);
      this.shareFeedbackTimer = null;
    }
  }

  private buildShareUrl(station: RadioStation, opts?: { publicLink?: boolean }): string {
    const stream = (station.streamUrl || '').trim();
    // Never put bare http(s):// stream URLs in the query — WhatsApp truncates the link.
    const includeStream =
      !!stream &&
      stream.length <= RadioWatcherComponent.SHARE_STREAM_MAX_LEN &&
      !/:\/\//i.test(stream);
    return buildRadioShareLink(
      {
        station: station.id || '',
        stream: includeStream ? stream : undefined
      },
      opts
    );
  }

  private tryOpenSharedStationFromQuery(): boolean {
    const id = (this.route.snapshot.queryParamMap.get('station') || '').trim();
    if (!id) {
      return false;
    }
    this.pendingShareStationId = id;
    this.listMode = 'catalog';
    return true;
  }

  private resumePagePlayback(station: RadioStation): void {
    if (!station || this.radioPlayer.isOpen) {
      return;
    }
    this.radioPlayer.clearPendingResume();
    this.selectedStation = station;
    this.playError = '';
    this.schedulePlayDefer(() => {
      if (!this.radioPlayer.isOpen) {
        this.playStation(station, 'restore');
      }
    }, 0);
    this.syncLandscapeFullscreen();
    this.cdr.markForCheck();
  }

  private loadCountries(): void {
    this.isLoadingCountries = true;
    this.countriesError = '';
    this.api.getRadioCountries().subscribe({
      next: (list) => {
        if (!this.pageAlive) {
          return;
        }
        this.countries = list || [];
        this.isLoadingCountries = false;
        if (this.isAllCountries) {
          this.applyWorldwideCountFromCountries();
        }
        this.cdr.markForCheck();
      },
      error: () => {
        if (!this.pageAlive) {
          return;
        }
        this.countriesError = 'RADIO.ERR_COUNTRIES';
        this.isLoadingCountries = false;
        this.cdr.markForCheck();
      }
    });
  }

  private loadCatalogCount(): void {
    this.catalogCountSub?.unsubscribe();
    if (this.isAllCountries) {
      if (this.countries.length) {
        this.applyWorldwideCountFromCountries();
        return;
      }
      // Count comes with countries; keep badge spinner until then.
      this.isLoadingCatalogCount = true;
      this.cdr.markForCheck();
      return;
    }
    this.isLoadingCatalogCount = true;
    this.catalogCountSub = this.api.getRadioStationCount(this.selectedCountry).subscribe({
      next: (res) => {
        this.catalogTotalCount = res?.count || 0;
        this.isLoadingCatalogCount = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.catalogTotalCount = 0;
        this.isLoadingCatalogCount = false;
        this.cdr.markForCheck();
      }
    });
  }

  private applyWorldwideCountFromCountries(): void {
    this.catalogTotalCount = (this.countries || []).reduce(
      (sum, c) => sum + (Number(c.stationCount) || 0),
      0
    );
    this.isLoadingCatalogCount = false;
  }

  private loadStations(): void {
    this.stationsSub?.unsubscribe();
    this.stationsError = '';
    this.worldwideSearchHint = false;

    const searchQ = this.catalogStationSearchQuery();
    if (this.isAllCountries) {
      const tag = this.selectedTag.trim();
      if (searchQ.length < 2 && !tag) {
        this.stations = [];
        this.searchMatchTotal = null;
        this.searchListTruncated = false;
        this.catalogPages = 1;
        this.worldwideSearchHint = true;
        this.isLoadingStations = false;
        this.tryResolvePendingShare();
        this.cdr.markForCheck();
        return;
      }
    }

    this.isLoadingStations = true;
    const q = searchQ || undefined;
    const tag = this.selectedTag.trim() || undefined;
    if (this.isAllCountries) {
      this.stationsSub = this.api.getRadioStationsWorldwide(q, tag).subscribe({
        next: (page) => {
          this.stations = page?.stations || [];
          this.searchMatchTotal = Math.max(0, Number(page?.total) || 0);
          this.searchListTruncated = !!page?.truncated;
          this.catalogPages = Math.max(
            1,
            Math.ceil(this.stations.length / Math.max(1, this.listPageSize))
          );
          if (this.catalogPage > this.catalogPages) {
            this.catalogPage = this.catalogPages;
          }
          this.isLoadingStations = false;
          this.tryResolvePendingShare();
          this.cdr.markForCheck();
        },
        error: () => {
          this.stations = [];
          this.searchMatchTotal = null;
          this.searchListTruncated = false;
          this.catalogPages = 1;
          this.stationsError = 'RADIO.ERR_STATIONS';
          this.isLoadingStations = false;
          this.cdr.markForCheck();
        }
      });
      return;
    }

    this.searchMatchTotal = null;
    this.searchListTruncated = false;
    this.stationsSub = this.api.getRadioStations(this.selectedCountry, q, tag).subscribe({
      next: (list) => {
        this.stations = list || [];
        this.catalogPages = Math.max(
          1,
          Math.ceil(this.stations.length / Math.max(1, this.listPageSize))
        );
        if (this.catalogPage > this.catalogPages) {
          this.catalogPage = this.catalogPages;
        }
        this.isLoadingStations = false;
        this.ensureTagsLoaded();
        this.tryResolvePendingShare();
        this.cdr.markForCheck();
      },
      error: () => {
        this.stations = [];
        this.catalogPages = 1;
        this.stationsError = 'RADIO.ERR_STATIONS';
        this.isLoadingStations = false;
        this.cdr.markForCheck();
      }
    });
  }

  private tagsLoadCountry = '';

  private ensureTagsLoaded(forCountry?: string): void {
    const country = (forCountry || this.selectedCountry || 'all').toLowerCase();
    if (this.tagsLoadCountry === country && this.tags.length > 0) {
      return;
    }
    this.tagsLoadCountry = country;
    this.loadTags(country);
  }

  private loadTags(countryOverride?: string): void {
    const country = (countryOverride || this.selectedCountry || 'all').toLowerCase();
    this.api.getRadioTags(country).pipe(catchError(() => of([] as string[]))).subscribe((tags) => {
      if (!this.pageAlive || this.tagsLoadCountry !== country) {
        return;
      }
      this.tags = tags || [];
      this.tagsLoadCountry = country;
      this.cdr.markForCheck();
    });
  }

  private loadFavorites(): void {
    if (!this.isLoggedIn) {
      this.favorites = [];
      this.favoriteIds = new Set();
      this.radioPlayer.setFavorites([]);
      this.favoritesHint = 'RADIO.FAVORITES_LOGIN';
      return;
    }
    this.isLoadingFavorites = true;
    this.favoritesError = '';
    this.favoritesHint = '';
    this.api.getRadioFavorites().subscribe({
      next: (fav) => {
        if (!this.pageAlive) {
          return;
        }
        this.applyFavorites(fav?.stations || []);
        this.isLoadingFavorites = false;
        this.cdr.markForCheck();
      },
      error: () => {
        if (!this.pageAlive) {
          return;
        }
        this.favoritesError = 'RADIO.ERR_FAVORITES_LOAD';
        this.isLoadingFavorites = false;
        this.cdr.markForCheck();
      }
    });
  }

  private applyFavorites(stations: RadioStation[]): void {
    this.favorites = stations || [];
    this.favoriteIds = new Set(this.favorites.map((s) => s.id).filter(Boolean));
    this.radioPlayer.setFavorites(this.favorites);
  }

  private tryResolvePendingShare(): void {
    if (!this.pendingShareStationId) {
      return;
    }
    const id = this.pendingShareStationId;
    const found =
      this.stations.find((s) => s.id === id) ||
      this.favorites.find((s) => s.id === id);
    if (found) {
      this.pendingShareStationId = '';
      this.selectStation(found);
      return;
    }
    this.api.getRadioStationById(id).pipe(catchError(() => of(null))).subscribe((st) => {
      if (!this.pageAlive) {
        return;
      }
      if (st) {
        this.pendingShareStationId = '';
        this.selectStation(st);
        this.cdr.markForCheck();
      }
    });
  }

  private restoreLastPlayedStation(): void {
    if (this.restoredLastStation || this.selectedStation || this.radioPlayer.isOpen) {
      return;
    }
    const local = this.readLocalLastStation();
    if (local) {
      this.restoredLastStation = true;
      this.selectedStation = local;
      this.schedulePlayDefer(() => {
        if (!this.radioPlayer.isOpen) {
          this.playStation(local, 'restore');
        }
      }, 0);
      this.syncLandscapeFullscreen();
    }
    if (this.isLoggedIn) {
      this.api.getRadioLastStation().pipe(catchError(() => of(null))).subscribe((st) => {
        if (!this.pageAlive) {
          return;
        }
        if (st && !this.restoredLastStation && !this.radioPlayer.isOpen) {
          this.restoredLastStation = true;
          this.selectedStation = st;
          this.schedulePlayDefer(() => {
            if (!this.radioPlayer.isOpen) {
              this.playStation(st, 'restore');
            }
          }, 0);
          this.syncLandscapeFullscreen();
          this.cdr.markForCheck();
        } else if (st) {
          this.writeLocalLastStation(st);
        }
      });
    }
  }

  private persistLastStation(station: RadioStation): void {
    this.writeLocalLastStation(station);
    if (!this.isLoggedIn) {
      return;
    }
    this.lastStationSaveSub?.unsubscribe();
    this.lastStationSaveSub = this.api.saveRadioLastStation(station).pipe(catchError(() => of(null))).subscribe();
  }

  private readLocalLastStation(): RadioStation | null {
    try {
      const raw = localStorage.getItem(RadioWatcherComponent.LAST_STATION_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as RadioStation;
      if (!parsed?.streamUrl || !parsed?.name) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private writeLocalLastStation(station: RadioStation): void {
    try {
      localStorage.setItem(RadioWatcherComponent.LAST_STATION_STORAGE_KEY, JSON.stringify(station));
    } catch {
      // ignore quota
    }
  }

  private liveShouldSurviveLeave(): boolean {
    return this.radioPlayer.isOpen;
  }

  /** The shared element is already playing this station. Do not reopen the stream. */
  private continuePageLive(station: RadioStation, media: HTMLAudioElement): void {
    this.nowPlaying.watch('page', station);
    if (!this.playbackGuard) {
      const gen = this.playGeneration;
      this.playbackGuard = attachRadioPlaybackGuard({
        media,
        isCurrent: () => this.pageAlive && gen === this.playGeneration && !this.radioPlayer.isOpen,
        reload: () => {
          if (!this.pageAlive || gen !== this.playGeneration || this.radioPlayer.isOpen) {
            return;
          }
          this.playStation(station, 'reconnect');
        },
        onReconnecting: () => this.noteRadioReconnect(gen)
      });
    }
    this.isBuffering = false;
    this.playError = '';
    this.forceAudible(media);
    void media.play().catch(() => undefined);
    void this.engageEqualizer(media);
    this.cdr.markForCheck();
  }

  private playStation(station: RadioStation, reason: 'user' | 'reconnect' | 'restore' = 'user'): void {
    const media = this.liveAudio;
    if (this.pageAlive && media && this.equalizer.wantsProcessing && !this.radioPlayer.isOpen) {
      void this.equalizer.resume();
      this.equalizer.engageMedia(media);
    }
    if (!this.pageAlive || !media || !station?.streamUrl || this.radioPlayer.isOpen) {
      return;
    }
    if (reason !== 'reconnect' && this.radioPlayer.isLive(media, station)) {
      this.continuePageLive(station, media);
      return;
    }
    this.destroyPlayer(false, { keepPip: reason === 'reconnect', handoffNowPlaying: true });
    this.nowPlaying.watch('page', station);
    if (!this.pageAlive) {
      return;
    }
    delete media.dataset['patSkipBackground'];
    media.dataset['patStationId'] = this.radioPlayer.stationKey(station);
    if (reason !== 'reconnect') {
      this.isReconnecting = false;
    }
    const gen = ++this.playGeneration;
    this.playError = '';
    this.isBuffering = true;
    publishRadioTrack(media, { station: station.name, artworkUrl: station.logo });
    this.cdr.markForCheck();

    const proxyUrl = bustRadioStreamUrl(this.api.radioStreamProxyUrl(station.streamUrl));
    const isHls = this.isHlsStream(station);
    this.playbackGuard = attachRadioPlaybackGuard({
      media,
      isCurrent: () => this.pageAlive && gen === this.playGeneration,
      reload: () => {
        if (!this.pageAlive || gen !== this.playGeneration || this.radioPlayer.isOpen) {
          return;
        }
        this.playStation(station, 'reconnect');
      },
      onReconnecting: () => this.noteRadioReconnect(gen)
    });

    const onError = (message: string) => {
      if (gen !== this.playGeneration) {
        return;
      }
      this.playError = message || 'RADIO.ERR_STREAM';
      this.isBuffering = false;
      this.cdr.markForCheck();
    };

    const tryPlay = () => {
      if (gen !== this.playGeneration) {
        return;
      }
      this.forceAudible(media);
      void media.play().then(() => {
        if (gen !== this.playGeneration) {
          return;
        }
        this.clearPlaybackGesture();
        this.isBuffering = false;
        this.isReconnecting = false;
        void this.engageEqualizer(media);
        this.cdr.markForCheck();
      }).catch((err: unknown) => {
        if (gen !== this.playGeneration) {
          return;
        }
        const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
        if (name === 'NotAllowedError') {
          media.muted = true;
          void media.play().then(() => {
            if (gen !== this.playGeneration) {
              return;
            }
            this.forceAudible(media);
            this.isBuffering = false;
            this.isReconnecting = false;
            this.playError = '';
            void this.engageEqualizer(media);
            if (media.muted || media.paused) {
              this.armPlaybackGesture(station, gen, false);
            }
            this.cdr.markForCheck();
          }).catch(() => {
            if (gen !== this.playGeneration) {
              return;
            }
            if (reason === 'user') {
              onError('RADIO.ERR_PLAY');
              return;
            }
            // Bluetooth / lock screen: a tap may never come. Keep reopening
            // until the network is back, and also arm a tap as a backup.
            this.playbackGuard?.requestReconnect();
            this.armPlaybackGesture(station, gen, true);
          });
          return;
        }
        if (reason === 'restore' || reason === 'reconnect') {
          this.playbackGuard?.requestReconnect();
          this.armPlaybackGesture(station, gen, true);
          return;
        }
        this.playbackGuard?.requestReconnect();
      });
    };

    media.onwaiting = () => {
      if (gen === this.playGeneration) {
        this.isBuffering = true;
        this.cdr.markForCheck();
      }
    };
    media.onplaying = () => {
      if (gen === this.playGeneration) {
        this.clearPlaybackGesture();
        this.isBuffering = false;
        this.isReconnecting = false;
        this.playError = '';
        this.cdr.markForCheck();
      }
    };
    media.onerror = null;

    // HLS (.m3u8) — same path as TV
    if (isHls && Hls.isSupported()) {
      const hls = new Hls(createTvHlsConfig());
      this.hls = hls;
      hls.loadSource(proxyUrl);
      hls.attachMedia(media);
      hls.on(Hls.Events.MANIFEST_PARSED, () => tryPlay());
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (gen !== this.playGeneration) {
          return;
        }
        if (data.fatal && !tryRecoverTvHlsError(hls, data)) {
          this.playbackGuard?.requestReconnect();
        }
      });
      return;
    }

    if (isHls && media.canPlayType('application/vnd.apple.mpegurl')) {
      media.src = proxyUrl;
      tryPlay();
      return;
    }

    // Progressive Icecast / MP3 / AAC — streamed by backend (not buffered)
    media.src = proxyUrl;
    tryPlay();
  }

  /** HLS playlist vs progressive Icecast/MP3/AAC (or unresolved .m3u/.pls). */
  private isHlsStream(station: RadioStation): boolean {
    const url = (station.streamUrl || '').toLowerCase();
    const codec = (station.codec || '').toLowerCase();
    if (url.includes('.m3u8')) {
      return true;
    }
    if (codec.includes('mpegurl') || codec.includes('m3u8') || codec.includes('hls')) {
      return true;
    }
    return false;
  }

  private noteRadioReconnect(gen: number): void {
    if (!this.pageAlive || gen !== this.playGeneration) {
      return;
    }
    this.playError = '';
    this.isReconnecting = true;
    this.isBuffering = true;
    try {
      this.cdr.detectChanges();
    } catch {
      this.cdr.markForCheck();
    }
  }

  private destroyPlayer(clearSrc = true, options?: { keepPip?: boolean; handoffNowPlaying?: boolean; keepLive?: boolean }): void {
    if (options?.keepLive) {
      this.playbackGuard?.dispose();
      this.playbackGuard = null;
      this.playGeneration++;
      if (!options?.handoffNowPlaying) {
        this.nowPlaying.release('page');
      }
      return;
    }
    if (!options?.handoffNowPlaying) {
      this.nowPlaying.release('page');
    }
    const tearingDown = this.liveAudio;
    if (tearingDown) {
      tearingDown.dataset['patSkipBackground'] = '1';
    }
    this.playbackGuard?.dispose();
    this.playbackGuard = null;
    this.playGeneration++;
    this.clearPlayDeferTimer();
    if (!options?.keepPip && !this.radioPlayer.isOpen) {
      closeRadioDocPip();
      this.isPipActive = false;
      this.userOpenedPip = false;
    }
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        // ignore
      }
      this.hls = null;
    }
    const media = this.liveAudio;
    if (media) {
      media.onwaiting = null;
      media.onplaying = null;
      media.onerror = null;
      if (clearSrc) {
        resetTvMediaElement(media);
      } else {
        try {
          media.pause();
        } catch {
          // ignore
        }
        try {
          media.srcObject = null;
        } catch {
          // ignore
        }
      }
    }
  }

  dropTrackImage(index: number): void {
    if (index < 0 || index >= this.trackImages.length) {
      return;
    }
    this.trackImages = this.trackImages.filter((_, i) => i !== index);
    if (this.trackImageIndex >= this.trackImages.length) {
      this.trackImageIndex = 0;
    }
    this.syncTrackSlide();
    this.cdr.markForCheck();
  }

  trackImageUrl(_index: number, img: RadioTrackImage): string {
    return img?.url || '';
  }

  private applyNowPlaying(state: RadioNowPlaying | null): void {
    const label = (state?.label || '').trim();
    const images = (state?.images || []).filter((img) => !!img?.url);
    const songChanged = label !== this.nowPlayingLabel;
    const samePics = !songChanged
      && images.length === this.trackImages.length
      && images.every((img, i) => img.url === this.trackImages[i]?.url);
    this.nowPlayingLabel = label;
    this.nowPlayingTitle = (state?.title || '').trim();
    this.nowPlayingArtist = (state?.artist || '').trim();
    this.nowPlayingAlbum = (state?.album || '').trim();
    if (!samePics) {
      this.trackImages = images;
      this.trackImageIndex = 0;
      this.clearTrackSlide();
    }
    this.syncTrackSlide();
    this.pushNowPlayingSession();
    this.cdr.markForCheck();
  }

  private pushNowPlayingSession(): void {
    if (this.isFloatingOpen || !this.selectedStation || this.playError) {
      return;
    }
    const station = this.selectedStation;
    publishRadioTrack(this.liveAudio, {
      station: station.name,
      title: this.nowPlayingTitle,
      artist: this.nowPlayingArtist,
      album: this.nowPlayingAlbum,
      artworkUrl: this.trackImages[0]?.url || station.logo
    });
  }

  private syncTrackSlide(): void {
    if (this.trackImages.length < 2) {
      this.clearTrackSlide();
      this.trackImageIndex = 0;
      return;
    }
    if (this.trackSlideTimer) {
      return;
    }
    this.trackSlideTimer = setInterval(() => {
      if (!this.pageAlive || this.trackImages.length < 2) {
        this.clearTrackSlide();
        return;
      }
      this.trackImageIndex = (this.trackImageIndex + 1) % this.trackImages.length;
      this.cdr.markForCheck();
    }, 8000);
  }

  private clearTrackSlide(): void {
    if (this.trackSlideTimer) {
      clearInterval(this.trackSlideTimer);
      this.trackSlideTimer = null;
    }
  }

  formatPlayError(message: string | null | undefined): string {
    const m = (message || '').trim();
    if (!m) {
      return '';
    }
    if (m.startsWith('RADIO.')) {
      return this.translate.instant(m);
    }
    return m;
  }

  formatBitrate(station: RadioStation | null): string {
    if (!station?.bitrate || station.bitrate <= 0) {
      return '';
    }
    return `${station.bitrate} kbps`;
  }
}
