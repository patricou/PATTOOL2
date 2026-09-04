import { Component, HostBinding, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { of, Subject, Subscription } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, map, switchMap } from 'rxjs/operators';

import {
  ApiService,
  FoncierCacheSource,
  FoncierCommune,
  FoncierListing,
  FoncierMutation
} from '../services/api.service';
import { PositionService } from '../services/position.service';
import {
  FONCIER_SORT_OPTIONS,
  FoncierCacheRow,
  FoncierSortKey,
  filterCacheItems,
  parseFoncierSort,
  placesFromCache,
  sortCacheItems,
  sortLabelKey
} from './foncier-cache-query';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import { SheetSelectComponent, SheetSelectOption } from '../shared/sheet-select/sheet-select.component';
import { openWhatsAppTextShare } from '../shared/share-whatsapp-image.util';

export type FoncierProvider = 'cerema' | 'stream-estate' | 'chercher-trouver';

@Component({
  selector: 'app-foncier',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, TraceViewerModalComponent, SheetSelectComponent],
  templateUrl: './foncier.component.html',
  styleUrls: ['./foncier-shared.css']
})
export class FoncierComponent implements OnInit, OnDestroy {

  readonly providers: Array<{ id: FoncierProvider; labelKey: string; icon: string }> = [
    { id: 'cerema', labelKey: 'FONCIER.TAB_CEREMA', icon: 'fa fa-database' },
    { id: 'stream-estate', labelKey: 'FONCIER.TAB_STREAM_ESTATE', icon: 'fa fa-building' },
    { id: 'chercher-trouver', labelKey: 'FONCIER.TAB_CHERCHER_TROUVER', icon: 'fa fa-search' }
  ];
  readonly radiusOptions = [0, 2, 5, 10, 20, 30];
  readonly sourceOptions: FoncierCacheSource[] = ['cache', 'both', 'api'];
  readonly sortOptions = FONCIER_SORT_OPTIONS;
  readonly typeOptionsCerema: SheetSelectOption[] = [
    { value: '', labelKey: 'FONCIER.TYPE_ALL', icon: 'fa fa-th' },
    { value: 'maison', labelKey: 'FONCIER.TYPE_HOUSE', icon: 'fa fa-home' },
    { value: 'appartement', labelKey: 'FONCIER.TYPE_FLAT', icon: 'fa fa-building' }
  ];
  readonly typeOptionsListings: SheetSelectOption[] = [
    ...this.typeOptionsCerema,
    { value: 'terrain', labelKey: 'FONCIER.TYPE_LAND', icon: 'fa fa-map' }
  ];
  readonly radiusSelectOptions: SheetSelectOption[] = this.radiusOptions.map((km) =>
    km === 0
      ? { value: 0, labelKey: 'FONCIER.RADIUS_COMMUNE', icon: 'fa fa-map-pin' }
      : { value: km, labelKey: 'FONCIER.RADIUS_KM', labelParams: { km }, icon: 'fa fa-dot-circle-o' }
  );
  readonly sortSelectOptions: SheetSelectOption[] = this.sortOptions.map((key) => ({
    value: key,
    labelKey: sortLabelKey(key),
    icon: key.includes('asc') ? 'fa fa-sort-amount-asc' : 'fa fa-sort-amount-desc'
  }));

  provider: FoncierProvider = 'cerema';
  query = '';
  type = '';
  radiusKm = 0;
  cacheMode: FoncierCacheSource = 'cache';
  sortKey: FoncierSortKey = 'date-desc';
  cacheCount = 0;
  clearingCache = false;
  priceMin = '';
  priceMax = '';
  surfaceMin = '';
  surfaceMax = '';
  communes: FoncierCommune[] = [];
  selected: FoncierCommune | null = null;
  communeActiveIndex = -1;
  listings: FoncierListing[] = [];
  mutations: FoncierMutation[] = [];
  private rawListings: FoncierListing[] = [];
  private rawMutations: FoncierMutation[] = [];
  private fullListings: FoncierListing[] = [];
  private fullMutations: FoncierMutation[] = [];
  count = 0;
  page = 1;
  hasNext = false;
  seConfigured = true;
  ctConfigured = true;

  searchingCommunes = false;
  loading = false;
  searched = false;
  locating = false;
  errorMessage = '';
  geocodingKey = '';
  private cacheItems: FoncierCacheRow[] = [];
  private localCacheReady = false;
  private cacheLoadPending = true;
  private readonly brokenPhotos = new Set<string>();
  private readonly proxiedPhotos = new Set<string>();

  @HostBinding('class.foncier-cerema')
  get isCerema(): boolean {
    return this.provider === 'cerema';
  }

  @HostBinding('class.foncier-stream-estate')
  get isStreamEstate(): boolean {
    return this.provider === 'stream-estate';
  }

  @HostBinding('class.foncier-chercher-trouver')
  get isChercherTrouver(): boolean {
    return this.provider === 'chercher-trouver';
  }

