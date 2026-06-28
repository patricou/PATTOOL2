import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { ApiService } from '../services/api.service';
import { environment } from '../../environments/environment';
import * as L from 'leaflet';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-meteo-france',
  templateUrl: './meteo-france.component.html',
  styleUrls: ['./meteo-france.component.css'],
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, NavigationButtonsModule]
})
export class MeteoFranceComponent implements OnInit, OnDestroy {

  constructor(private apiService: ApiService) {}

  city = '';
  countryCode = 'FR';
  lat = 48.8566;
  lon = 2.3522;
  fullAddress = '';

  currentWeather: any = null;
  forecast: any = null;
  displayForecastList: any[] = [];
  forecastDisplayMode: 'hourly' | 'daily' = 'hourly';

  mfStatus: any = null;
  radarValidityTime: string | null = null;
  radarDisplaySource: 'mf' | 'rainviewer' | null = null;
  radarLoadError = false;

  errorMessage = '';
  isLoadingWeather = false;
  isLoadingForecast = false;
  isLoadingCitySearch = false;
  isLoadingGps = false;
  citySearchResults: any[] = [];
  showCitySearchResults = false;

  radarOpacity = 0.72;
  showRadar = true;
  autoRefreshRadar = true;
  activeMainTab: 'radar' | 'clim' = 'radar';
  radarRefreshSeconds = 60;
  readonly radarRefreshMinSeconds = 30;
  readonly radarRefreshMaxSeconds = 600;

  departmentCode = '';
  climFrequency: 'quotidienne' | 'horaire' = 'quotidienne';
  climDays = 30;
  climData: any = null;
  climStations: any[] = [];
  climSelectedStationId = '';
  isLoadingClim = false;
  climErrorKey = '';

  private map: L.Map | null = null;
  private marker: L.Marker | null = null;
  private mosaicOverlay: L.ImageOverlay | null = null;
  private rainViewerLayer: L.TileLayer | null = null;
  private mosaicObjectUrl: string | null = null;
  private readonly radarBounds: L.LatLngBoundsExpression = [[40.8, -5.6], [52.0, 10.2]];
  private readonly subs = new Subscription();
  private mosaicRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private mapInitialized = false;

