import { Component, HostBinding, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

import { ApiService, FoncierCacheSource, FoncierCommune, FoncierListing } from '../services/api.service';
import {
  FONCIER_SORT_OPTIONS,
  FoncierSortKey,
  filterCacheItems,
  paginateCache,
  parseFoncierSort,
  placesFromCache,
  sortCacheItems,
  sortLabelKey
} from './foncier-cache-query';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import { SheetSelectComponent, SheetSelectOption } from '../shared/sheet-select/sheet-select.component';

export type FoncierListingProvider = 'stream-estate' | 'chercher-trouver';

@Component({
  selector: 'app-foncier-listings',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, TraceViewerModalComponent, SheetSelectComponent],
  templateUrl: './foncier-listings.component.html',
  styleUrls: ['./foncier-shared.css']
})
export class FoncierListingsComponent implements OnInit, OnDestroy {

  readonly radiusOptions = [0, 2, 5, 10, 20, 30];
  readonly sourceOptions: FoncierCacheSource[] = ['cache', 'both', 'api'];
  readonly sortOptions = FONCIER_SORT_OPTIONS;
  readonly typeOptions: SheetSelectOption[] = [
    { value: '', labelKey: 'FONCIER.TYPE_ALL', icon: 'fa fa-th' },
    { value: 'maison', labelKey: 'FONCIER.TYPE_HOUSE', icon: 'fa fa-home' },
    { value: 'appartement', labelKey: 'FONCIER.TYPE_FLAT', icon: 'fa fa-building' },
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

  provider: FoncierListingProvider = 'stream-estate';
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
  private rawResults: FoncierListing[] = [];
  count = 0;
  page = 1;
  hasNext = false;
  configured = true;

  searchingCommunes = false;
  loading = false;
  searched = false;
  errorMessage = '';
  signupUrl = '';
  geocodingKey = '';
  private cacheItems: FoncierListing[] = [];
  private localCacheReady = false;
  private cacheLoadPending = true;

  @HostBinding('class.foncier-stream-estate')
  get isStreamEstate(): boolean {
    return this.provider === 'stream-estate';
  }

  @HostBinding('class.foncier-chercher-trouver')
  get isChercherTrouver(): boolean {
    return this.provider === 'chercher-trouver';
  }

  @ViewChild(TraceViewerModalComponent) traceViewer?: TraceViewerModalComponent;

  private readonly query$ = new Subject<string>();
  private statusSub?: Subscription;
  private communeSub?: Subscription;
  private listSub?: Subscription;
  private readonly subs: Subscription[] = [];

  constructor(
    private api: ApiService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  ngOnInit(): void {
    const dataProvider = this.route.snapshot.data['provider'] as FoncierListingProvider;
    this.provider = dataProvider === 'chercher-trouver' ? 'chercher-trouver' : 'stream-estate';
    this.signupUrl = this.provider === 'chercher-trouver'
      ? 'https://cherchertrouver.immo/api'
      : 'https://stream.estate/fr/api-immobilier';

    const params = this.route.snapshot.queryParamMap;
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
    this.statusSub = this.statusCall().subscribe({
      next: (res) => {
        this.configured = !!res?.configured;
        if (res?.cacheCount != null) {
          this.cacheCount = res.cacheCount;
        }
        if (this.selected && this.canSearch()) {
          this.search(1);
        }
      },
      error: () => {
        this.configured = false;
      }
    });
  }

  ngOnDestroy(): void {
    this.statusSub?.unsubscribe();
    this.communeSub?.unsubscribe();
    this.listSub?.unsubscribe();
    this.subs.forEach((s) => s.unsubscribe());
  }

  get titleKey(): string {
    return this.provider === 'chercher-trouver' ? 'FONCIER.CT_TITLE' : 'FONCIER.SE_TITLE';
  }

  get subtitleKey(): string {
    return this.provider === 'chercher-trouver' ? 'FONCIER.CT_SUBTITLE' : 'FONCIER.SE_SUBTITLE';
  }

  get emptyKey(): string {
    return this.provider === 'chercher-trouver' ? 'FONCIER.CT_EMPTY' : 'FONCIER.SE_EMPTY';
  }

  get keyHelpKey(): string {
    return this.provider === 'chercher-trouver' ? 'FONCIER.CT_KEY_HELP' : 'FONCIER.SE_KEY_HELP';
  }

  onQueryChanged(): void {
    this.selected = null;
    this.errorMessage = '';
    this.query$.next(this.query);
    this.syncUrlIfChanged();
    this.listings = [];
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
      this.search(1);
      return;
    }
    this.lookupCommunes(q, true);
  }

  pickCommune(commune: FoncierCommune): void {
    this.selected = commune;
    this.query = commune.nom;
    this.communes = [];
    this.communeActiveIndex = -1;
    this.search(1);
  }

  clearSearch(): void {
    this.communeSub?.unsubscribe();
    this.listSub?.unsubscribe();
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
        this.rawResults = [];
        this.count = 0;
        this.hasNext = false;
        this.page = 1;
    this.searched = false;
    this.errorMessage = '';
    this.syncUrlIfChanged();
  }

  onRadiusChanged(): void {
    if (this.selected) {
      this.search(1);
    }
  }

  onSortChanged(): void {
    if (this.useLocalCache()) {
      this.search(1);
      return;
    }
    this.listings = sortCacheItems(this.rawResults, this.sortKey);
    this.syncUrlIfChanged();
  }

  sortLabelKey(sort: FoncierSortKey): string {
    return sortLabelKey(sort);
  }

  onSourceChanged(): void {
    this.syncUrlIfChanged();
    if (this.selected) {
      this.search(1);
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
          this.search(this.page);
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
    if (next < 1) {
      return;
    }
    this.search(next);
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

  photoStyle(listing: FoncierListing): Record<string, string> | null {
    return listing.photo ? { 'background-image': `url(${listing.photo})` } : null;
  }

  canOpenMap(listing: FoncierListing): boolean {
    return this.hasCoords(listing) || !!(listing.address || listing.city || listing.zipcode || this.selected);
  }

  openInTraceViewer(listing: FoncierListing): void {
    if (!this.traceViewer || this.geocodingKey) {
      return;
    }
    const label = [listing.title, listing.address, listing.city, listing.zipcode].filter(Boolean).join(' · ');
    if (this.hasCoords(listing)) {
      this.traceViewer.openAtLocation(listing.lat as number, listing.lon as number, label);
      return;
    }
    const query = [listing.address, listing.city, listing.zipcode, this.selected?.nom].filter(Boolean).join(' ');
    const postcode = listing.zipcode || this.selected?.codesPostaux?.[0];
    if (!query.trim()) {
      this.errorMessage = 'FONCIER.GEOCODE_FAILED';
      return;
    }
    this.geocodingKey = listing.id || query;
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
        listing.lat = hit.lat;
        listing.lon = hit.lon;
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

  private hasCoords(item?: { lat?: number; lon?: number } | null): boolean {
    return Number.isFinite(item?.lat) && Number.isFinite(item?.lon);
  }

  communeMeta(commune: FoncierCommune): string {
    const zip = commune.codesPostaux?.[0] || '';
    const dept = commune.departement || '';
    return [zip, dept, commune.code ? `INSEE ${commune.code}` : ''].filter(Boolean).join(' · ');
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

  private search(page: number): void {
    if (!this.canSearch()) {
      this.errorMessage = this.keyHelpKey;
      return;
    }
    if (this.cacheMode === 'cache' && this.cacheLoadPending) {
      this.searched = true;
      this.page = page;
      return;
    }
    if (this.useLocalCache()) {
      this.applyLocalSearch(page);
      return;
    }
    this.listSub?.unsubscribe();
    this.loading = true;
    this.searched = true;
    this.errorMessage = '';
    this.page = page;
    this.syncUrlIfChanged();
    this.listSub = this.listingsCall(page).subscribe({
      next: (res) => {
        this.loading = false;
        this.rawResults = res?.items || [];
        this.listings = sortCacheItems(this.rawResults, this.sortKey);
        this.count = res?.count != null ? res.count : this.listings.length;
        this.hasNext = !!res?.hasNext;
        this.configured = res?.configured !== false;
        if (res?.cacheCount != null) {
          this.cacheCount = res.cacheCount;
        }
        this.ingestCacheItems(this.listings);
      },
      error: (err) => {
        this.loading = false;
        this.listings = [];
        this.rawResults = [];
        this.count = 0;
        this.hasNext = false;
        const code = err?.error?.error;
        if (code === 'not_configured') {
          this.configured = false;
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

  private statusCall() {
    return this.provider === 'chercher-trouver'
      ? this.api.getChercherTrouverStatus()
      : this.api.getStreamEstateStatus();
  }

  private listingsCall(page: number) {
    const opts = {
      q: this.query.trim(),
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
      source: this.cacheMode
    };
    return this.provider === 'chercher-trouver'
      ? this.api.searchChercherTrouverListings(opts)
      : this.api.searchStreamEstateListings(opts);
  }

  private refreshCacheCount(): void {
    this.api.getFoncierCache(this.provider).subscribe({
      next: (res) => {
        this.cacheItems = res?.items || [];
        this.localCacheReady = Array.isArray(res?.items);
        this.cacheLoadPending = false;
        this.cacheCount = res?.count ?? this.cacheItems.length;
        if (this.cacheMode === 'cache' && this.selected) {
          this.search(this.page || 1);
        }
      },
      error: () => {
        this.localCacheReady = false;
        this.cacheLoadPending = false;
      }
    });
  }

  private ingestCacheItems(items: FoncierListing[] | undefined): void {
    if (!items?.length) {
      return;
    }
    const byId = new Map(this.cacheItems.filter((item) => item.id).map((item) => [item.id as string, item]));
    for (const item of items) {
      if (item.id) {
        byId.set(item.id, item);
      } else {
        this.cacheItems.push(item);
      }
    }
    this.cacheItems = this.cacheItems.filter((item) => !item.id).concat([...byId.values()]);
    this.cacheCount = Math.max(this.cacheCount, this.cacheItems.length);
  }

  private applyLocalSearch(page: number): void {
    this.listSub?.unsubscribe();
    this.loading = false;
    this.searched = true;
    this.errorMessage = '';
    this.page = page;
    const q = this.query.trim();
    const matched = filterCacheItems(this.cacheItems, {
      q,
      codeInsee: this.selected?.code,
      type: this.type,
      priceMin: this.toInt(this.priceMin),
      priceMax: this.toInt(this.priceMax),
      surfaceMin: this.toInt(this.surfaceMin),
      surfaceMax: this.toInt(this.surfaceMax),
      radiusKm: this.radiusKm,
      lat: this.selected?.lat,
      lon: this.selected?.lon
    });
    const slice = paginateCache(sortCacheItems(matched, this.sortKey), page, 20);
    this.rawResults = slice.items;
    this.listings = slice.items;
    this.count = slice.count;
    this.hasNext = slice.hasNext;
    this.syncUrlIfChanged();
  }

  private toInt(value: string): number | undefined {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  private syncUrlIfChanged(): void {
    const next: Record<string, string | null> = {
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
