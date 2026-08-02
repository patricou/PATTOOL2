import {
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
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { forkJoin, Observable, Subject, Subscription, of } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, map, switchMap } from 'rxjs/operators';

import {
  ApiService,
  WebcamCodeLabel,
  WebcamFavorites,
  WebcamItem,
  WebcamSearchPage
} from '../services/api.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import { isValidGeoCoordinate } from '../shared/geo-coordinates.util';
import {
  startTvHlsPlayback,
  type TvHlsPlaybackHandle
} from '../tv-watcher/tv-hls-playback';
import { isProgressiveVod } from '../tv-watcher/tv-stream.util';
import {
  WebcamFilterPreference,
  WebcamGlobalFilterModalComponent
} from './webcam-global-filter-modal.component';

type PlayerMode = 'day' | 'live' | 'month' | 'image';
type WebcamCatalogTab = 'windy' | 'traffic' | 'europe';
type WebcamProviderTab = WebcamCatalogTab | 'favorites';

@Component({
  selector: 'app-webcam-watcher',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    TraceViewerModalComponent,
    WebcamGlobalFilterModalComponent
  ],
  templateUrl: './webcam-watcher.component.html',
  styleUrls: ['./webcam-watcher.component.css']
})
export class WebcamWatcherComponent implements OnInit, OnDestroy {
  @ViewChild(TraceViewerModalComponent) private traceViewerModal?: TraceViewerModalComponent;
  @ViewChild('wcStage') private stageRef?: ElementRef<HTMLElement>;
  @ViewChild('wcHlsVideo')
  set hlsVideoRef(ref: ElementRef<HTMLVideoElement> | undefined) {
    this.hlsVideo = ref;
    this.bindLandscapeVideoFsListener(ref?.nativeElement || null);
  }
  private hlsVideo?: ElementRef<HTMLVideoElement>;

  /**
   * Mobile landscape: immersive webcam stage (CSS + best-effort native fullscreen).
   * Set via HostBinding so the player can cover the viewport even if Fullscreen API is blocked.
   */
  @HostBinding('class.wc-landscape-fs') landscapeFullscreen = false;

  activeProvider: WebcamProviderTab = 'windy';

  /** Sidebar quick filter — client-side on the loaded list only. */
  sidebarFilterQuery = '';
  /** Server-side catalog search from the global filter modal. */
  catalogQuery = '';
  continent = '';
  country = '';
  category = '';
  sortKey: 'popularity' | 'createdOn' = 'popularity';
  nearbyRadiusKm = 100;
  useNearby = false;
  nearbyLat: number | null = null;
  nearbyLon: number | null = null;
  geoError = '';

  /** Road511 / NAPSPAN jurisdiction (e.g. CA, DE). */
  jurisdiction = 'CA';
  /** Prefer cameras that expose an HLS stream. */
  hasVideoOnly = false;

  globalFilterOpen = false;
  applyGlobalFilterToAllTabs = false;
  globalFilterPreference: WebcamFilterPreference = {};

  continents: WebcamCodeLabel[] = [];
  countries: WebcamCodeLabel[] = [];
  categories: WebcamCodeLabel[] = [];
  jurisdictions: WebcamCodeLabel[] = [];

  /** Raw catalog rows for the current global filters (before sidebar text). */
  listSource: WebcamItem[] = [];
  /** True when offset/page navigate inside listSource (Europe / Traffic / Favorites). */
  clientPaging = false;
  /** Server-reported total for Windy server paging. */
  private serverTotal = 0;

  items: WebcamItem[] = [];
  total = 0;
  offset = 0;
  readonly pageSize = 24;
  private static readonly CLIENT_FETCH_PAGE = 50;
  private static readonly CLIENT_FETCH_MAX = 500;

  favorites: WebcamItem[] = [];
  favoriteIds = new Set<string>();
  favoritesHint = '';
  favoritesError = '';
  favoriteBusyKey = '';
  isLoadingFavorites = false;

  selected: WebcamItem | null = null;
  selectedId = '';
  playerMode: PlayerMode = 'day';
  playerUrl: SafeResourceUrl | null = null;
  iframeGen = 0;
  hlsError = '';
  /** Stage title/actions bar: shown briefly, then collapses until hover. */
  headerExpanded = false;

  isLoading = false;
  isLoadingMeta = false;
  isLoadingDetail = false;
  isLoadingPlayer = false;
  listError = '';
  configured = true;
  trafficConfigured = true;
  europeConfigured = true;

  private static readonly HEADER_HIDE_MS = 3000;
  private static readonly LANDSCAPE_FS_BODY_CLASS = 'wc-landscape-fs';

