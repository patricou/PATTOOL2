import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  Optional,
  Output,
  SimpleChanges,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions, TooltipItem, registerables } from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import { Subject, catchError, of } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { ApiService, ForecastSourceStreamEvent } from '../../services/api.service';
import { MeteoChartFullscreenService } from '../../meteo-france/meteo-chart-fullscreen.service';
import {
  meteoChartCompactPointRadius,
  withMeteoChartZoom
} from '../../meteo-france/meteo-france-chart.util';

Chart.register(...registerables);
Chart.register(zoomPlugin);

type TemperatureUnit = 'celsius' | 'fahrenheit';
type WeatherDataSourceBrand = 'meteofrance' | 'open-meteo' | 'openweathermap' | 'meteoswiss';
type TimelineTab = 'meteofrance' | 'open-meteo' | 'openweathermap' | 'meteoswiss' | 'compare';
type TimelineParam = 'temp' | 'humidity' | 'wind' | 'precip' | 'precipDaily' | 'pop';
type TimelineSourceKey = 'meteofrance' | 'open-meteo' | 'openweathermap' | 'meteoswiss';
type TimelineSourceValues = Record<TimelineParam, number | null>;
type TimelineSlot = {
  ts: number;
  kind: 'history' | 'now' | 'forecast';
  values: Record<TimelineSourceKey, TimelineSourceValues>;
};
type ForecastChartKind = 'line' | 'bar';
type TimelineLoadLogLevel = 'info' | 'loading' | 'ok' | 'warn' | 'error';

interface TimelineLoadLogEntry {
  id: number;
  at: Date;
  level: TimelineLoadLogLevel;
  messageKey: string;
  detail?: string;
  params?: Record<string, string>;
}

@Component({
  selector: 'app-weather-point-timeline',
  standalone: true,
  imports: [CommonModule, TranslateModule, BaseChartDirective],
  templateUrl: './weather-point-timeline.component.html',
  styleUrls: ['./weather-point-timeline.component.css']
})
export class WeatherPointTimelineComponent implements OnChanges, AfterViewInit, OnDestroy {
  private static readonly LOGO_MF = 'assets/images/meteofrance-logo.svg';
  private static readonly LOGO_OPEN_METEO = 'assets/images/open-meteo-logo.svg';
  private static readonly LOGO_OWM = 'assets/images/openweathermap-logo.svg';
  private static readonly LOGO_MS = 'assets/images/meteoswiss-logo.svg';
  private static readonly SLOT_PARAMS: Array<'temp' | 'humidity' | 'wind' | 'precip' | 'pop'> = [
    'temp', 'humidity', 'wind', 'precip', 'pop'
  ];
  private static readonly HISTORY_DAYS = 7;
  private static readonly FORECAST_HOURS = 168;
  private static readonly STEP_MINUTES = 120;

  @Input() visible = false;
  @Input({ required: true }) lat!: number;
  @Input({ required: true }) lon!: number;
  @Input() title = '';
  @Input() mfTempC: number | null = null;
  @Input() msTempC: number | null = null;
  @Input() openMeteoTempC: number | null = null;
  @Input() openWeatherTempC: number | null = null;
  @Input() mfObservedAt: string | null = null;
  @Input() msObservedAt: string | null = null;
  @Input() openMeteoObservedAt: string | null = null;
  @Input() openWeatherObservedAt: string | null = null;
  @Input() stationId?: string;
  @Input() stationName?: string;
  @Input() departmentCode?: string;
  @Input() climEnabled = true;
  @Input() region: 'france' | 'switzerland' = 'france';
  @Input() temperatureUnit: TemperatureUnit = 'celsius';
  @Input() enableRevealAnimation = true;
  @Input() overlayMode: 'fixed' | 'embedded' = 'fixed';
  @Input() registerChartFullscreen = false;

  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() closed = new EventEmitter<void>();
  @Output() fullscreenChange = new EventEmitter<boolean>();

  @ViewChild('timelineChart', { read: BaseChartDirective }) timelineChart?: BaseChartDirective;
  @ViewChild('timelineOverlay') timelineOverlay?: ElementRef<HTMLElement>;
  @ViewChild('loadLogBody') loadLogBody?: ElementRef<HTMLElement>;

  readonly meteoFranceBrandLogo = WeatherPointTimelineComponent.LOGO_MF;
  readonly meteoSwissBrandLogo = WeatherPointTimelineComponent.LOGO_MS;

  get headerBrandLogo(): string {
    return this.region === 'switzerland'
      ? WeatherPointTimelineComponent.LOGO_MS
      : WeatherPointTimelineComponent.LOGO_MF;
  }

  get headerBrandAlt(): string {
    return this.region === 'switzerland' ? 'MeteoSwiss' : 'Météo-France';
  }

  timelineFullscreen = false;
  loading = false;
  errorKey = '';
  tabErrorKey = '';
  historyAvailable = false;
  forecastAvailable = false;
  dataLoaded = false;
  stationLabel = '';
  chartsReady = false;
  nowIndex = -1;
  activeTab: TimelineTab = 'meteofrance';
  activeParam: TimelineParam = 'temp';
  chartType: ForecastChartKind = 'line';
  infoKey = '';
  owmLoading = false;
  omLoading = false;
  mfForecastLoading = false;
  msLoading = false;
  climLoading = false;
  loadLogPanelOpen = false;
  loadLogEntries: TimelineLoadLogEntry[] = [];
  /** Bound in template — updated on next tick to avoid NG0100 on loadInProgress. */
  loadInProgressUi = false;

  chartData: ChartConfiguration<'line' | 'bar'>['data'] = { labels: [], datasets: [] };
  chartOptions: ChartOptions<'line' | 'bar'> = this.buildChartOptions();

  readonly timelineTabs: ReadonlyArray<{
    id: TimelineTab;
    labelKey: string;
    brand: WeatherDataSourceBrand | 'compare';
  }> = [
    { id: 'meteofrance', labelKey: 'METEO_FRANCE.POINT_TIMELINE_TAB_MF', brand: 'meteofrance' },
    { id: 'meteoswiss', labelKey: 'METEO_FRANCE.POINT_TIMELINE_TAB_MS', brand: 'meteoswiss' },
    { id: 'open-meteo', labelKey: 'METEO_FRANCE.POINT_TIMELINE_TAB_OM', brand: 'open-meteo' },
    { id: 'openweathermap', labelKey: 'METEO_FRANCE.POINT_TIMELINE_TAB_OWM', brand: 'openweathermap' },
    { id: 'compare', labelKey: 'METEO_FRANCE.POINT_TIMELINE_TAB_COMPARE', brand: 'compare' }
  ];

  get visibleTimelineTabs(): ReadonlyArray<{
    id: TimelineTab;
    labelKey: string;
    brand: WeatherDataSourceBrand | 'compare';
  }> {
    if (this.region === 'switzerland') {
      return this.timelineTabs.filter((tab) => tab.id !== 'meteofrance');
    }
    return this.timelineTabs.filter((tab) => tab.id !== 'meteoswiss');
  }

  readonly paramOptions: ReadonlyArray<{ id: TimelineParam; labelKey: string }> = [
    { id: 'temp', labelKey: 'METEO_FRANCE.AGG_COL_TEMP' },
    { id: 'humidity', labelKey: 'METEO_FRANCE.HUMIDITY' },
    { id: 'wind', labelKey: 'METEO_FRANCE.WIND' },
    { id: 'precip', labelKey: 'METEO_FRANCE.PRECIP' },
    { id: 'precipDaily', labelKey: 'METEO_FRANCE.PRECIP_DAILY' },
    { id: 'pop', labelKey: 'METEO_FRANCE.RAIN_CHANCE' }
  ];

  private readonly destroy$ = new Subject<void>();
  private readonly closeFullscreenHandler = (): void => {
    this.exitFullscreen();
  };

  private nowTs = 0;
  private forecastStreamAbort: AbortController | null = null;
  private streamEventQueue: ForecastSourceStreamEvent[] = [];
  private streamFlushScheduled = false;
  private revealTimer: ReturnType<typeof setInterval> | null = null;
  private revealedPoints = 0;
  private fullyRenderedDatasetLabels = new Set<string>();
  private requestId = 0;
  private climCache: any = null;
  private climQuotidienneCache: any = null;
  private mfForecastCache: any = null;
  private msForecastCache: any = null;
  private owmForecastCache: any = null;
  private omForecastCache: any = null;
  private quotidienneLoading = false;
  private slots: TimelineSlot[] = [];
  private dailySlots: TimelineSlot[] = [];
  private chartPoints: Array<{ ts: number; kind: 'history' | 'now' | 'forecast' }> = [];
  private loadLogSeq = 0;
  private loadDoneLogged = false;
  private chartReadyLogged = false;
  private activeLoadCancel$?: Subject<void>;
  private loadDataTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly LOAD_LOG_MAX = 120;