  get isListings(): boolean {
    return !this.isCerema;
  }

  get configured(): boolean {
    if (this.isCerema) {
      return true;
    }
    return this.provider === 'chercher-trouver' ? this.ctConfigured : this.seConfigured;
  }

  get typeOptions(): SheetSelectOption[] {
    return this.isCerema ? this.typeOptionsCerema : this.typeOptionsListings;
  }

  get providerBadge(): 'DVF' | 'SE' | 'CT' {
    if (this.provider === 'stream-estate') {
      return 'SE';
    }
    if (this.provider === 'chercher-trouver') {
      return 'CT';
    }
    return 'DVF';
  }

  get providerLabelKey(): string {
    return this.providers.find((tab) => tab.id === this.provider)?.labelKey || 'FONCIER.TAB_CEREMA';
  }

  itemNumber(index: number): number {
    return (this.page - 1) * this.pageSize + index + 1;
  }

  get titleIcon(): string {
    return this.providers.find((tab) => tab.id === this.provider)?.icon || 'fa fa-home';
  }

  get emptyKey(): string {
    if (this.provider === 'chercher-trouver') {
      return 'FONCIER.CT_EMPTY';
    }
    if (this.provider === 'stream-estate') {
      return 'FONCIER.SE_EMPTY';
    }
    return 'FONCIER.CEREMA_EMPTY';
  }

  get keyHelpKey(): string {
    return this.provider === 'chercher-trouver' ? 'FONCIER.CT_KEY_HELP' : 'FONCIER.SE_KEY_HELP';
  }

  get signupUrl(): string {
    return this.provider === 'chercher-trouver'
      ? 'https://cherchertrouver.immo/api'
      : 'https://stream.estate/fr/api-immobilier';
  }

  get hasResults(): boolean {
    return this.isCerema ? this.mutations.length > 0 : this.listings.length > 0;
  }

  get pageSize(): number {
    return this.isCerema ? 40 : 20;
  }

  get pageCount(): number {
    return Math.max(1, Math.ceil((this.count || 0) / this.pageSize));
  }

  get showPager(): boolean {
    return this.hasResults && (this.page > 1 || this.hasNext || this.pageCount > 1);
  }

  get canGoNext(): boolean {
    return !this.loading && (this.hasNext || this.page < this.pageCount);
  }

  @ViewChild(TraceViewerModalComponent) traceViewer?: TraceViewerModalComponent;

  private static readonly DEFAULT_MAP_LAT = 46.2;
  private static readonly DEFAULT_MAP_LNG = 2.2;

  private readonly query$ = new Subject<string>();
  private communeSub?: Subscription;
  private resultSub?: Subscription;
  private positionSub?: Subscription;
  private readonly subs: Subscription[] = [];

