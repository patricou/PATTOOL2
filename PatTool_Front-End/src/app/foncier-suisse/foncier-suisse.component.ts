import { Component, HostBinding, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { of, Subject, Subscription } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, map, switchMap } from 'rxjs/operators';

import {
  ApiService,
  FoncierCacheSource,
  FoncierCommune,
  FoncierListing,
  FoncierSuisseChanceScore,
  FoncierSuisseFaq,
  FoncierSuisseGuide
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
} from '../foncier/foncier-cache-query';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import { SheetSelectComponent, SheetSelectOption } from '../shared/sheet-select/sheet-select.component';
import { openWhatsAppTextShare } from '../shared/share-whatsapp-image.util';
import { FoncierMapPoint, FoncierResultsMapComponent } from '../foncier/foncier-results-map.component';

export type FoncierSuisseTab = 'search' | 'popular' | 'chances' | 'guides';

@Component({
  selector: 'app-foncier-suisse',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, TraceViewerModalComponent, SheetSelectComponent, FoncierResultsMapComponent],
  templateUrl: './foncier-suisse.component.html',
  styleUrls: ['../foncier/foncier-shared.css']
})
export class FoncierSuisseComponent implements OnInit, OnDestroy {

  readonly tabs: Array<{ id: FoncierSuisseTab; labelKey: string; icon: string }> = [
    { id: 'search', labelKey: 'FONCIER_SUISSE.TAB_SEARCH', icon: 'fa fa-search' },
    { id: 'popular', labelKey: 'FONCIER_SUISSE.TAB_POPULAR', icon: 'fa fa-star' },
    { id: 'chances', labelKey: 'FONCIER_SUISSE.TAB_CHANCES', icon: 'fa fa-line-chart' },
    { id: 'guides', labelKey: 'FONCIER_SUISSE.TAB_GUIDES', icon: 'fa fa-book' }
  ];
  readonly sourceOptions: FoncierCacheSource[] = ['cache', 'both', 'api'];
  readonly sortOptions = FONCIER_SORT_OPTIONS;
  readonly dealOptions: SheetSelectOption[] = [
    { value: 'rent', labelKey: 'FONCIER_SUISSE.DEAL_RENT', icon: 'fa fa-key' },
    { value: 'sell', labelKey: 'FONCIER_SUISSE.DEAL_SELL', icon: 'fa fa-home' },
    { value: 'serviced', labelKey: 'FONCIER_SUISSE.DEAL_SERVICED', icon: 'fa fa-suitcase' }
  ];
  readonly roomsOptions: SheetSelectOption[] = [
    { value: '', labelKey: 'FONCIER_SUISSE.ROOMS_ANY', icon: 'fa fa-th' },
    { value: 1, labelKey: 'FONCIER_SUISSE.ROOMS_MIN', labelParams: { n: 1 }, icon: 'fa fa-bed' },
    { value: 2, labelKey: 'FONCIER_SUISSE.ROOMS_MIN', labelParams: { n: 2 }, icon: 'fa fa-bed' },
    { value: 3, labelKey: 'FONCIER_SUISSE.ROOMS_MIN', labelParams: { n: 3 }, icon: 'fa fa-bed' },
    { value: 4, labelKey: 'FONCIER_SUISSE.ROOMS_MIN', labelParams: { n: 4 }, icon: 'fa fa-bed' },
    { value: 5, labelKey: 'FONCIER_SUISSE.ROOMS_MIN', labelParams: { n: 5 }, icon: 'fa fa-bed' }
  ];
  readonly sortSelectOptions: SheetSelectOption[] = this.sortOptions.map((key) => ({
    value: key,
    labelKey: sortLabelKey(key),
    icon: key.includes('asc') ? 'fa fa-sort-amount-asc' : 'fa fa-sort-amount-desc'
  }));
  readonly chanceRoomOptions: SheetSelectOption[] = [
    { value: 'rooms_1_5', labelKey: 'FONCIER_SUISSE.CH_ROOMS_15' },
    { value: 'rooms_2_5', labelKey: 'FONCIER_SUISSE.CH_ROOMS_25' },
    { value: 'rooms_3_5', labelKey: 'FONCIER_SUISSE.CH_ROOMS_35' },
    { value: 'rooms_4_5', labelKey: 'FONCIER_SUISSE.CH_ROOMS_45' },
    { value: 'rooms_5_5_plus', labelKey: 'FONCIER_SUISSE.CH_ROOMS_55' }
  ];
  readonly chanceBudgetOptions: SheetSelectOption[] = [
    { value: 'budget_under_1000', labelKey: 'FONCIER_SUISSE.CH_BUDGET_1000' },
    { value: 'budget_1000_1500', labelKey: 'FONCIER_SUISSE.CH_BUDGET_1500' },
    { value: 'budget_1500_2000', labelKey: 'FONCIER_SUISSE.CH_BUDGET_2000' },
    { value: 'budget_2000_2500', labelKey: 'FONCIER_SUISSE.CH_BUDGET_2500' },
    { value: 'budget_2500_3000', labelKey: 'FONCIER_SUISSE.CH_BUDGET_3000' },
    { value: 'budget_3000_3500', labelKey: 'FONCIER_SUISSE.CH_BUDGET_3500' },
    { value: 'budget_3500_4000', labelKey: 'FONCIER_SUISSE.CH_BUDGET_4000' },
    { value: 'budget_over_4000', labelKey: 'FONCIER_SUISSE.CH_BUDGET_5000' },
    { value: 'budget_over_5000', labelKey: 'FONCIER_SUISSE.CH_BUDGET_5000P' }
  ];
  readonly chanceHouseholdOptions: SheetSelectOption[] = [
    { value: 'single', labelKey: 'FONCIER_SUISSE.CH_HH_SINGLE' },
    { value: 'shared_flat', labelKey: 'FONCIER_SUISSE.CH_HH_SHARED' },
    { value: 'couple_no_kids', labelKey: 'FONCIER_SUISSE.CH_HH_COUPLE' },
    { value: 'couple_with_kids', labelKey: 'FONCIER_SUISSE.CH_HH_COUPLE_KIDS' },
    { value: 'family_with_kids', labelKey: 'FONCIER_SUISSE.CH_HH_FAMILY' }
  ];
  readonly chanceTimeOptions: SheetSelectOption[] = [
    { value: 'asap', labelKey: 'FONCIER_SUISSE.CH_TIME_ASAP' },
    { value: 'within_3_months', labelKey: 'FONCIER_SUISSE.CH_TIME_3' },
    { value: 'within_6_months', labelKey: 'FONCIER_SUISSE.CH_TIME_6' },
    { value: 'within_12_months', labelKey: 'FONCIER_SUISSE.CH_TIME_12' },
    { value: 'browsing', labelKey: 'FONCIER_SUISSE.CH_TIME_BROWSE' }
  ];

