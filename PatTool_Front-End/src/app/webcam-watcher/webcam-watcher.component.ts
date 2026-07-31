import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

import {
  ApiService,
  WebcamCodeLabel,
  WebcamItem,
  WebcamSearchPage
} from '../services/api.service';

type PlayerMode = 'day' | 'live' | 'month' | 'image';

@Component({
  selector: 'app-webcam-watcher',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './webcam-watcher.component.html',
  styleUrls: ['./webcam-watcher.component.css']
})
export class WebcamWatcherComponent implements OnInit, OnDestroy {
  continent = 'EU';
  country = '';
  category = '';
  sortKey: 'popularity' | 'createdOn' = 'popularity';
  nearbyRadiusKm = 100;
  useNearby = false;
  nearbyLat: number | null = null;
  nearbyLon: number | null = null;
  geoError = '';

  continents: WebcamCodeLabel[] = [];
  countries: WebcamCodeLabel[] = [];
  categories: WebcamCodeLabel[] = [];

  items: WebcamItem[] = [];
  total = 0;
  offset = 0;
  readonly pageSize = 24;

  selected: WebcamItem | null = null;
  selectedId = '';
  playerMode: PlayerMode = 'day';
  playerUrl: SafeResourceUrl | null = null;
  iframeGen = 0;

  isLoading = false;
  isLoadingMeta = false;
  isLoadingDetail = false;
  listError = '';
  configured = true;

  private metaSub?: Subscription;
  private listSub?: Subscription;
  private detailSub?: Subscription;
  private langSub?: Subscription;

  constructor(
    private api: ApiService,
    private sanitizer: DomSanitizer,
    private translate: TranslateService
  ) {}

  ngOnInit(): void {
    this.langSub = this.translate.onLangChange.subscribe(() => {
      this.loadMeta();
      this.loadItems();
    });
    this.loadMeta();
    this.loadItems();
  }

  ngOnDestroy(): void {
    this.metaSub?.unsubscribe();
    this.listSub?.unsubscribe();
    this.detailSub?.unsubscribe();
    this.langSub?.unsubscribe();
  }

  get page(): number {
    return Math.floor(this.offset / this.pageSize) + 1;
  }

  get pages(): number {
    return Math.max(1, Math.ceil(this.total / this.pageSize));
  }

  get canPrev(): boolean {
    return this.offset > 0;
  }

  get canNext(): boolean {
    return this.offset + this.pageSize < this.total;
  }

  get locationLabel(): string {
    if (!this.selected) {
      return '';
    }
    return [this.selected.city, this.selected.region, this.selected.country]
      .filter(Boolean)
      .join(' · ');
  }

  onFilterChange(): void {
    this.offset = 0;
    this.clearSelection();
    this.loadItems();
  }

  onContinentChange(): void {
    this.country = '';
    this.onFilterChange();
  }

  clearFilters(): void {
    this.continent = 'EU';
    this.country = '';
    this.category = '';
    this.sortKey = 'popularity';
    this.useNearby = false;
    this.nearbyLat = null;
    this.nearbyLon = null;
    this.geoError = '';
    this.onFilterChange();
  }

  prevPage(): void {
    if (!this.canPrev) {
      return;
    }
    this.offset = Math.max(0, this.offset - this.pageSize);
    this.loadItems();
  }

  nextPage(): void {
    if (!this.canNext) {
      return;
    }
    this.offset += this.pageSize;
    this.loadItems();
  }

  selectWebcam(item: WebcamItem): void {
    if (!item?.id) {
      return;
    }
    this.selectedId = item.id;
    this.selected = item;
    this.isLoadingDetail = true;
    this.detailSub?.unsubscribe();
    this.detailSub = this.api.getWebcam(item.id, this.apiLang()).subscribe({
      next: (detail) => {
        this.selected = { ...item, ...detail };
        this.isLoadingDetail = false;
        this.setPlayerMode(this.preferredMode(this.selected));
      },
      error: () => {
        this.isLoadingDetail = false;
        this.setPlayerMode(this.preferredMode(item));
      }
    });
  }

