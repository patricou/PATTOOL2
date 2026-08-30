import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { firstValueFrom, Observable, of, Subscription, throwError } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import * as L from 'leaflet';

import { LeafletBasemapService } from '../shared/leaflet-basemap.service';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import {
  ApiService,
  ArtisansNearbyItem,
  ArtisansNearbyResponse,
  ArtisansSource
} from '../services/api.service';
import {
  activityLabelFromCode,
  normalizeNaf,
  TRADE_NAF_CODES,
  tradeKeyFromCode
} from './artisans-trades';
import { searchOsmOverpass } from './artisans-overpass';
import {
  applyNearbyOfficialSites,
  fetchNearbyOfficialSites,
  normalizeWebsite,
  resolveOfficialWebsite,
  resolveOfficialWebsites
} from './artisans-website';

type MappedArtisan = ArtisansNearbyItem & { lat: number; lon: number };
type ArtisanSortKey =
  | 'distance-asc'
  | 'distance-desc'
  | 'name-asc'
  | 'name-desc'
  | 'trade-asc'
  | 'city-asc';

export const ARTISAN_LIST_PAGE_SIZE = 100;

export const ARTISAN_TRADES = [
  'all',
  'plumber',
  'electrician',
  'heating',
  'painter',
  'carpenter',
  'mason',
  'roofer',
  'locksmith',
  'tiler',
  'glazier',
  'gardener',
  'cleaner',
  'hairdresser',
  'baker',
  'butcher',
  'mechanic',
  'appliance',
  'supermarket',
  'grocery',
  'shop',
  'hardware',
  'clothing',
  'furniture',
  'florist',
  'pharmacy',
  'optician',
  'restaurant',
  'cafe',
  'hotel',
  'fuel'
] as const;

@Component({
  selector: 'app-artisans-nearby',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, TraceViewerModalComponent],
  templateUrl: './artisans-nearby.component.html',
  styleUrls: ['./artisans-nearby.component.css']
})
export class ArtisansNearbyComponent implements OnInit, AfterViewInit, OnDestroy {

  @ViewChild('mapHost') mapHost?: ElementRef<HTMLDivElement>;
  @ViewChild('resultsList') resultsList?: ElementRef<HTMLElement>;
  @ViewChild(TraceViewerModalComponent) traceViewer?: TraceViewerModalComponent;

  readonly listPageSize = ARTISAN_LIST_PAGE_SIZE;
  readonly sortOptions: ArtisanSortKey[] = [
    'distance-asc',
    'distance-desc',
    'name-asc',
    'name-desc',
    'trade-asc',
    'city-asc'
  ];

  source: ArtisansSource = 'sirene';
  i18nPrefix = 'ARTISANS';
  addressQuery = '';
  trade = 'all';
  radiusKm = 10;
  page = 1;

  placeLabel = '';
  searchLat: number | null = null;
  searchLon: number | null = null;
  result: ArtisansNearbyResponse | null = null;
  selectedId: string | null = null;
  listItems: MappedArtisan[] = [];
  viewportItems: MappedArtisan[] = [];
  listQuery = '';
  listTrade = 'all';
  listCity = '';
  sortKey: ArtisanSortKey = 'distance-asc';

  isLoading = false;
  locating = false;
  searched = false;
  errorMessage = '';

  private map?: L.Map;
  private baseLayer: L.TileLayer | L.LayerGroup | null = null;
  private mapLayer?: L.FeatureGroup;
  private markers = new Map<string, L.CircleMarker>();
  private radiusCircle?: L.Circle;
  private mapSyncPaused = false;
  private searchFromMapTimer: ReturnType<typeof setTimeout> | null = null;
  private searchSub?: Subscription;
  private websiteSub?: Subscription;
  private readonly websiteResolving = new Set<string>();
  private readonly websiteJobs = new Map<string, Promise<string>>();
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private blinkingMarker: L.CircleMarker | null = null;
  private readonly markerRestStyle = {
    radius: 7,
    weight: 1,
    color: '#fff',
    fillColor: '#c45c26',
    fillOpacity: 0.92
  };

  constructor(
    private readonly api: ApiService,
    private readonly basemap: LeafletBasemapService,
    private readonly route: ActivatedRoute,
    private readonly translate: TranslateService,
    private readonly cdr: ChangeDetectorRef,
    private readonly ngZone: NgZone,
    private readonly http: HttpClient
  ) {}

