import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

import {
  ApiService,
  FoncierCacheSource,
  FoncierCommune,
  FoncierMutation
} from '../services/api.service';
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

@Component({
  selector: 'app-foncier-cerema',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, TraceViewerModalComponent, SheetSelectComponent],
  templateUrl: './cerema.component.html',
  styleUrls: ['./foncier-shared.css']
})
export class FoncierCeremaComponent implements OnInit, OnDestroy {

  readonly radiusOptions = [0, 2, 5, 10, 20, 30];
  readonly sourceOptions: FoncierCacheSource[] = ['cache', 'both', 'api'];
  readonly sortOptions = FONCIER_SORT_OPTIONS;
  readonly typeOptions: SheetSelectOption[] = [
    { value: '', labelKey: 'FONCIER.TYPE_ALL', icon: 'fa fa-th' },
    { value: 'maison', labelKey: 'FONCIER.TYPE_HOUSE', icon: 'fa fa-home' },
    { value: 'appartement', labelKey: 'FONCIER.TYPE_FLAT', icon: 'fa fa-building' }
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

  query = '';
  typeLocal = '';
  radiusKm = 0;
  cacheMode: FoncierCacheSource = 'cache';
  sortKey: FoncierSortKey = 'date-desc';
  cacheCount = 0;
  clearingCache = false;
  communes: FoncierCommune[] = [];
  selected: FoncierCommune | null = null;
  communeActiveIndex = -1;
  mutations: FoncierMutation[] = [];
  private rawResults: FoncierMutation[] = [];
  count = 0;
  page = 1;
  hasNext = false;

  searchingCommunes = false;
  loading = false;
  searched = false;
  errorMessage = '';
  geocodingKey = '';
  private cacheItems: FoncierMutation[] = [];
  private localCacheReady = false;
  private cacheLoadPending = true;

  @ViewChild(TraceViewerModalComponent) traceViewer?: TraceViewerModalComponent;

  private readonly query$ = new Subject<string>();
  private communeSub?: Subscription;
  private mutationSub?: Subscription;
  private readonly subs: Subscription[] = [];

  constructor(
    private api: ApiService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  ngOnInit(): void {
    const params = this.route.snapshot.queryParamMap;
    this.query = (params.get('q') || '').trim();
    this.typeLocal = params.get('type') || '';
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

    this.refreshCacheCount();

    if (insee.match(/^\d{5}$/)) {
      this.selected = { code: insee, nom: this.query || insee };
      this.loadMutations(1);
    } else if (this.query.length >= 2) {
      this.lookupCommunes(this.query);
    }
  }

  ngOnDestroy(): void {
    this.communeSub?.unsubscribe();
    this.mutationSub?.unsubscribe();
    this.subs.forEach((s) => s.unsubscribe());
  }

  onQueryChanged(): void {
    this.selected = null;
    this.errorMessage = '';
    this.query$.next(this.query);
    this.syncUrl();
    this.mutations = [];
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
      this.loadMutations(1);
      return;
    }
    this.lookupCommunes(q, true);
  }

  pickCommune(commune: FoncierCommune): void {
    this.selected = commune;
    this.query = commune.nom;
    this.communes = [];
    this.communeActiveIndex = -1;
    this.loadMutations(1);
  }

  clearSearch(): void {
    this.communeSub?.unsubscribe();
    this.mutationSub?.unsubscribe();
    this.query = '';
    this.typeLocal = '';
    this.radiusKm = 0;
    this.sortKey = 'date-desc';
    this.cacheMode = 'cache';
    this.communes = [];
    this.communeActiveIndex = -1;
    this.selected = null;
    this.mutations = [];
    this.rawResults = [];
    this.count = 0;
    this.page = 1;
    this.hasNext = false;
    this.searched = false;
    this.errorMessage = '';
    this.syncUrl();
  }

  onSortChanged(): void {
    if (this.useLocalCache()) {
      this.loadMutations(1);
      return;
    }
    this.mutations = sortCacheItems(this.rawResults, this.sortKey);
    this.syncUrl();
  }

  sortLabelKey(sort: FoncierSortKey): string {
    return sortLabelKey(sort);
  }

  onTypeChanged(): void {
    if (this.selected) {
      this.loadMutations(1);
    }
  }

  onRadiusChanged(): void {
    if (this.selected) {
      this.loadMutations(1);
    }
  }

  onSourceChanged(): void {
    this.syncUrl();
    if (this.selected) {
      this.loadMutations(1);
    } else if (this.query.trim().length >= 2) {
      this.lookupCommunes(this.query);
    }
  }

  clearCache(): void {
    if (this.clearingCache) {
      return;
    }
    this.clearingCache = true;
    this.api.clearFoncierCache('cerema').subscribe({
      next: (res) => {
        this.clearingCache = false;
        this.cacheItems = [];
        this.localCacheReady = true;
        this.cacheCount = res?.count ?? 0;
        if (this.selected || (this.cacheMode === 'cache' && this.query.trim())) {
          this.loadMutations(this.page);
        }
      },
      error: () => {
        this.clearingCache = false;
        this.errorMessage = 'FONCIER.ERROR';
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

  loadPage(delta: number): void {
    const next = this.page + delta;
    if (next < 1 || (delta > 0 && !this.hasNext)) {
      return;
    }
    this.loadMutations(next);
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

  canOpenMap(row: FoncierMutation): boolean {
    return this.hasCoords(row) || !!(row.address || this.selected);
  }

  openInTraceViewer(row: FoncierMutation): void {
    if (!this.traceViewer || this.geocodingKey) {
      return;
    }
    const label = row.address || this.selected?.nom || '';
    if (this.hasCoords(row)) {
      this.traceViewer.openAtLocation(row.lat as number, row.lon as number, label);
      return;
    }
    const query = [row.address, this.selected?.nom].filter(Boolean).join(' ');
    const postcode = this.selected?.codesPostaux?.[0];
    if (!query.trim()) {
      this.errorMessage = 'FONCIER.GEOCODE_FAILED';
      return;
    }
    this.geocodingKey = row.id || query;
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
        row.lat = hit.lat;
        row.lon = hit.lon;
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

  private hasCoords(item?: { lat?: number; lon?: number } | null): boolean {
    return Number.isFinite(item?.lat) && Number.isFinite(item?.lon);
  }

  communeMeta(commune: FoncierCommune): string {
    const zip = commune.codesPostaux?.[0] || '';
    const dept = commune.departement || '';
    return [zip, dept, commune.code ? `INSEE ${commune.code}` : ''].filter(Boolean).join(' · ');
  }

  private refreshCacheCount(): void {
    this.api.getFoncierCache('cerema').subscribe({
      next: (res) => {
        this.cacheItems = (res?.items || []) as FoncierMutation[];
        this.localCacheReady = Array.isArray(res?.items);
        this.cacheLoadPending = false;
        this.cacheCount = res?.count ?? this.cacheItems.length;
        if (this.cacheMode === 'cache' && this.selected) {
          this.loadMutations(this.page || 1);
        }
      },
      error: () => {
        this.localCacheReady = false;
        this.cacheLoadPending = false;
      }
    });
  }

  private useLocalCache(): boolean {
    return this.cacheMode === 'cache' && this.localCacheReady;
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

  private ingestCacheItems(items: FoncierMutation[] | undefined): void {
    if (!items?.length) {
      return;
    }
    const byId = new Map(this.cacheItems.filter((item) => item.id).map((item) => [item.id as string, item]));
    for (const item of items) {
      if (item.id) {
        byId.set(item.id, item);
      }
    }
    this.cacheItems = [...byId.values()];
    this.cacheCount = Math.max(this.cacheCount, this.cacheItems.length);
  }

  private applyLocalMutations(page: number): void {
    this.mutationSub?.unsubscribe();
    this.loading = false;
    this.searched = true;
    this.errorMessage = '';
    this.page = page;
    const q = this.query.trim();
    const matched = filterCacheItems(this.cacheItems, {
      q,
      codeInsee: this.selected?.code,
      type: this.typeLocal,
      radiusKm: this.radiusKm,
      lat: this.selected?.lat,
      lon: this.selected?.lon
    });
    const slice = paginateCache(sortCacheItems(matched, this.sortKey), page, 40);
    this.rawResults = slice.items;
    this.mutations = slice.items;
    this.count = slice.count;
    this.hasNext = slice.hasNext;
    this.syncUrl();
  }

  private loadMutations(page: number): void {
    if (this.cacheMode === 'cache' && this.cacheLoadPending) {
      this.searched = true;
      this.page = page;
      return;
    }
    if (this.useLocalCache()) {
      this.applyLocalMutations(page);
      return;
    }
    if (!this.selected?.code) {
      return;
    }
    this.mutationSub?.unsubscribe();
    this.loading = true;
    this.searched = true;
    this.errorMessage = '';
    this.page = page;
    this.syncUrl();
    this.mutationSub = this.api.getCeremaMutations(
      this.selected.code,
      this.typeLocal,
      page,
      this.radiusKm,
      this.cacheMode
    ).subscribe({
      next: (res) => {
        this.loading = false;
        this.rawResults = res?.items || [];
        this.mutations = sortCacheItems(this.rawResults, this.sortKey);
        this.count = res?.count || 0;
        this.hasNext = !!res?.hasNext;
        if (res?.cacheCount != null) {
          this.cacheCount = res.cacheCount;
        }
        this.ingestCacheItems(this.mutations);
        if (!this.mutations.length) {
          this.errorMessage = '';
        }
      },
      error: (err) => {
        this.loading = false;
        this.mutations = [];
        this.rawResults = [];
        this.errorMessage = err?.error?.error === 'upstream_unavailable'
          ? 'FONCIER.ERROR_UPSTREAM'
          : 'FONCIER.ERROR';
      }
    });
  }

  private syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        q: this.query.trim() || null,
        type: this.typeLocal || null,
        insee: this.selected?.code || null,
        radius: this.radiusKm > 0 ? String(this.radiusKm) : null,
        source: this.cacheMode !== 'cache' ? this.cacheMode : null,
        sort: this.sortKey !== 'date-desc' ? this.sortKey : null
      },
      replaceUrl: true
    });
  }
}
