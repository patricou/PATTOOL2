import { Component, ChangeDetectorRef, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute, ParamMap } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { ApiService, ForecastSourceStreamEvent } from '../services/api.service';
import { WeatherHistoryCacheService } from '../services/weather-history-cache.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { LeafletBasemapOption, LeafletBasemapService } from '../shared/leaflet-basemap.service';
import { environment } from '../../environments/environment';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions, TooltipItem, registerables } from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import * as L from 'leaflet';
import { MeteoSwissPrecipTabComponent } from './meteo-swiss-precip-tab.component';
import { MeteoFranceChartPanelComponent } from './meteo-france-chart-panel.component';
import { MeteoChartFullscreenService } from './meteo-chart-fullscreen.service';
import { WeatherPointTimelineComponent } from '../shared/weather-point-timeline/weather-point-timeline.component';
import {
  meteoChartCompactPointRadius,
  withMeteoChartZoom
} from './meteo-france-chart.util';
import { catchError, forkJoin, of, Subscription, take } from 'rxjs';

Chart.register(...registerables);
Chart.register(zoomPlugin);

type TemperatureUnit = 'celsius' | 'fahrenheit';
type WeatherDataSourceBrand = 'meteofrance' | 'open-meteo' | 'openweathermap' | 'meteoswiss';
type WeatherPanelSource = 'openweathermap' | 'open-meteo' | 'meteofrance';
type MultiDayForecastDisplayParam = 'temp' | 'humidity' | 'wind' | 'precip' | 'pop' | 'weather';
type ForecastChartKind = 'line' | 'bar';
type ForecastChartStyle = 'auto' | 'line' | 'bar';

/** Normalized forward-geocode row (same shape as address-geocode). */
interface MeteoFranceGeocodeResult {
  lat: number;
  lon: number;
  displayName: string;
  address: Record<string, unknown>;
}

interface ForecastChartBlock {
  param: MultiDayForecastDisplayParam;
  labelKey: string;
  chartType: ForecastChartKind;
  data: ChartConfiguration<'line' | 'bar'>['data'];
  options: ChartOptions<'line' | 'bar'>;
}
type RadarLayerSource = 'meteofrance' | 'rainviewer';
type CloudLayerSource = 'openweathermap' | 'rainviewer';
type MeteoFranceMainTab = 'radar' | 'clim' | 'ms-hist' | 'aromepi' | 'forecast-options' | 'forecast-owm' | 'forecast-om' | 'forecast-ms' | 'ms-precip' | 'forecast-aggregate';

interface TemperatureGridPoint {
  lat: number;
  lon: number;
  tempC: number;
  stationId?: string;
  stationName?: string;
  stationLat?: number;
  stationLon?: number;
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
  altitudeM?: number;
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
  styleUrls: ['./meteo-france.component.css', './meteo-france-maps.shared.css'],
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, BaseChartDirective, MeteoFranceChartPanelComponent, WeatherPointTimelineComponent, MeteoSwissPrecipTabComponent]
})
export class MeteoFranceComponent implements OnInit, OnDestroy {

  private static readonly TEMP_UNIT_STORAGE_KEY = 'meteo-france.temperature-unit';
  private static readonly BACKEND_LOG_STORAGE_KEY = 'meteo-france.show-backend-log';
  private static readonly TEMP_TOOLTIPS_STORAGE_KEY = 'meteo-france.show-temperature-tooltips';
  private static readonly CURRENT_WEATHER_SOURCE_STORAGE_KEY = 'meteo-france.current-weather-source';
  private static readonly CURRENT_WEATHER_SOURCE_FR_STORAGE_KEY = 'meteo-france.current-weather-source.fr';
  private static readonly MS_FORECAST_LOADING_RETRY_MS = 15_000;
  private static readonly MS_FORECAST_LOADING_MAX_RETRIES = 10;
  private static readonly MS_FORECAST_CACHE_POLL_MS = 5_000;
  private static readonly MS_FORECAST_CACHE_POLL_MAX = 24;
  private static readonly CURRENT_WEATHER_SOURCE_ABROAD_STORAGE_KEY = 'meteo-france.current-weather-source.abroad';
  private static readonly FORECAST_WEATHER_SOURCE_STORAGE_KEY = 'meteo-france.forecast-weather-source';
  private static readonly MULTI_DAY_FORECAST_PARAMS_STORAGE_KEY = 'meteo-france.multi-day-forecast-params';
  private static readonly FORECAST_CHART_STYLE_STORAGE_KEY = 'meteo-france.forecast-chart-style';
  private static readonly RADAR_LAYER_SOURCE_STORAGE_KEY = 'meteo-france.radar-layer-source';
  private static readonly CLOUD_LAYER_SOURCE_STORAGE_KEY = 'meteo-france.cloud-layer-source';
  private static readonly MAP_BASE_LAYER_STORAGE_KEY = 'meteo-france.map-base-layer';
  private static readonly LOGO_MF = 'assets/images/meteofrance-logo.svg';
  private static readonly LOGO_OPEN_METEO = 'assets/images/open-meteo-logo.svg';
  private static readonly LOGO_OWM = 'assets/images/openweathermap-logo.svg';
  private static readonly LOGO_METEOSWISS = 'assets/images/meteoswiss-logo.svg';
  private static readonly MF_OBS_VIEWPORT_BOUNDS = {
    south: 42.0,
    north: 51.2,
    west: -5.2,
    east: 8.5,
  };
  private static readonly CH_OBS_VIEWPORT_BOUNDS = {
    south: 45.82,
    north: 47.81,
    west: 5.96,
    east: 10.49,
  };
  private static readonly TEMP_LABEL_LOGO_EXTRA_PX = 24;
  /** Default zoom for the rain-radar map — centered on the selected position. */
  private static readonly RADAR_MAP_ZOOM = 13;
  /** Default zoom for forecast maps (AROME-PI + multi-day forecast tabs). */
  private static readonly FORECAST_MAP_ZOOM = 12;
  private static readonly CLIM_TEMP_COLUMNS = new Set(['TN', 'TNT', 'TX', 'TM', 'T', 'TAT', 'TROS']);

  @ViewChild('mapShell') mapShell?: ElementRef<HTMLElement>;
  @ViewChild('aromepiMapShell') aromepiMapShell?: ElementRef<HTMLElement>;
  @ViewChild(WeatherPointTimelineComponent) pointTempTimeline?: WeatherPointTimelineComponent;
  @ViewChild(MeteoSwissPrecipTabComponent) msPrecipTab?: MeteoSwissPrecipTabComponent;

  pointTempTimelineVisible = false;

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
  climHumidityChartData: ChartConfiguration<'line'>['data'] = { labels: [], datasets: [] };
  climWindChartData: ChartConfiguration<'line'>['data'] = { labels: [], datasets: [] };
  climTempChartOptions: ChartOptions<'line'> = this.buildClimTempChartOptions();
  climRainChartOptions: ChartOptions<'bar'> = this.buildClimRainChartOptions();
  climHumidityChartOptions: ChartOptions<'line'> = this.buildClimScalarChartOptions('%');
  climWindChartOptions: ChartOptions<'line'> = this.buildClimScalarChartOptions('m/s');
  climChartsReady = false;
  climShowTable = false;

  readonly msHistPeriodOptions: ClimPeriodOption[] = [
    { days: 7, labelKey: 'METEO_FRANCE.CLIM_PERIOD_7D' },
    { days: 14, labelKey: 'METEO_FRANCE.CLIM_PERIOD_14D' },
    { days: 30, labelKey: 'METEO_FRANCE.CLIM_PERIOD_1M' }
  ];
  msHistDays = 7;
  msHistData: any = null;
  isLoadingMsHist = false;
  msHistErrorKey = '';
  msHistErrorDetail = '';
  msHistPeriodStart = '';
  msHistPeriodEnd = '';
  msHistRequestedDays = 7;
  msHistChartsReady = false;
  msHistShowTable = false;
  msHistTempChartData: ChartConfiguration<'line'>['data'] = { labels: [], datasets: [] };
  msHistRainChartData: ChartConfiguration<'bar'>['data'] = { labels: [], datasets: [] };
  msHistHumidityChartData: ChartConfiguration<'line'>['data'] = { labels: [], datasets: [] };
  msHistWindChartData: ChartConfiguration<'line'>['data'] = { labels: [], datasets: [] };
  msHistTempChartOptions: ChartOptions<'line'> = this.buildClimTempChartOptions();
  msHistRainChartOptions: ChartOptions<'bar'> = this.buildClimRainChartOptions();
  msHistHumidityChartOptions: ChartOptions<'line'> = this.buildClimScalarChartOptions('%');
  msHistWindChartOptions: ChartOptions<'line'> = this.buildClimScalarChartOptions('m/s');
  private msHistDataCacheKey = '';
  climFromCache = false;
  msHistFromCache = false;
  isClearingClimHistoryCache = false;
  isClearingMsHistHistoryCache = false;

  owmForecastChartBlocks: ForecastChartBlock[] = [];
  omForecastChartBlocks: ForecastChartBlock[] = [];
  msForecastChartBlocks: ForecastChartBlock[] = [];
  aggregateForecastChartBlocks: ForecastChartBlock[] = [];
  owmForecastChartsReady = false;
  omForecastChartsReady = false;
  msForecastChartsReady = false;
  aggregateForecastChartsReady = false;
  aromepiForecastChartBlocks: ForecastChartBlock[] = [];
  aromepiForecastChartsReady = false;

  readonly meteoFranceApiPortalUrl = 'https://portail-api.meteofrance.fr/web/fr/';

  constructor(
    private apiService: ApiService,
    private historyCache: WeatherHistoryCacheService,
    private keycloakService: KeycloakService,
    private translate: TranslateService,
    private basemapService: LeafletBasemapService,
    private cdr: ChangeDetectorRef,
    private chartFullscreen: MeteoChartFullscreenService,
    private route: ActivatedRoute
  ) {}


  city = '';
  countryCode = '';
  lat = 48.8566;
  lon = 2.3522;
  fullAddress = '';

  currentWeather: any = null;
  currentWeatherSource: WeatherPanelSource = 'meteofrance';
  readonly weatherPanelSources: WeatherPanelSource[] = ['openweathermap', 'open-meteo', 'meteofrance'];

  owmForecast: any = null;
  owmForecastErrorKey = '';
  isLoadingOwmForecast = false;

  omForecast: any = null;
  omForecastErrorKey = '';
  isLoadingOmForecast = false;

  msForecast: any = null;
  msForecastErrorKey = '';
  msForecastErrorDetail = '';
  isLoadingMsForecast = false;
  msForecastCacheLoading = false;
  msForecastCachePollCount = 0;
  private msForecastLoadingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private msForecastCachePollTimer: ReturnType<typeof setTimeout> | null = null;
  private msForecastLoadingRetryCount = 0;

  aggregatedForecast: any = null;
  aggregatedForecastErrorKey = '';
  isLoadingAggregatedForecast = false;

  forecastHorizonHours = 24;
  forecastStepMinutes = 60;
  readonly forecastHorizonMinHours = 24;
  readonly forecastHorizonMaxHours = 240;
  readonly forecastStepMinMinutes = 6;
  readonly forecastStepMaxMinutes = 1440;
  readonly forecastHorizonOptions: number[] = [24, 48, 72, 96, 120, 144, 168, 192, 216, 240];
  readonly forecastStepOptions: number[] = [6, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 720, 1440];
  multiDayForecastDisplayParams: MultiDayForecastDisplayParam[] = [
    'temp', 'humidity', 'wind', 'precip', 'pop'
  ];
  forecastChartStyle: ForecastChartStyle = 'auto';
  readonly forecastChartStyleOptions: ForecastChartStyle[] = ['auto', 'line', 'bar'];
  readonly multiDayForecastParamOptions: Array<{ id: MultiDayForecastDisplayParam; labelKey: string }> = [
    { id: 'temp', labelKey: 'METEO_FRANCE.AGG_COL_TEMP' },
    { id: 'humidity', labelKey: 'METEO_FRANCE.HUMIDITY' },
    { id: 'wind', labelKey: 'METEO_FRANCE.WIND' },
    { id: 'precip', labelKey: 'METEO_FRANCE.PRECIP' },
    { id: 'pop', labelKey: 'METEO_FRANCE.RAIN_CHANCE' },
    { id: 'weather', labelKey: 'METEO_FRANCE.FORECAST_PARAM_WEATHER' }
  ];

  private owmForecastRequestId = 0;
  private omForecastRequestId = 0;
  private msForecastRequestId = 0;
  private aggregatedForecastRequestId = 0;
  private aggregatedForecastSourceLists: Partial<Record<'meteofrance' | 'meteoswiss' | 'open-meteo' | 'openweathermap', any[]>> = {};
  private aggregatedForecastSourceErrorsInternal: Record<string, string> = {};
  private aggregatedForecastStreamAbort: AbortController | null = null;
  radarLayerSource: RadarLayerSource = 'rainviewer';
  cloudLayerSource: CloudLayerSource = 'openweathermap';
  readonly radarLayerSources: RadarLayerSource[] = ['meteofrance', 'rainviewer'];
  readonly cloudLayerSources: CloudLayerSource[] = ['openweathermap', 'rainviewer'];
  mapBaseLayerId = 'osm-standard';

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
  isLoadingCitySearch = false;
  isLoadingGps = false;
  citySearchResults: MeteoFranceGeocodeResult[] = [];
  private citySearchCache = new Map<string, MeteoFranceGeocodeResult[]>();
  private citySearchRequestId = 0;

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
  temperatureLabelSource: 'meteofrance-dpobs' | 'meteoswiss-smn' | 'open-meteo' | null = null;
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
  radarRefreshCountdown = 0;
  activeMainTab: MeteoFranceMainTab = 'radar';
  radarRefreshSeconds = 60;
  readonly radarRefreshMinSeconds = 30;
  readonly radarRefreshMaxSeconds = 600;
  temperatureCacheMinutes = 5;
  readonly temperatureCacheMinMinutes = 1;
  readonly temperatureCacheMaxMinutes = 120;
  isClearingTemperatureCache = false;
  historyCacheDays = 14;
  readonly historyCacheMinDays = 1;
  readonly historyCacheMaxDays = 90;
  aromepiPrefetchAhead = 5;
  readonly aromepiPrefetchAheadMin = 5;
  readonly aromepiPrefetchAheadMax = 12;

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
  private climDataCacheKey = '';

  stationHistoryModalVisible = false;
  stationHistoryPoint: TemperatureGridPoint | null = null;
  stationHistoryFrequency: 'quotidienne' | 'horaire' = 'horaire';
  stationHistoryDays = 7;
  stationHistoryData: any = null;
  stationHistoryLoading = false;
  stationHistoryErrorKey = '';
  stationHistoryErrorDetail = '';
  stationHistoryPeriodStart = '';
  stationHistoryPeriodEnd = '';
  stationHistoryRequestedDays = 7;
  stationHistoryChartsReady = false;
  stationHistoryShowTable = false;
  stationHistoryTempChartData: ChartConfiguration<'line'>['data'] = { labels: [], datasets: [] };
  stationHistoryHumidityChartData: ChartConfiguration<'line'>['data'] = { labels: [], datasets: [] };
  stationHistoryWindChartData: ChartConfiguration<'line'>['data'] = { labels: [], datasets: [] };
  stationHistoryRainChartData: ChartConfiguration<'bar'>['data'] = { labels: [], datasets: [] };
  stationHistoryPressureChartData: ChartConfiguration<'line'>['data'] = { labels: [], datasets: [] };
  stationHistoryTempChartOptions: ChartOptions<'line'> = this.buildClimTempChartOptions();
  stationHistoryHumidityChartOptions: ChartOptions<'line'> = this.buildClimScalarChartOptions('%');
  stationHistoryWindChartOptions: ChartOptions<'line'> = this.buildClimScalarChartOptions('m/s');
  stationHistoryRainChartOptions: ChartOptions<'bar'> = this.buildClimRainChartOptions();
  stationHistoryPressureChartOptions: ChartOptions<'line'> = this.buildClimScalarChartOptions('hPa');


  aromepiCapabilities: any = null;
  aromepiLayers: Array<{ name: string; title: string; style?: string; category?: string }> = [];
  aromepiSelectedLayer = '';
  aromepiSelectedStyle = '';
  aromepiTimeSteps: string[] = [];
  aromepiReferenceTime = '';
  aromepiFrameIndex = 0;
  aromepiOpacity = 0.72;
  aromepiPlaying = false;
  aromepiMapFullscreen = false;
  isLoadingAromepiCapabilities = false;
  isLoadingAromepiForecast = false;
  aromepiErrorKey = '';
  aromepiPointForecast: any = null;
  aromepiCurrentValues: Record<string, unknown> = {};
  aromepiLoadError = false;
  aromepiNearestStation: { id: string; name?: string; distanceKm?: number } | null = null;
  aromepiNearestStationStatus: 'idle' | 'loading' | 'ok' | 'unavailable' | 'outside-france' = 'idle';
  private aromepiNearestStationRequestId = 0;

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
  private selectedTempLabelDismissed = false;
  private selectedPointTempC: number | null = null;
  private selectedPointMfTempC: number | null = null;
  private selectedPointUsesMf = false;
  private selectedPointMfStation: { id?: string; name?: string } | null = null;
  private selectedPointMfStationDistKm: number | null = null;
  private selectedPointOpenMeteoTempC: number | null = null;
  private selectedPointOpenWeatherTempC: number | null = null;
  private selectedPointMfObservedAt: string | null = null;
  private selectedPointMsTempC: number | null = null;
  private selectedPointMsStation: { id?: string; name?: string } | null = null;
  private selectedPointMsStationDistKm: number | null = null;
  private selectedPointMsObservedAt: string | null = null;
  private selectedPointOpenMeteoObservedAt: string | null = null;
  private selectedPointOpenWeatherObservedAt: string | null = null;
  private selectedPointOpenWeatherPlace: string | null = null;
  private selectedPointOpenWeatherDistKm: number | null = null;
  private selectedPointComparisonReady = false;
  selectedPointComparisonLoading = false;
  private selectedLocationName = '';
  private reverseGeocodeRequestId = 0;
  private locationGeocodeKey = '';
  private weatherRequestId = 0;
  private selectedTempRequestId = 0;
  private temperatureGridPoints: TemperatureGridPoint[] = [];
  private temperatureLabelsDebounce: ReturnType<typeof setTimeout> | null = null;
  private temperatureLabelsRequestId = 0;
  private temperatureLabelsLoadSub: Subscription | null = null;
  private readonly refreshingTemperatureKeys = new Set<string>();
  private readonly stationAltitudeCache = new Map<string, number | null>();
  private readonly stationAltitudeInflight = new Map<string, Subscription>();
  private cloudIntensityReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private mosaicObjectUrl: string | null = null;
  private readonly radarBounds: L.LatLngBoundsExpression = [[40.8, -5.6], [52.0, 10.2]];
  private readonly subs = new Subscription();
  private mosaicRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private mapInitialized = false;
  private aromepiMap: L.Map | null = null;
  private aromepiMarker: L.Marker | null = null;
  private aromepiWmsLayer: L.TileLayer | null = null;
  private aromepiWmsLayerPending: L.TileLayer | null = null;
  private aromepiWmsCrossfadeTimer: ReturnType<typeof setInterval> | null = null;
  private aromepiWmsTransitioning = false;
  private aromepiMapInitialized = false;
  private forecastMap: L.Map | null = null;
  private forecastMarker: L.Marker | null = null;
  private forecastMapInitialized = false;
  private forecastBaseLayer: L.TileLayer | L.LayerGroup | null = null;
  private aromepiBaseLayer: L.TileLayer | L.LayerGroup | null = null;
  private aromepiPlayScheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private aromepiPrefetchLayers = new Map<number, L.TileLayer>();
  private aromepiForecastDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private weatherReloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private aromepiWmsCrossfadeFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private forecastMapInitRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly forecastMapLayoutTimers = new Set<ReturnType<typeof setTimeout>>();
  private aromepiMapInitRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly aromepiMapLayoutTimers = new Set<ReturnType<typeof setTimeout>>();
  private initMapTimer: ReturnType<typeof setTimeout> | null = null;
  private componentDestroyed = false;
  private static readonly AROMEPI_WMS_CROSSFADE_MS = 320;
  private static readonly AROMEPI_PLAY_CROSSFADE_MS = 180;
  private static readonly AROMEPI_PLAY_FRAME_DWELL_MS = 450;
  private static readonly AROMEPI_PLAY_DATA_WAIT_MS = 900;
  /** Point temperature timeline: 7 d history + 7 d forecast, one sample every 2 h. */
  /** AROME-PI WMS native resolution (independent of multi-day forecast options). */
  private static readonly AROMEPI_FORECAST_HORIZON_MINUTES = 360;
  private static readonly AROMEPI_FORECAST_STEP_MINUTES = 15;
  /** Zoom from router deep link (trace viewer, etc.) applied on next radar map focus. */
  private pendingRadarMapZoom: number | null = null;
  /** Shared center/zoom kept in sync across radar, AROME-PI and forecast-options maps. */
  private sharedMapCenterLat: number | null = null;
  private sharedMapCenterLon: number | null = null;
  private sharedMapZoom: number | null = null;
  private syncingMapView = false;

  ngOnInit(): void {
    this.loadTemperatureUnitPreference();
    this.loadBackendLogPreference();
    this.loadTemperatureTooltipsPreference();
    this.fixLeafletIcons();
    this.loadMeteoFranceStatus();
    this.loadRadarPreferences();
    this.loadForecastPreferences();
    this.loadMultiDayForecastDisplayParams();
    this.loadForecastChartStylePreference();
    this.loadTemperatureCachePreferences();
    this.loadHistoryCachePreferences();
    this.loadAromepiPlaybackPreferences();
    this.mapBaseLayerId = this.readMapBaseLayerPreference();
    this.basemapService.loadOptionalLayers(this.apiService);

    const hadDeepLink = this.applyNavigationQueryParams(this.route.snapshot.queryParamMap);
    this.subs.add(
      this.route.queryParamMap.subscribe((params) => {
        if (!this.applyNavigationQueryParams(params)) {
          return;
        }
        if (this.mapInitialized) {
          this.onMainTabChange('radar');
        }
      })
    );
    this.subs.add(
      this.translate.onLangChange.subscribe(() => {
        if (this.aromepiForecastSteps.length) {
          this.updateAromepiForecastCharts();
        }
        this.cdr.markForCheck();
      })
    );

    if (hadDeepLink) {
      this.bootstrapMeteoFranceLocation();
      return;
    }

    this.isLoadingGps = true;
    this.getUserLocation().then((location) => {
      this.setLocation(location.lat, location.lng, false);
    }).finally(() => {
      this.bootstrapMeteoFranceLocation();
    });
  }

