import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostBinding,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { firstValueFrom, interval, Observable, of, Subject, Subscription, throwError } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, map, switchMap, take, takeWhile } from 'rxjs/operators';
import * as L from 'leaflet';

import { LeafletBasemapOption, LeafletBasemapService } from '../shared/leaflet-basemap.service';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import { SheetSelectComponent, SheetSelectOption } from '../shared/sheet-select/sheet-select.component';
import { KeycloakService } from '../keycloak/keycloak.service';
import { PositionService } from '../services/position.service';
import {
  ApiService,
  ArtisansCacheMode,
  ArtisansCacheTradeCount,
  ArtisansFavorites,
  ArtisansNearbyItem,
  ArtisansNearbyResponse,
  ArtisansSource
} from '../services/api.service';
import {
  activityLabelFromCode,
  normalizeNaf,
  OSM_TRADES,
  SIRENE_TRADES,
  TRADE_NAF_CODES,
  tradeKeyFromCode
} from './artisans-trades';
import { searchOsmOverpass } from './artisans-overpass';
import {
  normalizeWebsite,
  resolveOfficialWebsite
} from './artisans-website';
import { isEstablishmentClosed } from './artisans-opening-hours';
import { openWhatsAppTextShare } from '../shared/share-whatsapp-image.util';

type MappedArtisan = ArtisansNearbyItem & { lat: number; lon: number };
type ArtisanMarker = L.CircleMarker | L.Marker;
type ArtisanSortKey =
  | 'distance-asc'
  | 'distance-desc'
  | 'name-asc'
  | 'name-desc'
  | 'trade-asc'
  | 'city-asc';

interface AddressHit {
  lat: number;
  lon: number;
  displayName: string;
}

export const ARTISAN_LIST_PAGE_SIZE = 500;
export const ARTISAN_PAGE_SIZE_ALL = 0;
export const ARTISAN_PAGE_SIZE_OPTIONS: number[] = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, ARTISAN_PAGE_SIZE_ALL];
export const ARTISAN_RADIUS_MIN_KM = 1;
export const ARTISAN_RADIUS_MAX_KM = 50;

export const ARTISAN_TRADES = [
  'all',
  ...SIRENE_TRADES.filter((trade) => trade !== 'all'),
  ...OSM_TRADES.filter((trade) => trade !== 'all' && !(SIRENE_TRADES as readonly string[]).includes(trade))
] as const;

type ArtisanTradeStatSort = 'count-desc' | 'count-asc' | 'name-asc' | 'name-desc';

interface ArtisanTradeStat {
  value: string;
  label: string;
  icon: string;
  count: number;
  pct: number;
}

const TRADE_ICONS: Record<string, string> = {
  all: 'fa fa-th',
  plumber: 'fa fa-wrench',
  electrician: 'fa fa-bolt',
  heating: 'fa fa-fire',
  painter: 'fa fa-paint-brush',
  carpenter: 'fa fa-tree',
  mason: 'fa fa-cube',
  roofer: 'fa fa-home',
  locksmith: 'fa fa-key',
  tiler: 'fa fa-th-large',
  glazier: 'fa fa-square-o',
  gardener: 'fa fa-leaf',
  cleaner: 'fa fa-bath',
  hairdresser: 'fa fa-scissors',
  baker: 'fa fa-birthday-cake',
  butcher: 'fa fa-cutlery',
  mechanic: 'fa fa-car',
  appliance: 'fa fa-plug',
  supermarket: 'fa fa-shopping-cart',
  grocery: 'fa fa-shopping-basket',
  shop: 'fa fa-tag',
  hardware: 'fa fa-gavel',
  clothing: 'fa fa-shopping-bag',
  furniture: 'fa fa-bed',
  florist: 'fa fa-pagelines',
  pharmacy: 'fa fa-medkit',
  optician: 'fa fa-eye',
  restaurant: 'fa fa-cutlery',
  cafe: 'fa fa-coffee',
  hotel: 'fa fa-building',
  fuel: 'fa fa-tint',
  beauty: 'fa fa-magic',
  isolation: 'fa fa-snowflake-o',
  plasterer: 'fa fa-square',
  dentist: 'fa fa-smile-o',
  doctor: 'fa fa-user-md',
  veterinary: 'fa fa-paw',
  realestate: 'fa fa-building-o',
  laundry: 'fa fa-tint',
  bank: 'fa fa-university',
  insurance: 'fa fa-shield',
  wholesale: 'fa fa-cubes',
  post: 'fa fa-envelope',
  shoes: 'fa fa-black-tie',
  electronics: 'fa fa-plug',
  it: 'fa fa-laptop',
  books: 'fa fa-book',
  sports: 'fa fa-futbol-o',
  jewelry: 'fa fa-diamond',
  bar: 'fa fa-beer',
  fastfood: 'fa fa-cutlery'
};

@Component({
  selector: 'app-artisans-nearby',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, TraceViewerModalComponent, SheetSelectComponent],
  templateUrl: './artisans-nearby.component.html',
  styleUrls: ['./artisans-nearby.component.css']
})
export class ArtisansNearbyComponent implements OnInit, AfterViewInit, OnDestroy {

  @HostBinding('class.artisans-osm')
  get isOsmSource(): boolean {
    return this.source === 'osm';
  }

  @HostBinding('class.artisans-fs')
  get isArtisansFullscreen(): boolean {
    return this.mapFullscreen;
  }

  @ViewChild('layoutShell') layoutShell?: ElementRef<HTMLDivElement>;
  @ViewChild('mapHost') mapHost?: ElementRef<HTMLDivElement>;
  @ViewChild('mapCard') mapCard?: ElementRef<HTMLDivElement>;
  @ViewChild('resultsList') resultsList?: ElementRef<HTMLElement>;
  @ViewChild(TraceViewerModalComponent) traceViewer?: TraceViewerModalComponent;

  private static readonly DEFAULT_MAP_LAT = 46.2;
  private static readonly DEFAULT_MAP_LNG = 2.2;

  listPageSize = ARTISAN_LIST_PAGE_SIZE;
  readonly pageSizeOptions = ARTISAN_PAGE_SIZE_OPTIONS;
  mapListOnly = false;
  readonly radiusMinKm = ARTISAN_RADIUS_MIN_KM;
  readonly radiusMaxKm = ARTISAN_RADIUS_MAX_KM;
  readonly sortOptions: ArtisanSortKey[] = [
    'distance-asc',
    'distance-desc',
    'name-asc',
    'name-desc',
    'trade-asc',
    'city-asc'
  ];

  source: ArtisansSource = 'sirene';
  readonly cacheModes: ArtisansCacheMode[] = ['cache', 'both', 'api'];
  cacheMode: ArtisansCacheMode = 'cache';
  includeWithoutCoords = false;
  includeClosed = true;
  cacheCount = 0;
  cacheFilling = false;
  clearingCache = false;
  cacheBreakdownOpen = false;
  cacheBreakdownLoading = false;
  cacheTrades: ArtisansCacheTradeCount[] = [];
  i18nPrefix = 'ARTISANS';
  addressQuery = '';
  addressHits: AddressHit[] = [];
  addressActiveIndex = -1;
  addressSearching = false;
  trade = 'all';
  tradeSelectOptions: SheetSelectOption[] = [];
  radiusKm = 10;
  page = 1;

  placeLabel = '';
  searchLat: number | null = null;
  searchLon: number | null = null;
  result: ArtisansNearbyResponse | null = null;
  selectedId: string | null = null;
  listItems: ArtisansNearbyItem[] = [];
  viewportItems: MappedArtisan[] = [];
  listQuery = '';
  listTrade = 'all';
  listCity = '';
  listTradeSelectOptions: SheetSelectOption[] = [];
  private discoveredTradeOptions: SheetSelectOption[] = [];
  sortKey: ArtisanSortKey = 'distance-asc';

  showFavorites = false;
  favorites: ArtisansNearbyItem[] = [];
  favoriteKeys = new Set<string>();
  favoriteBusyKey = '';
  favoritesError = '';
  favoritesHint = '';

  isLoading = false;
  locating = false;
  searched = false;
  errorMessage = '';
  mapFullscreen = false;
  /** True only when the Fullscreen API is unavailable; uses a fixed overlay instead. */
  mapFullscreenCssFallback = false;
  countsHelpOpen = false;
  tradeStatsOpen = false;
  tradeStatsQuery = '';
  tradeStatsSort: ArtisanTradeStatSort = 'count-desc';
  mapBaseLayerId = 'osm-standard';
  filtersCollapsed = false;
  resultsCollapsed = false;

  get basemapOptions(): LeafletBasemapOption[] {
    return this.basemap.getAvailableLayers();
  }

  private map?: L.Map;
  private baseLayer: L.TileLayer | L.LayerGroup | null = null;
  private mapLayer?: L.FeatureGroup;
  private markers = new Map<string, ArtisanMarker>();
  private markerRenderer?: L.Canvas;
  private radiusCircle?: L.Polygon;
  private addressPicked = false;
  private readonly addressSearch$ = new Subject<string>();
  private readonly listQuery$ = new Subject<string>();
  private readonly radiusSearch$ = new Subject<number>();
  private addressSearchSub?: Subscription;
  private listQuerySub?: Subscription;
  private radiusSearchSub?: Subscription;
  private addressGeocodeSub?: Subscription;
  private langSub?: Subscription;
  private searchSub?: Subscription;
  private placeGeocodeSub?: Subscription;
  private cacheSub?: Subscription;
  private cachePollSub?: Subscription;
  private cacheReloadSub?: Subscription;
  private remoteListQuery = '';
  private favoritesSub?: Subscription;
  private favoriteToggleSub?: Subscription;
  private radiusPrefSub?: Subscription;
  private radiusSaveSub?: Subscription;
  private positionSub?: Subscription;
  private readonly websiteResolving = new Set<string>();
  private readonly websiteJobs = new Map<string, Promise<string>>();
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private blinkingMarker: ArtisanMarker | null = null;
  private blinkingId: string | null = null;
  private suppressMapClickUntil = 0;
  private markerStyle(favorite: boolean) {
    const mobile = this.isStackedLayout();
    return {
      radius: mobile ? 12 : 7,
      weight: mobile ? 2 : 1,
      color: '#fff',
      fillColor: favorite ? '#c9a227' : '#c45c26',
      fillOpacity: favorite ? 0.95 : 0.92,
      bubblingMouseEvents: false
    };
  }

