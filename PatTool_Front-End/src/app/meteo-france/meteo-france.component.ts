import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { ApiService } from '../services/api.service';
import { environment } from '../../environments/environment';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions, registerables } from 'chart.js';
import * as L from 'leaflet';
import { Subscription } from 'rxjs';

Chart.register(...registerables);

type TemperatureUnit = 'celsius' | 'fahrenheit';
type TemperatureDataSource = 'meteofrance' | 'open-meteo';

interface TemperatureGridPoint {
  lat: number;
  lon: number;
  tempC: number;
  stationId?: string;
  stationName?: string;
  humidityPct?: number;
  windDirectionDeg?: number;
  windSpeedMs?: number;
  windGustMs?: number;
  dewPointC?: number;
  precipitationMm?: number;
  pressureHpa?: number;
  observedAt?: string;
  source?: string;
  interpolated?: boolean;
  cached?: boolean;
}

interface ClimPeriodOption {
  days: number;
  labelKey: string;
}

@Component({
  selector: 'app-meteo-france',
  templateUrl: './meteo-france.component.html',
  styleUrls: ['./meteo-france.component.css'],
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, BaseChartDirective]
})
export class MeteoFranceComponent implements OnInit, OnDestroy {

  private static readonly TEMP_UNIT_STORAGE_KEY = 'meteo-france.temperature-unit';
  private static readonly SELECTED_TEMP_LABEL_HIDE_MS = 2000;
  private static readonly TEMP_SOURCE_STORAGE_KEY = 'meteo-france.temperature-data-source';
  private static readonly CLIM_TEMP_COLUMNS = new Set(['TN', 'TNT', 'TX', 'TM']);

  @ViewChild('climTempChart') climTempChart?: BaseChartDirective;
  @ViewChild('climRainChart') climRainChart?: BaseChartDirective;
  @ViewChild('mapShell') mapShell?: ElementRef<HTMLElement>;

  readonly climDailyPeriodOptions: ClimPeriodOption[] = [
    { days: 7, labelKey: 'METEO_FRANCE.CLIM_PERIOD_7D' },
    { days: 30, labelKey: 'METEO_FRANCE.CLIM_PERIOD_1M' },
    { days: 90, labelKey: 'METEO_FRANCE.CLIM_PERIOD_3M' },
    { days: 180, labelKey: 'METEO_FRANCE.CLIM_PERIOD_6M' },
    { days: 365, labelKey: 'METEO_FRANCE.CLIM_PERIOD_1Y' }
  ];

  readonly climHourlyPeriodOptions: ClimPeriodOption[] = [
    { days: 1, labelKey: 'METEO_FRANCE.CLIM_PERIOD_1D' },
    { days: 3, labelKey: 'METEO_FRANCE.CLIM_PERIOD_3D' },
    { days: 7, labelKey: 'METEO_FRANCE.CLIM_PERIOD_7D' },
    { days: 14, labelKey: 'METEO_FRANCE.CLIM_PERIOD_14D' },
    { days: 31, labelKey: 'METEO_FRANCE.CLIM_PERIOD_1M' }
  ];

  climTempChartData: ChartConfiguration<'line'>['data'] = { labels: [], datasets: [] };
  climRainChartData: ChartConfiguration<'bar'>['data'] = { labels: [], datasets: [] };
  climTempChartOptions: ChartOptions<'line'> = this.buildClimTempChartOptions();
  climRainChartOptions: ChartOptions<'bar'> = this.buildClimRainChartOptions();
  climChartsReady = false;
  climShowTable = false;

  readonly meteoFranceApiPortalUrl = 'https://portail-api.meteofrance.fr/web/fr/';

  constructor(
    private apiService: ApiService,
    private translate: TranslateService
  ) {}

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
  cloudDisplaySource: 'rainviewer' | 'openweathermap' | null = null;
  cloudLoadError = false;
  cloudValidityTime: string | null = null;

  errorMessage = '';
  isLoadingWeather = false;
  isLoadingForecast = false;
  isLoadingCitySearch = false;
  isLoadingGps = false;
  citySearchResults: any[] = [];
  showCitySearchResults = false;

  radarOpacity = 0.72;
  showRadar = true;
  showCloudLayer = true;
  cloudOpacity = 1;
  cloudIntensity = 4;
  readonly cloudIntensityMin = 0.5;
  readonly cloudIntensityMax = 8;
  showTemperatureMap = true;
  temperatureDataSource: TemperatureDataSource = 'meteofrance';
  isLoadingTemperatureLabels = false;
  temperatureLabelSource: 'meteofrance-dpobs' | 'open-meteo' | null = null;
  temperatureLabelsFromCache = false;
  temperatureLabelsUpdatedAt: Date | null = null;
  temperatureLabelsDetailLevel: string | null = null;
  temperatureLabelsCount = 0;
  temperatureLabelsCacheTtlMinutes: number | null = null;
  temperatureLabelsRefreshTrigger: 'initial' | 'pan' | 'zoom' | 'source' | null = null;
  temperatureLabelsErrorKey = '';
  temperatureUnit: TemperatureUnit = 'celsius';
  mapFullscreen = false;
  autoRefreshRadar = true;
  activeMainTab: 'radar' | 'clim' = 'radar';
  radarRefreshSeconds = 60;
  readonly radarRefreshMinSeconds = 30;
  readonly radarRefreshMaxSeconds = 600;
  temperatureCacheMinutes = 5;
  readonly temperatureCacheMinMinutes = 1;
  readonly temperatureCacheMaxMinutes = 120;

  departmentCode = '';
  climFrequency: 'quotidienne' | 'horaire' = 'quotidienne';
  climDays = 30;
  climData: any = null;
  climStations: any[] = [];
  climSelectedStationId = '';
  isLoadingClim = false;
  climErrorKey = '';
  climErrorDetail = '';
  climPeriodStart = '';
  climPeriodEnd = '';
  climRequestedDays = 30;
  climAttemptedStation: any = null;

  private map: L.Map | null = null;
  private marker: L.Marker | null = null;
  private mosaicOverlay: L.ImageOverlay | null = null;
  private rainViewerLayer: L.TileLayer | null = null;
  private rainViewerCloudLayer: L.TileLayer | null = null;
  private temperatureLabelsLayer: L.LayerGroup | null = null;
  private selectedTempLabelMarker: L.Marker | null = null;
  private selectedTempLabelHideToken = 0;
  private selectedTempLabelDismissed = false;
  private selectedPointTempC: number | null = null;
  private selectedLocationName = '';
  private reverseGeocodeRequestId = 0;
  private selectedTempRequestId = 0;
  private temperatureGridPoints: TemperatureGridPoint[] = [];
  private temperatureLabelsDebounce: ReturnType<typeof setTimeout> | null = null;
  private temperatureLabelsRequestId = 0;
  private temperatureLabelsLoadSub: Subscription | null = null;
  private readonly refreshingTemperatureKeys = new Set<string>();
  private cloudIntensityReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private mosaicObjectUrl: string | null = null;
  private readonly radarBounds: L.LatLngBoundsExpression = [[40.8, -5.6], [52.0, 10.2]];
  private readonly subs = new Subscription();
  private mosaicRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private mapInitialized = false;

