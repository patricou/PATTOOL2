import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { of, Subject, Subscription } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged } from 'rxjs/operators';

import { ApiService, SkyMapPreview, StellariumConfig, StellariumSkySource } from '../services/api.service';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';

@Component({
  selector: 'app-ciel',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, NavigationButtonsModule],
  templateUrl: './ciel.component.html',
  styleUrls: ['./ciel.component.css']
})
export class CielComponent implements OnInit, OnDestroy {

  config: StellariumConfig | null = null;
  viewerUrl: SafeResourceUrl | null = null;

  lat = 48.8566;
  lon = 2.3522;
  placeLabel = '';

  searchQuery = '';
  searchResults: StellariumSkySource[] = [];
  selectedSource: StellariumSkySource | null = null;
  skyMapPreview: SkyMapPreview | null = null;
  skyMapImageUrl: string | null = null;
  skyMapEmbedUrl: SafeResourceUrl | null = null;
  isLoadingSkyMap = false;

  isLoadingConfig = false;
  isSearching = false;
  errorMessage = '';

  private readonly searchInput$ = new Subject<string>();
  private subscriptions = new Subscription();
  private skyMapSub: Subscription | null = null;

  constructor(
    private readonly api: ApiService,
    private readonly sanitizer: DomSanitizer
  ) {}

  ngOnInit(): void {
    this.subscriptions.add(
      this.searchInput$.pipe(debounceTime(350), distinctUntilChanged()).subscribe(q => this.runSearch(q))
    );
    this.loadConfig();
  }

  ngOnDestroy(): void {
    this.skyMapSub?.unsubscribe();
    this.subscriptions.unsubscribe();
  }

  loadConfig(lat?: number, lon?: number): void {
    this.isLoadingConfig = true;
    this.errorMessage = '';
    this.subscriptions.add(
      this.api.getStellariumConfig(lat, lon).subscribe({
        next: cfg => {
          this.config = cfg;
          this.lat = cfg.lat;
          this.lon = cfg.lon;
          this.placeLabel = cfg.placeLabel ?? '';
          this.updateViewerUrl(cfg.embedUrl);
          this.isLoadingConfig = false;
        },
        error: () => {
          this.errorMessage = 'CIEL.ERROR_CONFIG';
          this.isLoadingConfig = false;
        }
      })
    );
  }

  onSearchInput(): void {
    this.searchInput$.next(this.searchQuery.trim());
  }

  searchNow(): void {
    this.runSearch(this.searchQuery.trim());
  }

  selectResult(source: StellariumSkySource): void {
    this.selectedSource = source;
    this.searchQuery = source.short_name || source.match || this.searchQuery;
    this.searchResults = [];
    this.loadSkyMapPreview(source);
  }

