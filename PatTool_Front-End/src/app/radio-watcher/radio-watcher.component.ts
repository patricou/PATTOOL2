import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged, catchError } from 'rxjs/operators';
import { of } from 'rxjs';
import Hls from 'hls.js';

import { ApiService, RadioCountry, RadioStation } from '../services/api.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { RadioPlayerService } from '../services/radio-player.service';
import { createTvHlsConfig, tryRecoverTvHlsError } from '../tv-watcher/tv-hls-config';

type RadioListMode = 'catalog' | 'favorites';

@Component({
  selector: 'app-radio-watcher',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './radio-watcher.component.html',
  styleUrls: ['./radio-watcher.component.css']
})
export class RadioWatcherComponent implements OnInit, OnDestroy {
  @ViewChild('mediaEl') mediaEl?: ElementRef<HTMLVideoElement>;

  countries: RadioCountry[] = [];
  stations: RadioStation[] = [];
  tags: string[] = [];
  favorites: RadioStation[] = [];
  favoriteIds = new Set<string>();

  listMode: RadioListMode = 'favorites';
  selectedCountry = 'fr';
  selectedTag = '';
  stationQuery = '';
  selectedStation: RadioStation | null = null;
  worldwideSearchHint = false;
  countryMenuOpen = false;
  countryFilter = '';
  private filtersCollapsedByMode: Record<RadioListMode, boolean> = {
    catalog: true,
    favorites: true
  };

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
  volumePercent = 100;
  isBuffering = false;
  chromeVisible = true;
  shareMenuOpen = false;
  shareFeedback = '';
  readonly canNativeShare =
    typeof navigator !== 'undefined' && typeof (navigator as Navigator).share === 'function';

  catalogTotalCount = 0;
  isLoadingCatalogCount = false;

  private catalogCountSub?: Subscription;
  private hls: Hls | null = null;
  private stationSearch$ = new Subject<string>();
  private stationSearchSub?: Subscription;
  private stationsSub?: Subscription;
  private resumeSub?: Subscription;
  private lastStationSaveSub?: Subscription;
  private restoredLastStation = false;
  private chromeHideTimer: ReturnType<typeof setTimeout> | null = null;
  private shareFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingShareStationId = '';
  private playGeneration = 0;
  private static readonly CHROME_HIDE_MS = 4000;
  private static readonly LAST_STATION_STORAGE_KEY = 'pattool.radio.last-station';
  private static readonly SHARE_STREAM_MAX_LEN = 80;