  ngOnInit(): void {
    this.loadTemperatureUnitPreference();
    this.loadTemperatureDataSourcePreference();
    this.fixLeafletIcons();
    this.loadMeteoFranceStatus();
    this.loadRadarPreferences();
    this.loadTemperatureCachePreferences();
    this.isLoadingGps = true;
    this.getUserLocation().then((location) => {
      this.lat = location.lat;
      this.lon = location.lng;
      this.selectedLocationName = this.formatGpsCoordinates(location.lat, location.lng);
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
    this.exitMapFullscreenIfActive();
    this.temperatureLabelsLoadSub?.unsubscribe();
    this.subs.unsubscribe();
    this.clearRadarTimers();
    if (this.cloudIntensityReloadTimer) {
      clearTimeout(this.cloudIntensityReloadTimer);
      this.cloudIntensityReloadTimer = null;
    }
    this.detachTemperatureLabelListeners();
    this.removeCloudLayers();
    this.removeRadarLayers();
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }

  get radarAvailable(): boolean {
    return this.mfStatus?.authValid === true;
  }

  get temperatureMapAvailable(): boolean {
    return this.mapInitialized;
  }

  get obsAvailable(): boolean {
    return this.mfStatus?.dpobsAuthValid === true;
  }

  get obsStatusMessageKey(): string {
    if (!this.mfStatus || !this.showTemperatureMap || this.temperatureDataSource !== 'meteofrance') {
      return '';
    }
    if (!this.mfStatus.dpobsConfigured) {
      return 'METEO_FRANCE.DPOBS_NOT_CONFIGURED';
    }
    if (this.mfStatus.dpobsAuthValid === false) {
      return 'METEO_FRANCE.DPOBS_INVALID_TOKEN';
    }
    return '';
  }

  get temperatureMapHintKey(): string {
    if (this.temperatureDataSource === 'open-meteo') {
      return 'METEO_FRANCE.TEMPERATURE_MAP_HINT_OPENMETEO';
    }
    return 'METEO_FRANCE.TEMPERATURE_MAP_HINT_MF';
  }

  get precipitationLayerStatusKey(): string {
    if (!this.showRadar) {
      return 'METEO_FRANCE.PRECIPITATION_LAYER_OFF';
    }
    if (this.radarLoadError) {
      return 'METEO_FRANCE.PRECIPITATION_LAYER_ERROR';
    }
    if (this.radarDisplaySource === 'mf') {
      return 'METEO_FRANCE.PRECIPITATION_LAYER_MF';
    }
    if (this.radarDisplaySource === 'rainviewer') {
      return 'METEO_FRANCE.PRECIPITATION_LAYER_RAINVIEWER';
    }
    return 'METEO_FRANCE.PRECIPITATION_LAYER_LOADING';
  }

  get cloudLayerStatusKey(): string {
    if (!this.showCloudLayer) {
      return 'METEO_FRANCE.CLOUD_LAYER_OFF';
    }
    if (this.cloudLoadError) {
      return 'METEO_FRANCE.CLOUD_LAYER_ERROR';
    }
    if (this.cloudDisplaySource === 'rainviewer') {
      return 'METEO_FRANCE.CLOUD_LAYER_RAINVIEWER';
    }
    if (this.cloudDisplaySource === 'openweathermap') {
      return 'METEO_FRANCE.CLOUD_LAYER_OPENWEATHER';
    }
    return 'METEO_FRANCE.CLOUD_LAYER_LOADING';
  }

  get temperatureTriggerLabel(): string {
    switch (this.temperatureLabelsRefreshTrigger) {
      case 'pan':
        return this.translate.instant('METEO_FRANCE.TEMPERATURE_TRIGGER_PAN');
      case 'zoom':
        return this.translate.instant('METEO_FRANCE.TEMPERATURE_TRIGGER_ZOOM');
      case 'source':
        return this.translate.instant('METEO_FRANCE.TEMPERATURE_TRIGGER_SOURCE');
      default:
        return this.translate.instant('METEO_FRANCE.TEMPERATURE_TRIGGER_INITIAL');
    }
  }

  get temperatureSourceLabel(): string {
    if (this.temperatureLabelSource === 'meteofrance-dpobs') {
      return this.translate.instant('METEO_FRANCE.TEMPERATURE_SOURCE_MF');
    }
    if (this.temperatureLabelSource === 'open-meteo') {
      return this.translate.instant('METEO_FRANCE.TEMPERATURE_SOURCE_OPENMETEO');
    }
    return this.temperatureDataSource === 'meteofrance'
      ? this.translate.instant('METEO_FRANCE.TEMPERATURE_SOURCE_MF')
      : this.translate.instant('METEO_FRANCE.TEMPERATURE_SOURCE_OPENMETEO');
  }

  get temperatureDetailLabel(): string {
    switch (this.temperatureLabelsDetailLevel) {
      case 'major-cities':
        return this.translate.instant('METEO_FRANCE.TEMPERATURE_DETAIL_MAJOR_CITIES');
      case 'mixed':
        return this.translate.instant('METEO_FRANCE.TEMPERATURE_DETAIL_MIXED');
      case 'sparse':
        return this.translate.instant('METEO_FRANCE.TEMPERATURE_DETAIL_SPARSE');
      case 'all':
        return this.translate.instant('METEO_FRANCE.TEMPERATURE_DETAIL_ALL');
      default:
        return '';
    }
  }

  get temperatureStatusParams(): Record<string, string> {
    const ttl = this.temperatureLabelsCacheTtlMinutes ?? this.temperatureCacheMinutes;
    const params: Record<string, string> = {
      source: this.temperatureSourceLabel,
      trigger: this.temperatureTriggerLabel,
      time: this.temperatureLabelsUpdatedAt
        ? this.temperatureLabelsUpdatedAt.toLocaleTimeString()
        : '—',
      count: String(this.temperatureLabelsCount),
      ttl: String(ttl),
    };
    const detail = this.temperatureDetailLabel;
    if (detail) {
      params['detail'] = detail;
    }
    params['detailSuffix'] = detail ? ` — ${detail}` : '';
    return params;
  }

  get temperatureReadyStatusKey(): string {
    return this.temperatureLabelsFromCache
      ? 'METEO_FRANCE.TEMPERATURE_STATUS_CACHED'
      : 'METEO_FRANCE.TEMPERATURE_STATUS_FRESH';
  }

  get cloudStatusParams(): Record<string, string> {
    return {
      time: this.cloudValidityTime ?? '—',
    };
  }

  get precipitationStatusParams(): Record<string, string> {
    return {
      time: this.radarValidityTime ?? '—',
    };
  }

  onTemperatureDataSourceChange(source: TemperatureDataSource): void {
    if (this.temperatureDataSource === source) {
      return;
    }
    this.temperatureDataSource = source;
    try {
      localStorage.setItem(MeteoFranceComponent.TEMP_SOURCE_STORAGE_KEY, source);
    } catch { /* private mode */ }
    this.temperatureGridPoints = [];
    this.temperatureLabelSource = null;
    this.temperatureLabelsErrorKey = '';
    this.selectedPointTempC = null;
    this.temperatureLabelsRefreshTrigger = 'source';
    this.temperatureLabelsRequestId++;
    if (this.showTemperatureMap) {
      this.scheduleTemperatureLabelsLoad();
      this.fetchSelectedPointTemperature(this.lat, this.lon);
    }
  }

  private readonly onMapMoveEndForTemperatureLabels = (): void => {
    this.temperatureLabelsRefreshTrigger = 'pan';
    this.renderTemperatureLabels();
    this.scheduleTemperatureLabelsLoad();
  };

  private readonly onMapZoomEndForTemperatureLabels = (): void => {
    this.temperatureLabelsRefreshTrigger = 'zoom';
    this.renderTemperatureLabels();
    this.scheduleTemperatureLabelsLoad();
  };

  /** Minimum screen spacing between temperature labels (px). */
  private readonly temperatureLabelMinPxX = 44;
  private readonly temperatureLabelMinPxY = 22;

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

  get climPeriodOptions(): ClimPeriodOption[] {
    return this.climFrequency === 'horaire'
      ? this.climHourlyPeriodOptions
      : this.climDailyPeriodOptions;
  }

  get climHasRainSeries(): boolean {
    return this.climRainChartData.datasets.some((ds) =>
      (ds.data as (number | null)[]).some((v) => v != null)
    );
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
      if (this.isTemperatureMapUiClick(e.originalEvent)) {
        return;
      }
      this.setLocation(e.latlng.lat, e.latlng.lng, false);
    });

    this.map.getContainer().addEventListener('click', this.onTemperatureTooltipClick);

    this.mapInitialized = true;
    this.setupRadarLayer();
    this.setupCloudLayer();
    this.setupTemperatureLabels();
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

  private loadTemperatureCachePreferences(): void {
    this.subs.add(
      this.apiService.getMeteoFranceTemperatureCachePreferences().subscribe({
        next: (pref) => {
          if (pref?.temperatureCacheMinutes != null) {
            this.temperatureCacheMinutes = pref.temperatureCacheMinutes;
          }
        },
        error: () => { /* anonymous or not configured — default applies */ }
      })
    );
  }

  onTemperatureCacheMinutesCommitted(): void {
    const n = Math.round(Number(this.temperatureCacheMinutes));
    this.temperatureCacheMinutes = Number.isFinite(n)
      ? Math.max(this.temperatureCacheMinMinutes, Math.min(this.temperatureCacheMaxMinutes, n))
      : 5;
    this.subs.add(
      this.apiService.saveMeteoFranceTemperatureCachePreferences(this.temperatureCacheMinutes).subscribe({
        next: (pref) => {
          this.temperatureCacheMinutes = pref.temperatureCacheMinutes;
        },
        error: () => { /* keep local value */ }
      })
    );
  }

  private startRadarRefreshTimer(): void {
    this.clearRadarTimers();
    if (!this.autoRefreshRadar) {
      return;
    }
    const refreshLayers = (): void => {
      if (this.showRadar && this.radarAvailable) {
        this.loadMosaicOverlay();
      }
      if (this.showCloudLayer) {
        this.loadCloudLayer();
      }
    };
    if ((this.showRadar && this.radarAvailable) || this.showCloudLayer) {
      this.mosaicRefreshTimer = setInterval(refreshLayers, this.radarRefreshMs);
    }
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
          this.radarLoadError = false;
          if (frame?.time != null) {
            const ts = Number(frame.time);
            if (Number.isFinite(ts)) {
              this.radarValidityTime = new Date(ts * 1000).toLocaleString();
            }
          }
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
            this.setupCloudLayer();
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

  onCloudOpacityChange(): void {
    const opacity = this.readCloudOpacity();
    this.cloudOpacity = opacity;
    if (this.rainViewerCloudLayer) {
      this.rainViewerCloudLayer.setOpacity(opacity);
      this.updateCloudTileEnhancement();
    }
  }

  onCloudIntensityChange(): void {
    this.cloudIntensity = this.readCloudIntensity();
    if (this.cloudDisplaySource === 'openweathermap') {
      if (this.cloudIntensityReloadTimer) {
        clearTimeout(this.cloudIntensityReloadTimer);
      }
      this.updateCloudTileEnhancement();
      this.cloudIntensityReloadTimer = setTimeout(() => {
        this.loadOpenWeatherCloudLayer();
        this.cloudIntensityReloadTimer = null;
      }, 350);
      return;
    }
    if (this.cloudDisplaySource === 'rainviewer') {
      if (this.cloudIntensityReloadTimer) {
        clearTimeout(this.cloudIntensityReloadTimer);
      }
      this.updateCloudTileEnhancement();
      this.cloudIntensityReloadTimer = setTimeout(() => {
        this.loadRainViewerCloudLayer();
        this.cloudIntensityReloadTimer = null;
      }, 350);
      return;
    }
    this.updateCloudTileEnhancement();
  }

  private updateCloudTileEnhancement(): void {
    const layer = this.rainViewerCloudLayer;
    if (!layer) {
      return;
    }
    const container = layer.getContainer() as HTMLElement | undefined;
    if (!container) {
      return;
    }
    const opacity = this.readCloudOpacity();
    const intensity = this.readCloudIntensity();
    const isOwm = this.cloudDisplaySource === 'openweathermap';
    const intensityFactor = 0.9 + intensity * 0.22;
    const baseContrast = isOwm ? 1.55 : 1.65;
    const contrast = baseContrast * intensityFactor * (0.85 + opacity * 0.15);
    const baseBrightness = isOwm ? 0.82 : 0.88;
    const brightness = baseBrightness - (intensity - 1) * (isOwm ? 0.06 : 0.05);
    const saturate = (isOwm ? 1.45 : 1.25) * (0.9 + intensity * 0.12);
    container.style.setProperty('--mf-cloud-contrast', contrast.toFixed(2));
    container.style.setProperty('--mf-cloud-brightness', brightness.toFixed(2));
    container.style.setProperty('--mf-cloud-saturate', saturate.toFixed(2));
  }

  private readCloudOpacity(): number {
    const n = Number(this.cloudOpacity);
    return Number.isFinite(n) ? Math.max(0.05, Math.min(1, n)) : 0.85;
  }

  private readCloudIntensity(): number {
    const n = Number(this.cloudIntensity);
    return Number.isFinite(n)
      ? Math.max(this.cloudIntensityMin, Math.min(this.cloudIntensityMax, n))
      : 4;
  }

  private attachCloudTileLayer(url: string, attribution: string, openWeather = false, rainViewer = false): void {
    if (!this.map) {
      return;
    }
    if (this.rainViewerCloudLayer) {
      this.map.removeLayer(this.rainViewerCloudLayer);
    }
    this.rainViewerCloudLayer = L.tileLayer(url, {
      opacity: this.readCloudOpacity(),
      zIndex: 450,
      maxZoom: 19,
      attribution,
      className: openWeather
        ? 'mf-cloud-tiles mf-cloud-tiles--owm'
        : rainViewer
          ? 'mf-cloud-tiles mf-cloud-tiles--rv'
          : 'mf-cloud-tiles'
    });
    this.rainViewerCloudLayer.addTo(this.map);
    this.cloudLoadError = false;
  }

  private loadOpenWeatherCloudLayer(): void {
    if (!this.map || !this.showCloudLayer) {
      return;
    }
    if (this.mfStatus?.openWeatherConfigured === false) {
      this.cloudLoadError = true;
      this.cloudDisplaySource = null;
      return;
    }
    const enhance = this.readCloudIntensity().toFixed(1);
    const cacheBust = Date.now();
    const tileUrl = `${environment.API_URL}external/weather/map/clouds/{z}/{x}/{y}?enhance=${enhance}&_=${cacheBust}`;
    this.attachCloudTileLayer(tileUrl, 'Clouds &copy; OpenWeatherMap (via PatTool)', true);
    this.cloudDisplaySource = 'openweathermap';
    this.cloudValidityTime = new Date().toLocaleString();
    this.updateCloudTileEnhancement();
  }

  onShowCloudLayerChange(): void {
    this.setupCloudLayer();
    this.startRadarRefreshTimer();
  }

  private setupCloudLayer(): void {
    if (!this.map || !this.mapInitialized) {
      return;
    }
    this.removeCloudLayers();
    if (!this.showCloudLayer) {
      return;
    }
    this.loadCloudLayer();
    if (this.autoRefreshRadar) {
      this.startRadarRefreshTimer();
    }
  }

  private loadCloudLayer(): void {
    if (!this.map || !this.showCloudLayer) {
      return;
    }
    if (this.mfStatus?.openWeatherConfigured !== false) {
      this.loadOpenWeatherCloudLayer();
      return;
    }
    this.loadRainViewerCloudLayer();
  }

  private loadRainViewerCloudLayer(): void {
    if (!this.map || !this.showCloudLayer) {
      return;
    }
    this.subs.add(
      this.apiService.getRainViewerMaps().subscribe({
        next: (data) => {
          if (data?.error || !this.map || !this.showCloudLayer) {
            this.loadOpenWeatherCloudLayer();
            return;
          }
          const infrared = data?.satellite?.infrared;
          if (!infrared?.length) {
            this.loadOpenWeatherCloudLayer();
            return;
          }
          const frame = infrared[infrared.length - 1];
          const path = frame?.path;
          if (!path) {
            this.loadOpenWeatherCloudLayer();
            return;
          }
          const encodedPath = encodeURIComponent(path);
          const enhance = this.readCloudIntensity().toFixed(1);
          const tileBase = `${environment.API_URL}external/radar/rainviewer/tile/{z}/{x}/{y}`;
          this.attachCloudTileLayer(
            `${tileBase}?path=${encodedPath}&size=256&color=2&options=0_0&enhance=${enhance}`,
            'Satellite IR &copy; RainViewer.com (via PatTool)',
            false,
            true
          );
          this.cloudDisplaySource = 'rainviewer';
          this.updateCloudTileEnhancement();
          if (frame?.time != null) {
            const ts = Number(frame.time);
            if (Number.isFinite(ts)) {
              this.cloudValidityTime = new Date(ts * 1000).toLocaleString();
            }
          }
        },
        error: () => {
          this.loadOpenWeatherCloudLayer();
        }
      })
    );
  }

  private removeCloudLayers(): void {
    if (this.map && this.rainViewerCloudLayer) {
      this.map.removeLayer(this.rainViewerCloudLayer);
      this.rainViewerCloudLayer = null;
    }
    this.cloudDisplaySource = null;
    this.cloudLoadError = false;
    this.cloudValidityTime = null;
  }

  onShowTemperatureMapChange(): void {
    this.setupTemperatureLabels();
  }

  private setupTemperatureLabels(): void {
    if (!this.map) {
      return;
    }
    this.removeTemperatureLabels();
    if (!this.showTemperatureMap) {
      return;
    }
    this.temperatureLabelsLayer = L.layerGroup().addTo(this.map);
    this.temperatureLabelsRefreshTrigger = 'initial';
    this.map.on('moveend', this.onMapMoveEndForTemperatureLabels);
    this.map.on('zoomend', this.onMapZoomEndForTemperatureLabels);
    this.scheduleTemperatureLabelsLoad();
    this.fetchSelectedPointTemperature(this.lat, this.lon);
  }

  private removeTemperatureLabels(): void {
    this.detachTemperatureLabelListeners();
    this.clearTemperatureLabelsDebounce();
    this.temperatureLabelsLoadSub?.unsubscribe();
    this.temperatureLabelsLoadSub = null;
    this.temperatureGridPoints = [];
    this.selectedPointTempC = null;
    this.selectedTempRequestId++;
    this.selectedTempLabelDismissed = false;
    this.selectedTempLabelHideToken++;
    this.temperatureLabelsRequestId++;
    this.isLoadingTemperatureLabels = false;
    if (this.selectedTempLabelMarker && this.map) {
      this.map.removeLayer(this.selectedTempLabelMarker);
      this.selectedTempLabelMarker = null;
    }
    if (this.map && this.temperatureLabelsLayer) {
      this.map.removeLayer(this.temperatureLabelsLayer);
      this.temperatureLabelsLayer = null;
    }
  }

  private detachTemperatureLabelListeners(): void {
    this.map?.off('moveend', this.onMapMoveEndForTemperatureLabels);
    this.map?.off('zoomend', this.onMapZoomEndForTemperatureLabels);
  }

  private clearTemperatureLabelsDebounce(): void {
    if (this.temperatureLabelsDebounce) {
      clearTimeout(this.temperatureLabelsDebounce);
      this.temperatureLabelsDebounce = null;
    }
  }

  private scheduleTemperatureLabelsLoad(): void {
    if (!this.showTemperatureMap || !this.map) {
      return;
    }
    this.clearTemperatureLabelsDebounce();
    const { debounceMs } = this.computeTemperatureLabelCapacity();
    this.temperatureLabelsDebounce = setTimeout(() => this.loadTemperatureLabels(), debounceMs);
  }

  private loadTemperatureLabels(): void {
    if (!this.showTemperatureMap || !this.map || !this.temperatureLabelsLayer) {
      return;
    }
    const bounds = this.map.getBounds();
    const capacity = this.computeTemperatureLabelCapacity();

    this.temperatureLabelsLoadSub?.unsubscribe();
    const requestId = ++this.temperatureLabelsRequestId;
    const previousPoints = [...this.temperatureGridPoints];
    this.temperatureLabelsErrorKey = '';
    this.isLoadingTemperatureLabels = true;

    this.temperatureLabelsLoadSub = this.apiService.getWeatherTemperatureLabels(
      bounds.getSouth(),
      bounds.getNorth(),
      bounds.getWest(),
      bounds.getEast(),
      capacity.cols,
      capacity.rows,
      capacity.maxStations,
      this.temperatureDataSource
    ).subscribe({
      next: (data) => {
        if (requestId !== this.temperatureLabelsRequestId || !this.showTemperatureMap) {
          return;
        }
        if (data?.error) {
          this.applyTemperatureLabelsFailure(previousPoints);
        } else {
          const src = data?.source || 'open-meteo';
          const labelSource = src.includes('meteofrance') ? 'meteofrance-dpobs' : 'open-meteo';
          this.temperatureLabelSource = labelSource;
          this.temperatureLabelsFromCache = data?.cached === true;
          this.temperatureLabelsUpdatedAt = new Date();
          this.temperatureLabelsDetailLevel = data?.detailLevel ?? null;
          this.temperatureLabelsCount = data?.count ?? (Array.isArray(data?.points) ? data.points.length : 0);
          this.temperatureLabelsCacheTtlMinutes = data?.cacheTtlMinutes ?? null;
          this.temperatureGridPoints = Array.isArray(data?.points)
            ? data.points
                .map((point) => this.normalizeTemperatureGridPoint(point, data?.cached === true))
                .filter((point) => this.isValidTemperatureLabelPoint(point, labelSource))
            : [];
          if (this.temperatureGridPoints.length) {
            this.temperatureLabelsErrorKey = '';
          } else {
            this.temperatureLabelSource = null;
            this.temperatureLabelsErrorKey = previousPoints.length
              ? ''
              : 'METEO_FRANCE.TEMPERATURE_LABELS_EMPTY';
            if (previousPoints.length) {
              this.temperatureGridPoints = previousPoints;
            }
          }
        }
        this.renderTemperatureLabels();
        this.isLoadingTemperatureLabels = false;
      },
      error: () => {
        if (requestId !== this.temperatureLabelsRequestId) {
          return;
        }
        this.isLoadingTemperatureLabels = false;
        this.applyTemperatureLabelsFailure(previousPoints);
        this.renderTemperatureLabels();
      }
    });
    this.subs.add(this.temperatureLabelsLoadSub);
  }

  private isValidTemperatureLabelPoint(
    point: TemperatureGridPoint,
    source: 'meteofrance-dpobs' | 'open-meteo'
  ): boolean {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || !Number.isFinite(point.tempC)) {
      return false;
    }
    if (point.interpolated) {
      return false;
    }
    if (this.temperatureDataSource === 'meteofrance') {
      return !!point.stationId;
    }
    return true;
  }

  private applyTemperatureLabelsFailure(previousPoints: TemperatureGridPoint[]): void {
    if (previousPoints.length) {
      this.temperatureGridPoints = previousPoints;
      this.temperatureLabelsErrorKey = '';
      return;
    }
    this.temperatureGridPoints = [];
    this.temperatureLabelsErrorKey = 'METEO_FRANCE.TEMPERATURE_LABELS_ERROR';
    this.temperatureLabelSource = null;
  }

  private computeTemperatureLabelCapacity(): {
    cols: number;
    rows: number;
    maxStations: number;
    debounceMs: number;
  } {
    if (!this.map) {
      return { cols: 6, rows: 4, maxStations: 24, debounceMs: 450 };
    }
    const zoom = this.map.getZoom();
    const size = this.map.getSize();
    let cols = Math.max(4, Math.min(10, Math.ceil(size.x / this.temperatureLabelMinPxX)));
    let rows = Math.max(3, Math.min(8, Math.ceil(size.y / this.temperatureLabelMinPxY)));

    if (zoom <= 7) {
      return {
        cols: Math.min(cols, 5),
        rows: Math.min(rows, 4),
        maxStations: 22,
        debounceMs: 550,
      };
    }
    if (zoom <= 9) {
      return {
        cols: Math.min(cols, 7),
        rows: Math.min(rows, 5),
        maxStations: 45,
        debounceMs: 420,
      };
    }
    return {
      cols,
      rows,
      maxStations: 72,
      debounceMs: 350,
    };
  }

  private bindTemperatureMarkerTooltip(marker: L.Marker, point: TemperatureGridPoint): void {
    marker.bindTooltip(this.buildTemperatureLabelTooltip(point), {
      direction: 'top',
      offset: [0, -10],
      opacity: 0.97,
      className: 'mf-temp-tooltip',
      permanent: true,
      sticky: false
    });

    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelClose = (): void => {
      if (closeTimer !== null) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
    };
    const scheduleClose = (): void => {
      cancelClose();
      closeTimer = setTimeout(() => {
        marker.closeTooltip();
        closeTimer = null;
      }, 320);
    };
    const wireTooltipElement = (): void => {
      const el = marker.getTooltip()?.getElement() as HTMLElement | undefined;
      if (!el || el.dataset['mfTempTooltipWired'] === '1') {
        return;
      }
      el.dataset['mfTempTooltipWired'] = '1';
      el.addEventListener('mouseenter', cancelClose);
      el.addEventListener('mouseleave', scheduleClose);
    };

    marker.on('add', () => {
      marker.closeTooltip();
    });
    marker.on('mouseover', () => {
      cancelClose();
      marker.openTooltip();
      wireTooltipElement();
    });
    marker.on('mouseout', scheduleClose);
    marker.on('click', (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e);
    });
    marker.on('tooltipopen', wireTooltipElement);
  }