  setPlayerMode(mode: PlayerMode): void {
    if (mode === 'image') {
      this.playerMode = 'image';
      this.playerUrl = null;
      return;
    }
    this.playerMode = mode;
    const cam = this.selected;
    let url = '';
    if (cam) {
      if (mode === 'live') {
        url = cam.playerLiveUrl || '';
      } else if (mode === 'month') {
        url = cam.playerMonthUrl || '';
      } else if (mode === 'day') {
        url = cam.playerDayUrl || '';
      }
    }
    if (!url) {
      this.playerMode = 'image';
      this.playerUrl = null;
      return;
    }
    this.iframeGen += 1;
    this.playerUrl = this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  requestNearby(): void {
    this.geoError = '';
    if (!navigator.geolocation) {
      this.geoError = 'WEBCAM.GEO_UNSUPPORTED';
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.nearbyLat = pos.coords.latitude;
        this.nearbyLon = pos.coords.longitude;
        this.useNearby = true;
        this.continent = '';
        this.country = '';
        this.onFilterChange();
      },
      () => {
        this.geoError = 'WEBCAM.GEO_DENIED';
        this.useNearby = false;
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 }
    );
  }

  clearNearby(): void {
    this.useNearby = false;
    this.nearbyLat = null;
    this.nearbyLon = null;
    this.geoError = '';
    if (!this.continent) {
      this.continent = 'EU';
    }
    this.onFilterChange();
  }

  openOnWindy(): void {
    const url = this.selected?.detailUrl;
    if (url) {
      window.open(url, '_blank', 'noopener');
    }
  }

  private loadMeta(): void {
    this.isLoadingMeta = true;
    this.metaSub?.unsubscribe();
    const lang = this.apiLang();
    this.metaSub = this.api.getWebcamContinents(lang).subscribe({
      next: (res) => {
        this.continents = res.continents || [];
        this.configured = res.configured !== false;
        this.isLoadingMeta = false;
      },
      error: () => {
        this.isLoadingMeta = false;
      }
    });
    this.api.getWebcamCountries(lang).subscribe({
      next: (res) => {
        this.countries = res.countries || [];
        if (res.configured === false) {
          this.configured = false;
        }
      }
    });
    this.api.getWebcamCategories(lang).subscribe({
      next: (res) => {
        this.categories = res.categories || [];
      }
    });
  }

  private loadItems(): void {
    this.isLoading = true;
    this.listError = '';
    this.listSub?.unsubscribe();

    const nearby =
      this.useNearby && this.nearbyLat != null && this.nearbyLon != null
        ? `${this.nearbyLat},${this.nearbyLon},${this.nearbyRadiusKm}`
        : undefined;

    this.listSub = this.api
      .searchWebcams({
        countries: this.useNearby ? undefined : this.country || undefined,
        continents: this.useNearby ? undefined : this.continent || undefined,
        categories: this.category || undefined,
        nearby,
        sortKey: this.sortKey,
        sortDirection: 'desc',
        limit: this.pageSize,
        offset: this.offset,
        lang: this.apiLang()
      })
      .subscribe({
        next: (page: WebcamSearchPage) => {
          this.isLoading = false;
          this.items = page.webcams || [];
          this.total = page.total || 0;
          if (page.error === 'missing_api_key') {
            this.configured = false;
            this.listError = 'WEBCAM.ERROR_API_KEY';
          } else if (page.error) {
            this.listError = 'WEBCAM.ERROR_LIST';
          }
          if (this.selectedId) {
            const still = this.items.find((w) => w.id === this.selectedId);
            if (!still && !this.selected) {
              this.clearSelection();
            }
          }
        },
        error: () => {
          this.isLoading = false;
          this.items = [];
          this.total = 0;
          this.listError = 'WEBCAM.ERROR_LIST';
        }
      });
  }

  private preferredMode(cam: WebcamItem | null): PlayerMode {
    if (!cam) {
      return 'image';
    }
    if (cam.playerDayUrl) {
      return 'day';
    }
    if (cam.playerLiveUrl) {
      return 'live';
    }
    if (cam.playerMonthUrl) {
      return 'month';
    }
    return 'image';
  }

  private clearSelection(): void {
    this.selected = null;
    this.selectedId = '';
    this.playerUrl = null;
    this.playerMode = 'day';
  }

  private apiLang(): string {
    const lang = (this.translate.currentLang || this.translate.defaultLang || 'en').toLowerCase();
    if (lang.startsWith('jp') || lang === 'ja') {
      return 'ja';
    }
    if (lang.startsWith('cn') || lang.startsWith('zh')) {
      return 'zh';
    }
    return lang.substring(0, 2) || 'en';
  }
}