  constructor(
    private api: ApiService,
    private keycloak: KeycloakService,
    private radioPlayer: RadioPlayerService,
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

  get hasFilterInputs(): boolean {
    if (this.stationQuery.trim()) {
      return true;
    }
    if (this.listMode === 'catalog' && this.selectedTag) {
      return true;
    }
    return false;
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

  get displayedStations(): RadioStation[] {
    const source = this.listMode === 'favorites' ? this.favorites : this.stations;
    const q = this.stationQuery.trim().toLowerCase();
    if (this.listMode === 'favorites' && q) {
      return source.filter((st) => this.matchesStationQuery(st, q));
    }
    return source;
  }

  get filteredStationCount(): number {
    return this.displayedStations.length;
  }

  get catalogTabCount(): number {
    if (this.listMode === 'favorites') {
      return this.filteredStationCount;
    }
    if (this.isAllCountries) {
      const searching = this.stationQuery.trim().length >= 2;
      if (!searching && this.catalogTotalCount > 0) {
        return this.catalogTotalCount;
      }
    }
    return this.filteredStationCount;
  }

  get hasActiveFilters(): boolean {
    if (this.listMode !== 'catalog') {
      return !!this.stationQuery.trim();
    }
    return !!(this.stationQuery.trim() || this.selectedTag || this.isAllCountries);
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
    this.stationSearchSub = this.stationSearch$
      .pipe(debounceTime(280), distinctUntilChanged())
      .subscribe(() => {
        if (this.listMode === 'catalog') {
          this.loadStations();
        } else {
          this.cdr.markForCheck();
        }
      });

    this.resumeSub = this.radioPlayer.resumeOnPage$.subscribe((station) => {
      this.resumePagePlayback(station);
    });
    const pending = this.radioPlayer.consumePendingResume();
    if (pending) {
      this.restoredLastStation = true;
      this.resumePagePlayback(pending);
    }

    this.loadCountries();
    this.loadCatalogCount();
    this.loadStations();
    this.loadFavorites();
    if (!this.tryOpenSharedStationFromQuery()) {
      this.restoreLastPlayedStation();
    }
  }

  ngOnDestroy(): void {
    this.clearChromeHideTimer();
    this.clearShareFeedbackTimer();
    this.stationSearchSub?.unsubscribe();
    this.stationsSub?.unsubscribe();
    this.catalogCountSub?.unsubscribe();
    this.resumeSub?.unsubscribe();
    this.lastStationSaveSub?.unsubscribe();
    this.destroyPlayer();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    let changed = false;
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
    this.showChrome(true);
  }

  onRadioPointerMove(): void {
    if (!this.chromeVisible) {
      this.showChrome(true);
    } else {
      this.scheduleChromeHide();
    }
  }

  onRadioPointerLeave(): void {
    this.scheduleChromeHide(800);
  }

  private showChrome(scheduleHide: boolean): void {
    this.chromeVisible = true;
    this.cdr.markForCheck();
    if (scheduleHide) {
      this.scheduleChromeHide();
    } else {
      this.clearChromeHideTimer();
    }
  }

  private scheduleChromeHide(delayMs = RadioWatcherComponent.CHROME_HIDE_MS): void {
    this.clearChromeHideTimer();
    if (!this.selectedStation || this.isMuted || this.shareMenuOpen) {
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

  toggleFiltersCollapsed(): void {
    this.filtersCollapsedByMode[this.listMode] = !this.filtersCollapsedByMode[this.listMode];
  }

  setListMode(mode: RadioListMode): void {
    if (this.listMode === mode) {
      return;
    }
    this.listMode = mode;
    this.countryMenuOpen = false;
    if (mode === 'catalog' && !this.stations.length && !this.isLoadingStations) {
      this.loadStations();
    }
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
    const next = (code || 'fr').toLowerCase();
    if (this.selectedCountry === next) {
      return;
    }
    this.selectedCountry = next;
    this.selectedTag = '';
    this.loadCatalogCount();
    this.loadStations();
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
    this.loadStations();
  }

  onStationSearchInput(value: string): void {
    this.stationQuery = value || '';
    this.stationSearch$.next(this.stationQuery);
  }

  clearStationSearch(): void {
    this.stationQuery = '';
    this.stationSearch$.next('');
  }

  trackByStationId(_index: number, st: RadioStation): string {
    return st.id || st.streamUrl || String(_index);
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

  selectStation(station: RadioStation): void {
    if (!station) {
      return;
    }
    if (this.isFloatingOpen) {
      this.radioPlayer.setStation(station);
      this.selectedStation = station;
      this.persistLastStation(station);
      this.cdr.markForCheck();
      return;
    }
    this.selectedStation = station;
    this.playError = '';
    this.chromeVisible = true;
    this.persistLastStation(station);
    setTimeout(() => this.playStation(station), 0);
  }

  stopPlayback(): void {
    this.destroyPlayer();
    this.selectedStation = null;
    this.playError = '';
    this.isBuffering = false;
    this.cdr.markForCheck();
  }

  openFloatingWindow(): void {
    if (!this.selectedStation) {
      return;
    }
    const station = this.selectedStation;
    this.destroyPlayer();
    this.radioPlayer.openFloating(station);
    this.cdr.markForCheck();
  }

  closeFloatingWindow(): void {
    this.radioPlayer.close();
  }

  toggleMute(): void {
    const media = this.mediaEl?.nativeElement;
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
    const media = this.mediaEl?.nativeElement;
    const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    this.volumePercent = p;
    if (media) {
      media.volume = p / 100;
      media.muted = p === 0;
      this.isMuted = media.muted;
    }
    this.showChrome(true);
  }

  onMediaVolumeChange(): void {
    const media = this.mediaEl?.nativeElement;
    if (!media) {
      return;
    }
    this.isMuted = !!media.muted;
    this.volumePercent = Math.round((media.muted ? 0 : media.volume) * 100);
    this.cdr.markForCheck();
  }

  ensureSound(event?: Event): void {
    event?.stopPropagation();
    const media = this.mediaEl?.nativeElement;
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
        this.applyFavorites(fav?.stations || []);
        this.favoriteBusyId = this.favoriteBusyId === busyId ? '' : this.favoriteBusyId;
        this.cdr.markForCheck();
      },
      error: () => {
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
    const url = this.buildShareUrl(this.selectedStation);
    const text = this.translate.instant('RADIO.SHARE_TEXT', { name: this.selectedStation.name });
    try {
      await navigator.share({ title: this.selectedStation.name, text, url });
      this.shareMenuOpen = false;
    } catch {
      // user cancelled
    }
  }

  shareWhatsApp(): void {
    if (!this.selectedStation) {
      return;
    }
    const url = this.buildShareUrl(this.selectedStation);
    const text = this.translate.instant('RADIO.SHARE_TEXT', { name: this.selectedStation.name });
    window.open(
      'https://wa.me/?text=' + encodeURIComponent(text + ' ' + url),
      '_blank',
      'noopener'
    );
    this.shareMenuOpen = false;
  }

  async copyShareLink(): Promise<void> {
    if (!this.selectedStation) {
      return;
    }
    const url = this.buildShareUrl(this.selectedStation);
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

  private buildShareUrl(station: RadioStation): string {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const params = new URLSearchParams();
    params.set('station', station.id || '');
    const stream = (station.streamUrl || '').trim();
    if (stream && stream.length <= RadioWatcherComponent.SHARE_STREAM_MAX_LEN) {
      params.set('stream', stream);
    }
    return `${origin}/#/tools/radio-watcher?${params.toString()}`;
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
    this.selectedStation = station;
    this.playError = '';
    setTimeout(() => this.playStation(station), 0);
    this.cdr.markForCheck();
  }

  private loadCountries(): void {
    this.isLoadingCountries = true;
    this.countriesError = '';
    this.api.getRadioCountries().subscribe({
      next: (list) => {
        this.countries = list || [];
        this.isLoadingCountries = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.countriesError = 'RADIO.ERR_COUNTRIES';
        this.isLoadingCountries = false;
        this.cdr.markForCheck();
      }
    });
  }

  private loadCatalogCount(): void {
    this.catalogCountSub?.unsubscribe();
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

  private loadStations(): void {
    this.stationsSub?.unsubscribe();
    this.stationsError = '';
    this.worldwideSearchHint = false;

    if (this.isAllCountries) {
      const q = this.stationQuery.trim();
      if (q.length < 2) {
        this.stations = [];
        this.tags = [];
        this.worldwideSearchHint = true;
        this.isLoadingStations = false;
        this.tryResolvePendingShare();
        this.cdr.markForCheck();
        return;
      }
    }

    this.isLoadingStations = true;
    const q = this.stationQuery.trim() || undefined;
    const tag = this.selectedTag.trim() || undefined;
    this.stationsSub = this.api.getRadioStations(this.selectedCountry, q, tag).subscribe({
      next: (list) => {
        this.stations = list || [];
        this.isLoadingStations = false;
        if (!this.isAllCountries) {
          this.loadTags();
        } else {
          this.tags = [];
        }
        this.tryResolvePendingShare();
        this.cdr.markForCheck();
      },
      error: () => {
        this.stations = [];
        this.stationsError = 'RADIO.ERR_STATIONS';
        this.isLoadingStations = false;
        this.cdr.markForCheck();
      }
    });
  }

  private loadTags(): void {
    this.api.getRadioTags(this.selectedCountry).pipe(catchError(() => of([] as string[]))).subscribe((tags) => {
      this.tags = tags || [];
      this.cdr.markForCheck();
    });
  }

  private loadFavorites(): void {
    if (!this.isLoggedIn) {
      this.favorites = [];
      this.favoriteIds = new Set();
      this.favoritesHint = 'RADIO.FAVORITES_LOGIN';
      return;
    }
    this.isLoadingFavorites = true;
    this.favoritesError = '';
    this.favoritesHint = '';
    this.api.getRadioFavorites().subscribe({
      next: (fav) => {
        this.applyFavorites(fav?.stations || []);
        this.isLoadingFavorites = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.favoritesError = 'RADIO.ERR_FAVORITES_LOAD';
        this.isLoadingFavorites = false;
        this.cdr.markForCheck();
      }
    });
  }

  private applyFavorites(stations: RadioStation[]): void {
    this.favorites = stations || [];
    this.favoriteIds = new Set(this.favorites.map((s) => s.id).filter(Boolean));
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
      if (st) {
        this.pendingShareStationId = '';
        this.selectStation(st);
        this.cdr.markForCheck();
      }
    });
  }

  private restoreLastPlayedStation(): void {
    if (this.restoredLastStation) {
      return;
    }
    const local = this.readLocalLastStation();
    if (local) {
      this.restoredLastStation = true;
      this.selectedStation = local;
      setTimeout(() => this.playStation(local), 0);
    }
    if (this.isLoggedIn) {
      this.api.getRadioLastStation().pipe(catchError(() => of(null))).subscribe((st) => {
        if (st && !this.restoredLastStation) {
          this.restoredLastStation = true;
          this.selectedStation = st;
          setTimeout(() => this.playStation(st), 0);
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

  private playStation(station: RadioStation): void {
    const media = this.mediaEl?.nativeElement;
    if (!media || !station?.streamUrl) {
      return;
    }
    const gen = ++this.playGeneration;
    this.destroyPlayer(false);
    this.playError = '';
    this.isBuffering = true;
    this.cdr.markForCheck();

    const proxyUrl = this.api.radioStreamProxyUrl(station.streamUrl);
    const isHls = this.isHlsStream(station);

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
      media.muted = false;
      this.isMuted = false;
      if (media.volume === 0) {
        media.volume = this.volumePercent / 100 || 1;
      }
      void media.play().then(() => {
        if (gen !== this.playGeneration) {
          return;
        }
        this.isBuffering = false;
        this.cdr.markForCheck();
      }).catch((err: unknown) => {
        if (gen !== this.playGeneration) {
          return;
        }
        const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
        if (name === 'NotAllowedError') {
          media.muted = true;
          this.isMuted = true;
          void media.play().then(() => {
            this.isBuffering = false;
            this.cdr.markForCheck();
          }).catch(() => onError('RADIO.ERR_PLAY'));
          return;
        }
        onError('RADIO.ERR_PLAY');
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
        this.isBuffering = false;
        this.cdr.markForCheck();
      }
    };
    media.onerror = () => onError('RADIO.ERR_MEDIA');

    // HLS (.m3u8) — same path as TV
    if (isHls && Hls.isSupported()) {
      const hls = new Hls(createTvHlsConfig());
      this.hls = hls;
      hls.loadSource(proxyUrl);
      hls.attachMedia(media);
      hls.on(Hls.Events.MANIFEST_PARSED, () => tryPlay());
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          if (!tryRecoverTvHlsError(hls, data)) {
            onError('RADIO.ERR_STREAM');
          }
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

  private destroyPlayer(clearSrc = true): void {
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        // ignore
      }
      this.hls = null;
    }
    const media = this.mediaEl?.nativeElement;
    if (media) {
      media.onwaiting = null;
      media.onplaying = null;
      media.onerror = null;
      try {
        media.pause();
      } catch {
        // ignore
      }
      if (clearSrc) {
        media.removeAttribute('src');
        media.load();
      }
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