  ngOnInit(): void {
    const source = this.route.snapshot.data['source'];
    this.source = source === 'osm' ? 'osm' : 'sirene';
    this.i18nPrefix = this.source === 'osm' ? 'NEARBY_PROS' : 'ARTISANS';
    this.useMyPosition(true);
  }

  ngAfterViewInit(): void {
    setTimeout(() => this.ensureMap(), 0);
  }

  ngOnDestroy(): void {
    if (this.searchFromMapTimer != null) {
      clearTimeout(this.searchFromMapTimer);
    }
    this.searchSub?.unsubscribe();
    this.websiteSub?.unsubscribe();
    this.stopMarkerBlink();
    this.map?.remove();
    this.map = undefined;
  }

  get items(): ArtisansNearbyItem[] {
    return this.result?.items || [];
  }

  get mappedItems(): MappedArtisan[] {
    return this.items
      .filter((item): item is MappedArtisan => this.hasMapPoint(item))
      .filter((item) => this.matchesSelectedTrade(item));
  }

  get total(): number {
    return this.result?.total || 0;
  }

  get totalPages(): number {
    const per = this.result?.perPage || ARTISAN_LIST_PAGE_SIZE;
    return Math.max(1, Math.ceil(this.total / per));
  }

  get trades(): string[] {
    const rest = ARTISAN_TRADES.filter((trade) => trade !== 'all')
      .slice()
      .sort((a, b) => this.compareTradeLabels(a, b));
    return ['all', ...rest];
  }

  tradeLabelKey(trade: string): string {
    return `ARTISANS.TRADE_${trade.toUpperCase()}`;
  }

  sortLabelKey(key: ArtisanSortKey): string {
    return `ARTISANS.SORT_${key.replace(/-/g, '_').toUpperCase()}`;
  }

  get listFilterActive(): boolean {
    return !!this.listQuery.trim() || this.listTrade !== 'all' || !!this.listCity;
  }

  get resultTrades(): string[] {
    const keys = new Set<string>();
    for (const item of this.viewportItems) {
      const key = this.resolvedTradeKey(item);
      if (key && key !== 'all') {
        keys.add(key);
      }
    }
    return [...keys].sort((a, b) => this.compareTradeLabels(a, b));
  }

  get resultCities(): string[] {
    const cities = new Set<string>();
    for (const item of this.viewportItems) {
      const city = (item.city || '').trim();
      if (city) {
        cities.add(city);
      }
    }
    return [...cities].sort((a, b) => a.localeCompare(b, this.uiLocale, { sensitivity: 'base' }));
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
    this.applyListView();
  }