  private renderTemperatureLabels(): void {
    if (!this.temperatureLabelsLayer || !this.map) {
      return;
    }
    this.temperatureLabelsLayer.clearLayers();
    const inBounds = this.filterPointsInMapBounds(this.temperatureGridPoints);
    const visible = this.filterNonOverlappingTemperatureLabels(inBounds);
    for (const point of visible) {
      if (point.tempC == null || !Number.isFinite(point.tempC)) {
        continue;
      }
      if (this.isNearSelectedPoint(point.lat, point.lon)) {
        continue;
      }
      const label = this.formatTemperatureLabel(point.tempC);
      const w = Math.max(28, label.length * 7 + 12);
      const h = 20;
      const icon = L.divIcon({
        className: 'mf-temp-label',
        html: `<span>${label}</span>`,
        iconSize: [w, h],
        iconAnchor: [w / 2, h / 2]
      });
      const marker = L.marker([point.lat, point.lon], { icon, interactive: true });
      this.bindTemperatureMarkerTooltip(marker, point);
      marker.addTo(this.temperatureLabelsLayer);
    }
    this.updateSelectedTemperatureLabel();
  }

  private filterPointsInMapBounds(points: TemperatureGridPoint[]): TemperatureGridPoint[] {
    if (!this.map) {
      return points;
    }
    const bounds = this.map.getBounds();
    return points.filter((point) => bounds.contains([point.lat, point.lon]));
  }