  constructor(
    private api: ApiService,
    private position: PositionService,
    private ngZone: NgZone,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  ngOnInit(): void {
    const params = this.route.snapshot.queryParamMap;
    const dataProvider = this.route.snapshot.data['provider'] as string | undefined;
    this.provider = this.parseProvider(params.get('provider') || dataProvider);
    this.query = (params.get('q') || '').trim();
    this.type = params.get('type') || '';
    this.priceMin = params.get('priceMin') || '';
    this.priceMax = params.get('priceMax') || '';
    this.surfaceMin = params.get('surfaceMin') || '';
    this.surfaceMax = params.get('surfaceMax') || '';
    this.radiusKm = this.parseRadius(params.get('radius'));
    this.cacheMode = this.parseSource(params.get('source'));
    this.sortKey = parseFoncierSort(params.get('sort'));
    const insee = params.get('insee') || '';
    if (this.isCerema && this.type === 'terrain') {
      this.type = '';
    }

    this.subs.push(
      this.query$.pipe(debounceTime(300), distinctUntilChanged()).subscribe((value) => {
        const q = value.trim();
        if (q.length >= 2 && !this.selected) {
          this.lookupCommunes(q);
        } else if (!this.selected) {
          this.communes = [];
          this.communeActiveIndex = -1;
        }
      })
    );

    if (insee.match(/^\d{5}$/)) {
      this.selected = { code: insee, nom: this.query || insee };
    } else if (this.query.length >= 2) {
      this.lookupCommunes(this.query);
    }

    this.refreshCacheCount();
    if (this.isCerema && this.selected && this.cacheMode !== 'cache') {
      this.runSearch(1);
    }
    this.subs.push(
      this.api.getStreamEstateStatus().subscribe({
        next: (res) => {
          this.seConfigured = !!res?.configured;
          if (this.provider === 'stream-estate' && res?.cacheCount != null) {
            this.cacheCount = res.cacheCount;
          }
          if (this.provider === 'stream-estate' && this.selected && this.canSearch()) {
            this.runSearch(1);
          }
        },
        error: () => {
          this.seConfigured = false;
        }
      })
    );
    this.subs.push(
      this.api.getChercherTrouverStatus().subscribe({
        next: (res) => {
          this.ctConfigured = !!res?.configured;
          if (this.provider === 'chercher-trouver' && res?.cacheCount != null) {
            this.cacheCount = res.cacheCount;
          }
          if (this.provider === 'chercher-trouver' && this.selected && this.canSearch()) {
            this.runSearch(1);
          }
        },
        error: () => {
          this.ctConfigured = false;
        }
      })
    );
  }

  ngOnDestroy(): void {
    this.communeSub?.unsubscribe();
    this.resultSub?.unsubscribe();
    this.positionSub?.unsubscribe();
    this.subs.forEach((s) => s.unsubscribe());
  }

  setProvider(next: FoncierProvider): void {
    if (this.provider === next) {
      return;
    }
    this.resultSub?.unsubscribe();
    this.provider = next;
    if (this.isCerema && this.type === 'terrain') {
      this.type = '';
    }
    this.listings = [];
    this.mutations = [];
    this.rawListings = [];
    this.rawMutations = [];
    this.fullListings = [];
    this.fullMutations = [];
    this.count = 0;
    this.hasNext = false;
    this.page = 1;
    this.searched = false;
    this.loading = false;
    this.errorMessage = '';
    this.cacheItems = [];
    this.localCacheReady = false;
    this.cacheLoadPending = true;
    this.cacheCount = 0;
    this.syncUrlIfChanged();
    this.refreshCacheCount();
    if (this.selected && this.canSearch()) {
      this.runSearch(1);
    }
  }

  onQueryChanged(): void {
    this.selected = null;
    this.errorMessage = '';
    this.query$.next(this.query);
    this.syncUrlIfChanged();
    this.listings = [];
    this.mutations = [];
    this.fullListings = [];
    this.fullMutations = [];
    this.searched = false;
    const q = this.query.trim();
    if (q.length < 2) {
      this.communes = [];
      this.communeActiveIndex = -1;
    }
  }

  onCommuneKeydown(event: KeyboardEvent): void {
    const hits = this.communes;
    if (!hits.length && event.key !== 'Escape') {
      return;
    }
    const active = this.communeActiveIndex;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.communeActiveIndex = active < hits.length - 1 ? active + 1 : 0;
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.communeActiveIndex = active > 0 ? active - 1 : hits.length - 1;
        break;
      case 'Enter':
        if (active >= 0 && active < hits.length) {
          event.preventDefault();
          this.pickCommune(hits[active]);
        }
        break;
      case 'Escape':
        event.preventDefault();
        this.communes = [];
        this.communeActiveIndex = -1;
        break;
      case 'Home':
        if (hits.length) {
          event.preventDefault();
          this.communeActiveIndex = 0;
        }
        break;
      case 'End':
        if (hits.length) {
          event.preventDefault();
          this.communeActiveIndex = hits.length - 1;
        }
        break;
      default:
        break;
    }
  }

  submitSearch(): void {
    const q = this.query.trim();
    if (!q) {
      return;
    }
    if (this.communes.length && !this.selected) {
      this.pickCommune(this.communes[this.communeActiveIndex] ?? this.communes[0]);
      return;
    }
    if (this.selected) {
      this.runSearch(1);
      return;
    }
    this.lookupCommunes(q, true);
  }

  pickCommune(commune: FoncierCommune): void {
    this.selected = commune;
    this.query = commune.nom;
    this.communes = [];
    this.communeActiveIndex = -1;
    this.runSearch(1);
  }

  useMyPosition(): void {
    if (this.locating) {
      return;
    }
    this.locating = true;
    this.errorMessage = '';
    this.positionSub?.unsubscribe();
    this.positionSub = this.position.getCurrentPosition().pipe(
      switchMap((gps) => {
        if (!gps) {
          return of(null);
        }
        return this.api.geocodeReverse(gps.latitude, gps.longitude).pipe(
          catchError(() => of(null)),
          map((geo) => ({ gps, geo }))
        );
      })
    ).subscribe({
      next: (hit) => {
        this.ngZone.run(() => {
          this.locating = false;
          if (!hit?.gps) {
            this.errorMessage = 'FONCIER.GEO_DENIED';
            return;
          }
          this.applyMyPosition(hit.gps.latitude, hit.gps.longitude, hit.geo);
        });
      },
      error: () => {
        this.ngZone.run(() => {
          this.locating = false;
          this.errorMessage = 'FONCIER.GEO_DENIED';
        });
      }
    });
  }

  openTraceViewerForSelection(): void {
    if (!this.traceViewer) {
      return;
    }
    const lat = Number.isFinite(this.selected?.lat)
      ? this.selected!.lat as number
      : FoncierComponent.DEFAULT_MAP_LAT;
    const lon = Number.isFinite(this.selected?.lon)
      ? this.selected!.lon as number
      : FoncierComponent.DEFAULT_MAP_LNG;
    const label = (this.selected?.nom || this.query || '').trim()
      || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    this.traceViewer.openAtLocation(lat, lon, label, undefined, true, true);
  }