  constructor(
    private apiService: ApiService,
    private translate: TranslateService,
    private readonly cdr: ChangeDetectorRef,
    @Optional() private chartFullscreen?: MeteoChartFullscreenService
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['visible']) {
      if (this.visible && changes['visible'].previousValue !== true) {
        this.scheduleLoadData();
      } else if (!this.visible) {
        this.cancelScheduledLoadData();
        this.resetInternalState();
      }
    }
    if (this.visible && (changes['lat'] || changes['lon'])
      && changes['lat']?.previousValue !== undefined
      && changes['lon']?.previousValue !== undefined) {
      this.scheduleLoadData(true);
    }
    const tempChanged = changes['temperatureUnit'] || changes['mfTempC']
      || changes['openMeteoTempC'] || changes['openWeatherTempC'];
    if (this.visible && this.dataLoaded && !this.loadInProgress && tempChanged) {
      this.refreshFromCaches(false);
    }
  }

  ngAfterViewInit(): void {
    if (this.visible && !this.dataLoaded && this.loadDataTimer == null) {
      this.scheduleLoadData();
    }
  }

  ngOnDestroy(): void {
    this.resetInternalState();
    this.destroy$.next();
    this.destroy$.complete();
  }

  get displayTitle(): string {
    return this.title;
  }

  get currentTempC(): number | null {
    switch (this.activeTab) {
      case 'meteoswiss':
        return this.msTempC;
      case 'open-meteo':
        return this.openMeteoTempC;
      case 'openweathermap':
        return this.openWeatherTempC;
      default:
        return this.mfTempC;
    }
  }

  get currentObservedAtRaw(): string | null {
    switch (this.activeTab) {
      case 'meteoswiss':
        return this.msObservedAt;
      case 'open-meteo':
        return this.openMeteoObservedAt;
      case 'openweathermap':
        return this.openWeatherObservedAt;
      default:
        return this.mfObservedAt;
    }
  }

  get currentTempLabelKey(): string {
    return this.formatObservedTime(this.currentObservedAtRaw)
      ? 'METEO_FRANCE.POINT_TIMELINE_CURRENT_AT'
      : 'METEO_FRANCE.POINT_TIMELINE_CURRENT';
  }

  get currentTempLabelParams(): Record<string, string> {
    const time = this.formatObservedTime(this.currentObservedAtRaw);
    return time ? { time } : {};
  }

  get showCompareNow(): boolean {
    return this.activeParam === 'temp'
      && this.activeTab === 'compare'
      && (this.mfTempC != null || this.msTempC != null || this.openMeteoTempC != null || this.openWeatherTempC != null);
  }

  get compareNowMeanTempC(): number | null {
    const regional = this.region === 'switzerland' ? this.msTempC : this.mfTempC;
    return this.meanOfTempsC(regional, this.openMeteoTempC, this.openWeatherTempC);
  }

  get sourceKey(): string {
    switch (this.activeTab) {
      case 'meteoswiss':
        return 'METEO_FRANCE.POINT_TIMELINE_SOURCE_MS';
      case 'open-meteo':
        return 'METEO_FRANCE.POINT_TIMELINE_SOURCE_OM';
      case 'openweathermap':
        return 'METEO_FRANCE.POINT_TIMELINE_SOURCE_OWM';
      case 'compare':
        return this.region === 'switzerland'
          ? 'METEO_FRANCE.POINT_TIMELINE_SOURCE_COMPARE_CH'
          : 'METEO_FRANCE.POINT_TIMELINE_SOURCE_COMPARE';
      default:
        return 'METEO_FRANCE.POINT_TIMELINE_SOURCE';
    }
  }

  get sourceLogo(): string | null {
    switch (this.activeTab) {
      case 'meteoswiss':
        return this.getBrandLogoSrc('meteoswiss');
      case 'open-meteo':
        return this.getBrandLogoSrc('open-meteo');
      case 'openweathermap':
        return this.getBrandLogoSrc('openweathermap');
      case 'compare':
        return null;
      default:
        return this.meteoFranceBrandLogo;
    }
  }

  get showStation(): boolean {
    return (this.activeTab === 'meteofrance' || this.activeTab === 'meteoswiss') && !!this.stationLabel;
  }

  get periodLabel(): string {
    return this.buildPeriodLabel(this.activeParam, this.getActiveDisplaySlots());
  }

  get infoParams(): Record<string, string> {
    return { period: this.periodLabel };
  }

  get loadInProgress(): boolean {
    return this.climLoading
      || this.mfForecastLoading
      || this.msLoading
      || this.omLoading
      || this.owmLoading
      || this.quotidienneLoading;
  }

  get tabLoading(): boolean {
    const param = this.activeParam;
    switch (this.activeTab) {
      case 'meteofrance':
        return (this.mfForecastLoading || this.climLoading)
          && this.getSlotsForTab('meteofrance', param).length === 0;
      case 'meteoswiss':
        return this.msLoading && this.getSlotsForTab('meteoswiss', param).length === 0;
      case 'openweathermap':
        return this.owmLoading && this.getSlotsForTab('openweathermap', param).length === 0;
      case 'open-meteo':
        return this.omLoading && this.getSlotsForTab('open-meteo', param).length === 0;
      case 'compare':
        return (this.region === 'switzerland'
          ? (this.msLoading || this.owmLoading || this.omLoading)
          : (this.mfForecastLoading || this.owmLoading || this.omLoading))
          && this.getSlotsForTab('compare', param).length === 0;
      default:
        return false;
    }
  }

  getBrandLogoSrc(brand: WeatherDataSourceBrand): string {
    switch (brand) {
      case 'meteofrance':
        return WeatherPointTimelineComponent.LOGO_MF;
      case 'meteoswiss':
        return WeatherPointTimelineComponent.LOGO_MS;
      case 'openweathermap':
        return WeatherPointTimelineComponent.LOGO_OWM;
      default:
        return WeatherPointTimelineComponent.LOGO_OPEN_METEO;
    }
  }

  getBrandAlt(brand: WeatherDataSourceBrand): string {
    switch (brand) {
      case 'meteofrance':
        return 'Météo-France';
      case 'meteoswiss':
        return 'MeteoSwiss';
      case 'openweathermap':
        return 'OpenWeatherMap';
      default:
        return 'Open-Meteo';
    }
  }

  formatTemperatureLabel(valueCelsius: number): string {
    const unit = this.temperatureUnit === 'fahrenheit' ? '°F' : '°C';
    const value = this.temperatureUnit === 'fahrenheit'
      ? Math.round(valueCelsius * 9 / 5 + 32)
      : Math.round(valueCelsius * 10) / 10;
    return `${value}${unit}`;
  }

  formatObservedTime(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const trimmed = value.trim();
    let date: Date | null = null;
    if (/^\d{10}$/.test(trimmed)) {
      date = new Date(Number(trimmed) * 1000);
    } else if (/^\d{13}$/.test(trimmed)) {
      date = new Date(Number(trimmed));
    } else {
      date = new Date(trimmed);
    }
    if (!date || Number.isNaN(date.getTime())) {
      return null;
    }
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  isFullscreen(): boolean {
    return this.timelineFullscreen;
  }

  exitFullscreen(): void {
    const overlay = this.timelineOverlay?.nativeElement;
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void> };
    const fsElement = document.fullscreenElement ?? doc.webkitFullscreenElement;
    if (overlay && fsElement === overlay) {
      const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(document);
      exit?.().catch(() => this.setFullscreen(false));
      return;
    }
    this.setFullscreen(false);
  }

  close(): void {
    this.exitFullscreen();
    this.unregisterFullscreenHandler();
    this.resetInternalState();
    this.visibleChange.emit(false);
    this.closed.emit();
  }

  onTabChange(tab: TimelineTab): void {
    if (this.activeTab === tab) {
      return;
    }
    this.activeTab = tab;
    this.tabErrorKey = '';
    this.infoKey = '';
    this.renderChart();
  }

  onParamChange(param: TimelineParam): void {
    if (this.activeParam === param) {
      return;
    }
    this.activeParam = param;
    this.tabErrorKey = '';
    this.infoKey = '';
    if (param === 'precipDaily') {
      this.loadQuotidienne();
    }
    this.renderChart();
  }

  toggleFullscreen(): void {
    if (this.timelineFullscreen) {
      this.exitFullscreen();
      return;
    }
    const overlay = this.timelineOverlay?.nativeElement;
    if (!overlay) {
      this.setFullscreen(true);
      return;
    }
    const request = overlay.requestFullscreen?.bind(overlay)
      ?? (overlay as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(overlay);
    if (request) {
      request().then(() => this.setFullscreen(true))
        .catch(() => this.setFullscreen(true));
    } else {
      this.setFullscreen(true);
    }
  }

  resetZoom(): void {
    const chart = this.timelineChart?.chart as (Chart & { resetZoom?: () => void }) | undefined;
    chart?.resetZoom?.();
  }

  refreshData(): void {
    if (!this.visible || !Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return;
    }
    this.quotidienneLoading = false;
    this.tabErrorKey = '';
    this.infoKey = '';
    this.errorKey = '';
    this.scheduleLoadData(true);
  }

  private cancelScheduledLoadData(): void {
    if (this.loadDataTimer != null) {
      clearTimeout(this.loadDataTimer);
      this.loadDataTimer = null;
    }
  }

  /** Avoid NG0100: loadData mutates loadInProgress during the same CD cycle as visible=true. */
  private scheduleLoadData(isRefresh = false): void {
    this.cancelScheduledLoadData();
    this.loadDataTimer = setTimeout(() => {
      this.loadDataTimer = null;
      if (!this.visible) {
        return;
      }
      this.loadData(isRefresh);
      if (isRefresh && this.activeParam === 'precipDaily') {
        this.loadQuotidienne();
      }
    }, 0);
  }

  /** Reporte les mises à jour UI météo (flags, graphique) — évite NG0100 en dev mode. */
  private deferTimelineUiUpdate(update: () => void): void {
    setTimeout(() => {
      if (!this.visible) {
        return;
      }
      update();
      this.syncLoadInProgressUi();
      this.cdr.markForCheck();
    }, 0);
  }

  private syncLoadInProgressUi(): void {
    this.loadInProgressUi = this.loadInProgress;
  }

  toggleLoadLogPanel(): void {
    this.loadLogPanelOpen = !this.loadLogPanelOpen;
  }

  closeLoadLogPanel(): void {
    this.loadLogPanelOpen = false;
  }

  clearLoadLog(): void {
    this.loadLogEntries = [];
    this.loadLogSeq = 0;
  }

  loadLogStatusClass(level: TimelineLoadLogLevel): string {
    switch (level) {
      case 'ok':
        return 'mf-log-ok';
      case 'error':
        return 'mf-log-error';
      case 'warn':
        return 'mf-log-warn';
      case 'loading':
        return 'mf-log-loading';
      default:
        return 'mf-log-info';
    }
  }

  formatLoadLogTime(at: Date): string {
    return at.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  onNativeFullscreenChange(): void {
    this.syncNativeFullscreen();
  }

  private loadData(isRefresh = false): void {
    if (!this.visible || !Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return;
    }
    const requestId = ++this.requestId;
    this.clearLoadLog();
    this.loadDoneLogged = false;
    this.chartReadyLogged = false;
    this.cancelActiveLoads();
    this.appendLoadLog('info', isRefresh
      ? 'METEO_FRANCE.POINT_TIMELINE_LOG_REFRESH'
      : 'METEO_FRANCE.POINT_TIMELINE_LOG_START', undefined, {
      lat: this.lat.toFixed(4),
      lon: this.lon.toFixed(4)
    });
    if (this.stationId || this.stationName) {
      this.appendLoadLog('info', 'METEO_FRANCE.POINT_TIMELINE_LOG_STATION_HINT', undefined, {
        label: this.stationName
          ? (this.stationId ? `${this.stationName} (${this.stationId})` : this.stationName)
          : String(this.stationId)
      });
    }
    this.appendLoadLog('loading', 'METEO_FRANCE.POINT_TIMELINE_LOG_LOADING_PARALLEL');
    this.loading = false;
    this.dataLoaded = true;
    this.errorKey = '';
    this.chartsReady = false;
    this.resetCharts();
    this.climCache = null;
    this.climQuotidienneCache = null;
    this.mfForecastCache = null;
    this.owmForecastCache = null;
    this.omForecastCache = null;
    this.owmLoading = true;
    this.omLoading = true;
    this.mfForecastLoading = true;
    this.climLoading = this.climEnabled;
    this.syncLoadInProgressUi();
    this.clearReveal();
    this.streamEventQueue = [];
    this.loadClimHoraire(requestId);
    this.loadForecastStream(requestId);
    if (this.region === 'switzerland') {
      this.activeTab = 'meteoswiss';
      this.loadMeteoSwissForecast(requestId);
    } else {
      this.activeTab = 'meteofrance';
    }
  }

  private loadMeteoSwissForecast(requestId: number): void {
    if (this.region !== 'switzerland' || !this.visible) {
      this.msLoading = false;
      return;
    }
    this.msLoading = true;
    const loadCancel$ = this.activeLoadCancel$;
    this.apiService.getForecastByCoordinates(
      this.lat,
      this.lon,
      null,
      'meteoswiss',
      WeatherPointTimelineComponent.FORECAST_HOURS,
      WeatherPointTimelineComponent.STEP_MINUTES
    ).pipe(
      takeUntil(loadCancel$ ?? this.destroy$),
      catchError(() => of(null))
    ).subscribe({
      next: (data) => {
        if (requestId !== this.requestId || !this.visible) {
          return;
        }
        this.deferTimelineUiUpdate(() => {
          if (requestId !== this.requestId) {
            return;
          }
          this.msLoading = false;
          this.msForecastCache = data && !data.error && Array.isArray(data.list) ? data : null;
          this.refreshFromCaches(true);
          this.checkLoadComplete();
        });
      },
      error: () => {
        if (requestId !== this.requestId) {
          return;
        }
        this.deferTimelineUiUpdate(() => {
          if (requestId !== this.requestId) {
            return;
          }
          this.msLoading = false;
          this.refreshFromCaches(true);
          this.checkLoadComplete();
        });
      }
    });
  }

  private loadClimHoraire(requestId: number): void {
    if (!this.climEnabled || !this.visible) {
      this.climLoading = false;
      this.appendLoadLog('warn', 'METEO_FRANCE.POINT_TIMELINE_LOG_CLIM_SKIP');
      this.checkLoadComplete();
      return;
    }
    this.appendLoadLog('info', 'METEO_FRANCE.POINT_TIMELINE_LOG_CLIM_START');
    const loadCancel$ = this.activeLoadCancel$;
    this.apiService.getMeteoFranceClimNearby(
      this.lat,
      this.lon,
      WeatherPointTimelineComponent.HISTORY_DAYS,
      'horaire',
      this.departmentCode || undefined,
      this.stationId
    ).pipe(
      catchError(() => of(null)),
      takeUntil(this.destroy$),
      takeUntil(loadCancel$!)
    ).subscribe({
      next: (clim) => {
        if (requestId !== this.requestId || !this.visible) {
          return;
        }
        this.deferTimelineUiUpdate(() => {
          if (requestId !== this.requestId || !this.visible) {
            return;
          }
          this.climLoading = false;
          this.climCache = clim;
          this.logClimResponse('METEO_FRANCE.POINT_TIMELINE_LOG_CLIM_OK', clim);
          this.refreshFromCaches(true);
          this.checkLoadComplete();
        });
      },
      error: (err) => {
        if (requestId !== this.requestId) {
          return;
        }
        this.deferTimelineUiUpdate(() => {
          if (requestId !== this.requestId) {
            return;
          }
          this.climLoading = false;
          this.appendLoadLog('error', 'METEO_FRANCE.POINT_TIMELINE_LOG_CLIM_ERROR', this.extractErrorMessage(err));
          this.checkLoadComplete();
        });
      }
    });
  }

  private abortForecastStream(): void {
    this.forecastStreamAbort?.abort();
    this.forecastStreamAbort = null;
  }

  private cancelActiveLoads(): void {
    this.abortForecastStream();
    this.activeLoadCancel$?.next();
    this.activeLoadCancel$?.complete();
    this.activeLoadCancel$ = new Subject<void>();
  }

  private loadForecastStream(requestId: number): void {
    const abort = new AbortController();
    this.forecastStreamAbort = abort;
    this.appendLoadLog('info', 'METEO_FRANCE.POINT_TIMELINE_LOG_SSE_START');
    this.apiService.streamForecastSources(
      this.lat,
      this.lon,
      WeatherPointTimelineComponent.FORECAST_HOURS,
      WeatherPointTimelineComponent.STEP_MINUTES,
      abort.signal
    ).pipe(takeUntil(this.destroy$)).subscribe({
      next: (event) => {
        if (requestId !== this.requestId || !this.visible) {
          return;
        }
        this.enqueueStreamEvent(event);
      },
      complete: () => {
        if (requestId !== this.requestId) {
          return;
        }
        this.deferTimelineUiUpdate(() => {
          if (requestId !== this.requestId) {
            return;
          }
          this.mfForecastLoading = false;
          this.owmLoading = false;
          this.omLoading = false;
          this.appendLoadLog('ok', 'METEO_FRANCE.POINT_TIMELINE_LOG_SSE_COMPLETE');
          this.checkLoadComplete();
        });
      },
      error: (err) => {
        if (requestId !== this.requestId || abort.signal.aborted) {
          if (abort.signal.aborted) {
            this.appendLoadLog('warn', 'METEO_FRANCE.POINT_TIMELINE_LOG_SSE_ABORT');
          }
          return;
        }
        this.deferTimelineUiUpdate(() => {
          if (requestId !== this.requestId) {
            return;
          }
          this.mfForecastLoading = false;
          this.owmLoading = false;
          this.omLoading = false;
          this.appendLoadLog('error', 'METEO_FRANCE.POINT_TIMELINE_LOG_SSE_FATAL', this.extractErrorMessage(err));
          if (!this.chartsReady && this.slots.length === 0) {
            this.errorKey = 'METEO_FRANCE.POINT_TIMELINE_LOAD_ERROR';
          }
          this.checkLoadComplete();
        });
      }
    });
  }

  private applyForecastStreamEvent(event: ForecastSourceStreamEvent): void {
    const payload = !event.error && Array.isArray(event.list) ? { list: event.list } : null;
    const sourceLabel = this.forecastSourceLabel(event.source);
    if (event.error || !payload?.list?.length) {
      this.appendLoadLog('error', 'METEO_FRANCE.POINT_TIMELINE_LOG_SSE_SOURCE_ERROR', undefined, {
        source: sourceLabel,
        error: event.error ?? this.translate.instant('METEO_FRANCE.POINT_TIMELINE_NO_DATA')
      });
    } else {
      this.appendLoadLog('ok', 'METEO_FRANCE.POINT_TIMELINE_LOG_SSE_SOURCE_OK', undefined, {
        source: sourceLabel,
        steps: String(payload.list.length)
      });
    }
    switch (event.source) {
      case 'meteofrance':
        this.mfForecastLoading = false;
        this.mfForecastCache = payload;
        break;
      case 'openweathermap':
        this.owmLoading = false;
        this.owmForecastCache = payload;
        break;
      case 'open-meteo':
        this.omLoading = false;
        this.omForecastCache = payload;
        break;
    }
  }

  private loadQuotidienne(): void {
    if (this.quotidienneLoading || this.climQuotidienneCache || !this.climEnabled || !this.visible) {
      return;
    }
    const requestId = this.requestId;
    this.quotidienneLoading = true;
    this.appendLoadLog('loading', 'METEO_FRANCE.POINT_TIMELINE_LOG_QUOT_START');
    const loadCancel$ = this.activeLoadCancel$;
    this.apiService.getMeteoFranceClimNearby(
      this.lat,
      this.lon,
      WeatherPointTimelineComponent.HISTORY_DAYS,
      'quotidienne',
      this.departmentCode || undefined,
      this.stationId
    ).pipe(
      catchError(() => of(null)),
      takeUntil(this.destroy$),
      takeUntil(loadCancel$!)
    ).subscribe({
      next: (data) => {
        if (requestId !== this.requestId || !this.visible) {
          return;
        }
        this.deferTimelineUiUpdate(() => {
          if (requestId !== this.requestId || !this.visible) {
            return;
          }
          this.quotidienneLoading = false;
          this.climQuotidienneCache = data;
          this.logClimResponse('METEO_FRANCE.POINT_TIMELINE_LOG_QUOT_OK', data);
          this.buildDailySlots(data, this.slots);
          if (this.activeParam === 'precipDaily') {
            this.renderChart();
          }
          this.checkLoadComplete();
        });
      },
      error: (err) => {
        if (requestId !== this.requestId) {
          return;
        }
        this.deferTimelineUiUpdate(() => {
          if (requestId !== this.requestId) {
            return;
          }
          this.quotidienneLoading = false;
          this.appendLoadLog('error', 'METEO_FRANCE.POINT_TIMELINE_LOG_QUOT_ERROR', this.extractErrorMessage(err));
          this.checkLoadComplete();
        });
      }
    });
  }

  private resetInternalState(): void {
    this.cancelScheduledLoadData();
    this.cancelActiveLoads();
    this.unregisterFullscreenHandler();
    this.clearReveal();
    this.streamEventQueue = [];
    this.timelineFullscreen = false;
    this.loading = false;
    this.errorKey = '';
    this.tabErrorKey = '';
    this.infoKey = '';
    this.chartsReady = false;
    this.historyAvailable = false;
    this.forecastAvailable = false;
    this.dataLoaded = false;
    this.stationLabel = '';
    this.climCache = null;
    this.climQuotidienneCache = null;
    this.mfForecastCache = null;
    this.msForecastCache = null;
    this.owmForecastCache = null;
    this.omForecastCache = null;
    this.owmLoading = false;
    this.omLoading = false;
    this.mfForecastLoading = false;
    this.msLoading = false;
    this.climLoading = false;
    this.quotidienneLoading = false;
    this.loadInProgressUi = false;
    this.slots = [];
    this.dailySlots = [];
    this.loadLogPanelOpen = false;
    this.loadLogEntries = [];
    this.loadDoneLogged = false;
    this.chartReadyLogged = false;
    this.resetCharts();
    this.requestId++;
  }

  private resetCharts(): void {
    this.chartData = { labels: [], datasets: [] };
    this.nowIndex = -1;
  }

  private refreshFromCaches(incremental = false): void {
    if (this.region === 'switzerland') {
      this.buildSlotsSwitzerland();
    } else {
      this.buildSlots(this.climCache, this.mfForecastCache);
      this.buildDailySlots(this.climQuotidienneCache, this.slots);
    }
    this.dataLoaded = true;
    this.renderChart(this.shouldUseIncremental(incremental));
  }

  private buildSlotsSwitzerland(): void {
    const slotMap = new Map<number, TimelineSlot>();
    this.historyAvailable = false;
    this.forecastAvailable = false;
    this.stationLabel = this.stationName || this.stationId || '';

    const nowTs = Math.floor(Date.now() / 1000);
    const nowSlot = slotMap.get(nowTs) ?? this.createEmptySlot(nowTs, 'now');
    nowSlot.kind = 'now';
    if (this.msTempC != null) {
      nowSlot.values.meteoswiss.temp = Math.round(this.celsiusToDisplay(this.msTempC) * 10) / 10;
    }
    if (this.openMeteoTempC != null) {
      nowSlot.values['open-meteo'].temp = Math.round(this.celsiusToDisplay(this.openMeteoTempC) * 10) / 10;
    }
    if (this.openWeatherTempC != null) {
      nowSlot.values.openweathermap.temp = Math.round(this.celsiusToDisplay(this.openWeatherTempC) * 10) / 10;
    }
    slotMap.set(nowTs, nowSlot);
    this.nowTs = nowTs;

    if (this.msForecastCache?.list) {
      this.mergeForecastListIntoSlotMap(slotMap, this.msForecastCache.list, 'meteoswiss');
    }
    if (this.owmForecastCache?.list) {
      this.mergeForecastListIntoSlotMap(slotMap, this.owmForecastCache.list, 'openweathermap');
    }
    if (this.omForecastCache?.list) {
      this.mergeForecastListIntoSlotMap(slotMap, this.omForecastCache.list, 'open-meteo');
    }

    this.slots = [...slotMap.values()].sort((a, b) => a.ts - b.ts);
    this.dailySlots = [];
    this.fillNowValues();
  }

  private shouldUseIncremental(incremental: boolean): boolean {
    return incremental && this.enableRevealAnimation;
  }

  private enqueueStreamEvent(event: ForecastSourceStreamEvent): void {
    this.streamEventQueue.push(event);
    this.flushStreamQueue();
  }

  private flushStreamQueue(): void {
    if (this.streamFlushScheduled || !this.streamEventQueue.length) {
      return;
    }
    this.streamFlushScheduled = true;
    requestAnimationFrame(() => {
      this.streamFlushScheduled = false;
      const event = this.streamEventQueue.shift();
      if (!event || !this.visible) {
        if (this.streamEventQueue.length) {
          this.flushStreamQueue();
        }
        return;
      }
      this.deferTimelineUiUpdate(() => {
        if (!this.visible) {
          return;
        }
        this.applyForecastStreamEvent(event);
        this.refreshFromCaches(true);
        if (!this.chartsReady && !this.errorKey && !this.tabLoading && this.slots.length === 0) {
          this.tabErrorKey = 'METEO_FRANCE.POINT_TIMELINE_NO_DATA';
          this.appendLoadLog('warn', 'METEO_FRANCE.POINT_TIMELINE_LOG_NO_SLOTS_YET');
        }
        if (this.streamEventQueue.length) {
          this.flushStreamQueue();
        }
      });
    });
  }

  private clearReveal(): void {
    if (this.revealTimer != null) {
      clearInterval(this.revealTimer);
      this.revealTimer = null;
    }
    this.revealedPoints = 0;
    this.fullyRenderedDatasetLabels.clear();
  }

  private stopRevealTimer(): void {
    if (this.revealTimer != null) {
      clearInterval(this.revealTimer);
      this.revealTimer = null;
    }
  }

  private truncateValuesForReveal(values: Array<number | null>, revealedPoints: number): Array<number | null> {
    if (revealedPoints >= values.length) {
      return values;
    }
    return values.map((value, index) => (index < revealedPoints ? value : null));
  }

  private applyRevealToDatasets(
    datasets: ChartConfiguration<'line' | 'bar'>['data']['datasets'],
    revealedPoints: number,
    chartType: ForecastChartKind
  ): ChartConfiguration<'line' | 'bar'>['data']['datasets'] {
    if (chartType !== 'line' || revealedPoints <= 0) {
      return datasets;
    }
    return datasets.map((dataset) => {
      const lineDataset = dataset as {
        showLine?: boolean;
        data?: Array<number | null>;
        label?: string;
        pointRadius?: number | number[];
        spanGaps?: boolean;
      };
      if (lineDataset.showLine === false) {
        return dataset;
      }
      const label = String(lineDataset.label ?? '');
      if (this.fullyRenderedDatasetLabels.has(label)) {
        return dataset;
      }
      const sourceData = Array.isArray(lineDataset.data) ? lineDataset.data : [];
      const data = this.truncateValuesForReveal(sourceData, revealedPoints);
      const rawRadius = lineDataset.pointRadius;
      const pointRadius = Array.isArray(rawRadius)
        ? rawRadius.map((radius, index) => (index < revealedPoints ? radius : 0))
        : rawRadius;
      return {
        ...lineDataset,
        data,
        pointRadius,
        spanGaps: true
      } as (typeof datasets)[number];
    });
  }

  private scheduleReveal(
    slotCount: number,
    datasets: ChartConfiguration<'line' | 'bar'>['data']['datasets'],
    labels: string[],
    chartType: ForecastChartKind,
    incremental: boolean
  ): void {
    if (!this.enableRevealAnimation || chartType !== 'line' || slotCount <= 1) {
      this.revealedPoints = slotCount;
      return;
    }
    if (!incremental) {
      this.clearReveal();
      this.revealedPoints = slotCount;
      return;
    }
    const hasNewDatasets = datasets.some((dataset) =>
      dataset.label && !this.fullyRenderedDatasetLabels.has(String(dataset.label))
    );
    if (!hasNewDatasets) {
      this.revealedPoints = slotCount;
      return;
    }
    const startAt = Math.max(1, Math.min(4, slotCount));
    this.revealedPoints = startAt;
    if (this.revealTimer != null) {
      clearInterval(this.revealTimer);
    }
    const step = Math.max(1, Math.ceil(slotCount / 24));
    this.revealTimer = setInterval(() => {
      if (!this.visible) {
        this.clearReveal();
        return;
      }
      const next = Math.min(slotCount, this.revealedPoints + step);
      this.revealedPoints = next;
      const chart = this.timelineChart?.chart;
      if (!chart) {
        return;
      }
      const revealedDatasets = this.applyRevealToDatasets(datasets, next, chartType);
      chart.data.labels = labels;
      chart.data.datasets = revealedDatasets as typeof chart.data.datasets;
      this.chartData = chart.data as ChartConfiguration<'line' | 'bar'>['data'];
      chart.update('none');
      if (next >= slotCount) {
        this.stopRevealTimer();
        this.revealedPoints = slotCount;
        for (const dataset of datasets) {
          if (dataset.label) {
            this.fullyRenderedDatasetLabels.add(String(dataset.label));
          }
        }
        chart.data.datasets = datasets as typeof chart.data.datasets;
        this.chartData = chart.data as ChartConfiguration<'line' | 'bar'>['data'];
        chart.update('active');
      }
    }, 45);
  }

  private applyChartInPlace(
    labels: string[],
    datasets: ChartConfiguration<'line' | 'bar'>['data']['datasets'],
    chartType: ForecastChartKind,
    incremental: boolean
  ): void {
    const chart = this.timelineChart?.chart;
    if (!chart) {
      this.activateChart();
      return;
    }
    const useReveal = this.shouldUseIncremental(incremental);
    const revealedDatasets = useReveal && chartType === 'line'
      ? this.applyRevealToDatasets(datasets, this.revealedPoints || 1, chartType)
      : datasets;
    chart.data.labels = labels;
    chart.data.datasets = revealedDatasets as typeof chart.data.datasets;
    this.chartData = chart.data as ChartConfiguration<'line' | 'bar'>['data'];
    chart.update(incremental ? 'active' : 'none');
    if (useReveal && chartType === 'line') {
      this.scheduleReveal(labels.length, datasets, labels, chartType, true);
    }
  }

  private buildSlots(climData: any, mfOnlyForecast: any = null): void {
    this.historyAvailable = false;
    this.forecastAvailable = false;
    this.stationLabel = '';
    const slotMap = new Map<number, TimelineSlot>();

    if (climData && !climData.error) {
      const hourly = climData.frequency === 'horaire';
      const rows = [...(climData.rows || [])].sort((a, b) =>
        this.climRowSortKey(a).localeCompare(this.climRowSortKey(b))
      );
      const precipColumn = this.resolveClimPrecipColumn(rows);
      const resolvedStationName = climData.station?.name || climData.stationName || this.stationName;
      const resolvedStationId = climData.station?.id || climData.stationId || this.stationId;
      if (resolvedStationName || resolvedStationId) {
        this.stationLabel = resolvedStationName
          ? (resolvedStationId ? `${resolvedStationName} (${resolvedStationId})` : resolvedStationName)
          : String(resolvedStationId);
      }
      for (const row of rows) {
        const ts = this.climRowEpochSeconds(row);
        if (ts == null || !this.isTimelineTwoHourSlot(ts)) {
          continue;
        }
        const slot = slotMap.get(ts) ?? this.createEmptySlot(ts, 'history');
        for (const param of WeatherPointTimelineComponent.SLOT_PARAMS) {
          const value = this.extractClimTimelineValue(row, hourly, param, precipColumn);
          if (value != null) {
            slot.values.meteofrance[param] = value;
            this.historyAvailable = true;
          }
        }
        slotMap.set(ts, slot);
      }
    }

    const nowTs = Math.floor(Date.now() / 1000);
    const nowSlot = slotMap.get(nowTs) ?? this.createEmptySlot(nowTs, 'now');
    nowSlot.kind = 'now';
    if (this.mfTempC != null) {
      nowSlot.values.meteofrance.temp = Math.round(this.celsiusToDisplay(this.mfTempC) * 10) / 10;
    }
    if (this.msTempC != null) {
      nowSlot.values.meteoswiss.temp = Math.round(this.celsiusToDisplay(this.msTempC) * 10) / 10;
    }
    if (this.openMeteoTempC != null) {
      nowSlot.values['open-meteo'].temp = Math.round(this.celsiusToDisplay(this.openMeteoTempC) * 10) / 10;
    }
    if (this.openWeatherTempC != null) {
      nowSlot.values.openweathermap.temp = Math.round(this.celsiusToDisplay(this.openWeatherTempC) * 10) / 10;
    }
    slotMap.set(nowTs, nowSlot);
    this.nowTs = nowTs;

    if (mfOnlyForecast && !mfOnlyForecast.error && Array.isArray(mfOnlyForecast.list)) {
      this.mergeForecastListIntoSlotMap(slotMap, mfOnlyForecast.list, 'meteofrance');
    }
    if (this.owmForecastCache?.list) {
      this.mergeForecastListIntoSlotMap(slotMap, this.owmForecastCache.list, 'openweathermap');
    }
    if (this.omForecastCache?.list) {
      this.mergeForecastListIntoSlotMap(slotMap, this.omForecastCache.list, 'open-meteo');
    }

    this.slots = [...slotMap.values()].sort((a, b) => a.ts - b.ts);
    this.fillNowValues();
  }

  private mergeForecastListIntoSlotMap(
    slotMap: Map<number, TimelineSlot>,
    list: any[],
    source: TimelineSourceKey
  ): void {
    for (const item of list) {
      const ts = Number(item?.dt);
      if (!Number.isFinite(ts) || ts <= 0) {
        continue;
      }
      const slot = slotMap.get(ts) ?? this.createEmptySlot(ts, 'forecast');
      for (const param of WeatherPointTimelineComponent.SLOT_PARAMS) {
        const value = this.extractListItemTimelineValue(item, param);
        if (value != null) {
          slot.values[source][param] = value;
          this.forecastAvailable = true;
        }
      }
      slotMap.set(ts, slot);
    }
  }

  private extractListItemTimelineValue(item: any, param: TimelineParam): number | null {
    if (!item) {
      return null;
    }
    switch (param) {
      case 'temp': {
        const temp = item.main?.temp;
        return temp != null ? Math.round(this.celsiusToDisplay(Number(temp)) * 10) / 10 : null;
      }
      case 'humidity': {
        const humidity = item.main?.humidity;
        return humidity != null ? Math.round(Number(humidity)) : null;
      }
      case 'wind': {
        const wind = item.wind?.speed;
        return wind != null ? Math.round(Number(wind) * 100) / 100 : null;
      }
      case 'precip': {
        const mm = item.rain?.['1h'] ?? item.rain?.['3h'] ?? item.snow?.['1h'] ?? item.snow?.['3h'];
        return mm != null ? Number(mm) : null;
      }
      case 'pop': {
        const pop = item.pop;
        return pop != null ? Math.round(Number(pop) * 1000) / 10 : null;
      }
      default:
        return null;
    }
  }

  private fillNowValues(): void {
    const nowTs = this.nowTs;
    const slots = this.slots;
    const nowIndex = slots.findIndex((slot) => slot.kind === 'now');
    if (nowIndex < 0) {
      return;
    }
    const nowSlot = slots[nowIndex];
    const params: Array<'humidity' | 'wind' | 'precip'> = ['humidity', 'wind', 'precip'];
    const sources: TimelineSourceKey[] = this.compareSourceKeys();
    for (const source of sources) {
      for (const param of params) {
        if (nowSlot.values[source][param] != null) {
          continue;
        }
        let before: { ts: number; value: number } | null = null;
        let after: { ts: number; value: number } | null = null;
        for (let i = nowIndex - 1; i >= 0; i--) {
          const value = slots[i].values[source][param];
          if (value != null) {
            before = { ts: slots[i].ts, value };
            break;
          }
        }
        for (let i = nowIndex + 1; i < slots.length; i++) {
          const value = slots[i].values[source][param];
          if (value != null) {
            after = { ts: slots[i].ts, value };
            break;
          }
        }
        let resolved: number | null = null;
        if (before && after) {
          if (param === 'precip') {
            resolved = after.value;
          } else {
            const span = after.ts - before.ts;
            const ratio = span > 0 ? (nowTs - before.ts) / span : 0;
            resolved = before.value + (after.value - before.value) * ratio;
          }
        } else if (after) {
          resolved = after.value;
        } else if (before) {
          resolved = before.value;
        }
        if (resolved != null) {
          nowSlot.values[source][param] = Math.round(resolved * 10) / 10;
        }
      }
    }
  }

  private buildDailySlots(climQuotidienneData: any, hourlySlots: TimelineSlot[]): void {
    const dayMap = new Map<string, TimelineSlot>();
    const todayStart = this.timelineTodayStartTs();

    const ensureDay = (dayKey: string, noonTs: number): TimelineSlot => {
      let slot = dayMap.get(dayKey);
      if (!slot) {
        const kind: TimelineSlot['kind'] = noonTs < todayStart
          ? 'history'
          : noonTs < todayStart + 86_400
            ? 'now'
            : 'forecast';
        slot = this.createEmptySlot(noonTs, kind);
        dayMap.set(dayKey, slot);
      }
      return slot;
    };

    if (climQuotidienneData && !climQuotidienneData.error) {
      const rows = [...(climQuotidienneData.rows || [])].sort((a, b) =>
        this.climRowSortKey(a).localeCompare(this.climRowSortKey(b))
      );
      const precipColumn = this.resolveClimPrecipColumn(rows);
      for (const row of rows) {
        const ts = this.climRowEpochSeconds(row);
        if (ts == null || ts >= todayStart) {
          continue;
        }
        const dayKey = this.timelineLocalDayKey(ts);
        const slot = ensureDay(dayKey, this.timelineDayNoonTs(ts));
        const value = this.extractClimTimelineValue(row, false, 'precipDaily', precipColumn);
        if (value != null) {
          slot.values.meteofrance.precipDaily = value;
          this.historyAvailable = true;
        }
      }
    }

    for (const hourSlot of hourlySlots) {
      if (hourSlot.kind === 'now') {
        continue;
      }
      const dayKey = this.timelineLocalDayKey(hourSlot.ts);
      const isPastDay = hourSlot.ts < todayStart;
      const dailySlot = ensureDay(dayKey, this.timelineDayNoonTs(hourSlot.ts));
      for (const source of ['meteofrance', 'open-meteo', 'openweathermap'] as const) {
        const precip = hourSlot.values[source].precip;
        if (precip == null) {
          continue;
        }
        if (source === 'meteofrance' && isPastDay && dailySlot.values.meteofrance.precipDaily != null) {
          continue;
        }
        const prev = dailySlot.values[source].precipDaily ?? 0;
        dailySlot.values[source].precipDaily = Math.round((prev + precip) * 10) / 10;
        if (hourSlot.kind === 'forecast' || !isPastDay) {
          this.forecastAvailable = true;
        }
      }
    }

    this.dailySlots = [...dayMap.values()].sort((a, b) => a.ts - b.ts);
  }

  private createEmptyTimelineSourceValues(): TimelineSourceValues {
    return {
      temp: null,
      humidity: null,
      wind: null,
      precip: null,
      precipDaily: null,
      pop: null
    };
  }

  private createEmptySlot(ts: number, kind: TimelineSlot['kind']): TimelineSlot {
    const empty = () => this.createEmptyTimelineSourceValues();
    return {
      ts,
      kind,
      values: {
        meteofrance: empty(),
        meteoswiss: empty(),
        'open-meteo': empty(),
        openweathermap: empty()
      }
    };
  }

  private compareSourceKeys(): TimelineSourceKey[] {
    return this.region === 'switzerland'
      ? ['meteoswiss', 'open-meteo', 'openweathermap']
      : ['meteofrance', 'open-meteo', 'openweathermap'];
  }

  private meanOfTempsC(...values: Array<number | null | undefined>): number | null {
    const temps = values.filter((value): value is number => value != null && Number.isFinite(value));
    if (!temps.length) {
      return null;
    }
    return Math.round((temps.reduce((sum, value) => sum + value, 0) / temps.length) * 10) / 10;
  }

  private compareMeanSlotValue(slot: TimelineSlot, param: TimelineParam): number | null {
    if (param !== 'temp') {
      return null;
    }
    const values = this.compareSourceKeys()
      .map((source) => this.slotValue(slot, source, param))
      .filter((value): value is number => value != null && Number.isFinite(value));
    if (!values.length) {
      return null;
    }
    return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
  }

  private slotValue(slot: TimelineSlot, source: TimelineSourceKey, param: TimelineParam): number | null {
    return slot.values[source][param];
  }

  private getSlotsForTab(tab: TimelineTab, param: TimelineParam): TimelineSlot[] {
    if (tab === 'compare') {
      return this.slots.filter((slot) =>
        this.compareSourceKeys().some((source) => slot.values[source][param] != null)
      );
    }
    return this.slots.filter((slot) => this.slotValue(slot, tab, param) != null);
  }

  private getDailySlotsForTab(tab: TimelineTab, param: TimelineParam): TimelineSlot[] {
    if (tab === 'compare') {
      return this.dailySlots.filter((slot) =>
        this.compareSourceKeys().some((source) => slot.values[source][param] != null)
      );
    }
    return this.dailySlots.filter((slot) => this.slotValue(slot, tab, param) != null);
  }

  private getActiveDisplaySlots(): TimelineSlot[] {
    const tab = this.activeTab;
    const param = this.activeParam;
    return param === 'precipDaily'
      ? this.getDailySlotsForTab(tab, param)
      : this.getSlotsForTab(tab, param);
  }

  private buildPeriodLabel(param: TimelineParam, slots: TimelineSlot[]): string {
    return this.formatTimelineSlotRangeLabel(slots, param === 'precipDaily');
  }

  private formatTimelineSlotRangeLabel(slots: Array<{ ts: number }>, daily: boolean): string {
    if (!slots.length) {
      return '';
    }
    const format = daily
      ? (ts: number) => this.formatDailyChartLabel(ts)
      : (ts: number) => this.formatChartLabel(ts);
    return `${format(slots[0].ts)} → ${format(slots[slots.length - 1].ts)}`;
  }

  private renderChart(incremental = false): void {
    if (!incremental) {
      this.clearReveal();
      this.fullyRenderedDatasetLabels.clear();
      this.chartsReady = false;
      this.resetCharts();
    }
    this.tabErrorKey = '';
    this.infoKey = '';
    const tab = this.activeTab;
    const param = this.activeParam;
    const chartType = (param === 'precip' || param === 'precipDaily') ? 'bar' : 'line';
    this.chartType = chartType;
    const slots = param === 'precipDaily'
      ? this.getDailySlotsForTab(tab, param)
      : this.getSlotsForTab(tab, param);
    const showNowMarker = param === 'temp' || param === 'humidity' || param === 'wind' || param === 'precip';

    if (!slots.length) {
      this.chartsReady = false;
      if (this.tabLoading) {
        this.tabErrorKey = '';
        return;
      }
      this.tabErrorKey = this.resolveTabErrorKey(tab, param);
      return;
    }

    this.chartPoints = slots.map((slot) => ({ ts: slot.ts, kind: slot.kind }));
    const labels = param === 'precipDaily'
      ? slots.map((slot) => this.formatDailyChartLabel(slot.ts))
      : slots.map((slot) => this.formatChartLabel(slot.ts));
    this.nowIndex = showNowMarker ? slots.findIndex((slot) => slot.kind === 'now') : -1;
    const nowLabel = this.translate.instant('METEO_FRANCE.POINT_TIMELINE_LEGEND_NOW');
    const compactPoints = meteoChartCompactPointRadius(slots.length, 3) === 0;
    const linePointRadius = compactPoints ? 0 : 3;
    const linePointHoverRadius = compactPoints ? 0 : 5;
    const comparePointRadius = compactPoints ? 0 : 2;
    const comparePointHoverRadius = compactPoints ? 0 : 4;
    const datasets: ChartConfiguration<'line' | 'bar'>['data']['datasets'] = [];

    if (tab === 'compare') {
      const compareSources: Array<{ key: TimelineSourceKey; labelKey: string; color: string }> = [
        ...(this.region === 'switzerland'
          ? [{ key: 'meteoswiss' as TimelineSourceKey, labelKey: 'METEO_FRANCE.POINT_TIMELINE_LEGEND_MS', color: '#d52b1e' }]
          : [{ key: 'meteofrance' as TimelineSourceKey, labelKey: 'METEO_FRANCE.POINT_TIMELINE_LEGEND_MF', color: '#2ecc71' }]),
        { key: 'open-meteo', labelKey: 'METEO_FRANCE.POINT_TIMELINE_LEGEND_OM', color: '#3498db' },
        { key: 'openweathermap', labelKey: 'METEO_FRANCE.POINT_TIMELINE_LEGEND_OWM', color: '#e67e22' }
      ];
      for (const source of compareSources) {
        const rawValues = slots.map((slot) => this.slotValue(slot, source.key, param));
        if (!rawValues.some((value) => value != null)) {
          continue;
        }
        const values = this.normalizeTimelineChartValues(rawValues, chartType);
        datasets.push({
          label: this.translate.instant(source.labelKey),
          data: values,
          borderColor: source.color,
          backgroundColor: chartType === 'bar'
            ? this.hexToRgba(source.color, 0.55)
            : 'transparent',
          ...(chartType === 'line' ? {
            tension: 0.25,
            spanGaps: true,
            pointRadius: values.map((_value, index) => {
              if (showNowMarker && index === this.nowIndex) {
                return 0;
              }
              return _value != null ? comparePointRadius : 0;
            }),
            pointHoverRadius: values.map((_value, index) => {
              if (showNowMarker && index === this.nowIndex) {
                return 0;
              }
              return _value != null ? comparePointHoverRadius : 0;
            })
          } : {
            borderWidth: 1
          }),
          fill: false,
          order: 2
        });
      }
      if (param === 'temp') {
        const meanValues = slots.map((slot) => this.compareMeanSlotValue(slot, param));
        if (meanValues.some((value) => value != null)) {
          const values = this.normalizeTimelineChartValues(meanValues, chartType);
          datasets.push({
            label: this.translate.instant('METEO_FRANCE.AGG_COL_MEAN'),
            data: values,
            borderColor: '#6366f1',
            backgroundColor: 'transparent',
            borderDash: [8, 4],
            borderWidth: 2,
            tension: 0.25,
            spanGaps: true,
            pointRadius: values.map((_value, index) => {
              if (showNowMarker && index === this.nowIndex) {
                return 0;
              }
              return _value != null ? comparePointRadius : 0;
            }),
            pointHoverRadius: values.map((_value, index) => {
              if (showNowMarker && index === this.nowIndex) {
                return 0;
              }
              return _value != null ? comparePointHoverRadius : 0;
            }),
            fill: false,
            order: 1
          });
        }
      }
      if (!datasets.length) {
        this.chartsReady = false;
        this.tabErrorKey = 'METEO_FRANCE.POINT_TIMELINE_NO_DATA';
        return;
      }
      if (showNowMarker && this.nowIndex >= 0) {
        const nowSlot = slots[this.nowIndex];
        const nowValue = param === 'temp'
          ? this.compareMeanSlotValue(nowSlot, param)
          : nowSlot.values.meteofrance[param]
            ?? nowSlot.values['open-meteo'][param]
            ?? nowSlot.values.openweathermap[param];
        if (nowValue != null) {
          const nowValues: Array<number | null> = slots.map((_slot, index) =>
            index === this.nowIndex ? nowValue : null
          );
          datasets.push({
            type: 'line',
            label: nowLabel,
            data: nowValues,
            borderColor: '#dc2626',
            backgroundColor: '#dc2626',
            pointRadius: nowValues.map((value) => value != null ? 9 : 0),
            pointHoverRadius: nowValues.map((value) => value != null ? 11 : 0),
            pointBorderColor: '#ffffff',
            pointBorderWidth: 2,
            showLine: false,
            spanGaps: false,
            order: 0
          } as any);
        }
      }
    } else {
      const rawValues = slots.map((slot) => this.slotValue(slot, tab, param));
      const values = this.normalizeTimelineChartValues(rawValues, chartType);
      const color = tab === 'open-meteo'
        ? '#3498db'
        : tab === 'openweathermap'
          ? '#e67e22'
          : tab === 'meteoswiss'
            ? '#d52b1e'
            : '#2ecc71';
      const labelKey = tab === 'open-meteo'
        ? 'METEO_FRANCE.POINT_TIMELINE_LEGEND_OM'
        : tab === 'openweathermap'
          ? 'METEO_FRANCE.POINT_TIMELINE_LEGEND_OWM'
          : tab === 'meteoswiss'
            ? 'METEO_FRANCE.POINT_TIMELINE_LEGEND_MS'
            : 'METEO_FRANCE.POINT_TIMELINE_LEGEND_MF';
      const nowValues: Array<number | null> = rawValues.map((value, index) =>
        showNowMarker && index === this.nowIndex ? value : null
      );
      datasets.push({
        label: this.translate.instant(labelKey),
        data: values,
        borderColor: color,
        backgroundColor: chartType === 'bar'
          ? this.hexToRgba(color, 0.55)
          : tab === 'meteofrance'
            ? 'rgba(46, 204, 113, 0.12)'
            : tab === 'open-meteo'
              ? 'rgba(52, 152, 219, 0.12)'
              : 'rgba(230, 126, 34, 0.12)',
        ...(chartType === 'line' ? {
          tension: 0.25,
          spanGaps: true,
          pointRadius: rawValues.map((_value, index) =>
            showNowMarker && index === this.nowIndex ? 0 : linePointRadius
          ),
          pointHoverRadius: rawValues.map((_value, index) =>
            showNowMarker && index === this.nowIndex ? 0 : linePointHoverRadius
          ),
          fill: tab === 'meteofrance' || tab === 'meteoswiss'
        } : {
          borderWidth: 1
        }),
        order: 2
      });
      if (showNowMarker) {
        datasets.push({
          type: 'line',
          label: nowLabel,
          data: nowValues,
          borderColor: '#dc2626',
          backgroundColor: '#dc2626',
          pointRadius: nowValues.map((value) => value != null ? 9 : 0),
          pointHoverRadius: nowValues.map((value) => value != null ? 11 : 0),
          pointBorderColor: '#ffffff',
          pointBorderWidth: 2,
          showLine: false,
          spanGaps: false,
          order: 0
        } as any);
      }
    }

    this.chartOptions = this.buildChartOptions(this.chartPoints, param, chartType);
    const chartContent = this.evaluateChartContent(datasets, param, nowLabel);
    if (chartContent === 'empty') {
      this.chartsReady = false;
      this.tabErrorKey = this.resolveTabErrorKey(tab, param);
      this.appendLoadLog('warn', 'METEO_FRANCE.POINT_TIMELINE_LOG_TAB_EMPTY', this.translate.instant(this.tabErrorKey));
      return;
    }
    if (chartContent === 'all-zero') {
      this.chartsReady = false;
      this.infoKey = 'METEO_FRANCE.POINT_TIMELINE_NO_PRECIP_PERIOD';
      this.appendLoadLog('info', 'METEO_FRANCE.POINT_TIMELINE_LOG_ALL_ZERO');
      return;
    }
    const useIncremental = this.shouldUseIncremental(incremental);
    if (useIncremental && this.chartsReady) {
      this.applyChartInPlace(labels, datasets, chartType, true);
      return;
    }
    const startReveal = useIncremental && chartType === 'line' && labels.length > 1;
    if (startReveal) {
      const initialReveal = Math.max(1, Math.min(4, labels.length));
      this.revealedPoints = initialReveal;
      const partialDatasets = this.applyRevealToDatasets(datasets, initialReveal, chartType);
      this.chartData = { labels, datasets: partialDatasets };
    } else {
      this.chartData = { labels, datasets };
    }
    this.activateChart(startReveal, labels, datasets, chartType);
  }

  private resolveTabErrorKey(tab: TimelineTab, param: TimelineParam): string {
    if (param === 'pop' && tab === 'meteofrance') {
      return 'METEO_FRANCE.POINT_TIMELINE_POP_MF_FORECAST_ONLY';
    }
    switch (tab) {
      case 'meteoswiss':
        return 'METEO_FRANCE.POINT_TIMELINE_UNAVAILABLE_MS';
      case 'open-meteo':
        return 'METEO_FRANCE.POINT_TIMELINE_UNAVAILABLE_OM';
      case 'openweathermap':
        return 'METEO_FRANCE.POINT_TIMELINE_UNAVAILABLE_OWM';
      case 'compare':
        return 'METEO_FRANCE.POINT_TIMELINE_NO_DATA';
      default:
        if (param === 'pop' || param === 'humidity' || param === 'wind' || param === 'precip' || param === 'precipDaily') {
          return this.forecastAvailable
            ? 'METEO_FRANCE.POINT_TIMELINE_FORECAST_ONLY_PARAM'
            : 'METEO_FRANCE.POINT_TIMELINE_NO_DATA';
        }
        return this.historyAvailable
          ? 'METEO_FRANCE.POINT_TIMELINE_FORECAST_UNAVAILABLE'
          : 'METEO_FRANCE.POINT_TIMELINE_NO_DATA';
    }
  }

  private activateChart(
    revealAfterMount = false,
    revealLabels: string[] = [],
    revealDatasets: ChartConfiguration<'line' | 'bar'>['data']['datasets'] = [],
    revealChartType: ForecastChartKind = 'line'
  ): void {
    setTimeout(() => {
      if (!this.visible) {
        return;
      }
      this.chartsReady = true;
      this.cdr.markForCheck();
      requestAnimationFrame(() => {
        this.timelineChart?.update();
        if (revealAfterMount && revealChartType === 'line') {
          this.scheduleReveal(revealLabels.length, revealDatasets, revealLabels, revealChartType, true);
        }
        if (!this.chartReadyLogged) {
          this.chartReadyLogged = true;
          this.appendLoadLog('ok', 'METEO_FRANCE.POINT_TIMELINE_LOG_CHART_READY', undefined, {
            slots: String(this.slots.length)
          });
        }
        this.checkLoadComplete();
        this.cdr.markForCheck();
      });
    }, 0);
  }

  private buildChartOptions(
    points: Array<{ ts: number; kind: 'history' | 'now' | 'forecast' }> = [],
    param: TimelineParam = 'temp',
    chartType: ForecastChartKind = 'line'
  ): ChartOptions<'line' | 'bar'> {
    const yUnit = this.timelineYUnit(param);
    const percentParam = param === 'humidity' || param === 'pop';
    const decimals = param === 'wind' ? 2 : 1;
    const nowLabel = this.translate.instant('METEO_FRANCE.POINT_TIMELINE_LEGEND_NOW');
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { boxWidth: 10, font: { size: 10 } }
        },
        tooltip: {
          callbacks: {
            title: (items: TooltipItem<'line' | 'bar'>[]) => {
              const index = items[0]?.dataIndex ?? -1;
              const point = points[index];
              if (!point) {
                return items[0]?.label ?? '';
              }
              return param === 'precipDaily'
                ? this.formatDailyChartLabel(point.ts)
                : this.formatChartLabel(point.ts);
            },
            label: (ctx: TooltipItem<'line' | 'bar'>) => {
              const y = ctx.parsed.y;
              if (y == null || Number.isNaN(y)) {
                return `${ctx.dataset.label}: —`;
              }
              const formatted = y.toLocaleString(undefined, { maximumFractionDigits: decimals });
              const index = ctx.dataIndex;
              const point = points[index];
              const suffix = yUnit ? ` ${yUnit}` : '';
              if (point?.kind === 'now' || ctx.dataset.label === nowLabel) {
                return `${nowLabel}: ${formatted}${suffix}`;
              }
              return `${ctx.dataset.label}: ${formatted}${suffix}`;
            }
          }
        }
      },
      scales: {
        x: {
          display: this.timelineFullscreen,
          ticks: {
            maxTicksLimit: this.timelineFullscreen ? 14 : 8,
            maxRotation: 45,
            minRotation: 0,
            font: { size: 10 },
            autoSkip: true
          }
        },
        y: {
          beginAtZero: chartType === 'bar' || percentParam,
          max: percentParam ? 100 : undefined,
          title: { display: !!yUnit, text: yUnit, font: { size: 10 } },
          ticks: {
            font: { size: 10 },
            callback: (v: string | number) => Number(v).toLocaleString(undefined, { maximumFractionDigits: decimals })
          }
        }
      },
      elements: chartType === 'bar'
        ? { bar: { borderWidth: 1 } }
        : { line: { spanGaps: true, tension: 0.25 } },
      datasets: chartType === 'bar'
        ? { bar: { categoryPercentage: 0.82, barPercentage: 0.9 } }
        : undefined
    };
    return (chartType === 'bar'
      ? withMeteoChartZoom<'bar'>(options as ChartOptions<'bar'>)
      : withMeteoChartZoom<'line'>(options as ChartOptions<'line'>)) as ChartOptions<'line' | 'bar'>;
  }

  private evaluateChartContent(
    datasets: ChartConfiguration<'line' | 'bar'>['data']['datasets'],
    param: TimelineParam,
    nowLabel: string
  ): 'ok' | 'empty' | 'all-zero' {
    const values = this.collectTimelineDatasetValues(datasets, nowLabel);
    if (!values.length) {
      return 'empty';
    }
    if ((param === 'precip' || param === 'precipDaily') && values.every((value) => value === 0)) {
      return 'all-zero';
    }
    return 'ok';
  }

  private collectTimelineDatasetValues(
    datasets: ChartConfiguration<'line' | 'bar'>['data']['datasets'],
    skipLabel?: string
  ): number[] {
    const values: number[] = [];
    for (const dataset of datasets) {
      if (skipLabel && dataset.label === skipLabel) {
        continue;
      }
      for (const raw of dataset.data ?? []) {
        if (raw != null && Number.isFinite(Number(raw))) {
          values.push(Number(raw));
        }
      }
    }
    return values;
  }

  private normalizeTimelineChartValues(
    values: Array<number | null>,
    chartType: ForecastChartKind
  ): Array<number | null> {
    if (chartType !== 'bar') {
      return values;
    }
    return values.map((value) => (value == null ? 0 : value));
  }

  private timelineYUnit(param: TimelineParam): string {
    switch (param) {
      case 'temp':
        return this.temperatureUnit === 'fahrenheit' ? '°F' : '°C';
      case 'humidity':
      case 'pop':
        return '%';
      case 'wind':
        return 'm/s';
      case 'precip':
      case 'precipDaily':
        return 'mm';
      default:
        return '';
    }
  }

  private climRowSortKey(row: any): string {
    const raw = row.DATE ?? row.AAAAMMJJ ?? row.AAAAMMJJHH;
    return raw != null ? String(raw).trim() : '';
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

  private celsiusToDisplay(valueCelsius: number): number {
    if (this.temperatureUnit === 'fahrenheit') {
      return valueCelsius * 9 / 5 + 32;
    }
    return valueCelsius;
  }

  private resolveClimPrecipColumn(rows: any[]): string | null {
    if (rows.some((row) => this.parseClimNumber(row.RR) != null)) {
      return 'RR';
    }
    if (rows.some((row) => this.parseClimNumber(row.RR1) != null)) {
      return 'RR1';
    }
    if (rows.some((row) => this.parseClimNumber(row.RR3) != null)) {
      return 'RR3';
    }
    return null;
  }

  private extractClimTimelineValue(
    row: any,
    hourly: boolean,
    param: TimelineParam,
    precipColumn: string | null = null
  ): number | null {
    switch (param) {
      case 'temp':
        return this.extractClimTimelineTemp(row, hourly);
      case 'humidity': {
        const humidity = this.parseClimNumber(row.U);
        return humidity != null ? humidity : null;
      }
      case 'wind': {
        const wind = this.parseClimNumber(row.FF) ?? this.parseClimNumber(row.FXI);
        return wind != null ? wind : null;
      }
      case 'precip': {
        if (precipColumn) {
          return this.parseClimNumber(row[precipColumn]);
        }
        const rain = this.parseClimNumber(row.RR);
        if (rain != null) {
          return rain;
        }
        return this.parseClimNumber(row.RR1) ?? this.parseClimNumber(row.RR3);
      }
      case 'precipDaily': {
        if (hourly) {
          return null;
        }
        if (precipColumn) {
          return this.parseClimNumber(row[precipColumn]);
        }
        return this.parseClimNumber(row.RR)
          ?? this.parseClimNumber(row.RR1)
          ?? this.parseClimNumber(row.RR3);
      }
      case 'pop':
        return null;
      default:
        return null;
    }
  }

  private extractClimTimelineTemp(row: any, hourly: boolean): number | null {
    if (hourly) {
      const instant = this.tempChartValue(row.T);
      if (instant != null) {
        return instant;
      }
      return this.tempChartValue(row.TAT);
    }
    return this.extractClimDailyMeanTemp(row);
  }

  private extractClimDailyMeanTemp(row: any): number | null {
    const mean = this.tempChartValue(row.TM);
    if (mean != null) {
      return mean;
    }
    const tnKey = this.parseClimNumber(row.TN) != null ? 'TN' : 'TNT';
    const min = this.tempChartValue(row[tnKey]);
    const max = this.tempChartValue(row.TX);
    if (min != null && max != null) {
      return Math.round(((min + max) / 2) * 10) / 10;
    }
    if (max != null) {
      return max;
    }
    if (min != null) {
      return min;
    }
    const instant = this.tempChartValue(row.T);
    if (instant != null) {
      return instant;
    }
    return this.tempChartValue(row.TAT);
  }

  private isTimelineTwoHourSlot(ts: number): boolean {
    const date = new Date(ts * 1000);
    return date.getMinutes() === 0 && date.getHours() % 2 === 0;
  }

  private timelineLocalDayKey(ts: number): string {
    const date = new Date(ts * 1000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private timelineDayNoonTs(ts: number): number {
    const date = new Date(ts * 1000);
    date.setHours(12, 0, 0, 0);
    return Math.floor(date.getTime() / 1000);
  }

  private timelineTodayStartTs(): number {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return Math.floor(date.getTime() / 1000);
  }

  private formatChartLabel(ts: number | null | undefined): string {
    if (ts == null || !Number.isFinite(Number(ts))) {
      return '';
    }
    return this.formatTemperatureDateTime(new Date(Number(ts) * 1000));
  }

  private formatDailyChartLabel(ts: number | null | undefined): string {
    if (ts == null || !Number.isFinite(Number(ts))) {
      return '';
    }
    return new Date(Number(ts) * 1000).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    });
  }

  private formatTemperatureDateTime(date: Date): string {
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

  private hexToRgba(hex: string, alpha: number): string {
    const normalized = hex.replace('#', '');
    const r = parseInt(normalized.substring(0, 2), 16);
    const g = parseInt(normalized.substring(2, 4), 16);
    const b = parseInt(normalized.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  private setFullscreen(fullscreen: boolean): void {
    if (this.timelineFullscreen === fullscreen) {
      return;
    }
    this.timelineFullscreen = fullscreen;
    this.fullscreenChange.emit(fullscreen);
    if (fullscreen) {
      this.registerFullscreenHandler();
    } else {
      this.unregisterFullscreenHandler();
    }
    if (this.chartsReady) {
      this.chartOptions = this.buildChartOptions(this.chartPoints, this.activeParam, this.chartType);
    }
    setTimeout(() => this.resizeChart(), fullscreen ? 180 : 120);
  }

  private registerFullscreenHandler(): void {
    if (this.registerChartFullscreen) {
      this.chartFullscreen?.register(this.closeFullscreenHandler);
    }
  }

  private unregisterFullscreenHandler(): void {
    if (this.registerChartFullscreen) {
      this.chartFullscreen?.unregister(this.closeFullscreenHandler);
    }
  }

  private resizeChart(): void {
    this.timelineChart?.chart?.resize();
    this.timelineChart?.update();
  }

  private syncNativeFullscreen(): void {
    const overlay = this.timelineOverlay?.nativeElement;
    if (!overlay || !this.visible) {
      return;
    }
    const doc = document as Document & { webkitFullscreenElement?: Element };
    const active = document.fullscreenElement === overlay || doc.webkitFullscreenElement === overlay;
    if (this.timelineFullscreen !== active) {
      this.setFullscreen(active);
    }
  }

  private appendLoadLog(
    level: TimelineLoadLogLevel,
    messageKey: string,
    detail?: string,
    params?: Record<string, string>
  ): void {
    const entry: TimelineLoadLogEntry = {
      id: ++this.loadLogSeq,
      at: new Date(),
      level,
      messageKey,
      detail,
      params
    };
    this.loadLogEntries = [entry, ...this.loadLogEntries].slice(0, WeatherPointTimelineComponent.LOAD_LOG_MAX);
    setTimeout(() => {
      const body = this.loadLogBody?.nativeElement;
      if (body) {
        body.scrollTop = 0;
      }
    }, 0);
  }

  private checkLoadComplete(): void {
    if (this.loadDoneLogged || this.loadInProgress) {
      return;
    }
    this.loadDoneLogged = true;
    this.appendLoadLog('ok', 'METEO_FRANCE.POINT_TIMELINE_LOG_DONE');
  }

  private logClimResponse(messageKey: string, clim: any): void {
    if (!clim) {
      this.appendLoadLog('error', 'METEO_FRANCE.POINT_TIMELINE_LOG_CLIM_ERROR');
      return;
    }
    if (clim.error) {
      const detail = clim.details || clim.error;
      this.appendLoadLog('error', 'METEO_FRANCE.POINT_TIMELINE_LOG_CLIM_ERROR', String(detail));
      return;
    }
    const rows = Array.isArray(clim.rows) ? clim.rows.length : 0;
    const stationName = clim.station?.name || clim.stationName;
    const stationId = clim.station?.id || clim.stationId;
    const params: Record<string, string> = { rows: String(rows) };
    if (stationName || stationId) {
      params['station'] = stationName
        ? (stationId ? `${stationName} (${stationId})` : stationName)
        : String(stationId);
    }
    this.appendLoadLog('ok', messageKey, undefined, params);
    if (params['station']) {
      this.appendLoadLog('info', 'METEO_FRANCE.POINT_TIMELINE_LOG_CLIM_STATION', undefined, {
        label: params['station']
      });
    }
  }

  private forecastSourceLabel(source: string): string {
    switch (source) {
      case 'meteofrance':
        return this.translate.instant('METEO_FRANCE.POINT_TIMELINE_TAB_MF');
      case 'meteoswiss':
        return this.translate.instant('METEO_FRANCE.POINT_TIMELINE_TAB_MS');
      case 'open-meteo':
        return this.translate.instant('METEO_FRANCE.POINT_TIMELINE_TAB_OM');
      case 'openweathermap':
        return this.translate.instant('METEO_FRANCE.POINT_TIMELINE_TAB_OWM');
      default:
        return source;
    }
  }

  private extractErrorMessage(err: unknown): string {
    if (err == null) {
      return '';
    }
    if (typeof err === 'string') {
      return err;
    }
    if (err instanceof Error) {
      return err.message;
    }
    if (typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
      return (err as { message: string }).message;
    }
    return String(err);
  }
}