  private filterNonOverlappingTemperatureLabels(points: TemperatureGridPoint[]): TemperatureGridPoint[] {
    if (!this.map || !points.length) {
      return [];
    }
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    const result: typeof points = [];
    for (const point of points) {
      const pt = this.map.latLngToContainerPoint([point.lat, point.lon]);
      const label = this.formatTemperatureLabel(point.tempC);
      const w = Math.max(28, label.length * 7 + 12);
      const h = 20;
      const rect = { x: pt.x - w / 2, y: pt.y - h / 2, w, h };
      if (this.temperatureLabelRectOverlaps(rect, placed)) {
        continue;
      }
      placed.push(rect);
      result.push(point);
    }
    return result;
  }

  private temperatureLabelRectOverlaps(
    rect: { x: number; y: number; w: number; h: number },
    placed: Array<{ x: number; y: number; w: number; h: number }>
  ): boolean {
    const pad = 4;
    for (const p of placed) {
      if (
        rect.x + rect.w + pad >= p.x &&
        p.x + p.w + pad >= rect.x &&
        rect.y + rect.h + pad >= p.y &&
        p.y + p.h + pad >= rect.y
      ) {
        return true;
      }
    }
    return false;
  }

  private isNearSelectedPoint(lat: number, lon: number): boolean {
    if (!this.map) {
      return false;
    }
    const selectedPt = this.map.latLngToContainerPoint([this.lat, this.lon]);
    const stationPt = this.map.latLngToContainerPoint([lat, lon]);
    const dx = selectedPt.x - stationPt.x;
    const dy = selectedPt.y - stationPt.y;
    return dx * dx + dy * dy < 28 * 28;
  }