  constructor(
    private readonly api: ApiService,
    private readonly basemap: LeafletBasemapService,
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly translate: TranslateService,
    private readonly cdr: ChangeDetectorRef,
    private readonly ngZone: NgZone,
    private readonly http: HttpClient,
    private readonly keycloak: KeycloakService,
    private readonly position: PositionService
  ) {}

  ngOnInit(): void {
    this.applySource('sirene', false);
    if (this.route.snapshot.queryParamMap.get('source')) {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { source: null },
        queryParamsHandling: 'merge',
        replaceUrl: true
      });
    }
    this.langSub = this.translate.onLangChange.subscribe(() => {
      this.rebuildTradeSelectOptions();
      this.rebuildListTradeOptions();
    });
    this.loadFavorites();
    this.addressSearchSub = this.addressSearch$.pipe(debounceTime(350)).subscribe((query) => {
      this.lookupAddresses(query, false);
    });
    this.listQuerySub = this.listQuery$.pipe(
      debounceTime(400),
      distinctUntilChanged()
    ).subscribe((query) => this.onDebouncedListQuery(query));
    this.radiusSearchSub = this.radiusSearch$.pipe(
      debounceTime(450),
      distinctUntilChanged()
    ).subscribe((km) => {
      this.persistPreferences();
      this.searchAfterRadiusChange();
    });
    this.loadPreferences(() => this.useMyPosition(true));
  }

  ngAfterViewInit(): void {
    this.basemap.loadOptionalLayers(this.api);
    setTimeout(() => this.ensureMap(), 0);
  }

  ngOnDestroy(): void {
    this.exitMapFullscreen();
    this.searchSub?.unsubscribe();
    this.addressSearchSub?.unsubscribe();
    this.listQuerySub?.unsubscribe();
    this.radiusSearchSub?.unsubscribe();
    this.langSub?.unsubscribe();
    this.addressGeocodeSub?.unsubscribe();
    this.favoritesSub?.unsubscribe();
    this.favoriteToggleSub?.unsubscribe();
    this.radiusPrefSub?.unsubscribe();
    this.radiusSaveSub?.unsubscribe();
    this.positionSub?.unsubscribe();
    this.placeGeocodeSub?.unsubscribe();
    this.cacheSub?.unsubscribe();
    this.cachePollSub?.unsubscribe();
    this.cacheReloadSub?.unsubscribe();
    this.stopMarkerBlink();
    this.map?.remove();
    this.map = undefined;
  }

  onBasemapChange(): void {
    if (!this.map) {
      return;
    }
    this.baseLayer = this.basemap.applyBaseLayer(this.map, this.mapBaseLayerId, this.baseLayer);
  }

  toggleFiltersCollapsed(): void {
    this.filtersCollapsed = !this.filtersCollapsed;
    this.refreshMapAfterResize();
  }

  toggleResultsCollapsed(): void {
    this.resultsCollapsed = !this.resultsCollapsed;
    this.refreshMapAfterResize();
  }

  toggleMapFullscreen(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const shell = this.layoutShell?.nativeElement;
    if (!shell) {
      return;
    }
    if (this.mapFullscreen) {
      this.exitMapFullscreen();
      return;
    }
    const request = shell.requestFullscreen?.bind(shell)
      ?? (shell as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> })
        .webkitRequestFullscreen?.bind(shell);
    if (!request) {
      this.mapFullscreenCssFallback = true;
      this.mapFullscreen = true;
      this.refreshMapAfterResize();
      return;
    }
    request().catch(() => {
      this.mapFullscreenCssFallback = true;
      this.mapFullscreen = true;
      this.refreshMapAfterResize();
    });
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  onMapFullscreenChange(): void {
    const shell = this.layoutShell?.nativeElement;
    const doc = document as Document & { webkitFullscreenElement?: Element };
    const active = !!(shell && (document.fullscreenElement === shell || doc.webkitFullscreenElement === shell));
    if (this.mapFullscreen === active) {
      return;
    }
    this.mapFullscreen = active;
    if (active) {
      this.mapFullscreenCssFallback = false;
    }
    this.refreshMapAfterResize();
  }

  @HostListener('document:keydown.escape')
  onMapFullscreenEscape(): void {
    if (this.tradeStatsOpen) {
      this.closeTradeStats();
      return;
    }
    if (this.countsHelpOpen) {
      this.countsHelpOpen = false;
      return;
    }
    if (this.mapFullscreen) {
      this.exitMapFullscreen();
    }
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    if (this.countsHelpOpen) {
      this.countsHelpOpen = false;
    }
  }

  toggleCountsHelp(event: Event): void {
    event.stopPropagation();
    this.countsHelpOpen = !this.countsHelpOpen;
  }

  openTradeStats(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!this.searched || this.isLoading) {
      return;
    }
    this.countsHelpOpen = false;
    this.tradeStatsQuery = '';
    this.tradeStatsOpen = true;
  }

  closeTradeStats(): void {
    this.tradeStatsOpen = false;
  }

  toggleTradeStatsSort(field: 'name' | 'count'): void {
    if (field === 'name') {
      this.tradeStatsSort = this.tradeStatsSort === 'name-asc' ? 'name-desc' : 'name-asc';
      return;
    }
    this.tradeStatsSort = this.tradeStatsSort === 'count-desc' ? 'count-asc' : 'count-desc';
  }

  filterToTradeStat(row: ArtisanTradeStat): void {
    this.showFavorites = false;
    this.resultsCollapsed = false;
    this.closeTradeStats();
    const value = row.value;
    if (this.isSelectableSearchTrade(value)) {
      this.listTrade = 'all';
      this.listQuery = '';
      this.listCity = '';
      if (this.trade === value) {
        return;
      }
      this.trade = value;
      this.onTradeChange();
      return;
    }
    this.listTrade = value;
    this.onListViewChange();
  }

  private exitMapFullscreen(): void {
    const doc = document as Document & {
      webkitFullscreenElement?: Element;
      webkitExitFullscreen?: () => Promise<void>;
    };
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(document);
      exit?.().catch(() => {
        this.mapFullscreen = false;
        this.mapFullscreenCssFallback = false;
        this.refreshMapAfterResize();
      });
      return;
    }
    if (this.mapFullscreen) {
      this.mapFullscreen = false;
      this.mapFullscreenCssFallback = false;
      this.refreshMapAfterResize();
    }
  }

  private refreshMapAfterResize(): void {
    this.cdr.markForCheck();
    setTimeout(() => {
      this.map?.invalidateSize();
      this.updateRadiusCircle();
    }, 120);
  }

  get isLoggedIn(): boolean {
    return this.keycloak.isLoggedIn();
  }

  get hasVisiblePanel(): boolean {
    return this.searched || this.isLoading || this.showFavorites;
  }

  favoriteKey(item: ArtisansNearbyItem): string {
    const source = item.source || this.source;
    return `${source}:${item.id || ''}`;
  }

  isFavorite(item: ArtisansNearbyItem): boolean {
    return !!item.id && this.favoriteKeys.has(this.favoriteKey(item));
  }

  setShowFavorites(on: boolean): void {
    this.showFavorites = on;
    this.favoritesHint = '';
    this.favoritesError = '';
    if (on && !this.isLoggedIn) {
      this.favoritesHint = `${this.i18nPrefix}.FAVORITES_LOGIN`;
    }
    this.applyListView();
    setTimeout(() => {
      this.ensureMap();
      this.refreshMapMarkers(on);
    }, 0);
  }

  toggleFavorite(item: ArtisansNearbyItem, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!item.id) {
      return;
    }
    if (!this.isLoggedIn) {
      this.favoritesHint = `${this.i18nPrefix}.FAVORITES_LOGIN`;
      this.cdr.markForCheck();
      return;
    }
    const key = this.favoriteKey(item);
    if (this.favoriteBusyKey) {
      return;
    }
    this.favoritesHint = '';
    this.favoritesError = '';
    this.favoriteBusyKey = key;
    const removing = this.favoriteKeys.has(key);
    this.favoriteToggleSub?.unsubscribe();
    const req$ = removing
      ? this.api.removeArtisanFavorite(item.id, item.source || this.source)
      : this.api.addArtisanFavorite(this.toFavoritePayload(item));
    this.favoriteToggleSub = req$.subscribe({
      next: (res) => {
        this.applyFavoritesPayload(res);
        this.favoriteBusyKey = '';
        this.cdr.markForCheck();
      },
      error: () => {
        this.favoriteBusyKey = '';
        this.favoritesError = `${this.i18nPrefix}.ERR_FAVORITES_SAVE`;
        this.cdr.markForCheck();
      }
    });
  }

  private loadFavorites(): void {
    if (!this.isLoggedIn) {
      this.favorites = [];
      this.favoriteKeys = new Set();
      return;
    }
    this.favoritesSub?.unsubscribe();
    this.favoritesSub = this.api.getArtisansFavorites().subscribe({
      next: (res) => this.applyFavoritesPayload(res),
      error: () => {
        this.favoritesError = `${this.i18nPrefix}.ERR_FAVORITES_LOAD`;
        this.cdr.markForCheck();
      }
    });
  }

  private loadPreferences(then: () => void): void {
    if (!this.isLoggedIn) {
      then();
      return;
    }
    this.radiusPrefSub?.unsubscribe();
    this.radiusPrefSub = this.api.getArtisansPreferences().subscribe({
      next: (pref) => {
        if (pref?.radiusKm != null) {
          this.radiusKm = this.clampRadius(pref.radiusKm);
        }
        if (pref?.perPage != null) {
          this.listPageSize = this.clampPerPage(pref.perPage);
        }
        if (typeof pref?.mapListOnly === 'boolean') {
          this.mapListOnly = pref.mapListOnly;
        }
        this.cdr.markForCheck();
        then();
      },
      error: () => then()
    });
  }

  private persistPreferences(): void {
    if (!this.isLoggedIn) {
      return;
    }
    this.radiusSaveSub?.unsubscribe();
    this.radiusSaveSub = this.api.saveArtisansPreferences({
      radiusKm: this.clampRadius(this.radiusKm),
      perPage: this.clampPerPage(this.listPageSize),
      mapListOnly: this.mapListOnly
    }).subscribe({
      error: () => { /* keep in-memory preferences */ }
    });
  }

  private clampRadius(km: number): number {
    if (!Number.isFinite(km)) {
      return 10;
    }
    return Math.max(this.radiusMinKm, Math.min(this.radiusMaxKm, Math.round(km)));
  }

  private clampPerPage(n: number): number {
    if (!Number.isFinite(n)) {
      return ARTISAN_LIST_PAGE_SIZE;
    }
    if (n <= 0) {
      return ARTISAN_PAGE_SIZE_ALL;
    }
    let best: number = ARTISAN_LIST_PAGE_SIZE;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const option of ARTISAN_PAGE_SIZE_OPTIONS) {
      if (option <= 0) {
        continue;
      }
      const delta = Math.abs(option - n);
      if (delta < bestDelta) {
        best = option;
        bestDelta = delta;
      }
    }
    return best;
  }

  private applyFavoritesPayload(res: ArtisansFavorites | null): void {
    this.favorites = (res?.items || []).filter((item) => !!item.id);
    this.favoriteKeys = new Set(this.favorites.map((item) => this.favoriteKey(item)));
    if (this.showFavorites) {
      this.applyListView();
      setTimeout(() => this.refreshMapMarkers(true), 0);
    }
    this.cdr.markForCheck();
  }

  private toFavoritePayload(item: ArtisansNearbyItem): ArtisansNearbyItem {
    return {
      id: item.id,
      source: item.source || this.source,
      name: item.name,
      activity: item.activity,
      activityCode: item.activityCode,
      tradeKey: this.resolvedTradeKey(item) || item.tradeKey,
      address: item.address,
      city: item.city,
      postalCode: item.postalCode,
      lat: item.lat,
      lon: item.lon,
      url: item.url,
      website: item.website,
      phone: item.phone,
      openingHours: item.openingHours
    };
  }

  get items(): ArtisansNearbyItem[] {
    return this.result?.items || [];
  }

  get mappedItems(): MappedArtisan[] {
    return this.withMapPoint(this.items);
  }

  get mapPlotItems(): MappedArtisan[] {
    if (this.mapListOnly && !this.showFavorites) {
      const rows = this.listItems.length ? this.listItems : this.items;
      return this.withMapPoint(rows);
    }
    const extra = this.result?.mapItems;
    return this.withMapPoint(extra && extra.length ? extra : this.items);
  }

  private withMapPoint(items: ArtisansNearbyItem[]): MappedArtisan[] {
    return items
      .filter((item): item is MappedArtisan => this.hasMapPoint(item))
      .filter((item) => this.matchesSelectedTrade(item))
      .filter((item) => this.showFavorites || this.includeClosed || !this.isItemClosed(item));
  }

  get total(): number {
    return this.result?.total || 0;
  }

  get totalPages(): number {
    const per = this.effectivePerPage;
    return Math.max(1, Math.ceil(this.total / per));
  }

  private get effectivePerPage(): number {
    if (this.listPageSize <= 0 || (this.result?.perPage != null && this.result.perPage <= 0)) {
      return Math.max(1, this.total);
    }
    return this.result?.perPage || this.listPageSize;
  }

  get trades(): string[] {
    const sourceTrades = this.source === 'osm' ? OSM_TRADES : SIRENE_TRADES;
    const rest = sourceTrades.filter((trade) => trade !== 'all')
      .slice()
      .sort((a, b) => this.compareTradeLabels(a, b));
    return ['all', ...rest];
  }

  private rebuildTradeSelectOptions(): void {
    const catalog = this.trades
      .filter((trade) => trade !== 'all')
      .map((trade) => ({
        value: trade,
        labelKey: this.tradeLabelKey(trade),
        icon: TRADE_ICONS[trade] || 'fa fa-wrench'
      }));
    const seen = new Set(catalog.map((option) => String(option.value)));
    const extras = this.discoveredTradeOptions.filter((option) => !seen.has(String(option.value)));
    const rest = [...catalog, ...extras].sort((a, b) =>
      this.typeOptionLabel(a).localeCompare(this.typeOptionLabel(b), this.uiLocale, { sensitivity: 'base' })
    );
    this.tradeSelectOptions = [
      { value: 'all', labelKey: this.tradeLabelKey('all'), icon: TRADE_ICONS['all'] },
      ...rest
    ];
  }

  private rebuildListTradeOptions(): void {
    const byValue = new Map<string, SheetSelectOption>();
    for (const item of this.resultTradeSourceItems()) {
      const option = this.itemTypeOption(item);
      if (option && !byValue.has(String(option.value))) {
        byValue.set(String(option.value), option);
      }
    }
    const rest = [...byValue.values()].sort((a, b) =>
      this.typeOptionLabel(a).localeCompare(this.typeOptionLabel(b), this.uiLocale, { sensitivity: 'base' })
    );
    this.listTradeSelectOptions = [
      { value: 'all', labelKey: this.tradeLabelKey('all'), icon: TRADE_ICONS['all'] },
      ...rest
    ];
    this.collectDiscoveredTrades(byValue);
  }

  private collectDiscoveredTrades(fromList: Map<string, SheetSelectOption>): void {
    const catalog = new Set(this.trades);
    this.discoveredTradeOptions = [...fromList.values()].filter((option) => {
      const value = String(option.value ?? '');
      return value.startsWith('naf:') || (!catalog.has(value) && value !== 'all');
    });
    this.rebuildTradeSelectOptions();
  }

  private resultTradeSourceItems(): ArtisansNearbyItem[] {
    if (this.showFavorites) {
      return this.favoritesWithDistance();
    }
    const extra = this.result?.mapItems;
    if (extra && extra.length) {
      const byId = new Map<string, ArtisansNearbyItem>();
      for (const item of extra) {
        byId.set(this.tradeItemId(item), item);
      }
      for (const item of this.items) {
        byId.set(this.tradeItemId(item), item);
      }
      return [...byId.values()];
    }
    return this.items.length ? this.items : this.listSourceItems();
  }

  private tradeItemId(item: ArtisansNearbyItem): string {
    return item.id || [item.name, item.activityCode, item.lat, item.lon].join('|');
  }

  private itemTradeKey(item: ArtisansNearbyItem): string {
    const fromItem = (item.tradeKey || '').trim();
    if (fromItem && fromItem !== 'all') {
      return fromItem;
    }
    return tradeKeyFromCode(item.activityCode);
  }

  private itemTypeValue(item: ArtisansNearbyItem): string {
    const tradeKey = this.itemTradeKey(item);
    if (tradeKey) {
      return tradeKey;
    }
    const code = normalizeNaf(item.activityCode);
    if (code) {
      return `naf:${code}`;
    }
    const activity = this.activityDetail(item);
    return activity ? `act:${activity}` : '';
  }

  private itemTypeOption(item: ArtisansNearbyItem): SheetSelectOption | null {
    const tradeKey = this.itemTradeKey(item);
    if (tradeKey) {
      return {
        value: tradeKey,
        labelKey: this.tradeLabelKey(tradeKey),
        icon: TRADE_ICONS[tradeKey] || 'fa fa-wrench'
      };
    }
    const code = normalizeNaf(item.activityCode);
    const activity = this.activityDetail(item);
    if (code) {
      return {
        value: `naf:${code}`,
        label: activity ? `${activity} (${code})` : code,
        icon: 'fa fa-tag'
      };
    }
    if (!activity) {
      return null;
    }
    return {
      value: `act:${activity}`,
      label: activity,
      icon: 'fa fa-tag'
    };
  }

  private typeOptionLabel(option: SheetSelectOption): string {
    if (option.label) {
      return option.label;
    }
    if (option.labelKey) {
      const label = this.translate.instant(option.labelKey);
      if (label && !String(label).startsWith('ARTISANS.TRADE_')) {
        return label;
      }
    }
    return String(option.value ?? '');
  }

  get listCityOptions(): SheetSelectOption[] {
    return [
      { value: '', labelKey: this.i18nPrefix + '.FILTER_CITY_ALL', icon: 'fa fa-globe' },
      ...this.resultCities.map((city) => ({
        value: city,
        label: city,
        icon: 'fa fa-map-marker'
      }))
    ];
  }

  readonly sortSelectOptions: SheetSelectOption[] = this.sortOptions.map((key) => ({
    value: key,
    labelKey: this.sortLabelKey(key),
    icon: key.startsWith('distance')
      ? 'fa fa-location-arrow'
      : key.startsWith('name')
        ? 'fa fa-sort-alpha-asc'
        : key.startsWith('trade')
          ? 'fa fa-wrench'
          : 'fa fa-map-marker'
  }));

  tradeLabelKey(trade: string): string {
    return `ARTISANS.TRADE_${trade.toUpperCase()}`;
  }

  sortLabelKey(key: ArtisanSortKey): string {
    return `ARTISANS.SORT_${key.replace(/-/g, '_').toUpperCase()}`;
  }

  get listFilterActive(): boolean {
    return !!this.listQuery.trim() || this.listTrade !== 'all' || !!this.listCity;
  }

  private get serverHasCityCatalog(): boolean {
    return !this.showFavorites && !!this.result?.cities?.length;
  }

  listItemNumber(index: number): number {
    if (this.showFavorites) {
      return index + 1;
    }
    const per = this.effectivePerPage;
    return (this.page - 1) * per + index + 1;
  }

  get resultTrades(): string[] {
    const keys = new Set<string>();
    for (const item of this.resultTradeSourceItems()) {
      const key = this.itemTypeValue(item);
      if (key) {
        keys.add(key);
      }
    }
    return [...keys];
  }

  get tradeStats(): ArtisanTradeStat[] {
    const counts = new Map<string, { option: SheetSelectOption; count: number }>();
    for (const item of this.tradeStatItems()) {
      const option = this.itemTypeOption(item);
      if (!option) {
        continue;
      }
      const key = String(option.value);
      const prev = counts.get(key);
      if (prev) {
        prev.count += 1;
      } else {
        counts.set(key, { option, count: 1 });
      }
    }
    const rows = [...counts.values()];
    const total = rows.reduce((sum, row) => sum + row.count, 0) || 1;
    const mapped = rows.map((row) => ({
      value: String(row.option.value),
      label: this.typeOptionLabel(row.option),
      icon: row.option.icon || 'fa fa-wrench',
      count: row.count,
      pct: Math.round((row.count / total) * 1000) / 10
    }));
    mapped.sort((a, b) => this.compareTradeStats(a, b));
    return mapped;
  }

  get visibleTradeStats(): ArtisanTradeStat[] {
    const query = this.tradeStatsQuery.trim().toLowerCase();
    if (!query) {
      return this.tradeStats;
    }
    return this.tradeStats.filter((row) => row.label.toLowerCase().includes(query));
  }

  private compareTradeStats(a: ArtisanTradeStat, b: ArtisanTradeStat): number {
    if (this.tradeStatsSort === 'name-asc' || this.tradeStatsSort === 'name-desc') {
      const byName = a.label.localeCompare(b.label, this.uiLocale, { sensitivity: 'base' });
      const ordered = byName || (b.count - a.count);
      return this.tradeStatsSort === 'name-desc' ? -ordered : ordered;
    }
    const byCount = a.count - b.count;
    const ordered = byCount || a.label.localeCompare(b.label, this.uiLocale, { sensitivity: 'base' });
    return this.tradeStatsSort === 'count-desc' ? -ordered : ordered;
  }

  get tradeStatsCounted(): number {
    return this.tradeStats.reduce((sum, row) => sum + row.count, 0);
  }

  private tradeStatItems(): ArtisansNearbyItem[] {
    const extra = this.result?.mapItems;
    if (extra && extra.length) {
      const byId = new Map<string, ArtisansNearbyItem>();
      for (const item of extra) {
        byId.set(this.tradeItemId(item), item);
      }
      for (const item of this.items) {
        byId.set(this.tradeItemId(item), item);
      }
      return [...byId.values()];
    }
    return this.items;
  }

  get resultCities(): string[] {
    if (this.showFavorites) {
      return this.citiesFrom(this.favoritesWithDistance());
    }
    const fromApi = this.result?.cities;
    if (fromApi && fromApi.length) {
      return [...fromApi].sort((a, b) => a.localeCompare(b, this.uiLocale, { sensitivity: 'base' }));
    }
    return this.citiesFrom(this.listSourceItems());
  }

  private citiesFrom(items: ArtisansNearbyItem[]): string[] {
    const cities = new Set<string>();
    for (const item of items) {
      const city = (item.city || '').trim();
      if (city) {
        cities.add(city);
      }
    }
    return [...cities].sort((a, b) => a.localeCompare(b, this.uiLocale, { sensitivity: 'base' }));
  }

  get listPoolCount(): number {
    return this.showFavorites ? this.favorites.length : this.listSourceItems().length;
  }

  private listSourceItems(): ArtisansNearbyItem[] {
    if (this.showFavorites) {
      return this.favoritesWithDistance();
    }
    if (this.includeWithoutCoords) {
      return this.items.filter((item) => this.matchesSelectedTrade(item));
    }
    return this.viewportItems;
  }

  private favoritesWithDistance(): ArtisansNearbyItem[] {
    return this.favorites.map((item) => {
      if (this.searchLat == null || this.searchLon == null || !this.hasMapPoint(item)) {
        return item;
      }
      return {
        ...item,
        distanceKm: Math.round(
          haversineKm(this.searchLat, this.searchLon, item.lat as number, item.lon as number) * 10
        ) / 10
      };
    });
  }

  private favoriteMappedItems(): MappedArtisan[] {
    return this.favoritesWithDistance().filter((item): item is MappedArtisan => this.hasMapPoint(item));
  }

  private compareTradeLabels(a: string, b: string): number {
    return this.translatedTradeLabel(a).localeCompare(
      this.translatedTradeLabel(b),
      this.uiLocale,
      { sensitivity: 'base' }
    );
  }

  private translatedTradeLabel(trade: string): string {
    const key = this.tradeLabelKey(trade);
    const label = this.translate.instant(key);
    return label && !label.startsWith('ARTISANS.TRADE_') ? label : trade;
  }

  private get uiLocale(): string {
    const lang = (this.translate.currentLang || this.translate.defaultLang || 'fr').toLowerCase();
    const mapped: Record<string, string> = {
      cn: 'zh',
      jp: 'ja',
      in: 'hi'
    };
    return mapped[lang] || lang;
  }

  onListViewChange(): void {
    if (!this.showFavorites && this.source === 'sirene' && this.searched) {
      this.listQuery$.next(this.listQuery.trim());
    }
    this.applyListView();
    if (this.mapListOnly && !this.showFavorites) {
      this.redrawMapMarkers();
    }
  }

  onListCityChange(): void {
    if (!this.showFavorites && this.searched) {
      this.search(1, false, false);
      return;
    }
    this.onListViewChange();
  }

  onListSortChange(): void {
    if (!this.showFavorites && this.searched) {
      this.search(1, false, false);
      return;
    }
    this.onListViewChange();
  }

  private onDebouncedListQuery(query: string): void {
    if (this.showFavorites || this.source !== 'sirene' || !this.searched) {
      return;
    }
    const q = query.trim();
    if (q.length < 2 && !this.remoteListQuery) {
      return;
    }
    this.search(1, false, false);
  }

  websiteHref(item: ArtisansNearbyItem): string {
    return normalizeWebsite(item.website);
  }

  sirenePageHref(item: ArtisansNearbyItem): string {
    const url = (item.url || '').trim();
    if (url.includes('annuaire-entreprises.data.gouv.fr/')) {
      return url;
    }
    const id = String(item.id || '').replace(/\s/g, '');
    if (/^\d{14}$/.test(id)) {
      return `https://annuaire-entreprises.data.gouv.fr/etablissement/${id}`;
    }
    if (/^\d{9}$/.test(id)) {
      return `https://annuaire-entreprises.data.gouv.fr/entreprise/${id}`;
    }
    return '';
  }

  isWebsiteResolving(item: ArtisansNearbyItem): boolean {
    const id = item.id || item.name || '';
    return !!id && this.websiteResolving.has(id);
  }

  websiteLabel(item: ArtisansNearbyItem): string {
    const href = this.websiteHref(item);
    if (!href) {
      return this.translate.instant(`${this.i18nPrefix}.SITE`);
    }
    try {
      const host = new URL(href).hostname.replace(/^www\./i, '');
      return host || this.translate.instant(`${this.i18nPrefix}.SITE`);
    } catch {
      return this.translate.instant(`${this.i18nPrefix}.SITE`);
    }
  }

  siteButtonHref(item: ArtisansNearbyItem): string {
    return this.websiteHref(item) || this.siteSearchHref(item);
  }

  siteSearchHref(item: ArtisansNearbyItem): string {
    const quotedName = item.name?.trim() ? `"${item.name.trim()}"` : '';
    const query = [
      quotedName,
      item.city,
      item.postalCode,
      'site officiel',
      '-site:pagesjaunes.fr',
      '-site:facebook.com',
      '-site:societe.com',
      '-site:laposte.fr'
    ]
      .filter((part) => !!(part && String(part).trim()))
      .join(' ')
      .trim();
    if (!quotedName) {
      return '';
    }
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  }

  openSite(item: ArtisansNearbyItem, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const known = this.websiteHref(item);
    if (known) {
      window.open(known, '_blank', 'noopener,noreferrer');
      return;
    }
    void this.ensureWebsite(item).then((found) => {
      const href = found || this.siteSearchHref(item);
      if (href) {
        window.open(href, '_blank', 'noopener,noreferrer');
      }
      this.cdr.markForCheck();
    });
  }

  private ensureWebsite(item: ArtisansNearbyItem): Promise<string> {
    const known = this.websiteHref(item);
    if (known) {
      return Promise.resolve(known);
    }
    const id = item.id || item.name || '';
    const pending = id ? this.websiteJobs.get(id) : undefined;
    if (pending) {
      return pending;
    }
    if (id) {
      this.websiteResolving.add(id);
    }
    const job = firstValueFrom(resolveOfficialWebsite(this.http, item).pipe(
      catchError(() => of(''))
    )).then((url) => {
      if (url) {
        item.website = url;
      }
      if (id) {
        this.websiteResolving.delete(id);
        this.websiteJobs.delete(id);
      }
      this.refreshResolvedSiteUi();
      return url || '';
    });
    if (id) {
      this.websiteJobs.set(id, job);
    }
    return job;
  }

  private refreshResolvedSiteUi(): void {
    this.applyListView();
    for (const item of this.mapPlotItems) {
      const marker = item.id ? this.markers.get(item.id) : undefined;
      if (marker && this.websiteHref(item)) {
        marker.setTooltipContent(this.buildPopup(item));
      }
    }
    this.cdr.markForCheck();
  }

  private matchesSelectedTrade(item: ArtisansNearbyItem): boolean {
    if (this.trade === 'all') {
      return true;
    }
    if (this.resolvedTradeKey(item) === this.trade) {
      return true;
    }
    const naf = normalizeNaf(item.activityCode);
    return (TRADE_NAF_CODES[this.trade] || []).includes(naf);
  }

  resolvedTradeKey(item: ArtisansNearbyItem): string {
    const fromItem = (item.tradeKey || '').trim();
    if (fromItem && fromItem !== 'all') {
      return fromItem;
    }
    const fromCode = tradeKeyFromCode(item.activityCode);
    if (fromCode) {
      return fromCode;
    }
    return this.trade !== 'all' ? this.trade : '';
  }

  domainLabel(item: ArtisansNearbyItem): string {
    const key = this.resolvedTradeKey(item);
    if (key) {
      const translated = this.translate.instant(this.tradeLabelKey(key));
      if (translated && !translated.startsWith('ARTISANS.TRADE_')) {
        return translated;
      }
    }
    return this.activityDetail(item)
      || this.translate.instant(`${this.i18nPrefix}.ACTIVITY_UNKNOWN`);
  }

  activityDetail(item: ArtisansNearbyItem): string {
    return (item.activity || '').trim() || activityLabelFromCode(item.activityCode);
  }

  openTraceViewerForSelection(): void {
    if (!this.traceViewer) {
      return;
    }
    const lat = this.searchLat != null && Number.isFinite(this.searchLat)
      ? this.searchLat
      : ArtisansNearbyComponent.DEFAULT_MAP_LAT;
    const lon = this.searchLon != null && Number.isFinite(this.searchLon)
      ? this.searchLon
      : ArtisansNearbyComponent.DEFAULT_MAP_LNG;
    const label = (this.placeLabel || this.addressQuery || '').trim()
      || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    this.traceViewer.openAtLocation(lat, lon, label, undefined, true, true);
  }

  onLocationSelected(location: { lat: number; lng: number }): void {
    if (!Number.isFinite(location?.lat) || !Number.isFinite(location?.lng)) {
      return;
    }
    this.ngZone.run(() => this.applyPickedMapLocation(location.lat, location.lng));
  }

  useMyPosition(autoSearch = false): void {
    this.locating = true;
    this.errorMessage = '';
    this.positionSub?.unsubscribe();
    this.positionSub = this.position.getGpsPosition().pipe(
      switchMap((gps) => gps ? of(gps) : this.position.getIpPosition())
    ).subscribe({
      next: (coords) => {
        this.ngZone.run(() => {
          this.locating = false;
          if (!coords) {
            this.errorMessage = `${this.i18nPrefix}.GEO_DENIED`;
            this.cdr.markForCheck();
            return;
          }
          this.searchLat = coords.latitude;
          this.searchLon = coords.longitude;
          this.placeLabel = '';
          this.addressQuery = '';
          this.addressPicked = false;
          this.clearAddressHits();
          this.errorMessage = '';
          this.cdr.markForCheck();
          this.fillPlaceFromCoords(coords.latitude, coords.longitude);
          if (autoSearch || this.searched) {
            this.search(1);
          }
        });
      },
      error: () => {
        this.ngZone.run(() => {
          this.locating = false;
          this.errorMessage = `${this.i18nPrefix}.GEO_DENIED`;
          this.cdr.markForCheck();
        });
      }
    });
  }

  get placeCaption(): string {
    const label = (this.placeLabel || '').trim();
    if (label && !looksLikeCoordinates(label)) {
      return label;
    }
    if (this.searchLat != null && this.searchLon != null) {
      return `${this.searchLat.toFixed(5)}, ${this.searchLon.toFixed(5)}`;
    }
    return '';
  }

  private fillPlaceFromCoords(lat: number, lon: number): void {
    this.placeGeocodeSub?.unsubscribe();
    this.placeGeocodeSub = this.api.geocodeReverse(lat, lon).pipe(
      take(1),
      catchError(() => of(null))
    ).subscribe((res) => {
      const label = String(res?.displayName || res?.display_name || '').trim();
      if (label && this.searchLat === lat && this.searchLon === lon) {
        this.placeLabel = label;
        this.cdr.markForCheck();
      }
    });
  }

  private withOsmFallback(
    res: ArtisansNearbyResponse,
    lat?: number,
    lon?: number
  ): Observable<ArtisansNearbyResponse> {
    if (this.source !== 'osm' || this.cacheMode === 'cache' || (res.items && res.items.length)) {
      return of(res);
    }
    const useLat = lat ?? res.lat ?? this.searchLat;
    const useLon = lon ?? res.lon ?? this.searchLon;
    if (useLat == null || useLon == null) {
      return of(res);
    }
    return searchOsmOverpass(this.http, useLat, useLon, this.radiusKm, this.trade, this.page, this.listPageSize).pipe(
      map((fallback) => ({
        ...fallback,
        cacheCount: res.cacheCount ?? fallback.cacheCount,
        cacheMode: res.cacheMode ?? fallback.cacheMode
      })),
      catchError(() => of(res))
    );
  }

  setSource(source: ArtisansSource): void {
    if (source === this.source || this.isLoading) {
      return;
    }
    this.applySource(source, true);
  }

  private applySource(source: ArtisansSource, rerunSearch: boolean): void {
    this.source = source;
    this.i18nPrefix = source === 'osm' ? 'NEARBY_PROS' : 'ARTISANS';
    this.rebuildTradeSelectOptions();
    if (!this.isSelectableSearchTrade(this.trade)) {
      this.trade = 'all';
    }
    this.refreshCacheCount();
    if (rerunSearch && this.searched) {
      this.search(1, false);
    }
  }

  private isSelectableSearchTrade(trade: string): boolean {
    if (this.trades.includes(trade)) {
      return true;
    }
    return this.source === 'sirene' && trade.startsWith('naf:');
  }

  setCacheMode(mode: ArtisansCacheMode): void {
    if (mode === this.cacheMode || this.isLoading) {
      return;
    }
    this.cacheMode = mode;
    if (this.searched) {
      this.search(1, false);
    }
  }

  cacheModeLabelKey(mode: ArtisansCacheMode): string {
    if (mode === 'cache') {
      return 'ARTISANS.SOURCE_CACHE';
    }
    if (mode === 'api') {
      return 'ARTISANS.SOURCE_API';
    }
    return 'ARTISANS.SOURCE_BOTH';
  }

  cacheModeIcon(mode: ArtisansCacheMode): string {
    if (mode === 'cache') {
      return 'fa-database';
    }
    if (mode === 'api') {
      return 'fa-cloud';
    }
    return 'fa-random';
  }

  clearCache(): void {
    if (this.clearingCache) {
      return;
    }
    this.clearingCache = true;
    this.cacheFilling = false;
    this.searchSub?.unsubscribe();
    this.cachePollSub?.unsubscribe();
    this.cacheReloadSub?.unsubscribe();
    this.isLoading = false;
    this.cacheSub?.unsubscribe();
    this.cacheSub = this.api.clearArtisansCache(this.source).subscribe({
      next: () => {
        this.clearingCache = false;
        this.cacheCount = 0;
        this.cacheTrades = [];
        if (this.cacheMode === 'cache') {
          this.applyEmptyCacheResults();
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.clearingCache = false;
        this.errorMessage = `${this.i18nPrefix}.ERROR`;
        this.cdr.markForCheck();
      }
    });
  }

  private applyEmptyCacheResults(): void {
    this.result = {
      ...(this.result || {}),
      items: [],
      total: 0,
      cacheCount: 0,
      cacheMode: 'cache',
      source: this.source
    };
    this.listItems = [];
    this.viewportItems = [];
    setTimeout(() => this.refreshMapMarkers(false), 0);
  }

  private refreshCacheCount(): void {
    this.cacheSub?.unsubscribe();
    this.cacheSub = this.api.getArtisansCache(this.source).subscribe({
      next: (res) => {
        this.cacheCount = res?.count ?? 0;
        this.cdr.markForCheck();
      },
      error: () => {
        this.cacheCount = 0;
      }
    });
  }

  private startCacheCountPoll(): void {
    this.cachePollSub?.unsubscribe();
    this.cacheFilling = this.cacheMode !== 'cache';
    this.cdr.markForCheck();
    let last = this.cacheCount;
    let stable = 0;
    this.cachePollSub = interval(2000).pipe(
      take(180),
      switchMap(() => this.api.getArtisansCache(this.source).pipe(catchError(() => of({ count: last })))),
      takeWhile((res) => {
        const n = res?.count ?? last;
        if (n === last) {
          stable++;
          return stable < 20;
        }
        last = n;
        stable = 0;
        return true;
      }, true)
    ).subscribe({
      next: (res) => {
        if (res?.count == null) {
          return;
        }
        const grew = res.count > this.cacheCount;
        this.cacheCount = res.count;
        this.cacheFilling = grew;
        if (grew && this.cacheMode === 'cache' && this.searched && !this.showFavorites) {
          this.reloadCachePageQuietly();
        }
        this.cdr.markForCheck();
      },
      complete: () => {
        this.cacheFilling = false;
        this.cdr.markForCheck();
      }
    });
  }

  private reloadCachePageQuietly(): void {
    if (this.cacheMode !== 'cache' || this.isLoading) {
      return;
    }
    const hasPoint = this.searchLat != null && this.searchLon != null;
    const q = this.addressQuery.trim();
    if (!hasPoint && !q) {
      return;
    }
    this.cacheReloadSub?.unsubscribe();
    this.cacheReloadSub = this.api.searchArtisansNearby({
      source: this.source,
      lat: hasPoint ? this.searchLat! : undefined,
      lon: hasPoint ? this.searchLon! : undefined,
      q: this.placeLabel || q || undefined,
      radiusKm: this.radiusKm,
      trade: this.trade,
      page: this.page,
      perPage: this.listPageSize,
      text: this.source === 'sirene' && this.listQuery.trim().length >= 2 ? this.listQuery.trim() : undefined,
      city: this.listCity.trim() || undefined,
      sort: this.sortKey,
      cache: 'cache',
      withoutCoords: this.includeWithoutCoords || undefined,
      includeClosed: this.includeClosed ? undefined : false
    }).subscribe({
      next: (res) => {
        this.result = res;
        if (res.cacheCount != null) {
          this.cacheCount = res.cacheCount;
        }
        this.cdr.markForCheck();
        setTimeout(() => this.refreshMapMarkers(false), 0);
      }
    });
  }

  onWithoutCoordsChange(value: boolean): void {
    this.includeWithoutCoords = value;
    if (this.searched) {
      this.search(1, false, false);
    }
  }

  onIncludeClosedChange(value: boolean): void {
    this.includeClosed = value;
    if (this.searched) {
      this.search(1, false, false);
      return;
    }
    this.applyListView();
    this.refreshMapMarkers(false);
  }

  onPageSizeChange(): void {
    this.listPageSize = this.clampPerPage(Number(this.listPageSize));
    this.persistPreferences();
    if (this.searched) {
      this.search(1, false, false);
    }
  }

  onMapListOnlyChange(value: boolean): void {
    const next = !!value;
    if (this.mapListOnly === next) {
      return;
    }
    this.mapListOnly = next;
    this.persistPreferences();
    if (this.searched || this.showFavorites) {
      this.refreshMapMarkers(false);
    }
  }

  onTradeChange(): void {
    if (this.searched) {
      this.search(1);
    }
  }

  onRadiusSliderChange(): void {
    this.updateRadiusCircle();
    this.applyRadiusToMap();
    this.radiusSearch$.next(this.radiusKm);
  }

  private searchAfterRadiusChange(): void {
    if (this.showFavorites || this.searchLat == null || this.searchLon == null) {
      return;
    }
    this.search(1, false, false);
  }

  private searchAroundMapClick(latlng: L.LatLng): void {
    if (this.isLoading) {
      return;
    }
    this.applyPickedMapLocation(latlng.lat, latlng.lng);
  }

  private applyPickedMapLocation(lat: number, lon: number): void {
    this.addressQuery = '';
    this.placeLabel = '';
    this.addressPicked = false;
    this.clearAddressHits();
    this.searchLat = lat;
    this.searchLon = lon;
    this.fillPlaceFromCoords(lat, lon);
    this.search(1, true);
  }

  onAddressQueryChange(): void {
    const q = this.addressQuery.trim();
    if (this.addressPicked && q === (this.placeLabel || '').trim()) {
      return;
    }
    this.addressPicked = false;
    this.errorMessage = '';
    this.addressSearch$.next(this.addressQuery);
  }

  onAddressKeydown(event: KeyboardEvent): void {
    const hits = this.addressHits;
    if (!hits.length && event.key !== 'Escape') {
      return;
    }
    const active = this.addressActiveIndex;
    const setActive = (index: number) => {
      this.addressActiveIndex = index;
      this.cdr.markForCheck();
    };
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive(active < hits.length - 1 ? active + 1 : 0);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive(active > 0 ? active - 1 : hits.length - 1);
        break;
      case 'Enter':
        if (active >= 0 && active < hits.length) {
          event.preventDefault();
          this.selectAddress(hits[active]);
        }
        break;
      case 'Escape':
        event.preventDefault();
        this.clearAddressHits();
        this.cdr.markForCheck();
        break;
      case 'Home':
        if (hits.length) {
          event.preventDefault();
          setActive(0);
        }
        break;
      case 'End':
        if (hits.length) {
          event.preventDefault();
          setActive(hits.length - 1);
        }
        break;
      default:
        break;
    }
  }

  submitAddressSearch(): void {
    if (this.addressHits.length) {
      const hit = this.addressHits[this.addressActiveIndex] ?? this.addressHits[0];
      this.selectAddress(hit);
      return;
    }
    const q = this.addressQuery.trim();
    if (q && !this.addressPicked) {
      this.lookupAddresses(q, true);
      return;
    }
    this.search(1);
  }

  selectAddress(hit: AddressHit): void {
    if (!hit?.displayName || !Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) {
      return;
    }
    this.addressQuery = hit.displayName;
    this.placeLabel = hit.displayName;
    this.searchLat = hit.lat;
    this.searchLon = hit.lon;
    this.addressPicked = true;
    this.clearAddressHits();
    this.search(1);
  }

  private lookupAddresses(query: string, fromSubmit: boolean): void {
    const q = query.trim();
    if (q.length < 3) {
      this.clearAddressHits();
      this.addressSearching = false;
      if (fromSubmit) {
        this.errorMessage = `${this.i18nPrefix}.NEED_PLACE`;
      }
      this.cdr.markForCheck();
      return;
    }
    this.addressSearching = true;
    if (fromSubmit) {
      this.errorMessage = '';
    }
    this.addressGeocodeSub?.unsubscribe();
    this.addressGeocodeSub = this.api.geocodeSearch(q).pipe(take(1)).subscribe({
      next: (data) => {
        this.addressHits = this.mapGeocodeHits(data);
        this.addressActiveIndex = this.addressHits.length ? 0 : -1;
        this.addressSearching = false;
        if (!this.addressHits.length) {
          this.errorMessage = `${this.i18nPrefix}.ADDRESS_NOT_FOUND`;
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.addressHits = [];
        this.addressActiveIndex = -1;
        this.addressSearching = false;
        this.errorMessage = `${this.i18nPrefix}.ADDRESS_NOT_FOUND`;
        this.cdr.markForCheck();
      }
    });
  }

  private mapGeocodeHits(data: unknown[]): AddressHit[] {
    return (data || []).map((item: any) => {
      const lat = typeof item?.lat === 'number' ? item.lat : parseFloat(item?.lat);
      const lon = typeof item?.lon === 'number' ? item.lon : parseFloat(item?.lon ?? item?.lng);
      const displayName = String(item?.displayName || item?.display_name || '').trim();
      return { lat, lon, displayName };
    }).filter((hit: AddressHit) => hit.displayName && Number.isFinite(hit.lat) && Number.isFinite(hit.lon));
  }

  private clearAddressHits(): void {
    this.addressHits = [];
    this.addressActiveIndex = -1;
    this.addressSearching = false;
  }

  search(page = 1, fitMap = true, resetListFilters = true): void {
    const hasPoint = this.searchLat != null && this.searchLon != null;
    const q = this.addressQuery.trim();
    if (!hasPoint && !q) {
      this.errorMessage = `${this.i18nPrefix}.NEED_PLACE`;
      return;
    }
    if (q && !this.addressPicked) {
      this.lookupAddresses(q, true);
      return;
    }
    this.page = page;
    this.isLoading = true;
    this.searched = true;
    this.showFavorites = false;
    this.errorMessage = '';
    if (resetListFilters) {
      this.listItems = [];
      this.viewportItems = [];
      this.listQuery = '';
      this.listTrade = 'all';
      this.listCity = '';
      this.remoteListQuery = '';
    }
    const listText = !resetListFilters && this.source === 'sirene' && this.listQuery.trim().length >= 2
      ? this.listQuery.trim()
      : '';
    const listCity = !resetListFilters ? this.listCity.trim() : '';
    this.searchSub?.unsubscribe();
    this.cachePollSub?.unsubscribe();
    this.websiteResolving.clear();
    this.websiteJobs.clear();
    const lat = hasPoint ? this.searchLat! : undefined;
    const lon = hasPoint ? this.searchLon! : undefined;
    this.searchSub = this.api.searchArtisansNearby({
      source: this.source,
      lat,
      lon,
      q: this.placeLabel || q || undefined,
      radiusKm: this.radiusKm,
      trade: this.trade,
      page: this.page,
      perPage: this.listPageSize,
      text: listText || undefined,
      city: listCity || undefined,
      sort: this.sortKey,
      cache: this.cacheMode,
      withoutCoords: this.includeWithoutCoords || undefined,
      includeClosed: this.includeClosed ? undefined : false
    }).pipe(
      catchError((err) => this.source === 'osm' ? of({ items: [], total: 0 } as ArtisansNearbyResponse) : throwError(() => err)),
      switchMap((res) => this.withOsmFallback(res, lat, lon))
    ).subscribe({
      next: (res) => {
        this.result = res;
        this.isLoading = false;
        this.remoteListQuery = listText;
        if (res.cacheCount != null) {
          this.cacheCount = res.cacheCount;
        }
        this.startCacheCountPoll();
        if (res.lat != null && res.lon != null) {
          this.searchLat = res.lat;
          this.searchLon = res.lon;
        }
        if (res.placeLabel && !looksLikeCoordinates(res.placeLabel)) {
          this.placeLabel = res.placeLabel;
        } else if (!this.placeLabel.trim() && this.searchLat != null && this.searchLon != null) {
          this.fillPlaceFromCoords(this.searchLat, this.searchLon);
        }
        this.selectedId = this.mappedItems[0]?.id || null;
        this.cdr.markForCheck();
        setTimeout(() => {
          this.ensureMap();
          const reuseMarkers = !fitMap
            && !this.mapListOnly
            && !!(res.mapItems && res.mapItems.length)
            && this.markers.size > 0;
          if (reuseMarkers) {
            this.syncListToMap();
          } else {
            this.refreshMapMarkers(fitMap);
          }
        }, 0);
      },
      error: (err) => {
        this.isLoading = false;
        this.result = null;
        const status = err?.status;
        this.errorMessage = status === 404
          ? `${this.i18nPrefix}.ADDRESS_NOT_FOUND`
          : `${this.i18nPrefix}.ERROR`;
        this.cdr.markForCheck();
      }
    });
  }

  shareOnWhatsApp(item: ArtisansNearbyItem, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const text = this.itemShareText(item);
    if (!text) {
      return;
    }
    openWhatsAppTextShare(text);
  }

  private itemShareText(item: ArtisansNearbyItem): string {
    const name = (item.name || '').trim();
    const type = this.domainLabel(item);
    const cityLine = [item.postalCode, item.city].filter(Boolean).join(' ').trim();
    const address = (item.address || '').trim();
    const place = address && cityLine && address.toLowerCase().includes(cityLine.toLowerCase())
      ? address
      : [address, cityLine].filter(Boolean).join(', ');
    const sirene = this.sirenePageHref(item);
    const lines = [
      name ? `*${name}*` : '',
      type,
      place
    ].map((line) => line.trim()).filter(Boolean);
    if (sirene) {
      lines.push('', sirene);
    } else if ((item.url || '').trim()) {
      lines.push('', (item.url || '').trim());
    }
    return lines.join('\n');
  }

  openInTraceViewer(item: ArtisansNearbyItem, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!this.traceViewer || item.lat == null || item.lon == null
        || !Number.isFinite(item.lat) || !Number.isFinite(item.lon)) {
      return;
    }
    const label = [item.name, item.address, item.postalCode, item.city]
      .filter((part) => !!(part && String(part).trim()))
      .join(' · ');
    this.traceViewer.openAtLocation(item.lat, item.lon, label);
  }

  onListHover(item: ArtisansNearbyItem): void {
    this.startMarkerBlink(item.id);
    this.showMarkerInfo(item.id);
  }

  onListLeave(): void {
    this.stopMarkerBlink();
    this.hideMarkerInfo();
  }

  selectItem(item: ArtisansNearbyItem): void {
    this.highlightListItem(item.id);
    void this.ensureWebsite(item);
  }

  private highlightListItem(id: string | undefined, scrollToTop = false): void {
    if (!id) {
      return;
    }
    this.selectedId = id;
    this.cdr.detectChanges();
    if (scrollToTop) {
      setTimeout(() => this.scrollHitToTop(id), 0);
    }
  }

  private isStackedLayout(): boolean {
    return typeof window !== 'undefined'
      && !window.matchMedia('(min-width: 801px)').matches;
  }

  private onMapClicked(event: L.LeafletMouseEvent): void {
    if (Date.now() < this.suppressMapClickUntil) {
      return;
    }
    const tapOnMarker = this.eventHitsMarker(event);
    const maxPx = tapOnMarker
      ? 140
      : (this.isStackedLayout() ? 72 : 28);
    const item = this.artisanNearPoint(event.containerPoint, maxPx);
    if (item) {
      this.selectArtisanFromMap(item);
      return;
    }
    if (tapOnMarker) {
      return;
    }
    this.searchAroundMapClick(event.latlng);
  }

  private eventHitsMarker(event: L.LeafletMouseEvent): boolean {
    const target = event.originalEvent?.target;
    return target instanceof Element && !!target.closest('.leaflet-interactive');
  }

  private artisanNearPoint(clickPt: L.Point, maxPx: number): ArtisansNearbyItem | null {
    if (!this.map) {
      return null;
    }
    const mapped = this.showFavorites ? this.favoriteMappedItems() : this.mapPlotItems;
    let best: ArtisansNearbyItem | null = null;
    let bestDist = maxPx;
    for (const item of mapped) {
      const pt = this.map.latLngToContainerPoint(L.latLng(item.lat, item.lon));
      const dist = clickPt.distanceTo(pt);
      if (dist <= bestDist) {
        bestDist = dist;
        best = item;
      }
    }
    return best;
  }

  private selectArtisanFromMap(item: ArtisansNearbyItem): void {
    this.suppressMapClickUntil = Date.now() + 800;
    if (this.listFilterActive) {
      this.listQuery = '';
      this.listTrade = 'all';
      this.listCity = '';
      this.applyListView();
    }
    this.highlightListItem(item.id, true);
    this.startMarkerBlink(item.id);
    this.showMarkerInfo(item.id);
    void this.ensureWebsite(item);
  }

  private scrollHitToTop(id: string, attempt = 0): void {
    const list = this.resultsList?.nativeElement;
    if (!list) {
      if (attempt < 10) {
        setTimeout(() => this.scrollHitToTop(id, attempt + 1), 40);
      }
      return;
    }
    let hit: HTMLElement | null = null;
    for (const el of Array.from(list.querySelectorAll('[data-artisan-id]'))) {
      if (el.getAttribute('data-artisan-id') === id) {
        hit = el as HTMLElement;
        break;
      }
    }
    if (!hit) {
      if (attempt < 10) {
        setTimeout(() => this.scrollHitToTop(id, attempt + 1), 40);
      }
      return;
    }
    const top = hit.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTop = Math.max(0, top);
  }

  /** Leaflet focuses the map on tap; without this the page jumps to the map on mobile. */
  private preventMapFocusScroll(): void {
    const container = this.map?.getContainer();
    if (!container) {
      return;
    }
    const nativeFocus = HTMLElement.prototype.focus;
    container.focus = function (this: HTMLElement, options?: FocusOptions) {
      nativeFocus.call(this, {
        ...(typeof options === 'object' && options ? options : {}),
        preventScroll: true
      });
    };
    if (this.isStackedLayout()) {
      const keyboard = (this.map as L.Map & { keyboard?: L.Handler }).keyboard;
      keyboard?.disable();
      container.tabIndex = -1;
    }
  }

  previousPage(): void {
    if (this.page > 1) {
      this.search(this.page - 1, false, false);
    }
  }

  nextPage(): void {
    if (this.page < this.totalPages) {
      this.search(this.page + 1, false, false);
    }
  }

  private ensureMap(): void {
    const el = this.mapHost?.nativeElement;
    if (!el || this.map) {
      this.map?.invalidateSize();
      this.updateRadiusCircle();
      return;
    }
    this.map = L.map(el, {
      zoomControl: true,
      attributionControl: true,
      tapTolerance: 32,
      keyboard: !this.isStackedLayout()
    });
    this.preventMapFocusScroll();
    this.ensureRadiusPane();
    this.markerRenderer = L.canvas({ padding: 0.5 });
    this.baseLayer = this.basemap.applyBaseLayer(this.map, this.mapBaseLayerId, null);
    this.mapLayer = L.featureGroup().addTo(this.map);
    this.map.setView([46.6, 2.5], 6);
    this.map.on('moveend zoomend', () => {
      this.ngZone.run(() => this.onMapViewChanged());
    });
    this.map.on('click', (event: L.LeafletMouseEvent) => {
      this.ngZone.run(() => this.onMapClicked(event));
    });
    this.map.on('tooltipopen', (event: L.TooltipEvent) => {
      this.closeOtherTooltips(event.tooltip);
    });
    const card = this.mapCard?.nativeElement;
    card?.querySelectorAll('.artisans-basemap, .artisans-map-fs-btn, .artisans-place, .artisans-map-list-switch').forEach((node) => {
      L.DomEvent.disableClickPropagation(node as HTMLElement);
      L.DomEvent.disableScrollPropagation(node as HTMLElement);
    });
    setTimeout(() => this.map?.invalidateSize(), 0);
  }

  itemHasMapPoint(item: ArtisansNearbyItem): boolean {
    return this.hasMapPoint(item);
  }

  private hasMapPoint(item: ArtisansNearbyItem): boolean {
    return item.lat != null && item.lon != null
      && Number.isFinite(item.lat) && Number.isFinite(item.lon);
  }

  private syncListToMap(): void {
    const mapped = this.mappedItems;
    this.viewportItems = mapped;
    if (this.listCity && !this.resultCities.includes(this.listCity)) {
      this.listCity = '';
    }
    if (this.listTrade !== 'all' && !this.resultTrades.includes(this.listTrade)) {
      this.listTrade = 'all';
    }
    this.applyListView();
  }

  private applyListView(): void {
    this.rebuildListTradeOptions();
    const query = (this.showFavorites || this.source === 'osm')
      ? this.listQuery.trim().toLowerCase()
      : '';
    let items = this.listSourceItems().filter((item) => {
      if (this.listTrade !== 'all' && this.itemTypeValue(item) !== this.listTrade) {
        return false;
      }
      if (this.listCity && !this.serverHasCityCatalog && (item.city || '').trim().toLowerCase() !== this.listCity.trim().toLowerCase()) {
        return false;
      }
      if (!this.showFavorites && !this.includeClosed && this.isItemClosed(item)) {
        return false;
      }
      if (!query) {
        return true;
      }
      const hay = [
        item.name,
        item.legalName,
        item.address,
        item.city,
        item.postalCode,
        item.activity,
        item.activityCode,
        item.website,
        this.domainLabel(item)
      ].join(' ').toLowerCase();
      return hay.includes(query);
    });
    if (this.showFavorites || !this.searched) {
      items = items.slice().sort((a, b) => this.compareItems(a, b));
    }
    this.listItems = items;
    if (this.selectedId && !items.some((item) => item.id === this.selectedId)) {
      const stillAround = this.listSourceItems().some((item) => item.id === this.selectedId);
      if (!stillAround) {
        this.selectedId = items[0]?.id || null;
      }
    }
    this.cdr.markForCheck();
  }

  private compareItems(a: ArtisansNearbyItem, b: ArtisansNearbyItem): number {
    const name = (item: ArtisansNearbyItem) => (item.name || '').trim();
    const city = (item: ArtisansNearbyItem) => (item.city || '').trim();
    const dist = (item: ArtisansNearbyItem) => item.distanceKm ?? Number.POSITIVE_INFINITY;
    switch (this.sortKey) {
      case 'distance-desc':
        return dist(b) - dist(a) || name(a).localeCompare(name(b), undefined, { sensitivity: 'base' });
      case 'name-asc':
        return name(a).localeCompare(name(b), undefined, { sensitivity: 'base' });
      case 'name-desc':
        return name(b).localeCompare(name(a), undefined, { sensitivity: 'base' });
      case 'trade-asc':
        return this.domainLabel(a).localeCompare(this.domainLabel(b), undefined, { sensitivity: 'base' })
          || name(a).localeCompare(name(b), undefined, { sensitivity: 'base' });
      case 'city-asc':
        return city(a).localeCompare(city(b), undefined, { sensitivity: 'base' })
          || name(a).localeCompare(name(b), undefined, { sensitivity: 'base' });
      case 'distance-asc':
      default:
        return dist(a) - dist(b) || name(a).localeCompare(name(b), undefined, { sensitivity: 'base' });
    }
  }

  private onMapViewChanged(): void {
    this.syncListToMap();
  }

  private applyRadiusToMap(): void {
    if (!this.map || this.searchLat == null || this.searchLon == null) {
      return;
    }
    const center = L.latLng(this.searchLat, this.searchLon);
    this.map.fitBounds(center.toBounds(this.radiusKm * 2000), {
      padding: [16, 16],
      maxZoom: 15
    });
    this.updateRadiusCircle();
  }

  private ensureRadiusPane(): void {
    if (!this.map || this.map.getPane('radiusPane')) {
      return;
    }
    this.map.createPane('radiusPane');
    const pane = this.map.getPane('radiusPane');
    if (pane) {
      pane.style.zIndex = '350';
    }
  }

  private updateRadiusCircle(): void {
    if (!this.map || this.searchLat == null || this.searchLon == null) {
      return;
    }
    this.ensureRadiusPane();
    const ring = geodesicCircleRing(this.searchLat, this.searchLon, this.radiusKm * 1000);
    if (this.radiusCircle) {
      this.radiusCircle.setLatLngs(ring);
      if (!this.map.hasLayer(this.radiusCircle)) {
        this.radiusCircle.addTo(this.map);
      }
      return;
    }
    this.radiusCircle = L.polygon(ring, {
      pane: 'radiusPane',
      color: '#c45c26',
      weight: 2,
      fillColor: '#c45c26',
      fillOpacity: 0.08,
      interactive: false
    }).addTo(this.map);
  }

  private startMarkerBlink(id?: string): void {
    this.stopMarkerBlink();
    if (!id) {
      return;
    }
    const marker = this.markers.get(id);
    if (!marker) {
      return;
    }
    this.blinkingMarker = marker;
    this.blinkingId = id;
    let on = false;
    const pulse = () => {
      on = !on;
      if (this.isCircleMarker(marker)) {
        const base = this.isStackedLayout() ? 12 : 8;
        marker.setStyle({
          radius: on ? base + 4 : base,
          weight: on ? 3 : 2,
          color: '#fff',
          fillColor: '#dc3545',
          fillOpacity: on ? 1 : 0.28
        });
        marker.bringToFront();
        return;
      }
      marker.getElement()?.classList.toggle('artisans-closed-pin--pulse', on);
    };
    pulse();
    this.ngZone.runOutsideAngular(() => {
      this.blinkTimer = setInterval(pulse, 260);
    });
  }

  private stopMarkerBlink(): void {
    if (this.blinkTimer != null) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    if (this.blinkingMarker) {
      if (this.isCircleMarker(this.blinkingMarker)) {
        this.blinkingMarker.setStyle(this.styleForItemId(this.blinkingId));
      } else {
        this.blinkingMarker.getElement()?.classList.remove('artisans-closed-pin--pulse');
      }
      this.blinkingMarker = null;
      this.blinkingId = null;
    }
  }

  private styleForItemId(id?: string | null) {
    const favorite = !!(id && (
      this.favoriteKeys.has(`${this.source}:${id}`)
      || this.favorites.some((item) => item.id === id)
    ));
    return this.markerStyle(favorite);
  }

  private refreshMapMarkers(fitMap = false): void {
    this.ensureMap();
    if (!this.map || !this.mapLayer) {
      return;
    }
    if (this.showFavorites) {
      this.hideRadiusCircle();
      this.applyListView();
    } else {
      this.updateRadiusCircle();
      this.syncListToMap();
      if (fitMap && this.searchLat != null && this.searchLon != null) {
        this.applyRadiusToMap();
      }
    }
    this.redrawMapMarkers();
    if (this.showFavorites && fitMap) {
      const mapped = this.favoriteMappedItems();
      if (mapped.length) {
        const bounds = L.latLngBounds(mapped.map((item) => [item.lat, item.lon] as [number, number]));
        this.map.fitBounds(bounds.pad(0.12), { maxZoom: 15, padding: [16, 16] });
      }
    }
    setTimeout(() => this.map?.invalidateSize(), 0);
  }

  private redrawMapMarkers(): void {
    if (!this.map || !this.mapLayer) {
      return;
    }
    this.stopMarkerBlink();
    this.mapLayer.clearLayers();
    this.markers.clear();
    const mapped = this.showFavorites ? this.favoriteMappedItems() : this.mapPlotItems;
    if (!this.showFavorites && this.searchLat != null && this.searchLon != null) {
      const center = L.circleMarker([this.searchLat, this.searchLon], {
        radius: 8,
        color: '#fff',
        weight: 2,
        fillColor: '#0d6efd',
        fillOpacity: 1
      });
      center.bindTooltip(
        this.escapeHtml(this.placeLabel || this.translate.instant(`${this.i18nPrefix}.YOU`)),
        this.markerTooltipOptions()
      );
      center.on('click', (event) => L.DomEvent.stopPropagation(event));
      center.addTo(this.mapLayer);
    }
    for (const item of mapped) {
      const closed = this.isItemClosed(item);
      const favorite = this.isFavorite(item);
      const marker = closed
        ? L.marker([item.lat, item.lon], {
            icon: this.closedMarkerIcon(),
            keyboard: false,
            riseOnHover: true
          })
        : L.circleMarker([item.lat, item.lon], {
            ...this.markerStyle(favorite),
            renderer: this.markerRenderer
          });
      marker.bindTooltip(this.buildPopup(item), this.markerTooltipOptions());
      marker.on('mouseover', () => {
        this.closeOtherTooltips(marker.getTooltip());
        if (this.blinkingMarker === marker) {
          return;
        }
        if (this.isCircleMarker(marker)) {
          const rest = this.markerStyle(favorite);
          marker.setStyle({ radius: rest.radius + 3, weight: 2 });
          marker.bringToFront();
        } else {
          marker.getElement()?.classList.add('artisans-closed-pin--hover');
        }
        this.ngZone.run(() => this.highlightListItem(item.id));
      });
      marker.on('mouseout', () => {
        if (this.blinkingMarker === marker) {
          return;
        }
        if (this.isCircleMarker(marker)) {
          marker.setStyle(this.markerStyle(favorite));
        } else {
          marker.getElement()?.classList.remove('artisans-closed-pin--hover');
        }
      });
      marker.on('click', (event) => {
        L.DomEvent.stop(event);
        this.ngZone.run(() => this.selectArtisanFromMap(item));
      });
      marker.addTo(this.mapLayer);
      if (item.id) {
        this.markers.set(item.id, marker);
      }
    }
  }

  private hideRadiusCircle(): void {
    if (this.radiusCircle && this.map?.hasLayer(this.radiusCircle)) {
      this.map.removeLayer(this.radiusCircle);
    }
  }

  private showMarkerInfo(id?: string): void {
    this.hideMarkerInfo();
    if (!id) {
      return;
    }
    const marker = this.markers.get(id);
    if (!marker) {
      return;
    }
    if (this.isStackedLayout()) {
      this.openMobileInfo(marker);
      return;
    }
    marker.openTooltip();
  }

  private openMobileInfo(marker: ArtisanMarker): void {
    const html = marker.getTooltip()?.getContent();
    if (html == null || html === '') {
      return;
    }
    marker.unbindPopup();
    marker.bindPopup(html, {
      className: 'artisans-map-popup',
      closeButton: true,
      autoPan: true,
      autoPanPadding: [18, 36],
      maxWidth: 280,
      minWidth: 160,
      offset: [0, -4]
    });
    setTimeout(() => {
      if (this.blinkingMarker === marker || this.markers.get(this.selectedId || '') === marker) {
        marker.openPopup();
      }
    }, 60);
  }

  private hideMarkerInfo(): void {
    this.closeOtherTooltips();
    for (const marker of this.markers.values()) {
      marker.closePopup();
    }
  }

  private closeOtherTooltips(keep?: L.Tooltip | null): void {
    this.mapLayer?.eachLayer((layer) => {
      const marker = layer as L.CircleMarker;
      const tip = marker.getTooltip?.();
      if (tip && tip !== keep) {
        marker.closeTooltip();
      }
    });
  }

  private markerTooltipOptions(): L.TooltipOptions {
    return {
      direction: 'top',
      offset: [0, -8],
      opacity: 1,
      sticky: false,
      className: 'artisans-map-tooltip'
    };
  }

  private buildPopup(item: ArtisansNearbyItem): string {
    const domain = this.domainLabel(item);
    const detail = this.activityDetail(item);
    const activity = [
      domain,
      detail && detail !== domain ? detail : '',
      item.activityCode
    ].filter((part) => !!(part && String(part).trim()));
    const cityLine = [item.postalCode, item.city].filter(Boolean).join(' ').trim();
    const address = (item.address || '').trim();
    const place = address && cityLine && address.toLowerCase().includes(cityLine.toLowerCase())
      ? [address]
      : [address, cityLine].filter(Boolean);
    const extras = [
      item.distanceKm != null
        ? this.escapeHtml(this.translate.instant(`${this.i18nPrefix}.DISTANCE`, { km: item.distanceKm }))
        : '',
      this.websiteHref(item)
        ? `<a href="${this.escapeHtml(this.websiteHref(item))}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(this.websiteLabel(item))}</a>`
        : '',
      this.sirenePageHref(item)
        ? `<a href="${this.escapeHtml(this.sirenePageHref(item))}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(this.translate.instant('ARTISANS.OPEN_SIRENE'))}</a>`
        : ''
    ].filter(Boolean);
    const closedBadge = this.isItemClosed(item)
      ? ` <span class="artisans-popup-closed">${this.escapeHtml(this.translate.instant('ARTISANS.CLOSED'))}</span>`
      : '';
    const lines = [
      `<strong>${this.escapeHtml(item.name || '')}</strong>${closedBadge}`,
      item.legalName
        ? this.escapeHtml(`${this.translate.instant('ARTISANS.LEGAL_NAME')} ${item.legalName}`)
        : '',
      activity.length ? this.escapeHtml(activity.join(' · ')) : '',
      place.length ? this.escapeHtml(place.join(', ')) : '',
      extras.length ? extras.join(' · ') : ''
    ].filter(Boolean);
    return lines.join('<br>');
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  isItemClosed(item: ArtisansNearbyItem | null | undefined): boolean {
    return isEstablishmentClosed(item);
  }

  private closedMarkerIcon(): L.DivIcon {
    const size = this.isStackedLayout() ? 22 : 16;
    return L.divIcon({
      className: 'artisans-closed-icon',
      html: `<span class="artisans-closed-pin" style="width:${size}px;height:${size}px">`
        + `<span class="artisans-closed-pin-dot"></span>`
        + `<span class="artisans-closed-pin-x">×</span>`
        + `</span>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2]
    });
  }

  private isCircleMarker(marker: ArtisanMarker): marker is L.CircleMarker {
    return marker instanceof L.CircleMarker;
  }
}

function looksLikeCoordinates(value: string): boolean {
  return /^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(value.trim());
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function geodesicCircleRing(lat: number, lon: number, radiusM: number, steps = 96): L.LatLngExpression[] {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const earthM = 6378137;
  const lat1 = lat * toRad;
  const lon1 = lon * toRad;
  const ang = Math.max(radiusM, 1) / earthM;
  const ring: L.LatLngExpression[] = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = (2 * Math.PI * i) / steps;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(bearing)
    );
    const lon2 = lon1 + Math.atan2(
      Math.sin(bearing) * Math.sin(ang) * Math.cos(lat1),
      Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2)
    );
    ring.push([lat2 * toDeg, lon2 * toDeg]);
  }
  return ring;
}