  tab: FoncierSuisseTab = 'search';
  query = '';
  deal = 'rent';
  roomsMin: number | '' = '';
  priceMin = '';
  priceMax = '';
  surfaceMin = '';
  cacheMode: FoncierCacheSource = 'both';
  sortKey: FoncierSortKey = 'date-desc';
  cacheCount = 0;
  clearingCache = false;
  communes: FoncierCommune[] = [];
  selected: FoncierCommune | null = null;
  communeActiveIndex = -1;
  listings: FoncierListing[] = [];
  private fullListings: FoncierListing[] = [];
  count = 0;
  page = 1;
  hasNext = false;
  chanceRooms = 'rooms_2_5';
  chanceBudget = 'budget_2000_2500';
  chanceHousehold = 'single';
  chanceTime = 'asap';
  chanceWorkplace = '';
  chanceScores: FoncierSuisseChanceScore[] = [];
  chanceAnalysis = '';
  chanceBudgetHint = '';
  chanceAltHint = '';
  guidesQuery = '';
  guides: FoncierSuisseGuide[] = [];
  openGuide: FoncierSuisseGuide | null = null;
  faqs: FoncierSuisseFaq[] = [];
  openFaqId: number | null = null;

  searchingCommunes = false;
  loading = false;
  searched = false;
  locating = false;
  errorMessage = '';
  geocodingKey = '';
  selectedMapId: string | null = null;
  filtersCollapsed = false;
  resultsCollapsed = false;
  private cacheItems: FoncierCacheRow[] = [];
  private localCacheReady = false;
  private cacheLoadPending = true;
  private readonly brokenPhotos = new Set<string>();
  private readonly proxiedPhotos = new Set<string>();