  private updateSelectedTemperatureLabel(): void {
    if (!this.map || !this.showTemperatureMap || this.selectedTempLabelDismissed) {
      if (!this.showTemperatureMap) {
        this.removeSelectedTemperatureLabel();
      }
      return;
    }
    const tempC = this.resolveSelectedTemperatureCelsius();
    if (tempC == null) {
      this.removeSelectedTemperatureLabel();
      return;
    }
    const { html, width, height } = this.buildSelectedTemperatureLabelIcon(tempC);
    const icon = L.divIcon({
      className: 'mf-temp-label mf-temp-label--selected',
      html,
      iconSize: [width, height],
      iconAnchor: [width / 2, height / 2]
    });
    if (!this.selectedTempLabelMarker) {
      this.selectedTempLabelMarker = L.marker([this.lat, this.lon], {
        icon,
        interactive: false,
        zIndexOffset: 1000
      }).addTo(this.map);
    } else {
      this.selectedTempLabelMarker.setLatLng([this.lat, this.lon]);
      this.selectedTempLabelMarker.setIcon(icon);
    }
    this.scheduleSelectedTemperatureLabelHide();
  }

  private resetSelectedTemperatureLabelDisplay(): void {
    this.selectedTempLabelDismissed = false;
    this.selectedTempLabelHideToken++;
  }

  private scheduleSelectedTemperatureLabelHide(): void {
    const token = ++this.selectedTempLabelHideToken;
    setTimeout(() => {
      if (token !== this.selectedTempLabelHideToken || this.selectedTempLabelDismissed) {
        return;
      }
      this.selectedTempLabelDismissed = true;
      this.removeSelectedTemperatureLabel();
    }, MeteoFranceComponent.SELECTED_TEMP_LABEL_HIDE_MS);
  }

  private removeSelectedTemperatureLabel(): void {
    this.selectedTempLabelHideToken++;
    if (this.selectedTempLabelMarker && this.map) {
      this.map.removeLayer(this.selectedTempLabelMarker);
      this.selectedTempLabelMarker = null;
    }
  }

  formatTemperatureLabel(valueCelsius: number): string {
    const unit = this.temperatureUnit === 'fahrenheit' ? '°F' : '°C';
    const value = this.temperatureUnit === 'fahrenheit'
      ? Math.round(valueCelsius * 9 / 5 + 32)
      : Math.round(valueCelsius * 10) / 10;
    return `${value}${unit}`;
  }

  private buildSelectedTemperatureLabelIcon(tempC: number): {
    html: string;
    width: number;
    height: number;
  } {
    const tempLabel = this.formatTemperatureLabel(tempC);
    const locationName = this.resolveSelectedLocationName();
    let html: string;
    let textWidth: number;
    if (locationName) {
      html =
        `<span class="mf-temp-label-selected-inner">` +
        `<span class="mf-temp-label-temp">${tempLabel}</span>` +
        `<span class="mf-temp-label-city">${this.escapeHtml(locationName)}</span>` +
        `</span>`;
      textWidth = locationName.length + tempLabel.length + 3;
    } else {
      html = `<span>${tempLabel}</span>`;
      textWidth = tempLabel.length;
    }
    const width = Math.max(28, textWidth * 7 + 16);
    const height = locationName ? 34 : 20;
    return { html, width, height };
  }

  private resolveSelectedLocationName(): string {
    const name = this.selectedLocationName?.trim();
    if (name) {
      return name;
    }
    return this.formatGpsCoordinates(this.lat, this.lon);
  }

  private formatGpsCoordinates(lat: number, lon: number): string {
    return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  }

  private resolvePlaceNameFromGeocode(res: any, lat: number, lon: number): string {
    const address = res?.address;
    if (address && typeof address === 'object') {
      const placeKeys = [
        'city',
        'town',
        'village',
        'hamlet',
        'locality',
        'suburb',
        'neighbourhood',
        'neighborhood',
        'municipality',
        'county',
        'state',
        'region',
        'road',
        'pedestrian',
        'path',
        'park',
        'natural',
        'water',
        'peak',
        'island',
        'landuse',
      ];
      for (const key of placeKeys) {
        const value = this.readAddressField(address, key);
        if (value) {
          return value;
        }
      }
    }

    const displayName = String(res?.displayName || res?.display_name || '').trim();
    if (displayName && !this.looksLikeCoordinates(displayName)) {
      const firstPart = displayName.split(',')[0]?.trim();
      if (firstPart) {
        return firstPart;
      }
    }

    return this.formatGpsCoordinates(lat, lon);
  }

  private readAddressField(address: Record<string, unknown>, key: string): string {
    const raw = address[key];
    if (typeof raw !== 'string') {
      return '';
    }
    return raw.trim();
  }

  private looksLikeCoordinates(text: string): boolean {
    return /^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(text.trim());
  }

