import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { ApiService } from '../services/api.service';
import { LeafletBasemapOption, LeafletBasemapService } from '../shared/leaflet-basemap.service';
import { environment } from '../../environments/environment';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions, registerables } from 'chart.js';
import * as L from 'leaflet';
import { catchError, of, Subscription } from 'rxjs';

Chart.register(...registerables);

type TemperatureUnit = 'celsius' | 'fahrenheit';
type WeatherDataSourceBrand = 'meteofrance' | 'open-meteo' | 'openweathermap';
type WeatherPanelSource = 'openweathermap' | 'open-meteo' | 'meteofrance';
type RadarLayerSource = 'meteofrance' | 'rainviewer';
type CloudLayerSource = 'openweathermap' | 'rainviewer';

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

type MeteoBackendLogStatus = 'loading' | 'ok' | 'error';

interface MeteoBackendLogEntry {
  id: number;
  at: Date;
  categoryKey: string;
  sourceKey: string;
  status: MeteoBackendLogStatus;
  detail?: string;
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
  private static readonly BACKEND_LOG_STORAGE_KEY = 'meteo-france.show-backend-log';
  private static readonly TEMP_TOOLTIPS_STORAGE_KEY = 'meteo-france.show-temperature-tooltips';
  private static readonly CURRENT_WEATHER_SOURCE_STORAGE_KEY = 'meteo-france.current-weather-source';
  private static readonly CURRENT_WEATHER_SOURCE_FR_STORAGE_KEY = 'meteo-france.current-weather-source.fr';
  private static readonly CURRENT_WEATHER_SOURCE_ABROAD_STORAGE_KEY = 'meteo-france.current-weather-source.abroad';
  private static readonly FORECAST_WEATHER_SOURCE_STORAGE_KEY = 'meteo-france.forecast-weather-source';
  private static readonly RADAR_LAYER_SOURCE_STORAGE_KEY = 'meteo-france.radar-layer-source';
  private static readonly CLOUD_LAYER_SOURCE_STORAGE_KEY = 'meteo-france.cloud-layer-source';
  private static readonly MAP_BASE_LAYER_STORAGE_KEY = 'meteo-france.map-base-layer';
  private static readonly LOGO_MF = 'assets/images/meteofrance-logo.svg';
  private static readonly LOGO_OPEN_METEO = 'assets/images/open-meteo-logo.svg';
  private static readonly LOGO_OWM = 'assets/images/openweathermap-logo.svg';
  private static readonly MF_OBS_VIEWPORT_BOUNDS = {
    south: 42.0,
    north: 51.2,
    west: -5.2,
    east: 8.5,
  };
  private static readonly TEMP_LABEL_LOGO_EXTRA_PX = 24;
  /** Default zoom for the rain-radar map — centered on the selected position. */
  private static readonly RADAR_MAP_ZOOM = 13;
  private static readonly CLIM_TEMP_COLUMNS = new Set(['TN', 'TNT', 'TX', 'TM']);