  @HostBinding('class.foncier-suisse-search') get isSearch(): boolean { return this.tab === 'search'; }
  @HostBinding('class.foncier-suisse-popular') get isPopular(): boolean { return this.tab === 'popular'; }
  @HostBinding('class.foncier-suisse-chances') get isChances(): boolean { return this.tab === 'chances'; }
  @HostBinding('class.foncier-suisse-guides') get isGuides(): boolean { return this.tab === 'guides'; }

  get titleIcon(): string {
    return this.tabs.find((tab) => tab.id === this.tab)?.icon || 'fa fa-home';
  }

  get providerLabelKey(): string {
    return this.tabs.find((tab) => tab.id === this.tab)?.labelKey || 'FONCIER_SUISSE.TAB_SEARCH';
  }

  get emptyKey(): string {
    if (this.tab === 'popular') {
      return 'FONCIER_SUISSE.POPULAR_EMPTY';
    }
    if (this.tab === 'chances') {
      return 'FONCIER_SUISSE.CHANCES_EMPTY';
    }
    if (this.tab === 'guides') {
      return 'FONCIER_SUISSE.GUIDES_EMPTY';
    }
    return 'FONCIER_SUISSE.SEARCH_EMPTY';
  }

  get hasResults(): boolean {
    if (this.tab === 'chances') {
      return this.chanceScores.length > 0;
    }
    if (this.tab === 'guides') {
      return this.guides.length > 0 || this.faqs.length > 0;
    }
    return this.listings.length > 0;
  }

  get pageSize(): number {
    return 20;
  }

  get pageCount(): number {
    return Math.max(1, Math.ceil((this.count || 0) / this.pageSize));
  }

  get showPager(): boolean {
    return this.isListingsTab && this.hasResults && (this.page > 1 || this.hasNext || this.pageCount > 1);
  }

  get showResultsMap(): boolean {
    return this.isListingsTab && this.searched && (this.mapPoints.length > 0 || this.hasCoords(this.selected));
  }

  get mapPoints(): FoncierMapPoint[] {
    return this.listings.reduce<FoncierMapPoint[]>((points, listing, index) => {
      if (!this.hasCoords(listing)) {
        return points;
      }
      points.push({
        id: this.mapItemId(listing, index),
        lat: listing.lat as number,
        lon: listing.lon as number,
        label: this.mapPointLabel(listing),
        number: this.itemNumber(index)
      });
      return points;
    }, []);
  }

  get canGoNext(): boolean {
    return !this.loading && (this.hasNext || this.page < this.pageCount);
  }

  get isListingsTab(): boolean {
    return this.tab === 'search' || this.tab === 'popular';
  }

  @ViewChild(TraceViewerModalComponent) traceViewer?: TraceViewerModalComponent;