  websiteHref(item: ArtisansNearbyItem): string {
    return normalizeWebsite(item.website);
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
    const query = [item.name, item.city, item.postalCode, 'site officiel']
      .filter((part) => !!(part && String(part).trim()))
      .join(' ')
      .trim();
    if (!query) {
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

  private enrichWebsites(items: ArtisansNearbyItem[]): void {
    this.websiteSub?.unsubscribe();
    this.websiteResolving.clear();
    this.websiteJobs.clear();
    const missing = items.filter((item) => !this.websiteHref(item));
    if (!missing.length) {
      return;
    }
    for (const item of missing) {
      const id = item.id || item.name || '';
      if (id) {
        this.websiteResolving.add(id);
      }
    }
    this.cdr.markForCheck();
    const lat = this.searchLat;
    const lon = this.searchLon;
    const nearby$ = lat != null && lon != null
      ? fetchNearbyOfficialSites(this.http, lat, lon, this.radiusKm)
      : of([]);
    this.websiteSub = nearby$.pipe(
      catchError(() => of([])),
      switchMap((nearby) => {
        applyNearbyOfficialSites(missing, nearby);
        const still = missing.filter((item) => !this.websiteHref(item));
        for (const item of missing) {
          if (this.websiteHref(item)) {
            const id = item.id || item.name || '';
            if (id) {
              this.websiteResolving.delete(id);
            }
          }
        }
        this.cdr.markForCheck();
        return still.length ? resolveOfficialWebsites(this.http, still) : of(still);
      })
    ).subscribe({
      next: () => {
        this.websiteResolving.clear();
        this.refreshResolvedSiteUi();
      },
      error: () => {
        this.websiteResolving.clear();
        this.cdr.markForCheck();
      }
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
    for (const item of this.mappedItems) {
      const marker = item.id ? this.markers.get(item.id) : undefined;
      if (marker && this.websiteHref(item)) {
        marker.setPopupContent(this.buildPopup(item));
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

  useMyPosition(autoSearch = false): void {
    if (!navigator.geolocation) {
      this.errorMessage = `${this.i18nPrefix}.GEO_UNSUPPORTED`;
      return;
    }
    this.locating = true;
    this.errorMessage = '';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.ngZone.run(() => {
          this.locating = false;
          this.searchLat = pos.coords.latitude;
          this.searchLon = pos.coords.longitude;
          this.placeLabel = '';
          this.addressQuery = '';
          this.cdr.markForCheck();
          if (autoSearch || this.searched) {
            this.search(1);
          }
        });
      },
      () => {
        this.ngZone.run(() => {
          this.locating = false;
          this.errorMessage = `${this.i18nPrefix}.GEO_DENIED`;
          this.cdr.markForCheck();
        });
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 }
    );
  }

  private withOsmFallback(
    res: ArtisansNearbyResponse,
    lat?: number,
    lon?: number
  ): Observable<ArtisansNearbyResponse> {
    if (this.source !== 'osm' || (res.items && res.items.length)) {
      return of(res);
    }
    const useLat = lat ?? res.lat ?? this.searchLat;
    const useLon = lon ?? res.lon ?? this.searchLon;
    if (useLat == null || useLon == null) {
      return of(res);
    }
    return searchOsmOverpass(this.http, useLat, useLon, this.radiusKm, this.trade, this.page, ARTISAN_LIST_PAGE_SIZE).pipe(
      catchError(() => of(res))
    );
  }

  onTradeChange(): void {
    if (this.searched) {
      this.search(1);
    }
  }

  onRadiusSliderChange(): void {
    this.applyRadiusToMap();
    if (this.searched) {
      this.search(1, true);
    }
  }

  search(page = 1, fitMap = true): void {
    const hasPoint = this.searchLat != null && this.searchLon != null;
    const q = this.addressQuery.trim();
    if (!hasPoint && !q) {
      this.errorMessage = `${this.i18nPrefix}.NEED_PLACE`;
      return;
    }
    this.page = page;
    this.isLoading = true;
    this.searched = true;
    this.errorMessage = '';
    this.listItems = [];
    this.viewportItems = [];
    this.listQuery = '';
    this.listTrade = 'all';
    this.listCity = '';
    this.searchSub?.unsubscribe();
    this.websiteSub?.unsubscribe();
    this.websiteResolving.clear();
    this.websiteJobs.clear();
    const lat = hasPoint && !q ? this.searchLat! : undefined;
    const lon = hasPoint && !q ? this.searchLon! : undefined;
    this.searchSub = this.api.searchArtisansNearby({
      source: this.source,
      lat,
      lon,
      q: q || undefined,
      radiusKm: this.radiusKm,
      trade: this.trade,
      page: this.page,
      perPage: ARTISAN_LIST_PAGE_SIZE
    }).pipe(
      catchError((err) => this.source === 'osm' ? of({ items: [], total: 0 } as ArtisansNearbyResponse) : throwError(() => err)),
      switchMap((res) => this.withOsmFallback(res, lat, lon))
    ).subscribe({
      next: (res) => {
        this.result = res;
        this.isLoading = false;
        if (res.lat != null && res.lon != null) {
          this.searchLat = res.lat;
          this.searchLon = res.lon;
        }
        if (res.placeLabel) {
          this.placeLabel = res.placeLabel;
        }
        this.selectedId = this.mappedItems[0]?.id || null;
        this.cdr.markForCheck();
        this.enrichWebsites(this.items);
        setTimeout(() => {
          this.ensureMap();
          this.refreshMapMarkers(fitMap);
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
  }

  onListLeave(): void {
    this.stopMarkerBlink();
  }

  selectItem(item: ArtisansNearbyItem): void {
    this.highlightListItem(item.id);
    const marker = item.id ? this.markers.get(item.id) : undefined;
    if (marker && this.map && item.lat != null && item.lon != null) {
      this.mapSyncPaused = true;
      this.map.setView([item.lat, item.lon], Math.max(this.map.getZoom(), 14));
      marker.openPopup();
      setTimeout(() => {
        this.mapSyncPaused = false;
        this.syncListToMap();
      }, 250);
    }
  }

  private highlightListItem(id: string | undefined): void {
    if (!id) {
      return;
    }
    this.selectedId = id;
    this.cdr.markForCheck();
    setTimeout(() => this.scrollHitToTop(id), 0);
  }

  private scrollHitToTop(id: string): void {
    const list = this.resultsList?.nativeElement;
    if (!list) {
      return;
    }
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
    const hit = list.querySelector(`[data-artisan-id="${escaped}"]`) as HTMLElement | null;
    if (!hit) {
      return;
    }
    const top = hit.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTo({ top, behavior: 'smooth' });
  }

  previousPage(): void {
    if (this.page > 1) {
      this.search(this.page - 1);
    }
  }

  nextPage(): void {
    if (this.page < this.totalPages) {
      this.search(this.page + 1);
    }
  }

  private ensureMap(): void {
    const el = this.mapHost?.nativeElement;
    if (!el || this.map) {
      this.map?.invalidateSize();
      return;
    }
    this.map = L.map(el, { zoomControl: true, attributionControl: true });
    this.baseLayer = this.basemap.applyBaseLayer(this.map, 'osm-standard', null);
    this.mapLayer = L.featureGroup().addTo(this.map);
    this.map.setView([46.6, 2.5], 6);
    this.map.on('moveend zoomend', () => {
      this.ngZone.run(() => this.onMapViewChanged());
    });
    setTimeout(() => this.map?.invalidateSize(), 0);
  }

  private hasMapPoint(item: ArtisansNearbyItem): boolean {
    return item.lat != null && item.lon != null
      && Number.isFinite(item.lat) && Number.isFinite(item.lon);
  }

  private syncListToMap(): void {
    const mapped = this.mappedItems;
    const bounds = this.map?.getBounds();
    this.viewportItems = bounds
      ? mapped.filter((item) => bounds.contains([item.lat, item.lon]))
      : mapped;
    if (this.listCity && !this.resultCities.includes(this.listCity)) {
      this.listCity = '';
    }
    if (this.listTrade !== 'all' && !this.resultTrades.includes(this.listTrade)) {
      this.listTrade = 'all';
    }
    this.applyListView();
  }

  private applyListView(): void {
    const query = this.listQuery.trim().toLowerCase();
    let items = this.viewportItems.filter((item) => {
      if (this.listTrade !== 'all' && this.resolvedTradeKey(item) !== this.listTrade) {
        return false;
      }
      if (this.listCity && (item.city || '').trim() !== this.listCity) {
        return false;
      }
      if (!query) {
        return true;
      }
      const hay = [
        item.name,
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
    items = items.slice().sort((a, b) => this.compareItems(a, b));
    this.listItems = items;
    if (this.selectedId && !items.some((item) => item.id === this.selectedId)) {
      this.selectedId = items[0]?.id || null;
    }
    this.cdr.markForCheck();
  }

  private compareItems(a: MappedArtisan, b: MappedArtisan): number {
    const name = (item: MappedArtisan) => (item.name || '').trim();
    const city = (item: MappedArtisan) => (item.city || '').trim();
    const dist = (item: MappedArtisan) => item.distanceKm ?? Number.POSITIVE_INFINITY;
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
    if (this.mapSyncPaused || !this.searched || !this.map || this.isLoading) {
      return;
    }
    const next = this.radiusKmFromMap();
    if (Math.abs(next - this.radiusKm) < 2) {
      return;
    }
    this.radiusKm = next;
    this.updateRadiusCircle();
    this.cdr.markForCheck();
    if (this.searchFromMapTimer != null) {
      clearTimeout(this.searchFromMapTimer);
    }
    this.searchFromMapTimer = setTimeout(() => this.search(1, false), 500);
  }

  private radiusKmFromMap(): number {
    if (!this.map) {
      return this.radiusKm;
    }
    const bounds = this.map.getBounds();
    const center = this.searchLat != null && this.searchLon != null
      ? L.latLng(this.searchLat, this.searchLon)
      : this.map.getCenter();
    const farthestM = Math.max(
      this.map.distance(center, bounds.getNorthEast()),
      this.map.distance(center, bounds.getNorthWest()),
      this.map.distance(center, bounds.getSouthEast()),
      this.map.distance(center, bounds.getSouthWest())
    );
    return Math.max(1, Math.min(50, Math.round(farthestM / 1000)));
  }

  private applyRadiusToMap(): void {
    if (!this.map || this.searchLat == null || this.searchLon == null) {
      return;
    }
    this.mapSyncPaused = true;
    const center = L.latLng(this.searchLat, this.searchLon);
    this.map.fitBounds(center.toBounds(this.radiusKm * 2000), {
      padding: [16, 16],
      maxZoom: 15
    });
    this.updateRadiusCircle();
    setTimeout(() => {
      this.mapSyncPaused = false;
      this.syncListToMap();
    }, 500);
  }

  private updateRadiusCircle(): void {
    if (!this.map || this.searchLat == null || this.searchLon == null) {
      return;
    }
    const meters = this.radiusKm * 1000;
    if (this.radiusCircle) {
      this.radiusCircle.setLatLng([this.searchLat, this.searchLon]);
      this.radiusCircle.setRadius(meters);
      return;
    }
    this.radiusCircle = L.circle([this.searchLat, this.searchLon], {
      radius: meters,
      color: '#c45c26',
      weight: 1,
      fillColor: '#c45c26',
      fillOpacity: 0.06,
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
    let on = false;
    const pulse = () => {
      on = !on;
      marker.setStyle({
        radius: on ? 12 : 8,
        weight: on ? 3 : 2,
        color: '#fff',
        fillColor: '#dc3545',
        fillOpacity: on ? 1 : 0.28
      });
      marker.bringToFront();
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
      this.blinkingMarker.setStyle(this.markerRestStyle);
      this.blinkingMarker = null;
    }
  }

  private refreshMapMarkers(fitMap = false): void {
    this.ensureMap();
    if (!this.map || !this.mapLayer) {
      return;
    }
    this.stopMarkerBlink();
    this.mapLayer.clearLayers();
    this.markers.clear();
    const mapped = this.mappedItems;
    if (this.searchLat != null && this.searchLon != null) {
      const center = L.circleMarker([this.searchLat, this.searchLon], {
        radius: 8,
        color: '#fff',
        weight: 2,
        fillColor: '#0d6efd',
        fillOpacity: 1
      });
      center.bindPopup(this.escapeHtml(this.placeLabel || this.translate.instant(`${this.i18nPrefix}.YOU`)));
      center.addTo(this.mapLayer);
    }
    for (const item of mapped) {
      const marker = L.circleMarker([item.lat, item.lon], { ...this.markerRestStyle });
      marker.bindPopup(this.buildPopup(item));
      marker.on('mouseover', () => {
        if (this.blinkingMarker === marker) {
          return;
        }
        marker.setStyle({ radius: 10, weight: 2 });
        marker.bringToFront();
        this.ngZone.run(() => this.highlightListItem(item.id));
      });
      marker.on('mouseout', () => {
        if (this.blinkingMarker === marker) {
          return;
        }
        marker.setStyle(this.markerRestStyle);
      });
      marker.on('click', () => this.ngZone.run(() => {
        this.highlightListItem(item.id);
        marker.openPopup();
      }));
      marker.addTo(this.mapLayer);
      if (item.id) {
        this.markers.set(item.id, marker);
      }
    }
    this.updateRadiusCircle();
    if (fitMap && this.searchLat != null && this.searchLon != null) {
      this.applyRadiusToMap();
    } else {
      this.syncListToMap();
    }
    setTimeout(() => {
      this.map?.invalidateSize();
      this.syncListToMap();
    }, 0);
  }

  private buildPopup(item: ArtisansNearbyItem): string {
    const domain = this.domainLabel(item);
    const detail = this.activityDetail(item);
    const lines = [
      `<strong>${this.escapeHtml(item.name || '')}</strong>`,
      domain ? `<span>${this.escapeHtml(domain)}</span>` : '',
      detail ? this.escapeHtml(detail) : '',
      item.activityCode ? this.escapeHtml(item.activityCode) : '',
      item.address ? this.escapeHtml(item.address) : '',
      [item.postalCode, item.city].filter(Boolean).join(' '),
      item.distanceKm != null
        ? this.escapeHtml(this.translate.instant(`${this.i18nPrefix}.DISTANCE`, { km: item.distanceKm }))
        : '',
      this.websiteHref(item)
        ? `<a href="${this.escapeHtml(this.websiteHref(item))}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(this.websiteLabel(item))}</a>`
        : ''
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
}