  private search$ = new Subject<string>();
  private searchSub?: Subscription;
  private metaSub?: Subscription;
  private listSub?: Subscription;
  private detailSub?: Subscription;
  private langSub?: Subscription;
  private headerHideTimer: ReturnType<typeof setTimeout> | null = null;
  private headerPinnedByHover = false;
  /** Select the first listed webcam once the opening catalog is ready (if no last webcam). */
  private pendingAutoSelectFirst = true;
  private lastRestorePending = true;
  private restoredLastWebcam = false;
  private lastWebcamSaveSub?: Subscription;
  private favoritesSub?: Subscription;
  private favoriteToggleSub?: Subscription;
  private hlsHandle: TvHlsPlaybackHandle | null = null;
  private hlsStartTimer: ReturnType<typeof setTimeout> | null = null;

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
    private sanitizer: DomSanitizer,
    private translate: TranslateService,
    private keycloak: KeycloakService
  ) {}

  get isLoggedIn(): boolean {
    return this.keycloak.isLoggedIn();
  }

  ngOnInit(): void {
    // Sidebar text only refilters the already-loaded list (no server round-trip).
    this.searchSub = this.search$.pipe(debounceTime(200), distinctUntilChanged()).subscribe(() => {
      this.offset = 0;
      this.applyDisplayedList();
    });
    this.langSub = this.translate.onLangChange.subscribe(() => {
      if (this.activeProvider === 'windy') {
        this.loadMeta();
      }
      this.loadItems();
    });
    this.loadMeta();
    this.restoreLastWebcam();
    this.loadFavorites();
    // Default entry: webcams around the user (Europe fallback if geolocation fails).
    this.requestNearby({ initial: true });
    this.setupLandscapeFullscreenWatchers();
    this.syncLandscapeFullscreen();
  }

  ngOnDestroy(): void {
    this.teardownLandscapeFullscreenWatchers();
    this.exitLandscapeFullscreen(false);
    this.clearHeaderHideTimer();
    this.stopHls();
    this.lastWebcamSaveSub?.unsubscribe();
    this.favoritesSub?.unsubscribe();
    this.favoriteToggleSub?.unsubscribe();
    this.searchSub?.unsubscribe();
    this.metaSub?.unsubscribe();
    this.listSub?.unsubscribe();
    this.detailSub?.unsubscribe();
    this.langSub?.unsubscribe();
  }

  /** Exit immersive landscape webcam (portrait or explicit dismiss). */
  exitLandscapeFullscreen(markDismissed = true): void {
    if (markDismissed && this.landscapeFullscreen) {
      this.landscapeFsUserDismissed = true;
    }
    if (
      !this.landscapeFullscreen &&
      !document.body.classList.contains(WebcamWatcherComponent.LANDSCAPE_FS_BODY_CLASS)
    ) {
      this.landscapeFsSuppressDismiss = true;
      this.exitOwnedNativeFullscreen();
      this.landscapeFsSuppressDismiss = false;
      return;
    }
    this.landscapeFullscreen = false;
    document.body.classList.remove(WebcamWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
    this.landscapeFsSuppressDismiss = true;
    this.exitOwnedNativeFullscreen();
    // fullscreenchange is sync-ish on most browsers; clear on next tick.
    setTimeout(() => {
      this.landscapeFsSuppressDismiss = false;
    }, 0);
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
      (
        this.landscapeOrientationMql as MediaQueryList & {
          addListener?: (cb: () => void) => void;
        }
      ).addListener?.(this.onLandscapeOrientationMedia);
    }
    document.addEventListener('fullscreenchange', this.onLandscapeFsChange);
    document.addEventListener('webkitfullscreenchange', this.onLandscapeFsChange);
    this.bindLandscapeVideoFsListener(this.hlsVideo?.nativeElement || null);
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
      // Video may appear after orientation already flipped — try native FS again.
      if (this.landscapeFullscreen) {
        void this.requestLandscapeNativeFullscreen();
      }
    }
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
      this.isMobileLikeViewport() &&
      this.isLandscapeOrientation() &&
      !!this.selected &&
      !this.landscapeFsUserDismissed
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
    if (this.landscapeFullscreen && !this.selected) {
      this.exitLandscapeFullscreen(false);
    }
  }

  private enterLandscapeFullscreen(): void {
    if (!this.landscapeFullscreen) {
      this.landscapeFullscreen = true;
      document.body.classList.add(WebcamWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
      this.collapseHeader();
    } else {
      document.body.classList.add(WebcamWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
    }
    // Best-effort native FS (often blocked without a gesture — CSS mode still covers the screen).
    void this.requestLandscapeNativeFullscreen();
  }

  private async requestLandscapeNativeFullscreen(): Promise<void> {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      return;
    }

    const video = this.hlsVideo?.nativeElement as
      | (HTMLVideoElement & {
          webkitDisplayingFullscreen?: boolean;
          webkitEnterFullscreen?: () => void;
        })
      | undefined;

    if (video) {
      if (video.webkitDisplayingFullscreen) {
        return;
      }
      this.landscapeFsNativeRequested = true;
      try {
        if (typeof video.webkitEnterFullscreen === 'function') {
          video.webkitEnterFullscreen();
          return;
        }
        const wrap = video.closest('.wc-player-wrap') as HTMLElement | null;
        const target = wrap || video;
        const req =
          target.requestFullscreen?.bind(target) ||
          (
            target as HTMLElement & {
              webkitRequestFullscreen?: () => Promise<void> | void;
            }
          ).webkitRequestFullscreen?.bind(target);
        if (req) {
          await Promise.resolve(req());
        }
      } catch {
        // CSS immersive mode remains active.
      }
      return;
    }

    // iframe / still image: request FS on the player wrap when available.
    const wrap =
      this.stageRef?.nativeElement?.querySelector('.wc-player-wrap') as HTMLElement | null;
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
    const video = this.hlsVideo?.nativeElement as
      | (HTMLVideoElement & {
          webkitDisplayingFullscreen?: boolean;
          webkitExitFullscreen?: () => void;
        })
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
    const wrap =
      video?.closest('.wc-player-wrap') ||
      this.stageRef?.nativeElement?.querySelector('.wc-player-wrap') ||
      null;
    const owned =
      this.landscapeFsNativeRequested ||
      fsEl === video ||
      (!!wrap && (fsEl === wrap || wrap.contains(fsEl)));
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
    const video = this.hlsVideo?.nativeElement as
      | (HTMLVideoElement & { webkitDisplayingFullscreen?: boolean })
      | undefined;
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const fsEl = document.fullscreenElement || doc.webkitFullscreenElement || null;
    const wrap =
      video?.closest('.wc-player-wrap') ||
      this.stageRef?.nativeElement?.querySelector('.wc-player-wrap') ||
      null;
    const ours = !!(
      video?.webkitDisplayingFullscreen ||
      (fsEl && (fsEl === video || (wrap && (fsEl === wrap || wrap.contains(fsEl)))))
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

  get isFavorites(): boolean {
    return this.activeProvider === 'favorites';
  }

  get isTraffic(): boolean {
    return this.activeProvider === 'traffic';
  }

  get isEurope(): boolean {
    return this.activeProvider === 'europe';
  }

  /** Road511 or NAPSPAN catalog (same sidebar UX). */
  get isDotCatalog(): boolean {
    return this.isTraffic || this.isEurope;
  }

  /** Catalog provider for the selected webcam (stage / player), not the sidebar tab. */
  get stageCatalog(): WebcamCatalogTab {
    if (this.selected) {
      return this.providerTabFor(this.selected);
    }
    return this.isFavorites ? 'windy' : (this.activeProvider as WebcamCatalogTab);
  }

  get isStageTraffic(): boolean {
    return this.stageCatalog === 'traffic';
  }

  get isStageEurope(): boolean {
    return this.stageCatalog === 'europe';
  }

  get isStageDotCatalog(): boolean {
    return this.isStageTraffic || this.isStageEurope;
  }

  get isHlsMode(): boolean {
    return this.isStageDotCatalog && this.playerMode === 'live' && !!this.selected?.playerLiveUrl;
  }

  get page(): number {
    return Math.floor(this.offset / this.pageSize) + 1;
  }

  get pages(): number {
    return Math.max(1, Math.ceil(this.total / this.pageSize));
  }

  get canPrev(): boolean {
    return this.offset > 0;
  }

  get canNext(): boolean {
    return this.offset + this.pageSize < this.total;
  }

  get hasActiveGlobalFilter(): boolean {
    return !!(
      this.catalogQuery.trim() ||
      this.continent ||
      this.country ||
      this.category ||
      this.sortKey !== 'popularity' ||
      this.hasVideoOnly ||
      this.useNearby ||
      (this.isTraffic && this.jurisdiction && this.jurisdiction !== 'CA') ||
      (this.isEurope && this.jurisdiction && this.jurisdiction !== 'FRA') ||
      this.applyGlobalFilterToAllTabs
    );
  }

  /** Loaded rows narrowed by the sidebar text filter (before pagination slice). */
  private get unpagedDisplayedItems(): WebcamItem[] {
    const q = this.sidebarFilterQuery.trim().toLowerCase();
    if (!q) {
      return this.listSource;
    }
    return this.listSource.filter((cam) => this.matchesSidebarFilter(cam, q));
  }

  get locationLabel(): string {
    if (!this.selected) {
      return '';
    }
    return [this.selected.city, this.selected.region, this.selected.country]
      .filter(Boolean)
      .join(' · ');
  }

  get hasSelectedLocation(): boolean {
    return !!this.selected && isValidGeoCoordinate(this.selected.latitude, this.selected.longitude);
  }

  get showPlayerSpinner(): boolean {
    return this.isLoadingDetail || this.isLoadingPlayer;
  }

  get providerConfigured(): boolean {
    if (this.isFavorites) {
      return true;
    }
    if (this.isEurope) {
      return this.europeConfigured;
    }
    return this.isTraffic ? this.trafficConfigured : this.configured;
  }

  setProvider(tab: WebcamProviderTab): void {
    if (this.activeProvider === tab) {
      return;
    }
    this.activeProvider = tab;
    this.offset = 0;
    this.sidebarFilterQuery = '';
    this.listError = '';
    this.geoError = '';
    this.favoritesHint = '';
    this.favoritesError = '';
    this.pendingAutoSelectFirst = true;
    this.clearSelection();
    if (!this.applyGlobalFilterToAllTabs) {
      this.catalogQuery = '';
      this.hasVideoOnly = false;
      this.useNearby = false;
      this.nearbyLat = null;
      this.nearbyLon = null;
    }
    if (tab === 'favorites') {
      if (!this.applyGlobalFilterToAllTabs) {
        this.useNearby = false;
        this.nearbyLat = null;
        this.nearbyLon = null;
      }
      this.loadFavoritesList();
    } else if (tab === 'traffic') {
      if (!this.applyGlobalFilterToAllTabs || !this.jurisdiction) {
        this.jurisdiction = 'CA';
      }
      if (!this.applyGlobalFilterToAllTabs) {
        this.useNearby = false;
        this.nearbyLat = null;
        this.nearbyLon = null;
      }
      this.loadTrafficMeta();
      this.loadItems();
    } else if (tab === 'europe') {
      if (!this.applyGlobalFilterToAllTabs || !this.jurisdiction) {
        this.jurisdiction = 'FRA';
      }
      if (!this.applyGlobalFilterToAllTabs) {
        this.useNearby = false;
        this.nearbyLat = null;
        this.nearbyLon = null;
      }
      this.loadEuropeMeta();
      this.loadItems();
    } else {
      this.loadMeta();
      if (this.applyGlobalFilterToAllTabs && (this.useNearby || this.continent || this.country)) {
        this.loadItems();
      } else {
        this.requestNearby({ initial: true });
      }
    }
  }

  onStagePointerEnter(): void {
    if (!this.selected || !this.supportsHeaderAutoCollapse()) {
      return;
    }
    this.headerPinnedByHover = true;
    this.revealHeader(false);
  }

  onStagePointerLeave(ev: MouseEvent): void {
    if (!this.selected || !this.supportsHeaderAutoCollapse()) {
      return;
    }
    // Crossing into the Windy iframe fires mouseleave while the cursor is still
    // visually over the webcam — keep the header open in that case.
    if (this.isPointInsideStage(ev.clientX, ev.clientY)) {
      return;
    }
    this.headerPinnedByHover = false;
    this.collapseHeader();
  }

  @HostListener('document:mousemove', ['$event'])
  onDocumentMouseMove(ev: MouseEvent): void {
    if (!this.headerPinnedByHover || !this.selected || !this.supportsHeaderAutoCollapse()) {
      return;
    }
    if (!this.isPointInsideStage(ev.clientX, ev.clientY)) {
      this.headerPinnedByHover = false;
      this.collapseHeader();
    }
  }

  onSidebarFilterChange(): void {
    this.search$.next((this.sidebarFilterQuery || '').trim());
  }

  clearSidebarFilter(): void {
    if (!this.sidebarFilterQuery) {
      return;
    }
    this.sidebarFilterQuery = '';
    this.onSidebarFilterChange();
  }

  onFilterChange(): void {
    this.offset = 0;
    this.clearSelection();
    this.loadItems();
  }

  openGlobalFilter(): void {
    this.globalFilterPreference = {
      applyToAllTabs: this.applyGlobalFilterToAllTabs,
      catalogQuery: this.catalogQuery,
      continent: this.continent,
      country: this.country,
      category: this.category,
      sortKey: this.sortKey,
      jurisdiction: this.jurisdiction,
      hasVideoOnly: this.hasVideoOnly,
      useNearby: this.useNearby,
      nearbyRadiusKm: this.nearbyRadiusKm
    };
    this.globalFilterOpen = true;
  }

  closeGlobalFilter(): void {
    this.globalFilterOpen = false;
  }

  onGlobalFilterApplied(pref: WebcamFilterPreference): void {
    this.applyFilterPreference(pref);
  }

  onGlobalFilterCleared(pref: WebcamFilterPreference): void {
    this.applyFilterPreference(pref);
  }

  private applyFilterPreference(pref: WebcamFilterPreference): void {
    this.applyGlobalFilterToAllTabs = !!pref.applyToAllTabs;
    this.catalogQuery = pref.catalogQuery || '';
    this.continent = pref.continent || '';
    this.country = pref.country || '';
    this.category = pref.category || '';
    this.sortKey = pref.sortKey === 'createdOn' ? 'createdOn' : 'popularity';
    this.hasVideoOnly = !!pref.hasVideoOnly;
    this.nearbyRadiusKm = Math.max(25, Math.min(300, pref.nearbyRadiusKm || 100));
    if (this.isTraffic || this.isEurope) {
      this.jurisdiction = pref.jurisdiction || (this.isEurope ? 'FRA' : 'CA');
    }
    this.globalFilterOpen = false;
    this.offset = 0;
    this.clearSelection();
    this.geoError = '';

    const wantNearby = !!pref.useNearby;
    if (wantNearby) {
      // initial:true → Europe/default fallback when geolocation is denied
      this.requestNearby({ initial: true });
      return;
    }
    this.useNearby = false;
    this.nearbyLat = null;
    this.nearbyLon = null;
    if (this.isFavorites) {
      this.applyFavoritesToList();
      return;
    }
    this.loadItems();
  }

  prevPage(): void {
    if (!this.canPrev) {
      return;
    }
    this.offset = Math.max(0, this.offset - this.pageSize);
    if (this.clientPaging) {
      this.applyDisplayedList();
    } else {
      this.loadItems();
    }
  }

  nextPage(): void {
    if (!this.canNext) {
      return;
    }
    this.offset += this.pageSize;
    if (this.clientPaging) {
      this.applyDisplayedList();
    } else {
      this.loadItems();
    }
  }

  selectWebcam(item: WebcamItem): void {
    if (!item?.id) {
      return;
    }
    this.selectedId = item.id;
    this.selected = item;
    this.playerUrl = null;
    this.hlsError = '';
    this.stopHls();
    this.isLoadingPlayer = false;
    this.headerPinnedByHover = false;
    this.revealHeader(true);
    this.persistLastWebcam(item);
    this.syncLandscapeFullscreen();
    this.isLoadingDetail = true;
    this.detailSub?.unsubscribe();
    const catalog = this.providerTabFor(item);
    if (!this.isFavorites && catalog !== this.activeProvider) {
      this.activeProvider = catalog;
    }
    const detail$ =
      catalog === 'traffic'
        ? this.api.getWebcamTraffic(item.id)
        : catalog === 'europe'
          ? this.api.getWebcamEurope(item.id)
          : this.api.getWebcam(item.id, this.apiLang());
    this.detailSub = detail$.subscribe({
      next: (detail) => {
        this.selected = { ...item, ...detail };
        this.isLoadingDetail = false;
        this.persistLastWebcam(this.selected);
        this.setPlayerMode(this.preferredMode(this.selected));
        this.syncLandscapeFullscreen();
      },
      error: () => {
        this.isLoadingDetail = false;
        this.setPlayerMode(this.preferredMode(item));
        this.syncLandscapeFullscreen();
      }
    });
  }

  setPlayerMode(mode: PlayerMode): void {
    this.hlsError = '';
    this.stopHls();

    if (mode === 'image') {
      this.playerMode = 'image';
      this.playerUrl = null;
      const still = this.selected?.imagePreviewUrl || this.selected?.imageUrl;
      this.isLoadingPlayer = !!still;
      this.syncLandscapeFullscreen();
      return;
    }

    const cam = this.selected;
    let url = '';
    if (cam) {
      if (mode === 'live') {
        url = cam.playerLiveUrl || '';
      } else if (mode === 'month') {
        url = cam.playerMonthUrl || '';
      } else if (mode === 'day') {
        url = cam.playerDayUrl || '';
      }
    }

    if (!url) {
      this.playerMode = 'image';
      this.playerUrl = null;
      const still = cam?.imagePreviewUrl || cam?.imageUrl;
      this.isLoadingPlayer = !!still;
      this.syncLandscapeFullscreen();
      return;
    }

    this.playerMode = mode;

    // Road511 / NAPSPAN (and any .m3u8 live URL): play via proxied HLS / progressive MP4, not iframe.
    // NAPSPAN France often returns Viewsurf mediaRedirect → short MP4 (not HLS).
    if (this.isHlsUrl(url) || (this.isStageDotCatalog && mode === 'live')) {
      this.playerUrl = null;
      this.isLoadingPlayer = true;
      const progressive = !this.isHlsUrl(url) && (isProgressiveVod(url) || this.isStageDotCatalog);
      this.scheduleHlsStart(url, progressive);
      this.syncLandscapeFullscreen();
      return;
    }

    this.isLoadingPlayer = true;
    this.iframeGen += 1;
    this.playerUrl = this.sanitizer.bypassSecurityTrustResourceUrl(url);
    this.syncLandscapeFullscreen();
  }

  onPlayerLoaded(): void {
    if (!this.isLoadingPlayer) {
      return;
    }
    // Cached <img>/<iframe> can emit load synchronously during the same CD pass
    // that turned the spinner on — defer so aria-busy does not flip mid-check (NG0100).
    queueMicrotask(() => {
      this.isLoadingPlayer = false;
    });
  }

  requestNearby(opts?: { initial?: boolean }): void {
    this.geoError = '';
    this.isLoading = true;
    if (!navigator.geolocation) {
      this.geoError = 'WEBCAM.GEO_UNSUPPORTED';
      if (opts?.initial) {
        this.fallbackDefaultList();
      } else {
        this.isLoading = false;
      }
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.nearbyLat = pos.coords.latitude;
        this.nearbyLon = pos.coords.longitude;
        this.useNearby = true;
        this.continent = '';
        this.country = '';
        if (this.isTraffic) {
          // Road511 nearby can span states; drop jurisdiction.
          this.jurisdiction = '';
        }
        // NAPSPAN Free plan requires jurisdiction on every query — keep Pays.
        this.onFilterChange();
      },
      () => {
        this.geoError = 'WEBCAM.GEO_DENIED';
        this.useNearby = false;
        if (opts?.initial) {
          this.fallbackDefaultList();
        } else {
          this.isLoading = false;
        }
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 }
    );
  }

  clearNearby(): void {
    this.useNearby = false;
    this.nearbyLat = null;
    this.nearbyLon = null;
    this.geoError = '';
    if (this.isTraffic) {
      if (!this.jurisdiction) {
        this.jurisdiction = 'CA';
      }
    } else if (this.isEurope) {
      if (!this.jurisdiction) {
        this.jurisdiction = 'FRA';
      }
    } else if (!this.continent) {
      this.continent = 'EU';
    }
    this.onFilterChange();
  }

  /** Europe catalog when geolocation is unavailable on first entry. */
  private fallbackDefaultList(): void {
    this.useNearby = false;
    this.nearbyLat = null;
    this.nearbyLon = null;
    if (this.isTraffic) {
      this.jurisdiction = this.jurisdiction || 'CA';
    } else if (this.isEurope) {
      this.jurisdiction = this.jurisdiction || 'FRA';
    } else {
      this.continent = 'EU';
      this.country = '';
    }
    this.onFilterChange();
  }

  openExternal(): void {
    const url = this.selected?.detailUrl;
    if (url) {
      window.open(url, '_blank', 'noopener');
    }
  }

  openInTraceViewer(): void {
    const cam = this.selected;
    if (!cam || !this.traceViewerModal || !isValidGeoCoordinate(cam.latitude, cam.longitude)) {
      return;
    }
    const label =
      [cam.title, cam.city, cam.country].filter(Boolean).join(' · ') ||
      this.translate.instant('WEBCAM.OPEN_TRACE_VIEWER');
    this.traceViewerModal.openAtLocation(cam.latitude as number, cam.longitude as number, label);
  }

  private loadMeta(): void {
    this.isLoadingMeta = true;
    this.metaSub?.unsubscribe();
    const lang = this.apiLang();
    this.metaSub = this.api.getWebcamContinents(lang).subscribe({
      next: (res) => {
        this.continents = res.continents || [];
        this.configured = res.configured !== false;
        this.isLoadingMeta = false;
      },
      error: () => {
        this.isLoadingMeta = false;
      }
    });
    this.api.getWebcamCountries(lang).subscribe({
      next: (res) => {
        this.countries = res.countries || [];
        if (res.configured === false) {
          this.configured = false;
        }
      }
    });
    this.api.getWebcamCategories(lang).subscribe({
      next: (res) => {
        this.categories = res.categories || [];
      }
    });
  }

  private loadTrafficMeta(): void {
    this.isLoadingMeta = true;
    this.metaSub?.unsubscribe();
    this.metaSub = this.api.getWebcamTrafficJurisdictions().subscribe({
      next: (res) => {
        this.jurisdictions = res.jurisdictions || [];
        this.trafficConfigured = res.configured !== false;
        this.isLoadingMeta = false;
      },
      error: () => {
        this.isLoadingMeta = false;
        this.trafficConfigured = false;
      }
    });
  }

  private loadEuropeMeta(): void {
    this.isLoadingMeta = true;
    this.metaSub?.unsubscribe();
    this.metaSub = this.api.getWebcamEuropeJurisdictions().subscribe({
      next: (res) => {
        this.jurisdictions = res.jurisdictions || [];
        this.europeConfigured = res.configured !== false;
        // Drop stale Pays (e.g. Switzerland) that NAPSPAN lists but with zero cameras.
        if (
          this.jurisdiction &&
          this.jurisdictions.length > 0 &&
          !this.jurisdictions.some((j) => j.code === this.jurisdiction)
        ) {
          this.jurisdiction = this.jurisdictions[0].code || 'FRA';
          this.offset = 0;
          this.loadItems();
        }
        this.isLoadingMeta = false;
      },
      error: () => {
        this.isLoadingMeta = false;
        this.europeConfigured = false;
      }
    });
  }

  private loadItems(): void {
    this.isLoading = true;
    this.listError = '';
    this.listSub?.unsubscribe();

    if (this.isFavorites) {
      this.applyFavoritesToList();
      return;
    }
    if (this.isTraffic) {
      this.loadTrafficItems();
      return;
    }
    if (this.isEurope) {
      this.loadEuropeItems();
      return;
    }

    this.clientPaging = false;
    const nearby =
      this.useNearby && this.nearbyLat != null && this.nearbyLon != null
        ? `${this.nearbyLat},${this.nearbyLon},${this.nearbyRadiusKm}`
        : undefined;

    this.listSub = this.api
      .searchWebcams({
        countries: this.useNearby ? undefined : this.country || undefined,
        continents: this.useNearby ? undefined : this.continent || undefined,
        categories: this.category || undefined,
        nearby,
        q: this.catalogQuery.trim() || undefined,
        sortKey: this.sortKey,
        sortDirection: 'desc',
        limit: this.pageSize,
        offset: this.offset,
        lang: this.apiLang()
      })
      .subscribe({
        next: (page: WebcamSearchPage) => this.applyServerListPage(page, 'WEBCAM.ERROR_API_KEY'),
        error: () => this.applyListError()
      });
  }

  private loadTrafficItems(): void {
    const nearby =
      this.useNearby && this.nearbyLat != null && this.nearbyLon != null
        ? `${this.nearbyLat},${this.nearbyLon},${this.nearbyRadiusKm}`
        : undefined;

    this.clientPaging = true;
    this.listSub = this.fetchCatalogPages((limit, offset) =>
      this.api.searchWebcamTraffic({
        jurisdiction: nearby ? undefined : this.jurisdiction || undefined,
        nearby,
        q: this.catalogQuery.trim() || undefined,
        hasVideo: this.hasVideoOnly,
        limit,
        offset
      })
    ).subscribe({
      next: (cams) => this.applyClientListSource(cams),
      error: () => this.applyListError('WEBCAM.ERROR_TRAFFIC_LIST')
    });
  }

  private loadEuropeItems(): void {
    const nearby =
      this.useNearby && this.nearbyLat != null && this.nearbyLon != null
        ? `${this.nearbyLat},${this.nearbyLon},${this.nearbyRadiusKm}`
        : undefined;

    this.clientPaging = true;
    this.listSub = this.fetchCatalogPages((limit, offset) =>
      this.api.searchWebcamEurope({
        // Always send Pays — NAPSPAN Free rejects features queries without jurisdiction.
        jurisdiction: this.jurisdiction || undefined,
        nearby,
        q: this.catalogQuery.trim() || undefined,
        hasVideo: this.hasVideoOnly,
        limit,
        offset
      })
    ).subscribe({
      next: (cams) => this.applyClientListSource(cams),
      error: () => this.applyListError('WEBCAM.ERROR_EUROPE_LIST')
    });
  }

  /**
   * Pull successive pages so the sidebar text filter can run on the full loaded
   * catalog (Europe / Traffic), not just the current page.
   */
  private fetchCatalogPages(
    fetchPage: (limit: number, offset: number) => Observable<WebcamSearchPage>
  ): Observable<WebcamItem[]> {
    const pageSize = WebcamWatcherComponent.CLIENT_FETCH_PAGE;
    const max = WebcamWatcherComponent.CLIENT_FETCH_MAX;
    return fetchPage(pageSize, 0).pipe(
      catchError(() =>
        of({ webcams: [], total: 0, limit: pageSize, offset: 0, error: 'upstream_error' } as WebcamSearchPage)
      ),
      switchMap((first) => {
        if (first.error === 'missing_api_key') {
          if (this.isEurope) {
            this.europeConfigured = false;
            this.listError = 'WEBCAM.ERROR_EUROPE_API_KEY';
          } else if (this.isTraffic) {
            this.trafficConfigured = false;
            this.listError = 'WEBCAM.ERROR_TRAFFIC_API_KEY';
          }
        } else if (first.error) {
          this.listError = this.isEurope ? 'WEBCAM.ERROR_EUROPE_LIST' : 'WEBCAM.ERROR_TRAFFIC_LIST';
        }
        const firstItems = first.webcams || [];
        const reportedTotal = first.total || firstItems.length;
        const target = Math.min(Math.max(reportedTotal, firstItems.length), max);
        if (firstItems.length >= target) {
          return of(firstItems);
        }
        const offsets: number[] = [];
        for (let off = pageSize; off < target; off += pageSize) {
          offsets.push(off);
        }
        if (offsets.length === 0) {
          return of(firstItems);
        }
        return forkJoin(
          offsets.map((off) =>
            fetchPage(pageSize, off).pipe(
              catchError(() =>
                of({ webcams: [], total: 0, limit: pageSize, offset: off } as WebcamSearchPage)
              ),
              map((p) => p.webcams || [])
            )
          )
        ).pipe(map((pages) => firstItems.concat(...pages)));
      })
    );
  }

  private applyServerListPage(page: WebcamSearchPage, missingKeyI18n: string): void {
    this.isLoading = false;
    this.clientPaging = false;
    this.listSource = page.webcams || [];
    this.serverTotal = page.total || 0;
    if (page.error === 'missing_api_key') {
      this.configured = false;
      this.listError = missingKeyI18n;
    } else if (page.error) {
      this.listError = 'WEBCAM.ERROR_LIST';
    }
    this.applyDisplayedList();
    this.tryAutoSelectDefault();
  }

  private applyClientListSource(cams: WebcamItem[]): void {
    this.isLoading = false;
    this.clientPaging = true;
    this.listSource = cams || [];
    this.serverTotal = this.listSource.length;
    this.applyDisplayedList();
    this.tryAutoSelectDefault();
  }

  private applyDisplayedList(): void {
    const filtered = this.unpagedDisplayedItems;
    if (this.clientPaging || this.isFavorites) {
      this.total = filtered.length;
      if (this.offset >= this.total && this.total > 0) {
        this.offset = Math.floor((this.total - 1) / this.pageSize) * this.pageSize;
      }
      this.items = filtered.slice(this.offset, this.offset + this.pageSize);
    } else {
      // Windy server page: sidebar narrows the current page only.
      this.items = filtered;
      this.total = this.sidebarFilterQuery.trim() ? filtered.length : this.serverTotal;
    }
    if (this.selectedId) {
      const still = filtered.find((w) => w.id === this.selectedId);
      if (!still && !this.selected) {
        this.clearSelection();
      }
    }
  }

  private matchesSidebarFilter(cam: WebcamItem, q: string): boolean {
    const needle = (q || '').trim().toLowerCase();
    if (!needle) {
      return true;
    }
    const hay = [
      cam.title,
      cam.city,
      cam.region,
      cam.country,
      cam.countryCode,
      cam.provider,
      ...(cam.categories || [])
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    // Road-like tokens (a6, n7, i-405): match as whole ids, not substrings of A61/A10.
    if (/^(?:[a-z]{1,3}[-\s]?)?\d{1,4}[a-z]?$/i.test(needle)) {
      const road = needle.replace(/[\s\-]+/g, '').toUpperCase();
      const compact = hay.toUpperCase().replace(/([A-Z])[\s\-]+(\d)/g, '$1$2');
      const escaped = road.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^A-Z0-9])${escaped}(?![0-9])`).test(compact);
    }
    return hay.includes(needle);
  }

  private applyListError(key = 'WEBCAM.ERROR_LIST'): void {
    this.isLoading = false;
    this.listSource = [];
    this.items = [];
    this.total = 0;
    this.serverTotal = 0;
    this.listError = key;
  }

  private tryAutoSelectDefault(): void {
    if (!this.pendingAutoSelectFirst || this.selectedId) {
      return;
    }
    if (this.lastRestorePending) {
      return;
    }
    if (this.items.length > 0) {
      this.pendingAutoSelectFirst = false;
      this.selectWebcam(this.items[0]);
    }
  }

  private restoreLastWebcam(): void {
    const apply = (cam: WebcamItem | null | undefined) => {
      this.lastRestorePending = false;
      if (this.restoredLastWebcam || this.selectedId) {
        this.tryAutoSelectDefault();
        return;
      }
      if (!cam?.id) {
        this.tryAutoSelectDefault();
        return;
      }
      this.restoredLastWebcam = true;
      this.pendingAutoSelectFirst = false;
      this.selectWebcam(cam);
    };

    if (this.isLoggedIn) {
      this.api.getWebcamLast().subscribe({
        next: (cam) => {
          if (cam?.id) {
            apply(cam);
            return;
          }
          apply(this.readLastWebcamFromStorage());
        },
        error: () => apply(this.readLastWebcamFromStorage())
      });
      return;
    }
    apply(this.readLastWebcamFromStorage());
  }

  private persistLastWebcam(webcam: WebcamItem | null | undefined): void {
    if (!webcam?.id) {
      return;
    }
    this.writeLastWebcamToStorage(webcam);
    if (!this.isLoggedIn) {
      return;
    }
    this.lastWebcamSaveSub?.unsubscribe();
    this.lastWebcamSaveSub = this.api
      .saveWebcamLast(webcam)
      .pipe(catchError(() => of(null)))
      .subscribe();
  }

  private localStorageKey(): string {
    const user =
      this.keycloak.getPreferredUsername() ||
      this.keycloak.getUsernameForDisplay() ||
      'anonymous';
    return `pattool.webcam.last.${user}`;
  }

  private readLastWebcamFromStorage(): WebcamItem | null {
    try {
      const raw = localStorage.getItem(this.localStorageKey());
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as WebcamItem;
      return parsed?.id ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeLastWebcamToStorage(webcam: WebcamItem): void {
    try {
      localStorage.setItem(this.localStorageKey(), JSON.stringify(webcam));
    } catch {
      // ignore quota
    }
  }

  private providerTabFor(item: WebcamItem | null | undefined): WebcamCatalogTab {
    const p = (item?.provider || '').toLowerCase();
    if (p === 'road511') {
      return 'traffic';
    }
    if (p === 'napspan') {
      return 'europe';
    }
    return 'windy';
  }

  private preferredMode(cam: WebcamItem | null): PlayerMode {
    if (!cam) {
      return 'image';
    }
    const catalog = this.providerTabFor(cam);
    if (catalog === 'traffic' || catalog === 'europe') {
      if (cam.playerLiveUrl || cam.hasVideo) {
        return 'live';
      }
      return 'image';
    }
    if (cam.playerDayUrl) {
      return 'day';
    }
    if (cam.playerLiveUrl) {
      return 'live';
    }
    if (cam.playerMonthUrl) {
      return 'month';
    }
    return 'image';
  }

  isFavorite(cam: WebcamItem | null | undefined): boolean {
    return !!cam?.id && this.favoriteIds.has(this.favoriteKey(cam));
  }

  toggleFavorite(cam: WebcamItem, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    if (!cam?.id) {
      return;
    }
    if (!this.isLoggedIn) {
      this.favoritesHint = 'WEBCAM.FAVORITES_LOGIN';
      return;
    }
    const key = this.favoriteKey(cam);
    if (this.favoriteBusyKey) {
      return;
    }
    this.favoritesHint = '';
    this.favoritesError = '';
    this.favoriteBusyKey = key;
    const removing = this.favoriteIds.has(key);
    this.favoriteToggleSub?.unsubscribe();
    const req$ = removing
      ? this.api.removeWebcamFavorite(cam.id, cam.provider || undefined)
      : this.api.addWebcamFavorite(cam);
    this.favoriteToggleSub = req$.subscribe({
      next: (res) => {
        this.applyFavoritesPayload(res);
        this.favoriteBusyKey = '';
        if (this.isFavorites) {
          this.applyFavoritesToList();
        }
      },
      error: () => {
        this.favoriteBusyKey = '';
        this.favoritesError = 'WEBCAM.ERR_FAVORITES_SAVE';
      }
    });
  }

  private loadFavorites(): void {
    if (!this.isLoggedIn) {
      this.favorites = [];
      this.favoriteIds = new Set();
      return;
    }
    this.isLoadingFavorites = true;
    this.favoritesError = '';
    this.favoritesSub?.unsubscribe();
    this.favoritesSub = this.api.getWebcamFavorites().subscribe({
      next: (res) => {
        this.applyFavoritesPayload(res);
        this.isLoadingFavorites = false;
        if (this.isFavorites) {
          this.applyFavoritesToList();
        }
      },
      error: () => {
        this.favorites = [];
        this.favoriteIds = new Set();
        this.isLoadingFavorites = false;
        this.favoritesError = 'WEBCAM.ERR_FAVORITES_LOAD';
        if (this.isFavorites) {
          this.applyFavoritesToList();
        }
      }
    });
  }

  private loadFavoritesList(): void {
    if (!this.isLoggedIn) {
      this.favoritesHint = 'WEBCAM.FAVORITES_LOGIN';
      this.favorites = [];
      this.favoriteIds = new Set();
      this.listSource = [];
      this.items = [];
      this.total = 0;
      this.isLoading = false;
      this.listError = '';
      return;
    }
    this.favoritesHint = '';
    this.isLoading = true;
    this.listError = '';
    this.loadFavorites();
  }

  private applyFavoritesPayload(res: WebcamFavorites | null | undefined): void {
    const list = (res?.webcams || []).filter((w) => !!w?.id);
    this.favorites = list.slice().sort((a, b) =>
      (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' })
    );
    this.favoriteIds = new Set(this.favorites.map((w) => this.favoriteKey(w)));
  }

  private applyFavoritesToList(): void {
    this.isLoading = this.isLoadingFavorites;
    this.listError = '';
    this.clientPaging = true;
    this.listSource = this.favorites;
    this.applyDisplayedList();
    if (!this.isLoading) {
      this.tryAutoSelectDefault();
    }
  }

  private favoriteKey(cam: WebcamItem): string {
    const provider = (cam.provider || 'windy').toLowerCase();
    return `${provider}:${cam.id}`;
  }

  private isHlsUrl(url: string): boolean {
    return /\.m3u8(\?|$)/i.test(url) || /playlist\.m3u8/i.test(url);
  }

  private scheduleHlsStart(url: string, progressive = false): void {
    if (this.hlsStartTimer != null) {
      clearTimeout(this.hlsStartTimer);
    }
    this.hlsStartTimer = setTimeout(() => {
      this.hlsStartTimer = null;
      const video = this.hlsVideo?.nativeElement;
      if (!video || !url) {
        this.isLoadingPlayer = false;
        this.hlsError = 'WEBCAM.ERROR_HLS';
        return;
      }
      const proxyUrl = this.api.tvStreamProxyUrl(url);
      this.hlsHandle = startTvHlsPlayback(video, proxyUrl, {
        progressive,
        onBuffering: (buffering) => {
          this.isLoadingPlayer = buffering;
        },
        onError: (message) => {
          this.isLoadingPlayer = false;
          this.hlsError =
            typeof message === 'string' && message.trim()
              ? message
              : 'WEBCAM.ERROR_HLS';
        }
      });
    }, 40);
  }

  private stopHls(): void {
    if (this.hlsStartTimer != null) {
      clearTimeout(this.hlsStartTimer);
      this.hlsStartTimer = null;
    }
    this.hlsHandle?.destroy();
    this.hlsHandle = null;
  }

  private clearSelection(): void {
    this.stopHls();
    this.selected = null;
    this.selectedId = '';
    this.playerUrl = null;
    this.playerMode = 'day';
    this.hlsError = '';
    this.isLoadingDetail = false;
    this.isLoadingPlayer = false;
    this.headerPinnedByHover = false;
    this.collapseHeader();
    this.syncLandscapeFullscreen();
  }

  private revealHeader(scheduleHide: boolean): void {
    this.headerExpanded = true;
    this.clearHeaderHideTimer();
    if (!this.supportsHeaderAutoCollapse()) {
      return;
    }
    if (scheduleHide && !this.headerPinnedByHover) {
      this.headerHideTimer = setTimeout(() => {
        this.headerHideTimer = null;
        if (!this.headerPinnedByHover) {
          this.headerExpanded = false;
        }
      }, WebcamWatcherComponent.HEADER_HIDE_MS);
    }
  }

  private collapseHeader(): void {
    this.clearHeaderHideTimer();
    this.headerExpanded = false;
  }

  private clearHeaderHideTimer(): void {
    if (this.headerHideTimer != null) {
      clearTimeout(this.headerHideTimer);
      this.headerHideTimer = null;
    }
  }

  /** Auto-hide only when a fine pointer can re-open the bar on hover. */
  private supportsHeaderAutoCollapse(): boolean {
    return (
      typeof window !== 'undefined' &&
      window.matchMedia('(hover: hover) and (pointer: fine)').matches
    );
  }

  private isPointInsideStage(x: number, y: number): boolean {
    const el = this.stageRef?.nativeElement;
    if (!el) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  private apiLang(): string {
    const lang = (this.translate.currentLang || this.translate.defaultLang || 'en').toLowerCase();
    if (lang.startsWith('jp') || lang === 'ja') {
      return 'ja';
    }
    if (lang.startsWith('cn') || lang.startsWith('zh')) {
      return 'zh';
    }
    return lang.substring(0, 2) || 'en';
  }
}