  private static readonly DEFAULT_MAP_LAT = 46.8182;
  private static readonly DEFAULT_MAP_LNG = 8.2275;

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
    private router: Router,
    private translate: TranslateService
  ) {}

  ngOnInit(): void {
    const params = this.route.snapshot.queryParamMap;
    const dataTab = this.route.snapshot.data['tab'] as string | undefined;
    this.tab = this.parseTab(params.get('tab') || dataTab);
    this.query = (params.get('q') || '').trim();
    this.deal = this.parseDeal(params.get('deal'));
    this.roomsMin = this.parseRooms(params.get('rooms'));
    this.priceMin = params.get('priceMin') || '';
    this.priceMax = params.get('priceMax') || '';
    this.surfaceMin = params.get('surfaceMin') || '';
    this.cacheMode = this.parseSource(params.get('source'));
    this.sortKey = parseFoncierSort(params.get('sort'));
    this.chanceRooms = params.get('chRooms') || this.chanceRooms;
    this.chanceBudget = params.get('chBudget') || this.chanceBudget;
    this.chanceHousehold = params.get('chHh') || this.chanceHousehold;
    this.chanceTime = params.get('chTime') || this.chanceTime;

    this.subs.push(
      this.query$.pipe(debounceTime(300), distinctUntilChanged()).subscribe((value) => {
        const q = value.trim();
        if (q.length >= 2 && !this.selected) {
          this.lookupPlaces(q);
        } else if (!this.selected) {
          this.communes = [];
          this.communeActiveIndex = -1;
        }
      })
    );

    if (this.query.length >= 2) {
      this.lookupPlaces(this.query);
    }
    this.refreshCacheCount();
  }

  ngOnDestroy(): void {
    this.communeSub?.unsubscribe();
    this.resultSub?.unsubscribe();
    this.positionSub?.unsubscribe();
    this.subs.forEach((s) => s.unsubscribe());
  }

  setTab(next: FoncierSuisseTab): void {
    if (this.tab === next) {
      return;
    }
    this.resultSub?.unsubscribe();
    this.tab = next;
    this.listings = [];
    this.fullListings = [];
    this.count = 0;
    this.hasNext = false;
    this.page = 1;
    this.searched = false;
    this.loading = false;
    this.errorMessage = '';
    this.chanceScores = [];
    this.chanceAnalysis = '';
    this.openGuide = null;
    this.syncUrlIfChanged();
    if (next === 'popular') {
      this.runSearch(1);
    } else if (next === 'guides') {
      this.loadGuides();
    }
  }

  onQueryChanged(): void {
    this.selected = null;
    this.errorMessage = '';
    this.query$.next(this.query);
    this.syncUrlIfChanged();
    this.listings = [];
    this.fullListings = [];
    this.searched = false;
    if (this.query.trim().length < 2) {
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
      default:
        break;
    }
  }

  submitSearch(): void {
    if (this.tab === 'chances') {
      this.loadChances();
      return;
    }
    if (this.tab === 'guides') {
      this.loadGuides();
      return;
    }
    if (this.tab === 'popular') {
      this.runSearch(1);
      return;
    }
    const q = this.query.trim();
    if (!q) {
      return;
    }
    if (this.communes.length && !this.selected) {
      this.pickCommune(this.communes[this.communeActiveIndex] ?? this.communes[0]);
      return;
    }
    this.runSearch(1);
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
            this.errorMessage = 'FONCIER_SUISSE.GEO_DENIED';
            return;
          }
          this.applyMyPosition(hit.gps.latitude, hit.gps.longitude, hit.geo);
        });
      },
      error: () => {
        this.ngZone.run(() => {
          this.locating = false;
          this.errorMessage = 'FONCIER_SUISSE.GEO_DENIED';
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
      : FoncierSuisseComponent.DEFAULT_MAP_LAT;
    const lon = Number.isFinite(this.selected?.lon)
      ? this.selected!.lon as number
      : FoncierSuisseComponent.DEFAULT_MAP_LNG;
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
    this.resultSub?.unsubscribe();
    this.query = '';
    this.deal = 'rent';
    this.roomsMin = '';
    this.priceMin = '';
    this.priceMax = '';
    this.surfaceMin = '';
    this.sortKey = 'date-desc';
    this.communes = [];
    this.selected = null;
    this.listings = [];
    this.fullListings = [];
    this.count = 0;
    this.hasNext = false;
    this.page = 1;
    this.searched = false;
    this.errorMessage = '';
    this.selectedMapId = null;
    this.chanceScores = [];
    this.guidesQuery = '';
    this.guides = [];
    this.faqs = [];
    this.openGuide = null;
    this.syncUrlIfChanged();
  }

  onFilterChanged(): void {
    if (this.tab === 'search' && (this.selected || this.query.trim().length >= 2)) {
      this.runSearch(1);
    } else if (this.tab === 'popular') {
      this.runSearch(1);
    }
  }

  onSortChanged(): void {
    this.fullListings = sortCacheItems(this.fullListings, this.sortKey);
    this.page = 1;
    this.applyPageSlice();
    this.syncUrlIfChanged();
  }

  setCacheMode(mode: FoncierCacheSource): void {
    if (this.cacheMode === mode) {
      return;
    }
    this.cacheMode = mode;
    this.syncUrlIfChanged();
    if (this.tab === 'popular' || this.selected || this.query.trim().length >= 2) {
      this.runSearch(1);
    }
  }

  clearCache(): void {
    if (this.clearingCache) {
      return;
    }
    this.clearingCache = true;
    this.api.clearFoncierSuisseCache().subscribe({
      next: (res) => {
        this.clearingCache = false;
        this.cacheItems = [];
        this.localCacheReady = true;
        this.cacheCount = res?.count ?? 0;
        if (this.searched) {
          this.runSearch(this.page);
        }
      },
      error: () => {
        this.clearingCache = false;
        this.errorMessage = 'FONCIER_SUISSE.ERROR';
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
    if (text) {
      openWhatsAppTextShare(text);
    }
  }

  formatPrice(value: number | null | undefined): string {
    if (value == null || Number.isNaN(value)) {
      return '—';
    }
    return new Intl.NumberFormat(this.numberLocale(), {
      style: 'currency',
      currency: 'CHF',
      maximumFractionDigits: 0
    }).format(value);
  }

  formatNumber(value: number | null | undefined, suffix = ''): string {
    if (value == null || Number.isNaN(value)) {
      return '—';
    }
    return new Intl.NumberFormat(this.numberLocale(), { maximumFractionDigits: 1 }).format(value) + suffix;
  }

  dealLabel(listing: FoncierListing): string {
    const key = listing.priceType || listing.type || this.deal;
    if (key === 'sell') {
      return this.translate.instant('FONCIER_SUISSE.DEAL_SELL');
    }
    if (key === 'serviced') {
      return this.translate.instant('FONCIER_SUISSE.DEAL_SERVICED');
    }
    return this.translate.instant('FONCIER_SUISSE.DEAL_RENT');
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

  canOpenMap(row: { lat?: number; lon?: number; address?: string; city?: string; zipcode?: string }): boolean {
    return this.hasCoords(row) || !!(row.address || row.city || row.zipcode || this.selected);
  }

  openListingMap(listing: FoncierListing): void {
    const label = [listing.title, listing.address, listing.city, listing.zipcode].filter(Boolean).join(' · ');
    this.openInTraceViewer(listing, label, [listing.address, listing.city, listing.zipcode, this.selected?.nom], listing.zipcode);
  }

  onMapPointSelect(id: string): void {
    this.selectedMapId = id;
    const el = document.querySelector(`[data-foncier-id="${CSS.escape(id)}"]`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  toggleFiltersCollapsed(): void {
    this.filtersCollapsed = !this.filtersCollapsed;
  }

  toggleResultsCollapsed(): void {
    this.resultsCollapsed = !this.resultsCollapsed;
  }

  mapItemId(item: { id?: string; url?: string; address?: string; lat?: number; lon?: number }, index: number): string {
    return item.id || item.url || `${index}-${item.lat}-${item.lon}-${item.address || ''}`;
  }

  private mapPointLabel(listing: FoncierListing): string {
    const title = (listing.title || listing.address || '').trim();
    const price = listing.price != null ? this.formatPrice(listing.price) : '';
    return [title, price].filter(Boolean).join(' · ') || this.selected?.nom || '';
  }

  parseSource(value: string | null): FoncierCacheSource {
    return this.sourceOptions.includes(value as FoncierCacheSource)
      ? (value as FoncierCacheSource)
      : 'both';
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

  communeMeta(commune: FoncierCommune): string {
    const zip = commune.codesPostaux?.[0] || '';
    return [zip, commune.departement].filter(Boolean).join(' · ');
  }

  itemNumber(index: number): number {
    return (this.page - 1) * this.pageSize + index + 1;
  }

  scoreWidth(score?: number): string {
    const n = Math.max(0, Math.min(100, score ?? 0));
    return n + '%';
  }

  openGuideBody(guide: FoncierSuisseGuide): void {
    if (!guide.slug) {
      return;
    }
    if (this.openGuide?.slug === guide.slug && this.openGuide.md_body) {
      this.openGuide = null;
      return;
    }
    this.loading = true;
    this.api.getFoncierSuisseGuide(guide.slug, this.locale()).subscribe({
      next: (res) => {
        this.loading = false;
        this.openGuide = res || guide;
      },
      error: () => {
        this.loading = false;
        this.openGuide = guide;
      }
    });
  }

  toggleFaq(faq: FoncierSuisseFaq): void {
    this.openFaqId = this.openFaqId === faq.id ? null : (faq.id ?? null);
  }

  private locale(): string {
    const lang = (this.translate.currentLang || '').toLowerCase();
    return lang.startsWith('de') ? 'de' : 'en';
  }

  private numberLocale(): string {
    const lang = (this.translate.currentLang || 'fr').replace('_', '-');
    return lang.startsWith('de') ? 'de-CH' : 'fr-CH';
  }

  private parseTab(raw: string | null | undefined): FoncierSuisseTab {
    if (raw === 'popular' || raw === 'chances' || raw === 'guides' || raw === 'search') {
      return raw;
    }
    return 'search';
  }

  private parseDeal(raw: string | null): string {
    return raw === 'sell' || raw === 'serviced' || raw === 'rent' ? raw : 'rent';
  }

  private parseRooms(raw: string | null): number | '' {
    const n = parseInt(raw || '', 10);
    return n >= 1 && n <= 5 ? n : '';
  }

  private hasCoords(item?: { lat?: number; lon?: number } | null): boolean {
    return Number.isFinite(item?.lat) && Number.isFinite(item?.lon);
  }

  private photoKey(listing: FoncierListing): string {
    return listing.id || listing.photo || listing.url || listing.title || '';
  }

  private listingShareText(listing: FoncierListing): string {
    const facts = [
      this.dealLabel(listing),
      listing.price != null ? this.formatPrice(listing.price) : '',
      listing.surface != null ? this.formatNumber(listing.surface, ' m²') : '',
      listing.rooms != null ? this.formatNumber(listing.rooms) + ' p.' : ''
    ].filter(Boolean);
    const place = (listing.address || '').trim()
      || [listing.zipcode, listing.city].filter(Boolean).join(' ').trim();
    const lines = [(listing.title || '').trim(), facts.join(' · '), place].filter(Boolean);
    if (listing.url) {
      lines.push('', listing.url);
    }
    return lines.join('\n');
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
      this.errorMessage = 'FONCIER_SUISSE.GEOCODE_FAILED';
      return;
    }
    this.geocodingKey = item.id || query;
    this.api.geocodeFoncierSuissePlace(query, postcode).subscribe({
      next: (hit) => {
        this.geocodingKey = '';
        if (!this.hasCoords(hit)) {
          this.errorMessage = 'FONCIER_SUISSE.GEOCODE_FAILED';
          return;
        }
        item.lat = hit.lat;
        item.lon = hit.lon;
        this.traceViewer?.openAtLocation(hit.lat as number, hit.lon as number, hit.label || label);
      },
      error: () => {
        this.geocodingKey = '';
        this.errorMessage = 'FONCIER_SUISSE.GEOCODE_FAILED';
      }
    });
  }

  private lookupPlaces(value: string, fromSubmit = false): void {
    this.communeSub?.unsubscribe();
    this.searchingCommunes = true;
    this.communeSub = this.api.searchFoncierSuissePlaces(value.trim()).subscribe({
      next: (res) => {
        let items = res?.items || [];
        if (!items.length && this.cacheMode === 'cache' && this.localCacheReady) {
          items = placesFromCache(this.cacheItems, value);
        }
        this.communes = items;
        this.communeActiveIndex = items.length ? 0 : -1;
        this.searchingCommunes = false;
        if (fromSubmit && items.length === 0) {
          this.errorMessage = 'FONCIER_SUISSE.NO_PLACE';
        }
      },
      error: () => {
        this.searchingCommunes = false;
        this.errorMessage = fromSubmit ? 'FONCIER_SUISSE.NO_PLACE' : 'FONCIER_SUISSE.ERROR';
      }
    });
  }

  private runSearch(_page: number): void {
    if (this.cacheMode === 'cache' && this.cacheLoadPending) {
      this.searched = true;
      this.page = 1;
      return;
    }
    if (this.cacheMode === 'cache' && this.localCacheReady) {
      this.applyLocalSearch();
      return;
    }
    this.loadListings();
  }

  private loadListings(): void {
    this.resultSub?.unsubscribe();
    this.loading = true;
    this.searched = true;
    this.errorMessage = '';
    this.page = 1;
    this.fullListings = [];
    this.syncUrlIfChanged();
    if (this.tab === 'popular') {
      this.resultSub = this.api.getFoncierSuissePopular({ locale: this.locale(), source: this.cacheMode }).subscribe({
        next: (res) => this.finalizeListings(res?.items || [], res?.count, res?.cacheCount),
        error: (err) => this.failListings(err)
      });
      return;
    }
    this.fetchListingPage(1);
  }

  private fetchListingPage(page: number): void {
    this.resultSub = this.api.searchFoncierSuisseListings({
      q: this.selected?.nom || this.query.trim(),
      type: this.deal,
      priceMin: this.toInt(this.priceMin),
      priceMax: this.toInt(this.priceMax),
      surfaceMin: this.toInt(this.surfaceMin),
      roomsMin: this.roomsMin === '' ? undefined : this.roomsMin,
      zip: this.selected?.codesPostaux?.[0],
      page,
      locale: this.locale(),
      source: page > 1 && this.cacheMode === 'both' ? 'api' : this.cacheMode
    }).subscribe({
      next: (res) => {
        const incoming = res?.items || [];
        this.pushUnique(this.fullListings, incoming);
        this.count = Math.max(res?.count ?? 0, this.fullListings.length);
        if (res?.cacheCount != null) {
          this.cacheCount = res.cacheCount;
        }
        const more = !!res?.hasNext && incoming.length > 0 && page < 10 && this.fullListings.length < this.count;
        if (more) {
          this.fetchListingPage(page + 1);
          return;
        }
        this.finalizeListings(this.fullListings, this.count, this.cacheCount);
      },
      error: (err) => {
        if (this.fullListings.length) {
          this.finalizeListings(this.fullListings, this.fullListings.length, this.cacheCount);
          return;
        }
        this.failListings(err);
      }
    });
  }

  private finalizeListings(items: FoncierListing[], count?: number, cacheCount?: number): void {
    this.loading = false;
    this.fullListings = sortCacheItems(items, this.sortKey);
    this.count = count ?? this.fullListings.length;
    if (cacheCount != null) {
      this.cacheCount = cacheCount;
    }
    this.ingestCacheItems(this.fullListings);
    this.page = 1;
    this.applyPageSlice();
  }

  private failListings(err: { error?: { error?: string } }): void {
    this.loading = false;
    this.listings = [];
    this.fullListings = [];
    this.count = 0;
    this.errorMessage = err?.error?.error === 'upstream_unavailable'
      ? 'FONCIER_SUISSE.ERROR_UPSTREAM'
      : 'FONCIER_SUISSE.ERROR';
  }

  private pushUnique(target: FoncierListing[], items: FoncierListing[]): void {
    const seen = new Set(target.map((item) => item.id || item.url || item.title || ''));
    for (const item of items) {
      const key = item.id || item.url || item.title || '';
      if (key && seen.has(key)) {
        continue;
      }
      if (key) {
        seen.add(key);
      }
      target.push(item);
    }
  }

  private loadChances(): void {
    const location = (this.selected?.nom || this.query).trim();
    if (!location) {
      this.errorMessage = 'FONCIER_SUISSE.CHANCES_EMPTY';
      return;
    }
    this.resultSub?.unsubscribe();
    this.loading = true;
    this.searched = true;
    this.errorMessage = '';
    this.syncUrlIfChanged();
    this.resultSub = this.api.getFoncierSuisseChances({
      location,
      rooms: this.chanceRooms,
      budget: this.chanceBudget,
      household: this.chanceHousehold,
      timeframe: this.chanceTime,
      workplace: this.chanceWorkplace.trim() || undefined,
      locale: this.locale()
    }).subscribe({
      next: (res) => {
        this.loading = false;
        this.chanceScores = res?.scores || [];
        this.chanceAnalysis = res?.analysis_text || '';
        this.chanceBudgetHint = res?.highlight_budget || '';
        this.chanceAltHint = res?.highlight_alternative || '';
      },
      error: () => {
        this.loading = false;
        this.chanceScores = [];
        this.errorMessage = 'FONCIER_SUISSE.ERROR_UPSTREAM';
      }
    });
  }

  private loadGuides(): void {
    this.resultSub?.unsubscribe();
    this.loading = true;
    this.searched = true;
    this.errorMessage = '';
    const q = this.guidesQuery.trim();
    this.resultSub = this.api.getFoncierSuisseGuides(q || undefined, this.locale()).subscribe({
      next: (res) => {
        this.guides = res?.guides || [];
        this.api.getFoncierSuisseFaqs(q || undefined, this.locale()).subscribe({
          next: (faqs) => {
            this.loading = false;
            this.faqs = faqs?.faqs || [];
          },
          error: () => {
            this.loading = false;
            this.faqs = [];
          }
        });
      },
      error: () => {
        this.loading = false;
        this.guides = [];
        this.errorMessage = 'FONCIER_SUISSE.ERROR_UPSTREAM';
      }
    });
  }

  private refreshCacheCount(): void {
    this.api.getFoncierSuisseCache().subscribe({
      next: (res) => {
        this.cacheItems = (res?.items || []) as FoncierCacheRow[];
        this.localCacheReady = Array.isArray(res?.items);
        this.cacheLoadPending = false;
        this.cacheCount = res?.count ?? this.cacheItems.length;
        if (this.tab === 'popular') {
          this.runSearch(1);
        } else if (this.tab === 'guides') {
          this.loadGuides();
        } else if (this.cacheMode === 'cache' && this.selected) {
          this.runSearch(1);
        }
      },
      error: () => {
        this.localCacheReady = false;
        this.cacheLoadPending = false;
        if (this.tab === 'popular') {
          this.runSearch(1);
        } else if (this.tab === 'guides') {
          this.loadGuides();
        }
      }
    });
  }

  private ingestCacheItems(items: FoncierCacheRow[] | undefined): void {
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

  private applyLocalSearch(): void {
    this.loading = false;
    this.searched = true;
    this.errorMessage = '';
    this.page = 1;
    const matched = filterCacheItems(this.cacheItems, {
      q: this.query.trim(),
      zip: this.selected?.codesPostaux?.[0],
      type: this.tab === 'search' ? this.deal : '',
      priceMin: this.toInt(this.priceMin),
      priceMax: this.toInt(this.priceMax),
      surfaceMin: this.toInt(this.surfaceMin),
      lat: this.selected?.lat,
      lon: this.selected?.lon
    });
    this.fullListings = sortCacheItems(matched, this.sortKey) as FoncierListing[];
    this.applyPageSlice();
    this.syncUrlIfChanged();
  }

  private applyPageSlice(): void {
    this.selectedMapId = null;
    const from = (this.page - 1) * this.pageSize;
    const to = from + this.pageSize;
    this.listings = this.fullListings.slice(from, to);
    this.count = this.fullListings.length;
    this.hasNext = to < this.fullListings.length;
  }

  private applyPickedMapLocation(lat: number, lon: number): void {
    this.locating = true;
    this.positionSub?.unsubscribe();
    this.positionSub = this.api.geocodeReverse(lat, lon).pipe(catchError(() => of(null))).subscribe({
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
    this.query = parsed.city || parsed.label;
    this.communes = [];
    const fallback: FoncierCommune = {
      code: parsed.postcode || '',
      nom: parsed.city || parsed.label,
      codesPostaux: parsed.postcode ? [parsed.postcode] : [],
      lat,
      lon
    };
    if (!parsed.city && !parsed.postcode) {
      this.selected = fallback;
      this.runSearch(1);
      return;
    }
    this.communeSub?.unsubscribe();
    this.communeSub = this.api.searchFoncierSuissePlaces(parsed.postcode || parsed.city).subscribe({
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
        this.query = this.selected.nom;
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
    const city = String(addr['city'] || addr['town'] || addr['village'] || addr['municipality'] || '').trim();
    const postcode = String(addr['postcode'] || '').replace(/\D/g, '').slice(0, 4);
    const display = String(root['displayName'] || root['display_name'] || '').trim();
    const label = [postcode, city].filter(Boolean).join(' ')
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
      tab: this.tab,
      q: this.query.trim() || null,
      deal: this.deal !== 'rent' ? this.deal : null,
      rooms: this.roomsMin === '' ? null : String(this.roomsMin),
      priceMin: this.priceMin || null,
      priceMax: this.priceMax || null,
      surfaceMin: this.surfaceMin || null,
      source: this.cacheMode !== 'both' ? this.cacheMode : null,
      sort: this.sortKey !== 'date-desc' ? this.sortKey : null,
      chRooms: this.tab === 'chances' && this.chanceRooms !== 'rooms_2_5' ? this.chanceRooms : null,
      chBudget: this.tab === 'chances' && this.chanceBudget !== 'budget_2000_2500' ? this.chanceBudget : null,
      chHh: this.tab === 'chances' && this.chanceHousehold !== 'single' ? this.chanceHousehold : null,
      chTime: this.tab === 'chances' && this.chanceTime !== 'asap' ? this.chanceTime : null
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
