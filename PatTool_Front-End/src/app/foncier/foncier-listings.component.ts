import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

import { ApiService, FoncierCacheSource, FoncierCommune, FoncierListing } from '../services/api.service';
import { filterCacheItems, paginateCache, placesFromCache } from './foncier-cache-query';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';

export type FoncierListingProvider = 'stream-estate' | 'chercher-trouver';

@Component({
  selector: 'app-foncier-listings',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, TraceViewerModalComponent],
  templateUrl: './foncier-listings.component.html',
  styleUrls: ['./foncier-shared.css']
})
export class FoncierListingsComponent implements OnInit, OnDestroy {

  readonly radiusOptions = [0, 2, 5, 10, 20, 30];
  readonly sourceOptions: FoncierCacheSource[] = ['cache', 'both', 'api'];

  provider: FoncierListingProvider = 'stream-estate';
  query = '';
  type = '';
  radiusKm = 0;
  cacheMode: FoncierCacheSource = 'cache';
  cacheCount = 0;
  clearingCache = false;
  priceMin = '';
  priceMax = '';
  surfaceMin = '';
  surfaceMax = '';
  communes: FoncierCommune[] = [];
  selected: FoncierCommune | null = null;
  listings: FoncierListing[] = [];
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
    const insee = params.get('insee') || '';

    this.subs.push(
      this.query$.pipe(debounceTime(80), distinctUntilChanged()).subscribe((value) => {
        if (this.cacheMode === 'cache') {
          return;
        }
        if (value.trim().length >= 2 && !this.selected && !/^\d{5}$/.test(value.trim())) {
          this.lookupCommunes(value);
        }
      })
    );

    if (insee.match(/^\d{5}$/)) {
      this.selected = { code: insee, nom: this.query || insee };
    } else if (this.cacheMode !== 'cache' && this.query.length >= 2 && !/^\d{5}$/.test(this.query)) {
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
    if (this.cacheMode === 'cache') {
      const q = this.query.trim();
      if (q.length >= 2 || /^\d{5}$/.test(q)) {
        this.search(1);
      } else {
        this.listings = [];
        this.communes = [];
        this.searched = false;
      }
      return;
    }
    this.listings = [];
    this.searched = false;
  }

  submitSearch(): void {
    const q = this.query.trim();
    if (!q) {
      return;
    }
    if (this.selected) {
      this.search(1);
      return;
    }
    if (/^\d{5}$/.test(q) || this.cacheMode === 'cache') {
      this.search(1);
      return;
    }
    this.lookupCommunes(q, true);
  }

  pickCommune(commune: FoncierCommune): void {
    this.selected = commune;
    this.query = commune.nom;
    this.communes = [];
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
    this.cacheMode = 'cache';
    this.communes = [];
    this.selected = null;
        this.listings = [];
        this.count = 0;
        this.hasNext = false;
        this.page = 1;
    this.searched = false;
    this.errorMessage = '';
    this.syncUrlIfChanged();
  }

  onRadiusChanged(): void {
    if (this.selected || this.query.trim()) {
      this.submitSearch();
    }
  }

  onSourceChanged(): void {
    this.syncUrlIfChanged();
    if (this.selected || this.query.trim()) {
      this.search(1);
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

  private lookupCommunes(value: string, autoPick = false): void {
    if (this.useLocalCache()) {
      this.communeSub?.unsubscribe();
      this.searchingCommunes = false;
      this.communes = placesFromCache(this.cacheItems, value);
      if (autoPick && this.communes.length === 1) {
        this.pickCommune(this.communes[0]);
      } else if (autoPick && this.communes.length === 0) {
        this.errorMessage = 'FONCIER.NO_COMMUNE';
      }
      return;
    }
    this.communeSub?.unsubscribe();
    this.searchingCommunes = true;
    this.communeSub = this.api.searchFoncierCommunes(value.trim()).subscribe({
      next: (res) => {
        this.communes = res?.items || [];
        this.searchingCommunes = false;
        if (autoPick && this.communes.length === 1) {
          this.pickCommune(this.communes[0]);
        } else if (autoPick && this.communes.length === 0) {
          this.errorMessage = 'FONCIER.NO_COMMUNE';
        }
      },
      error: () => {
        this.searchingCommunes = false;
        this.communes = [];
        this.errorMessage = 'FONCIER.ERROR';
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
        this.listings = res?.items || [];
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
        if (this.cacheMode === 'cache' && (this.searched || this.selected || this.query.trim().length >= 2)) {
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
    if (!this.selected) {
      this.communes = placesFromCache(this.cacheItems, q);
    }
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
    const slice = paginateCache(matched, page, 20);
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
      source: this.cacheMode !== 'cache' ? this.cacheMode : null
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
