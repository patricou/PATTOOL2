import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

import { ApiService, StellariumConfig, StellariumSkySource } from '../services/api.service';
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

  isLoadingConfig = false;
  isSearching = false;
  errorMessage = '';

  private readonly searchInput$ = new Subject<string>();
  private subscriptions = new Subscription();

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
    iframe?.requestFullscreen?.();
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
}