  @ViewChild('climTempChart') climTempChart?: BaseChartDirective;
  @ViewChild('climRainChart') climRainChart?: BaseChartDirective;
  @ViewChild('mapShell') mapShell?: ElementRef<HTMLElement>;
  @ViewChild('aromepiMapShell') aromepiMapShell?: ElementRef<HTMLElement>;

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
    private translate: TranslateService,
    private basemapService: LeafletBasemapService
  ) {}

  city = '';
  countryCode = '';
  lat = 48.8566;
  lon = 2.3522;
  fullAddress = '';

  currentWeather: any = null;
  forecast: any = null;
  displayForecastList: any[] = [];
  forecastDisplayMode: 'hourly' | 'daily' = 'hourly';
  currentWeatherSource: WeatherPanelSource = 'meteofrance';
  forecastWeatherSource: WeatherPanelSource = 'openweathermap';
  readonly weatherPanelSources: WeatherPanelSource[] = ['openweathermap', 'open-meteo', 'meteofrance'];
  radarLayerSource: RadarLayerSource = 'rainviewer';
  cloudLayerSource: CloudLayerSource = 'openweathermap';
  readonly radarLayerSources: RadarLayerSource[] = ['meteofrance', 'rainviewer'];
  readonly cloudLayerSources: CloudLayerSource[] = ['openweathermap', 'rainviewer'];
  mapBaseLayerId = 'osm-standard';
  forecastErrorKey = '';

  mfStatus: any = null;
  radarValidityTime: string | null = null;
  radarDisplaySource: 'mf' | 'rainviewer' | null = null;
  radarLoadError = false;
  private mfWmsFallbackAttempted = false;
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
  cloudOpacity = 0.45;
  cloudIntensity = 1.5;
  readonly cloudIntensityMin = 0.5;
  readonly cloudIntensityMax = 8;
  showTemperatureMap = true;
  showTemperatureTooltips = false;
  isLoadingTemperatureLabels = false;
  temperatureLabelSource: 'meteofrance-dpobs' | 'open-meteo' | null = null;
  temperatureLabelsFromCache = false;
  temperatureLabelsUpdatedAt: Date | null = null;
  temperatureLabelsDetailLevel: string | null = null;
  temperatureLabelsCount = 0;
  temperatureLabelsCacheTtlMinutes: number | null = null;
  temperatureLabelsRefreshTrigger: 'initial' | 'pan' | 'zoom' | null = null;
  temperatureLabelsErrorKey = '';
  temperatureUnit: TemperatureUnit = 'celsius';
  mapFullscreen = false;
  autoRefreshRadar = true;
  activeMainTab: 'radar' | 'clim' | 'aromepi' = 'radar';
  radarRefreshSeconds = 60;
  readonly radarRefreshMinSeconds = 30;
  readonly radarRefreshMaxSeconds = 600;
  temperatureCacheMinutes = 5;
  readonly temperatureCacheMinMinutes = 1;
  readonly temperatureCacheMaxMinutes = 120;
  isClearingTemperatureCache = false;

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
  private climDataLocationKey = '';

  aromepiCapabilities: any = null;
  aromepiLayers: Array<{ name: string; title: string; style?: string; category?: string }> = [];
  aromepiSelectedLayer = '';
  aromepiSelectedStyle = '';
  aromepiTimeSteps: string[] = [];
  aromepiReferenceTime = '';
  aromepiFrameIndex = 0;
  aromepiOpacity = 0.72;
  aromepiPlaying = false;
  aromepiPlayIntervalMs = 900;
  aromepiMapFullscreen = false;
  isLoadingAromepiCapabilities = false;
  isLoadingAromepiForecast = false;
  aromepiErrorKey = '';
  aromepiPointForecast: any = null;
  aromepiCurrentValues: Record<string, unknown> = {};
  aromepiLoadError = false;

  showBackendLog = false;
  backendLogs: MeteoBackendLogEntry[] = [];
  private backendLogSeq = 0;
  private static readonly BACKEND_LOG_MAX = 120;
  private map: L.Map | null = null;
  private activeBaseLayer: L.TileLayer | L.LayerGroup | null = null;
  private marker: L.Marker | null = null;
  private mosaicOverlay: L.ImageOverlay | null = null;
  private mfWmsRadarLayer: L.TileLayer | null = null;
  private rainViewerLayer: L.TileLayer | null = null;
  private rainViewerCloudLayer: L.TileLayer | null = null;
  private temperatureLabelsLayer: L.LayerGroup | null = null;
  private selectedTempLabelMarker: L.Marker | null = null;
  private selectedTempLabelDismissed = false;
  private selectedPointTempC: number | null = null;
  private selectedPointMfTempC: number | null = null;
  private selectedPointUsesMf = false;
  private selectedPointMfStation: { id?: string; name?: string } | null = null;
  private selectedPointMfStationDistKm: number | null = null;
  private selectedPointOpenMeteoTempC: number | null = null;
  private selectedPointOpenWeatherTempC: number | null = null;
  private selectedPointMfObservedAt: string | null = null;
  private selectedPointOpenMeteoObservedAt: string | null = null;
  private selectedPointOpenWeatherObservedAt: string | null = null;
  private selectedPointOpenWeatherPlace: string | null = null;
  private selectedPointOpenWeatherDistKm: number | null = null;
  private selectedPointComparisonReady = false;
  private selectedPointComparisonLoading = false;
  private selectedLocationName = '';
  private reverseGeocodeRequestId = 0;
  private weatherRequestId = 0;
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
  private aromepiMap: L.Map | null = null;
  private aromepiMarker: L.Marker | null = null;
  private aromepiWmsLayer: L.TileLayer | null = null;
  private aromepiMapInitialized = false;
  private aromepiPlayTimer: ReturnType<typeof setInterval> | null = null;
  private aromepiForecastDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.loadTemperatureUnitPreference();
    this.loadBackendLogPreference();
    this.loadTemperatureTooltipsPreference();
    this.fixLeafletIcons();
    this.loadMeteoFranceStatus();
    this.loadRadarPreferences();
    this.loadTemperatureCachePreferences();
    this.mapBaseLayerId = this.readMapBaseLayerPreference();
    this.basemapService.loadOptionalLayers(this.apiService);
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
      this.syncWeatherSourcePreferences();
      this.syncMapLayerSourcePreferences();
      this.refreshMfTemperatureAvailability();
      this.isLoadingGps = false;
      setTimeout(() => this.initMap(), 0);
    });
  }

  private migrateLegacyCurrentWeatherSourceStorage(): void {
    try {
      const legacy = localStorage.getItem(MeteoFranceComponent.CURRENT_WEATHER_SOURCE_STORAGE_KEY);
      if (legacy !== 'openweathermap' && legacy !== 'open-meteo' && legacy !== 'meteofrance') {
        return;
      }
      const frKey = MeteoFranceComponent.CURRENT_WEATHER_SOURCE_FR_STORAGE_KEY;
      const abroadKey = MeteoFranceComponent.CURRENT_WEATHER_SOURCE_ABROAD_STORAGE_KEY;
      if (localStorage.getItem(frKey) || localStorage.getItem(abroadKey)) {
        localStorage.removeItem(MeteoFranceComponent.CURRENT_WEATHER_SOURCE_STORAGE_KEY);
        return;
      }
      if (legacy === 'meteofrance') {
        localStorage.setItem(frKey, legacy);
      } else {
        localStorage.setItem(abroadKey, legacy);
      }
      localStorage.removeItem(MeteoFranceComponent.CURRENT_WEATHER_SOURCE_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  ngOnDestroy(): void {
    this.exitMapFullscreenIfActive();
    this.exitAromepiMapFullscreenIfActive();
    this.temperatureLabelsLoadSub?.unsubscribe();
    this.subs.unsubscribe();
    this.clearRadarTimers();
    this.stopAromepiAnimation();
    if (this.aromepiForecastDebounceTimer) {
      clearTimeout(this.aromepiForecastDebounceTimer);
      this.aromepiForecastDebounceTimer = null;
    }
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
    if (this.aromepiMap) {
      this.aromepiMap.remove();
      this.aromepiMap = null;
    }
  }

  get radarAvailable(): boolean {
    return this.mfStatus?.wmsAvailable === true || this.mfStatus?.authValid === true;
  }

  get isSelectedRadarSourceAvailable(): boolean {
    return this.radarLayerSource === 'rainviewer' || this.radarAvailable;
  }

  get availableRadarLayerSources(): RadarLayerSource[] {
    if (this.isLocationInFrance() && this.radarAvailable) {
      return this.radarLayerSources;
    }
    return this.radarLayerSources.filter((source) => source !== 'meteofrance');
  }

  get temperatureMapAvailable(): boolean {
    return this.mapInitialized;
  }

  get obsAvailable(): boolean {
    return this.mfStatus?.dpobsAuthValid === true;
  }

  get isFranceLocation(): boolean {
    return (this.countryCode || '').toUpperCase() === 'FR';
  }

  /** MF DPObs station markers on the map (France métropole viewport). */
  get showMapTemperatureGrid(): boolean {
    return this.showTemperatureMap && this.isLocationInFrance() && this.isMapViewportServedByMfObs();
  }

  /** Click comparison includes MF only when the selected position is in France. */
  get showMfInPointComparison(): boolean {
    return this.showTemperatureMap && this.isMfTemperaturePointAllowed();
  }

  get isPositionInFrance(): boolean {
    return this.isLocationInFrance();
  }

  get availableWeatherPanelSources(): WeatherPanelSource[] {
    if (this.isLocationInFrance()) {
      return this.weatherPanelSources;
    }
    return this.weatherPanelSources.filter((source) => source !== 'meteofrance');
  }

  private shouldShowMfStationLabels(): boolean {
    return this.showMapTemperatureGrid;
  }

  private isMfStationLabelPoint(point: TemperatureGridPoint): boolean {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || !Number.isFinite(point.tempC)) {
      return false;
    }
    if (point.interpolated) {
      return false;
    }
    if (point.stationId) {
      return true;
    }
    const source = String(point.source || '').toLowerCase();
    return source.includes('meteofrance');
  }

  private filterMfStationLabelPoints(points: TemperatureGridPoint[]): TemperatureGridPoint[] {
    return points.filter((point) => this.isMfStationLabelPoint(point));
  }

  private clearMapTemperatureGrid(): void {
    this.temperatureLabelsLoadSub?.unsubscribe();
    this.temperatureLabelsLoadSub = null;
    this.temperatureGridPoints = [];
    this.temperatureLabelSource = null;
    this.temperatureLabelsUpdatedAt = null;
    this.temperatureLabelsCount = 0;
    this.temperatureLabelsErrorKey = '';
    this.isLoadingTemperatureLabels = false;
    this.temperatureLabelsLayer?.clearLayers();
  }

  private isMapViewportServedByMfObs(): boolean {
    if (!this.map) {
      return this.isLocationInFrance();
    }
    const center = this.map.getCenter();
    const b = MeteoFranceComponent.MF_OBS_VIEWPORT_BOUNDS;
    return center.lat >= b.south
      && center.lat <= b.north
      && center.lng >= b.west
      && center.lng <= b.east;
  }

  get obsStatusMessageKey(): string {
    if (!this.mfStatus || !this.showTemperatureMap || !this.isLocationInFrance() || !this.isMapViewportServedByMfObs()) {
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
    return this.showMapTemperatureGrid
      ? 'METEO_FRANCE.TEMPERATURE_MAP_HINT_MF'
      : 'METEO_FRANCE.TEMPERATURE_MAP_HINT_POINT_ONLY';
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
    if (this.showMapTemperatureGrid) {
      return this.translate.instant('METEO_FRANCE.TEMPERATURE_SOURCE_MF');
    }
    return this.translate.instant('METEO_FRANCE.TEMPERATURE_COMPARE_ABROAD');
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

  get temperatureMapBrandLogo(): string {
    return this.getBrandLogoSrc(this.resolveMapTemperatureBrand());
  }

  readonly openWeatherBrandLogo = MeteoFranceComponent.LOGO_OWM;
  readonly meteoFranceBrandLogo = MeteoFranceComponent.LOGO_MF;
  readonly openMeteoBrandLogo = MeteoFranceComponent.LOGO_OPEN_METEO;

  getBrandLogoSrc(brand: WeatherDataSourceBrand): string {
    switch (brand) {
      case 'meteofrance':
        return MeteoFranceComponent.LOGO_MF;
      case 'openweathermap':
        return MeteoFranceComponent.LOGO_OWM;
      default:
        return MeteoFranceComponent.LOGO_OPEN_METEO;
    }
  }

  getBrandAlt(brand: WeatherDataSourceBrand): string {
    switch (brand) {
      case 'meteofrance':
        return 'Météo-France';
      case 'openweathermap':
        return 'OpenWeatherMap';
      default:
        return 'Open-Meteo';
    }
  }

  getBrandInitials(brand: WeatherDataSourceBrand): string {
    switch (brand) {
      case 'meteofrance':
        return 'MF';
      case 'openweathermap':
        return 'OWM';
      default:
        return 'OM';
    }
  }

  private getBrandSourceLabel(brand: WeatherDataSourceBrand): string {
    switch (brand) {
      case 'meteofrance':
        return this.translate.instant('METEO_FRANCE.LOG_SOURCE_MF_DPOBS');
      case 'openweathermap':
        return this.translate.instant('METEO_FRANCE.LOG_SOURCE_OWM');
      default:
        return this.translate.instant('METEO_FRANCE.LOG_SOURCE_OPEN_METEO');
    }
  }

  onShowTemperatureTooltipsChange(): void {
    try {
      localStorage.setItem(
        MeteoFranceComponent.TEMP_TOOLTIPS_STORAGE_KEY,
        String(this.showTemperatureTooltips)
      );
    } catch { /* private mode */ }
    this.renderTemperatureLabels();
  }

  private loadTemperatureTooltipsPreference(): void {
    try {
      const stored = localStorage.getItem(MeteoFranceComponent.TEMP_TOOLTIPS_STORAGE_KEY);
      if (stored === 'true' || stored === 'false') {
        this.showTemperatureTooltips = stored === 'true';
      }
    } catch { /* private mode */ }
  }

  onShowBackendLogChange(): void {
    if (!this.showBackendLog) {
      this.backendLogs = [];
    }
    try {
      localStorage.setItem(MeteoFranceComponent.BACKEND_LOG_STORAGE_KEY, String(this.showBackendLog));
    } catch { /* private mode */ }
  }

  private loadBackendLogPreference(): void {
    try {
      const stored = localStorage.getItem(MeteoFranceComponent.BACKEND_LOG_STORAGE_KEY);
      if (stored === 'true' || stored === 'false') {
        this.showBackendLog = stored === 'true';
      }
    } catch { /* private mode */ }
  }

  resolveMapTemperatureBrandForTemplate(): WeatherDataSourceBrand {
    return this.resolveMapTemperatureBrand();
  }

  private resolveMapTemperatureBrand(): WeatherDataSourceBrand {
    if (this.temperatureLabelSource === 'meteofrance-dpobs') {
      return 'meteofrance';
    }
    return 'open-meteo';
  }

  private resolvePointDataBrand(point: TemperatureGridPoint): WeatherDataSourceBrand {
    if (point.stationId || (point.source && point.source.includes('meteofrance'))) {
      return 'meteofrance';
    }
    return this.resolveMapTemperatureBrand();
  }

  private buildBrandLogoHtml(brand: WeatherDataSourceBrand, size = 14): string {
    const src = this.getBrandLogoSrc(brand);
    const alt = this.escapeHtml(this.getBrandAlt(brand));
    const mfClass = brand === 'meteofrance' ? ' mf-temp-source-logo--meteofrance' : '';
    return `<img class="mf-temp-source-logo${mfClass}" src="${src}" alt="${alt}" width="${size}" height="${size}" loading="lazy" />`;
  }

  private buildTemperatureLabelHtml(tempC: number, brand: WeatherDataSourceBrand): string {
    const value = this.formatTemperatureLabel(tempC);
    return (
      `<span class="mf-temp-label-inner">` +
      `${this.buildBrandLogoHtml(brand)}` +
      `<span class="mf-temp-label-value">${value}</span>` +
      `</span>`
    );
  }

  private estimateTemperatureLabelWidth(tempLabel: string): number {
    return Math.max(40, tempLabel.length * 7 + 12 + MeteoFranceComponent.TEMP_LABEL_LOGO_EXTRA_PX);
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

  get aromepiAvailable(): boolean {
    return this.mfStatus?.aromepiAuthValid === true;
  }

  get aromepiStatusMessageKey(): string {
    if (!this.mfStatus) {
      return '';
    }
    if (!this.mfStatus.aromepiConfigured) {
      return 'METEO_FRANCE.AROMEPI_NOT_CONFIGURED';
    }
    if (this.mfStatus.aromepiAuthValid === false) {
      return 'METEO_FRANCE.AROMEPI_INVALID_TOKEN';
    }
    return '';
  }

  get aromepiCurrentTime(): string {
    return this.aromepiTimeSteps[this.aromepiFrameIndex] || '';
  }

  get aromepiCurrentOffsetMinutes(): number {
    if (!this.aromepiReferenceTime || !this.aromepiCurrentTime) {
      return 0;
    }
    const ref = Date.parse(this.aromepiReferenceTime);
    const cur = Date.parse(this.aromepiCurrentTime);
    if (!Number.isFinite(ref) || !Number.isFinite(cur)) {
      return 0;
    }
    return Math.round((cur - ref) / 60_000);
  }

  get aromepiCloudLayers(): Array<{ name: string; title: string; style?: string; category?: string }> {
    return this.aromepiLayers.filter((l) => l.category === 'cloud');
  }

  get aromepiPrecipLayers(): Array<{ name: string; title: string; style?: string; category?: string }> {
    return this.aromepiLayers.filter((l) => l.category === 'precipitation');
  }

  get aromepiOtherLayers(): Array<{ name: string; title: string; style?: string; category?: string }> {
    return this.aromepiLayers.filter((l) => l.category !== 'cloud' && l.category !== 'precipitation');
  }

  get aromepiForecastSteps(): any[] {
    const steps = this.aromepiPointForecast?.steps;
    return Array.isArray(steps) ? steps : [];
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

  get availableMapBaseLayers(): LeafletBasemapOption[] {
    return this.basemapService.getAvailableLayers();
  }

  getMapBaseLayerLabel(layer: LeafletBasemapOption): string {
    return layer.labelKey ? this.translate.instant(layer.labelKey) : layer.label;
  }

  onMapBaseLayerChange(): void {
    this.persistMapBaseLayerPreference(this.mapBaseLayerId);
    this.applyMapBaseLayer();
  }

  private readMapBaseLayerPreference(): string {
    try {
      const raw = localStorage.getItem(MeteoFranceComponent.MAP_BASE_LAYER_STORAGE_KEY);
      if (raw && this.basemapService.isValidLayerId(raw)) {
        return raw;
      }
    } catch {
      /* ignore */
    }
    return 'osm-standard';
  }

  private persistMapBaseLayerPreference(layerId: string): void {
    try {
      localStorage.setItem(MeteoFranceComponent.MAP_BASE_LAYER_STORAGE_KEY, layerId);
    } catch {
      /* ignore */
    }
  }

  private applyMapBaseLayer(): void {
    if (!this.map) {
      return;
    }
    this.activeBaseLayer = this.basemapService.applyBaseLayer(
      this.map,
      this.mapBaseLayerId,
      this.activeBaseLayer
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
      zoom: MeteoFranceComponent.RADAR_MAP_ZOOM,
      minZoom: 2,
      maxZoom: 18,
      worldCopyJump: true
    });

    this.activeBaseLayer = this.basemapService.applyBaseLayer(
      this.map,
      this.mapBaseLayerId,
      null
    );

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
    this.focusRadarMapOnPosition();
  }

  /** Keep the rain-radar map tightly centered on the selected position. */
  private focusRadarMapOnPosition(): void {
    if (!this.map || !Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return;
    }
    const zoom = Math.max(this.map.getZoom(), MeteoFranceComponent.RADAR_MAP_ZOOM);
    this.map.setView([this.lat, this.lon], zoom);
  }

  private setupRadarLayer(): void {
    if (!this.map || !this.mapInitialized) {
      return;
    }
    this.removeRadarLayers();

    if (!this.showRadar) {
      return;
    }

    this.loadRadarLayer();
    this.startRadarRefreshTimer();
  }

  private loadRadarLayer(): void {
    if (!this.map || !this.showRadar) {
      return;
    }
    if (this.radarLayerSource === 'rainviewer') {
      this.loadRainViewerLayer();
      return;
    }
    if (!this.radarAvailable) {
      this.radarLoadError = true;
      this.radarDisplaySource = null;
      return;
    }
    this.loadMfRadarLayer();
  }

  private loadMfRadarLayer(): void {
    if (!this.map) {
      return;
    }
    this.mfWmsFallbackAttempted = false;
    if (this.shouldUseMfWmsRadar()) {
      this.loadMfWmsRadarLayer();
      return;
    }
    if (this.mfStatus?.authValid === true) {
      this.loadMfRainViewerProxyLayer();
      return;
    }
    this.loadMosaicOverlay();
  }

  /** WMS only when backend probe succeeded (geoservices URL + layer valid). */
  private shouldUseMfWmsRadar(): boolean {
    return this.mfStatus?.wmsAvailable === true && this.mfStatus?.wmsOperational === true;
  }

  /**
   * DPRadar API has no PNG tiles. When WMS is off/unavailable but DPRadar auth works,
   * show RainViewer radar on the map and keep MF validity_time from observation meta.
   */
  private loadMfRainViewerProxyLayer(): void {
    if (!this.map) {
      return;
    }
    this.radarLoadError = false;
    this.loadMfObservationMeta();
    this.logBackend('METEO_FRANCE.LOG_CAT_PRECIPITATION', 'METEO_FRANCE.LOG_SOURCE_MF_RADAR', 'loading');
    if (this.mfWmsRadarLayer) {
      this.map.removeLayer(this.mfWmsRadarLayer);
      this.mfWmsRadarLayer = null;
    }
    if (this.mosaicOverlay) {
      this.map.removeLayer(this.mosaicOverlay);
      this.mosaicOverlay = null;
    }
    if (this.mosaicObjectUrl) {
      URL.revokeObjectURL(this.mosaicObjectUrl);
      this.mosaicObjectUrl = null;
    }
    this.loadRainViewerLayer(true);
  }

  private loadMfWmsRadarLayer(): void {
    if (!this.map) {
      return;
    }
    this.radarLoadError = false;
    this.radarDisplaySource = null;
    this.loadMfObservationMeta();
    this.logBackend('METEO_FRANCE.LOG_CAT_PRECIPITATION', 'METEO_FRANCE.LOG_SOURCE_MF_RADAR', 'loading');

    if (this.mosaicOverlay) {
      this.map.removeLayer(this.mosaicOverlay);
      this.mosaicOverlay = null;
    }
    if (this.mosaicObjectUrl) {
      URL.revokeObjectURL(this.mosaicObjectUrl);
      this.mosaicObjectUrl = null;
    }
    if (this.mfWmsRadarLayer) {
      this.map.removeLayer(this.mfWmsRadarLayer);
      this.mfWmsRadarLayer = null;
    }

    const refresh = Date.now();
    this.mfWmsRadarLayer = L.tileLayer(
      `${environment.API_URL}external/meteofrance/radar/wms/{z}/{x}/{y}?width=256&height=256&_=${refresh}`,
      {
        opacity: this.radarOpacity,
        zIndex: 500,
        maxNativeZoom: 10,
        maxZoom: 12,
        attribution: 'Radar &copy; Météo-France (WMS via PatTool)'
      }
    );
    this.mfWmsRadarLayer.on('tileerror', () => {
      if (!this.mfWmsFallbackAttempted && this.radarLayerSource === 'meteofrance') {
        this.mfWmsFallbackAttempted = true;
        this.loadMfRainViewerProxyLayer();
        return;
      }
      this.radarLoadError = true;
      this.logBackend(
        'METEO_FRANCE.LOG_CAT_PRECIPITATION',
        'METEO_FRANCE.LOG_SOURCE_MF_RADAR',
        'error'
      );
    });
    this.mfWmsRadarLayer.on('load', () => {
      if (this.radarDisplaySource === 'mf') {
        this.radarLoadError = false;
      }
    });
    this.mfWmsRadarLayer.addTo(this.map);
    this.radarDisplaySource = 'mf';
    this.logBackend('METEO_FRANCE.LOG_CAT_PRECIPITATION', 'METEO_FRANCE.LOG_SOURCE_MF_RADAR', 'ok');
  }

  onRadarLayerSourceChange(): void {
    this.persistLayerSourcePreference(
      MeteoFranceComponent.RADAR_LAYER_SOURCE_STORAGE_KEY,
      this.radarLayerSource
    );
    this.setupRadarLayer();
  }

  onCloudLayerSourceChange(): void {
    this.persistLayerSourcePreference(
      MeteoFranceComponent.CLOUD_LAYER_SOURCE_STORAGE_KEY,
      this.cloudLayerSource
    );
    this.setupCloudLayer();
  }

  getRadarLayerSourceLabel(source: RadarLayerSource): string {
    switch (source) {
      case 'meteofrance':
        return this.translate.instant('METEO_FRANCE.RADAR_SOURCE_MF');
      default:
        return this.translate.instant('METEO_FRANCE.RADAR_SOURCE_RAINVIEWER');
    }
  }

  getCloudLayerSourceLabel(source: CloudLayerSource): string {
    switch (source) {
      case 'openweathermap':
        return this.translate.instant('METEO_FRANCE.CLOUD_SOURCE_OWM');
      default:
        return this.translate.instant('METEO_FRANCE.CLOUD_SOURCE_RAINVIEWER');
    }
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

  onClearTemperatureObservationCache(): void {
    if (this.isClearingTemperatureCache) {
      return;
    }
    this.isClearingTemperatureCache = true;
    this.logBackend('METEO_FRANCE.LOG_CAT_TEMPERATURE', 'METEO_FRANCE.LOG_SOURCE_MF_DPOBS', 'loading');
    this.subs.add(
      this.apiService.clearMeteoFranceTemperatureObservationCache().subscribe({
        next: () => {
          this.isClearingTemperatureCache = false;
          this.temperatureLabelsFromCache = false;
          this.temperatureLabelsUpdatedAt = null;
          this.temperatureGridPoints = [];
          this.temperatureLabelsRequestId++;
          this.logBackend('METEO_FRANCE.LOG_CAT_TEMPERATURE', 'METEO_FRANCE.LOG_SOURCE_MF_DPOBS_OPEN_METEO', 'ok');
          if (this.showTemperatureMap) {
            this.scheduleTemperatureLabelsLoad();
            this.fetchSelectedPointTemperature(this.lat, this.lon);
          }
        },
        error: () => {
          this.isClearingTemperatureCache = false;
          this.logBackend('METEO_FRANCE.LOG_CAT_TEMPERATURE', 'METEO_FRANCE.LOG_SOURCE_MF_DPOBS', 'error');
        }
      })
    );
  }

  private startRadarRefreshTimer(): void {
    this.clearRadarTimers();
    if (!this.autoRefreshRadar) {
      return;
    }
    const refreshLayers = (): void => {
      if (this.showRadar) {
        this.loadRadarLayer();
      }
      if (this.showCloudLayer) {
        this.loadCloudLayer();
      }
    };
    if (this.showRadar || this.showCloudLayer) {
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
    this.logBackend('METEO_FRANCE.LOG_CAT_PRECIPITATION', 'METEO_FRANCE.LOG_SOURCE_MF_RADAR', 'loading');

    const url = `${environment.API_URL}external/meteofrance/radar/mosaic?zone=METROPOLE&observation=REFLECTIVITE&maille=1000&_=${Date.now()}`;
    this.subs.add(
      this.apiService.fetchRadarMosaicBlob(url).subscribe({
        next: (blob) => {
          if (!this.map || !blob?.size) {
            this.radarLoadError = true;
            this.logBackend(
              'METEO_FRANCE.LOG_CAT_PRECIPITATION',
              'METEO_FRANCE.LOG_SOURCE_MF_RADAR',
              'error'
            );
            return;
          }
          const imageBlob = blob.type.startsWith('image/')
            ? blob
            : new Blob([blob], { type: 'image/png' });
          if (this.mosaicObjectUrl) {
            URL.revokeObjectURL(this.mosaicObjectUrl);
          }
          if (this.mosaicOverlay) {
            this.map.removeLayer(this.mosaicOverlay);
          }
          this.mosaicObjectUrl = URL.createObjectURL(imageBlob);
          this.mosaicOverlay = L.imageOverlay(this.mosaicObjectUrl, this.radarBounds, {
            opacity: this.radarOpacity,
            zIndex: 500
          });
          this.mosaicOverlay.addTo(this.map);
          this.radarDisplaySource = 'mf';
          this.logBackend('METEO_FRANCE.LOG_CAT_PRECIPITATION', 'METEO_FRANCE.LOG_SOURCE_MF_RADAR', 'ok');
        },
        error: () => {
          this.radarLoadError = true;
          this.logBackend(
            'METEO_FRANCE.LOG_CAT_PRECIPITATION',
            'METEO_FRANCE.LOG_SOURCE_MF_RADAR',
            'error'
          );
        }
      })
    );
  }

  private loadMfObservationMeta(): void {
    this.logBackend('METEO_FRANCE.LOG_CAT_META', 'METEO_FRANCE.LOG_SOURCE_MF_RADAR', 'loading');
    this.subs.add(
      this.apiService.getMeteoFranceRadarObservationMeta().subscribe({
        next: (meta) => {
          if (meta?.validity_time) {
            this.radarValidityTime = meta.validity_time;
          } else if (meta?.validityTime) {
            this.radarValidityTime = meta.validityTime;
          }
          this.logBackend(
            'METEO_FRANCE.LOG_CAT_META',
            'METEO_FRANCE.LOG_SOURCE_MF_RADAR',
            'ok',
            this.radarValidityTime || undefined
          );
        },
        error: () => {
          this.logBackend('METEO_FRANCE.LOG_CAT_META', 'METEO_FRANCE.LOG_SOURCE_MF_RADAR', 'error');
        }
      })
    );
  }

  private loadRainViewerLayer(forMfProxy = false): void {
    if (!this.map) {
      return;
    }
    const logSource = forMfProxy ? 'METEO_FRANCE.LOG_SOURCE_MF_RADAR' : 'METEO_FRANCE.LOG_SOURCE_RAINVIEWER';
    this.logBackend('METEO_FRANCE.LOG_CAT_PRECIPITATION', logSource, 'loading');
    this.subs.add(
      this.apiService.getRainViewerMaps().subscribe({
        next: (data) => {
          if (data?.error || !this.map) {
            this.radarLoadError = true;
            this.logBackend('METEO_FRANCE.LOG_CAT_PRECIPITATION', logSource, 'error');
            return;
          }
          const past = data?.radar?.past;
          if (!past?.length) {
            this.radarLoadError = true;
            this.logBackend('METEO_FRANCE.LOG_CAT_PRECIPITATION', logSource, 'error');
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
              attribution: forMfProxy
                ? 'Radar map RainViewer — horodatage Météo-France DPRadar (via PatTool)'
                : 'Radar &copy; RainViewer.com (via PatTool)'
            }
          );
          this.rainViewerLayer.addTo(this.map);
          this.radarDisplaySource = forMfProxy ? 'mf' : 'rainviewer';
          this.radarLoadError = false;
          if (!forMfProxy && frame?.time != null) {
            const ts = Number(frame.time);
            if (Number.isFinite(ts)) {
              this.radarValidityTime = new Date(ts * 1000).toLocaleString();
            }
          }
          this.logBackend(
            'METEO_FRANCE.LOG_CAT_PRECIPITATION',
            logSource,
            'ok',
            this.radarValidityTime || undefined
          );
        },
        error: () => {
          this.radarLoadError = true;
          this.logBackend('METEO_FRANCE.LOG_CAT_PRECIPITATION', logSource, 'error');
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
    if (this.map && this.mfWmsRadarLayer) {
      this.map.removeLayer(this.mfWmsRadarLayer);
      this.mfWmsRadarLayer = null;
    }
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
    this.logBackend('METEO_FRANCE.LOG_CAT_STATUS', 'METEO_FRANCE.LOG_SOURCE_PATTOOL', 'loading');
    this.subs.add(
      this.apiService.getMeteoFranceStatus().subscribe({
        next: (status) => {
          this.mfStatus = status;
          const parts: string[] = [];
          if (status?.dpradarConfigured) {
            parts.push('DPRadar');
          }
          if (status?.dpobsConfigured) {
            parts.push('DPObs');
          }
          if (status?.openWeatherConfigured) {
            parts.push('OpenWeatherMap');
          }
          if (status?.aromepiConfigured) {
            parts.push('AROME-PI');
          }
          this.logBackend(
            'METEO_FRANCE.LOG_CAT_STATUS',
            'METEO_FRANCE.LOG_SOURCE_PATTOOL',
            'ok',
            parts.length ? parts.join(', ') : undefined
          );
          this.syncMapLayerSourcePreferences();
          if (this.activeMainTab === 'radar') {
            this.setupRadarLayer();
            this.setupCloudLayer();
          } else if (this.activeMainTab === 'clim' && this.climAvailable) {
            this.loadClimDataForCurrentPosition();
          } else if (this.activeMainTab === 'aromepi' && this.aromepiAvailable) {
            this.loadAromepiCapabilities();
          }
        },
        error: () => {
          this.mfStatus = { dpradarConfigured: false, wmsAvailable: false };
          this.logBackend('METEO_FRANCE.LOG_CAT_STATUS', 'METEO_FRANCE.LOG_SOURCE_PATTOOL', 'error');
        }
      })
    );
  }

  onRadarOpacityChange(): void {
    if (this.mosaicOverlay) {
      this.mosaicOverlay.setOpacity(this.radarOpacity);
    }
    if (this.mfWmsRadarLayer) {
      this.mfWmsRadarLayer.setOpacity(this.radarOpacity);
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
    const isOwm = this.cloudDisplaySource === 'openweathermap';
    if (isOwm) {
      container.style.removeProperty('--mf-cloud-contrast');
      container.style.removeProperty('--mf-cloud-brightness');
      container.style.removeProperty('--mf-cloud-saturate');
      return;
    }
    const intensity = this.readCloudIntensity();
    const opacity = this.readCloudOpacity();
    const intensityFactor = 0.9 + intensity * 0.22;
    const contrast = 1.65 * intensityFactor * (0.85 + opacity * 0.15);
    const brightness = 0.88 - (intensity - 1) * 0.05;
    const saturate = 1.25 * (0.9 + intensity * 0.12);
    container.style.setProperty('--mf-cloud-contrast', contrast.toFixed(2));
    container.style.setProperty('--mf-cloud-brightness', brightness.toFixed(2));
    container.style.setProperty('--mf-cloud-saturate', saturate.toFixed(2));
  }

  private readCloudOpacity(): number {
    const n = Number(this.cloudOpacity);
    return Number.isFinite(n) ? Math.max(0.1, Math.min(1, n)) : 0.45;
  }

  private readCloudIntensity(): number {
    const n = Number(this.cloudIntensity);
    return Number.isFinite(n)
      ? Math.max(this.cloudIntensityMin, Math.min(this.cloudIntensityMax, n))
      : 1.5;
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
    this.rainViewerCloudLayer.on('load', () => this.updateCloudTileEnhancement());
    this.updateCloudTileEnhancement();
  }

  private loadOpenWeatherCloudLayer(): void {
    if (!this.map || !this.showCloudLayer) {
      return;
    }
    if (this.mfStatus?.openWeatherConfigured === false) {
      this.cloudLoadError = true;
      this.cloudDisplaySource = null;
      this.logBackend('METEO_FRANCE.LOG_CAT_CLOUDS', 'METEO_FRANCE.LOG_SOURCE_OWM', 'error');
      return;
    }
    this.logBackend('METEO_FRANCE.LOG_CAT_CLOUDS', 'METEO_FRANCE.LOG_SOURCE_OWM', 'loading');
    const enhance = this.readCloudIntensity().toFixed(1);
    const cacheBust = Date.now();
    const tileUrl = `${environment.API_URL}external/weather/map/clouds/{z}/{x}/{y}?enhance=${enhance}&_=${cacheBust}`;
    this.attachCloudTileLayer(tileUrl, 'Clouds &copy; OpenWeatherMap (via PatTool)', true);
    this.cloudDisplaySource = 'openweathermap';
    this.cloudValidityTime = new Date().toLocaleString();
    this.updateCloudTileEnhancement();
    this.logBackend(
      'METEO_FRANCE.LOG_CAT_CLOUDS',
      'METEO_FRANCE.LOG_SOURCE_OWM',
      'ok',
      `enhance=${enhance}`
    );
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
    this.cloudLoadError = false;
    if (this.cloudLayerSource === 'openweathermap') {
      this.loadOpenWeatherCloudLayer();
      return;
    }
    this.loadRainViewerCloudLayer();
  }

  private loadRainViewerCloudLayer(): void {
    if (!this.map || !this.showCloudLayer) {
      return;
    }
    this.logBackend('METEO_FRANCE.LOG_CAT_CLOUDS', 'METEO_FRANCE.LOG_SOURCE_RAINVIEWER_IR', 'loading');
    this.subs.add(
      this.apiService.getRainViewerMaps().subscribe({
        next: (data) => {
          if (data?.error || !this.map || !this.showCloudLayer) {
            this.cloudLoadError = true;
            this.logBackend(
              'METEO_FRANCE.LOG_CAT_CLOUDS',
              'METEO_FRANCE.LOG_SOURCE_RAINVIEWER_IR',
              'error'
            );
            return;
          }
          const infrared = data?.satellite?.infrared;
          if (!infrared?.length) {
            this.cloudLoadError = true;
            this.logBackend(
              'METEO_FRANCE.LOG_CAT_CLOUDS',
              'METEO_FRANCE.LOG_SOURCE_RAINVIEWER_IR',
              'error'
            );
            return;
          }
          const frame = infrared[infrared.length - 1];
          const path = frame?.path;
          if (!path) {
            this.cloudLoadError = true;
            this.logBackend(
              'METEO_FRANCE.LOG_CAT_CLOUDS',
              'METEO_FRANCE.LOG_SOURCE_RAINVIEWER_IR',
              'error'
            );
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
          this.logBackend(
            'METEO_FRANCE.LOG_CAT_CLOUDS',
            'METEO_FRANCE.LOG_SOURCE_RAINVIEWER_IR',
            'ok',
            this.cloudValidityTime || undefined
          );
        },
        error: () => {
          this.cloudLoadError = true;
          this.logBackend(
            'METEO_FRANCE.LOG_CAT_CLOUDS',
            'METEO_FRANCE.LOG_SOURCE_RAINVIEWER_IR',
            'error'
          );
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
    this.clearSelectedPointComparison();
    this.selectedPointTempC = null;
    this.selectedTempRequestId++;
    this.selectedTempLabelDismissed = false;
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
    if (!this.shouldShowMfStationLabels()) {
      this.clearMapTemperatureGrid();
      this.updateSelectedTemperatureLabel();
      return;
    }
    this.clearTemperatureLabelsDebounce();
    const { debounceMs } = this.computeTemperatureStationCapacity();
    this.temperatureLabelsDebounce = setTimeout(() => this.loadTemperatureLabels(), debounceMs);
  }

  private loadTemperatureLabels(): void {
    if (!this.showTemperatureMap || !this.map || !this.temperatureLabelsLayer) {
      return;
    }
    if (!this.shouldShowMfStationLabels()) {
      this.clearMapTemperatureGrid();
      this.updateSelectedTemperatureLabel();
      return;
    }
    const bounds = this.map.getBounds();
    const capacity = this.computeTemperatureStationCapacity();

    this.temperatureLabelsLoadSub?.unsubscribe();
    const requestId = ++this.temperatureLabelsRequestId;
    const previousPoints = this.filterMfStationLabelPoints([...this.temperatureGridPoints]);
    this.temperatureLabelsErrorKey = '';
    this.isLoadingTemperatureLabels = true;
    this.logBackend('METEO_FRANCE.LOG_CAT_TEMPERATURE', 'METEO_FRANCE.LOG_SOURCE_MF_DPOBS', 'loading');

    this.temperatureLabelsLoadSub = this.apiService.getMeteoFranceObsTemperatureLabels(
      bounds.getSouth(),
      bounds.getNorth(),
      bounds.getWest(),
      bounds.getEast(),
      capacity.maxStations
    ).subscribe({
      next: (data) => {
        if (requestId !== this.temperatureLabelsRequestId || !this.showTemperatureMap) {
          return;
        }
        if (!this.shouldShowMfStationLabels()) {
          this.clearMapTemperatureGrid();
          this.renderTemperatureLabels();
          this.isLoadingTemperatureLabels = false;
          return;
        }
        if (data?.error) {
          this.applyTemperatureLabelsFailure(previousPoints);
          this.logBackend(
            'METEO_FRANCE.LOG_CAT_TEMPERATURE',
            'METEO_FRANCE.LOG_SOURCE_MF_DPOBS',
            'error',
            String(data.error)
          );
        } else {
          const src = String(data?.source || '');
          if (!src.includes('meteofrance')) {
            this.temperatureGridPoints = [];
            this.temperatureLabelSource = null;
            this.temperatureLabelsErrorKey = previousPoints.length
              ? ''
              : 'METEO_FRANCE.TEMPERATURE_LABELS_EMPTY';
            this.logBackend(
              'METEO_FRANCE.LOG_CAT_TEMPERATURE',
              'METEO_FRANCE.LOG_SOURCE_MF_DPOBS',
              'error',
              'non-MF response'
            );
          } else {
            this.temperatureLabelSource = 'meteofrance-dpobs';
            this.temperatureLabelsFromCache = data?.cached === true;
            this.temperatureLabelsUpdatedAt = new Date();
            this.temperatureLabelsDetailLevel = data?.detailLevel ?? null;
            this.temperatureLabelsCount = data?.count ?? (Array.isArray(data?.points) ? data.points.length : 0);
            this.temperatureLabelsCacheTtlMinutes = data?.cacheTtlMinutes ?? null;
            this.temperatureGridPoints = Array.isArray(data?.points)
              ? data.points
                  .map((point) => this.normalizeTemperatureGridPoint(point, data?.cached === true))
                  .filter((point) => this.isMfStationLabelPoint(point))
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
            this.logBackendTemperatureSource(data, this.temperatureGridPoints.length);
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
        this.logBackend('METEO_FRANCE.LOG_CAT_TEMPERATURE', 'METEO_FRANCE.LOG_SOURCE_MF_DPOBS', 'error');
        this.renderTemperatureLabels();
      }
    });
    this.subs.add(this.temperatureLabelsLoadSub);
  }

  private applyTemperatureLabelsFailure(previousPoints: TemperatureGridPoint[]): void {
    const mfPrevious = this.filterMfStationLabelPoints(previousPoints);
    if (mfPrevious.length) {
      this.temperatureGridPoints = mfPrevious;
      this.temperatureLabelsErrorKey = '';
      return;
    }
    this.temperatureGridPoints = [];
    this.temperatureLabelsErrorKey = 'METEO_FRANCE.TEMPERATURE_LABELS_ERROR';
    this.temperatureLabelSource = null;
  }

  private computeTemperatureStationCapacity(): {
    maxStations: number;
    debounceMs: number;
  } {
    if (!this.map) {
      return { maxStations: 24, debounceMs: 450 };
    }
    const zoom = this.map.getZoom();
    if (zoom <= 7) {
      return { maxStations: 22, debounceMs: 550 };
    }
    if (zoom <= 9) {
      return { maxStations: 45, debounceMs: 420 };
    }
    return { maxStations: 72, debounceMs: 350 };
  }

  private bindTemperatureMarkerTooltip(marker: L.Marker, point: TemperatureGridPoint): void {
    if (!this.showTemperatureTooltips) {
      return;
    }
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
    if (!this.shouldShowMfStationLabels()) {
      this.updateSelectedTemperatureLabel();
      return;
    }
    const inBounds = this.filterPointsInMapBounds(this.filterMfStationLabelPoints(this.temperatureGridPoints));
    const visible = this.filterNonOverlappingTemperatureLabels(inBounds);
    for (const point of visible) {
      if (point.tempC == null || !Number.isFinite(point.tempC)) {
        continue;
      }
      if (this.isNearSelectedPoint(point.lat, point.lon)) {
        continue;
      }
      const label = this.formatTemperatureLabel(point.tempC);
      const w = this.estimateTemperatureLabelWidth(label);
      const h = 20;
      const icon = L.divIcon({
        className: 'mf-temp-label',
        html: this.buildTemperatureLabelHtml(point.tempC, 'meteofrance'),
        iconSize: [w, h],
        iconAnchor: [w / 2, h / 2]
      });
      const marker = L.marker([point.lat, point.lon], {
        icon,
        interactive: this.showTemperatureTooltips
      });
      this.bindTemperatureMarkerTooltip(marker, point);
      marker.addTo(this.temperatureLabelsLayer);
    }
    this.syncSelectedPointMfFromGrid();
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
      const w = this.estimateTemperatureLabelWidth(label);
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

  private updateSelectedTemperatureLabel(options?: { forceShow?: boolean }): void {
    if (!this.map || !this.showTemperatureMap) {
      if (!this.showTemperatureMap) {
        this.removeSelectedTemperatureLabel();
      }
      return;
    }
    if (this.selectedTempLabelDismissed && !options?.forceShow) {
      return;
    }
    if (!this.canShowSelectedTemperatureLabel()) {
      this.removeSelectedTemperatureLabel();
      return;
    }
    const html = this.buildSelectedTemperatureLabelHtml();
    const icon = L.divIcon({
      className: 'mf-temp-label mf-temp-label--selected',
      html,
      iconSize: [1, 1],
      iconAnchor: [0, 0]
    });
    if (!this.selectedTempLabelMarker) {
      this.selectedTempLabelMarker = L.marker([this.lat, this.lon], {
        icon,
        interactive: true,
        zIndexOffset: 1000
      }).addTo(this.map);
    } else {
      this.selectedTempLabelMarker.setLatLng([this.lat, this.lon]);
      this.selectedTempLabelMarker.setIcon(icon);
    }
  }

  private canShowSelectedTemperatureLabel(): boolean {
    return this.selectedPointComparisonLoading
      || this.selectedPointComparisonReady
      || this.selectedPointTempC != null
      || this.selectedPointMfTempC != null
      || this.selectedPointOpenMeteoTempC != null
      || this.selectedPointOpenWeatherTempC != null;
  }

  private resetSelectedTemperatureLabelDisplay(): void {
    this.selectedTempLabelDismissed = false;
  }

  private removeSelectedTemperatureLabel(): void {
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

  private buildSelectedSourceRow(
    brand: WeatherDataSourceBrand,
    tempC: number,
    size = 14,
    title?: string,
    observedAt?: string | null
  ): string {
    const tooltip = title?.trim() || this.getBrandAlt(brand);
    const logoSize = brand === 'meteofrance' ? Math.max(size, 14) : size;
    const obsTime = this.formatPointObservedTime(observedAt);
    const timeHtml = obsTime
      ? `<span class="mf-temp-label-obs-time">${this.escapeHtml(obsTime)}</span>`
      : '';
    return (
      `<span class="mf-temp-label-source-row" title="${this.escapeHtml(tooltip)}">` +
      `${this.buildBrandLogoHtml(brand, logoSize)}` +
      `<span class="mf-temp-label-source-code">${this.escapeHtml(this.getBrandInitials(brand))}</span>` +
      `<span class="mf-temp-label-source-values">` +
      `<span class="mf-temp-label-alt-value">${this.formatTemperatureLabel(tempC)}</span>` +
      timeHtml +
      `</span>` +
      `</span>`
    );
  }

  private formatSelectedMfStationLabel(): string {
    const name = this.selectedPointMfStation?.name?.trim();
    if (name) {
      return name;
    }
    return this.selectedPointMfStation?.id?.trim() || '';
  }

  /** Station line under MF row: name only on the marker, nearest-station hint when farther away. */
  private formatSelectedMfStationProximityLabel(): string {
    const name = this.formatSelectedMfStationLabel();
    const distKm = this.selectedPointMfStationDistKm;
    if (!name) {
      return '';
    }
    if (distKm != null && distKm >= 1.5) {
      return this.translate.instant('METEO_FRANCE.POINT_SOURCE_MF_NEAREST', {
        station: name,
        km: this.formatDistanceKm(distKm),
      });
    }
    return name;
  }

  private formatDistanceKm(km: number): string {
    if (km < 10) {
      return km.toFixed(1).replace(/\.0$/, '');
    }
    return String(Math.round(km));
  }

  private updateSelectedPointMfStationDistance(
    clickLat: number,
    clickLon: number,
    mfPoint?: any
  ): void {
    this.selectedPointMfStationDistKm = null;
    let stationLat: number | undefined;
    let stationLon: number | undefined;

    const rawStationLat = mfPoint?.stationLat;
    const rawStationLon = mfPoint?.stationLon;
    if (Number.isFinite(Number(rawStationLat)) && Number.isFinite(Number(rawStationLon))) {
      stationLat = Number(rawStationLat);
      stationLon = Number(rawStationLon);
    } else {
      const stationId = this.selectedPointMfStation?.id ?? mfPoint?.stationId;
      const gridPoint = stationId
        ? this.temperatureGridPoints.find((p) => p.stationId === String(stationId))
        : this.findNearestGridPoint(clickLat, clickLon);
      if (gridPoint && Number.isFinite(gridPoint.lat) && Number.isFinite(gridPoint.lon)) {
        stationLat = gridPoint.lat;
        stationLon = gridPoint.lon;
      }
    }

    if (stationLat == null || stationLon == null) {
      return;
    }
    this.selectedPointMfStationDistKm = this.haversineKm(clickLat, clickLon, stationLat, stationLon);
  }

  private clearSelectedPointComparison(): void {
    this.selectedPointUsesMf = false;
    this.selectedPointMfTempC = null;
    this.selectedPointMfStation = null;
    this.selectedPointMfStationDistKm = null;
    this.selectedPointOpenMeteoTempC = null;
    this.selectedPointOpenWeatherTempC = null;
    this.selectedPointMfObservedAt = null;
    this.selectedPointOpenMeteoObservedAt = null;
    this.selectedPointOpenWeatherObservedAt = null;
    this.selectedPointOpenWeatherPlace = null;
    this.selectedPointOpenWeatherDistKm = null;
    this.selectedPointComparisonReady = false;
    this.selectedPointComparisonLoading = false;
  }

  private extractPointObservedAt(point: any): string | null {
    const raw = point?.observedAt;
    if (raw == null) {
      return null;
    }
    const text = String(raw).trim();
    return text || null;
  }

  private formatPointObservedTime(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const trimmed = value.trim();
    if (/^\d{10}$/.test(trimmed)) {
      const date = new Date(Number(trimmed) * 1000);
      return Number.isNaN(date.getTime())
        ? null
        : date.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    if (/^\d{13}$/.test(trimmed)) {
      const date = new Date(Number(trimmed));
      return Number.isNaN(date.getTime())
        ? null
        : date.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  private buildSelectedPointRowTitle(
    brand: WeatherDataSourceBrand,
    extra?: string,
    observedAt?: string | null
  ): string | undefined {
    const parts = [this.getBrandAlt(brand)];
    if (extra?.trim()) {
      parts.push(extra.trim());
    }
    const obsTime = this.formatPointObservedTime(observedAt);
    if (obsTime) {
      parts.push(
        this.translate.instant('METEO_FRANCE.POINT_SOURCE_AT', { time: obsTime })
      );
    }
    return parts.length > 1 || obsTime ? parts.join(' · ') : undefined;
  }

  private haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private extractPointTempC(data: any): number | null {
    const raw = data?.points?.[0]?.tempC;
    const tempC = raw != null ? Number(raw) : NaN;
    return Number.isFinite(tempC) ? tempC : null;
  }

  private buildSelectedTemperatureLabelHtml(): string {
    const locationName = this.resolveSelectedLocationName();
    const rows: string[] = [];

    if (this.selectedPointMfTempC != null && this.isMfTemperaturePointAllowed()) {
      const stationName = this.formatSelectedMfStationLabel();
      const mfTitle = this.buildSelectedPointRowTitle(
        'meteofrance',
        stationName || undefined,
        this.selectedPointMfObservedAt
      );
      let mfBlock = this.buildSelectedSourceRow(
        'meteofrance',
        this.selectedPointMfTempC,
        14,
        mfTitle,
        this.selectedPointMfObservedAt
      );
      if (stationName) {
        const stationLine = this.formatSelectedMfStationProximityLabel();
        if (stationLine) {
          mfBlock += `<span class="mf-temp-label-station">${this.escapeHtml(stationLine)}</span>`;
        }
      }
      rows.push(`<span class="mf-temp-label-mf-block">${mfBlock}</span>`);
    }

    if (this.selectedPointOpenMeteoTempC != null) {
      rows.push(this.buildSelectedSourceRow(
        'open-meteo',
        this.selectedPointOpenMeteoTempC,
        14,
        this.buildSelectedPointRowTitle('open-meteo', undefined, this.selectedPointOpenMeteoObservedAt),
        this.selectedPointOpenMeteoObservedAt
      ));
    } else if (
      this.selectedPointMfTempC == null
      && this.selectedPointOpenMeteoTempC == null
      && this.selectedPointOpenWeatherTempC == null
    ) {
      const tempC = this.resolveSelectedTemperatureCelsius();
      if (tempC != null) {
        rows.push(this.buildSelectedSourceRow(this.resolveMapTemperatureBrand(), tempC));
      }
    }

    if (this.selectedPointOpenWeatherTempC != null) {
      rows.push(this.buildSelectedSourceRow(
        'openweathermap',
        this.selectedPointOpenWeatherTempC,
        14,
        this.buildSelectedPointRowTitle('openweathermap', undefined, this.selectedPointOpenWeatherObservedAt),
        this.selectedPointOpenWeatherObservedAt
      ));
    }

    if (this.selectedPointComparisonLoading) {
      const loadingText = this.escapeHtml(this.translate.instant('METEO_FRANCE.LOADING'));
      if (!rows.length) {
        rows.push(`<span class="mf-temp-label-loading"><i class="fa fa-spinner fa-spin"></i> ${loadingText}</span>`);
      } else {
        rows.push(`<span class="mf-temp-label-loading mf-temp-label-loading--inline"><i class="fa fa-spinner fa-spin"></i></span>`);
      }
    }

    const closeLabel = this.escapeHtml(this.translate.instant('METEO_FRANCE.TEMPERATURE_LABEL_CLOSE'));
    const headerHtml = locationName.trim()
      ? `<span class="mf-temp-label-city mf-temp-label-city--header">${this.escapeHtml(locationName)}</span>`
      : '';
    return (
      `<span class="mf-temp-label-selected-inner">` +
      `<button type="button" class="mf-temp-selected-close" aria-label="${closeLabel}" title="${closeLabel}">` +
      `<i class="fa fa-times" aria-hidden="true"></i>` +
      `</button>` +
      `${headerHtml}` +
      `${rows.join('')}` +
      `</span>`
    );
  }

  private dismissSelectedTemperatureLabel(): void {
    this.selectedTempLabelDismissed = true;
    this.removeSelectedTemperatureLabel();
  }

  /** Fill MF row from the station grid when the point API finished before grid data was ready. */
  private syncSelectedPointMfFromGrid(): void {
    if (!this.isMfTemperaturePointAllowed()) {
      return;
    }
    this.applySelectedPointMfFallbackFromGrid(this.lat, this.lon);
  }

  private applySelectedPointMfFallbackFromGrid(lat: number, lon: number): void {
    if (!this.isMfTemperaturePointAllowed()) {
      return;
    }
    if (this.selectedPointMfTempC != null) {
      return;
    }
    const nearest = this.findNearestGridPoint(lat, lon);
    if (!nearest?.tempC || !Number.isFinite(nearest.tempC)) {
      return;
    }
    if (this.resolvePointDataBrand(nearest) !== 'meteofrance') {
      return;
    }
    this.selectedPointMfTempC = nearest.tempC;
    this.selectedPointUsesMf = true;
    if (nearest.stationId || nearest.stationName) {
      this.selectedPointMfStation = {
        id: nearest.stationId,
        name: nearest.stationName,
      };
    }
    if (nearest.observedAt) {
      this.selectedPointMfObservedAt = nearest.observedAt;
    }
    this.updateSelectedPointMfStationDistance(lat, lon, nearest);
    if (this.selectedPointTempC == null) {
      this.selectedPointTempC = nearest.tempC;
    }
  }

  private isMfTemperaturePoint(point: any, mfSource: string): boolean {
    if (!point || point.tempC == null) {
      return false;
    }
    if (point.stationId || point.stationName) {
      return true;
    }
    if (point.interpolated === true) {
      return true;
    }
    const normalized = mfSource.toLowerCase();
    return normalized === 'meteofrance-dpobs' || normalized === 'meteofrance-dpobs-v2';
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
    return !!target?.closest('.mf-temp-tooltip, .mf-temp-label, .mf-temp-refresh-btn, .mf-temp-selected-close');
  }

  private readonly onTemperatureTooltipClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const closeButton = target?.closest('.mf-temp-selected-close') as HTMLElement | null;
    if (closeButton) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.dismissSelectedTemperatureLabel();
      return;
    }
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
    if (!this.shouldShowMfStationLabels()) {
      return;
    }
    const point = this.temperatureGridPoints.find((p) => this.temperaturePointKey(p) === key);
    if (!point?.stationId || this.refreshingTemperatureKeys.has(key)) {
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
          const normalized = this.upsertMfTemperatureGridPoint(updated);
          if (normalized) {
            this.applyRefreshedMfStationToSelectedPoint(normalized);
          }
        },
        error: () => {
          this.refreshingTemperatureKeys.delete(key);
        }
      })
    );
  }

  /** Insert or replace one MF station in the local grid after a forced refresh. */
  private upsertMfTemperatureGridPoint(rawPoint: any): TemperatureGridPoint | null {
    if (!this.shouldShowMfStationLabels()) {
      return null;
    }
    const normalized = this.normalizeTemperatureGridPoint(rawPoint, false);
    normalized.cached = false;
    if (!this.isMfStationLabelPoint(normalized)) {
      return null;
    }
    const key = this.temperaturePointKey(normalized);
    const index = this.temperatureGridPoints.findIndex((p) => this.temperaturePointKey(p) === key);
    if (index >= 0) {
      this.temperatureGridPoints[index] = normalized;
    } else {
      this.temperatureGridPoints.push(normalized);
    }
    this.temperatureLabelsFromCache = false;
    this.temperatureLabelsUpdatedAt = new Date();
    this.temperatureLabelSource = 'meteofrance-dpobs';
    this.temperatureLabelsCount = this.temperatureGridPoints.length;
    this.renderTemperatureLabels();
    return normalized;
  }

  private applyRefreshedMfStationToSelectedPoint(point: TemperatureGridPoint): void {
    if (!point.stationId) {
      return;
    }
    const selectedId = this.selectedPointMfStation?.id?.trim();
    const matchesSelected = selectedId
      ? selectedId === point.stationId
      : this.isNearSelectedPoint(point.lat, point.lon);
    if (!matchesSelected) {
      return;
    }
    this.selectedPointMfTempC = point.tempC;
    this.selectedPointUsesMf = true;
    this.selectedPointMfObservedAt = point.observedAt ?? null;
    if (point.stationId || point.stationName) {
      this.selectedPointMfStation = {
        id: point.stationId,
        name: point.stationName,
      };
    }
    this.selectedPointTempC = point.tempC;
    this.updateSelectedPointMfStationDistance(this.lat, this.lon, point);
    this.updateSelectedTemperatureLabel();
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

    lines.push(this.tooltipRowWithBrand(
      this.translate.instant('METEO_FRANCE.TEMPERATURE'),
      this.formatTemperatureLabel(point.tempC),
      this.resolvePointDataBrand(point)
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
    }

    if (point.stationId && this.shouldShowMfStationLabels()) {
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

  private tooltipRowWithBrand(label: string, value: string, brand: WeatherDataSourceBrand): string {
    const logo = this.buildBrandLogoHtml(brand, 16);
    return (
      `<div class="mf-temp-tooltip-row mf-temp-tooltip-row--with-brand">` +
      `<span>${this.escapeHtml(label)}</span>` +
      `<strong class="mf-temp-tooltip-value-with-logo">${logo}${this.escapeHtml(value)}</strong>` +
      `</div>`
    );
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
    if (this.selectedPointMfTempC != null) {
      return this.selectedPointMfTempC;
    }
    if (this.selectedPointOpenMeteoTempC != null) {
      return this.selectedPointOpenMeteoTempC;
    }
    if (this.selectedPointOpenWeatherTempC != null) {
      return this.selectedPointOpenWeatherTempC;
    }
    if (this.selectedPointTempC != null && Number.isFinite(this.selectedPointTempC)) {
      return this.selectedPointTempC;
    }
    if (this.showMapTemperatureGrid) {
      return this.findNearestGridTempC(this.lat, this.lon);
    }
    const owmTemp = this.currentWeather?.main?.temp;
    return owmTemp != null && Number.isFinite(owmTemp) ? owmTemp : null;
  }

  private fetchSelectedPointTemperature(lat: number, lon: number): void {
    if (!this.showTemperatureMap) {
      this.selectedPointTempC = null;
      this.clearSelectedPointComparison();
      this.removeSelectedTemperatureLabel();
      return;
    }
    this.resetSelectedTemperatureLabelDisplay();
    this.clearSelectedPointComparison();
    const requestId = ++this.selectedTempRequestId;
    this.selectedPointComparisonLoading = true;

    let interim: number | null = null;
    if (this.showMapTemperatureGrid) {
      interim = this.findNearestGridTempC(lat, lon);
    } else {
      const owmTemp = this.currentWeather?.main?.temp;
      interim = owmTemp != null && Number.isFinite(owmTemp) ? owmTemp : null;
    }
    if (interim != null) {
      this.selectedPointTempC = interim;
    }
    this.applySelectedPointMfFallbackFromGrid(lat, lon);
    this.updateSelectedTemperatureLabel({ forceShow: true });

    this.logBackend('METEO_FRANCE.LOG_CAT_TEMPERATURE_POINT', 'METEO_FRANCE.LOG_SOURCE_MF_DPOBS_OPEN_METEO', 'loading');

    let mfDone = false;
    let openMeteoDone = false;
    let owmDone = false;

    const finishSelectedPointFetch = (): void => {
      if (requestId !== this.selectedTempRequestId || !this.showTemperatureMap) {
        return;
      }
      if (!mfDone || !openMeteoDone || !owmDone) {
        return;
      }
      this.selectedPointComparisonLoading = false;
      this.selectedPointComparisonReady = true;
      this.syncSelectedPointMfFromGrid();
      const detail = this.selectedPointMfTempC != null
        ? this.formatSelectedMfStationLabel() || this.formatTemperatureLabel(this.selectedPointMfTempC)
        : this.selectedPointTempC != null
          ? this.formatTemperatureLabel(this.selectedPointTempC)
          : undefined;
      this.logBackend(
        'METEO_FRANCE.LOG_CAT_TEMPERATURE_POINT',
        this.selectedPointMfTempC != null
          ? 'METEO_FRANCE.LOG_SOURCE_MF_DPOBS'
          : 'METEO_FRANCE.LOG_SOURCE_OPEN_METEO',
        this.selectedPointTempC != null ? 'ok' : 'error',
        detail
      );
      this.updateSelectedTemperatureLabel({ forceShow: true });
    };

    const applyMfResponse = (mf: any): void => {
      if (requestId !== this.selectedTempRequestId || !this.showTemperatureMap) {
        return;
      }
      const mfPoint = mf?.points?.[0];
      const mfTemp = this.extractPointTempC(mf);
      const mfSource = String(mf?.source || '');
      if (this.isMfTemperaturePoint(mfPoint, mfSource) && mfTemp != null && this.isMfTemperaturePointAllowed()) {
        this.selectedPointUsesMf = true;
        this.selectedPointMfTempC = mfTemp;
        this.selectedPointMfObservedAt = this.extractPointObservedAt(mfPoint);
        if (mfPoint?.stationId || mfPoint?.stationName) {
          this.selectedPointMfStation = {
            id: mfPoint.stationId != null ? String(mfPoint.stationId) : undefined,
            name: mfPoint.stationName != null ? String(mfPoint.stationName) : undefined,
          };
        } else {
          const nearest = this.findNearestGridPoint(lat, lon);
          if (nearest?.stationId || nearest?.stationName) {
            this.selectedPointMfStation = {
              id: nearest.stationId,
              name: nearest.stationName,
            };
          }
        }
        this.selectedPointTempC = mfTemp;
        this.updateSelectedPointMfStationDistance(lat, lon, mfPoint);
        this.upsertMfTemperatureGridPoint(mfPoint);
      }
      this.applySelectedPointMfFallbackFromGrid(lat, lon);
      mfDone = true;
      this.updateSelectedTemperatureLabel({ forceShow: true });
      finishSelectedPointFetch();
    };

    const applyOpenMeteoResponse = (openMeteo: any): void => {
      if (requestId !== this.selectedTempRequestId || !this.showTemperatureMap) {
        return;
      }
      const openMeteoTemp = this.extractPointTempC(openMeteo);
      const openMeteoPoint = openMeteo?.points?.[0];
      if (openMeteoTemp != null) {
        this.selectedPointOpenMeteoTempC = openMeteoTemp;
        this.selectedPointOpenMeteoObservedAt = this.extractPointObservedAt(openMeteoPoint);
        if (this.selectedPointMfTempC == null) {
          this.selectedPointTempC = openMeteoTemp;
        }
      } else if (this.selectedPointTempC == null) {
        this.selectedPointTempC = interim;
      }
      openMeteoDone = true;
      this.updateSelectedTemperatureLabel({ forceShow: true });
      finishSelectedPointFetch();
    };

    const applyOwmResponse = (owm: any): void => {
      if (requestId !== this.selectedTempRequestId || !this.showTemperatureMap) {
        return;
      }
      const owmTemp = owm?.main?.temp;
      if (owmTemp != null && Number.isFinite(owmTemp)) {
        this.selectedPointOpenWeatherTempC = owmTemp;
        if (this.selectedPointTempC == null) {
          this.selectedPointTempC = owmTemp;
        }
      }
      if (owm?.dt != null) {
        this.selectedPointOpenWeatherObservedAt = String(owm.dt);
      }
      const place = owm?.name != null ? String(owm.name).trim() : '';
      this.selectedPointOpenWeatherPlace = place || null;
      const owmLat = owm?.coord?.lat;
      const owmLon = owm?.coord?.lon;
      if (Number.isFinite(owmLat) && Number.isFinite(owmLon)) {
        this.selectedPointOpenWeatherDistKm = this.haversineKm(lat, lon, owmLat, owmLon);
      } else {
        this.selectedPointOpenWeatherDistKm = null;
      }
      owmDone = true;
      this.updateSelectedTemperatureLabel({ forceShow: true });
      finishSelectedPointFetch();
    };

    this.subs.add(
      this.apiService.postWeatherTemperatureLabels([{ lat, lon }], 'open-meteo').subscribe({
        next: applyOpenMeteoResponse,
        error: () => {
          if (requestId !== this.selectedTempRequestId || !this.showTemperatureMap) {
            return;
          }
          if (this.selectedPointTempC == null) {
            this.selectedPointTempC = interim;
          }
          openMeteoDone = true;
          this.updateSelectedTemperatureLabel({ forceShow: true });
          finishSelectedPointFetch();
        }
      })
    );

    if (this.shouldFetchMfTemperatureAt(lat, lon)) {
      const nearestGrid = this.findNearestGridPoint(lat, lon);
      const mfTarget: { lat: number; lon: number; stationId?: string } = { lat, lon };
      if (nearestGrid?.stationId) {
        mfTarget.stationId = nearestGrid.stationId;
      }
      this.subs.add(
        this.apiService.postWeatherTemperatureLabels([mfTarget], 'meteofrance', true).subscribe({
          next: applyMfResponse,
          error: () => {
            if (requestId !== this.selectedTempRequestId || !this.showTemperatureMap) {
              return;
            }
            this.applySelectedPointMfFallbackFromGrid(lat, lon);
            mfDone = true;
            this.updateSelectedTemperatureLabel({ forceShow: true });
            finishSelectedPointFetch();
          }
        })
      );
    } else {
      mfDone = true;
    }

    this.subs.add(
      this.apiService.getCurrentWeatherByCoordinates(lat, lon).pipe(
        catchError(() => of(null))
      ).subscribe({
        next: (owm) => {
          if (owm?.error) {
            owmDone = true;
            finishSelectedPointFetch();
            return;
          }
          applyOwmResponse(owm);
        },
        error: () => {
          if (requestId !== this.selectedTempRequestId || !this.showTemperatureMap) {
            return;
          }
          owmDone = true;
          finishSelectedPointFetch();
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
    if (this.aromepiMapFullscreen) {
      this.exitAromepiMapFullscreenIfActive();
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

  onMainTabChange(tab: 'radar' | 'clim' | 'aromepi'): void {
    this.activeMainTab = tab;
    if (tab === 'radar') {
      this.stopAromepiAnimation();
      setTimeout(() => {
        this.map?.invalidateSize();
        this.focusRadarMapOnPosition();
        this.setupRadarLayer();
        this.setupTemperatureLabels();
      }, 0);
    } else if (tab === 'clim') {
      this.stopAromepiAnimation();
      setTimeout(() => {
        this.loadClimDataForCurrentPosition();
      }, 0);
    } else if (tab === 'aromepi') {
      setTimeout(() => {
        this.initAromepiMap();
        if (this.aromepiAvailable) {
          if (!this.aromepiCapabilities && !this.isLoadingAromepiCapabilities) {
            this.loadAromepiCapabilities();
          } else {
            this.setupAromepiWmsLayer();
            this.scheduleAromepiForecastLoad();
          }
        }
      }, 0);
    }
  }

  loadAromepiCapabilities(): void {
    if (!this.aromepiAvailable) {
      return;
    }
    this.isLoadingAromepiCapabilities = true;
    this.aromepiErrorKey = '';
    this.logBackend('METEO_FRANCE.LOG_CAT_AROMEPI', 'METEO_FRANCE.LOG_SOURCE_MF_AROMEPI', 'loading');
    this.subs.add(
      this.apiService.getMeteoFranceAromepiCapabilities().subscribe({
        next: (caps) => {
          this.isLoadingAromepiCapabilities = false;
          if (caps?.error) {
            this.aromepiErrorKey = 'METEO_FRANCE.AROMEPI_LOAD_ERROR';
            this.logBackend('METEO_FRANCE.LOG_CAT_AROMEPI', 'METEO_FRANCE.LOG_SOURCE_MF_AROMEPI', 'error', String(caps.error));
            return;
          }
          this.aromepiCapabilities = caps;
          this.aromepiLayers = Array.isArray(caps.layers) ? caps.layers : [];
          this.aromepiTimeSteps = Array.isArray(caps.timeSteps) ? caps.timeSteps : [];
          this.aromepiReferenceTime = caps.defaultReferenceTime || caps.referenceTimes?.[caps.referenceTimes.length - 1] || '';
          this.aromepiFrameIndex = 0;
          if (!this.aromepiSelectedLayer && this.aromepiLayers.length) {
            const cloud = this.aromepiLayers.find((l) => l.category === 'cloud');
            const precip = this.aromepiLayers.find((l) => l.category === 'precipitation');
            this.aromepiSelectedLayer = (cloud || precip || this.aromepiLayers[0]).name;
            this.aromepiSelectedStyle = (cloud || precip || this.aromepiLayers[0]).style || '';
          }
          this.logBackend(
            'METEO_FRANCE.LOG_CAT_AROMEPI',
            'METEO_FRANCE.LOG_SOURCE_MF_AROMEPI',
            'ok',
            `${this.aromepiLayers.length} layers, ${this.aromepiTimeSteps.length} steps`
          );
          this.setupAromepiWmsLayer();
          this.scheduleAromepiForecastLoad();
        },
        error: () => {
          this.isLoadingAromepiCapabilities = false;
          this.aromepiErrorKey = 'METEO_FRANCE.AROMEPI_LOAD_ERROR';
          this.logBackend('METEO_FRANCE.LOG_CAT_AROMEPI', 'METEO_FRANCE.LOG_SOURCE_MF_AROMEPI', 'error');
        }
      })
    );
  }

  onAromepiLayerChange(layerName: string): void {
    const layer = this.aromepiLayers.find((l) => l.name === layerName);
    this.aromepiSelectedLayer = layerName;
    this.aromepiSelectedStyle = layer?.style || '';
    this.setupAromepiWmsLayer();
    this.loadAromepiCurrentValues();
  }

  onAromepiFrameIndexChange(index: number): void {
    const max = Math.max(0, this.aromepiTimeSteps.length - 1);
    this.aromepiFrameIndex = Math.max(0, Math.min(max, Math.round(index)));
    this.setupAromepiWmsLayer();
    this.loadAromepiCurrentValues();
  }

  toggleAromepiPlayback(): void {
    if (this.aromepiPlaying) {
      this.stopAromepiAnimation();
      return;
    }
    if (this.aromepiTimeSteps.length < 2) {
      return;
    }
    this.aromepiPlaying = true;
    this.aromepiPlayTimer = setInterval(() => {
      const next = this.aromepiFrameIndex + 1;
      if (next >= this.aromepiTimeSteps.length) {
        this.aromepiFrameIndex = 0;
      } else {
        this.aromepiFrameIndex = next;
      }
      this.setupAromepiWmsLayer();
      this.loadAromepiCurrentValues();
    }, this.aromepiPlayIntervalMs);
  }

  stopAromepiAnimation(): void {
    this.aromepiPlaying = false;
    if (this.aromepiPlayTimer) {
      clearInterval(this.aromepiPlayTimer);
      this.aromepiPlayTimer = null;
    }
  }

  onAromepiOpacityChange(): void {
    if (this.aromepiWmsLayer) {
      this.aromepiWmsLayer.setOpacity(this.aromepiOpacity);
    }
  }

  loadAromepiPointForecast(): void {
    if (!this.aromepiAvailable || !this.aromepiReferenceTime) {
      return;
    }
    this.isLoadingAromepiForecast = true;
    this.subs.add(
      this.apiService.getMeteoFranceAromepiPointForecast(
        this.lat,
        this.lon,
        this.aromepiReferenceTime
      ).subscribe({
        next: (data) => {
          this.isLoadingAromepiForecast = false;
          if (data?.error) {
            return;
          }
          this.aromepiPointForecast = data;
        },
        error: () => {
          this.isLoadingAromepiForecast = false;
        }
      })
    );
  }

  private scheduleAromepiForecastLoad(): void {
    if (!this.aromepiAvailable || this.activeMainTab !== 'aromepi') {
      return;
    }
    if (this.aromepiForecastDebounceTimer) {
      clearTimeout(this.aromepiForecastDebounceTimer);
    }
    this.aromepiForecastDebounceTimer = setTimeout(() => {
      this.aromepiForecastDebounceTimer = null;
      this.loadAromepiPointForecast();
      this.loadAromepiCurrentValues();
    }, 400);
  }

  private loadAromepiCurrentValues(): void {
    if (!this.aromepiAvailable || !this.aromepiCurrentTime || !this.aromepiReferenceTime) {
      return;
    }
    const layers = this.aromepiLayers
      .filter((l) => ['cloud', 'precipitation', 'temperature', 'humidity'].includes(l.category || ''))
      .slice(0, 4);
    if (!layers.length) {
      return;
    }
    const values: Record<string, unknown> = {};
    layers.forEach((layer) => {
      this.subs.add(
        this.apiService.getMeteoFranceAromepiFeatureInfo(
          this.lat,
          this.lon,
          layer.name,
          this.aromepiCurrentTime,
          this.aromepiReferenceTime,
          layer.style
        ).subscribe({
          next: (res) => {
            if (!res?.error) {
              values[layer.name] = res.value ?? res.raw;
              this.aromepiCurrentValues = { ...values };
            }
          }
        })
      );
    });
  }

  private initAromepiMap(): void {
    if (this.aromepiMap) {
      this.aromepiMap.invalidateSize();
      return;
    }
    const bounds = this.aromepiMapBounds();
    this.aromepiMap = L.map('meteo-france-aromepi-map', {
      center: [this.lat, this.lon],
      zoom: 7,
      minZoom: 5,
      maxZoom: 12,
      maxBounds: bounds,
      maxBoundsViscosity: 0.85,
      worldCopyJump: false
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19
    }).addTo(this.aromepiMap);

    this.aromepiMarker = L.marker([this.lat, this.lon], { draggable: true }).addTo(this.aromepiMap);
    this.aromepiMarker.on('dragend', () => {
      const pos = this.aromepiMarker!.getLatLng();
      this.setLocation(pos.lat, pos.lng, false);
    });

    this.aromepiMap.on('click', (e: L.LeafletMouseEvent) => {
      this.setLocation(e.latlng.lat, e.latlng.lng, false);
    });

    this.aromepiMapInitialized = true;
    this.setupAromepiWmsLayer();
    this.aromepiMap.invalidateSize();
  }

  private aromepiMapBounds(): L.LatLngBoundsExpression {
    const b = this.aromepiCapabilities?.bounds;
    if (b?.south != null && b?.west != null && b?.north != null && b?.east != null) {
      return [[b.south, b.west], [b.north, b.east]];
    }
    return [[40.0, -6.0], [51.5, 10.0]];
  }

  private setupAromepiWmsLayer(): void {
    if (!this.aromepiMap || !this.aromepiMapInitialized || !this.aromepiAvailable) {
      return;
    }
    if (!this.aromepiSelectedLayer || !this.aromepiCurrentTime || !this.aromepiReferenceTime) {
      return;
    }
    if (this.aromepiWmsLayer) {
      this.aromepiMap.removeLayer(this.aromepiWmsLayer);
      this.aromepiWmsLayer = null;
    }
    const layer = this.aromepiSelectedLayer;
    const style = this.aromepiSelectedStyle;
    const { time, referenceTime } = this.resolveAromepiWmsTimes();
    if (!time || !referenceTime) {
      return;
    }
    this.aromepiWmsLayer = L.tileLayer(
      `${environment.API_URL}external/meteofrance/aromepi/wms/{z}/{x}/{y}?layer=${encodeURIComponent(layer)}&time=${encodeURIComponent(time)}&referenceTime=${encodeURIComponent(referenceTime)}${style ? `&style=${encodeURIComponent(style)}` : ''}&width=256&height=256`,
      {
        opacity: this.aromepiOpacity,
        zIndex: 500,
        maxNativeZoom: 10,
        maxZoom: 12,
        attribution: '&copy; Météo-France AROME-PI (via PatTool)'
      }
    );
    this.aromepiWmsLayer.addTo(this.aromepiMap);
    this.aromepiWmsLayer.on('tileerror', () => {
      this.aromepiLoadError = true;
    });
    this.aromepiWmsLayer.on('load', () => {
      this.aromepiLoadError = false;
    });
  }

  /** Ensure WMS TIME is within referenceTime + [15..360] min (backend also normalizes). */
  private resolveAromepiWmsTimes(): { time: string; referenceTime: string } {
    const referenceTime = this.aromepiReferenceTime;
    let time = this.aromepiCurrentTime;
    if (!referenceTime || !time) {
      return { time: '', referenceTime: referenceTime || '' };
    }
    const offset = this.aromepiCurrentOffsetMinutes;
    if (offset < 15 || offset > 360) {
      time = this.aromepiTimeSteps[0] || time;
      this.aromepiFrameIndex = 0;
    }
    return { time, referenceTime };
  }

  toggleAromepiMapFullscreen(): void {
    const shell = this.aromepiMapShell?.nativeElement;
    if (!shell) {
      return;
    }
    const doc = document as Document & { webkitFullscreenElement?: Element };
    if (document.fullscreenElement === shell || doc.webkitFullscreenElement === shell) {
      this.exitAromepiMapFullscreenIfActive();
      return;
    }
    const request = shell.requestFullscreen?.bind(shell)
      ?? (shell as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(shell);
    request?.().then(() => {
      this.aromepiMapFullscreen = true;
      setTimeout(() => this.aromepiMap?.invalidateSize(), 120);
    }).catch(() => {
      this.aromepiMapFullscreen = !this.aromepiMapFullscreen;
      setTimeout(() => this.aromepiMap?.invalidateSize(), 120);
    });
  }

  private exitAromepiMapFullscreenIfActive(): void {
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void> };
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(document);
      exit?.().catch(() => {
        this.aromepiMapFullscreen = false;
        setTimeout(() => this.aromepiMap?.invalidateSize(), 120);
      });
      return;
    }
    if (this.aromepiMapFullscreen) {
      this.aromepiMapFullscreen = false;
      setTimeout(() => this.aromepiMap?.invalidateSize(), 120);
    }
  }

  formatAromepiTime(iso: string): string {
    if (!iso) {
      return '';
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return iso;
    }
    return d.toLocaleString(undefined, {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  aromepiLayerLabel(layer: { name: string; title: string; category?: string }): string {
    const i18nKey = `METEO_FRANCE.AROMEPI_LAYERS.${layer.name}`;
    const translated = this.translate.instant(i18nKey);
    if (translated && translated !== i18nKey) {
      return translated;
    }
    const fromParts = this.aromepiLayerLabelFromParts(layer.name);
    if (fromParts) {
      return fromParts;
    }
    if (layer.title && layer.title !== layer.name) {
      return layer.title;
    }
    return layer.name.replace(/__/g, ' · ').replace(/_/g, ' ');
  }

  private aromepiLayerLabelFromParts(name: string): string | null {
    const sep = name.indexOf('__');
    if (sep <= 0) {
      return null;
    }
    const param = name.substring(0, sep);
    const level = name.substring(sep + 2);
    const paramKey = `METEO_FRANCE.AROMEPI_PARAM.${param}`;
    const levelKey = `METEO_FRANCE.AROMEPI_LEVEL.${level}`;
    const paramLabel = this.translate.instant(paramKey);
    if (paramLabel === paramKey) {
      return null;
    }
    const levelLabel = this.translate.instant(levelKey);
    if (levelLabel !== levelKey) {
      return `${paramLabel} (${levelLabel})`;
    }
    return paramLabel;
  }

  aromepiCategoryLabel(category?: string): string {
    const key = category ? `METEO_FRANCE.AROMEPI_CAT_${category.toUpperCase()}` : 'METEO_FRANCE.AROMEPI_CAT_OTHER';
    return key;
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
    this.updateCountryCode(result.countryCode || result?.address?.country_code);
    this.departmentCode = this.departmentFromAddress(result?.address) || '';
    this.setLocation(result.lat, result.lon, true, true);
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

  private setLocation(lat: number, lon: number, moveMap: boolean, preserveDepartment = false): void {
    this.lat = lat;
    this.lon = lon;
    this.selectedLocationName = this.formatGpsCoordinates(lat, lon);
    this.errorMessage = '';
    if (this.marker) {
      this.marker.setLatLng([lat, lon]);
    }
    if (this.aromepiMarker) {
      this.aromepiMarker.setLatLng([lat, lon]);
    }
    if (moveMap && this.aromepiMap) {
      this.aromepiMap.setView([lat, lon], Math.max(this.aromepiMap.getZoom(), 7));
    }
    if (moveMap && this.map) {
      this.focusRadarMapOnPosition();
    }
    if (!preserveDepartment) {
      this.departmentCode = '';
      this.countryCode = '';
    }
    if (this.showTemperatureMap) {
      this.refreshMfTemperatureAvailability();
      this.fetchSelectedPointTemperature(lat, lon);
    }
    this.reverseGeocode(lat, lon);
    this.syncWeatherSourcePreferences();
    this.clearWeatherAndForecast();
    this.refreshClimatologyForLocation();
    this.scheduleAromepiForecastLoad();
  }

  /** Reload nearest-station climatology when the map location changes. */
  private refreshClimatologyForLocation(): void {
    if (!this.climAvailable) {
      return;
    }
    this.invalidateClimForLocationChange();
    if (this.activeMainTab === 'clim') {
      this.loadClimDataForCurrentPosition();
    }
  }

  private currentLocationKey(): string {
    return `${this.lat.toFixed(4)},${this.lon.toFixed(4)}`;
  }

  private isClimStaleForLocation(): boolean {
    return this.climDataLocationKey !== this.currentLocationKey();
  }

  private invalidateClimForLocationChange(): void {
    this.climDataLocationKey = '';
    this.climSelectedStationId = '';
    this.climStations = [];
    this.climData = null;
    this.climChartsReady = false;
    this.climErrorKey = '';
    this.climErrorDetail = '';
  }

  private markClimLocationLoaded(): void {
    this.climDataLocationKey = this.currentLocationKey();
  }

  /** Load climatology for the nearest station at the current map position. */
  private loadClimDataForCurrentPosition(): void {
    if (!this.climAvailable || this.isLoadingClim) {
      if (this.climAvailable && this.climDisplayRows.length && !this.isClimStaleForLocation()) {
        this.updateClimCharts();
      }
      return;
    }
    if (this.isClimStaleForLocation()) {
      this.climSelectedStationId = '';
      this.climStations = [];
    }
    this.loadClimData(this.climSelectedStationId || undefined);
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
            this.updateCountryCode(address.country_code);
          }
          const postcode = address?.postcode || address?.postal_code;
          if (postcode) {
            this.departmentCode = this.departmentFromPostcode(String(postcode));
          }
          if (this.activeMainTab === 'clim' && this.climAvailable) {
            this.loadClimDataForCurrentPosition();
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
    this.logBackend('METEO_FRANCE.LOG_CAT_CLIM', 'METEO_FRANCE.LOG_SOURCE_MF_DPCLIM', 'loading');
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
            this.markClimLocationLoaded();
            this.logBackend(
              'METEO_FRANCE.LOG_CAT_CLIM',
              'METEO_FRANCE.LOG_SOURCE_MF_DPCLIM',
              'error',
              this.climErrorDetail
            );
            setTimeout(() => this.updateClimCharts(), 0);
            return;
          }
          this.climData = data;
          this.climSelectedStationId = data?.station?.id || '';
          this.markClimLocationLoaded();
          const stationLabel = data?.station?.name || data?.station?.id || '';
          this.logBackend(
            'METEO_FRANCE.LOG_CAT_CLIM',
            'METEO_FRANCE.LOG_SOURCE_MF_DPCLIM',
            'ok',
            stationLabel ? String(stationLabel) : undefined
          );
          setTimeout(() => this.updateClimCharts(), 0);
        },
        error: () => {
          this.isLoadingClim = false;
          this.climData = null;
          this.climChartsReady = false;
          this.climErrorKey = 'METEO_FRANCE.CLIM_LOAD_ERROR';
          this.climErrorDetail = '';
          this.logBackend('METEO_FRANCE.LOG_CAT_CLIM', 'METEO_FRANCE.LOG_SOURCE_MF_DPCLIM', 'error');
        }
      })
    );
  }

  private loadClimStations(department: string): void {
    this.logBackend('METEO_FRANCE.LOG_CAT_CLIM', 'METEO_FRANCE.LOG_SOURCE_MF_DPCLIM', 'loading', department);
    this.subs.add(
      this.apiService.getMeteoFranceClimStations(department, this.climFrequency).subscribe({
        next: (data) => {
          this.climStations = data?.stations || [];
          this.logBackend(
            'METEO_FRANCE.LOG_CAT_CLIM',
            'METEO_FRANCE.LOG_SOURCE_MF_DPCLIM',
            'ok',
            `${this.climStations.length} ${this.translate.instant('METEO_FRANCE.LOG_STATIONS')}`
          );
        },
        error: () => {
          this.climStations = [];
          this.logBackend('METEO_FRANCE.LOG_CAT_CLIM', 'METEO_FRANCE.LOG_SOURCE_MF_DPCLIM', 'error', department);
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

  private departmentFromAddress(address: any): string {
    const postcode = address?.postcode || address?.postal_code;
    return postcode ? this.departmentFromPostcode(String(postcode)) : '';
  }

  private updateCountryCode(code: string | undefined | null): void {
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized || normalized === this.countryCode) {
      return;
    }
    const wasInFrance = this.isLocationInFrance();
    const hadMfSelectedPoint = this.selectedPointMfTempC != null;
    this.countryCode = normalized;
    this.syncWeatherSourcePreferences();
    const nowInFrance = this.isLocationInFrance();
    if (!this.isMfTemperaturePointAllowed()) {
      this.clearMfTemperatureFromSelectedPoint();
      this.updateSelectedTemperatureLabel();
    }
    if (wasInFrance === nowInFrance && !(nowInFrance && !hadMfSelectedPoint && this.isMfTemperaturePointAllowed())) {
      return;
    }
    this.syncMapLayerSourcePreferences();
    this.refreshMfTemperatureAvailability();
    if (this.showTemperatureMap) {
      this.fetchSelectedPointTemperature(this.lat, this.lon);
    }
  }

  private clearMfTemperatureFromSelectedPoint(): void {
    this.selectedPointUsesMf = false;
    this.selectedPointMfTempC = null;
    this.selectedPointMfStation = null;
    this.selectedPointMfStationDistKm = null;
    this.selectedPointMfObservedAt = null;
  }

  /** Drop MF map/label data when the selected position leaves France. */
  private refreshMfTemperatureAvailability(): void {
    if (!this.showTemperatureMap) {
      return;
    }
    if (!this.isLocationInFrance()) {
      this.clearMfTemperatureFromSelectedPoint();
      this.clearMapTemperatureGrid();
      this.updateSelectedTemperatureLabel();
      return;
    }
    this.temperatureLabelsRefreshTrigger = 'initial';
    this.scheduleTemperatureLabelsLoad();
  }

  clearBackendLog(): void {
    this.backendLogs = [];
  }

  formatBackendLogTime(at: Date): string {
    return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  backendLogStatusClass(status: MeteoBackendLogStatus): string {
    return status === 'ok' ? 'mf-log-ok' : status === 'error' ? 'mf-log-error' : 'mf-log-loading';
  }

  private logBackend(
    categoryKey: string,
    sourceKey: string,
    status: MeteoBackendLogStatus,
    detail?: string
  ): void {
    if (!this.showBackendLog) {
      return;
    }
    const entry: MeteoBackendLogEntry = {
      id: ++this.backendLogSeq,
      at: new Date(),
      categoryKey,
      sourceKey,
      status,
      detail: detail?.trim() || undefined
    };
    this.backendLogs = [entry, ...this.backendLogs].slice(0, MeteoFranceComponent.BACKEND_LOG_MAX);
  }

  private logBackendTemperatureSource(data: any, pointCount: number): void {
    const src = String(data?.source || '');
    let sourceKey = 'METEO_FRANCE.LOG_SOURCE_OPEN_METEO';
    if (src.includes('meteofrance') && src.includes('open-meteo')) {
      sourceKey = 'METEO_FRANCE.LOG_SOURCE_MF_DPOBS_OPEN_METEO';
    } else if (src.includes('meteofrance')) {
      sourceKey = 'METEO_FRANCE.LOG_SOURCE_MF_DPOBS';
    }
    const parts: string[] = [];
    if (pointCount >= 0) {
      parts.push(`${pointCount} ${this.translate.instant('METEO_FRANCE.LOG_POINTS')}`);
    }
    if (data?.cached) {
      parts.push(this.translate.instant('METEO_FRANCE.LOG_FROM_CACHE'));
    }
    if (data?.detailLevel) {
      parts.push(String(data.detailLevel));
    }
    this.logBackend('METEO_FRANCE.LOG_CAT_TEMPERATURE', sourceKey, 'ok', parts.join(' · '));
  }

  private clearWeatherAndForecast(): void {
    this.weatherRequestId++;
    this.currentWeather = null;
    this.forecast = null;
    this.displayForecastList = [];
    this.forecastErrorKey = '';
    this.isLoadingWeather = false;
    this.isLoadingForecast = false;
  }

  onCurrentWeatherSourceChange(): void {
    this.persistWeatherSourcePreference(
      this.currentWeatherSourceStorageKey(),
      this.currentWeatherSource
    );
    this.currentWeather = null;
    this.weatherRequestId++;
    this.isLoadingWeather = false;
  }

  onForecastWeatherSourceChange(): void {
    this.persistWeatherSourcePreference(
      MeteoFranceComponent.FORECAST_WEATHER_SOURCE_STORAGE_KEY,
      this.forecastWeatherSource
    );
    this.forecast = null;
    this.displayForecastList = [];
    this.forecastErrorKey = '';
    this.weatherRequestId++;
    this.isLoadingForecast = false;
  }

  getWeatherPanelSourceLabel(source: WeatherPanelSource): string {
    switch (source) {
      case 'meteofrance':
        return this.translate.instant('METEO_FRANCE.TEMPERATURE_SOURCE_MF');
      case 'open-meteo':
        return this.translate.instant('METEO_FRANCE.TEMPERATURE_SOURCE_OPENMETEO');
      default:
        return this.translate.instant('METEO_FRANCE.TEMPERATURE_SOURCE_OWM');
    }
  }

  resolveWeatherPanelBrand(source: WeatherPanelSource): WeatherDataSourceBrand {
    switch (source) {
      case 'meteofrance':
        return 'meteofrance';
      case 'open-meteo':
        return 'open-meteo';
      default:
        return 'openweathermap';
    }
  }

  resolveLoadedWeatherBrand(
    selectedSource: WeatherPanelSource,
    payload: any
  ): WeatherDataSourceBrand {
    const patSource = String(payload?.patSource || '').toLowerCase();
    if (patSource.includes('meteofrance')) {
      return 'meteofrance';
    }
    if (patSource.includes('open-meteo') || patSource.includes('openmeteo')) {
      return 'open-meteo';
    }
    if (patSource.includes('openweather')) {
      return 'openweathermap';
    }
    return this.resolveWeatherPanelBrand(selectedSource);
  }

  private persistLayerSourcePreference(key: string, source: string): void {
    try {
      localStorage.setItem(key, source);
    } catch {
      /* ignore */
    }
  }

  private defaultRadarLayerSource(): RadarLayerSource {
    if (this.isLocationInFrance() && this.radarAvailable) {
      return 'meteofrance';
    }
    return 'rainviewer';
  }

  private defaultCloudLayerSource(): CloudLayerSource {
    if (this.mfStatus?.openWeatherConfigured === false) {
      return 'rainviewer';
    }
    return 'openweathermap';
  }

  private syncMapLayerSourcePreferences(): void {
    const nextRadar = this.resolveRadarLayerSourcePreference();
    const nextCloud = this.resolveCloudLayerSourcePreference();
    const changed = nextRadar !== this.radarLayerSource
      || nextCloud !== this.cloudLayerSource;
    this.radarLayerSource = nextRadar;
    this.cloudLayerSource = nextCloud;
    if (changed && this.mapInitialized) {
      if (this.showRadar) {
        this.setupRadarLayer();
      }
      if (this.showCloudLayer) {
        this.setupCloudLayer();
      }
    }
  }

  private resolveRadarLayerSourcePreference(): RadarLayerSource {
    const defaultSource = this.defaultRadarLayerSource();
    if (!this.hasSavedLayerSourcePreference(MeteoFranceComponent.RADAR_LAYER_SOURCE_STORAGE_KEY)) {
      return defaultSource;
    }
    const saved = this.readLayerSourcePreference(
      MeteoFranceComponent.RADAR_LAYER_SOURCE_STORAGE_KEY,
      defaultSource
    );
    if (saved === 'meteofrance') {
      if (!this.isLocationInFrance() || !this.radarAvailable) {
        return 'rainviewer';
      }
    }
    return saved;
  }

  private resolveCloudLayerSourcePreference(): CloudLayerSource {
    const defaultSource = this.defaultCloudLayerSource();
    if (!this.hasSavedLayerSourcePreference(MeteoFranceComponent.CLOUD_LAYER_SOURCE_STORAGE_KEY)) {
      return defaultSource;
    }
    const saved = this.readLayerSourcePreference(
      MeteoFranceComponent.CLOUD_LAYER_SOURCE_STORAGE_KEY,
      defaultSource
    );
    if (saved === 'openweathermap' && this.mfStatus?.openWeatherConfigured === false) {
      return 'rainviewer';
    }
    return saved;
  }

  private hasSavedLayerSourcePreference(key: string): boolean {
    try {
      const raw = localStorage.getItem(key);
      return raw === 'meteofrance'
        || raw === 'rainviewer'
        || raw === 'openweathermap';
    } catch {
      return false;
    }
  }

  private readLayerSourcePreference<T extends string>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        return raw as T;
      }
    } catch {
      /* ignore */
    }
    return fallback;
  }

  private defaultCurrentWeatherSourceForLocation(): WeatherPanelSource {
    return this.isLocationInFrance() ? 'meteofrance' : 'openweathermap';
  }

  private defaultForecastWeatherSourceForLocation(): WeatherPanelSource {
    return 'openweathermap';
  }

  private currentWeatherSourceStorageKey(): string {
    return this.isLocationInFrance()
      ? MeteoFranceComponent.CURRENT_WEATHER_SOURCE_FR_STORAGE_KEY
      : MeteoFranceComponent.CURRENT_WEATHER_SOURCE_ABROAD_STORAGE_KEY;
  }

  private isLocationInFrance(): boolean {
    const code = (this.countryCode || '').trim().toUpperCase();
    if (code === 'FR') {
      return true;
    }
    if (code) {
      return false;
    }
    return this.isCoordinateInFranceMetropole(this.lat, this.lon);
  }

  private isCoordinateInFranceMetropole(lat: number, lon: number): boolean {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return false;
    }
    const b = MeteoFranceComponent.MF_OBS_VIEWPORT_BOUNDS;
    return lat >= b.south
      && lat <= b.north
      && lon >= b.west
      && lon <= b.east;
  }

  private shouldFetchMfTemperatureAt(_lat: number, _lon: number): boolean {
    return this.showTemperatureMap && this.isMfTemperaturePointAllowed();
  }

  /** MF point temperatures only when geocoded country is France (not near-border bbox). */
  private isMfTemperaturePointAllowed(): boolean {
    return (this.countryCode || '').trim().toUpperCase() === 'FR';
  }

  private hasSavedWeatherSourcePreference(key: string): boolean {
    try {
      const raw = localStorage.getItem(key);
      return raw === 'openweathermap' || raw === 'open-meteo' || raw === 'meteofrance';
    } catch {
      return false;
    }
  }

  private syncWeatherSourcePreferences(): void {
    this.migrateLegacyCurrentWeatherSourceStorage();
    const defaultCurrent = this.defaultCurrentWeatherSourceForLocation();
    const defaultForecast = this.defaultForecastWeatherSourceForLocation();
    const nextCurrent = this.resolveWeatherPanelSourcePreference(
      this.currentWeatherSourceStorageKey(),
      defaultCurrent
    );
    const nextForecast = this.resolveWeatherPanelSourcePreference(
      MeteoFranceComponent.FORECAST_WEATHER_SOURCE_STORAGE_KEY,
      defaultForecast
    );
    const changed = nextCurrent !== this.currentWeatherSource
      || nextForecast !== this.forecastWeatherSource;
    this.currentWeatherSource = nextCurrent;
    this.forecastWeatherSource = nextForecast;
    if (changed) {
      this.currentWeather = null;
      this.forecast = null;
      this.displayForecastList = [];
      this.forecastErrorKey = '';
      this.isLoadingWeather = false;
      this.isLoadingForecast = false;
    }
  }

  private resolveWeatherPanelSourcePreference(
    key: string,
    defaultSource: WeatherPanelSource
  ): WeatherPanelSource {
    if (!this.hasSavedWeatherSourcePreference(key)) {
      return defaultSource;
    }
    const saved = this.readWeatherSourcePreference(key, defaultSource);
    if (saved === 'meteofrance' && !this.isLocationInFrance()) {
      return 'openweathermap';
    }
    if (saved === 'meteofrance' && key === MeteoFranceComponent.FORECAST_WEATHER_SOURCE_STORAGE_KEY) {
      return defaultSource;
    }
    return saved;
  }

  private readWeatherSourcePreference(key: string, fallback: WeatherPanelSource): WeatherPanelSource {
    try {
      const raw = localStorage.getItem(key);
      if (raw === 'openweathermap' || raw === 'open-meteo' || raw === 'meteofrance') {
        return raw;
      }
    } catch {
      /* ignore */
    }
    return fallback;
  }

  private persistWeatherSourcePreference(key: string, source: WeatherPanelSource): void {
    try {
      localStorage.setItem(key, source);
    } catch {
      /* ignore */
    }
  }

  private weatherPanelLogSourceKey(source: WeatherPanelSource): string {
    switch (source) {
      case 'meteofrance':
        return 'METEO_FRANCE.LOG_SOURCE_MF_DPOBS';
      case 'open-meteo':
        return 'METEO_FRANCE.LOG_SOURCE_OPEN_METEO';
      default:
        return 'METEO_FRANCE.LOG_SOURCE_OWM';
    }
  }

  refreshWeather(): void {
    if (this.currentWeatherSource === 'meteofrance' && !this.isLocationInFrance()) {
      this.currentWeatherSource = 'openweathermap';
    }
    if (this.forecastWeatherSource === 'meteofrance' && !this.isLocationInFrance()) {
      this.forecastWeatherSource = 'openweathermap';
    }
    const requestId = ++this.weatherRequestId;
    this.isLoadingWeather = true;
    this.isLoadingForecast = true;
    this.forecastErrorKey = '';
    const currentLogSource = this.weatherPanelLogSourceKey(this.currentWeatherSource);
    const forecastLogSource = this.weatherPanelLogSourceKey(this.forecastWeatherSource);
    this.logBackend('METEO_FRANCE.LOG_CAT_CURRENT', currentLogSource, 'loading');
    this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', forecastLogSource, 'loading');
    this.subs.add(
      this.apiService.getCurrentWeatherByCoordinates(this.lat, this.lon, null, this.currentWeatherSource).subscribe({
        next: (data) => {
          if (requestId !== this.weatherRequestId) {
            return;
          }
          this.currentWeather = data;
          this.isLoadingWeather = false;
          if (data?.error) {
            this.logBackend('METEO_FRANCE.LOG_CAT_CURRENT', currentLogSource, 'error');
          } else {
            const label = data?.name
              ? String(data.name)
              : data?.mfStation?.name
                ? String(data.mfStation.name)
                : `${this.lat.toFixed(4)}, ${this.lon.toFixed(4)}`;
            this.logBackend('METEO_FRANCE.LOG_CAT_CURRENT', currentLogSource, 'ok', label);
          }
          if (data?.name && this.currentWeatherSource === 'openweathermap') {
            this.city = data.name;
          }
          if (data?.sys?.country && this.currentWeatherSource === 'openweathermap') {
            this.updateCountryCode(data.sys.country);
          }
          if (this.showTemperatureMap && this.currentWeatherSource === 'openweathermap') {
            this.scheduleTemperatureLabelsLoad();
          }
        },
        error: () => {
          if (requestId !== this.weatherRequestId) {
            return;
          }
          this.isLoadingWeather = false;
          this.errorMessage = 'METEO_FRANCE.WEATHER_ERROR';
          this.logBackend('METEO_FRANCE.LOG_CAT_CURRENT', currentLogSource, 'error');
        }
      })
    );
    this.subs.add(
      this.apiService.getForecastByCoordinates(this.lat, this.lon, null, this.forecastWeatherSource).subscribe({
        next: (data) => {
          if (requestId !== this.weatherRequestId) {
            return;
          }
          this.forecast = data;
          this.isLoadingForecast = false;
          if (data?.error) {
            this.forecastErrorKey = data.error === 'forecast_not_available'
              ? 'METEO_FRANCE.FORECAST_MF_UNAVAILABLE'
              : 'METEO_FRANCE.WEATHER_ERROR';
            this.displayForecastList = [];
            this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', forecastLogSource, 'error');
            return;
          }
          this.forecastErrorKey = '';
          this.updateForecastList();
          const count = Array.isArray(data?.list) ? data.list.length : 0;
          this.logBackend(
            'METEO_FRANCE.LOG_CAT_FORECAST',
            forecastLogSource,
            'ok',
            count ? `${count} ${this.translate.instant('METEO_FRANCE.LOG_STEPS')}` : undefined
          );
        },
        error: () => {
          if (requestId !== this.weatherRequestId) {
            return;
          }
          this.isLoadingForecast = false;
          this.forecastErrorKey = 'METEO_FRANCE.WEATHER_ERROR';
          this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', forecastLogSource, 'error');
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