  onLocationSelected(location: { lat: number; lng: number }): void {
    if (!Number.isFinite(location?.lat) || !Number.isFinite(location?.lng)) {
      return;
    }
    this.applyPickedMapLocation(location.lat, location.lng);
  }

  clearSearch(): void {
    this.communeSub?.unsubscribe();
    this.resultSub?.unsubscribe();
    this.positionSub?.unsubscribe();
    this.query = '';
    this.type = '';
    this.priceMin = '';
    this.priceMax = '';
    this.surfaceMin = '';
    this.surfaceMax = '';
    this.radiusKm = 0;
    this.sortKey = 'date-desc';
    this.cacheMode = 'cache';
    this.communes = [];
    this.communeActiveIndex = -1;
    this.selected = null;
    this.listings = [];
    this.mutations = [];
    this.rawListings = [];
    this.rawMutations = [];
    this.fullListings = [];
    this.fullMutations = [];
    this.count = 0;
    this.hasNext = false;
    this.page = 1;
    this.searched = false;
    this.errorMessage = '';
    this.syncUrlIfChanged();
  }

  onTypeChanged(): void {
    if (this.selected) {
      this.runSearch(1);
    }
  }

  onRadiusChanged(): void {
    if (this.selected) {
      this.runSearch(1);
    }
  }

  onSortChanged(): void {
    if (this.isCerema) {
      this.fullMutations = sortCacheItems(this.fullMutations, this.sortKey);
    } else {
      this.fullListings = sortCacheItems(this.fullListings, this.sortKey);
    }
    this.page = 1;
    this.applyPageSlice();
    this.syncUrlIfChanged();
  }

  sortLabelKey(sort: FoncierSortKey): string {
    return sortLabelKey(sort);
  }

  onSourceChanged(): void {
    this.syncUrlIfChanged();
    if (this.selected) {
      this.runSearch(1);
    } else if (this.query.trim().length >= 2) {
      this.lookupCommunes(this.query);
    }
  }

  clearCache(): void {
    if (this.clearingCache) {
      return;
    }
    this.clearingCache = true;
    this.api.clearFoncierCache(this.provider).subscribe({
      next: (res) => {
        this.clearingCache = false;
        this.cacheItems = [];
        this.localCacheReady = true;
        this.cacheCount = res?.count ?? 0;
        if (this.searched && this.canSearch()) {
          this.runSearch(this.page);
        }
      },
      error: () => {
        this.clearingCache = false;
        this.errorMessage = 'FONCIER.ERROR';
      }
    });
  }

  loadPage(delta: number): void {
    const next = this.page + delta;
    if (next < 1 || next > this.pageCount) {
      return;
    }
    this.page = next;
    this.applyPageSlice();
    this.syncUrlIfChanged();
  }

  shareListingOnWhatsApp(listing: FoncierListing, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const text = this.listingShareText(listing);
    if (!text) {
      return;
    }
    openWhatsAppTextShare(text);
  }

  private listingShareText(listing: FoncierListing): string {
    const title = (listing.title || '').trim();
    const facts = [
      listing.type,
      listing.price != null ? this.formatPrice(listing.price) : '',
      listing.surface != null ? this.formatNumber(listing.surface, ' m²') : '',
      listing.rooms != null ? this.formatNumber(listing.rooms) + ' p.' : ''
    ].filter(Boolean);
    const place = (listing.address || '').trim()
      || [listing.zipcode, listing.city].filter(Boolean).join(' ').trim();
    const url = (listing.url || '').trim();
    const lines = [title, facts.join(' · '), place]
      .map((line) => line.trim())
      .filter(Boolean);
    if (url) {
      lines.push('', url);
    }
    return lines.join('\n');
  }