  private bootstrapMeteoFranceLocation(): void {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      this.setLocation(48.8566, 2.3522, false);
    }
    this.syncWeatherSourcePreferences();
    this.syncMapLayerSourcePreferences();
    this.loadRadarPreferences();
    this.loadForecastPreferences();
    this.loadMultiDayForecastDisplayParams();
    this.refreshMfTemperatureAvailability();
    this.isLoadingGps = false;
    this.initMapTimer = this.scheduleComponentTimeout(() => this.initMap(), 0);
    if (this.activeMainTab === 'aromepi') {
      this.scheduleAromepiMapInit(() => {
        if (this.aromepiAvailable) {
          this.ensureAromepiCapabilitiesLoaded();
        }
      });
    }
  }

  /** Deep link: ?lat=&lon=&z=&tab=radar&temp=1&radar=1 (from trace viewer, etc.). */
  private applyNavigationQueryParams(params: ParamMap): boolean {
    const latStr = params.get('lat');
    const lonStr = params.get('lon') ?? params.get('lng');
    if (!latStr || !lonStr) {
      return false;
    }
    const lat = parseFloat(latStr);
    const lon = parseFloat(lonStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return false;
    }

    const zStr = params.get('z') ?? params.get('zoom');
    if (zStr != null && zStr !== '') {
      const z = parseFloat(zStr);
      if (Number.isFinite(z) && z >= 2 && z <= 18) {
        this.pendingRadarMapZoom = z;
        this.sharedMapZoom = z;
      }
    }

    const tab = params.get('tab');
    if (tab === 'radar' || tab === 'clim' || tab === 'ms-hist' || tab === 'aromepi' || tab === 'forecast-owm'
      || tab === 'forecast-om' || tab === 'forecast-ms' || tab === 'ms-precip' || tab === 'forecast-aggregate' || tab === 'forecast-options') {
      this.activeMainTab = tab;
    } else if (params.get('temp') === '1' || params.get('radar') === '1') {
      this.activeMainTab = 'radar';
    }

    if (params.get('radar') === '1') {
      this.showRadar = true;
    } else if (params.get('radar') === '0') {
      this.showRadar = false;
    }
    if (params.get('temp') === '1') {
      this.showTemperatureMap = true;
    } else if (params.get('temp') === '0') {
      this.showTemperatureMap = false;
    }

    this.setLocation(lat, lon, this.mapInitialized);
    this.activeMainTab = this.resolveRegionalMainTab(this.activeMainTab);
    return true;
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
    this.componentDestroyed = true;
    this.invalidateInFlightRequests();
    this.abortAggregatedForecastStream();
    this.exitMapFullscreenIfActive();
    this.exitAromepiMapFullscreenIfActive();
    this.temperatureLabelsLoadSub?.unsubscribe();
    this.temperatureLabelsLoadSub = null;
    for (const sub of this.stationAltitudeInflight.values()) {
      sub.unsubscribe();
    }
    this.stationAltitudeInflight.clear();
    this.subs.unsubscribe();
    this.clearRadarTimers();
    this.stopAromepiAnimation();
    this.cancelAromepiWmsCrossfade();
    this.clearAromepiPrefetchLayers();
    this.clearAromepiWmsCrossfadeFallbackTimer();
    this.clearForecastMapTimers();
    this.clearAromepiMapTimers();
    this.clearMsForecastCacheWatch();
    this.clearMsForecastLoadingRetry();
    if (this.initMapTimer) {
      clearTimeout(this.initMapTimer);
      this.initMapTimer = null;
    }
    if (this.aromepiForecastDebounceTimer) {
      clearTimeout(this.aromepiForecastDebounceTimer);
      this.aromepiForecastDebounceTimer = null;
    }
    if (this.weatherReloadDebounceTimer) {
      clearTimeout(this.weatherReloadDebounceTimer);
      this.weatherReloadDebounceTimer = null;
    }
    if (this.cloudIntensityReloadTimer) {
      clearTimeout(this.cloudIntensityReloadTimer);
      this.cloudIntensityReloadTimer = null;
    }
    if (this.forecastChartRefreshTimer) {
      clearTimeout(this.forecastChartRefreshTimer);
      this.forecastChartRefreshTimer = null;
    }
    this.clearTemperatureLabelsDebounce();
    this.detachTemperatureLabelListeners();
    this.detachMapContainerListeners();
    this.removeCloudLayers();
    this.removeRadarLayers();
    this.removeTemperatureLabels();
    this.clearForecastCharts();
    if (this.aromepiMap) {
      if (this.aromepiWmsLayer) {
        this.aromepiMap.removeLayer(this.aromepiWmsLayer);
        this.aromepiWmsLayer = null;
      }
      if (this.aromepiWmsLayerPending) {
        this.aromepiMap.removeLayer(this.aromepiWmsLayerPending);
        this.aromepiWmsLayerPending = null;
      }
      this.aromepiMap.remove();
      this.aromepiMap = null;
      this.aromepiMarker = null;
      this.aromepiBaseLayer = null;
      this.aromepiMapInitialized = false;
    }
    if (this.map) {
      this.map.remove();
      this.map = null;
      this.marker = null;
      this.activeBaseLayer = null;
      this.mapInitialized = false;
    }
    this.destroyForecastMap();
  }

  private invalidateInFlightRequests(): void {
    this.weatherRequestId++;
    this.selectedTempRequestId++;
    this.temperatureLabelsRequestId++;
    this.reverseGeocodeRequestId++;
    this.owmForecastRequestId++;
    this.omForecastRequestId++;
    this.msForecastRequestId++;
    this.aggregatedForecastRequestId++;
  }

  private scheduleComponentTimeout(fn: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (this.componentDestroyed) {
        return;
      }
      fn();
    }, delayMs);
    return timer;
  }

  private scheduleForecastMapLayoutRefresh(delayMs: number): void {
    const timer = setTimeout(() => {
      this.forecastMapLayoutTimers.delete(timer);
      if (this.componentDestroyed) {
        return;
      }
      this.refreshForecastMapLayout();
    }, delayMs);
    this.forecastMapLayoutTimers.add(timer);
  }

  private clearForecastMapTimers(): void {
    if (this.forecastMapInitRetryTimer) {
      clearTimeout(this.forecastMapInitRetryTimer);
      this.forecastMapInitRetryTimer = null;
    }
    for (const timer of this.forecastMapLayoutTimers) {
      clearTimeout(timer);
    }
    this.forecastMapLayoutTimers.clear();
  }

  private scheduleAromepiMapLayoutRefresh(delayMs: number): void {
    const timer = setTimeout(() => {
      this.aromepiMapLayoutTimers.delete(timer);
      if (this.componentDestroyed) {
        return;
      }
      this.refreshAromepiMapLayout();
    }, delayMs);
    this.aromepiMapLayoutTimers.add(timer);
  }

  private clearAromepiMapTimers(): void {
    if (this.aromepiMapInitRetryTimer) {
      clearTimeout(this.aromepiMapInitRetryTimer);
      this.aromepiMapInitRetryTimer = null;
    }
    for (const timer of this.aromepiMapLayoutTimers) {
      clearTimeout(timer);
    }
    this.aromepiMapLayoutTimers.clear();
  }

  private detachMapContainerListeners(): void {
    this.map?.getContainer()?.removeEventListener('click', this.onTemperatureTooltipClick);
  }

  private clearAromepiWmsCrossfadeFallbackTimer(): void {
    if (this.aromepiWmsCrossfadeFallbackTimer) {
      clearTimeout(this.aromepiWmsCrossfadeFallbackTimer);
      this.aromepiWmsCrossfadeFallbackTimer = null;
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
    return this.isSelectedPointInFrance;
  }

  get isSwissLocation(): boolean {
    return this.isSelectedPointInSwitzerland;
  }

  get isSelectedPointInFrance(): boolean {
    return this.isLocationInFrance();
  }

  get isSelectedPointInSwitzerland(): boolean {
    return this.isLocationInSwitzerland();
  }

  /** MF or MeteoSwiss station markers on the map when location and viewport match. */
  get showMapTemperatureGrid(): boolean {
    return this.shouldShowStationLabels();
  }

  /** Click comparison includes MF only when the selected position is in France. */
  get showMfInPointComparison(): boolean {
    return this.showTemperatureMap && this.isMfTemperaturePointAllowed();
  }

  get isPositionInFrance(): boolean {
    return this.isLocationInFrance();
  }

  get isPositionInSwitzerland(): boolean {
    return this.isLocationInSwitzerland();
  }

  get showTemperatureMapHintKey(): string {
    if (this.shouldShowMsStationLabels()) {
      return 'METEO_FRANCE.SHOW_TEMPERATURE_MAP_HINT_MS';
    }
    if (this.shouldShowMfStationLabels()) {
      return 'METEO_FRANCE.SHOW_TEMPERATURE_MAP_HINT';
    }
    return 'METEO_FRANCE.SHOW_TEMPERATURE_MAP_HINT';
  }

  get availableWeatherPanelSources(): WeatherPanelSource[] {
    if (this.isLocationInFrance()) {
      return this.weatherPanelSources;
    }
    return this.weatherPanelSources.filter((source) => source !== 'meteofrance');
  }

  private shouldShowMfStationLabels(): boolean {
    return this.showTemperatureMap && this.isLocationInFrance();
  }

  private shouldShowMsStationLabels(): boolean {
    return this.showTemperatureMap && this.isLocationInSwitzerland();
  }

  private shouldShowStationLabels(): boolean {
    return this.shouldShowMfStationLabels() || this.shouldShowMsStationLabels();
  }

  private activeStationTemperatureProvider(): 'mf' | 'ms' | null {
    if (this.isLocationInSwitzerland()) {
      return 'ms';
    }
    if (this.isLocationInFrance()) {
      return 'mf';
    }
    return null;
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

  private isMsStationLabelPoint(point: TemperatureGridPoint): boolean {
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
    return source.includes('meteoswiss');
  }

  private filterMsStationLabelPoints(points: TemperatureGridPoint[]): TemperatureGridPoint[] {
    return points.filter((point) => this.isMsStationLabelPoint(point));
  }

  private filterActiveStationLabelPoints(points: TemperatureGridPoint[]): TemperatureGridPoint[] {
    return this.activeStationTemperatureProvider() === 'ms'
      ? this.filterMsStationLabelPoints(points)
      : this.filterMfStationLabelPoints(points);
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

  private isMapViewportServedByMsObs(): boolean {
    if (!this.map) {
      return this.isLocationInSwitzerland();
    }
    const center = this.map.getCenter();
    const b = MeteoFranceComponent.CH_OBS_VIEWPORT_BOUNDS;
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
    if (this.shouldShowMsStationLabels()) {
      return 'METEO_FRANCE.TEMPERATURE_MAP_HINT_MS';
    }
    if (this.shouldShowMfStationLabels()) {
      return 'METEO_FRANCE.TEMPERATURE_MAP_HINT_MF';
    }
    return 'METEO_FRANCE.TEMPERATURE_MAP_HINT_POINT_ONLY';
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
    if (this.temperatureLabelSource === 'meteoswiss-smn') {
      return this.translate.instant('METEO_FRANCE.TEMPERATURE_SOURCE_MS');
    }
    if (this.temperatureLabelSource === 'meteofrance-dpobs') {
      return this.translate.instant('METEO_FRANCE.TEMPERATURE_SOURCE_MF');
    }
    if (this.temperatureLabelSource === 'open-meteo') {
      return this.translate.instant('METEO_FRANCE.TEMPERATURE_SOURCE_OPENMETEO');
    }
    if (this.shouldShowMsStationLabels()) {
      return this.translate.instant('METEO_FRANCE.TEMPERATURE_SOURCE_MS');
    }
    if (this.shouldShowMfStationLabels()) {
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

  get regionalProviderTabBrand(): WeatherDataSourceBrand {
    if (this.isLocationInSwitzerland()) {
      return 'meteoswiss';
    }
    if (this.isLocationInFrance()) {
      return 'meteofrance';
    }
    return 'openweathermap';
  }

  /** Radar tab icon: regional provider logo, or globe when outside France and Switzerland. */
  get radarTabHeaderBrand(): 'meteofrance' | 'meteoswiss' | 'world' {
    return this.pageHeaderBrand;
  }

  get pageHeaderBrand(): 'meteofrance' | 'meteoswiss' | 'world' {
    if (this.isLocationInSwitzerland()) {
      return 'meteoswiss';
    }
    if (this.isLocationInFrance()) {
      return 'meteofrance';
    }
    return 'world';
  }

  get pageHeaderBrandLogo(): string | null {
    if (this.pageHeaderBrand === 'meteoswiss') {
      return MeteoFranceComponent.LOGO_METEOSWISS;
    }
    if (this.pageHeaderBrand === 'meteofrance') {
      return MeteoFranceComponent.LOGO_MF;
    }
    return null;
  }

  get pageHeaderBrandAlt(): string {
    switch (this.pageHeaderBrand) {
      case 'meteoswiss':
        return 'MeteoSwiss';
      case 'meteofrance':
        return 'Météo-France';
      default:
        return 'World';
    }
  }

  get pageHeaderBrandLinkKey(): string {
    switch (this.pageHeaderBrand) {
      case 'meteoswiss':
        return 'METEO_FRANCE.MS_PORTAL_LINK';
      default:
        return 'METEO_FRANCE.MF_API_PORTAL_LINK';
    }
  }

  get pageHeaderBrandUrl(): string {
    if (this.pageHeaderBrand === 'meteoswiss') {
      const lat = this.formatCoordForProviderUrl(this.lat);
      const lon = this.formatCoordForProviderUrl(this.lon);
      return `https://www.meteoswiss.admin.ch/?latitude=${lat}&longitude=${lon}`;
    }
    return this.meteoFranceApiPortalUrl;
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
      case 'meteoswiss':
        return MeteoFranceComponent.LOGO_METEOSWISS;
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
      case 'meteoswiss':
        return 'MeteoSwiss';
      default:
        return 'Open-Meteo';
    }
  }

  buildProviderForecastUrl(brand: WeatherDataSourceBrand): string {
    const lat = this.formatCoordForProviderUrl(this.lat);
    const lon = this.formatCoordForProviderUrl(this.lon);
    switch (brand) {
      case 'openweathermap':
        return `https://openweathermap.org/weathermap?basemap=map&crs=latlon&lat=${lat}&lon=${lon}&zoom=10&layer=precipitation_new&opacity=0.85`;
      case 'open-meteo':
        return `https://open-meteo.com/en/docs?latitude=${lat}&longitude=${lon}`;
      case 'meteoswiss':
        return `https://www.meteoswiss.admin.ch/?latitude=${lat}&longitude=${lon}`;
      default:
        return `https://meteofrance.com/?latitude=${lat}&longitude=${lon}`;
    }
  }

  private formatCoordForProviderUrl(value: number): string {
    return Number(value).toFixed(4);
  }

  getBrandInitials(brand: WeatherDataSourceBrand): string {
    switch (brand) {
      case 'meteofrance':
        return 'MF';
      case 'openweathermap':
        return 'OWM';
      case 'meteoswiss':
        return 'MS';
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
    if (this.temperatureLabelSource === 'meteoswiss-smn') {
      return 'meteoswiss';
    }
    if (this.temperatureLabelSource === 'meteofrance-dpobs') {
      return 'meteofrance';
    }
    if (this.activeStationTemperatureProvider() === 'ms') {
      return 'meteoswiss';
    }
    return 'open-meteo';
  }

  private resolvePointDataBrand(point: TemperatureGridPoint): WeatherDataSourceBrand {
    const source = String(point.source || '').toLowerCase();
    if (source.includes('meteoswiss')) {
      return 'meteoswiss';
    }
    if (point.stationId || source.includes('meteofrance')) {
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

  get showClimTabSpinner(): boolean {
    if (this.climStatusMessageKey) {
      return false;
    }
    if (!this.mfStatus) {
      return true;
    }
    return this.isLoadingClim;
  }

  get showMsForecastTabSpinner(): boolean {
    return this.isLoadingMsForecast || this.msForecastCacheLoading;
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

  get isAromepiMapReady(): boolean {
    return this.aromepiMapInitialized && this.aromepiMap != null;
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
    return this.aromepiEffectiveTimeSteps[this.aromepiFrameIndex] || '';
  }

  get aromepiEffectiveTimeSteps(): string[] {
    return this.buildAromepiEffectiveTimeSteps();
  }

  get aromepiEffectiveHorizonMinutes(): number {
    const fromCaps = Number(this.aromepiCapabilities?.forecastHorizonMinutes);
    if (Number.isFinite(fromCaps) && fromCaps > 0) {
      return fromCaps;
    }
    return MeteoFranceComponent.AROMEPI_FORECAST_HORIZON_MINUTES;
  }

  get aromepiEffectiveStepMinutes(): number {
    const fromCaps = Number(this.aromepiCapabilities?.forecastStepMinutes);
    if (Number.isFinite(fromCaps) && fromCaps > 0) {
      return fromCaps;
    }
    return MeteoFranceComponent.AROMEPI_FORECAST_STEP_MINUTES;
  }

  get aromepiCurrentOffsetMinutes(): number {
    return this.aromepiOffsetMinutesForTime(this.aromepiCurrentTime);
  }

  get aromepiForecastStepMinutes(): number {
    return this.aromepiEffectiveStepMinutes;
  }

  get aromepiMaxOffsetMinutes(): number {
    const steps = this.aromepiEffectiveTimeSteps;
    if (steps.length) {
      return this.aromepiOffsetMinutesForTime(steps[steps.length - 1]);
    }
    return this.aromepiEffectiveHorizonMinutes;
  }

  get aromepiMinOffsetMinutes(): number {
    const steps = this.aromepiEffectiveTimeSteps;
    if (!steps.length) {
      return 0;
    }
    return this.aromepiOffsetMinutesForTime(steps[0]);
  }

  private buildAromepiEffectiveTimeSteps(): string[] {
    const all = this.aromepiTimeSteps;
    if (!all.length || !this.aromepiReferenceTime) {
      return all;
    }
    const horizonMin = this.aromepiEffectiveHorizonMinutes;
    const stepMin = this.aromepiEffectiveStepMinutes;
    const sorted = [...all].sort((a, b) => Date.parse(a) - Date.parse(b));
    const withinHorizon = sorted.filter((timeIso) => {
      const offset = this.aromepiOffsetMinutesForTime(timeIso);
      return offset >= 0 && offset <= horizonMin;
    });
    if (!withinHorizon.length) {
      return sorted;
    }
    if (stepMin <= 15) {
      return withinHorizon;
    }
    const minOff = this.aromepiOffsetMinutesForTime(withinHorizon[0]);
    const tolerance = stepMin / 2;
    const picked: string[] = [];
    for (let target = minOff; target <= horizonMin; target += stepMin) {
      let best: string | null = null;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (const timeIso of withinHorizon) {
        const offset = this.aromepiOffsetMinutesForTime(timeIso);
        const delta = Math.abs(offset - target);
        if (delta <= tolerance && delta < bestDelta) {
          bestDelta = delta;
          best = timeIso;
        }
      }
      if (best && !picked.includes(best)) {
        picked.push(best);
      }
    }
    return picked.length ? picked : withinHorizon;
  }

  private clampAromepiFrameIndex(): void {
    const max = Math.max(0, this.aromepiEffectiveTimeSteps.length - 1);
    if (this.aromepiFrameIndex > max) {
      this.aromepiFrameIndex = 0;
    }
  }

  private aromepiOffsetMinutesForTime(timeIso: string): number {
    if (!this.aromepiReferenceTime || !timeIso) {
      return 0;
    }
    const ref = Date.parse(this.aromepiReferenceTime);
    const cur = Date.parse(timeIso);
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

  get aggregatedForecastSteps(): any[] {
    const steps = this.aggregatedForecast?.steps;
    return Array.isArray(steps) ? steps : [];
  }

  get aggregatedForecastHorizonHours(): number {
    return this.aggregatedForecast?.forecastHorizonHours ?? this.forecastHorizonHours;
  }

  get aggregatedForecastStepMinutes(): number {
    return this.aggregatedForecast?.forecastStepMinutes ?? this.forecastStepMinutes;
  }

  get aggregatedForecastSourceErrors(): Array<{ source: string; message: string }> {
    const raw = this.aggregatedForecast?.sourceErrors ?? this.aggregatedForecastSourceErrorsInternal;
    if (!raw || typeof raw !== 'object') {
      return [];
    }
    return Object.entries(raw).map(([source, message]) => ({
      source,
      message: String(message)
    }));
  }


  aggregatedSourceLabel(source: string): string {
    switch (source) {
      case 'openweathermap':
        return 'OWM';
      case 'open-meteo':
        return 'Open-Meteo';
      case 'meteofrance':
        return 'MF';
      case 'meteoswiss':
        return 'MS';
      default:
        return source;
    }
  }

  get aggregateRegionalSourceKey(): 'meteofrance' | 'meteoswiss' {
    return this.isLocationInSwitzerland() ? 'meteoswiss' : 'meteofrance';
  }

  get aggregateRegionalSourceShortLabel(): string {
    return this.aggregateRegionalSourceKey === 'meteoswiss' ? 'MS' : 'MF';
  }

  get aggregateForecastAggTitleKey(): string {
    return this.isLocationInSwitzerland()
      ? 'METEO_FRANCE.FORECAST_AGG_TITLE_CH'
      : 'METEO_FRANCE.FORECAST_AGG_TITLE';
  }

  get aggregateForecastAggHintKey(): string {
    return this.isLocationInSwitzerland()
      ? 'METEO_FRANCE.FORECAST_AGG_HINT_CH'
      : 'METEO_FRANCE.FORECAST_AGG_HINT';
  }

  get showMfAromepiTab(): boolean {
    return this.isLocationInFrance();
  }

  get showMeteoSwissForecastTabs(): boolean {
    return this.isLocationInSwitzerland();
  }

  get showClimTab(): boolean {
    return this.isLocationInFrance();
  }

  get showMsHistTab(): boolean {
    return this.isLocationInSwitzerland();
  }

  get showMsHistTabSpinner(): boolean {
    return this.isLoadingMsHist && !this.msHistDisplayRows.length;
  }

  get msHistDisplayRows(): any[] {
    return this.getSortedMsHistRows();
  }

  get msHistDisplayColumns(): string[] {
    const preferred = ['reference_timestamp', 'T', 'U', 'FF', 'RR'];
    const rows = this.msHistData?.rows;
    if (!Array.isArray(rows) || !rows.length) {
      return preferred;
    }
    return preferred.filter((key) => rows.some((row) => row[key] != null));
  }

  get msHistHasRainSeries(): boolean {
    return this.msHistRainChartData.datasets.some((ds) =>
      (ds.data as Array<number | null>).some((v) => v != null)
    );
  }

  get msHistHasHumiditySeries(): boolean {
    return this.msHistHumidityChartData.datasets.some((ds) =>
      (ds.data as Array<number | null>).some((v) => v != null)
    );
  }

  get msHistHasWindSeries(): boolean {
    return this.msHistWindChartData.datasets.some((ds) =>
      (ds.data as Array<number | null>).some((v) => v != null)
    );
  }

  get isMultiDayForecastTab(): boolean {
    return this.activeMainTab === 'forecast-owm'
      || this.activeMainTab === 'forecast-om'
      || this.activeMainTab === 'forecast-ms'
      || this.activeMainTab === 'forecast-aggregate';
  }

  get isForecastTab(): boolean {
    return this.isMultiDayForecastTab
      || this.activeMainTab === 'aromepi'
      || this.activeMainTab === 'forecast-options';
  }

  get isLoadingForecastLocation(): boolean {
    return Number.isFinite(this.lat)
      && Number.isFinite(this.lon)
      && this.locationGeocodeKey !== this.currentLocationKey();
  }

  get isForecastOptionsTab(): boolean {
    return this.activeMainTab === 'forecast-options';
  }

  get selectedMultiDayForecastNumericParams(): MultiDayForecastDisplayParam[] {
    return this.multiDayForecastDisplayParams.filter((p) => p !== 'weather');
  }

  get selectedMultiDayForecastParamOptions(): Array<{ id: MultiDayForecastDisplayParam; labelKey: string }> {
    return this.multiDayForecastParamOptions.filter((opt) =>
      this.multiDayForecastDisplayParams.includes(opt.id)
    );
  }

  get forecastHorizonSelectOptions(): number[] {
    return this.mergeForecastSelectOption(this.forecastHorizonOptions, this.forecastHorizonHours);
  }

  get forecastStepSelectOptions(): number[] {
    return this.mergeForecastSelectOption(this.forecastStepOptions, this.forecastStepMinutes);
  }

  get owmDisplayForecastList(): any[] {
    const list = this.owmForecast?.list;
    return Array.isArray(list) ? list : [];
  }

  get omDisplayForecastList(): any[] {
    const list = this.omForecast?.list;
    return Array.isArray(list) ? list : [];
  }

  get msDisplayForecastList(): any[] {
    const list = this.msForecast?.list;
    return Array.isArray(list) ? list : [];
  }

  get msForecastCacheLoadingLabel(): string {
    return this.translate.instant('METEO_FRANCE.FORECAST_MS_LOADING_CACHE', {
      current: this.msForecastCachePollCount,
      max: MeteoFranceComponent.MS_FORECAST_CACHE_POLL_MAX
    });
  }

  get msForecastPointLabel(): string {
    const point = this.msForecast?.meteoswissPoint;
    if (!point) {
      return '';
    }
    const name = point.name ?? point.postalCode ?? '';
    const distance = point.distanceKm != null ? ` (${point.distanceKm} km)` : '';
    return `${name}${distance}`.trim();
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

  get climHasHumiditySeries(): boolean {
    return this.climHumidityChartData.datasets.some((ds) =>
      (ds.data as (number | null)[]).some((v) => v != null)
    );
  }

  get climHasWindSeries(): boolean {
    return this.climWindChartData.datasets.some((ds) =>
      (ds.data as (number | null)[]).some((v) => v != null)
    );
  }

  get stationHistoryDisplayRows(): any[] {
    const rows = this.stationHistoryData?.rows;
    return Array.isArray(rows) ? rows : [];
  }

  get stationHistoryDisplayColumns(): string[] {
    const columns: string[] = this.stationHistoryData?.columns || [];
    if (columns.length) {
      return columns;
    }
    if (this.stationHistoryDisplayRows.length) {
      return Object.keys(this.stationHistoryDisplayRows[0]);
    }
    return [];
  }

  get stationHistoryPeriodOptions(): ClimPeriodOption[] {
    return this.stationHistoryFrequency === 'horaire'
      ? this.climHourlyPeriodOptions
      : this.climDailyPeriodOptions;
  }

  get stationHistoryModalTitle(): string {
    const name = this.stationHistoryPoint?.stationName?.trim()
      || this.stationHistoryData?.station?.name
      || this.stationHistoryPoint?.stationId
      || '';
    return this.translate.instant('METEO_FRANCE.STATION_HISTORY_MODAL_TITLE', { station: name });
  }

  get stationHistoryHasHumidityChart(): boolean {
    return this.stationHistoryHumidityChartData.datasets.some((ds) =>
      (ds.data as (number | null)[]).some((v) => v != null)
    );
  }

  get stationHistoryHasWindChart(): boolean {
    return this.stationHistoryWindChartData.datasets.some((ds) =>
      (ds.data as (number | null)[]).some((v) => v != null)
    );
  }

  get stationHistoryHasRainChart(): boolean {
    return this.stationHistoryRainChartData.datasets.some((ds) =>
      (ds.data as (number | null)[]).some((v) => v != null)
    );
  }

  get stationHistoryHasPressureChart(): boolean {
    return this.stationHistoryPressureChartData.datasets.some((ds) =>
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
    this.applyForecastMapBaseLayer();
    this.applyAromepiMapBaseLayer();
    this.refreshForecastMapLayout();
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

  private ensureSharedMapViewDefaults(): void {
    if (this.sharedMapCenterLat == null || this.sharedMapCenterLon == null) {
      this.sharedMapCenterLat = this.lat;
      this.sharedMapCenterLon = this.lon;
    }
    if (this.sharedMapZoom == null) {
      this.sharedMapZoom = this.pendingRadarMapZoom ?? MeteoFranceComponent.RADAR_MAP_ZOOM;
    }
  }

  private captureSharedMapViewFrom(source: L.Map): void {
    const center = source.getCenter();
    this.sharedMapCenterLat = center.lat;
    this.sharedMapCenterLon = center.lng;
    this.sharedMapZoom = source.getZoom();
  }

  private clampZoomForMap(map: L.Map, zoom: number): number {
    return Math.min(Math.max(zoom, map.getMinZoom()), map.getMaxZoom());
  }

  private applySharedMapViewTo(map: L.Map | null): void {
    if (!map) {
      return;
    }
    this.ensureSharedMapViewDefaults();
    const zoom = this.clampZoomForMap(map, this.sharedMapZoom!);
    map.setView([this.sharedMapCenterLat!, this.sharedMapCenterLon!], zoom, { animate: false });
  }

  private applySharedMapViewToAllMaps(): void {
    this.ensureSharedMapViewDefaults();
    this.syncingMapView = true;
    try {
      this.applySharedMapViewTo(this.map);
      this.applySharedMapViewTo(this.aromepiMap);
      this.applySharedMapViewTo(this.forecastMap);
    } finally {
      this.syncingMapView = false;
    }
  }

  private centerSharedMapOnLocation(options?: { minZoom?: number }): void {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return;
    }
    this.sharedMapCenterLat = this.lat;
    this.sharedMapCenterLon = this.lon;
    if (this.pendingRadarMapZoom != null) {
      this.sharedMapZoom = this.pendingRadarMapZoom;
      this.pendingRadarMapZoom = null;
    } else {
      let zoom = this.sharedMapZoom ?? MeteoFranceComponent.RADAR_MAP_ZOOM;
      if (options?.minZoom != null) {
        zoom = Math.max(zoom, options.minZoom);
      }
      this.sharedMapZoom = zoom;
    }
    this.applySharedMapViewToAllMaps();
  }

  private syncMapViewFromSource(source: 'radar' | 'aromepi' | 'forecast'): void {
    if (this.syncingMapView) {
      return;
    }
    const sourceMap = source === 'radar'
      ? this.map
      : source === 'aromepi'
        ? this.aromepiMap
        : this.forecastMap;
    if (!sourceMap) {
      return;
    }
    this.syncingMapView = true;
    try {
      this.captureSharedMapViewFrom(sourceMap);
      if (source !== 'radar') {
        this.applySharedMapViewTo(this.map);
      }
      if (source !== 'aromepi') {
        this.applySharedMapViewTo(this.aromepiMap);
      }
      if (source !== 'forecast') {
        this.applySharedMapViewTo(this.forecastMap);
      }
    } finally {
      this.syncingMapView = false;
    }
  }

  private readonly onRadarMapViewChange = (): void => {
    this.syncMapViewFromSource('radar');
  };

  private readonly onAromepiMapViewChange = (): void => {
    this.syncMapViewFromSource('aromepi');
  };

  private readonly onForecastMapViewChange = (): void => {
    this.syncMapViewFromSource('forecast');
  };

  private bindSharedMapViewSync(map: L.Map, source: 'radar' | 'aromepi' | 'forecast'): void {
    const handler = source === 'radar'
      ? this.onRadarMapViewChange
      : source === 'aromepi'
        ? this.onAromepiMapViewChange
        : this.onForecastMapViewChange;
    map.off('moveend', handler);
    map.off('zoomend', handler);
    map.on('moveend', handler);
    map.on('zoomend', handler);
  }

  private initMap(): void {
    if (this.map) {
      return;
    }
    this.ensureSharedMapViewDefaults();
    const initialRadarZoom = Math.min(Math.max(this.sharedMapZoom!, 2), 18);
    this.map = L.map('meteo-france-map', {
      center: [this.sharedMapCenterLat!, this.sharedMapCenterLon!],
      zoom: initialRadarZoom,
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
    this.bindSharedMapViewSync(this.map, 'radar');
    this.map.invalidateSize();
    this.centerSharedMapOnLocation({ minZoom: MeteoFranceComponent.RADAR_MAP_ZOOM });
  }

  /** Apply the shared map view on the radar map (pan/zoom sync, not forced recenter on marker). */
  private focusRadarMapOnPosition(): void {
    if (!this.map) {
      return;
    }
    this.applySharedMapViewTo(this.map);
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

  private loadMultiDayForecastDisplayParams(): void {
    try {
      const raw = localStorage.getItem(MeteoFranceComponent.MULTI_DAY_FORECAST_PARAMS_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      const allowed = new Set<MultiDayForecastDisplayParam>(
        this.multiDayForecastParamOptions.map((opt) => opt.id)
      );
      const selected = parsed.filter(
        (value): value is MultiDayForecastDisplayParam =>
          typeof value === 'string' && allowed.has(value as MultiDayForecastDisplayParam)
      );
      if (selected.length) {
        this.multiDayForecastDisplayParams = selected;
      }
    } catch {
      /* keep defaults */
    }
  }

  private persistMultiDayForecastDisplayParams(): void {
    try {
      localStorage.setItem(
        MeteoFranceComponent.MULTI_DAY_FORECAST_PARAMS_STORAGE_KEY,
        JSON.stringify(this.multiDayForecastDisplayParams)
      );
    } catch {
      /* ignore */
    }
  }

  private loadForecastChartStylePreference(): void {
    try {
      const stored = localStorage.getItem(MeteoFranceComponent.FORECAST_CHART_STYLE_STORAGE_KEY);
      if (stored === 'auto' || stored === 'line' || stored === 'bar') {
        this.forecastChartStyle = stored;
      }
    } catch {
      /* keep default */
    }
  }

  private persistForecastChartStylePreference(): void {
    try {
      localStorage.setItem(
        MeteoFranceComponent.FORECAST_CHART_STYLE_STORAGE_KEY,
        this.forecastChartStyle
      );
    } catch {
      /* ignore */
    }
  }

  forecastChartStyleLabelKey(style: ForecastChartStyle): string {
    switch (style) {
      case 'line':
        return 'METEO_FRANCE.FORECAST_CHART_STYLE_LINE';
      case 'bar':
        return 'METEO_FRANCE.FORECAST_CHART_STYLE_BAR';
      default:
        return 'METEO_FRANCE.FORECAST_CHART_STYLE_AUTO';
    }
  }

  get canEditMeteoOptions(): boolean {
    return this.keycloakService.hasAdminRole();
  }

  private guardMeteoOptionsEdit(): boolean {
    return this.keycloakService.hasAdminRole();
  }

  onForecastChartStyleChange(): void {
    this.persistForecastChartStylePreference();
    this.scheduleForecastChartsRefresh();
  }

  isMultiDayForecastParamSelected(param: MultiDayForecastDisplayParam): boolean {
    return this.multiDayForecastDisplayParams.includes(param);
  }

  forecastParamSwitchTooltipKey(param: MultiDayForecastDisplayParam): string {
    return `METEO_FRANCE.SWITCH_TOOLTIP_FORECAST_PARAM_${param.toUpperCase()}`;
  }

  paramTooltipKey(key: string): string {
    return `METEO_FRANCE.PARAM_TOOLTIP_${key}`;
  }

  onMultiDayForecastParamToggle(param: MultiDayForecastDisplayParam, checked: boolean): void {
    const current = [...this.multiDayForecastDisplayParams];
    if (checked) {
      if (!current.includes(param)) {
        current.push(param);
      }
    } else {
      const idx = current.indexOf(param);
      if (idx >= 0) {
        current.splice(idx, 1);
      }
    }
    if (!current.length) {
      current.push('temp');
    }
    this.multiDayForecastDisplayParams = current;
    this.persistMultiDayForecastDisplayParams();
    this.scheduleForecastChartsRefresh();
  }

  formatMultiDayForecastValue(item: any, param: MultiDayForecastDisplayParam): string {
    if (!item) {
      return '—';
    }
    switch (param) {
      case 'temp':
        return item.main?.temp != null ? this.formatTemperature(item.main.temp) : '—';
      case 'humidity':
        return item.main?.humidity != null ? `${Math.round(Number(item.main.humidity))}%` : '—';
      case 'wind':
        return this.formatWindSpeedMs(item.wind?.speed);
      case 'precip': {
        const mm = item.rain?.['1h'] ?? item.rain?.['3h'] ?? item.snow?.['1h'] ?? item.snow?.['3h'];
        return mm != null ? this.formatPrecipMm(mm) : '—';
      }
      case 'pop':
        return item.pop != null ? `${Math.round(Number(item.pop) * 100)}%` : '—';
      case 'weather':
        return item.weather?.[0]?.description ?? '—';
      default:
        return '—';
    }
  }

  private loadForecastPreferences(): void {
    this.subs.add(
      this.apiService.getMeteoFranceForecastPreferences().subscribe({
        next: (pref) => {
          if (pref?.forecastHorizonHours != null) {
            this.forecastHorizonHours = pref.forecastHorizonHours;
          }
          if (pref?.forecastStepMinutes != null) {
            this.forecastStepMinutes = pref.forecastStepMinutes;
          }
          this.normalizeForecastPreferences();
        },
        error: () => { /* default 24h / 60 min */ }
      })
    );
  }

  onForecastPreferencesCommitted(): void {
    if (!this.guardMeteoOptionsEdit()) {
      return;
    }
    this.normalizeForecastPreferences();
    this.clampAromepiFrameIndex();
    if (this.activeMainTab === 'aromepi') {
      this.setupAromepiWmsLayer(!!this.aromepiWmsLayer);
    }
    this.invalidateMultiDayForecasts();
    this.refreshActiveForecastTab();
    this.subs.add(
      this.apiService.saveMeteoFranceForecastPreferences(
        this.forecastHorizonHours,
        this.forecastStepMinutes
      ).subscribe({
        next: (pref) => {
          this.forecastHorizonHours = pref.forecastHorizonHours;
          this.forecastStepMinutes = pref.forecastStepMinutes;
          this.normalizeForecastPreferences();
          this.invalidateMultiDayForecasts();
          this.refreshActiveForecastTab();
        },
        error: () => { /* local values already applied */ }
      })
    );
  }

  formatForecastStepOption(minutes: number): string {
    if (minutes >= 1440) {
      return this.translate.instant('METEO_FRANCE.FORECAST_STEP_ONE_DAY');
    }
    if (minutes >= 60 && minutes % 60 === 0) {
      const hours = minutes / 60;
      return `${hours} ${this.translate.instant('METEO_FRANCE.FORECAST_HOURS_UNIT')}`;
    }
    return `${minutes} ${this.translate.instant('METEO_FRANCE.FORECAST_MINUTES_UNIT')}`;
  }

  formatForecastHorizonOption(hours: number): string {
    const h = Math.round(Number(hours));
    if (!Number.isFinite(h) || h <= 0) {
      return '—';
    }
    if (h >= 24 && h % 24 === 0) {
      const days = h / 24;
      if (days === 1) {
        return this.translate.instant('METEO_FRANCE.FORECAST_STEP_ONE_DAY');
      }
      return `${days} ${this.translate.instant('METEO_FRANCE.FORECAST_DAYS_UNIT')}`;
    }
    return `${h} ${this.translate.instant('METEO_FRANCE.FORECAST_HOURS_UNIT')}`;
  }

  private normalizeForecastPreferences(): void {
    const horizon = Math.round(Number(this.forecastHorizonHours));
    this.forecastHorizonHours = Number.isFinite(horizon)
      ? Math.max(this.forecastHorizonMinHours, Math.min(this.forecastHorizonMaxHours, horizon))
      : 24;
    this.forecastStepMinutes = this.clampForecastStepMinutes(Math.round(Number(this.forecastStepMinutes)));
  }

  private clampForecastStepMinutes(step: number): number {
    if (!Number.isFinite(step)) {
      return 60;
    }
    return Math.max(this.forecastStepMinMinutes, Math.min(this.forecastStepMaxMinutes, step));
  }

  private mergeForecastSelectOption(options: number[], current: number): number[] {
    const clamped = options === this.forecastHorizonOptions
      ? Math.max(this.forecastHorizonMinHours, Math.min(this.forecastHorizonMaxHours, Math.round(Number(current))))
      : this.clampForecastStepMinutes(Math.round(Number(current)));
    if (options.includes(clamped)) {
      return options;
    }
    return [...options, clamped].sort((a, b) => a - b);
  }

  private invalidateMultiDayForecasts(): void {
    this.owmForecastRequestId++;
    this.omForecastRequestId++;
    this.msForecastRequestId++;
    this.aggregatedForecastRequestId++;
    this.abortAggregatedForecastStream();
    this.owmForecast = null;
    this.omForecast = null;
    this.msForecast = null;
    this.aggregatedForecast = null;
    this.aggregatedForecastSourceLists = {};
    this.aggregatedForecastSourceErrorsInternal = {};
    this.owmForecastErrorKey = '';
    this.omForecastErrorKey = '';
    this.msForecastErrorKey = '';
    this.aggregatedForecastErrorKey = '';
    this.clearForecastCharts();
  }

  private loadRadarPreferences(): void {
    this.subs.add(
      this.apiService.getMeteoFranceRadarPreferences().subscribe({
        next: (pref) => {
          if (pref?.radarRefreshSeconds != null) {
            this.radarRefreshSeconds = pref.radarRefreshSeconds;
          }
          if (pref?.autoRefreshEnabled != null) {
            this.autoRefreshRadar = pref.autoRefreshEnabled;
          }
          this.startRadarRefreshTimer();
        },
        error: () => { /* keep defaults */ }
      })
    );
  }

  onRadarRefreshSecondsCommitted(): void {
    if (!this.guardMeteoOptionsEdit()) {
      return;
    }
    const n = Math.round(Number(this.radarRefreshSeconds));
    this.radarRefreshSeconds = Number.isFinite(n)
      ? Math.max(this.radarRefreshMinSeconds, Math.min(this.radarRefreshMaxSeconds, n))
      : 60;
    this.subs.add(
      this.apiService.saveMeteoFranceRadarPreferences({ radarRefreshSeconds: this.radarRefreshSeconds }).subscribe({
        next: (pref) => {
          if (pref?.radarRefreshSeconds != null) {
            this.radarRefreshSeconds = pref.radarRefreshSeconds;
          }
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

  private loadHistoryCachePreferences(): void {
    this.subs.add(
      this.apiService.getMeteoFranceHistoryCachePreferences().subscribe({
        next: (pref) => {
          if (pref?.historyCacheDays != null) {
            this.historyCacheDays = pref.historyCacheDays;
            this.historyCache.setRetentionDays(pref.historyCacheDays);
          }
        },
        error: () => {
          this.historyCacheDays = this.historyCache.getRetentionDays();
        }
      })
    );
  }

  onHistoryCacheDaysCommitted(): void {
    if (!this.guardMeteoOptionsEdit()) {
      this.historyCacheDays = this.historyCache.getRetentionDays();
      return;
    }
    const n = Math.round(Number(this.historyCacheDays));
    this.historyCacheDays = Number.isFinite(n)
      ? Math.max(this.historyCacheMinDays, Math.min(this.historyCacheMaxDays, n))
      : 14;
    this.historyCache.saveRetentionPreference(this.historyCacheDays);
  }

  private loadAromepiPlaybackPreferences(): void {
    this.subs.add(
      this.apiService.getMeteoFranceAromepiPlaybackPreferences().subscribe({
        next: (pref) => {
          if (pref?.prefetchAhead != null) {
            this.aromepiPrefetchAhead = this.clampAromepiPrefetchAhead(pref.prefetchAhead);
          }
        },
        error: () => {
          this.aromepiPrefetchAhead = this.clampAromepiPrefetchAhead(this.aromepiPrefetchAhead);
        }
      })
    );
  }

  onAromepiPrefetchAheadCommitted(): void {
    if (!this.guardMeteoOptionsEdit()) {
      return;
    }
    this.aromepiPrefetchAhead = this.clampAromepiPrefetchAhead(this.aromepiPrefetchAhead);
    this.subs.add(
      this.apiService.saveMeteoFranceAromepiPlaybackPreferences(this.aromepiPrefetchAhead).subscribe({
        next: (pref) => {
          if (pref?.prefetchAhead != null) {
            this.aromepiPrefetchAhead = this.clampAromepiPrefetchAhead(pref.prefetchAhead);
          }
          this.refreshAromepiPrefetchWindow();
        },
        error: () => {
          this.refreshAromepiPrefetchWindow();
        }
      })
    );
  }

  private clampAromepiPrefetchAhead(value: number): number {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) {
      return 5;
    }
    return Math.max(this.aromepiPrefetchAheadMin, Math.min(this.aromepiPrefetchAheadMax, n));
  }

  private refreshAromepiPrefetchWindow(): void {
    if (!this.aromepiMap || this.aromepiEffectiveTimeSteps.length < 2) {
      return;
    }
    this.clearAromepiPrefetchLayers();
    if (this.aromepiPlaying || this.aromepiWmsLayer) {
      this.prefetchAromepiPlaybackWindow();
    }
  }

  onTemperatureCacheMinutesCommitted(): void {
    if (!this.guardMeteoOptionsEdit()) {
      return;
    }
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
    if (!this.autoRefreshRadar || (!this.showRadar && !this.showCloudLayer)) {
      this.radarRefreshCountdown = 0;
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
    this.radarRefreshCountdown = this.effectiveRadarRefreshSeconds;
    this.mosaicRefreshTimer = setInterval(() => {
      this.radarRefreshCountdown = Math.max(0, this.radarRefreshCountdown - 1);
      if (this.radarRefreshCountdown === 0) {
        refreshLayers();
        this.radarRefreshCountdown = this.effectiveRadarRefreshSeconds;
      }
      this.cdr.markForCheck();
    }, 1000);
  }

  private get effectiveRadarRefreshSeconds(): number {
    const sec = Number(this.radarRefreshSeconds);
    return Number.isFinite(sec)
      ? Math.max(this.radarRefreshMinSeconds, Math.min(this.radarRefreshMaxSeconds, sec))
      : 60;
  }

  onAutoRefreshRadarChange(): void {
    if (!this.guardMeteoOptionsEdit()) {
      this.loadRadarPreferences();
      return;
    }
    this.startRadarRefreshTimer();
    this.subs.add(
      this.apiService.saveMeteoFranceRadarPreferences({ autoRefreshEnabled: this.autoRefreshRadar }).subscribe({
        error: () => { /* keep local value */ }
      })
    );
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
    this.radarRefreshCountdown = 0;
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
          this.prefetchAromepiCapabilitiesIfReady();
          if (this.activeMainTab === 'radar') {
            this.setupRadarLayer();
            this.setupCloudLayer();
          } else if (this.activeMainTab === 'clim' && this.climAvailable) {
            this.prepareClimTabLoad();
            this.loadClimDataForCurrentPosition();
          } else if (this.activeMainTab === 'ms-hist' && this.showMsHistTab) {
            this.prepareMsHistTabLoad();
            this.loadMsHistDataForCurrentPosition();
          } else if (this.activeMainTab === 'aromepi' && this.aromepiAvailable) {
            this.scheduleAromepiMapInit(() => this.ensureAromepiCapabilitiesLoaded());
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
    if (!this.shouldShowStationLabels()) {
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
    const provider = this.activeStationTemperatureProvider();
    if (!provider) {
      this.clearMapTemperatureGrid();
      this.updateSelectedTemperatureLabel();
      return;
    }
    const bounds = this.map.getBounds();
    const capacity = this.computeTemperatureStationCapacity();
    const loadingSourceKey = provider === 'ms'
      ? 'METEO_FRANCE.LOG_SOURCE_METEOSWISS_SMN'
      : 'METEO_FRANCE.LOG_SOURCE_MF_DPOBS';
    const expectedSourceToken = provider === 'ms' ? 'meteoswiss' : 'meteofrance';
    const labelSource: 'meteoswiss-smn' | 'meteofrance-dpobs' = provider === 'ms'
      ? 'meteoswiss-smn'
      : 'meteofrance-dpobs';

    this.temperatureLabelsLoadSub?.unsubscribe();
    const requestId = ++this.temperatureLabelsRequestId;
    const previousPoints = this.filterActiveStationLabelPoints([...this.temperatureGridPoints]);
    this.temperatureLabelsErrorKey = '';
    this.isLoadingTemperatureLabels = true;
    this.logBackend('METEO_FRANCE.LOG_CAT_TEMPERATURE', loadingSourceKey, 'loading');

    const fetch$ = provider === 'ms'
      ? this.apiService.getMeteoSwissObsTemperatureLabels(
          bounds.getSouth(),
          bounds.getNorth(),
          bounds.getWest(),
          bounds.getEast(),
          capacity.maxStations
        )
      : this.apiService.getMeteoFranceObsTemperatureLabels(
          bounds.getSouth(),
          bounds.getNorth(),
          bounds.getWest(),
          bounds.getEast(),
          capacity.maxStations
        );

    this.temperatureLabelsLoadSub = fetch$.subscribe({
      next: (data) => {
        if (requestId !== this.temperatureLabelsRequestId || !this.showTemperatureMap) {
          return;
        }
        if (this.activeStationTemperatureProvider() !== provider) {
          this.clearMapTemperatureGrid();
          this.renderTemperatureLabels();
          this.isLoadingTemperatureLabels = false;
          return;
        }
        if (data?.error) {
          this.applyTemperatureLabelsFailure(previousPoints);
          this.logBackend(
            'METEO_FRANCE.LOG_CAT_TEMPERATURE',
            loadingSourceKey,
            'error',
            String(data.error)
          );
        } else {
          const src = String(data?.source || '');
          if (!src.includes(expectedSourceToken)) {
            this.temperatureGridPoints = [];
            this.temperatureLabelSource = null;
            this.temperatureLabelsErrorKey = previousPoints.length
              ? ''
              : 'METEO_FRANCE.TEMPERATURE_LABELS_EMPTY';
            this.logBackend(
              'METEO_FRANCE.LOG_CAT_TEMPERATURE',
              loadingSourceKey,
              'error',
              provider === 'ms' ? 'non-MS response' : 'non-MF response'
            );
          } else {
            this.temperatureLabelSource = labelSource;
            this.temperatureLabelsFromCache = data?.cached === true;
            this.temperatureLabelsUpdatedAt = new Date();
            this.temperatureLabelsDetailLevel = data?.detailLevel ?? null;
            this.temperatureLabelsCount = data?.count ?? (Array.isArray(data?.points) ? data.points.length : 0);
            this.temperatureLabelsCacheTtlMinutes = data?.cacheTtlMinutes ?? null;
            this.temperatureGridPoints = Array.isArray(data?.points)
              ? data.points
                  .map((point) => this.normalizeTemperatureGridPoint(point, data?.cached === true))
                  .filter((point) => provider === 'ms'
                    ? this.isMsStationLabelPoint(point)
                    : this.isMfStationLabelPoint(point))
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
        this.logBackend('METEO_FRANCE.LOG_CAT_TEMPERATURE', loadingSourceKey, 'error');
        this.renderTemperatureLabels();
      }
    });
    this.subs.add(this.temperatureLabelsLoadSub);
  }

  private applyTemperatureLabelsFailure(previousPoints: TemperatureGridPoint[]): void {
    const keptPrevious = this.filterActiveStationLabelPoints(previousPoints);
    if (keptPrevious.length) {
      this.temperatureGridPoints = keptPrevious;
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
    this.applyCachedStationAltitude(point);
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
      this.ensureStationAltitude(point, marker);
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
    const provider = this.activeStationTemperatureProvider();
    if (!provider) {
      this.updateSelectedTemperatureLabel();
      return;
    }
    const brand: WeatherDataSourceBrand = provider === 'ms' ? 'meteoswiss' : 'meteofrance';
    const inBounds = this.filterPointsInMapBounds(this.filterActiveStationLabelPoints(this.temperatureGridPoints));
    const visible = this.filterNonOverlappingTemperatureLabels(inBounds);
    for (const point of visible) {
      if (point.tempC == null || !Number.isFinite(point.tempC)) {
        continue;
      }
      const [markerLat, markerLon] = this.stationMarkerLatLng(point);
      if (this.isNearSelectedPoint(markerLat, markerLon)) {
        continue;
      }
      const label = this.formatTemperatureLabel(point.tempC);
      const w = this.estimateTemperatureLabelWidth(label);
      const h = 20;
      const icon = L.divIcon({
        className: 'mf-temp-label',
        html: this.buildTemperatureLabelHtml(point.tempC, brand),
        iconSize: [w, h],
        iconAnchor: [w / 2, h / 2]
      });
      const marker = L.marker([markerLat, markerLon], {
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
    return points.filter((point) => {
      const [markerLat, markerLon] = this.stationMarkerLatLng(point);
      return bounds.contains([markerLat, markerLon]);
    });
  }

  private filterNonOverlappingTemperatureLabels(points: TemperatureGridPoint[]): TemperatureGridPoint[] {
    if (!this.map || !points.length) {
      return [];
    }
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    const result: typeof points = [];
    for (const point of points) {
      const [markerLat, markerLon] = this.stationMarkerLatLng(point);
      const pt = this.map.latLngToContainerPoint([markerLat, markerLon]);
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
    if (!this.showTemperatureMap) {
      this.removeSelectedTemperatureLabel();
      return;
    }
    if (this.selectedTempLabelDismissed && !options?.forceShow) {
      this.cdr.markForCheck();
      return;
    }
    if (!this.canShowSelectedTemperatureLabel()) {
      this.removeSelectedTemperatureLabel();
      return;
    }
    this.cdr.markForCheck();
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
    this.cdr.markForCheck();
  }

  formatTemperatureLabel(valueCelsius: number): string {
    const unit = this.temperatureUnit === 'fahrenheit' ? '°F' : '°C';
    const value = this.temperatureUnit === 'fahrenheit'
      ? Math.round(valueCelsius * 9 / 5 + 32)
      : Math.round(valueCelsius * 10) / 10;
    return `${value}${unit}`;
  }

  formatSelectedPointObservedTime(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const trimmed = value.trim();
    if (/^\d{10}$/.test(trimmed)) {
      const date = new Date(Number(trimmed) * 1000);
      return Number.isNaN(date.getTime()) ? null : this.formatTemperatureDateTime(date);
    }
    if (/^\d{13}$/.test(trimmed)) {
      const date = new Date(Number(trimmed));
      return Number.isNaN(date.getTime()) ? null : this.formatTemperatureDateTime(date);
    }
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return this.formatTemperatureDateTime(date);
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

  private formatSelectedMsStationLabel(): string {
    const name = this.selectedPointMsStation?.name?.trim();
    if (name) {
      return name;
    }
    return this.selectedPointMsStation?.id?.trim() || '';
  }

  private formatSelectedMsStationProximityLabel(): string {
    const name = this.formatSelectedMsStationLabel();
    const distKm = this.selectedPointMsStationDistKm;
    if (!name) {
      return '';
    }
    if (distKm != null && distKm >= 1.5) {
      return this.translate.instant('METEO_FRANCE.POINT_SOURCE_MS_NEAREST', {
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

  private updateSelectedPointMsStationDistance(
    clickLat: number,
    clickLon: number,
    msPoint?: any
  ): void {
    this.selectedPointMsStationDistKm = null;
    let stationLat: number | undefined;
    let stationLon: number | undefined;

    const rawStationLat = msPoint?.stationLat;
    const rawStationLon = msPoint?.stationLon;
    if (Number.isFinite(Number(rawStationLat)) && Number.isFinite(Number(rawStationLon))) {
      stationLat = Number(rawStationLat);
      stationLon = Number(rawStationLon);
    } else {
      const stationId = this.selectedPointMsStation?.id ?? msPoint?.stationId;
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
    this.selectedPointMsStationDistKm = this.haversineKm(clickLat, clickLon, stationLat, stationLon);
  }

  private clearSelectedPointComparison(): void {
    this.selectedPointUsesMf = false;
    this.selectedPointMfTempC = null;
    this.selectedPointMfStation = null;
    this.selectedPointMfStationDistKm = null;
    this.selectedPointMsTempC = null;
    this.selectedPointMsStation = null;
    this.selectedPointMsStationDistKm = null;
    this.selectedPointOpenMeteoTempC = null;
    this.selectedPointOpenWeatherTempC = null;
    this.selectedPointMfObservedAt = null;
    this.selectedPointMsObservedAt = null;
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
    return this.formatSelectedPointObservedTime(value);
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

  dismissSelectedPointWeatherOverlay(): void {
    this.dismissSelectedTemperatureLabel();
  }

  private dismissSelectedTemperatureLabel(): void {
    this.selectedTempLabelDismissed = true;
    this.closePointTempTimeline();
    this.removeSelectedTemperatureLabel();
  }

  /** Fill MF row from the station grid when the point API finished before grid data was ready. */
  private syncSelectedPointMfFromGrid(): void {
    if (!this.isLocationInFrance()) {
      return;
    }
    this.applySelectedPointMfFallbackFromGrid(this.lat, this.lon);
  }

  /** Fill MeteoSwiss row from the station grid when the point API finished before grid data was ready. */
  private syncSelectedPointMsFromGrid(): void {
    if (!this.isLocationInSwitzerland()) {
      return;
    }
    this.applySelectedPointMsFallbackFromGrid(this.lat, this.lon);
  }

  private applySelectedPointMfFallbackFromGrid(lat: number, lon: number): void {
    if (!this.isLocationInFrance()) {
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

  private applySelectedPointMsFallbackFromGrid(lat: number, lon: number): void {
    if (!this.isLocationInSwitzerland()) {
      return;
    }
    if (this.selectedPointMsTempC != null) {
      return;
    }
    const nearest = this.findNearestGridPoint(lat, lon);
    if (!nearest?.tempC || !Number.isFinite(nearest.tempC)) {
      return;
    }
    if (this.resolvePointDataBrand(nearest) !== 'meteoswiss') {
      return;
    }
    this.selectedPointMsTempC = nearest.tempC;
    if (nearest.stationId || nearest.stationName) {
      this.selectedPointMsStation = {
        id: nearest.stationId,
        name: nearest.stationName,
      };
    }
    if (nearest.observedAt) {
      this.selectedPointMsObservedAt = nearest.observedAt;
    }
    this.updateSelectedPointMsStationDistance(lat, lon, nearest);
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

  private isMsTemperaturePoint(point: any, msSource: string): boolean {
    if (!point || point.tempC == null) {
      return false;
    }
    if (point.stationId || point.stationName) {
      return true;
    }
    const normalized = msSource.toLowerCase();
    return normalized.includes('meteoswiss');
  }

  get forecastDataLocationPlace(): string {
    return this.resolveForecastDataLocationPlace();
  }

  get forecastDataLocationCoords(): string {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return '';
    }
    return this.formatGpsCoordinates(this.lat, this.lon);
  }

  get forecastDataLocationShowCoords(): boolean {
    const coords = this.forecastDataLocationCoords;
    const place = this.forecastDataLocationPlace;
    return !!coords && place !== coords;
  }

  private resolveForecastDataLocationPlace(): string {
    const address = this.fullAddress?.trim();
    if (address) {
      return address;
    }
    const cityLine = [this.city?.trim(), this.countryCode?.trim()].filter(Boolean).join(', ');
    if (cityLine) {
      return cityLine;
    }
    return this.resolveSelectedLocationName();
  }

  get showSelectedPointWeatherOverlay(): boolean {
    return this.showTemperatureMap
      && !this.selectedTempLabelDismissed
      && this.canShowSelectedTemperatureLabel();
  }

  get selectedPointWeatherLocationLabel(): string {
    return this.resolveSelectedLocationName();
  }

  get selectedPointMfStationLine(): string {
    return this.formatSelectedMfStationProximityLabel();
  }

  get selectedPointMsStationLine(): string {
    return this.formatSelectedMsStationProximityLabel();
  }

  get pointTempTimelineTitle(): string {
    return this.resolveSelectedLocationName();
  }

  get selectedPointFallbackSourceRow(): { brand: WeatherDataSourceBrand; tempC: number } | null {
    if (
      this.selectedPointMfTempC != null
      || this.selectedPointMsTempC != null
      || this.selectedPointOpenMeteoTempC != null
      || this.selectedPointOpenWeatherTempC != null
    ) {
      return null;
    }
    const tempC = this.resolveSelectedTemperatureCelsius();
    if (tempC == null) {
      return null;
    }
    return { brand: this.resolveMapTemperatureBrand(), tempC };
  }

  get hasSelectedPointWeatherData(): boolean {
    return (this.pointTimelineMfTempC != null && this.isSelectedPointInFrance)
      || (this.pointTimelineMsTempC != null && this.isSelectedPointInSwitzerland)
      || this.pointTimelineOpenMeteoTempC != null
      || this.pointTimelineOpenWeatherTempC != null
      || this.selectedPointFallbackSourceRow != null;
  }

  get canShowSelectedPointTimelineButton(): boolean {
    return this.isSelectedPointInFrance || this.isSelectedPointInSwitzerland;
  }

  get pointTimelineMfTempC(): number | null {
    return this.selectedPointMfTempC;
  }

  get pointTimelineMsTempC(): number | null {
    return this.selectedPointMsTempC;
  }

  get pointTimelineOpenMeteoTempC(): number | null {
    return this.selectedPointOpenMeteoTempC;
  }

  get pointTimelineOpenWeatherTempC(): number | null {
    return this.selectedPointOpenWeatherTempC;
  }

  get pointTimelineMfObservedAt(): string | null {
    return this.selectedPointMfObservedAt;
  }

  get pointTimelineMsObservedAt(): string | null {
    return this.selectedPointMsObservedAt;
  }

  get pointTimelineOpenMeteoObservedAt(): string | null {
    return this.selectedPointOpenMeteoObservedAt;
  }

  get pointTimelineOpenWeatherObservedAt(): string | null {
    return this.selectedPointOpenWeatherObservedAt;
  }

  get pointTempTimelineStationId(): string | undefined {
    if (this.isSelectedPointInSwitzerland) {
      return this.selectedPointMsStation?.id
        ?? this.findNearestGridPoint(this.lat, this.lon)?.stationId;
    }
    return this.selectedPointMfStation?.id
      ?? this.findNearestGridPoint(this.lat, this.lon)?.stationId;
  }

  get pointTempTimelineStationName(): string | undefined {
    if (this.isSelectedPointInSwitzerland) {
      return this.selectedPointMsStation?.name;
    }
    return this.selectedPointMfStation?.name;
  }

  get pointTempTimelineRegion(): 'france' | 'switzerland' {
    return this.isSelectedPointInSwitzerland ? 'switzerland' : 'france';
  }

  /** Native map fullscreen hides fixed overlays — timeline must be embedded in the map shell. */
  get pointTempTimelineOverlayMode(): 'fixed' | 'embedded' {
    return this.isRadarMapNativeFullscreen() ? 'embedded' : 'fixed';
  }

  openPointTempTimeline(): void {
    if (!this.canShowSelectedPointTimelineButton || !Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return;
    }
    this.pointTempTimelineVisible = true;
  }

  closePointTempTimeline(): void {
    this.pointTempTimelineVisible = false;
  }

  private resolveSelectedLocationName(): string {
    const name = this.selectedLocationName?.trim();
    if (name && !this.looksLikeCoordinates(name)) {
      return name;
    }
    const weatherPlace = this.selectedPointOpenWeatherPlace?.trim();
    if (weatherPlace) {
      return weatherPlace;
    }
    const city = this.city?.trim();
    if (city) {
      return city;
    }
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
    const stationLat = this.toOptionalNumber(point?.stationLat);
    const stationLon = this.toOptionalNumber(point?.stationLon);
    const normalized: TemperatureGridPoint = {
      lat: Number(point?.lat),
      lon: Number(point?.lon),
      tempC: Number(point?.tempC),
      stationId: point?.stationId,
      stationName: point?.stationName,
      stationLat,
      stationLon,
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
    return this.applyStationMarkerCoordinates(normalized);
  }

  /** Station observations are drawn at the station coordinates, not at query/interpolation points. */
  private applyStationMarkerCoordinates(point: TemperatureGridPoint): TemperatureGridPoint {
    if (!point.stationId || point.interpolated) {
      return point;
    }
    const markerLat = Number.isFinite(point.stationLat) ? point.stationLat! : point.lat;
    const markerLon = Number.isFinite(point.stationLon) ? point.stationLon! : point.lon;
    if (!Number.isFinite(markerLat) || !Number.isFinite(markerLon)) {
      return point;
    }
    return {
      ...point,
      lat: markerLat,
      lon: markerLon,
      stationLat: markerLat,
      stationLon: markerLon
    };
  }

  private stationMarkerLatLng(point: TemperatureGridPoint): [number, number] {
    return [point.lat, point.lon];
  }

  private temperaturePointKey(point: TemperatureGridPoint): string {
    return point.stationId ?? `${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
  }

  private isTemperatureMapUiClick(event: Event | undefined): boolean {
    const target = event?.target as HTMLElement | null;
    return !!target?.closest('.mf-temp-tooltip, .mf-temp-label, .mf-temp-refresh-btn, .mf-temp-history-btn, .mf-selected-point-weather-overlay, .mf-point-timeline-card');
  }

  private readonly onTemperatureTooltipClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const historyButton = target?.closest('.mf-temp-history-btn') as HTMLElement | null;
    if (historyButton) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const historyKey = historyButton.getAttribute('data-temp-key');
      if (historyKey) {
        this.openStationHistoryModal(historyKey);
      }
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
    const provider = this.activeStationTemperatureProvider();
    if (!provider) {
      return;
    }
    const point = this.temperatureGridPoints.find((p) => this.temperaturePointKey(p) === key);
    if (!point?.stationId || this.refreshingTemperatureKeys.has(key)) {
      return;
    }
    const [markerLat, markerLon] = this.stationMarkerLatLng(point);
    this.refreshingTemperatureKeys.add(key);
    this.subs.add(
      this.apiService.postWeatherTemperatureLabels(
        [{
          lat: markerLat,
          lon: markerLon,
          stationId: point.stationId
        }],
        provider === 'ms' ? 'meteoswiss' : 'meteofrance',
        true
      ).subscribe({
        next: (data) => {
          this.refreshingTemperatureKeys.delete(key);
          const updated = data?.points?.[0];
          if (!updated || data?.error) {
            return;
          }
          const normalized = provider === 'ms'
            ? this.upsertMsTemperatureGridPoint(updated)
            : this.upsertMfTemperatureGridPoint(updated);
          if (normalized) {
            if (provider === 'ms') {
              this.applyRefreshedMsStationToSelectedPoint(normalized);
            } else {
              this.applyRefreshedMfStationToSelectedPoint(normalized);
            }
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

  /** Insert or replace one MeteoSwiss station in the local grid after a forced refresh. */
  private upsertMsTemperatureGridPoint(rawPoint: any): TemperatureGridPoint | null {
    if (!this.shouldShowMsStationLabels()) {
      return null;
    }
    const normalized = this.normalizeTemperatureGridPoint(rawPoint, false);
    normalized.cached = false;
    if (!this.isMsStationLabelPoint(normalized)) {
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
    this.temperatureLabelSource = 'meteoswiss-smn';
    this.temperatureLabelsCount = this.temperatureGridPoints.length;
    this.renderTemperatureLabels();
    return normalized;
  }

  private applyRefreshedMfStationToSelectedPoint(point: TemperatureGridPoint): void {
    if (!point.stationId) {
      return;
    }
    const selectedId = this.selectedPointMfStation?.id?.trim();
    const [markerLat, markerLon] = this.stationMarkerLatLng(point);
    const matchesSelected = selectedId
      ? selectedId === point.stationId
      : this.isNearSelectedPoint(markerLat, markerLon);
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

  private applyRefreshedMsStationToSelectedPoint(point: TemperatureGridPoint): void {
    if (!point.stationId) {
      return;
    }
    const selectedId = this.selectedPointMsStation?.id?.trim();
    const [markerLat, markerLon] = this.stationMarkerLatLng(point);
    const matchesSelected = selectedId
      ? selectedId === point.stationId
      : this.isNearSelectedPoint(markerLat, markerLon);
    if (!matchesSelected) {
      return;
    }
    this.selectedPointMsTempC = point.tempC;
    this.selectedPointMsObservedAt = point.observedAt ?? null;
    if (point.stationId || point.stationName) {
      this.selectedPointMsStation = {
        id: point.stationId,
        name: point.stationName,
      };
    }
    if (this.selectedPointTempC == null) {
      this.selectedPointTempC = point.tempC;
    }
    this.updateSelectedPointMsStationDistance(this.lat, this.lon, point);
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

    if (this.isObsStationPoint(point)) {
      const altitudeLabel = this.formatStationAltitudeLabel(point.altitudeM);
      if (altitudeLabel) {
        lines.push(this.tooltipRow(
          this.translate.instant('METEO_FRANCE.TOOLTIP_STATION_ALTITUDE'),
          this.escapeHtml(altitudeLabel)
        ));
      }
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
      const refreshLabel = refreshing
        ? this.escapeHtml(this.translate.instant('METEO_FRANCE.TEMPERATURE_TOOLTIP_REFRESHING'))
        : this.escapeHtml(this.translate.instant('METEO_FRANCE.TEMPERATURE_TOOLTIP_REFRESH'));
      let actions =
        `<div class="mf-temp-tooltip-actions">` +
        `<button type="button" class="mf-temp-refresh-btn btn btn-sm btn-outline-primary" ` +
        `data-temp-key="${key}"${refreshing ? ' disabled' : ''}>${refreshLabel}</button>`;
      if (this.climAvailable) {
        const historyLabel = this.escapeHtml(this.translate.instant('METEO_FRANCE.TEMPERATURE_TOOLTIP_HISTORY'));
        actions +=
          `<button type="button" class="mf-temp-history-btn btn btn-sm btn-outline-light" ` +
          `data-temp-key="${key}">${historyLabel}</button>`;
      }
      actions += `</div>`;
      lines.push(actions);
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

  private isObsStationPoint(point: TemperatureGridPoint): boolean {
    if (point.interpolated || !point.stationId) {
      return false;
    }
    return this.isMfStationLabelPoint(point) || this.isMsStationLabelPoint(point);
  }

  private stationAltitudeCacheKey(lat: number, lon: number): string {
    return `${lat.toFixed(5)},${lon.toFixed(5)}`;
  }

  private applyCachedStationAltitude(point: TemperatureGridPoint): void {
    if (!this.isObsStationPoint(point) || point.altitudeM != null) {
      return;
    }
    const key = this.stationAltitudeCacheKey(point.lat, point.lon);
    if (this.stationAltitudeCache.has(key)) {
      const cached = this.stationAltitudeCache.get(key);
      if (cached != null) {
        point.altitudeM = cached;
      }
    }
  }

  private formatStationAltitudeLabel(altitudeM: number | undefined): string | null {
    if (altitudeM == null || !Number.isFinite(altitudeM)) {
      return null;
    }
    return `${Math.round(altitudeM)} m`;
  }

  private ensureStationAltitude(point: TemperatureGridPoint, marker?: L.Marker): void {
    if (!this.isObsStationPoint(point)) {
      return;
    }
    this.applyCachedStationAltitude(point);
    if (point.altitudeM != null) {
      return;
    }
    const key = this.stationAltitudeCacheKey(point.lat, point.lon);
    if (this.stationAltitudeCache.has(key) || this.stationAltitudeInflight.has(key)) {
      return;
    }
    const sub = this.apiService.getStationElevation(point.lat, point.lon).pipe(take(1)).subscribe({
      next: (response) => {
        this.stationAltitudeInflight.delete(key);
        const raw = response?.altitudeM;
        const altitudeM = raw != null && Number.isFinite(Number(raw)) ? Math.round(Number(raw)) : null;
        this.stationAltitudeCache.set(key, altitudeM);
        if (altitudeM == null) {
          return;
        }
        point.altitudeM = altitudeM;
        this.updatePointAltitudeInGrid(point);
        if (marker?.getTooltip()) {
          marker.setTooltipContent(this.buildTemperatureLabelTooltip(point));
        }
      },
      error: () => {
        this.stationAltitudeInflight.delete(key);
        this.stationAltitudeCache.set(key, null);
      }
    });
    this.stationAltitudeInflight.set(key, sub);
  }

  private updatePointAltitudeInGrid(point: TemperatureGridPoint): void {
    const key = this.temperaturePointKey(point);
    const index = this.temperatureGridPoints.findIndex((p) => this.temperaturePointKey(p) === key);
    if (index >= 0) {
      this.temperatureGridPoints[index] = { ...this.temperatureGridPoints[index], altitudeM: point.altitudeM };
    }
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
      return this.formatClimDate(value);
    }
    return this.formatTemperatureDateTime(date);
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
    this.applySelectedPointMsFallbackFromGrid(lat, lon);
    this.updateSelectedTemperatureLabel({ forceShow: true });

    this.logBackend('METEO_FRANCE.LOG_CAT_TEMPERATURE_POINT', 'METEO_FRANCE.LOG_SOURCE_MF_DPOBS_OPEN_METEO', 'loading');

    let mfDone = false;
    let msDone = false;
    let openMeteoDone = false;
    let owmDone = false;

    const finishSelectedPointFetch = (): void => {
      if (requestId !== this.selectedTempRequestId || !this.showTemperatureMap) {
        return;
      }
      if (!mfDone || !msDone || !openMeteoDone || !owmDone) {
        return;
      }
      this.selectedPointComparisonLoading = false;
      this.selectedPointComparisonReady = true;
      this.syncSelectedPointMfFromGrid();
      this.syncSelectedPointMsFromGrid();
      const detail = this.selectedPointMfTempC != null
        ? this.formatSelectedMfStationLabel() || this.formatTemperatureLabel(this.selectedPointMfTempC)
        : this.selectedPointMsTempC != null
          ? this.formatSelectedMsStationLabel() || this.formatTemperatureLabel(this.selectedPointMsTempC)
          : this.selectedPointTempC != null
            ? this.formatTemperatureLabel(this.selectedPointTempC)
            : undefined;
      this.logBackend(
        'METEO_FRANCE.LOG_CAT_TEMPERATURE_POINT',
        this.selectedPointMfTempC != null
          ? 'METEO_FRANCE.LOG_SOURCE_MF_DPOBS'
          : this.selectedPointMsTempC != null
            ? 'METEO_FRANCE.LOG_SOURCE_METEOSWISS_SMN'
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
      if (this.isMfTemperaturePoint(mfPoint, mfSource) && mfTemp != null && this.isLocationInFrance()) {
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

    const applyMsResponse = (ms: any): void => {
      if (requestId !== this.selectedTempRequestId || !this.showTemperatureMap) {
        return;
      }
      const msPoint = ms?.points?.[0];
      const msTemp = this.extractPointTempC(ms);
      const msSource = String(ms?.source || '');
      if (this.isMsTemperaturePoint(msPoint, msSource) && msTemp != null && this.isLocationInSwitzerland()) {
        this.selectedPointMsTempC = msTemp;
        this.selectedPointMsObservedAt = this.extractPointObservedAt(msPoint);
        if (msPoint?.stationId || msPoint?.stationName) {
          this.selectedPointMsStation = {
            id: msPoint.stationId != null ? String(msPoint.stationId) : undefined,
            name: msPoint.stationName != null ? String(msPoint.stationName) : undefined,
          };
        } else {
          const nearest = this.findNearestGridPoint(lat, lon);
          if (nearest?.stationId || nearest?.stationName) {
            this.selectedPointMsStation = {
              id: nearest.stationId,
              name: nearest.stationName,
            };
          }
        }
        if (this.selectedPointTempC == null) {
          this.selectedPointTempC = msTemp;
        }
        this.updateSelectedPointMsStationDistance(lat, lon, msPoint);
        this.upsertMsTemperatureGridPoint(msPoint);
      }
      this.applySelectedPointMsFallbackFromGrid(lat, lon);
      msDone = true;
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
      if (nearestGrid?.stationId && this.resolvePointDataBrand(nearestGrid) === 'meteofrance') {
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

    if (this.shouldFetchMsTemperatureAt(lat, lon)) {
      const nearestGrid = this.findNearestGridPoint(lat, lon);
      const msTarget: { lat: number; lon: number; stationId?: string } = { lat, lon };
      if (nearestGrid?.stationId && this.resolvePointDataBrand(nearestGrid) === 'meteoswiss') {
        msTarget.stationId = nearestGrid.stationId;
      }
      this.subs.add(
        this.apiService.postWeatherTemperatureLabels([msTarget], 'meteoswiss', true).subscribe({
          next: applyMsResponse,
          error: () => {
            if (requestId !== this.selectedTempRequestId || !this.showTemperatureMap) {
              return;
            }
            this.applySelectedPointMsFallbackFromGrid(lat, lon);
            msDone = true;
            this.updateSelectedTemperatureLabel({ forceShow: true });
            finishSelectedPointFetch();
          }
        })
      );
    } else {
      msDone = true;
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
      const [markerLat, markerLon] = this.stationMarkerLatLng(point);
      const dist = (markerLat - lat) ** 2 + (markerLon - lon) ** 2;
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

  private isRadarMapNativeFullscreen(): boolean {
    const shell = this.mapShell?.nativeElement;
    if (!shell) {
      return false;
    }
    const doc = document as Document & { webkitFullscreenElement?: Element };
    return document.fullscreenElement === shell || doc.webkitFullscreenElement === shell;
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
    if (this.chartFullscreen.closeIfActive()) {
      return;
    }
    if (this.stationHistoryModalVisible) {
      this.closeStationHistoryModal();
      return;
    }
    if (this.pointTempTimeline?.isFullscreen()) {
      this.pointTempTimeline.exitFullscreen();
      return;
    }
    if (this.pointTempTimelineVisible) {
      this.closePointTempTimeline();
      return;
    }
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
    this.scheduleComponentTimeout(() => {
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

  onMainTabChange(tab: MeteoFranceMainTab): void {
    tab = this.resolveRegionalMainTab(tab);
    const wasOnForecastOptions = this.isForecastOptionsTab;
    this.activeMainTab = tab;
    if (wasOnForecastOptions && !this.isForecastOptionsTab) {
      this.destroyForecastMap();
    }
    if (tab === 'radar') {
      this.stopAromepiAnimation();
      this.scheduleComponentTimeout(() => {
        this.map?.invalidateSize();
        this.focusRadarMapOnPosition();
        this.setupRadarLayer();
        this.setupTemperatureLabels();
      }, 0);
    } else if (tab === 'clim') {
      this.stopAromepiAnimation();
      this.prepareClimTabLoad();
      this.scheduleComponentTimeout(() => {
        this.loadClimDataForCurrentPosition();
      }, 0);
    } else if (tab === 'ms-hist') {
      this.stopAromepiAnimation();
      this.prepareMsHistTabLoad();
      this.scheduleComponentTimeout(() => {
        this.loadMsHistDataForCurrentPosition();
      }, 0);
    } else if (tab === 'aromepi') {
      this.stopAromepiAnimation();
      this.ensureForecastLocationResolved();
      this.prefetchAromepiCapabilitiesIfReady();
      this.scheduleAromepiMapInit(() => {
        if (this.aromepiAvailable || this.showMfAromepiTab) {
          this.ensureAromepiCapabilitiesLoaded();
        }
        this.loadAromepiNearestStation();
      });
    } else if (tab === 'forecast-options') {
      this.historyCacheDays = this.historyCache.getRetentionDays();
      this.stopAromepiAnimation();
      this.ensureForecastLocationResolved();
      this.scheduleForecastMapInit();
    } else if (tab === 'forecast-owm') {
      this.stopAromepiAnimation();
      this.activateOwmForecastTabIfNeeded();
    } else if (tab === 'forecast-om') {
      this.stopAromepiAnimation();
      this.activateOmForecastTabIfNeeded();
    } else if (tab === 'forecast-ms') {
      this.stopAromepiAnimation();
      this.activateMsForecastTabIfNeeded();
    } else if (tab === 'ms-precip') {
      this.stopAromepiAnimation();
      this.scheduleComponentTimeout(() => this.msPrecipTab?.activate(), 0);
    } else if (tab === 'forecast-aggregate') {
      this.stopAromepiAnimation();
      this.activateAggregatedForecastTabIfNeeded();
    }
  }

  private resolveRegionalMainTab(tab: MeteoFranceMainTab): MeteoFranceMainTab {
    if (tab === 'clim' && !this.showClimTab) {
      return this.showMeteoSwissForecastTabs ? 'forecast-ms' : 'radar';
    }
    if (tab === 'ms-hist' && !this.showMsHistTab) {
      return this.showClimTab ? 'clim' : 'radar';
    }
    if (tab === 'aromepi' && !this.showMfAromepiTab) {
      return this.showMeteoSwissForecastTabs ? 'forecast-ms' : 'radar';
    }
    if ((tab === 'forecast-ms' || tab === 'ms-precip') && !this.showMeteoSwissForecastTabs) {
      return this.showMfAromepiTab ? 'aromepi' : 'radar';
    }
    return tab;
  }

  private syncActiveTabForRegionalProvider(): void {
    const resolved = this.resolveRegionalMainTab(this.activeMainTab);
    if (resolved !== this.activeMainTab) {
      this.onMainTabChange(resolved);
    }
  }

  private hasOwmForecastData(): boolean {
    return this.owmForecast != null;
  }

  private hasOmForecastData(): boolean {
    return this.omForecast != null;
  }

  private hasMsForecastData(): boolean {
    return this.msForecast != null;
  }

  private hasAggregatedForecastData(): boolean {
    return this.aggregatedForecast != null;
  }

  private hasAromepiPointForecastData(): boolean {
    const steps = this.aromepiPointForecast?.steps;
    return Array.isArray(steps) && steps.length > 0;
  }

  private activateOwmForecastTabIfNeeded(): void {
    this.ensureForecastLocationResolved();
    if (this.hasOwmForecastData()) {
      this.scheduleForecastChartsRefresh();
      return;
    }
    this.prepareOwmForecastTabLoad();
    this.loadOwmForecast();
  }

  private activateOmForecastTabIfNeeded(): void {
    this.ensureForecastLocationResolved();
    if (this.hasOmForecastData()) {
      this.scheduleForecastChartsRefresh();
      return;
    }
    this.prepareOmForecastTabLoad();
    this.loadOmForecast();
  }

  private activateMsForecastTabIfNeeded(): void {
    this.ensureForecastLocationResolved();
    if (this.hasMsForecastData()) {
      this.scheduleForecastChartsRefresh();
      return;
    }
    this.prepareMsForecastTabLoad();
    this.subs.add(
      this.apiService.getMeteoSwissStatus().pipe(take(1)).subscribe({
        next: (status) => {
          if (status?.ready) {
            this.loadMsForecast();
            return;
          }
          if (status?.loading) {
            this.isLoadingMsForecast = false;
            this.msForecastCacheLoading = true;
            this.msForecastErrorKey = '';
            this.startMsForecastCacheWatch();
            return;
          }
          this.loadMsForecast();
        },
        error: () => this.loadMsForecast()
      })
    );
  }

  private activateAggregatedForecastTabIfNeeded(): void {
    this.ensureForecastLocationResolved();
    if (this.hasAggregatedForecastData()) {
      this.scheduleForecastChartsRefresh();
      return;
    }
    this.prepareAggregatedForecastTabLoad();
    this.loadAggregatedForecast();
  }

  private ensureForecastLocationResolved(): void {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return;
    }
    if (this.locationGeocodeKey === this.currentLocationKey()) {
      return;
    }
    this.markLocationResolvedAtCoordinates(this.lat, this.lon);
  }

  private prepareOwmForecastTabLoad(): void {
    this.isLoadingOwmForecast = true;
    this.owmForecastErrorKey = '';
    this.clearOwmForecastCharts();
  }

  private prepareOmForecastTabLoad(): void {
    this.isLoadingOmForecast = true;
    this.omForecastErrorKey = '';
    this.clearOmForecastCharts();
  }

  private prepareMsForecastTabLoad(): void {
    this.isLoadingMsForecast = true;
    this.msForecastErrorKey = '';
    this.clearMsForecastCharts();
  }

  private prepareAggregatedForecastTabLoad(): void {
    this.isLoadingAggregatedForecast = true;
    this.aggregatedForecastErrorKey = '';
    this.clearAggregateForecastCharts();
  }

  /** Start WMS capabilities fetch as soon as MF status confirms AROME-PI (before the user opens the tab). */
  private prefetchAromepiCapabilitiesIfReady(): void {
    if (!this.aromepiAvailable || !this.showMfAromepiTab || this.aromepiCapabilities || this.isLoadingAromepiCapabilities) {
      return;
    }
    this.loadAromepiCapabilities();
  }

  loadAromepiCapabilities(): void {
    if (!this.aromepiAvailable) {
      return;
    }
    if (this.isLoadingAromepiCapabilities || this.aromepiCapabilities) {
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
          this.clampAromepiFrameIndex();
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
          this.scheduleAromepiMapReadyAfterDom();
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
    this.clearAromepiPrefetchLayers();
    this.setupAromepiWmsLayer();
    this.loadAromepiCurrentValues();
  }

  onAromepiFrameSliderInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!Number.isFinite(input.valueAsNumber)) {
      return;
    }
    this.onAromepiFrameIndexChange(input.valueAsNumber);
  }

  onAromepiFrameIndexChange(index: number): void {
    const max = Math.max(0, this.aromepiEffectiveTimeSteps.length - 1);
    const nextIndex = Math.max(0, Math.min(max, Math.round(index)));
    if (nextIndex === this.aromepiFrameIndex && !this.aromepiPlaying) {
      return;
    }
    if (this.aromepiPlaying) {
      this.stopAromepiAnimation();
    }
    const previousIndex = this.aromepiFrameIndex;
    this.aromepiFrameIndex = nextIndex;
    this.cdr.markForCheck();
    this.setupAromepiWmsLayer(!!this.aromepiWmsLayer, (success) => {
      if (success === false) {
        this.aromepiFrameIndex = previousIndex;
        this.cdr.markForCheck();
        return;
      }
      if (!this.aromepiPlaying) {
        this.loadAromepiCurrentValues();
      }
    });
  }

  onAromepiStepFrame(delta: number): void {
    const max = Math.max(0, this.aromepiEffectiveTimeSteps.length - 1);
    if (max < 1 || !Number.isFinite(delta) || delta === 0) {
      return;
    }
    this.onAromepiFrameIndexChange(this.aromepiFrameIndex + delta);
  }

  toggleAromepiPlayback(): void {
    if (this.aromepiPlaying) {
      this.stopAromepiAnimation();
      this.loadAromepiCurrentValues();
      return;
    }
    if (this.aromepiEffectiveTimeSteps.length < 2) {
      return;
    }
    this.aromepiPlaying = true;
    this.prefetchAromepiPlaybackWindow();
    this.scheduleNextAromepiPlaybackFrame(MeteoFranceComponent.AROMEPI_PLAY_FRAME_DWELL_MS);
  }

  private scheduleNextAromepiPlaybackFrame(
    delayMs = MeteoFranceComponent.AROMEPI_PLAY_FRAME_DWELL_MS
  ): void {
    this.clearAromepiPlaybackScheduleTimer();
    if (!this.aromepiPlaying) {
      return;
    }
    this.aromepiPlayScheduleTimer = setTimeout(() => {
      this.aromepiPlayScheduleTimer = null;
      if (!this.aromepiPlaying) {
        return;
      }
      if (this.aromepiWmsTransitioning) {
        this.scheduleNextAromepiPlaybackFrame(50);
        return;
      }
      this.advanceAromepiPlaybackFrame();
    }, delayMs);
  }

  private clearAromepiPlaybackScheduleTimer(): void {
    if (this.aromepiPlayScheduleTimer) {
      clearTimeout(this.aromepiPlayScheduleTimer);
      this.aromepiPlayScheduleTimer = null;
    }
  }

  private advanceAromepiPlaybackFrame(): void {
    if (!this.aromepiPlaying || this.aromepiEffectiveTimeSteps.length < 2) {
      return;
    }
    this.tryShowAromepiPlaybackFrame(this.aromepiFrameIndex, 0);
  }

  private tryShowAromepiPlaybackFrame(fromIndex: number, skipCount: number): void {
    const steps = this.aromepiEffectiveTimeSteps;
    if (!this.aromepiPlaying || steps.length < 2) {
      return;
    }
    if (skipCount >= steps.length) {
      this.restartAromepiPlaybackFromPeriodStart();
      return;
    }
    const nextIndex = (fromIndex + 1) % steps.length;
    const lastValidIndex = this.aromepiFrameIndex;
    this.aromepiFrameIndex = nextIndex;
    this.cdr.markForCheck();
    const prefetched = this.takeAromepiPrefetchLayer(nextIndex);
    this.setupAromepiWmsLayer(true, (success) => {
      if (success === false) {
        this.aromepiFrameIndex = lastValidIndex;
        this.cdr.markForCheck();
        this.tryShowAromepiPlaybackFrame(nextIndex, skipCount + 1);
        return;
      }
      this.prefetchAromepiPlaybackWindow();
      this.scheduleNextAromepiPlaybackFrame();
    }, prefetched);
  }

  /** When no further step in the horizon has data, loop playback from the first step. */
  private restartAromepiPlaybackFromPeriodStart(): void {
    const steps = this.aromepiEffectiveTimeSteps;
    if (!this.aromepiPlaying || steps.length < 2) {
      return;
    }
    this.clearAromepiPrefetchLayers();
    const startIndex = 0;
    const lastValidIndex = this.aromepiFrameIndex;
    this.aromepiFrameIndex = startIndex;
    this.cdr.markForCheck();
    this.prefetchAromepiPlaybackWindow();
    const prefetched = this.takeAromepiPrefetchLayer(startIndex);
    this.setupAromepiWmsLayer(true, (success) => {
      if (success === false) {
        this.aromepiFrameIndex = lastValidIndex;
        this.cdr.markForCheck();
        this.tryShowAromepiPlaybackFrame(startIndex, 1);
        return;
      }
      this.prefetchAromepiPlaybackWindow();
      this.scheduleNextAromepiPlaybackFrame();
    }, prefetched);
  }

  stopAromepiAnimation(): void {
    this.aromepiPlaying = false;
    this.clearAromepiPlaybackScheduleTimer();
    this.clearAromepiPrefetchLayers();
  }

  onAromepiOpacityChange(): void {
    if (this.aromepiWmsLayer) {
      this.aromepiWmsLayer.setOpacity(this.aromepiOpacity);
    }
    if (this.aromepiWmsLayerPending) {
      this.aromepiWmsLayerPending.setOpacity(this.aromepiOpacity);
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
            this.clearAromepiForecastCharts();
            return;
          }
          this.aromepiPointForecast = data;
          this.scheduleForecastChartsRefresh();
        },
        error: () => {
          this.isLoadingAromepiForecast = false;
          this.clearAromepiForecastCharts();
        }
      })
    );
  }

  private scheduleAromepiForecastLoad(): void {
    if (!this.aromepiAvailable || this.activeMainTab !== 'aromepi') {
      return;
    }
    if (!this.hasAromepiPointForecastData()) {
      this.isLoadingAromepiForecast = true;
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

  loadAromepiNearestStation(): void {
    if (!this.aromepiAvailable) {
      this.aromepiNearestStation = null;
      this.aromepiNearestStationStatus = 'idle';
      return;
    }
    if (!this.isLocationInFrance()) {
      this.aromepiNearestStation = null;
      this.aromepiNearestStationStatus = 'outside-france';
      return;
    }
    const requestId = ++this.aromepiNearestStationRequestId;
    this.aromepiNearestStationStatus = 'loading';
    this.subs.add(
      this.apiService.getMeteoFranceNearestObsStation(this.lat, this.lon).subscribe({
        next: (data) => {
          if (requestId !== this.aromepiNearestStationRequestId || this.componentDestroyed) {
            return;
          }
          if (data?.error || !data?.id) {
            this.aromepiNearestStation = null;
            this.aromepiNearestStationStatus = 'unavailable';
            return;
          }
          this.aromepiNearestStation = {
            id: String(data.id),
            name: data.name != null ? String(data.name) : undefined,
            distanceKm: data.distanceKm != null ? Number(data.distanceKm) : undefined
          };
          this.aromepiNearestStationStatus = 'ok';
        },
        error: () => {
          if (requestId !== this.aromepiNearestStationRequestId || this.componentDestroyed) {
            return;
          }
          this.aromepiNearestStation = null;
          this.aromepiNearestStationStatus = 'unavailable';
        }
      })
    );
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
    if (this.componentDestroyed || this.activeMainTab !== 'aromepi') {
      return;
    }
    const container = this.getAromepiMapContainer();
    if (!container) {
      if (this.aromepiMapInitRetryTimer) {
        clearTimeout(this.aromepiMapInitRetryTimer);
      }
      this.aromepiMapInitRetryTimer = this.scheduleComponentTimeout(() => {
        this.aromepiMapInitRetryTimer = null;
        this.initAromepiMap();
      }, 120);
      return;
    }
    if (this.aromepiMap && (container as any)._leaflet_id == null) {
      if (this.aromepiWmsLayer) {
        this.aromepiMap.removeLayer(this.aromepiWmsLayer);
        this.aromepiWmsLayer = null;
      }
      if (this.aromepiWmsLayerPending) {
        this.aromepiMap.removeLayer(this.aromepiWmsLayerPending);
        this.aromepiWmsLayerPending = null;
      }
      this.aromepiMap.remove();
      this.aromepiMap = null;
      this.aromepiMarker = null;
      this.aromepiBaseLayer = null;
      this.aromepiMapInitialized = false;
    }
    if (!this.isAromepiMapContainerVisible(container)) {
      if (this.aromepiMapInitRetryTimer) {
        clearTimeout(this.aromepiMapInitRetryTimer);
      }
      this.aromepiMapInitRetryTimer = this.scheduleComponentTimeout(() => {
        this.aromepiMapInitRetryTimer = null;
        this.initAromepiMap();
      }, 120);
      return;
    }
    if (this.aromepiMap) {
      if (this.aromepiMarker) {
        this.aromepiMarker.setLatLng([this.lat, this.lon]);
      }
      this.bindSharedMapViewSync(this.aromepiMap, 'aromepi');
      this.refreshAromepiMapLayout();
      return;
    }
    const bounds = this.aromepiMapBounds();
    this.ensureSharedMapViewDefaults();
    const initialAromepiZoom = Math.min(Math.max(this.sharedMapZoom!, 5), 14);
    this.aromepiMap = L.map(container, {
      center: [this.sharedMapCenterLat!, this.sharedMapCenterLon!],
      zoom: initialAromepiZoom,
      minZoom: 5,
      maxZoom: 14,
      maxBounds: bounds,
      maxBoundsViscosity: 0.85,
      worldCopyJump: false
    });

    this.applyAromepiMapBaseLayer();

    this.aromepiMarker = L.marker([this.lat, this.lon], { draggable: true }).addTo(this.aromepiMap);
    this.aromepiMarker.on('dragend', () => {
      const pos = this.aromepiMarker!.getLatLng();
      this.setLocation(pos.lat, pos.lng, false);
    });

    this.aromepiMap.on('click', (e: L.LeafletMouseEvent) => {
      this.setLocation(e.latlng.lat, e.latlng.lng, false);
    });

    this.aromepiMapInitialized = true;
    this.bindSharedMapViewSync(this.aromepiMap, 'aromepi');
    this.setupAromepiWmsLayer();
    this.refreshAromepiMapLayout();
  }

  private getAromepiMapContainer(): HTMLElement | null {
    return document.getElementById('meteo-france-aromepi-map');
  }

  private isAromepiMapContainerVisible(container: HTMLElement): boolean {
    return container.offsetWidth > 0 && container.offsetHeight > 0;
  }

  private scheduleAromepiMapInit(afterInit?: () => void): void {
    this.clearAromepiMapTimers();
    const initTimer = setTimeout(() => {
      this.aromepiMapLayoutTimers.delete(initTimer);
      if (this.componentDestroyed || this.activeMainTab !== 'aromepi') {
        return;
      }
      afterInit?.();
      if (this.showMfAromepiTab) {
        this.initAromepiMap();
        if (this.aromepiCapabilities) {
          this.setupAromepiWmsLayer();
        }
        this.refreshAromepiMapLayout();
      }
    }, 0);
    this.aromepiMapLayoutTimers.add(initTimer);
    this.scheduleAromepiMapLayoutRefresh(150);
    this.scheduleAromepiMapLayoutRefresh(450);
  }

  /** After capabilities load: wait for *ngIf DOM, then create Leaflet map + WMS layer. */
  private scheduleAromepiMapReadyAfterDom(): void {
    const boot = () => {
      if (this.componentDestroyed || this.activeMainTab !== 'aromepi') {
        return;
      }
      this.initAromepiMap();
      this.setupAromepiWmsLayer();
      if (!this.hasAromepiPointForecastData()) {
        this.scheduleAromepiForecastLoad();
      }
      this.loadAromepiCurrentValues();
      this.refreshAromepiMapLayout();
    };
    setTimeout(boot, 0);
    this.scheduleAromepiMapLayoutRefresh(150);
    this.scheduleAromepiMapLayoutRefresh(450);
  }

  private ensureAromepiCapabilitiesLoaded(): void {
    if (!this.aromepiAvailable) {
      return;
    }
    if (!this.aromepiCapabilities && !this.isLoadingAromepiCapabilities) {
      this.loadAromepiCapabilities();
      return;
    }
    if (!this.aromepiCapabilities || this.isLoadingAromepiCapabilities) {
      return;
    }
    this.initAromepiMap();
    this.setupAromepiWmsLayer();
    if (!this.hasAromepiPointForecastData()) {
      this.scheduleAromepiForecastLoad();
    }
    this.loadAromepiCurrentValues();
    this.refreshAromepiMapLayout();
  }

  private focusAromepiMapOnPosition(): void {
    if (!this.aromepiMap) {
      return;
    }
    this.applySharedMapViewTo(this.aromepiMap);
  }

  private scheduleForecastMapInit(afterInit?: () => void): void {
    this.clearForecastMapTimers();
    const initTimer = setTimeout(() => {
      this.forecastMapLayoutTimers.delete(initTimer);
      if (this.componentDestroyed) {
        return;
      }
      this.initForecastMap();
      afterInit?.();
      this.refreshForecastMapLayout();
    }, 0);
    this.forecastMapLayoutTimers.add(initTimer);
    this.scheduleForecastMapLayoutRefresh(150);
    this.scheduleForecastMapLayoutRefresh(450);
  }

  private destroyForecastMap(): void {
    this.clearForecastMapTimers();
    if (this.forecastMap) {
      this.forecastMap.remove();
    }
    this.forecastMap = null;
    this.forecastMarker = null;
    this.forecastBaseLayer = null;
    this.forecastMapInitialized = false;
  }

  private getForecastMapContainer(): HTMLElement | null {
    return document.getElementById('meteo-france-forecast-map');
  }

  private isForecastMapContainerVisible(container: HTMLElement): boolean {
    return container.offsetWidth > 0 && container.offsetHeight > 0;
  }

  private initForecastMap(): void {
    if (this.componentDestroyed || !this.isForecastOptionsTab) {
      return;
    }
    const container = this.getForecastMapContainer();
    if (!container) {
      return;
    }
    if (this.forecastMap && (container as any)._leaflet_id == null) {
      this.destroyForecastMap();
    }
    if (!this.isForecastMapContainerVisible(container)) {
      if (this.forecastMapInitRetryTimer) {
        clearTimeout(this.forecastMapInitRetryTimer);
      }
      this.forecastMapInitRetryTimer = this.scheduleComponentTimeout(() => {
        this.forecastMapInitRetryTimer = null;
        this.initForecastMap();
      }, 120);
      return;
    }
    if (this.forecastMap) {
      this.bindForecastMapInteraction();
      this.bindSharedMapViewSync(this.forecastMap, 'forecast');
      this.refreshForecastMapLayout();
      return;
    }

    this.ensureSharedMapViewDefaults();
    this.forecastMap = L.map(container, {
      center: [this.sharedMapCenterLat!, this.sharedMapCenterLon!],
      zoom: this.sharedMapZoom!,
      minZoom: 3,
      maxZoom: 18,
      worldCopyJump: true
    });

    this.applyForecastMapBaseLayer();

    this.forecastMarker = L.marker([this.lat, this.lon], { draggable: true }).addTo(this.forecastMap);
    this.bindForecastMapInteraction();
    this.bindSharedMapViewSync(this.forecastMap, 'forecast');
    this.forecastMapInitialized = true;
    this.refreshForecastMapLayout();
  }

  private bindForecastMapInteraction(): void {
    if (!this.forecastMap || !this.forecastMarker) {
      return;
    }
    this.forecastMarker.setLatLng([this.lat, this.lon]);
    this.forecastMarker.off('dragend');
    this.forecastMarker.on('dragend', () => {
      const pos = this.forecastMarker!.getLatLng();
      this.onForecastMapLocationPick(pos.lat, pos.lng);
    });
    this.forecastMap.off('click');
    this.forecastMap.on('click', (e: L.LeafletMouseEvent) => {
      this.onForecastMapLocationPick(e.latlng.lat, e.latlng.lng);
    });
  }

  /** Click or drag on the shared forecast options map. */
  private onForecastMapLocationPick(lat: number, lon: number): void {
    if (!this.isForecastOptionsTab) {
      return;
    }
    this.setLocation(lat, lon, false);
    this.centerSharedMapOnLocation({ minZoom: MeteoFranceComponent.FORECAST_MAP_ZOOM });
  }

  private applyForecastMapBaseLayer(): void {
    if (!this.forecastMap) {
      return;
    }
    this.forecastBaseLayer = this.basemapService.applyBaseLayer(
      this.forecastMap,
      this.mapBaseLayerId,
      this.forecastBaseLayer
    );
  }

  private applyAromepiMapBaseLayer(): void {
    if (!this.aromepiMap) {
      return;
    }
    this.aromepiBaseLayer = this.basemapService.applyBaseLayer(
      this.aromepiMap,
      this.mapBaseLayerId,
      this.aromepiBaseLayer
    );
  }

  private refreshAromepiMapLayout(): void {
    if (!this.aromepiMap || this.activeMainTab !== 'aromepi') {
      return;
    }
    this.aromepiMap.invalidateSize(true);
    if (!this.aromepiBaseLayer) {
      this.applyAromepiMapBaseLayer();
    }
    this.redrawAromepiMapTiles();
    this.focusAromepiMapOnPosition();
  }

  private redrawAromepiMapTiles(): void {
    if (!this.aromepiMap) {
      return;
    }
    this.aromepiMap.eachLayer((layer) => {
      if (layer instanceof L.TileLayer) {
        layer.redraw();
        return;
      }
      if (layer instanceof L.LayerGroup) {
        layer.eachLayer((child) => {
          if (child instanceof L.TileLayer) {
            child.redraw();
          }
        });
      }
    });
  }

  private refreshForecastMapLayout(): void {
    if (!this.forecastMap || !this.isForecastOptionsTab) {
      return;
    }
    this.forecastMap.invalidateSize(true);
    if (!this.forecastBaseLayer) {
      this.applyForecastMapBaseLayer();
    }
    this.redrawForecastMapTiles();
    this.focusForecastMapOnPosition();
  }

  private redrawForecastMapTiles(): void {
    if (!this.forecastMap) {
      return;
    }
    this.forecastMap.eachLayer((layer) => {
      if (layer instanceof L.TileLayer) {
        layer.redraw();
        return;
      }
      if (layer instanceof L.LayerGroup) {
        layer.eachLayer((child) => {
          if (child instanceof L.TileLayer) {
            child.redraw();
          }
        });
      }
    });
  }

  private focusForecastMapOnPosition(): void {
    if (!this.forecastMap) {
      return;
    }
    this.applySharedMapViewTo(this.forecastMap);
  }

  private aromepiMapBounds(): L.LatLngBoundsExpression {
    const b = this.aromepiCapabilities?.bounds;
    if (b?.south != null && b?.west != null && b?.north != null && b?.east != null) {
      return [[b.south, b.west], [b.north, b.east]];
    }
    return [[40.0, -6.0], [51.5, 10.0]];
  }

  private setupAromepiWmsLayer(
    crossfade = false,
    onComplete?: (success: boolean) => void,
    prefetchedLayer?: L.TileLayer | null
  ): void {
    if (!this.aromepiMap || !this.aromepiMapInitialized || !this.aromepiAvailable) {
      onComplete?.(false);
      return;
    }
    if (!this.aromepiSelectedLayer || !this.aromepiCurrentTime || !this.aromepiReferenceTime) {
      onComplete?.(false);
      return;
    }
    const { time, referenceTime } = this.resolveAromepiWmsTimes();
    if (!time || !referenceTime) {
      onComplete?.(false);
      return;
    }
    const url = this.buildAromepiWmsUrl(this.aromepiSelectedLayer, this.aromepiSelectedStyle, time, referenceTime);
    if (crossfade && this.aromepiWmsLayer) {
      if (prefetchedLayer && !this.isAromepiLayerDataAvailable(prefetchedLayer)) {
        this.discardAromepiPrefetchLayer(prefetchedLayer);
        this.crossfadeAromepiWmsLayer(url, onComplete);
        return;
      }
      this.crossfadeAromepiWmsLayer(url, onComplete, prefetchedLayer);
      return;
    }
    if (prefetchedLayer) {
      if (!this.isAromepiLayerDataAvailable(prefetchedLayer)) {
        this.discardAromepiPrefetchLayer(prefetchedLayer);
        onComplete?.(false);
        return;
      }
      this.replaceAromepiWmsLayerImmediate(url, prefetchedLayer);
      onComplete?.(true);
      return;
    }
    this.replaceAromepiWmsLayerImmediate(url);
    onComplete?.(true);
  }

  private buildAromepiWmsUrl(layer: string, style: string, time: string, referenceTime: string): string {
    const styleParam = style ? `&style=${encodeURIComponent(style)}` : '';
    return `${environment.API_URL}external/meteofrance/aromepi/wms/{z}/{x}/{y}?layer=${encodeURIComponent(layer)}&time=${encodeURIComponent(time)}&referenceTime=${encodeURIComponent(referenceTime)}${styleParam}&width=256&height=256`;
  }

  private createAromepiWmsTileLayer(url: string, opacity: number): L.TileLayer {
    const options: L.TileLayerOptions = {
      opacity,
      zIndex: 500,
      maxNativeZoom: 10,
      maxZoom: 12,
      updateWhenIdle: !this.aromepiPlaying,
      keepBuffer: this.aromepiPlaying ? 2 : 1,
      attribution: '&copy; Météo-France AROME-PI (via PatTool)'
    };
    const b = this.aromepiCapabilities?.bounds;
    if (b?.south != null && b?.west != null && b?.north != null && b?.east != null) {
      options.bounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);
    }
    const tileLayer = L.tileLayer(url, options);
    tileLayer.on('tileerror', () => {
      if (!this.aromepiPlaying) {
        this.aromepiLoadError = true;
      }
    });
    tileLayer.on('load', () => {
      this.aromepiLoadError = false;
    });
    return tileLayer;
  }

  private replaceAromepiWmsLayerImmediate(url: string, existingLayer?: L.TileLayer | null): void {
    this.cancelAromepiWmsCrossfade();
    if (this.aromepiWmsLayerPending && this.aromepiMap) {
      this.aromepiMap.removeLayer(this.aromepiWmsLayerPending);
      this.aromepiWmsLayerPending = null;
    }
    if (this.aromepiWmsLayer && this.aromepiMap) {
      this.aromepiMap.removeLayer(this.aromepiWmsLayer);
      this.aromepiWmsLayer = null;
    }
    if (!this.aromepiMap) {
      return;
    }
    if (existingLayer && this.aromepiMap.hasLayer(existingLayer)) {
      this.aromepiWmsLayer = existingLayer;
      existingLayer.setOpacity(this.aromepiOpacity);
      return;
    }
    this.aromepiWmsLayer = this.createAromepiWmsTileLayer(url, this.aromepiOpacity);
    this.aromepiWmsLayer.addTo(this.aromepiMap);
  }

  private crossfadeAromepiWmsLayer(
    url: string,
    onComplete?: (success: boolean) => void,
    prefetchedLayer?: L.TileLayer | null
  ): void {
    if (!this.aromepiMap || !this.aromepiWmsLayer) {
      this.replaceAromepiWmsLayerImmediate(url, prefetchedLayer);
      onComplete?.(true);
      return;
    }
    this.cancelAromepiWmsCrossfade();
    const oldLayer = this.aromepiWmsLayer;
    const newLayer = prefetchedLayer ?? this.createAromepiWmsTileLayer(url, 0);
    this.aromepiWmsLayerPending = newLayer;
    this.aromepiWmsTransitioning = true;
    if (!prefetchedLayer || !this.aromepiMap.hasLayer(newLayer)) {
      newLayer.addTo(this.aromepiMap);
    }

    let finished = false;
    let fadeStarted = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      this.aromepiWmsTransitioning = false;
      this.aromepiWmsLayer = newLayer;
      this.aromepiWmsLayerPending = null;
      onComplete?.(true);
    };

    const abortTransition = () => {
      if (finished) {
        return;
      }
      finished = true;
      this.clearAromepiWmsCrossfadeFallbackTimer();
      newLayer.off('load', onLayerReady);
      newLayer.off('tileload', onFirstTile);
      if (this.aromepiMap?.hasLayer(newLayer)) {
        this.aromepiMap.removeLayer(newLayer);
      }
      this.aromepiWmsLayerPending = null;
      this.aromepiWmsTransitioning = false;
      onComplete?.(false);
    };

    const crossfadeMs = this.aromepiPlaying
      ? MeteoFranceComponent.AROMEPI_PLAY_CROSSFADE_MS
      : MeteoFranceComponent.AROMEPI_WMS_CROSSFADE_MS;

    const startFade = () => {
      if (fadeStarted) {
        return;
      }
      fadeStarted = true;
      newLayer.off('load', onLayerReady);
      newLayer.off('tileload', onFirstTile);
      const targetOpacity = this.aromepiOpacity;
      const steps = this.aromepiPlaying ? 6 : 8;
      const stepMs = Math.max(20, Math.round(crossfadeMs / steps));
      let step = 0;
      this.aromepiWmsCrossfadeTimer = setInterval(() => {
        step += 1;
        const ratio = Math.min(1, step / steps);
        newLayer.setOpacity(targetOpacity * ratio);
        oldLayer.setOpacity(targetOpacity * (1 - ratio));
        if (step >= steps) {
          this.cancelAromepiWmsCrossfade(false);
          if (this.aromepiMap?.hasLayer(oldLayer)) {
            this.aromepiMap.removeLayer(oldLayer);
          }
          newLayer.setOpacity(targetOpacity);
          finish();
        }
      }, stepMs);
    };

    const proceedToFade = () => {
      if (finished) {
        return;
      }
      if (!this.isAromepiLayerDataAvailable(newLayer)) {
        abortTransition();
        return;
      }
      startFade();
    };

    const onFirstTile = () => {
      if (this.aromepiPlaying && this.isAromepiLayerDataAvailable(newLayer)) {
        newLayer.off('tileload', onFirstTile);
        proceedToFade();
      }
    };

    const onLayerReady = () => {
      newLayer.off('load', onLayerReady);
      newLayer.off('tileload', onFirstTile);
      proceedToFade();
    };

    if (prefetchedLayer && this.isAromepiLayerDataAvailable(newLayer)) {
      proceedToFade();
    } else {
      newLayer.on('load', onLayerReady);
      if (this.aromepiPlaying) {
        newLayer.on('tileload', onFirstTile);
      }
      this.clearAromepiWmsCrossfadeFallbackTimer();
      const fallbackMs = this.aromepiPlaying
        ? MeteoFranceComponent.AROMEPI_PLAY_DATA_WAIT_MS
        : 2500;
      this.aromepiWmsCrossfadeFallbackTimer = this.scheduleComponentTimeout(() => {
        this.aromepiWmsCrossfadeFallbackTimer = null;
        if (!finished && this.aromepiWmsLayerPending === newLayer) {
          proceedToFade();
        }
      }, fallbackMs);
    }
  }

  private isAromepiLayerDataAvailable(layer: L.TileLayer): boolean {
    const tiles = (layer as L.TileLayer & { _tiles?: Record<string, { loaded?: boolean }> })._tiles;
    if (!tiles) {
      return false;
    }
    const values = Object.values(tiles);
    return values.length > 0 && values.some((tile) => tile.loaded);
  }

  private discardAromepiPrefetchLayer(layer: L.TileLayer): void {
    if (this.aromepiMap?.hasLayer(layer)) {
      this.aromepiMap.removeLayer(layer);
    }
    this.aromepiPrefetchLayers.forEach((cached, frameIndex) => {
      if (cached === layer) {
        this.aromepiPrefetchLayers.delete(frameIndex);
      }
    });
  }

  private prefetchAromepiPlaybackWindow(): void {
    const steps = this.aromepiEffectiveTimeSteps;
    if (steps.length < 2 || !this.aromepiMap) {
      return;
    }
    for (let i = 1; i <= this.aromepiPrefetchAhead; i++) {
      const idx = (this.aromepiFrameIndex + i) % steps.length;
      this.prefetchAromepiFrame(idx);
    }
  }

  private prefetchAromepiFrame(frameIndex: number): void {
    if (this.aromepiPrefetchLayers.has(frameIndex)) {
      return;
    }
    const steps = this.aromepiEffectiveTimeSteps;
    if (frameIndex < 0 || frameIndex >= steps.length) {
      return;
    }
    const time = steps[frameIndex];
    if (!time || !this.aromepiReferenceTime || !this.aromepiMap || !this.aromepiSelectedLayer) {
      return;
    }
    const url = this.buildAromepiWmsUrl(
      this.aromepiSelectedLayer,
      this.aromepiSelectedStyle,
      time,
      this.aromepiReferenceTime
    );
    const layer = this.createAromepiWmsTileLayer(url, 0);
    layer.addTo(this.aromepiMap);
    this.aromepiPrefetchLayers.set(frameIndex, layer);
  }

  private takeAromepiPrefetchLayer(frameIndex: number): L.TileLayer | null {
    const layer = this.aromepiPrefetchLayers.get(frameIndex) ?? null;
    if (layer) {
      this.aromepiPrefetchLayers.delete(frameIndex);
    }
    return layer;
  }

  private clearAromepiPrefetchLayers(): void {
    if (this.aromepiMap) {
      this.aromepiPrefetchLayers.forEach((layer) => {
        if (this.aromepiMap!.hasLayer(layer)) {
          this.aromepiMap!.removeLayer(layer);
        }
      });
    }
    this.aromepiPrefetchLayers.clear();
  }

  private cancelAromepiWmsCrossfade(clearPendingLayer = true): void {
    this.clearAromepiWmsCrossfadeFallbackTimer();
    if (this.aromepiWmsCrossfadeTimer) {
      clearInterval(this.aromepiWmsCrossfadeTimer);
      this.aromepiWmsCrossfadeTimer = null;
    }
    this.aromepiWmsTransitioning = false;
    if (clearPendingLayer && this.aromepiWmsLayerPending && this.aromepiMap) {
      this.aromepiMap.removeLayer(this.aromepiWmsLayerPending);
      this.aromepiWmsLayerPending = null;
    }
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
      setTimeout(() => this.refreshAromepiMapLayout(), 120);
    }).catch(() => {
      this.aromepiMapFullscreen = !this.aromepiMapFullscreen;
      setTimeout(() => this.refreshAromepiMapLayout(), 120);
    });
  }

  private exitAromepiMapFullscreenIfActive(): void {
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void> };
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(document);
      exit?.().catch(() => {
        this.aromepiMapFullscreen = false;
        setTimeout(() => this.refreshAromepiMapLayout(), 120);
      });
      return;
    }
    if (this.aromepiMapFullscreen) {
      this.aromepiMapFullscreen = false;
      setTimeout(() => this.refreshAromepiMapLayout(), 120);
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
    return this.formatTemperatureDateTime(d);
  }

  formatAromepiOffsetMinutes(minutes: number, parens = false): string {
    const unit = this.translate.instant('METEO_FRANCE.FORECAST_MINUTES_UNIT');
    const text = `+${minutes} ${unit}`;
    return parens ? `(${text})` : text;
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

  formatAromepiPointValue(layerName: string, value: unknown): string {
    if (value === null || value === undefined || value === '') {
      return '—';
    }
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return String(value);
    }
    const upper = layerName.toUpperCase();
    if (upper.includes('TEMPERATURE') || upper.includes('DEW_POINT') || upper.includes('WETB')) {
      return this.formatTemperature(num);
    }
    if (upper.includes('HUMIDITY') || upper.includes('NEBUL') || upper.includes('CLOUD_COVER')) {
      return `${Math.round(num)} %`;
    }
    if (upper.includes('PRECIP') || upper.includes('NEIGE') || upper.includes('GRAUPEL') || upper.includes('GRELE')) {
      return `${num} mm`;
    }
    if (upper.includes('WIND')) {
      return `${num} m/s`;
    }
    if (upper.includes('VISIBILITY')) {
      return `${Math.round(num)} m`;
    }
    if (upper.includes('PRESSURE')) {
      return `${num} hPa`;
    }
    return String(num);
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
    (document.activeElement as HTMLElement)?.blur();
    const query = this.city.trim();
    if (!query) {
      return;
    }

    const parsedCoords = this.parseCoordinatesInput(query);
    if (parsedCoords) {
      this.errorMessage = '';
      this.citySearchResults = [];
      this.setLocation(parsedCoords.lat, parsedCoords.lon, true);
      return;
    }

    const cacheKey = query.toLowerCase();
    const cached = this.citySearchCache.get(cacheKey);
    if (cached) {
      this.citySearchResults = cached;
      this.errorMessage = cached.length > 0 ? '' : 'METEO_FRANCE.GEOCODE_ERROR';
      this.isLoadingCitySearch = false;
      this.cdr.detectChanges();
      return;
    }

    this.errorMessage = '';
    this.isLoadingCitySearch = true;
    const requestId = ++this.citySearchRequestId;
    this.apiService.geocodeSearch(query).pipe(take(1)).subscribe({
      next: (data: any[]) => {
        if (requestId !== this.citySearchRequestId) {
          return;
        }
        const results = (data || [])
          .map((item) => this.normalizeGeocodeSearchResult(item))
          .filter((item): item is MeteoFranceGeocodeResult => item != null);
        this.citySearchCache.set(cacheKey, results);
        this.citySearchResults = results;
        if (results.length === 0) {
          this.errorMessage = 'METEO_FRANCE.GEOCODE_ERROR';
        }
        this.cdr.detectChanges();
      },
      error: () => {
        if (requestId !== this.citySearchRequestId) {
          return;
        }
        this.errorMessage = 'METEO_FRANCE.GEOCODE_ERROR';
        this.cdr.detectChanges();
      },
      complete: () => {
        if (requestId !== this.citySearchRequestId) {
          return;
        }
        this.isLoadingCitySearch = false;
        this.cdr.detectChanges();
      }
    });
  }

  selectCity(result: MeteoFranceGeocodeResult | any): void {
    const normalized = this.normalizeGeocodeSearchResult(result) ?? (result as MeteoFranceGeocodeResult);
    if (!normalized || !Number.isFinite(normalized.lat) || !Number.isFinite(normalized.lon)) {
      return;
    }
    this.selectCityFromGeocode(normalized);
  }

  /** Same critical path as address-geocode selectResult: UI first, heavy work later. */
  private selectCityFromGeocode(result: MeteoFranceGeocodeResult): void {
    this.citySearchResults = [];
    this.errorMessage = '';
    this.lat = result.lat;
    this.lon = result.lon;
    this.applyGeocodeMetadata(result, result.lat, result.lon);
    this.syncMapMarkers(false);
    this.cdr.detectChanges();
    setTimeout(() => {
      if (this.componentDestroyed) {
        return;
      }
      this.scheduleWeatherReloadForLocation();
    }, 0);
  }

  private normalizeGeocodeSearchResult(item: any): MeteoFranceGeocodeResult | null {
    if (!item) {
      return null;
    }
    const lat = typeof item.lat === 'number' ? item.lat : parseFloat(item.lat);
    const lon = typeof item.lon === 'number' ? item.lon : parseFloat(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }
    return {
      lat,
      lon,
      displayName: item.displayName || item.display_name || item.cityName || '',
      address: (item.address && typeof item.address === 'object') ? item.address : {}
    };
  }

  /** Parse coordinates from input: "lat, lon" or "lat lon" (same as address-geocode). */
  private parseCoordinatesInput(input: string): { lat: number; lon: number } | null {
    const trimmed = input.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
    const parts = trimmed.split(' ').filter((p) => p.length > 0);
    if (parts.length < 2) {
      return null;
    }
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return null;
    }
    return { lat, lon };
  }

  private syncMapMarkers(moveMap: boolean): void {
    if (this.marker) {
      this.marker.setLatLng([this.lat, this.lon]);
    }
    if (this.aromepiMarker) {
      this.aromepiMarker.setLatLng([this.lat, this.lon]);
    }
    if (this.forecastMarker) {
      this.forecastMarker.setLatLng([this.lat, this.lon]);
    }
    if (moveMap) {
      this.centerSharedMapOnLocation({ minZoom: MeteoFranceComponent.RADAR_MAP_ZOOM });
    }
  }

  private scheduleWeatherReloadForLocation(): void {
    const key = this.currentLocationKey();
    if (this.weatherReloadDebounceTimer) {
      clearTimeout(this.weatherReloadDebounceTimer);
    }
    this.weatherReloadDebounceTimer = setTimeout(() => {
      this.weatherReloadDebounceTimer = null;
      if (this.componentDestroyed || this.currentLocationKey() !== key) {
        return;
      }
      this.reloadWeatherForCurrentLocation();
    }, 400);
  }

  private reloadWeatherForCurrentLocation(): void {
    this.syncWeatherSourcePreferences();
    this.clearWeatherAndForecast();
    this.refreshClimatologyForLocation();
    this.refreshMsHistForLocation();
    this.scheduleAromepiForecastLoad();
    this.loadAromepiNearestStation();
    if (this.showTemperatureMap) {
      this.refreshMfTemperatureAvailability();
      this.fetchSelectedPointTemperature(this.lat, this.lon);
      this.updateSelectedTemperatureLabel();
    }
    this.focusActiveTabMap();
    if (this.isMultiDayForecastTab) {
      this.reloadActiveMultiDayForecast();
    } else {
      this.refreshActiveForecastTab();
    }
  }

  private focusActiveTabMap(): void {
    if (this.activeMainTab === 'radar' && this.map) {
      this.focusRadarMapOnPosition();
    } else if (this.activeMainTab === 'aromepi' && this.aromepiMap) {
      this.focusAromepiMapOnPosition();
    } else if (this.isForecastTab && this.forecastMap) {
      this.focusForecastMapOnPosition();
    }
  }

  private markLocationResolvedAtCoordinates(lat: number, lon: number): void {
    this.locationGeocodeKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  }

  centerMapOnUserPosition(): void {
    this.useGps();
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
            if (this.componentDestroyed) {
              return;
            }
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
    this.markLocationResolvedAtCoordinates(lat, lon);
    this.selectedLocationName = this.formatGpsCoordinates(lat, lon);
    this.fullAddress = this.selectedLocationName;
    this.errorMessage = '';
    if (!preserveDepartment) {
      this.departmentCode = '';
      this.countryCode = '';
    }
    this.syncMapMarkers(moveMap);
    this.reverseGeocodeForLocation(lat, lon);
    this.scheduleWeatherReloadForLocation();
  }

  /** Resolve place name and address from coordinates (map click, GPS, marker drag). */
  private reverseGeocodeForLocation(lat: number, lon: number): void {
    const requestKey = this.currentLocationKey();
    const requestId = ++this.reverseGeocodeRequestId;
    this.subs.add(
      this.apiService.geocodeReverse(lat, lon).pipe(take(1)).subscribe({
        next: (data) => {
          if (this.componentDestroyed || requestId !== this.reverseGeocodeRequestId) {
            return;
          }
          if (this.currentLocationKey() !== requestKey) {
            return;
          }
          const normalized = this.normalizeGeocodeSearchResult({
            lat: data?.lat ?? lat,
            lon: data?.lon ?? lon,
            displayName: data?.displayName ?? data?.display_name,
            display_name: data?.display_name ?? data?.displayName,
            address: data?.address
          });
          if (normalized) {
            this.applyGeocodeMetadata(normalized, lat, lon);
            this.cdr.detectChanges();
          }
        },
        error: () => {
          /* keep coordinate fallback already shown in setLocation */
        }
      })
    );
  }

  private reloadActiveMultiDayForecast(): void {
    if (this.activeMainTab === 'forecast-owm') {
      this.prepareOwmForecastTabLoad();
      this.loadOwmForecast(true);
    } else if (this.activeMainTab === 'forecast-om') {
      this.prepareOmForecastTabLoad();
      this.loadOmForecast(true);
    } else if (this.activeMainTab === 'forecast-ms') {
      this.prepareMsForecastTabLoad();
      this.loadMsForecast(true);
    } else if (this.activeMainTab === 'forecast-aggregate') {
      this.prepareAggregatedForecastTabLoad();
      this.loadAggregatedForecast(true);
    }
  }

  /** Reload nearest-station climatology when the map location changes. */
  private refreshClimatologyForLocation(): void {
    if (!this.climAvailable) {
      return;
    }
    this.invalidateClimForLocationChange();
    if (this.activeMainTab === 'clim') {
      this.prepareClimTabLoad();
      this.loadClimDataForCurrentPosition();
    }
  }

  /** Reload nearest-station MeteoSwiss history when the map location changes. */
  private refreshMsHistForLocation(): void {
    if (!this.showMsHistTab) {
      return;
    }
    this.invalidateMsHistForLocationChange();
    if (this.activeMainTab === 'ms-hist') {
      this.prepareMsHistTabLoad();
      this.loadMsHistDataForCurrentPosition();
    }
  }

  private currentLocationKey(): string {
    return `${this.lat.toFixed(4)},${this.lon.toFixed(4)}`;
  }

  private currentClimCacheKey(stationId?: string): string {
    const days = this.climFrequency === 'horaire' ? Math.min(this.climDays, 31) : this.climDays;
    return this.historyCache.climKey(
      this.lat,
      this.lon,
      days,
      this.climFrequency,
      stationId ?? (this.climSelectedStationId || undefined)
    );
  }

  private isClimStaleForLocation(): boolean {
    return this.climDataCacheKey !== this.currentClimCacheKey();
  }

  private invalidateClimForLocationChange(): void {
    this.climDataCacheKey = '';
    this.climSelectedStationId = '';
    this.climStations = [];
    this.climData = null;
    this.climChartsReady = false;
    this.climErrorKey = '';
    this.climErrorDetail = '';
    this.climFromCache = false;
  }

  private markClimLocationLoaded(cacheKey: string): void {
    this.climDataCacheKey = cacheKey;
  }

  /** Show spinner immediately when opening the clim tab or before the HTTP call starts. */
  private prepareClimTabLoad(): void {
    if (this.climStatusMessageKey) {
      return;
    }
    if (!this.mfStatus) {
      this.isLoadingClim = true;
      this.climChartsReady = false;
      return;
    }
    if (!this.climAvailable) {
      this.isLoadingClim = false;
      return;
    }
    if (this.climDisplayRows.length && !this.isClimStaleForLocation()) {
      return;
    }
    this.isLoadingClim = true;
    this.climChartsReady = false;
    this.cdr.markForCheck();
  }

  /** Load climatology for the nearest station at the current map position. */
  private loadClimDataForCurrentPosition(): void {
    if (!this.climAvailable) {
      return;
    }
    if (this.climDisplayRows.length && !this.isClimStaleForLocation()) {
      this.isLoadingClim = false;
      this.updateClimCharts();
      return;
    }
    if (this.isClimStaleForLocation()) {
      this.climSelectedStationId = '';
      this.climStations = [];
    }
    this.loadClimData(this.climSelectedStationId || undefined);
  }

  /** Apply Nominatim address fields (forward geocode response). UI only — no weather loads. */
  private applyGeocodeMetadata(res: any, lat: number, lon: number): void {
    this.locationGeocodeKey = this.currentLocationKey();
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
  }

  loadClimData(stationId?: string, forceRefresh = false): void {
    if (!this.climAvailable) {
      this.climData = null;
      return;
    }
    const days = this.climFrequency === 'horaire' ? Math.min(this.climDays, 31) : this.climDays;
    const climQuery = {
      lat: this.lat,
      lon: this.lon,
      days,
      frequency: this.climFrequency,
      stationId
    };
    if (!forceRefresh) {
      const clientCached = this.historyCache.lookupClim(climQuery);
      if (clientCached) {
        this.isLoadingClim = false;
        this.climFromCache = true;
        this.applyClimDataResponse(clientCached, this.historyCache.climKey(
          climQuery.lat,
          climQuery.lon,
          climQuery.days,
          climQuery.frequency,
          climQuery.stationId
        ));
        return;
      }
    }
    this.isLoadingClim = true;
    this.climChartsReady = false;
    this.climErrorKey = '';
    this.climErrorDetail = '';
    this.climAttemptedStation = null;
    this.climFromCache = false;
    this.cdr.markForCheck();
    this.setClimPeriodPreview(days);
    this.logBackend('METEO_FRANCE.LOG_CAT_CLIM', 'METEO_FRANCE.LOG_SOURCE_MF_DPCLIM', 'loading');
    this.subs.add(
      this.apiService.getMeteoFranceClimNearby(
        this.lat,
        this.lon,
        days,
        this.climFrequency,
        this.departmentCode || undefined,
        stationId,
        forceRefresh
      ).subscribe({
        next: (data) => {
          this.isLoadingClim = false;
          this.historyCache.setClim(climQuery, data);
          this.climFromCache = !!data?.cached;
          this.applyClimDataResponse(data, this.historyCache.climKey(
            climQuery.lat,
            climQuery.lon,
            climQuery.days,
            climQuery.frequency,
            climQuery.stationId
          ));
        },
        error: () => {
          this.isLoadingClim = false;
          this.climData = null;
          this.climChartsReady = false;
          this.climFromCache = false;
          this.climErrorKey = 'METEO_FRANCE.CLIM_LOAD_ERROR';
          this.climErrorDetail = '';
          this.logBackend('METEO_FRANCE.LOG_CAT_CLIM', 'METEO_FRANCE.LOG_SOURCE_MF_DPCLIM', 'error');
        }
      })
    );
  }

  private applyClimDataResponse(data: any, cacheKey: string): void {
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
      this.markClimLocationLoaded(cacheKey);
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
    this.markClimLocationLoaded(cacheKey);
    const stationLabel = data?.station?.name || data?.station?.id || '';
    this.logBackend(
      'METEO_FRANCE.LOG_CAT_CLIM',
      'METEO_FRANCE.LOG_SOURCE_MF_DPCLIM',
      'ok',
      stationLabel ? String(stationLabel) : undefined
    );
    setTimeout(() => this.updateClimCharts(), 0);
  }

  onClearClimHistoryCache(): void {
    if (this.isClearingClimHistoryCache) {
      return;
    }
    this.isClearingClimHistoryCache = true;
    this.historyCache.clearClim();
    this.subs.add(
      this.apiService.clearMeteoFranceClimCache().subscribe({
        next: () => {
          this.isClearingClimHistoryCache = false;
          this.climFromCache = false;
          this.loadClimData(this.climSelectedStationId || undefined, true);
        },
        error: () => {
          this.isClearingClimHistoryCache = false;
          this.loadClimData(this.climSelectedStationId || undefined, true);
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

  onMsHistPeriodChange(): void {
    this.loadMsHistData(false);
  }

  private currentMsHistCacheKey(): string {
    return this.historyCache.msHistKey(this.lat, this.lon, this.msHistDays);
  }

  private isMsHistStaleForLocation(): boolean {
    return this.msHistDataCacheKey !== this.currentMsHistCacheKey();
  }

  private invalidateMsHistForLocationChange(): void {
    this.msHistDataCacheKey = '';
    this.msHistData = null;
    this.msHistChartsReady = false;
    this.msHistErrorKey = '';
    this.msHistErrorDetail = '';
    this.msHistFromCache = false;
  }

  private markMsHistLocationLoaded(cacheKey: string): void {
    this.msHistDataCacheKey = cacheKey;
  }

  private syncMsHistFromCacheFlag(): void {
    this.msHistFromCache = !!this.msHistData?.cached
      || this.historyCache.lookupMsHist({
        lat: this.lat,
        lon: this.lon,
        days: this.msHistDays
      }) != null;
  }

  private prepareMsHistTabLoad(): void {
    if (!this.showMsHistTab) {
      return;
    }
    if (this.msHistDisplayRows.length && !this.isMsHistStaleForLocation()) {
      return;
    }
    this.isLoadingMsHist = true;
    this.msHistChartsReady = false;
  }

  private loadMsHistDataForCurrentPosition(): void {
    if (!this.showMsHistTab) {
      return;
    }
    if (this.msHistDisplayRows.length && !this.isMsHistStaleForLocation()) {
      this.isLoadingMsHist = false;
      this.syncMsHistFromCacheFlag();
      this.updateMsHistCharts();
      return;
    }
    this.loadMsHistData(false);
  }

  loadMsHistData(force = false): void {
    if (!this.showMsHistTab) {
      this.msHistData = null;
      return;
    }
    const msQuery = { lat: this.lat, lon: this.lon, days: this.msHistDays };
    if (!force && this.msHistDisplayRows.length && !this.isMsHistStaleForLocation()) {
      this.isLoadingMsHist = false;
      this.syncMsHistFromCacheFlag();
      this.updateMsHistCharts();
      return;
    }
    if (!force) {
      const clientCached = this.historyCache.lookupMsHist(msQuery);
      if (clientCached) {
        this.isLoadingMsHist = false;
        this.msHistFromCache = true;
        this.applyMsHistDataResponse(clientCached, this.currentMsHistCacheKey());
        return;
      }
    }
    this.isLoadingMsHist = true;
    this.msHistChartsReady = false;
    this.msHistErrorKey = '';
    this.msHistErrorDetail = '';
    this.msHistFromCache = false;
    this.setMsHistPeriodPreview(this.msHistDays);
    this.logBackend('METEO_FRANCE.LOG_CAT_CLIM', 'METEO_FRANCE.LOG_SOURCE_METEOSWISS_SMN', 'loading');
    this.subs.add(
      this.apiService.getMeteoSwissHistoryNearby(this.lat, this.lon, this.msHistDays, undefined, force).subscribe({
        next: (data) => {
          this.isLoadingMsHist = false;
          this.historyCache.setMsHist(msQuery, data);
          this.msHistFromCache = !!data?.cached;
          this.applyMsHistDataResponse(data, this.currentMsHistCacheKey());
        },
        error: () => {
          this.isLoadingMsHist = false;
          this.msHistData = null;
          this.msHistChartsReady = false;
          this.msHistFromCache = false;
          this.msHistErrorKey = 'METEO_FRANCE.MS_HIST_LOAD_ERROR';
          this.msHistErrorDetail = '';
          this.logBackend('METEO_FRANCE.LOG_CAT_CLIM', 'METEO_FRANCE.LOG_SOURCE_METEOSWISS_SMN', 'error');
          setTimeout(() => this.updateMsHistCharts(), 0);
        }
      })
    );
  }

  private applyMsHistDataResponse(data: any, cacheKey: string): void {
    this.applyMsHistPeriodFromResponse(data);
    if (data?.error) {
      this.msHistData = null;
      this.msHistChartsReady = false;
      this.msHistErrorKey = 'METEO_FRANCE.MS_HIST_LOAD_ERROR';
      this.msHistErrorDetail = data.details || data.error || '';
      this.markMsHistLocationLoaded(cacheKey);
      this.logBackend(
        'METEO_FRANCE.LOG_CAT_CLIM',
        'METEO_FRANCE.LOG_SOURCE_METEOSWISS_SMN',
        'error',
        this.msHistErrorDetail
      );
      setTimeout(() => this.updateMsHistCharts(), 0);
      return;
    }
    this.msHistData = data;
    this.markMsHistLocationLoaded(cacheKey);
    const stationLabel = data?.station?.name || data?.station?.id || '';
    const rowCount = Array.isArray(data?.rows) ? data.rows.length : 0;
    this.logBackend(
      'METEO_FRANCE.LOG_CAT_CLIM',
      'METEO_FRANCE.LOG_SOURCE_METEOSWISS_SMN',
      'ok',
      stationLabel
        ? `${stationLabel} · ${rowCount} ${this.translate.instant('METEO_FRANCE.LOG_STEPS')}`
        : `${rowCount} ${this.translate.instant('METEO_FRANCE.LOG_STEPS')}`
    );
    setTimeout(() => this.updateMsHistCharts(), 0);
  }

  onClearMsHistHistoryCache(): void {
    if (this.isClearingMsHistHistoryCache) {
      return;
    }
    this.isClearingMsHistHistoryCache = true;
    this.historyCache.clearMsHist();
    this.subs.add(
      this.apiService.clearMeteoSwissHistoryCache().subscribe({
        next: () => {
          this.isClearingMsHistHistoryCache = false;
          this.msHistFromCache = false;
          this.loadMsHistData(true);
        },
        error: () => {
          this.isClearingMsHistHistoryCache = false;
          this.loadMsHistData(true);
        }
      })
    );
  }

  private setMsHistPeriodPreview(days: number): void {
    const now = new Date();
    this.msHistPeriodEnd = this.formatTemperatureDateTime(now);
    const start = new Date(now.getTime() - (days - 1) * 86_400_000);
    this.msHistPeriodStart = this.formatTemperatureDateTime(start);
    this.msHistRequestedDays = days;
  }

  private applyMsHistPeriodFromResponse(data: any): void {
    if (!data) {
      return;
    }
    if (data.periodStart) {
      this.msHistPeriodStart = this.formatClimPeriodIso(data.periodStart, true);
    }
    if (data.periodEnd) {
      this.msHistPeriodEnd = this.formatClimPeriodIso(data.periodEnd, true);
    }
    if (data.requestedDays != null) {
      this.msHistRequestedDays = Number(data.requestedDays);
    }
  }

  private getSortedMsHistRows(): any[] {
    const rows = this.msHistData?.rows;
    if (!Array.isArray(rows)) {
      return [];
    }
    return [...rows].sort((a, b) => this.msHistRowSortKey(a).localeCompare(this.msHistRowSortKey(b)));
  }

  private msHistRowSortKey(row: any): string {
    if (row?.epochSeconds != null) {
      return String(row.epochSeconds).padStart(12, '0');
    }
    return row?.reference_timestamp != null ? String(row.reference_timestamp).trim() : '';
  }

  private msHistRowDateLabel(row: any): string {
    if (row?.epochSeconds != null && Number.isFinite(Number(row.epochSeconds))) {
      return this.formatTemperatureDateTime(new Date(Number(row.epochSeconds) * 1000));
    }
    const raw = row?.reference_timestamp;
    if (raw == null) {
      return '—';
    }
    const trimmed = String(raw).trim();
    const match = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/.exec(trimmed);
    if (match) {
      const day = Number(match[1]);
      const month = Number(match[2]) - 1;
      const year = Number(match[3]);
      const hour = Number(match[4]);
      const minute = Number(match[5]);
      return this.formatTemperatureDateTime(new Date(Date.UTC(year, month, day, hour, minute, 0)));
    }
    return trimmed;
  }

  formatMsHistColumn(column: string): string {
    if (column === 'reference_timestamp') {
      return 'METEO_FRANCE.MS_HIST_COL_TIME';
    }
    return this.formatClimColumn(column);
  }

  formatMsHistCell(column: string, row: any): string {
    if (column === 'reference_timestamp') {
      return this.msHistRowDateLabel(row);
    }
    const value = row[column];
    if (value == null || value === '') {
      return '—';
    }
    if (column === 'T') {
      const temp = this.tempChartValue(value);
      return temp != null ? String(temp) : '—';
    }
    return String(value);
  }

  private updateMsHistCharts(): void {
    const rows = this.getSortedMsHistRows();
    if (!rows.length) {
      this.msHistChartsReady = false;
      this.msHistTempChartData = { labels: [], datasets: [] };
      this.msHistRainChartData = { labels: [], datasets: [] };
      this.msHistHumidityChartData = { labels: [], datasets: [] };
      this.msHistWindChartData = { labels: [], datasets: [] };
      return;
    }

    const labels = rows.map((row) => this.msHistRowDateLabel(row));
    const pointRadius = meteoChartCompactPointRadius(rows.length);
    const hasT = rows.some((r) => this.parseClimNumber(r.T) != null);
    const hasRr = rows.some((r) => this.parseClimNumber(r.RR) != null);
    const hasU = rows.some((r) => this.parseClimNumber(r.U) != null);
    const hasFf = rows.some((r) => this.parseClimNumber(r.FF) != null);

    const tempDatasets: ChartConfiguration<'line'>['data']['datasets'] = hasT ? [{
      label: this.formatClimColumnLabel('T'),
      data: rows.map((r) => this.tempChartValue(r.T)),
      borderColor: '#d52b1e',
      backgroundColor: 'rgba(213, 43, 30, 0.12)',
      tension: 0.25,
      pointRadius,
      spanGaps: true
    }] : [];

    this.msHistTempChartOptions = this.buildClimTempChartOptions();
    this.msHistRainChartOptions = this.buildClimRainChartOptions();
    this.msHistHumidityChartOptions = this.buildClimScalarChartOptions('%');
    this.msHistWindChartOptions = this.buildClimScalarChartOptions('m/s');
    this.msHistTempChartData = { labels, datasets: tempDatasets };
    this.msHistRainChartData = {
      labels,
      datasets: [{
        label: this.translate.instant('METEO_FRANCE.CLIM_COL_RR'),
        data: hasRr ? rows.map((r) => this.parseClimNumber(r.RR)) : [],
        backgroundColor: 'rgba(14, 165, 233, 0.55)',
        borderColor: '#0284c7',
        borderWidth: 1
      }]
    };
    this.msHistHumidityChartData = {
      labels,
      datasets: hasU ? [{
        label: this.formatClimColumnLabel('U'),
        data: rows.map((r) => this.parseClimNumber(r.U)),
        borderColor: '#7c3aed',
        backgroundColor: 'rgba(124, 58, 237, 0.12)',
        tension: 0.25,
        pointRadius,
        spanGaps: true
      }] : []
    };
    this.msHistWindChartData = {
      labels,
      datasets: hasFf ? [{
        label: this.formatClimColumnLabel('FF'),
        data: rows.map((r) => this.parseClimNumber(r.FF)),
        borderColor: '#059669',
        backgroundColor: 'rgba(5, 150, 105, 0.12)',
        tension: 0.25,
        pointRadius,
        spanGaps: true
      }] : []
    };
    this.msHistChartsReady = tempDatasets.length > 0 || hasRr || hasU || hasFf;
  }

  formatClimColumn(column: string): string {
    return `METEO_FRANCE.CLIM_COL_${column}`;
  }

  formatClimColumnLabel(column: string): string {
    const key = this.formatClimColumn(column);
    const translated = this.translate.instant(key);
    return translated !== key ? translated : column;
  }

  openStationHistoryModal(key: string): void {
    if (!this.climAvailable) {
      return;
    }
    const point = this.temperatureGridPoints.find((p) => this.temperaturePointKey(p) === key);
    if (!point?.stationId) {
      return;
    }
    if (this.isRadarMapNativeFullscreen()) {
      this.exitMapFullscreenIfActive();
    }
    this.stationHistoryPoint = point;
    this.stationHistoryModalVisible = true;
    this.stationHistoryFrequency = 'horaire';
    this.stationHistoryDays = 7;
    this.stationHistoryShowTable = false;
    this.stationHistoryChartsReady = false;
    this.loadStationHistoryData();
  }

  closeStationHistoryModal(): void {
    this.stationHistoryModalVisible = false;
    this.stationHistoryPoint = null;
    this.stationHistoryData = null;
    this.stationHistoryLoading = false;
    this.stationHistoryErrorKey = '';
    this.stationHistoryErrorDetail = '';
    this.stationHistoryPeriodStart = '';
    this.stationHistoryPeriodEnd = '';
    this.stationHistoryChartsReady = false;
    this.stationHistoryShowTable = false;
    this.resetStationHistoryCharts();
  }


  onStationHistoryFrequencyChange(): void {
    const options = this.stationHistoryPeriodOptions;
    const stillValid = options.some((o) => o.days === this.stationHistoryDays);
    if (!stillValid) {
      this.stationHistoryDays = this.stationHistoryFrequency === 'horaire' ? 7 : 30;
    }
    this.loadStationHistoryData();
  }

  onStationHistoryPeriodChange(): void {
    this.loadStationHistoryData();
  }

  loadStationHistoryData(forceRefresh = false): void {
    const point = this.stationHistoryPoint;
    if (!this.climAvailable || !point?.stationId || !this.stationHistoryModalVisible) {
      return;
    }
    const days = this.stationHistoryFrequency === 'horaire'
      ? Math.min(this.stationHistoryDays, 31)
      : this.stationHistoryDays;
    const climQuery = {
      lat: point.lat,
      lon: point.lon,
      days,
      frequency: this.stationHistoryFrequency,
      stationId: point.stationId
    };
    if (!forceRefresh) {
      const clientCached = this.historyCache.lookupClim(climQuery);
      if (clientCached) {
        this.stationHistoryLoading = false;
        this.stationHistoryErrorKey = '';
        this.stationHistoryErrorDetail = '';
        this.applyStationHistoryDataResponse(clientCached);
        return;
      }
    }
    this.stationHistoryLoading = true;
    this.stationHistoryErrorKey = '';
    this.stationHistoryErrorDetail = '';
    this.setStationHistoryPeriodPreview(days);
    this.subs.add(
      this.apiService.getMeteoFranceClimNearby(
        point.lat,
        point.lon,
        days,
        this.stationHistoryFrequency,
        undefined,
        point.stationId,
        forceRefresh
      ).subscribe({
        next: (data) => {
          this.stationHistoryLoading = false;
          this.historyCache.setClim(climQuery, data);
          this.applyStationHistoryDataResponse(data);
        },
        error: () => {
          this.stationHistoryLoading = false;
          this.stationHistoryData = null;
          this.stationHistoryChartsReady = false;
          this.resetStationHistoryCharts();
          this.stationHistoryErrorKey = 'METEO_FRANCE.CLIM_LOAD_ERROR';
          this.stationHistoryErrorDetail = '';
        }
      })
    );
  }

  private applyStationHistoryDataResponse(data: any): void {
    this.applyStationHistoryPeriodFromResponse(data);
    if (data?.error) {
      this.stationHistoryData = null;
      this.stationHistoryChartsReady = false;
      this.resetStationHistoryCharts();
      this.stationHistoryErrorKey = 'METEO_FRANCE.CLIM_LOAD_ERROR';
      this.stationHistoryErrorDetail = data.details || data.error || '';
      return;
    }
    this.stationHistoryData = data;
    setTimeout(() => this.updateStationHistoryCharts(), 0);
  }

  getSortedStationHistoryRows(): any[] {
    return [...this.stationHistoryDisplayRows].sort((a, b) =>
      this.climRowSortKey(a).localeCompare(this.climRowSortKey(b))
    );
  }

  private setStationHistoryPeriodPreview(days: number): void {
    const hourly = this.stationHistoryFrequency === 'horaire';
    const now = new Date();
    const end = new Date(now);
    if (!hourly) {
      end.setDate(end.getDate() - 1);
      end.setHours(12, 0, 0, 0);
    }
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    if (!hourly) {
      start.setHours(12, 0, 0, 0);
    }
    this.stationHistoryPeriodStart = this.formatTemperatureDateTime(start);
    this.stationHistoryPeriodEnd = this.formatTemperatureDateTime(end);
    this.stationHistoryRequestedDays = days;
  }

  private applyStationHistoryPeriodFromResponse(data: any): void {
    if (!data) {
      return;
    }
    const hourly = data.frequency === 'horaire';
    if (data.periodStart) {
      this.stationHistoryPeriodStart = this.formatClimPeriodIso(data.periodStart, hourly);
    }
    if (data.periodEnd) {
      this.stationHistoryPeriodEnd = this.formatClimPeriodIso(data.periodEnd, hourly);
    }
    if (data.requestedDays != null) {
      this.stationHistoryRequestedDays = Number(data.requestedDays);
    }
  }

  private buildClimTempChartOptions(): ChartOptions<'line'> {
    const unit = () => (this.temperatureUnit === 'fahrenheit' ? '°F' : '°C');
    return withMeteoChartZoom<'line'>({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: {
          callbacks: {
            title: (items: TooltipItem<'line'>[]) => {
              const label = items[0]?.label;
              return label != null ? String(label) : '';
            },
            label: (ctx: TooltipItem<'line'>) => {
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
            callback: (v: string | number) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })
          }
        }
      }
    });
  }

  private buildClimRainChartOptions(): ChartOptions<'bar'> {
    return withMeteoChartZoom<'bar'>({
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
    });
  }

  private buildClimScalarChartOptions(unit: string): ChartOptions<'line'> {
    return withMeteoChartZoom<'line'>({
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
              return `${ctx.dataset.label}: ${y.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12, maxRotation: 45, minRotation: 0 } },
        y: {
          title: { display: true, text: unit },
          ticks: {
            callback: (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })
          }
        }
      }
    });
  }

  private updateClimCharts(): void {
    const rows = this.getSortedClimRows();
    if (!rows.length) {
      this.climChartsReady = false;
      this.climTempChartData = { labels: [], datasets: [] };
      this.climRainChartData = { labels: [], datasets: [] };
      this.climHumidityChartData = { labels: [], datasets: [] };
      this.climWindChartData = { labels: [], datasets: [] };
      return;
    }

    const labels = rows.map((row) => this.climRowDateLabel(row));
    const pointRadius = meteoChartCompactPointRadius(rows.length);
    const tempColumns: Array<{ key: string; color: string; bg: string }> = [];
    if (rows.some((r) => this.parseClimNumber(r.T) != null)) {
      tempColumns.push({ key: 'T', color: '#2563eb', bg: 'rgba(37, 99, 235, 0.12)' });
    } else if (rows.some((r) => this.parseClimNumber(r.TAT) != null)) {
      tempColumns.push({ key: 'TAT', color: '#2563eb', bg: 'rgba(37, 99, 235, 0.12)' });
    }
    const tnKey = rows.some((r) => this.parseClimNumber(r.TN) != null) ? 'TN' : 'TNT';
    if (rows.some((r) => this.parseClimNumber(r[tnKey]) != null)) {
      tempColumns.push({ key: tnKey, color: '#2563eb', bg: 'rgba(37, 99, 235, 0.12)' });
    }
    if (rows.some((r) => this.parseClimNumber(r.TX) != null)) {
      tempColumns.push({ key: 'TX', color: '#dc2626', bg: 'rgba(220, 38, 38, 0.12)' });
    }
    if (rows.some((r) => this.parseClimNumber(r.TM) != null)) {
      tempColumns.push({ key: 'TM', color: '#ca8a04', bg: 'rgba(202, 138, 4, 0.12)' });
    }
    if (rows.some((r) => this.parseClimNumber(r.TROS) != null)) {
      tempColumns.push({ key: 'TROS', color: '#0891b2', bg: 'rgba(8, 145, 178, 0.12)' });
    }

    const tempDatasets: ChartConfiguration<'line'>['data']['datasets'] = tempColumns.map((col) => ({
      label: this.formatClimColumnLabel(col.key),
      data: rows.map((r) => this.tempChartValue(r[col.key])),
      borderColor: col.color,
      backgroundColor: col.bg,
      tension: 0.25,
      pointRadius,
      spanGaps: true
    }));

    const rainKey = rows.some((r) => this.parseClimNumber(r.RR) != null)
      ? 'RR'
      : rows.some((r) => this.parseClimNumber(r.RR1) != null) ? 'RR1' : null;
    const hasRain = rainKey != null;

    const humidityDataset = rows.some((r) => this.parseClimNumber(r.U) != null)
      ? [{
          label: this.formatClimColumnLabel('U'),
          data: rows.map((r) => this.parseClimNumber(r.U)),
          borderColor: '#7c3aed',
          backgroundColor: 'rgba(124, 58, 237, 0.12)',
          tension: 0.25,
          pointRadius,
          spanGaps: true
        }]
      : [];

    const windDatasets: ChartConfiguration<'line'>['data']['datasets'] = [];
    if (rows.some((r) => this.parseClimNumber(r.FF) != null)) {
      windDatasets.push({
        label: this.formatClimColumnLabel('FF'),
        data: rows.map((r) => this.parseClimNumber(r.FF)),
        borderColor: '#059669',
        backgroundColor: 'rgba(5, 150, 105, 0.12)',
        tension: 0.25,
        pointRadius,
        spanGaps: true
      });
    }
    if (rows.some((r) => this.parseClimNumber(r.FXI) != null)) {
      windDatasets.push({
        label: this.formatClimColumnLabel('FXI'),
        data: rows.map((r) => this.parseClimNumber(r.FXI)),
        borderColor: '#d97706',
        backgroundColor: 'rgba(217, 119, 6, 0.12)',
        tension: 0.25,
        pointRadius,
        spanGaps: true
      });
    }

    this.climTempChartOptions = this.buildClimTempChartOptions();
    this.climRainChartOptions = this.buildClimRainChartOptions();
    this.climHumidityChartOptions = this.buildClimScalarChartOptions('%');
    this.climWindChartOptions = this.buildClimScalarChartOptions('m/s');
    this.climTempChartData = { labels, datasets: tempDatasets };
    this.climRainChartData = {
      labels,
      datasets: hasRain ? [{
        label: this.formatClimColumnLabel(rainKey!),
        data: rows.map((r) => this.parseClimNumber(r[rainKey!])),
        backgroundColor: 'rgba(14, 165, 233, 0.55)',
        borderColor: '#0284c7',
        borderWidth: 1
      }] : []
    };
    this.climHumidityChartData = { labels, datasets: humidityDataset };
    this.climWindChartData = { labels, datasets: windDatasets };
    this.climChartsReady =
      tempDatasets.length > 0
      || hasRain
      || humidityDataset.length > 0
      || windDatasets.length > 0;
  }

  private resetStationHistoryCharts(): void {
    this.stationHistoryTempChartData = { labels: [], datasets: [] };
    this.stationHistoryHumidityChartData = { labels: [], datasets: [] };
    this.stationHistoryWindChartData = { labels: [], datasets: [] };
    this.stationHistoryRainChartData = { labels: [], datasets: [] };
    this.stationHistoryPressureChartData = { labels: [], datasets: [] };
  }


  private climRowEpochSeconds(row: any): number | null {
    const raw = row?.DATE ?? row?.AAAAMMJJ ?? row?.AAAAMMJJHH;
    if (raw == null) {
      return null;
    }
    const trimmed = String(raw).trim();
    if (/^\d{10}$/.test(trimmed)) {
      const year = Number(trimmed.slice(0, 4));
      const month = Number(trimmed.slice(4, 6)) - 1;
      const day = Number(trimmed.slice(6, 8));
      const hour = Number(trimmed.slice(8, 10));
      const date = new Date(year, month, day, hour, 0, 0);
      return Number.isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
    }
    if (/^\d{8}$/.test(trimmed)) {
      const year = Number(trimmed.slice(0, 4));
      const month = Number(trimmed.slice(4, 6)) - 1;
      const day = Number(trimmed.slice(6, 8));
      const date = new Date(year, month, day, 12, 0, 0);
      return Number.isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
    }
    return null;
  }

  private updateStationHistoryCharts(): void {
    const rows = this.getSortedStationHistoryRows();
    if (!rows.length) {
      this.stationHistoryChartsReady = false;
      this.resetStationHistoryCharts();
      return;
    }

    const labels = rows.map((row) => this.climRowDateLabel(row));
    const pointRadius = meteoChartCompactPointRadius(rows.length);
    const tempColumns: Array<{ key: string; color: string; bg: string }> = [];
    if (rows.some((r) => this.parseClimNumber(r.T) != null)) {
      tempColumns.push({ key: 'T', color: '#2563eb', bg: 'rgba(37, 99, 235, 0.12)' });
    } else if (rows.some((r) => this.parseClimNumber(r.TAT) != null)) {
      tempColumns.push({ key: 'TAT', color: '#2563eb', bg: 'rgba(37, 99, 235, 0.12)' });
    }
    const tnKey = rows.some((r) => this.parseClimNumber(r.TN) != null) ? 'TN' : 'TNT';
    if (rows.some((r) => this.parseClimNumber(r[tnKey]) != null)) {
      tempColumns.push({ key: tnKey, color: '#2563eb', bg: 'rgba(37, 99, 235, 0.12)' });
    }
    if (rows.some((r) => this.parseClimNumber(r.TX) != null)) {
      tempColumns.push({ key: 'TX', color: '#dc2626', bg: 'rgba(220, 38, 38, 0.12)' });
    }
    if (rows.some((r) => this.parseClimNumber(r.TM) != null)) {
      tempColumns.push({ key: 'TM', color: '#ca8a04', bg: 'rgba(202, 138, 4, 0.12)' });
    }
    if (rows.some((r) => this.parseClimNumber(r.TROS) != null)) {
      tempColumns.push({ key: 'TROS', color: '#0891b2', bg: 'rgba(8, 145, 178, 0.12)' });
    }

    const tempDatasets: ChartConfiguration<'line'>['data']['datasets'] = tempColumns.map((col) => ({
      label: this.formatClimColumnLabel(col.key),
      data: rows.map((r) => this.tempChartValue(r[col.key])),
      borderColor: col.color,
      backgroundColor: col.bg,
      tension: 0.25,
      pointRadius,
      spanGaps: true
    }));

    const rainKey = rows.some((r) => this.parseClimNumber(r.RR) != null)
      ? 'RR'
      : rows.some((r) => this.parseClimNumber(r.RR1) != null) ? 'RR1' : null;
    const hasRain = rainKey != null;

    const humidityDataset = rows.some((r) => this.parseClimNumber(r.U) != null)
      ? [{
          label: this.formatClimColumnLabel('U'),
          data: rows.map((r) => this.parseClimNumber(r.U)),
          borderColor: '#7c3aed',
          backgroundColor: 'rgba(124, 58, 237, 0.12)',
          tension: 0.25,
          pointRadius,
          spanGaps: true
        }]
      : [];

    const windDatasets: ChartConfiguration<'line'>['data']['datasets'] = [];
    if (rows.some((r) => this.parseClimNumber(r.FF) != null)) {
      windDatasets.push({
        label: this.formatClimColumnLabel('FF'),
        data: rows.map((r) => this.parseClimNumber(r.FF)),
        borderColor: '#059669',
        backgroundColor: 'rgba(5, 150, 105, 0.12)',
        tension: 0.25,
        pointRadius,
        spanGaps: true
      });
    }
    if (rows.some((r) => this.parseClimNumber(r.FXI) != null)) {
      windDatasets.push({
        label: this.formatClimColumnLabel('FXI'),
        data: rows.map((r) => this.parseClimNumber(r.FXI)),
        borderColor: '#d97706',
        backgroundColor: 'rgba(217, 119, 6, 0.12)',
        tension: 0.25,
        pointRadius,
        spanGaps: true
      });
    }

    const pressureDataset = rows.some((r) => this.parseClimNumber(r.PMER) != null)
      ? [{
          label: this.formatClimColumnLabel('PMER'),
          data: rows.map((r) => this.parseClimNumber(r.PMER)),
          borderColor: '#64748b',
          backgroundColor: 'rgba(100, 116, 139, 0.12)',
          tension: 0.25,
          pointRadius,
          spanGaps: true
        }]
      : [];

    this.stationHistoryTempChartOptions = this.buildClimTempChartOptions();
    this.stationHistoryHumidityChartOptions = this.buildClimScalarChartOptions('%');
    this.stationHistoryWindChartOptions = this.buildClimScalarChartOptions('m/s');
    this.stationHistoryRainChartOptions = this.buildClimRainChartOptions();
    this.stationHistoryPressureChartOptions = this.buildClimScalarChartOptions('hPa');
    this.stationHistoryTempChartData = { labels, datasets: tempDatasets };
    this.stationHistoryHumidityChartData = { labels, datasets: humidityDataset };
    this.stationHistoryWindChartData = { labels, datasets: windDatasets };
    this.stationHistoryRainChartData = {
      labels,
      datasets: hasRain ? [{
        label: this.formatClimColumnLabel(rainKey!),
        data: rows.map((r) => this.parseClimNumber(r[rainKey!])),
        backgroundColor: 'rgba(14, 165, 233, 0.55)',
        borderColor: '#0284c7',
        borderWidth: 1
      }] : []
    };
    this.stationHistoryPressureChartData = { labels, datasets: pressureDataset };
    this.stationHistoryChartsReady =
      tempDatasets.length > 0
      || humidityDataset.length > 0
      || windDatasets.length > 0
      || hasRain
      || pressureDataset.length > 0;
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
    const now = new Date();
    if (hourly) {
      this.climPeriodEnd = this.formatTemperatureDateTime(now);
      const start = new Date(now.getTime() - (days - 1) * 86_400_000);
      this.climPeriodStart = this.formatTemperatureDateTime(start);
    } else {
      const yesterday = new Date(now.getTime() - 86_400_000);
      yesterday.setHours(12, 0, 0, 0);
      const start = new Date(now.getTime() - days * 86_400_000);
      start.setHours(12, 0, 0, 0);
      this.climPeriodEnd = this.formatTemperatureDateTime(yesterday);
      this.climPeriodStart = this.formatTemperatureDateTime(start);
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

  private formatClimPeriodIso(iso: string, _hourly: boolean): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return iso;
    }
    return this.formatTemperatureDateTime(d);
  }

  formatClimDate(value: string | undefined): string {
    if (!value) {
      return '—';
    }
    const trimmed = value.trim();
    if (/^\d{8}$/.test(trimmed)) {
      const year = Number(trimmed.slice(0, 4));
      const month = Number(trimmed.slice(4, 6)) - 1;
      const day = Number(trimmed.slice(6, 8));
      return this.formatTemperatureDateTime(new Date(year, month, day, 12, 0, 0));
    }
    if (/^\d{10}$/.test(trimmed)) {
      const year = Number(trimmed.slice(0, 4));
      const month = Number(trimmed.slice(4, 6)) - 1;
      const day = Number(trimmed.slice(6, 8));
      const hour = Number(trimmed.slice(8, 10));
      return this.formatTemperatureDateTime(new Date(year, month, day, hour, 0, 0));
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return this.formatTemperatureDateTime(parsed);
    }
    return trimmed;
  }

  formatTemperatureDateTime(date: Date): string {
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
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
    const wasInSwitzerland = this.isLocationInSwitzerland();
    const hadMfSelectedPoint = this.selectedPointMfTempC != null;
    this.countryCode = normalized;
    this.syncWeatherSourcePreferences();
    const nowInFrance = this.isLocationInFrance();
    const nowInSwitzerland = this.isLocationInSwitzerland();
    if (!nowInFrance) {
      this.closePointTempTimeline();
    }
    if (!this.isMfTemperaturePointAllowed()) {
      this.clearMfTemperatureFromSelectedPoint();
      this.updateSelectedTemperatureLabel();
    }
    if (!this.isMsTemperaturePointAllowed()) {
      this.clearMsTemperatureFromSelectedPoint();
      this.updateSelectedTemperatureLabel();
    }
    const stationCoverageUnchanged = wasInFrance === nowInFrance && wasInSwitzerland === nowInSwitzerland;
    if (!stationCoverageUnchanged) {
      this.syncActiveTabForRegionalProvider();
    }
    if (!stationCoverageUnchanged && this.activeMainTab === 'forecast-aggregate') {
      this.loadAggregatedForecast(true);
    }
    if (stationCoverageUnchanged && !(nowInFrance && !hadMfSelectedPoint && this.isMfTemperaturePointAllowed())) {
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

  private clearMsTemperatureFromSelectedPoint(): void {
    this.selectedPointMsTempC = null;
    this.selectedPointMsStation = null;
    this.selectedPointMsStationDistKm = null;
    this.selectedPointMsObservedAt = null;
  }

  /** Drop station map/label data when the selected position leaves France or Switzerland coverage. */
  private refreshMfTemperatureAvailability(): void {
    if (!this.showTemperatureMap) {
      return;
    }
    if (!this.shouldShowStationLabels()) {
      this.closePointTempTimeline();
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
    if (src.includes('meteoswiss')) {
      sourceKey = 'METEO_FRANCE.LOG_SOURCE_METEOSWISS_SMN';
    } else if (src.includes('meteofrance') && src.includes('open-meteo')) {
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
    this.owmForecastRequestId++;
    this.omForecastRequestId++;
    this.msForecastRequestId++;
    this.aggregatedForecastRequestId++;
    this.abortAggregatedForecastStream();
    this.currentWeather = null;
    this.owmForecast = null;
    this.omForecast = null;
    this.msForecast = null;
    this.aggregatedForecast = null;
    this.aggregatedForecastSourceLists = {};
    this.aggregatedForecastSourceErrorsInternal = {};
    this.owmForecastErrorKey = '';
    this.omForecastErrorKey = '';
    this.msForecastErrorKey = '';
    this.aggregatedForecastErrorKey = '';
    this.isLoadingWeather = false;
    if (this.activeMainTab === 'forecast-owm') {
      this.isLoadingOwmForecast = true;
      this.isLoadingOmForecast = false;
      this.isLoadingMsForecast = false;
      this.isLoadingAggregatedForecast = false;
    } else if (this.activeMainTab === 'forecast-om') {
      this.isLoadingOmForecast = true;
      this.isLoadingOwmForecast = false;
      this.isLoadingMsForecast = false;
      this.isLoadingAggregatedForecast = false;
    } else if (this.activeMainTab === 'forecast-ms') {
      this.isLoadingMsForecast = true;
      this.isLoadingOwmForecast = false;
      this.isLoadingOmForecast = false;
      this.isLoadingAggregatedForecast = false;
    } else if (this.activeMainTab === 'forecast-aggregate') {
      this.isLoadingAggregatedForecast = true;
      this.isLoadingOwmForecast = false;
      this.isLoadingOmForecast = false;
      this.isLoadingMsForecast = false;
    } else {
      this.isLoadingOwmForecast = false;
      this.isLoadingOmForecast = false;
      this.isLoadingMsForecast = false;
      this.isLoadingAggregatedForecast = false;
    }
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
    if (code === 'CH') {
      return false;
    }
    if (code) {
      return false;
    }
    return this.isCoordinateInFranceMetropole(this.lat, this.lon);
  }

  private isLocationInSwitzerland(): boolean {
    const code = (this.countryCode || '').trim().toUpperCase();
    if (code === 'CH') {
      return true;
    }
    if (code === 'FR') {
      return false;
    }
    if (code) {
      return false;
    }
    // Before geocode: CH only outside MF overlap (border French towns stay MF).
    return this.isCoordinateInSwitzerland(this.lat, this.lon)
      && !this.isCoordinateInFranceMetropole(this.lat, this.lon);
  }

  private isCoordinateInSwitzerland(lat: number, lon: number): boolean {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return false;
    }
    const b = MeteoFranceComponent.CH_OBS_VIEWPORT_BOUNDS;
    return lat >= b.south
      && lat <= b.north
      && lon >= b.west
      && lon <= b.east;
  }

  /** MF obs bbox excludes Switzerland (overlap near the border, e.g. Geneva). */
  private isCoordinateInFranceForMfObs(lat: number, lon: number): boolean {
    return this.isCoordinateInFranceMetropole(lat, lon)
      && !this.isCoordinateInSwitzerland(lat, lon);
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

  private shouldFetchMfTemperatureAt(lat: number, lon: number): boolean {
    return this.showTemperatureMap && this.isMfTemperaturePointAllowedAt(lat, lon);
  }

  private shouldFetchMsTemperatureAt(lat: number, lon: number): boolean {
    return this.showTemperatureMap && this.isMsTemperaturePointAllowedAt(lat, lon);
  }

  /** MF point temperatures for France only (country from geocode, not nearest cross-border station). */
  private isMfTemperaturePointAllowedAt(_lat: number, _lon: number): boolean {
    return this.isLocationInFrance();
  }

  /** MeteoSwiss point temperatures for Switzerland only. */
  private isMsTemperaturePointAllowedAt(_lat: number, _lon: number): boolean {
    return this.isLocationInSwitzerland();
  }

  /** @deprecated use isMfTemperaturePointAllowedAt */
  private isMfTemperaturePointAllowed(): boolean {
    return this.isMfTemperaturePointAllowedAt(this.lat, this.lon);
  }

  private isMsTemperaturePointAllowed(): boolean {
    return this.isMsTemperaturePointAllowedAt(this.lat, this.lon);
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
    const nextCurrent = this.resolveWeatherPanelSourcePreference(
      this.currentWeatherSourceStorageKey(),
      defaultCurrent
    );
    const changed = nextCurrent !== this.currentWeatherSource;
    this.currentWeatherSource = nextCurrent;
    if (changed) {
      this.currentWeather = null;
      this.isLoadingWeather = false;
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
    this.refreshCurrentWeather();
    this.refreshActiveForecastTab();
  }

  private refreshCurrentWeather(): void {
    const requestId = ++this.weatherRequestId;
    this.isLoadingWeather = true;
    const currentLogSource = this.weatherPanelLogSourceKey(this.currentWeatherSource);
    this.logBackend('METEO_FRANCE.LOG_CAT_CURRENT', currentLogSource, 'loading');
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
  }

  private refreshActiveForecastTab(): void {
    if (this.activeMainTab === 'aromepi') {
      this.clampAromepiFrameIndex();
      this.setupAromepiWmsLayer(!!this.aromepiWmsLayer);
      this.loadAromepiCurrentValues();
      this.aromepiPointForecast = null;
      this.clearAromepiForecastCharts();
      this.scheduleAromepiForecastLoad();
      return;
    }
    this.reloadActiveMultiDayForecast();
  }

  loadOwmForecast(force = false): void {
    if (!force && this.owmForecast) {
      this.scheduleForecastChartsRefresh();
      return;
    }
    const requestId = ++this.owmForecastRequestId;
    this.isLoadingOwmForecast = true;
    this.owmForecastErrorKey = '';
    this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', 'METEO_FRANCE.LOG_SOURCE_OWM', 'loading');
    this.subs.add(
      this.apiService.getForecastByCoordinates(
        this.lat,
        this.lon,
        null,
        'openweathermap',
        this.forecastHorizonHours,
        this.forecastStepMinutes
      ).subscribe({
        next: (data) => {
          if (requestId !== this.owmForecastRequestId) {
            return;
          }
          this.isLoadingOwmForecast = false;
          this.owmForecast = data;
          if (data?.error) {
            this.owmForecastErrorKey = 'METEO_FRANCE.WEATHER_ERROR';
            this.clearOwmForecastCharts();
            this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', 'METEO_FRANCE.LOG_SOURCE_OWM', 'error');
            return;
          }
          this.owmForecastErrorKey = '';
          const count = Array.isArray(data?.list) ? data.list.length : 0;
          this.logBackend(
            'METEO_FRANCE.LOG_CAT_FORECAST',
            'METEO_FRANCE.LOG_SOURCE_OWM',
            'ok',
            count ? `${count} ${this.translate.instant('METEO_FRANCE.LOG_STEPS')}` : undefined
          );
          this.scheduleForecastChartsRefresh();
        },
        error: () => {
          if (requestId !== this.owmForecastRequestId) {
            return;
          }
          this.isLoadingOwmForecast = false;
          this.owmForecastErrorKey = 'METEO_FRANCE.WEATHER_ERROR';
          this.clearOwmForecastCharts();
          this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', 'METEO_FRANCE.LOG_SOURCE_OWM', 'error');
        }
      })
    );
  }

  loadOmForecast(force = false): void {
    if (!force && this.omForecast) {
      this.scheduleForecastChartsRefresh();
      return;
    }
    const requestId = ++this.omForecastRequestId;
    this.isLoadingOmForecast = true;
    this.omForecastErrorKey = '';
    this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', 'METEO_FRANCE.LOG_SOURCE_OPEN_METEO', 'loading');
    this.subs.add(
      this.apiService.getForecastByCoordinates(
        this.lat,
        this.lon,
        null,
        'open-meteo',
        this.forecastHorizonHours,
        this.forecastStepMinutes
      ).subscribe({
        next: (data) => {
          if (requestId !== this.omForecastRequestId) {
            return;
          }
          this.isLoadingOmForecast = false;
          this.omForecast = data;
          if (data?.error) {
            this.omForecastErrorKey = this.resolveOpenMeteoForecastErrorKey(data.error);
            this.clearOmForecastCharts();
            this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', 'METEO_FRANCE.LOG_SOURCE_OPEN_METEO', 'error');
            return;
          }
          if (!Array.isArray(data?.list) || data.list.length === 0) {
            this.omForecastErrorKey = 'METEO_FRANCE.FORECAST_OM_EMPTY';
            this.clearOmForecastCharts();
            this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', 'METEO_FRANCE.LOG_SOURCE_OPEN_METEO', 'error');
            return;
          }
          this.omForecastErrorKey = '';
          const count = Array.isArray(data?.list) ? data.list.length : 0;
          this.logBackend(
            'METEO_FRANCE.LOG_CAT_FORECAST',
            'METEO_FRANCE.LOG_SOURCE_OPEN_METEO',
            'ok',
            count ? `${count} ${this.translate.instant('METEO_FRANCE.LOG_STEPS')}` : undefined
          );
          this.scheduleForecastChartsRefresh();
        },
        error: () => {
          if (requestId !== this.omForecastRequestId) {
            return;
          }
          this.isLoadingOmForecast = false;
          this.omForecastErrorKey = 'METEO_FRANCE.FORECAST_OM_ERROR';
          this.clearOmForecastCharts();
          this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', 'METEO_FRANCE.LOG_SOURCE_OPEN_METEO', 'error');
        }
      })
    );
  }

  loadMsForecast(force = false, resetLoadingRetry = force): void {
    if (resetLoadingRetry) {
      this.clearMsForecastLoadingRetry();
      this.msForecastLoadingRetryCount = 0;
    }
    if (!force && this.msForecast) {
      this.scheduleForecastChartsRefresh();
      return;
    }
    const requestId = ++this.msForecastRequestId;
    this.isLoadingMsForecast = true;
    if (!this.msForecastCacheLoading) {
      this.msForecastErrorKey = '';
      this.msForecastErrorDetail = '';
      this.clearMsForecastCharts();
    }
    this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', 'METEO_FRANCE.LOG_SOURCE_METEOSWISS', 'loading');
    this.subs.add(
      this.apiService.getForecastByCoordinates(
        this.lat,
        this.lon,
        null,
        'meteoswiss',
        this.forecastHorizonHours,
        this.forecastStepMinutes
      ).subscribe({
        next: (data) => {
          if (requestId !== this.msForecastRequestId) {
            return;
          }
          this.isLoadingMsForecast = false;
          this.msForecast = data;
          if (data?.error) {
            const errorKey = this.resolveMeteoSwissForecastErrorKey(data.error);
            this.clearMsForecastCharts();
            this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', 'METEO_FRANCE.LOG_SOURCE_METEOSWISS', 'error', String(data.error));
            if (errorKey === 'METEO_FRANCE.FORECAST_MS_LOADING') {
              this.msForecastCacheLoading = true;
              this.msForecastErrorKey = '';
              this.startMsForecastCacheWatch();
              return;
            }
            this.stopMsForecastCacheWatch();
            this.msForecastCacheLoading = false;
            this.msForecastErrorDetail = String(data.error);
            this.msForecastErrorKey = errorKey === 'METEO_FRANCE.FORECAST_MS_ERROR'
              ? 'METEO_FRANCE.FORECAST_MS_LOADING_FAILED'
              : errorKey;
            return;
          }
          this.stopMsForecastCacheWatch();
          this.msForecastCacheLoading = false;
          this.clearMsForecastLoadingRetry();
          this.msForecastLoadingRetryCount = 0;
          if (!Array.isArray(data?.list) || data.list.length === 0) {
            this.msForecastErrorKey = 'METEO_FRANCE.FORECAST_MS_EMPTY';
            this.clearMsForecastCharts();
            this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', 'METEO_FRANCE.LOG_SOURCE_METEOSWISS', 'error');
            return;
          }
          this.msForecastErrorKey = '';
          this.msForecastErrorDetail = '';
          const count = data.list.length;
          this.logBackend(
            'METEO_FRANCE.LOG_CAT_FORECAST',
            'METEO_FRANCE.LOG_SOURCE_METEOSWISS',
            'ok',
            count ? `${count} ${this.translate.instant('METEO_FRANCE.LOG_STEPS')}` : undefined
          );
          this.scheduleForecastChartsRefresh();
        },
        error: () => {
          if (requestId !== this.msForecastRequestId) {
            return;
          }
          this.isLoadingMsForecast = false;
          this.stopMsForecastCacheWatch();
          this.msForecastCacheLoading = false;
          this.msForecastErrorKey = 'METEO_FRANCE.FORECAST_MS_ERROR';
          this.clearMsForecastCharts();
          this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', 'METEO_FRANCE.LOG_SOURCE_METEOSWISS', 'error');
        }
      })
    );
  }

  private resolveMeteoSwissForecastErrorKey(error: unknown): string {
    const message = String(error ?? '').toLowerCase();
    if (message.includes('outside') || message.includes('coverage') || message.includes('switzerland')) {
      return 'METEO_FRANCE.FORECAST_MS_OUT_OF_COVERAGE';
    }
    if (message.includes('loading')) {
      return 'METEO_FRANCE.FORECAST_MS_LOADING';
    }
    if (message.includes('empty')) {
      return 'METEO_FRANCE.FORECAST_MS_EMPTY';
    }
    return 'METEO_FRANCE.FORECAST_MS_ERROR';
  }

  private startMsForecastCacheWatch(): void {
    if (this.msForecastCachePollTimer) {
      return;
    }
    this.msForecastCachePollCount = 0;
    this.pollMsForecastCacheStatus();
  }

  private pollMsForecastCacheStatus(): void {
    if (this.componentDestroyed || this.activeMainTab !== 'forecast-ms') {
      this.stopMsForecastCacheWatch();
      return;
    }
    this.msForecastCachePollCount++;
    if (this.msForecastCachePollCount > MeteoFranceComponent.MS_FORECAST_CACHE_POLL_MAX) {
      this.msForecastCacheLoading = false;
      this.msForecastErrorKey = 'METEO_FRANCE.FORECAST_MS_LOADING';
      this.stopMsForecastCacheWatch();
      return;
    }
    this.subs.add(
      this.apiService.getMeteoSwissStatus().subscribe({
        next: (status) => this.handleMsForecastCacheStatus(status),
        error: () => this.scheduleMsForecastCachePoll()
      })
    );
  }

  private handleMsForecastCacheStatus(status: any): void {
    if (status?.ready) {
      this.stopMsForecastCacheWatch();
      this.msForecastCacheLoading = false;
      this.msForecastErrorKey = '';
      this.loadMsForecast(true, true);
      return;
    }
    if (!status?.loading && status?.lastError) {
      this.stopMsForecastCacheWatch();
      this.msForecastCacheLoading = false;
      this.msForecastErrorDetail = String(status.lastError);
      this.msForecastErrorKey = 'METEO_FRANCE.FORECAST_MS_LOADING_FAILED';
      return;
    }
    this.scheduleMsForecastCachePoll();
  }

  private scheduleMsForecastCachePoll(): void {
    this.clearMsForecastCachePollTimer();
    this.msForecastCachePollTimer = setTimeout(() => {
      this.msForecastCachePollTimer = null;
      this.pollMsForecastCacheStatus();
    }, MeteoFranceComponent.MS_FORECAST_CACHE_POLL_MS);
  }

  private stopMsForecastCacheWatch(): void {
    this.clearMsForecastCachePollTimer();
    this.msForecastCachePollCount = 0;
  }

  private clearMsForecastCacheWatch(): void {
    this.stopMsForecastCacheWatch();
    this.msForecastCacheLoading = false;
  }

  private clearMsForecastCachePollTimer(): void {
    if (this.msForecastCachePollTimer) {
      clearTimeout(this.msForecastCachePollTimer);
      this.msForecastCachePollTimer = null;
    }
  }

  private scheduleMsForecastLoadingRetry(): void {
    if (this.componentDestroyed || this.msForecastErrorKey !== 'METEO_FRANCE.FORECAST_MS_LOADING') {
      return;
    }
    if (this.msForecastLoadingRetryCount >= MeteoFranceComponent.MS_FORECAST_LOADING_MAX_RETRIES) {
      return;
    }
    this.clearMsForecastLoadingRetry();
    this.msForecastLoadingRetryCount++;
    this.msForecastLoadingRetryTimer = setTimeout(() => {
      this.msForecastLoadingRetryTimer = null;
      if (this.componentDestroyed) {
        return;
      }
      this.loadMsForecast(true, false);
    }, MeteoFranceComponent.MS_FORECAST_LOADING_RETRY_MS);
  }

  private clearMsForecastLoadingRetry(): void {
    if (this.msForecastLoadingRetryTimer) {
      clearTimeout(this.msForecastLoadingRetryTimer);
      this.msForecastLoadingRetryTimer = null;
    }
  }

  private resolveOpenMeteoForecastErrorKey(error: unknown): string {
    const message = String(error ?? '').toLowerCase();
    if (message.includes('empty')) {
      return 'METEO_FRANCE.FORECAST_OM_EMPTY';
    }
    if (message.includes('api key') || message.includes('openweathermap')) {
      return 'METEO_FRANCE.FORECAST_OM_ERROR';
    }
    return 'METEO_FRANCE.FORECAST_OM_ERROR';
  }

  private abortAggregatedForecastStream(): void {
    this.aggregatedForecastStreamAbort?.abort();
    this.aggregatedForecastStreamAbort = null;
  }

  loadAggregatedForecast(force = false): void {
    if (!force && this.aggregatedForecast) {
      this.scheduleForecastChartsRefresh();
      return;
    }
    const requestId = ++this.aggregatedForecastRequestId;
    const useMeteoSwiss = this.isLocationInSwitzerland();
    this.isLoadingAggregatedForecast = true;
    this.aggregatedForecastErrorKey = '';
    this.aggregatedForecast = null;
    this.aggregatedForecastSourceLists = {};
    this.aggregatedForecastSourceErrorsInternal = {};
    this.clearAggregateForecastCharts();
    this.abortAggregatedForecastStream();
    this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', 'METEO_FRANCE.LOG_SOURCE_AGGREGATE', 'loading');

    let streamComplete = false;
    let regionalComplete = !useMeteoSwiss;

    const applyAggregateSourceEvent = (source: string, list: any[] | null | undefined, error?: string): void => {
      if (requestId !== this.aggregatedForecastRequestId) {
        return;
      }
      if (error || !Array.isArray(list) || list.length === 0) {
        this.aggregatedForecastSourceErrorsInternal[source] = error ?? 'no forecast steps';
      } else {
        this.aggregatedForecastSourceLists[source as keyof typeof this.aggregatedForecastSourceLists] = list;
      }
      this.rebuildAggregatedForecastFromSourceLists();
      if (this.aggregatedForecastSteps.length) {
        this.isLoadingAggregatedForecast = false;
        this.aggregatedForecastErrorKey = '';
        this.scheduleForecastChartsRefresh();
      }
    };

    const finalizeAggregateLoad = (): void => {
      if (requestId !== this.aggregatedForecastRequestId || !streamComplete || !regionalComplete) {
        return;
      }
      this.isLoadingAggregatedForecast = false;
      if (!this.aggregatedForecastSteps.length) {
        this.aggregatedForecastErrorKey = 'METEO_FRANCE.AGG_FORECAST_EMPTY';
        this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', 'METEO_FRANCE.LOG_SOURCE_AGGREGATE', 'error');
        return;
      }
      const count = this.aggregatedForecastSteps.length;
      this.logBackend(
        'METEO_FRANCE.LOG_CAT_FORECAST',
        'METEO_FRANCE.LOG_SOURCE_AGGREGATE',
        'ok',
        count ? `${count} ${this.translate.instant('METEO_FRANCE.LOG_STEPS')}` : undefined
      );
    };

    if (useMeteoSwiss) {
      this.subs.add(
        this.apiService.getForecastByCoordinates(
          this.lat,
          this.lon,
          null,
          'meteoswiss',
          this.forecastHorizonHours,
          this.forecastStepMinutes
        ).subscribe({
          next: (data) => {
            if (requestId !== this.aggregatedForecastRequestId) {
              return;
            }
            applyAggregateSourceEvent('meteoswiss', data?.list, data?.error);
            regionalComplete = true;
            finalizeAggregateLoad();
          },
          error: () => {
            if (requestId !== this.aggregatedForecastRequestId) {
              return;
            }
            applyAggregateSourceEvent('meteoswiss', null, 'meteoswiss forecast error');
            regionalComplete = true;
            finalizeAggregateLoad();
          }
        })
      );
    }

    const abort = new AbortController();
    this.aggregatedForecastStreamAbort = abort;
    this.subs.add(
      this.apiService.streamForecastSources(
        this.lat,
        this.lon,
        this.forecastHorizonHours,
        this.forecastStepMinutes,
        abort.signal
      ).subscribe({
        next: (event) => {
          if (requestId !== this.aggregatedForecastRequestId) {
            return;
          }
          if (useMeteoSwiss && event.source === 'meteofrance') {
            return;
          }
          applyAggregateSourceEvent(event.source, event.list, event.error);
        },
        complete: () => {
          if (requestId !== this.aggregatedForecastRequestId) {
            return;
          }
          streamComplete = true;
          finalizeAggregateLoad();
        },
        error: () => {
          if (requestId !== this.aggregatedForecastRequestId || abort.signal.aborted) {
            return;
          }
          streamComplete = true;
          if (!this.aggregatedForecastSteps.length) {
            this.isLoadingAggregatedForecast = false;
            this.aggregatedForecastErrorKey = 'METEO_FRANCE.AGG_FORECAST_ERROR';
            this.clearAggregateForecastCharts();
            this.logBackend('METEO_FRANCE.LOG_CAT_FORECAST', 'METEO_FRANCE.LOG_SOURCE_AGGREGATE', 'error');
            return;
          }
          finalizeAggregateLoad();
        }
      })
    );
  }

  trackAggregateStep(_index: number, step: { dt?: number }): number {
    return step?.dt ?? _index;
  }

  aggregateSourceValue(step: any, source: string, param: string): string {
    const raw = step?.[source]?.[param];
    if (raw === null || raw === undefined) {
      return '—';
    }
    if (param === 'pop') {
      return `${Math.round(Number(raw) * 100)}%`;
    }
    if (param === 'humidityPct') {
      return `${Math.round(Number(raw))}%`;
    }
    if (param === 'precipMm') {
      return this.formatPrecipMm(raw);
    }
    if (param === 'windSpeedMs') {
      return this.formatWindSpeedMs(raw);
    }
    return this.formatTemperature(Number(raw));
  }

  aggregateMeanValue(step: any, param: string): string {
    const stats = step?.aggregate?.[param];
    if (!stats || stats.mean === null || stats.mean === undefined) {
      return '—';
    }
    if (param === 'pop') {
      return `${Math.round(Number(stats.mean) * 100)}%`;
    }
    if (param === 'humidityPct') {
      return `${Math.round(Number(stats.mean))}%`;
    }
    if (param === 'precipMm') {
      return this.formatPrecipMm(stats.mean);
    }
    if (param === 'windSpeedMs') {
      return this.formatWindSpeedMs(stats.mean);
    }
    return this.formatTemperature(Number(stats.mean));
  }

  formatWindSpeedMs(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return '—';
    }
    const rounded = Math.round(Number(value) * 100) / 100;
    return `${rounded} m/s`;
  }

  formatPrecipMm(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return '—';
    }
    const rounded = Math.round(Number(value) * 100) / 100;
    return `${rounded} mm`;
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
    if (this.stationHistoryDisplayRows.length) {
      this.updateStationHistoryCharts();
    }
    this.scheduleForecastChartsRefresh();
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
    return this.formatTemperatureDateTime(new Date(ts * 1000));
  }

  trackForecastChartBlock(_index: number, block: ForecastChartBlock): string {
    return block.param;
  }

  private forecastChartRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleForecastChartsRefresh(): void {
    if (this.forecastChartRefreshTimer != null) {
      clearTimeout(this.forecastChartRefreshTimer);
    }
    this.forecastChartRefreshTimer = setTimeout(() => {
      this.forecastChartRefreshTimer = null;
      if (this.componentDestroyed) {
        return;
      }
      this.refreshForecastCharts();
    }, 0);
  }

  private refreshForecastCharts(): void {
    this.updateOwmForecastCharts();
    this.updateOmForecastCharts();
    this.updateMsForecastCharts();
    this.updateAggregateForecastCharts();
    this.updateAromepiForecastCharts();
  }

  private clearForecastCharts(): void {
    this.clearOwmForecastCharts();
    this.clearOmForecastCharts();
    this.clearMsForecastCharts();
    this.clearAggregateForecastCharts();
    this.clearAromepiForecastCharts();
  }

  private clearOwmForecastCharts(): void {
    this.owmForecastChartBlocks = [];
    this.owmForecastChartsReady = false;
  }

  private clearOmForecastCharts(): void {
    this.omForecastChartBlocks = [];
    this.omForecastChartsReady = false;
  }

  private clearMsForecastCharts(): void {
    this.msForecastChartBlocks = [];
    this.msForecastChartsReady = false;
  }

  private clearAggregateForecastCharts(): void {
    this.aggregateForecastChartBlocks = [];
    this.aggregateForecastChartsReady = false;
  }

  private clearAromepiForecastCharts(): void {
    this.aromepiForecastChartBlocks = [];
    this.aromepiForecastChartsReady = false;
  }

  private updateAromepiForecastCharts(): void {
    this.aromepiForecastChartBlocks = this.buildAromepiForecastChartBlocks(this.aromepiForecastSteps);
    this.aromepiForecastChartsReady = this.aromepiForecastChartBlocks.length > 0;
  }

  private updateOwmForecastCharts(): void {
    this.owmForecastChartBlocks = this.buildSingleSourceForecastChartBlocks(
      this.owmDisplayForecastList,
      'OWM',
      '#e67e22'
    );
    this.owmForecastChartsReady = this.owmForecastChartBlocks.length > 0;
  }

  private updateOmForecastCharts(): void {
    this.omForecastChartBlocks = this.buildSingleSourceForecastChartBlocks(
      this.omDisplayForecastList,
      'Open-Meteo',
      '#3498db'
    );
    this.omForecastChartsReady = this.omForecastChartBlocks.length > 0;
  }

  private updateMsForecastCharts(): void {
    this.msForecastChartBlocks = this.buildSingleSourceForecastChartBlocks(
      this.msDisplayForecastList,
      'MeteoSwiss',
      '#d52b1e'
    );
    this.msForecastChartsReady = this.msForecastChartBlocks.length > 0;
  }

  private updateAggregateForecastCharts(): void {
    this.aggregateForecastChartBlocks = this.buildAggregateForecastChartBlocks(this.aggregatedForecastSteps);
    this.aggregateForecastChartsReady = this.aggregateForecastChartBlocks.length > 0;
  }

  private buildAromepiForecastChartBlocks(steps: any[]): ForecastChartBlock[] {
    const layers: string[] = this.aromepiPointForecast?.layers ?? [];
    if (!steps.length || !layers.length) {
      return [];
    }
    const labels = steps.map((step) => this.formatAromepiChartLabel(step?.time));
    const pointRadius = meteoChartCompactPointRadius(steps.length);
    const color = '#2ecc71';
    const blocks: ForecastChartBlock[] = [];

    for (const param of this.selectedMultiDayForecastNumericParams) {
      const layer = this.findAromepiLayerForParam(layers, param);
      if (!layer) {
        continue;
      }
      const values = steps.map((step) => this.extractAromepiChartValue(layer, step?.values?.[layer], param));
      if (!values.some((v) => v != null)) {
        continue;
      }
      const chartType = this.resolveForecastChartType(param);
      const opt = this.multiDayForecastParamOptions.find((o) => o.id === param);
      const layerLabel = this.aromepiLayerLabel({ name: layer, title: layer });
      blocks.push({
        param,
        labelKey: opt?.labelKey ?? 'METEO_FRANCE.AGG_COL_TEMP',
        chartType,
        data: {
          labels,
          datasets: [{
            label: `MF · ${layerLabel}`,
            data: values,
            borderColor: color,
            backgroundColor: this.forecastChartBackgroundColor(chartType, color),
            fill: this.forecastChartFill(chartType),
            tension: 0.2,
            spanGaps: true,
            pointRadius
          }]
        },
        options: this.buildForecastChartOptions(chartType, param)
      });
    }
    return blocks;
  }

  private findAromepiLayerForParam(
    layers: string[],
    param: MultiDayForecastDisplayParam
  ): string | null {
    const upperLayers = layers.map((layer) => ({ layer, upper: layer.toUpperCase() }));
    const matches = (predicate: (upper: string) => boolean): string[] =>
      upperLayers.filter((entry) => predicate(entry.upper)).map((entry) => entry.layer);

    let candidates: string[] = [];
    switch (param) {
      case 'temp':
        candidates = matches((u) => u.includes('TEMPERATURE') && !u.includes('DEW') && !u.includes('WETB'));
        break;
      case 'humidity':
        candidates = matches((u) => u.includes('HUMIDITY') || u.includes('RELATIVE_HUMIDITY'));
        break;
      case 'wind':
        candidates = matches((u) =>
          u.includes('WIND_SPEED') || (u.includes('WIND') && !u.includes('GUST') && !u.includes('DIRECTION')));
        break;
      case 'precip':
        candidates = matches((u) =>
          u.includes('PRECIP') || u.includes('NEIGE') || u.includes('GRAUPEL') || u.includes('GRELE'));
        break;
      case 'pop':
        candidates = matches((u) => u.includes('PROB') || u.includes('_POP') || u.includes('PP_'));
        break;
      default:
        return null;
    }
    if (!candidates.length) {
      return null;
    }
    const rank = (name: string): number => {
      const u = name.toUpperCase();
      if (u.includes('GROUND_OR_WATER') || u.includes('GROUND') || u.includes('2M') || u.includes('SURFACE')) {
        return 0;
      }
      if (u.includes('SPECIFIC_HEIGHT')) {
        return 1;
      }
      return 2;
    };
    candidates.sort((a, b) => rank(a) - rank(b));
    return candidates[0];
  }

  private extractAromepiChartValue(
    layerName: string,
    raw: unknown,
    param: MultiDayForecastDisplayParam
  ): number | null {
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      return null;
    }
    if (param === 'temp' || (layerName.toUpperCase().includes('TEMPERATURE') && !layerName.toUpperCase().includes('DEW'))) {
      return this.celsiusToDisplay(num);
    }
    return num;
  }

  private formatAromepiChartLabel(iso: string | null | undefined): string {
    if (!iso) {
      return '';
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return iso;
    }
    return this.formatTemperatureDateTime(d);
  }

  private buildSingleSourceForecastChartBlocks(
    items: any[],
    datasetLabel: string,
    color: string
  ): ForecastChartBlock[] {
    if (!items.length) {
      return [];
    }
    const labels = items.map((item) => this.formatForecastChartLabel(item.dt));
    const pointRadius = meteoChartCompactPointRadius(items.length);
    const blocks: ForecastChartBlock[] = [];

    for (const param of this.selectedMultiDayForecastNumericParams) {
      const values = items.map((item) => this.extractMultiDayChartValue(item, param));
      if (!values.some((v) => v != null)) {
        continue;
      }
      const chartType = this.resolveForecastChartType(param);
      const opt = this.multiDayForecastParamOptions.find((o) => o.id === param);
      blocks.push({
        param,
        labelKey: opt?.labelKey ?? 'METEO_FRANCE.AGG_COL_TEMP',
        chartType,
        data: {
          labels,
          datasets: [{
            label: datasetLabel,
            data: values,
            borderColor: color,
            backgroundColor: this.forecastChartBackgroundColor(chartType, color),
            fill: this.forecastChartFill(chartType),
            tension: 0.2,
            spanGaps: true,
            pointRadius
          }]
        },
        options: this.buildForecastChartOptions(chartType, param)
      });
    }
    return blocks;
  }

  private buildAggregateForecastChartBlocks(steps: any[]): ForecastChartBlock[] {
    if (!steps.length) {
      return [];
    }
    const labels = steps.map((step) => this.formatForecastChartLabel(step.dt));
    const pointRadius = meteoChartCompactPointRadius(steps.length);
    const regionalKey = this.aggregateRegionalSourceKey;
    const regionalLabel = this.aggregateRegionalSourceShortLabel;
    const sourceDefs: Array<{ key: string; label: string; color: string; dashed?: boolean }> = [
      { key: 'openweathermap', label: 'OWM', color: '#e67e22' },
      { key: 'open-meteo', label: 'Open-Meteo', color: '#3498db' },
      { key: regionalKey, label: regionalLabel, color: '#2ecc71' },
      { key: 'mean', label: this.translate.instant('METEO_FRANCE.AGG_COL_MEAN'), color: '#9b59b6', dashed: true }
    ];
    const blocks: ForecastChartBlock[] = [];

    for (const param of this.selectedMultiDayForecastNumericParams) {
      const chartType = this.resolveForecastChartType(param);
      const datasets: ChartConfiguration<'line' | 'bar'>['data']['datasets'] = [];
      for (const source of sourceDefs) {
        const values = steps.map((step) => this.extractAggregateChartValue(step, source.key, param));
        if (!values.some((v) => v != null)) {
          continue;
        }
        datasets.push({
          label: source.label,
          data: values,
          borderColor: source.color,
          backgroundColor: this.forecastChartBackgroundColor(chartType, source.color),
          fill: this.forecastChartFill(chartType, source.dashed),
          tension: 0.2,
          spanGaps: true,
          pointRadius,
          borderDash: source.dashed && chartType === 'line' ? [6, 4] : undefined,
          borderWidth: source.dashed ? 2 : 1.5
        });
      }
      if (!datasets.length) {
        continue;
      }
      const opt = this.multiDayForecastParamOptions.find((o) => o.id === param);
      blocks.push({
        param,
        labelKey: opt?.labelKey ?? 'METEO_FRANCE.AGG_COL_TEMP',
        chartType,
        data: { labels, datasets },
        options: this.buildForecastChartOptions(chartType, param)
      });
    }
    return blocks;
  }

  private resolveForecastChartType(param: MultiDayForecastDisplayParam): ForecastChartKind {
    if (this.forecastChartStyle === 'line') {
      return 'line';
    }
    if (this.forecastChartStyle === 'bar') {
      return 'bar';
    }
    return param === 'precip' ? 'bar' : 'line';
  }

  private forecastChartBackgroundColor(chartType: ForecastChartKind, color: string): string {
    return chartType === 'bar'
      ? this.hexToRgba(color, 0.55)
      : this.hexToRgba(color, 0.12);
  }

  private forecastChartFill(chartType: ForecastChartKind, dashed = false): boolean {
    return chartType === 'line' && !dashed;
  }

  private buildForecastChartOptions(
    chartType: ForecastChartKind,
    param: MultiDayForecastDisplayParam
  ): ChartOptions<'line' | 'bar'> {
    const yUnit = this.forecastChartYUnit(param);
    const percentParam = param === 'humidity' || param === 'pop';
    const decimals = param === 'wind' ? 2 : 1;
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: {
          callbacks: {
            title: (items: TooltipItem<'line' | 'bar'>[]) => {
              const label = items[0]?.label;
              return label != null ? String(label) : '';
            },
            label: (ctx: TooltipItem<'line' | 'bar'>) => {
              const y = ctx.parsed.y;
              if (y == null || Number.isNaN(y)) {
                return `${ctx.dataset.label}: —`;
              }
              const formatted = y.toLocaleString(undefined, { maximumFractionDigits: decimals });
              return yUnit ? `${ctx.dataset.label}: ${formatted} ${yUnit}` : `${ctx.dataset.label}: ${formatted}`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 14, maxRotation: 45, minRotation: 0 } },
        y: {
          beginAtZero: chartType === 'bar' || percentParam,
          max: percentParam ? 100 : undefined,
          title: { display: !!yUnit, text: yUnit },
          ticks: {
            callback: (v: string | number) => Number(v).toLocaleString(undefined, { maximumFractionDigits: decimals })
          }
        }
      },
      elements: chartType === 'line'
        ? { line: { spanGaps: true, tension: 0.2 } }
        : undefined
    };
    return (chartType === 'bar'
      ? withMeteoChartZoom<'bar'>(options as ChartOptions<'bar'>)
      : withMeteoChartZoom<'line'>(options as ChartOptions<'line'>)) as ChartOptions<'line' | 'bar'>;
  }


  private forecastChartYUnit(param: MultiDayForecastDisplayParam): string {
    switch (param) {
      case 'temp':
        return this.temperatureUnit === 'fahrenheit' ? '°F' : '°C';
      case 'humidity':
      case 'pop':
        return '%';
      case 'wind':
        return 'm/s';
      case 'precip':
        return 'mm';
      default:
        return '';
    }
  }

  private formatForecastChartLabel(ts: number | null | undefined): string {
    if (ts == null || !Number.isFinite(Number(ts))) {
      return '';
    }
    return this.formatTemperatureDateTime(new Date(Number(ts) * 1000));
  }

  private extractMultiDayChartValue(item: any, param: MultiDayForecastDisplayParam): number | null {
    if (!item) {
      return null;
    }
    switch (param) {
      case 'temp':
        return item.main?.temp != null ? this.celsiusToDisplay(Number(item.main.temp)) : null;
      case 'humidity':
        return item.main?.humidity != null ? Number(item.main.humidity) : null;
      case 'wind':
        return item.wind?.speed != null ? Number(item.wind.speed) : null;
      case 'precip': {
        const mm = item.rain?.['1h'] ?? item.rain?.['3h'] ?? item.snow?.['1h'] ?? item.snow?.['3h'];
        return mm != null ? Number(mm) : null;
      }
      case 'pop':
        return item.pop != null ? Number(item.pop) * 100 : null;
      default:
        return null;
    }
  }

  private extractAggregateChartValue(
    step: any,
    source: string,
    param: MultiDayForecastDisplayParam
  ): number | null {
    const field = this.aggregateChartField(param);
    if (!field) {
      return null;
    }
    if (source === 'mean') {
      const mean = step?.aggregate?.[field]?.mean;
      return mean != null ? this.normalizeAggregateChartValue(field, mean) : null;
    }
    const raw = step?.[source]?.[field];
    return raw != null ? this.normalizeAggregateChartValue(field, raw) : null;
  }

  private aggregateChartField(param: MultiDayForecastDisplayParam): string | null {
    switch (param) {
      case 'temp': return 'tempC';
      case 'humidity': return 'humidityPct';
      case 'wind': return 'windSpeedMs';
      case 'precip': return 'precipMm';
      case 'pop': return 'pop';
      default: return null;
    }
  }

  private normalizeAggregateChartValue(field: string, raw: number): number {
    if (field === 'tempC') {
      return this.celsiusToDisplay(Number(raw));
    }
    if (field === 'pop') {
      return Number(raw) * 100;
    }
    return Number(raw);
  }

  private aggregateComparisonSourceKeys(): Array<'meteofrance' | 'meteoswiss' | 'open-meteo' | 'openweathermap'> {
    return ['openweathermap', 'open-meteo', this.aggregateRegionalSourceKey];
  }

  private rebuildAggregatedForecastFromSourceLists(): void {
    const sourceKeys = this.aggregateComparisonSourceKeys();
    const dtSet = new Set<number>();
    for (const key of sourceKeys) {
      for (const item of this.aggregatedForecastSourceLists[key] ?? []) {
        const dt = Number(item?.dt);
        if (Number.isFinite(dt)) {
          dtSet.add(dt);
        }
      }
    }
    const sortedDts = [...dtSet].sort((a, b) => a - b);
    const sourcesAvailable: string[] = [];
    const steps = sortedDts.map((dt) => {
      const step: Record<string, unknown> = { dt };
      const bySource: Record<string, Record<string, number>> = {};
      for (const key of sourceKeys) {
        const list = this.aggregatedForecastSourceLists[key];
        if (!list?.length) {
          continue;
        }
        const item = list.find((entry) => Number(entry?.dt) === dt);
        const values = item ? this.normalizeForecastItemAggregateFields(item) : null;
        if (values && Object.keys(values).length) {
          step[key] = values;
          bySource[key] = values;
          if (!sourcesAvailable.includes(key)) {
            sourcesAvailable.push(key);
          }
        }
      }
      const aggregate = this.buildAggregateStepStats(bySource);
      if (Object.keys(aggregate).length) {
        step['aggregate'] = aggregate;
      }
      return step;
    });

    this.aggregatedForecast = {
      lat: this.lat,
      lon: this.lon,
      forecastHorizonHours: this.forecastHorizonHours,
      forecastStepMinutes: this.forecastStepMinutes,
      steps,
      sourcesAvailable,
      sourceErrors: Object.keys(this.aggregatedForecastSourceErrorsInternal).length
        ? { ...this.aggregatedForecastSourceErrorsInternal }
        : undefined
    };
  }

  private normalizeForecastItemAggregateFields(item: any): Record<string, number> {
    const values: Record<string, number> = {};
    if (item?.main?.temp != null) {
      values['tempC'] = Math.round(Number(item.main.temp) * 10) / 10;
    }
    if (item?.main?.humidity != null) {
      values['humidityPct'] = Math.round(Number(item.main.humidity));
    }
    if (item?.wind?.speed != null) {
      values['windSpeedMs'] = Math.round(Number(item.wind.speed) * 10) / 10;
    }
    const mm = item?.rain?.['1h'] ?? item?.rain?.['3h'] ?? item?.snow?.['1h'] ?? item?.snow?.['3h'];
    if (mm != null) {
      values['precipMm'] = Math.round(Number(mm) * 10) / 10;
    }
    if (item?.pop != null) {
      values['pop'] = Math.round(Math.min(1, Math.max(0, Number(item.pop))) * 1000) / 1000;
    }
    return values;
  }

  private buildAggregateStepStats(
    bySource: Record<string, Record<string, number>>
  ): Record<string, { min: number; max: number; mean: number; count: number }> {
    const paramKeys = ['tempC', 'humidityPct', 'precipMm', 'windSpeedMs', 'pop'] as const;
    const aggregate: Record<string, { min: number; max: number; mean: number; count: number }> = {};
    for (const param of paramKeys) {
      const nums: number[] = [];
      for (const values of Object.values(bySource)) {
        const raw = values[param];
        if (raw != null && Number.isFinite(raw)) {
          nums.push(Number(raw));
        }
      }
      if (!nums.length) {
        continue;
      }
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      const mean = nums.reduce((sum, value) => sum + value, 0) / nums.length;
      if (param === 'pop') {
        aggregate[param] = {
          min: Math.round(min * 100) / 100,
          max: Math.round(max * 100) / 100,
          mean: Math.round(mean * 100) / 100,
          count: nums.length
        };
      } else if (param === 'humidityPct') {
        aggregate[param] = {
          min: Math.round(min),
          max: Math.round(max),
          mean: Math.round(mean),
          count: nums.length
        };
      } else {
        aggregate[param] = {
          min: Math.round(min * 10) / 10,
          max: Math.round(max * 10) / 10,
          mean: Math.round(mean * 10) / 10,
          count: nums.length
        };
      }
    }
    return aggregate;
  }

  private hexToRgba(hex: string, alpha: number): string {
    const normalized = hex.replace('#', '');
    const r = parseInt(normalized.substring(0, 2), 16);
    const g = parseInt(normalized.substring(2, 4), 16);
    const b = parseInt(normalized.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  formatDay(ts: number): string {
    return this.formatTemperatureDateTime(new Date(ts * 1000));
  }

  getWeatherIconUrl(icon: string | undefined): string {
    if (!icon) {
      return '';
    }
    return `https://openweathermap.org/img/wn/${icon}@2x.png`;
  }
}