  ngOnInit(): void {
    this.fixLeafletIcons();
    this.loadMeteoFranceStatus();
    this.loadRadarPreferences();
    this.isLoadingGps = true;
    this.getUserLocation().then((location) => {
      this.lat = location.lat;
      this.lon = location.lng;
      this.reverseGeocode(location.lat, location.lng);
    }).finally(() => {
      if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
        this.lat = 48.8566;
        this.lon = 2.3522;
      }
      this.isLoadingGps = false;
      setTimeout(() => this.initMap(), 0);
      this.refreshWeather();
    });
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.clearRadarTimers();
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }

  get radarAvailable(): boolean {
    return this.mfStatus?.authValid === true;
  }

  get radarStatusMessageKey(): string {
    if (!this.mfStatus) {
      return '';
    }
    if (!this.mfStatus.dpradarConfigured) {
      return 'METEO_FRANCE.DPRADAR_NOT_CONFIGURED';
    }
    if (this.mfStatus.authValid === false) {
      return 'METEO_FRANCE.DPRADAR_INVALID_TOKEN';
    }
    return '';
  }

  get showClearSkyRadarHint(): boolean {
    if (!this.radarAvailable || !this.showRadar || this.radarLoadError) {
      return false;
    }
    const desc = (this.currentWeather?.weather?.[0]?.description || '').toLowerCase();
    return desc.includes('clear') || desc.includes('dégagé') || desc.includes('degage');
  }

  get climAvailable(): boolean {
    return this.mfStatus?.dpclimAuthValid === true;
  }

  get climStatusMessageKey(): string {
    if (!this.mfStatus) {
      return '';
    }
    if (!this.mfStatus.dpclimConfigured) {
      return 'METEO_FRANCE.DPCLIM_NOT_CONFIGURED';
    }
    if (this.mfStatus.dpclimAuthValid === false) {
      return 'METEO_FRANCE.DPCLIM_INVALID_TOKEN';
    }
    return '';
  }

  get climDisplayRows(): any[] {
    const rows = this.climData?.rows;
    return Array.isArray(rows) ? rows : [];
  }

  get climDisplayColumns(): string[] {
    const preferred = ['DATE', 'AAAAMMJJ', 'AAAAMMJJHH', 'TN', 'TNT', 'TX', 'RR', 'TM', 'HNEIGEF'];
    const columns: string[] = this.climData?.columns || [];
    if (!columns.length && this.climDisplayRows.length) {
      return preferred.filter((key) => this.climDisplayRows[0][key] != null);
    }
    return preferred.filter((key) => columns.includes(key));
  }

  private fixLeafletIcons(): void {
    delete (L.Icon.Default.prototype as any)._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: 'assets/leaflet/images/marker-icon-2x.png',
      iconUrl: 'assets/leaflet/images/marker-icon.png',
      shadowUrl: 'assets/leaflet/images/marker-shadow.png'
    });
  }

  private initMap(): void {
    if (this.map) {
      return;
    }
    this.map = L.map('meteo-france-map', {
      center: [this.lat, this.lon],
      zoom: 8,
      minZoom: 5,
      maxZoom: 12,
      maxBounds: [[38, -8], [54, 12]]
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19
    }).addTo(this.map);

    this.marker = L.marker([this.lat, this.lon], { draggable: true }).addTo(this.map);
    this.marker.on('dragend', () => {
      const pos = this.marker!.getLatLng();
      this.setLocation(pos.lat, pos.lng, false);
    });

    this.map.on('click', (e: L.LeafletMouseEvent) => {
      this.setLocation(e.latlng.lat, e.latlng.lng, false);
    });

    this.mapInitialized = true;
    this.setupRadarLayer();
    this.map.invalidateSize();
  }

  private setupRadarLayer(): void {
    if (!this.map || !this.mapInitialized) {
      return;
    }
    this.removeRadarLayers();

    if (!this.showRadar || !this.radarAvailable) {
      return;
    }

    this.loadMosaicOverlay();
    this.startRadarRefreshTimer();
  }

  private get radarRefreshMs(): number {
    const sec = Number(this.radarRefreshSeconds);
    const clamped = Number.isFinite(sec)
      ? Math.max(this.radarRefreshMinSeconds, Math.min(this.radarRefreshMaxSeconds, sec))
      : 60;
    return clamped * 1000;
  }

  private loadRadarPreferences(): void {
    this.subs.add(
      this.apiService.getMeteoFranceRadarPreferences().subscribe({
        next: (pref) => {
          if (pref?.radarRefreshSeconds != null) {
            this.radarRefreshSeconds = pref.radarRefreshSeconds;
            this.startRadarRefreshTimer();
          }
        },
        error: () => { /* anonymous or not configured — status/default applies */ }
      })
    );
  }

  onRadarRefreshSecondsCommitted(): void {
    const n = Math.round(Number(this.radarRefreshSeconds));
    this.radarRefreshSeconds = Number.isFinite(n)
      ? Math.max(this.radarRefreshMinSeconds, Math.min(this.radarRefreshMaxSeconds, n))
      : 60;
    this.subs.add(
      this.apiService.saveMeteoFranceRadarPreferences(this.radarRefreshSeconds).subscribe({
        next: (pref) => {
          this.radarRefreshSeconds = pref.radarRefreshSeconds;
          this.startRadarRefreshTimer();
        },
        error: () => { /* keep local value */ }
      })
    );
  }

  private startRadarRefreshTimer(): void {
    this.clearRadarTimers();
    if (!this.autoRefreshRadar || !this.showRadar || !this.radarAvailable) {
      return;
    }
    this.mosaicRefreshTimer = setInterval(() => this.loadMosaicOverlay(), this.radarRefreshMs);
  }

  onAutoRefreshRadarChange(): void {
    this.startRadarRefreshTimer();
  }

  private loadMosaicOverlay(): void {
    if (!this.map) {
      return;
    }
    this.radarLoadError = false;
    this.radarDisplaySource = null;
    this.loadMfObservationMeta();

    const url = `${environment.API_URL}external/meteofrance/radar/mosaic?zone=METROPOLE&observation=REFLECTIVITE&maille=1000&_=${Date.now()}`;
    this.subs.add(
      this.apiService.fetchRadarMosaicBlob(url).subscribe({
        next: (blob) => {
          if (!this.map || !blob?.size || !blob.type.startsWith('image/')) {
            this.loadRainViewerLayer();
            return;
          }
          if (this.mosaicObjectUrl) {
            URL.revokeObjectURL(this.mosaicObjectUrl);
          }
          if (this.mosaicOverlay) {
            this.map.removeLayer(this.mosaicOverlay);
          }
          this.mosaicObjectUrl = URL.createObjectURL(blob);
          this.mosaicOverlay = L.imageOverlay(this.mosaicObjectUrl, this.radarBounds, {
            opacity: this.radarOpacity,
            zIndex: 500
          });
          this.mosaicOverlay.addTo(this.map);
          this.radarDisplaySource = 'mf';
        },
        error: () => {
          this.loadRainViewerLayer();
        }
      })
    );
  }

  private loadMfObservationMeta(): void {
    this.subs.add(
      this.apiService.getMeteoFranceRadarObservationMeta().subscribe({
        next: (meta) => {
          if (meta?.validity_time) {
            this.radarValidityTime = meta.validity_time;
          } else if (meta?.validityTime) {
            this.radarValidityTime = meta.validityTime;
          }
        },
        error: () => { /* optional metadata */ }
      })
    );
  }

  private loadRainViewerLayer(): void {
    if (!this.map) {
      return;
    }
    this.subs.add(
      this.apiService.getRainViewerMaps().subscribe({
        next: (data) => {
          if (data?.error || !this.map) {
            this.radarLoadError = true;
            return;
          }
          const past = data?.radar?.past;
          if (!past?.length) {
            this.radarLoadError = true;
            return;
          }
          const frame = past[past.length - 1];
          const path = frame?.path;
          if (!path) {
            this.radarLoadError = true;
            return;
          }
          if (this.rainViewerLayer) {
            this.map.removeLayer(this.rainViewerLayer);
          }
          const encodedPath = encodeURIComponent(path);
          const tileBase = `${environment.API_URL}external/radar/rainviewer/tile/{z}/{x}/{y}`;
          this.rainViewerLayer = L.tileLayer(
            `${tileBase}?path=${encodedPath}&size=256&color=2&options=1_1`,
            {
              opacity: this.radarOpacity,
              zIndex: 500,
              maxNativeZoom: 7,
              maxZoom: 12,
              attribution: 'Radar &copy; RainViewer.com (via PatTool)'
            }
          );
          this.rainViewerLayer.addTo(this.map);
          this.radarDisplaySource = 'rainviewer';
        },
        error: () => {
          this.radarLoadError = true;
        }
      })
    );
  }

  private clearRadarTimers(): void {
    if (this.mosaicRefreshTimer) {
      clearInterval(this.mosaicRefreshTimer);
      this.mosaicRefreshTimer = null;
    }
  }

  private removeRadarLayers(): void {
    this.clearRadarTimers();
    if (this.map && this.mosaicOverlay) {
      this.map.removeLayer(this.mosaicOverlay);
      this.mosaicOverlay = null;
    }
    if (this.map && this.rainViewerLayer) {
      this.map.removeLayer(this.rainViewerLayer);
      this.rainViewerLayer = null;
    }
    if (this.mosaicObjectUrl) {
      URL.revokeObjectURL(this.mosaicObjectUrl);
      this.mosaicObjectUrl = null;
    }
    this.radarDisplaySource = null;
  }

  loadMeteoFranceStatus(): void {
    this.subs.add(
      this.apiService.getMeteoFranceStatus().subscribe({
        next: (status) => {
          this.mfStatus = status;
          if (this.activeMainTab === 'radar') {
            this.setupRadarLayer();
          } else if (this.climAvailable) {
            this.loadClimData();
          }
        },
        error: () => {
          this.mfStatus = { dpradarConfigured: false, wmsAvailable: false };
        }
      })
    );
  }

  onRadarOpacityChange(): void {
    if (this.mosaicOverlay) {
      this.mosaicOverlay.setOpacity(this.radarOpacity);
    }
    if (this.rainViewerLayer) {
      this.rainViewerLayer.setOpacity(this.radarOpacity);
    }
  }

  onShowRadarChange(): void {
    this.setupRadarLayer();
  }

  onMainTabChange(tab: 'radar' | 'clim'): void {
    this.activeMainTab = tab;
    if (tab === 'radar') {
      setTimeout(() => {
        this.map?.invalidateSize();
        this.setupRadarLayer();
      }, 0);
    } else if (tab === 'clim' && this.climAvailable && !this.isLoadingClim) {
      this.loadClimData(this.climSelectedStationId || undefined);
    }
  }

  searchCity(): void {
    const query = this.city.trim();
    if (!query) {
      return;
    }
    this.isLoadingCitySearch = true;
    this.subs.add(
      this.apiService.geocodeSearch(query).subscribe({
        next: (results) => {
          this.citySearchResults = results || [];
          this.showCitySearchResults = this.citySearchResults.length > 0;
          this.isLoadingCitySearch = false;
        },
        error: () => {
          this.isLoadingCitySearch = false;
          this.errorMessage = 'METEO_FRANCE.GEOCODE_ERROR';
        }
      })
    );
  }

  selectCity(result: any): void {
    this.showCitySearchResults = false;
    this.city = result.cityName || result.displayName || this.city;
    if (result.countryCode) {
      this.countryCode = result.countryCode;
    }
    this.setLocation(result.lat, result.lon, true);
  }

  useGps(): void {
    this.isLoadingGps = true;
    this.errorMessage = '';
    this.getUserLocation().then((location) => {
      this.setLocation(location.lat, location.lng, true);
    }).finally(() => {
      this.isLoadingGps = false;
    });
  }

  /** GPS first, then IP geolocation; Paris only if both fail. */
  private getUserLocation(): Promise<{ lat: number; lng: number }> {
    return new Promise((resolve) => {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            resolve({
              lat: position.coords.latitude,
              lng: position.coords.longitude
            });
          },
          () => {
            this.getLocationFromIp().then(resolve).catch(() => {
              resolve({ lat: 48.8566, lng: 2.3522 });
            });
          },
          {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 60000
          }
        );
        return;
      }
      this.getLocationFromIp().then(resolve).catch(() => {
        resolve({ lat: 48.8566, lng: 2.3522 });
      });
    });
  }

  private getLocationFromIp(): Promise<{ lat: number; lng: number }> {
    return new Promise((resolve, reject) => {
      this.subs.add(
        this.apiService.getLocationByIp().subscribe({
          next: (data) => {
            if (data.status === 'success' && data.lat != null && data.lon != null) {
              resolve({ lat: data.lat, lng: data.lon });
            } else {
              reject(new Error('IP geolocation failed'));
            }
          },
          error: () => reject(new Error('IP geolocation request failed'))
        })
      );
    });
  }

  private setLocation(lat: number, lon: number, moveMap: boolean): void {
    this.lat = lat;
    this.lon = lon;
    this.errorMessage = '';
    if (this.marker) {
      this.marker.setLatLng([lat, lon]);
    }
    if (moveMap && this.map) {
      this.map.setView([lat, lon], Math.max(this.map.getZoom(), 8));
    }
    this.reverseGeocode(lat, lon);
    this.refreshWeather();
    if (this.activeMainTab === 'clim') {
      this.loadClimData();
    }
  }

  private reverseGeocode(lat: number, lon: number): void {
    this.subs.add(
      this.apiService.geocodeReverse(lat, lon).subscribe({
        next: (res) => {
          this.fullAddress = res?.displayName || '';
          if (res?.address?.city || res?.address?.town || res?.address?.village) {
            this.city = res.address.city || res.address.town || res.address.village;
          }
          if (res?.address?.country_code) {
            this.countryCode = String(res.address.country_code).toUpperCase();
          }
          const postcode = res?.address?.postcode || res?.address?.postal_code;
          if (postcode) {
            this.departmentCode = this.departmentFromPostcode(String(postcode));
          }
        },
        error: () => { /* keep previous label */ }
      })
    );
  }

  loadClimData(stationId?: string): void {
    if (!this.climAvailable) {
      this.climData = null;
      return;
    }
    this.isLoadingClim = true;
    this.climErrorKey = '';
    const days = this.climFrequency === 'horaire' ? Math.min(this.climDays, 31) : this.climDays;
    this.subs.add(
      this.apiService.getMeteoFranceClimNearby(
        this.lat,
        this.lon,
        days,
        this.climFrequency,
        this.departmentCode || undefined,
        stationId
      ).subscribe({
        next: (data) => {
          this.isLoadingClim = false;
          if (data?.error) {
            this.climData = null;
            this.climErrorKey = 'METEO_FRANCE.CLIM_LOAD_ERROR';
            return;
          }
          this.climData = data;
          this.climSelectedStationId = data?.station?.id || '';
          if (data?.department) {
            this.departmentCode = data.department;
            this.loadClimStations(data.department);
          }
        },
        error: () => {
          this.isLoadingClim = false;
          this.climData = null;
          this.climErrorKey = 'METEO_FRANCE.CLIM_LOAD_ERROR';
        }
      })
    );
  }

  private loadClimStations(department: string): void {
    this.subs.add(
      this.apiService.getMeteoFranceClimStations(department, this.climFrequency).subscribe({
        next: (data) => {
          this.climStations = data?.stations || [];
        },
        error: () => {
          this.climStations = [];
        }
      })
    );
  }

  onClimFrequencyChange(): void {
    this.climDays = this.climFrequency === 'horaire' ? 7 : 30;
    this.loadClimData(this.climSelectedStationId || undefined);
  }

  onClimStationChange(): void {
    if (!this.climSelectedStationId) {
      return;
    }
    this.loadClimData(this.climSelectedStationId);
  }

  formatClimColumn(column: string): string {
    return `METEO_FRANCE.CLIM_COL_${column}`;
  }

  formatClimDate(value: string | undefined): string {
    if (!value) {
      return '—';
    }
    const trimmed = value.trim();
    if (/^\d{8}$/.test(trimmed)) {
      const y = trimmed.slice(0, 4);
      const m = trimmed.slice(4, 6);
      const d = trimmed.slice(6, 8);
      return `${d}/${m}/${y}`;
    }
    if (/^\d{10}$/.test(trimmed)) {
      const y = trimmed.slice(0, 4);
      const m = trimmed.slice(4, 6);
      const d = trimmed.slice(6, 8);
      const h = trimmed.slice(8, 10);
      return `${d}/${m}/${y} ${h}h`;
    }
    return trimmed;
  }

  private departmentFromPostcode(postcode: string): string {
    const pc = postcode.trim();
    if (pc.startsWith('97') || pc.startsWith('98')) {
      return pc.substring(0, 3);
    }
    if (pc.startsWith('20')) {
      return '2A';
    }
    return pc.substring(0, 2);
  }

  refreshWeather(): void {
    this.isLoadingWeather = true;
    this.isLoadingForecast = true;
    this.subs.add(
      this.apiService.getCurrentWeatherByCoordinates(this.lat, this.lon).subscribe({
        next: (data) => {
          this.currentWeather = data;
          this.isLoadingWeather = false;
          if (data?.name) {
            this.city = data.name;
          }
        },
        error: () => {
          this.isLoadingWeather = false;
          this.errorMessage = 'METEO_FRANCE.WEATHER_ERROR';
        }
      })
    );
    this.subs.add(
      this.apiService.getForecastByCoordinates(this.lat, this.lon).subscribe({
        next: (data) => {
          this.forecast = data;
          this.isLoadingForecast = false;
          this.updateForecastList();
        },
        error: () => {
          this.isLoadingForecast = false;
        }
      })
    );
  }

  setForecastDisplayMode(mode: 'hourly' | 'daily'): void {
    this.forecastDisplayMode = mode;
    this.updateForecastList();
  }

  private updateForecastList(): void {
    const list = this.forecast?.list;
    if (!list?.length) {
      this.displayForecastList = [];
      return;
    }
    if (this.forecastDisplayMode === 'hourly') {
      this.displayForecastList = list.slice(0, 16);
      return;
    }
    const byDay = new Map<string, any>();
    for (const item of list) {
      const day = new Date(item.dt * 1000).toISOString().slice(0, 10);
      const existing = byDay.get(day);
      if (!existing || (item.main?.temp_max ?? item.main?.temp) > (existing.main?.temp_max ?? existing.main?.temp)) {
        byDay.set(day, item);
      }
    }
    this.displayForecastList = Array.from(byDay.values()).slice(0, 7);
  }

  formatTemperature(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return '—';
    }
    return `${Math.round(value * 10) / 10} °C`;
  }

  formatDate(ts: number): string {
    return new Date(ts * 1000).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  formatDay(ts: number): string {
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    });
  }

  getWeatherIconUrl(icon: string | undefined): string {
    if (!icon) {
      return '';
    }
    return `https://openweathermap.org/img/wn/${icon}@2x.png`;
  }
}