  formatPrice(value: number | null | undefined): string {
    if (value == null || Number.isNaN(value)) {
      return '—';
    }
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: 'EUR',
      maximumFractionDigits: 0
    }).format(value);
  }

  formatNumber(value: number | null | undefined, suffix = ''): string {
    if (value == null || Number.isNaN(value)) {
      return '—';
    }
    return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(value) + suffix;
  }

  formatPublished(value: string | undefined): string {
    if (!value) {
      return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(date);
  }

  sellerLabel(listing: FoncierListing): string {
    if (listing.sellerType === 'private') {
      return listing.seller || '';
    }
    const parts = [listing.seller, listing.sellerNetwork].filter(Boolean);
    return parts.join(' · ');
  }

  photoSrc(listing: FoncierListing): string | null {
    const raw = (listing.photo || '').trim();
    if (!raw) {
      return null;
    }
    if (this.proxiedPhotos.has(this.photoKey(listing))) {
      return this.api.foncierPhotoUrl(raw);
    }
    return raw;
  }

  isPhotoBroken(listing: FoncierListing): boolean {
    return this.brokenPhotos.has(this.photoKey(listing));
  }

  onPhotoError(listing: FoncierListing): void {
    const key = this.photoKey(listing);
    if (!this.proxiedPhotos.has(key)) {
      this.proxiedPhotos.add(key);
      return;
    }
    this.brokenPhotos.add(key);
  }

  private photoKey(listing: FoncierListing): string {
    return listing.id || listing.photo || listing.url || listing.title || '';
  }

  canOpenMap(row: { lat?: number; lon?: number; address?: string; city?: string; zipcode?: string }): boolean {
    return this.hasCoords(row) || !!(row.address || row.city || row.zipcode || this.selected);
  }

  openMutationMap(row: FoncierMutation): void {
    this.openInTraceViewer(row, row.address || this.selected?.nom || '', [row.address, this.selected?.nom], this.selected?.codesPostaux?.[0]);
  }

  openListingMap(listing: FoncierListing): void {
    const label = [listing.title, listing.address, listing.city, listing.zipcode].filter(Boolean).join(' · ');
    const queryParts = [listing.address, listing.city, listing.zipcode, this.selected?.nom];
    this.openInTraceViewer(listing, label, queryParts, listing.zipcode || this.selected?.codesPostaux?.[0]);
  }

  parseRadius(value: string | null): number {
    const n = parseInt(value || '', 10);
    return this.radiusOptions.includes(n) ? n : 0;
  }

  parseSource(value: string | null): FoncierCacheSource {
    return this.sourceOptions.includes(value as FoncierCacheSource)
      ? (value as FoncierCacheSource)
      : 'cache';
  }

  sourceLabelKey(mode: FoncierCacheSource): string {
    if (mode === 'cache') {
      return 'FONCIER.SOURCE_CACHE';
    }
    if (mode === 'api') {
      return 'FONCIER.SOURCE_API';
    }
    return 'FONCIER.SOURCE_BOTH';
  }

  sourceIcon(mode: FoncierCacheSource): string {
    if (mode === 'cache') {
      return 'fa-database';
    }
    if (mode === 'api') {
      return 'fa-cloud';
    }
    return 'fa-random';
  }

  setCacheMode(mode: FoncierCacheSource): void {
    if (this.cacheMode === mode) {
      return;
    }
    this.cacheMode = mode;
    this.onSourceChanged();
  }

  dpeClass(dpe?: string): string {
    const letter = (dpe || '').trim().toUpperCase().charAt(0);
    return letter >= 'A' && letter <= 'G' ? 'foncier-dpe--' + letter.toLowerCase() : '';
  }

  communeMeta(commune: FoncierCommune): string {
    const zip = commune.codesPostaux?.[0] || '';
    const dept = commune.departement || '';
    return [zip, dept, commune.code ? `INSEE ${commune.code}` : ''].filter(Boolean).join(' · ');
  }

  private parseProvider(raw: string | null | undefined): FoncierProvider {
    if (raw === 'stream-estate' || raw === 'chercher-trouver' || raw === 'cerema') {
      return raw;
    }
    return 'cerema';
  }

  private hasCoords(item?: { lat?: number; lon?: number } | null): boolean {
    return Number.isFinite(item?.lat) && Number.isFinite(item?.lon);
  }

  private openInTraceViewer(
    item: { id?: string; lat?: number; lon?: number },
    label: string,
    queryParts: Array<string | undefined>,
    postcode?: string
  ): void {
    if (!this.traceViewer || this.geocodingKey) {
      return;
    }
    if (this.hasCoords(item)) {
      this.traceViewer.openAtLocation(item.lat as number, item.lon as number, label);
      return;
    }
    const query = queryParts.filter(Boolean).join(' ');
    if (!query.trim()) {
      this.errorMessage = 'FONCIER.GEOCODE_FAILED';
      return;
    }
    this.geocodingKey = item.id || query;
    this.api.geocodeFoncierPlace(query, postcode).subscribe({
      next: (hit) => {
        this.geocodingKey = '';
        if (!this.hasCoords(hit)) {
          if (this.hasCoords(this.selected)) {
            this.traceViewer?.openAtLocation(this.selected!.lat as number, this.selected!.lon as number, label);
            return;
          }
          this.errorMessage = 'FONCIER.GEOCODE_FAILED';
          return;
        }
        item.lat = hit.lat;
        item.lon = hit.lon;
        this.traceViewer?.openAtLocation(hit.lat as number, hit.lon as number, hit.label || label);
      },
      error: () => {
        this.geocodingKey = '';
        if (this.hasCoords(this.selected)) {
          this.traceViewer?.openAtLocation(this.selected!.lat as number, this.selected!.lon as number, label);
          return;
        }
        this.errorMessage = 'FONCIER.GEOCODE_FAILED';
      }
    });
  }

  private lookupCommunes(value: string, fromSubmit = false): void {
    this.communeSub?.unsubscribe();
    this.searchingCommunes = true;
    this.communeSub = this.api.searchFoncierCommunes(value.trim()).subscribe({
      next: (res) => {
        let items = res?.items || [];
        if (!items.length && this.useLocalCache()) {
          items = placesFromCache(this.cacheItems, value);
        }
        if (!items.length && /^\d{5}$/.test(value.trim())) {
          const zip = value.trim();
          items = [{ code: zip, nom: zip, codesPostaux: [zip] }];
        }
        this.communes = items;
        this.communeActiveIndex = items.length ? 0 : -1;
        this.searchingCommunes = false;
        if (fromSubmit && items.length === 0) {
          this.errorMessage = 'FONCIER.NO_COMMUNE';
        }
      },
      error: () => {
        const local = this.useLocalCache() ? placesFromCache(this.cacheItems, value) : [];
        this.communes = local;
        this.communeActiveIndex = local.length ? 0 : -1;
        this.searchingCommunes = false;
        if (local.length) {
          return;
        }
        this.errorMessage = fromSubmit ? 'FONCIER.NO_COMMUNE' : 'FONCIER.ERROR';
      }
    });
  }

  private canSearch(): boolean {
    return this.configured || this.cacheMode !== 'api';
  }

  private useLocalCache(): boolean {
    return this.cacheMode === 'cache' && this.localCacheReady;
  }

  private runSearch(_page: number): void {
    if (!this.canSearch()) {
      this.errorMessage = this.keyHelpKey;
      return;
    }
    if (this.cacheMode === 'cache' && this.cacheLoadPending) {
      this.searched = true;
      this.page = 1;
      return;
    }
    if (this.useLocalCache()) {
      this.applyLocalSearch();
      return;
    }
    if (this.isCerema) {
      this.loadMutations();
      return;
    }
    this.loadListings();
  }

  private loadMutations(): void {
    const code = this.selected?.code || '';
    const around = this.radiusKm > 0 && this.hasCoords(this.selected);
    if (!code && !around) {
      return;
    }
    this.resultSub?.unsubscribe();
    this.loading = true;
    this.searched = true;
    this.errorMessage = '';
    this.page = 1;
    this.fullMutations = [];
    this.fullListings = [];
    this.syncUrlIfChanged();
    this.fetchMutationPage(1);
  }

  private fetchMutationPage(page: number): void {
    this.resultSub = this.api.getCeremaMutations({
      codeInsee: this.selected?.code || '',
      typeLocal: this.type,
      page,
      radiusKm: this.radiusKm,
      source: page > 1 && this.cacheMode === 'both' ? 'api' : this.cacheMode,
      priceMin: this.toInt(this.priceMin),
      priceMax: this.toInt(this.priceMax),
      surfaceMin: this.toInt(this.surfaceMin),
      lat: this.selected?.lat,
      lon: this.selected?.lon
    }).subscribe({
      next: (res) => {
        const incoming = res?.items || [];
        this.pushUnique(this.fullMutations, incoming);
        if (res?.cacheCount != null) {
          this.cacheCount = res.cacheCount;
        }
        const total = res?.count != null ? res.count : this.fullMutations.length;
        const more = !!res?.hasNext
          && incoming.length > 0
          && this.fullMutations.length < total
          && page < 30;
        if (more) {
          this.fetchMutationPage(page + 1);
          return;
        }
        this.finalizeMutations();
      },
      error: (err) => {
        if (this.fullMutations.length) {
          this.finalizeMutations();
          return;
        }
        this.loading = false;
        this.mutations = [];
        this.rawMutations = [];
        this.fullMutations = [];
        this.errorMessage = err?.error?.error === 'upstream_unavailable'
          ? 'FONCIER.ERROR_UPSTREAM'
          : 'FONCIER.ERROR';
      }
    });
  }

  private finalizeMutations(): void {
    this.loading = false;
    this.fullMutations = sortCacheItems(this.fullMutations, this.sortKey);
    this.fullListings = [];
    this.page = 1;
    this.applyPageSlice();
    this.ingestCacheItems(this.fullMutations);
  }

  private loadListings(): void {
    this.resultSub?.unsubscribe();
    this.loading = true;
    this.searched = true;
    this.errorMessage = '';
    this.page = 1;
    this.fullListings = [];
    this.fullMutations = [];
    this.syncUrlIfChanged();
    this.fetchListingPage(1);
  }

  private fetchListingPage(page: number): void {
    this.resultSub = this.listingsCall(page).subscribe({
      next: (res) => {
        const incoming = res?.items || [];
        this.pushUnique(this.fullListings, incoming);
        this.count = Math.max(res?.count ?? 0, this.fullListings.length);
        if (this.provider === 'chercher-trouver') {
          this.ctConfigured = res?.configured !== false;
        } else {
          this.seConfigured = res?.configured !== false;
        }
        if (res?.cacheCount != null) {
          this.cacheCount = res.cacheCount;
        }
        const gotAll = incoming.length > this.pageSize
          || !res?.hasNext
          || this.fullListings.length >= this.count;
        const more = !gotAll && incoming.length > 0 && page < 50;
        if (more) {
          this.fetchListingPage(page + 1);
          return;
        }
        this.finalizeListings();
      },
      error: (err) => {
        if (this.fullListings.length) {
          this.finalizeListings();
          return;
        }
        this.loading = false;
        this.listings = [];
        this.rawListings = [];
        this.fullListings = [];
        this.count = 0;
        this.hasNext = false;
        const code = err?.error?.error;
        if (code === 'not_configured') {
          if (this.provider === 'chercher-trouver') {
            this.ctConfigured = false;
          } else {
            this.seConfigured = false;
          }
          this.errorMessage = this.keyHelpKey;
        } else if (code === 'invalid_key') {
          this.errorMessage = 'FONCIER.ERROR_INVALID_KEY';
        } else if (code === 'insufficient_credits') {
          this.errorMessage = 'FONCIER.ERROR_CREDITS';
        } else if (code === 'forbidden') {
          this.errorMessage = 'FONCIER.ERROR_FORBIDDEN';
        } else if (code === 'upstream_unavailable' || code === 'upstream_failed') {
          this.errorMessage = 'FONCIER.ERROR_UPSTREAM';
        } else {
          this.errorMessage = 'FONCIER.ERROR';
        }
      }
    });
  }

  private finalizeListings(): void {
    this.loading = false;
    this.fullListings = sortCacheItems(this.fullListings, this.sortKey);
    this.fullMutations = [];
    this.page = 1;
    this.applyPageSlice();
    this.ingestCacheItems(this.fullListings);
  }

  private listingsCall(page: number) {
    const opts = {
      q: this.selected?.nom || this.query.trim(),
      type: this.type,
      priceMin: this.toInt(this.priceMin),
      priceMax: this.toInt(this.priceMax),
      surfaceMin: this.toInt(this.surfaceMin),
      surfaceMax: this.toInt(this.surfaceMax),
      page,
      codeInsee: this.selected?.code,
      radiusKm: this.radiusKm > 0 ? this.radiusKm : undefined,
      lat: this.selected?.lat,
      lon: this.selected?.lon,
      source: page > 1 && this.cacheMode === 'both' ? 'api' as FoncierCacheSource : this.cacheMode
    };
    return this.provider === 'chercher-trouver'
      ? this.api.searchChercherTrouverListings(opts)
      : this.api.searchStreamEstateListings(opts);
  }

  private refreshCacheCount(): void {
    this.api.getFoncierCache(this.provider).subscribe({
      next: (res) => {
        this.cacheItems = (res?.items || []) as FoncierCacheRow[];
        this.localCacheReady = Array.isArray(res?.items);
        this.cacheLoadPending = false;
        this.cacheCount = res?.count ?? this.cacheItems.length;
        if (this.cacheMode === 'cache' && this.selected) {
          this.runSearch(this.page || 1);
        }
      },
      error: () => {
        this.localCacheReady = false;
        this.cacheLoadPending = false;
      }
    });
  }

  private ingestCacheItems(items: FoncierCacheRow[] | undefined): void {
    if (!items?.length) {
      return;
    }
    const byId = new Map(this.cacheItems.filter((item) => item.id).map((item) => [item.id as string, item]));
    const withoutId = this.cacheItems.filter((item) => !item.id);
    for (const item of items) {
      if (item.id) {
        byId.set(item.id, item);
      } else {
        withoutId.push(item);
      }
    }
    this.cacheItems = withoutId.concat([...byId.values()]);
    this.cacheCount = Math.max(this.cacheCount, this.cacheItems.length);
  }

  private applyLocalSearch(): void {
    this.resultSub?.unsubscribe();
    this.loading = false;
    this.searched = true;
    this.errorMessage = '';
    this.page = 1;
    const q = this.query.trim();
    const matched = filterCacheItems(this.cacheItems, {
      q,
      codeInsee: this.selected?.code,
      zip: this.selected?.codesPostaux?.[0],
      type: this.type,
      priceMin: this.toInt(this.priceMin),
      priceMax: this.toInt(this.priceMax),
      surfaceMin: this.toInt(this.surfaceMin),
      surfaceMax: this.toInt(this.surfaceMax),
      radiusKm: this.radiusKm,
      lat: this.selected?.lat,
      lon: this.selected?.lon
    });
    const sorted = sortCacheItems(matched, this.sortKey);
    if (this.isCerema) {
      this.fullMutations = sorted as FoncierMutation[];
      this.fullListings = [];
    } else {
      this.fullListings = sorted as FoncierListing[];
      this.fullMutations = [];
    }
    this.applyPageSlice();
    this.syncUrlIfChanged();
  }

  private applyPageSlice(): void {
    const from = (this.page - 1) * this.pageSize;
    const to = from + this.pageSize;
    if (this.isCerema) {
      this.rawMutations = this.fullMutations.slice(from, to);
      this.mutations = this.rawMutations;
      this.rawListings = [];
      this.listings = [];
      this.count = this.fullMutations.length;
      this.hasNext = to < this.fullMutations.length;
      return;
    }
    this.rawListings = this.fullListings.slice(from, to);
    this.listings = this.rawListings;
    this.rawMutations = [];
    this.mutations = [];
    this.count = this.fullListings.length;
    this.hasNext = to < this.fullListings.length;
  }

  private pushUnique<T extends { id?: string; url?: string; address?: string }>(target: T[], items: T[]): void {
    const seen = new Set(target.map((item) => item.id || item.url || item.address || JSON.stringify(item)));
    for (const item of items) {
      const key = item.id || item.url || item.address || JSON.stringify(item);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      target.push(item);
    }
  }

  private applyPickedMapLocation(lat: number, lon: number): void {
    this.locating = true;
    this.errorMessage = '';
    this.positionSub?.unsubscribe();
    this.positionSub = this.api.geocodeReverse(lat, lon).pipe(
      catchError(() => of(null))
    ).subscribe({
      next: (geo) => {
        this.ngZone.run(() => {
          this.locating = false;
          this.applyMyPosition(lat, lon, geo);
        });
      },
      error: () => {
        this.ngZone.run(() => {
          this.locating = false;
          this.applyMyPosition(lat, lon, null);
        });
      }
    });
  }

  private applyMyPosition(lat: number, lon: number, geo: unknown): void {
    const parsed = this.parseReverseGeo(geo, lat, lon);
    this.query = parsed.label;
    this.communes = [];
    this.communeActiveIndex = -1;
    this.errorMessage = '';
    if (this.radiusKm === 0) {
      this.radiusKm = 10;
    }
    const lookup = parsed.postcode || parsed.city;
    const fallback: FoncierCommune = {
      code: parsed.postcode || '',
      nom: parsed.city || parsed.label,
      codesPostaux: parsed.postcode ? [parsed.postcode] : [],
      lat,
      lon
    };
    if (!lookup) {
      this.selected = fallback;
      this.runSearch(1);
      return;
    }
    this.communeSub?.unsubscribe();
    this.communeSub = this.api.searchFoncierCommunes(lookup).subscribe({
      next: (res) => {
        const commune = res?.items?.[0];
        this.selected = {
          code: commune?.code || parsed.postcode || '',
          nom: parsed.city || commune?.nom || parsed.label,
          departement: commune?.departement,
          codesPostaux: commune?.codesPostaux?.length
            ? commune.codesPostaux
            : (parsed.postcode ? [parsed.postcode] : []),
          lat,
          lon
        };
        this.runSearch(1);
      },
      error: () => {
        this.selected = fallback;
        this.runSearch(1);
      }
    });
  }

  private parseReverseGeo(
    geo: unknown,
    lat: number,
    lon: number
  ): { label: string; city: string; postcode: string } {
    const root = geo && typeof geo === 'object' ? geo as Record<string, unknown> : {};
    const addr = root['address'] && typeof root['address'] === 'object'
      ? root['address'] as Record<string, unknown>
      : {};
    const city = String(addr['city'] || addr['town'] || addr['village'] || addr['municipality'] || addr['hamlet'] || '').trim();
    const postcode = String(addr['postcode'] || '').replace(/\D/g, '').slice(0, 5);
    const road = [addr['house_number'], addr['road']].filter(Boolean).join(' ').trim();
    const display = String(root['displayName'] || root['display_name'] || '').trim();
    const cityLine = [postcode, city].filter(Boolean).join(' ');
    const label = [road, cityLine].filter(Boolean).join(', ')
      || display
      || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    return { label, city: city || label, postcode };
  }

  private toInt(value: string): number | undefined {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  private syncUrlIfChanged(): void {
    const next: Record<string, string | null> = {
      provider: this.provider,
      q: this.query.trim() || null,
      type: this.type || null,
      priceMin: this.priceMin || null,
      priceMax: this.priceMax || null,
      surfaceMin: this.surfaceMin || null,
      surfaceMax: this.surfaceMax || null,
      insee: this.selected?.code || null,
      radius: this.radiusKm > 0 ? String(this.radiusKm) : null,
      source: this.cacheMode !== 'cache' ? this.cacheMode : null,
      sort: this.sortKey !== 'date-desc' ? this.sortKey : null
    };
    const params = this.route.snapshot.queryParamMap;
    const unchanged = Object.keys(next).every((key) => (params.get(key) || null) === next[key]);
    if (unchanged) {
      return;
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: next,
      replaceUrl: true
    });
  }
}