  applyLocation(): void {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      this.errorMessage = 'CIEL.ERROR_COORDS';
      return;
    }
    this.loadConfig(this.lat, this.lon);
  }

  useMyLocation(): void {
    this.isLoadingConfig = true;
    this.errorMessage = '';
    this.subscriptions.add(
      this.api.getLocationByIp().subscribe({
        next: loc => {
          if (loc.status === 'success' && loc.lat != null && loc.lon != null) {
            this.loadConfig(loc.lat, loc.lon);
          } else {
            this.errorMessage = 'CIEL.ERROR_GEO';
            this.isLoadingConfig = false;
          }
        },
        error: () => {
          this.errorMessage = 'CIEL.ERROR_GEO';
          this.isLoadingConfig = false;
        }
      })
    );
  }

  openFullscreen(): void {
    const iframe = document.getElementById('ciel-stellarium-frame') as HTMLIFrameElement | null;
    this.requestElementFullscreen(iframe);
  }

  openSkyMapFullscreen(): void {
    const wrap = document.getElementById('ciel-skymap-wrap');
    this.requestElementFullscreen(wrap);
  }

  openSkyMapApp(): void {
    const query = (this.skyMapPreview?.name || this.skyMapPreview?.catalogId
      || this.selectedSource?.short_name || this.selectedSource?.match || '').trim();
    const fallback = this.skyMapPreview?.atlasUrl
      || ('https://www.sky-map.org/?' + new URLSearchParams({
        ...(query ? { object: query } : {}),
        zoom: '4',
        img_source: 'DSS2'
      }).toString());
    const android = /Android/i.test(navigator.userAgent || '');
    if (android && query) {
      window.location.href = 'intent://search#Intent;scheme=http;action=android.intent.action.SEARCH;'
        + 'package=com.google.android.stardroid;S.query=' + encodeURIComponent(query)
        + ';S.browser_fallback_url=' + encodeURIComponent(fallback) + ';end';
      return;
    }
    window.open(fallback, '_blank', 'noopener,noreferrer');
  }

  private requestElementFullscreen(el: HTMLElement | null): void {
    if (!el) {
      return;
    }
    const req = el.requestFullscreen
      || (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen;
    void req?.call(el);
  }

  private runSearch(query: string): void {
    if (query.length < 2) {
      this.searchResults = [];
      return;
    }
    this.isSearching = true;
    this.errorMessage = '';
    this.subscriptions.add(
      this.api.searchStellariumSkySources(query).subscribe({
        next: results => {
          this.searchResults = results;
          this.isSearching = false;
        },
        error: () => {
          this.searchResults = [];
          this.isSearching = false;
          this.errorMessage = 'CIEL.ERROR_SEARCH';
        }
      })
    );
  }

  private updateViewerUrl(url: string): void {
    const withCacheBust = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
    this.viewerUrl = this.sanitizer.bypassSecurityTrustResourceUrl(withCacheBust);
  }

  private loadSkyMapPreview(source: StellariumSkySource): void {
    this.skyMapSub?.unsubscribe();
    this.skyMapPreview = null;
    this.skyMapImageUrl = null;
    this.skyMapEmbedUrl = null;
    if (!this.isSkyMapEligible(source)) {
      this.isLoadingSkyMap = false;
      return;
    }
    const q = (source.short_name || source.match || '').trim();
    const raDeg = this.asFiniteNumber(source.model_data?.ra);
    const deDeg = this.asFiniteNumber(source.model_data?.de);
    const dimx = this.asFiniteNumber(source.model_data?.['dimx']);
    let angle: number | undefined;
    if (dimx != null && dimx > 0) {
      angle = Math.min(12, Math.max(0.4, (dimx / 60) * 1.6));
    }
    if (!q && (raDeg == null || deDeg == null)) {
      this.isLoadingSkyMap = false;
      return;
    }
    this.isLoadingSkyMap = true;
    this.skyMapSub = this.api.getSkyMapPreview({
      q: q || undefined,
      raHours: raDeg != null ? raDeg / 15 : undefined,
      deDeg: deDeg ?? undefined,
      angle,
      width: 400,
      height: 400
    }).pipe(
      catchError(() => of(null))
    ).subscribe(preview => {
      this.skyMapPreview = preview;
      this.skyMapImageUrl = this.api.skyMapImageSrc(preview);
      const embed = this.api.skyMapEmbedSrc(preview);
      this.skyMapEmbedUrl = embed
        ? this.sanitizer.bypassSecurityTrustResourceUrl(embed)
        : null;
      this.isLoadingSkyMap = false;
    });
  }

  private isSkyMapEligible(source: StellariumSkySource): boolean {
    const model = (source.model || '').toLowerCase();
    if (/tle|satellite/.test(model)) {
      return false;
    }
    const types = (source.types || []).map(t => (t || '').toLowerCase());
    if (types.includes('asa')) {
      return false;
    }
    const name = (source.short_name || source.match || '').trim();
    return !/^sun\b/i.test(name);
  }

  private asFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
}