  private normalizeTemperatureGridPoint(point: any, responseCached = false): TemperatureGridPoint {
    return {
      lat: Number(point?.lat),
      lon: Number(point?.lon),
      tempC: Number(point?.tempC),
      stationId: point?.stationId,
      stationName: point?.stationName,
      humidityPct: this.toOptionalNumber(point?.humidityPct),
      windDirectionDeg: this.toOptionalNumber(point?.windDirectionDeg),
      windSpeedMs: this.toOptionalNumber(point?.windSpeedMs),
      windGustMs: this.toOptionalNumber(point?.windGustMs),
      dewPointC: this.toOptionalNumber(point?.dewPointC),
      precipitationMm: this.toOptionalNumber(point?.precipitationMm),
      pressureHpa: this.toOptionalNumber(point?.pressureHpa),
      observedAt: point?.observedAt,
      source: point?.source,
      interpolated: point?.interpolated === true,
      cached: point?.cached === true || responseCached
    };
  }

  private temperaturePointKey(point: TemperatureGridPoint): string {
    return point.stationId ?? `${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
  }

  private isTemperatureMapUiClick(event: Event | undefined): boolean {
    const target = event?.target as HTMLElement | null;
    return !!target?.closest('.mf-temp-tooltip, .mf-temp-label, .mf-temp-refresh-btn');
  }

  private readonly onTemperatureTooltipClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest('.mf-temp-refresh-btn') as HTMLElement | null;
    if (!button) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const key = button.getAttribute('data-temp-key');
    if (key) {
      this.refreshTemperaturePointByKey(key);
    }
  };

  private refreshTemperaturePointByKey(key: string): void {
    const point = this.temperatureGridPoints.find((p) => this.temperaturePointKey(p) === key);
    if (!point || this.refreshingTemperatureKeys.has(key)) {
      return;
    }
    this.refreshingTemperatureKeys.add(key);
    this.subs.add(
      this.apiService.postWeatherTemperatureLabels(
        [{
          lat: point.lat,
          lon: point.lon,
          stationId: point.stationId
        }],
        'meteofrance',
        true
      ).subscribe({
        next: (data) => {
          this.refreshingTemperatureKeys.delete(key);
          const updated = data?.points?.[0];
          if (!updated || data?.error) {
            return;
          }
          const normalized = this.normalizeTemperatureGridPoint(updated, false);
          const index = this.temperatureGridPoints.findIndex((p) => this.temperaturePointKey(p) === key);
          if (index >= 0) {
            this.temperatureGridPoints[index] = normalized;
          }
          this.temperatureLabelsFromCache = false;
          this.temperatureLabelsUpdatedAt = new Date();
          this.temperatureLabelSource = 'meteofrance-dpobs';
          this.renderTemperatureLabels();
        },
        error: () => {
          this.refreshingTemperatureKeys.delete(key);
        }
      })
    );
  }

  private toOptionalNumber(value: unknown): number | undefined {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }

  private buildTemperatureLabelTooltip(point: TemperatureGridPoint): string {
    const lines: string[] = [];
    const stationTitle = this.resolveStationTooltipTitle(point);
    lines.push(`<div class="mf-temp-tooltip-title">${this.escapeHtml(stationTitle)}</div>`);
    if (point.stationName && point.stationId) {
      lines.push(`<div class="mf-temp-tooltip-meta">${this.escapeHtml(point.stationId)}</div>`);
    }

    if (point.interpolated) {
      lines.push(`<div class="mf-temp-tooltip-meta">${this.escapeHtml(this.translate.instant('METEO_FRANCE.TOOLTIP_INTERPOLATED'))}</div>`);
    }

    lines.push(this.tooltipRow(
      this.translate.instant('METEO_FRANCE.TEMPERATURE'),
      this.formatTemperatureLabel(point.tempC)
    ));

    if (point.humidityPct != null) {
      lines.push(this.tooltipRow(
        this.translate.instant('METEO_FRANCE.HUMIDITY'),
        `${Math.round(point.humidityPct)}%`
      ));
    }
    if (point.dewPointC != null) {
      lines.push(this.tooltipRow(
        this.translate.instant('METEO_FRANCE.TOOLTIP_DEWPOINT'),
        this.formatTemperatureLabel(point.dewPointC)
      ));
    }
    if (point.windSpeedMs != null) {
      const wind = point.windDirectionDeg != null
        ? `${point.windSpeedMs} m/s (${Math.round(point.windDirectionDeg)}°)`
        : `${point.windSpeedMs} m/s`;
      lines.push(this.tooltipRow(this.translate.instant('METEO_FRANCE.WIND'), wind));
    }
    if (point.windGustMs != null) {
      lines.push(this.tooltipRow(
        this.translate.instant('METEO_FRANCE.TOOLTIP_WIND_GUST'),
        `${point.windGustMs} m/s`
      ));
    }
    if (point.precipitationMm != null) {
      lines.push(this.tooltipRow(
        this.translate.instant('METEO_FRANCE.PRECIP'),
        `${point.precipitationMm} mm`
      ));
    }
    if (point.pressureHpa != null) {
      lines.push(this.tooltipRow(
        this.translate.instant('METEO_FRANCE.PRESSURE'),
        `${point.pressureHpa} hPa`
      ));
    }
    if (point.observedAt) {
      lines.push(this.tooltipRow(
        this.translate.instant('METEO_FRANCE.TOOLTIP_OBSERVED_AT'),
        this.escapeHtml(this.formatObservedAt(point.observedAt))
      ));
    }

    if (point.cached) {
      lines.push(`<div class="mf-temp-tooltip-meta">${this.escapeHtml(this.translate.instant('METEO_FRANCE.TEMPERATURE_TOOLTIP_CACHED'))}</div>`);
      const key = this.escapeHtml(this.temperaturePointKey(point));
      const refreshing = this.refreshingTemperatureKeys.has(this.temperaturePointKey(point));
      const label = refreshing
        ? this.escapeHtml(this.translate.instant('METEO_FRANCE.TEMPERATURE_TOOLTIP_REFRESHING'))
        : this.escapeHtml(this.translate.instant('METEO_FRANCE.TEMPERATURE_TOOLTIP_REFRESH'));
      lines.push(
        `<div class="mf-temp-tooltip-actions">` +
        `<button type="button" class="mf-temp-refresh-btn btn btn-sm btn-outline-primary" ` +
        `data-temp-key="${key}"${refreshing ? ' disabled' : ''}>${label}</button>` +
        `</div>`
      );
    }

    return lines.join('');
  }

  private resolveStationTooltipTitle(point: TemperatureGridPoint): string {
    const name = point.stationName?.trim();
    if (name) {
      return name;
    }
    if (point.stationId) {
      return `${this.translate.instant('METEO_FRANCE.TOOLTIP_STATION')} ${point.stationId}`;
    }
    const isMf = point.source === 'meteofrance-dpobs';
    return this.translate.instant(isMf ? 'METEO_FRANCE.TOOLTIP_STATION_MF' : 'METEO_FRANCE.TOOLTIP_OPENMETEO');
  }

  private tooltipRow(label: string, value: string): string {
    return `<div class="mf-temp-tooltip-row"><span>${this.escapeHtml(label)}</span><strong>${value}</strong></div>`;
  }

  private formatObservedAt(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString();
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private resolveSelectedTemperatureCelsius(): number | null {
    if (this.selectedPointTempC != null && Number.isFinite(this.selectedPointTempC)) {
      return this.selectedPointTempC;
    }
    if (this.temperatureDataSource === 'meteofrance') {
      return this.findNearestGridTempC(this.lat, this.lon);
    }
    const tempC = this.currentWeather?.main?.temp;
    return tempC != null && Number.isFinite(tempC) ? tempC : null;
  }

  private fetchSelectedPointTemperature(lat: number, lon: number): void {
    if (!this.showTemperatureMap) {
      this.selectedPointTempC = null;
      this.removeSelectedTemperatureLabel();
      return;
    }
    this.resetSelectedTemperatureLabelDisplay();
    const requestId = ++this.selectedTempRequestId;
    const interim = this.findNearestGridTempC(lat, lon);
    if (interim != null) {
      this.selectedPointTempC = interim;
      this.updateSelectedTemperatureLabel();
    }

    this.subs.add(
      this.apiService.postWeatherTemperatureLabels([{ lat, lon }], this.temperatureDataSource).subscribe({
        next: (data) => {
          if (requestId !== this.selectedTempRequestId || !this.showTemperatureMap) {
            return;
          }
          const raw = data?.points?.[0]?.tempC;
          const tempC = raw != null ? Number(raw) : NaN;
          if (Number.isFinite(tempC)) {
            this.selectedPointTempC = tempC;
          } else if (this.temperatureDataSource === 'open-meteo') {
            const owm = this.currentWeather?.main?.temp;
            this.selectedPointTempC = owm != null && Number.isFinite(owm) ? owm : interim;
          } else {
            this.selectedPointTempC = this.findNearestGridTempC(lat, lon) ?? interim;
          }
          this.updateSelectedTemperatureLabel();
        },
        error: () => {
          if (requestId !== this.selectedTempRequestId || !this.showTemperatureMap) {
            return;
          }
          if (this.temperatureDataSource === 'open-meteo') {
            const owm = this.currentWeather?.main?.temp;
            this.selectedPointTempC = owm != null && Number.isFinite(owm) ? owm : interim;
          } else {
            this.selectedPointTempC = this.findNearestGridTempC(lat, lon) ?? interim;
          }
          this.updateSelectedTemperatureLabel();
        }
      })
    );
  }

  private findNearestGridPoint(lat: number, lon: number): TemperatureGridPoint | null {
    if (!this.temperatureGridPoints.length) {
      return null;
    }
    let best: TemperatureGridPoint | null = null;
    let bestDist = Infinity;
    for (const point of this.temperatureGridPoints) {
      const dist = (point.lat - lat) ** 2 + (point.lon - lon) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = point;
      }
    }
    return best;
  }

  private findNearestGridTempC(lat: number, lon: number): number | null {
    const point = this.findNearestGridPoint(lat, lon);
    if (point?.tempC == null || !Number.isFinite(point.tempC)) {
      return null;
    }
    return point.tempC;
  }

  onShowRadarChange(): void {
    this.setupRadarLayer();
    this.startRadarRefreshTimer();
  }

  toggleMapFullscreen(): void {
    const shell = this.mapShell?.nativeElement;
    if (!shell) {
      return;
    }
    if (this.mapFullscreen) {
      this.exitMapFullscreenIfActive();
      return;
    }
    const request = shell.requestFullscreen?.bind(shell)
      ?? (shell as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(shell);
    request?.().catch(() => {
      this.mapFullscreen = true;
      this.refreshMapLayoutAfterResize();
    });
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  onMapFullscreenChange(): void {
    const shell = this.mapShell?.nativeElement;
    const doc = document as Document & { webkitFullscreenElement?: Element };
    const active = !!(shell && (document.fullscreenElement === shell || doc.webkitFullscreenElement === shell));
    if (this.mapFullscreen === active) {
      return;
    }
    this.mapFullscreen = active;
    this.refreshMapLayoutAfterResize();
  }

  @HostListener('document:keydown.escape')
  onMapFullscreenEscape(): void {
    if (this.mapFullscreen) {
      this.exitMapFullscreenIfActive();
    }
  }

  private exitMapFullscreenIfActive(): void {
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void> };
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(document);
      exit?.().catch(() => {
        this.mapFullscreen = false;
        this.refreshMapLayoutAfterResize();
      });
      return;
    }
    if (this.mapFullscreen) {
      this.mapFullscreen = false;
      this.refreshMapLayoutAfterResize();
    }
  }

  private refreshMapLayoutAfterResize(): void {
    setTimeout(() => {
      this.map?.invalidateSize();
      if (this.showTemperatureMap) {
        if (this.temperatureGridPoints.length) {
          this.renderTemperatureLabels();
        } else {
          this.scheduleTemperatureLabelsLoad();
        }
      }
    }, 120);
  }

  onMainTabChange(tab: 'radar' | 'clim'): void {
    this.activeMainTab = tab;
    if (tab === 'radar') {
      setTimeout(() => {
        this.map?.invalidateSize();
        this.setupRadarLayer();
        this.setupTemperatureLabels();
      }, 0);
    } else if (tab === 'clim') {
      setTimeout(() => {
        if (this.climAvailable && !this.isLoadingClim) {
          if (!this.climData && !this.climErrorKey) {
            this.loadClimData(this.climSelectedStationId || undefined);
          } else if (this.climDisplayRows.length) {
            this.updateClimCharts();
          }
        }
      }, 0);
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
    this.selectedLocationName = this.formatGpsCoordinates(lat, lon);
    this.errorMessage = '';
    if (this.marker) {
      this.marker.setLatLng([lat, lon]);
    }
    if (moveMap && this.map) {
      this.map.setView([lat, lon], Math.max(this.map.getZoom(), 8));
    }
    if (this.showTemperatureMap) {
      this.fetchSelectedPointTemperature(lat, lon);
      this.updateSelectedTemperatureLabel();
    }
    this.reverseGeocode(lat, lon);
    this.refreshWeather();
    if (this.activeMainTab === 'clim') {
      this.loadClimData();
    }
  }

  private reverseGeocode(lat: number, lon: number): void {
    const requestId = ++this.reverseGeocodeRequestId;
    this.subs.add(
      this.apiService.geocodeReverse(lat, lon).subscribe({
        next: (res) => {
          if (requestId !== this.reverseGeocodeRequestId) {
            return;
          }
          this.fullAddress = res?.displayName || res?.display_name || '';
          this.selectedLocationName = this.resolvePlaceNameFromGeocode(res, lat, lon);
          const address = res?.address;
          const cityName = address
            ? this.readAddressField(address, 'city')
              || this.readAddressField(address, 'town')
              || this.readAddressField(address, 'village')
              || this.readAddressField(address, 'hamlet')
              || this.readAddressField(address, 'locality')
              || this.readAddressField(address, 'municipality')
            : '';
          if (cityName) {
            this.city = cityName;
          }
          if (address?.country_code) {
            this.countryCode = String(address.country_code).toUpperCase();
          }
          const postcode = address?.postcode || address?.postal_code;
          if (postcode) {
            this.departmentCode = this.departmentFromPostcode(String(postcode));
          }
          if (this.showTemperatureMap) {
            this.updateSelectedTemperatureLabel();
          }
        },
        error: () => {
          if (requestId !== this.reverseGeocodeRequestId) {
            return;
          }
          this.selectedLocationName = this.formatGpsCoordinates(lat, lon);
          if (this.showTemperatureMap) {
            this.updateSelectedTemperatureLabel();
          }
        }
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
    this.climErrorDetail = '';
    this.climAttemptedStation = null;
    const days = this.climFrequency === 'horaire' ? Math.min(this.climDays, 31) : this.climDays;
    this.setClimPeriodPreview(days);
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
          this.applyClimPeriodFromResponse(data);
          if (data?.department) {
            this.departmentCode = data.department;
            this.loadClimStations(data.department);
          }
          if (data?.station) {
            this.climAttemptedStation = data.station;
          }
          if (data?.error) {
            this.climData = null;
            this.climChartsReady = false;
            this.climErrorKey = 'METEO_FRANCE.CLIM_LOAD_ERROR';
            this.climErrorDetail = data.details || data.error || '';
            if (data?.station?.id) {
              this.climSelectedStationId = data.station.id;
            }
            setTimeout(() => this.updateClimCharts(), 0);
            return;
          }
          this.climData = data;
          this.climSelectedStationId = data?.station?.id || '';
          setTimeout(() => this.updateClimCharts(), 0);
        },
        error: () => {
          this.isLoadingClim = false;
          this.climData = null;
          this.climChartsReady = false;
          this.climErrorKey = 'METEO_FRANCE.CLIM_LOAD_ERROR';
          this.climErrorDetail = '';
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
    const options = this.climPeriodOptions;
    const stillValid = options.some((o) => o.days === this.climDays);
    if (!stillValid) {
      this.climDays = this.climFrequency === 'horaire' ? 7 : 30;
    }
    this.loadClimData(this.climSelectedStationId || undefined);
  }

  onClimPeriodChange(): void {
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

  private buildClimTempChartOptions(): ChartOptions<'line'> {
    const unit = () => (this.temperatureUnit === 'fahrenheit' ? '°F' : '°C');
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const y = ctx.parsed.y;
              if (y == null || Number.isNaN(y)) {
                return `${ctx.dataset.label}: —`;
              }
              return `${ctx.dataset.label}: ${y.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit()}`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12, maxRotation: 45, minRotation: 0 } },
        y: {
          title: { display: true, text: unit() },
          ticks: {
            callback: (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })
          }
        }
      }
    };
  }

  private buildClimRainChartOptions(): ChartOptions<'bar'> {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const y = ctx.parsed.y;
              if (y == null || Number.isNaN(y)) {
                return '—';
              }
              return `${y.toLocaleString(undefined, { maximumFractionDigits: 1 })} mm`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12, maxRotation: 45, minRotation: 0 } },
        y: {
          beginAtZero: true,
          title: { display: true, text: 'mm' },
          ticks: {
            callback: (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })
          }
        }
      }
    };
  }

  private updateClimCharts(): void {
    const rows = this.getSortedClimRows();
    if (!rows.length) {
      this.climChartsReady = false;
      this.climTempChartData = { labels: [], datasets: [] };
      this.climRainChartData = { labels: [], datasets: [] };
      this.climTempChart?.update();
      this.climRainChart?.update();
      return;
    }

    const labels = rows.map((row) => this.climRowDateLabel(row));
    const tnKey = rows.some((r) => this.parseClimNumber(r.TN) != null) ? 'TN' : 'TNT';
    const hasTn = rows.some((r) => this.parseClimNumber(r[tnKey]) != null);
    const hasTx = rows.some((r) => this.parseClimNumber(r.TX) != null);
    const hasTm = rows.some((r) => this.parseClimNumber(r.TM) != null);
    const hasRr = rows.some((r) => this.parseClimNumber(r.RR) != null);

    const tempDatasets: ChartConfiguration<'line'>['data']['datasets'] = [];
    if (hasTn) {
      tempDatasets.push({
        label: this.translate.instant('METEO_FRANCE.CLIM_COL_TN'),
        data: rows.map((r) => this.tempChartValue(r[tnKey])),
        borderColor: '#2563eb',
        backgroundColor: 'rgba(37, 99, 235, 0.12)',
        tension: 0.25,
        pointRadius: rows.length > 60 ? 0 : 2,
        spanGaps: true
      });
    }
    if (hasTx) {
      tempDatasets.push({
        label: this.translate.instant('METEO_FRANCE.CLIM_COL_TX'),
        data: rows.map((r) => this.tempChartValue(r.TX)),
        borderColor: '#dc2626',
        backgroundColor: 'rgba(220, 38, 38, 0.12)',
        tension: 0.25,
        pointRadius: rows.length > 60 ? 0 : 2,
        spanGaps: true
      });
    }
    if (hasTm) {
      tempDatasets.push({
        label: this.translate.instant('METEO_FRANCE.CLIM_COL_TM'),
        data: rows.map((r) => this.tempChartValue(r.TM)),
        borderColor: '#ca8a04',
        backgroundColor: 'rgba(202, 138, 4, 0.12)',
        tension: 0.25,
        pointRadius: rows.length > 60 ? 0 : 2,
        spanGaps: true
      });
    }

    this.climTempChartOptions = this.buildClimTempChartOptions();
    this.climRainChartOptions = this.buildClimRainChartOptions();
    this.climTempChartData = { labels, datasets: tempDatasets };
    this.climRainChartData = {
      labels,
      datasets: [{
        label: this.translate.instant('METEO_FRANCE.CLIM_COL_RR'),
        data: hasRr ? rows.map((r) => this.parseClimNumber(r.RR)) : [],
        backgroundColor: 'rgba(14, 165, 233, 0.55)',
        borderColor: '#0284c7',
        borderWidth: 1
      }]
    };
    this.climChartsReady = tempDatasets.length > 0 || hasRr;
    this.climTempChart?.update();
    this.climRainChart?.update();
  }

  private getSortedClimRows(): any[] {
    return [...this.climDisplayRows].sort((a, b) =>
      this.climRowSortKey(a).localeCompare(this.climRowSortKey(b))
    );
  }

  private climRowSortKey(row: any): string {
    const raw = row.DATE ?? row.AAAAMMJJ ?? row.AAAAMMJJHH;
    return raw != null ? String(raw).trim() : '';
  }

  private climRowDateLabel(row: any): string {
    const raw = row.DATE ?? row.AAAAMMJJ ?? row.AAAAMMJJHH;
    return this.formatClimDate(raw != null ? String(raw) : undefined);
  }

  private parseClimNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const normalized = String(value).trim().replace(',', '.');
    const num = Number(normalized);
    return Number.isFinite(num) ? num : null;
  }

  private tempChartValue(value: unknown): number | null {
    const celsius = this.parseClimNumber(value);
    if (celsius == null) {
      return null;
    }
    return Math.round(this.celsiusToDisplay(celsius) * 10) / 10;
  }

  private setClimPeriodPreview(days: number): void {
    const hourly = this.climFrequency === 'horaire';
    const dateFmt = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
    const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    const now = new Date();
    if (hourly) {
      this.climPeriodEnd = dateTimeFmt.format(now);
      const start = new Date(now.getTime() - (days - 1) * 86_400_000);
      this.climPeriodStart = dateFmt.format(start);
    } else {
      const yesterday = new Date(now.getTime() - 86_400_000);
      const start = new Date(now.getTime() - days * 86_400_000);
      this.climPeriodEnd = dateFmt.format(yesterday);
      this.climPeriodStart = dateFmt.format(start);
    }
    this.climRequestedDays = days;
  }

  private applyClimPeriodFromResponse(data: any): void {
    if (!data) {
      return;
    }
    const hourly = data.frequency === 'horaire';
    if (data.periodStart) {
      this.climPeriodStart = this.formatClimPeriodIso(data.periodStart, hourly);
    }
    if (data.periodEnd) {
      this.climPeriodEnd = this.formatClimPeriodIso(data.periodEnd, hourly);
    }
    if (data.requestedDays != null) {
      this.climRequestedDays = Number(data.requestedDays);
    }
  }

  private formatClimPeriodIso(iso: string, hourly: boolean): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return iso;
    }
    const opts: Intl.DateTimeFormatOptions = {
      timeZone: 'Europe/Paris',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    };
    if (hourly) {
      return d.toLocaleString('fr-FR', { ...opts, hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('fr-FR', opts);
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
          if (this.showTemperatureMap) {
            if (this.temperatureDataSource === 'open-meteo' && this.selectedPointTempC == null) {
              const tempC = data?.main?.temp;
              if (tempC != null && Number.isFinite(tempC)) {
                this.selectedPointTempC = tempC;
              }
            }
            this.updateSelectedTemperatureLabel();
            this.scheduleTemperatureLabelsLoad();
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
    const display = this.celsiusToDisplay(value);
    const rounded = Math.round(display * 10) / 10;
    const unit = this.temperatureUnit === 'fahrenheit' ? '°F' : '°C';
    return `${rounded} ${unit}`;
  }

  formatClimValue(column: string, value: unknown): string {
    if (value === null || value === undefined || value === '') {
      return '—';
    }
    if (MeteoFranceComponent.CLIM_TEMP_COLUMNS.has(column)) {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return this.formatTemperature(num);
      }
    }
    return String(value);
  }

  onTemperatureUnitChange(unit: TemperatureUnit): void {
    if (this.temperatureUnit === unit) {
      return;
    }
    this.temperatureUnit = unit;
    try {
      localStorage.setItem(MeteoFranceComponent.TEMP_UNIT_STORAGE_KEY, unit);
    } catch { /* private mode */ }
    this.updateSelectedTemperatureLabel();
    this.renderTemperatureLabels();
    if (this.climDisplayRows.length) {
      this.updateClimCharts();
    }
  }

  private loadTemperatureUnitPreference(): void {
    try {
      const stored = localStorage.getItem(MeteoFranceComponent.TEMP_UNIT_STORAGE_KEY);
      if (stored === 'celsius' || stored === 'fahrenheit') {
        this.temperatureUnit = stored;
      }
    } catch { /* private mode */ }
  }

  private loadTemperatureDataSourcePreference(): void {
    try {
      const stored = localStorage.getItem(MeteoFranceComponent.TEMP_SOURCE_STORAGE_KEY);
      if (stored === 'meteofrance' || stored === 'open-meteo') {
        this.temperatureDataSource = stored;
      }
    } catch { /* private mode */ }
  }

  private celsiusToDisplay(valueCelsius: number): number {
    if (this.temperatureUnit === 'fahrenheit') {
      return valueCelsius * 9 / 5 + 32;
    }
    return valueCelsius;
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
