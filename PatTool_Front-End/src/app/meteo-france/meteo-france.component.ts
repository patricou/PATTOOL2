import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { ApiService } from '../services/api.service';
import { environment } from '../../environments/environment';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions, registerables } from 'chart.js';
import * as L from 'leaflet';
import { Subscription } from 'rxjs';

Chart.register(...registerables);

type TemperatureUnit = 'celsius' | 'fahrenheit';

interface ClimPeriodOption {
  days: number;
  labelKey: string;
}

@Component({
  selector: 'app-meteo-france',
  templateUrl: './meteo-france.component.html',
  styleUrls: ['./meteo-france.component.css'],
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, NavigationButtonsModule, BaseChartDirective]
})
export class MeteoFranceComponent implements OnInit, OnDestroy {

  private static readonly TEMP_UNIT_STORAGE_KEY = 'meteo-france.temperature-unit';
  private static readonly CLIM_TEMP_COLUMNS = new Set(['TN', 'TNT', 'TX', 'TM']);

  @ViewChild('climTempChart') climTempChart?: BaseChartDirective;
  @ViewChild('climRainChart') climRainChart?: BaseChartDirective;

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

  errorMessage = '';
  isLoadingWeather = false;
  isLoadingForecast = false;
  isLoadingCitySearch = false;
  isLoadingGps = false;
  citySearchResults: any[] = [];
  showCitySearchResults = false;

  radarOpacity = 0.72;
  showRadar = true;
  showTemperatureMap = true;
  isLoadingTemperatureLabels = false;
  temperatureLabelSource: 'meteofrance-dpobs' | 'open-meteo' | null = null;
  temperatureLabelsErrorKey = '';
  temperatureUnit: TemperatureUnit = 'celsius';
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
  climErrorDetail = '';
  climPeriodStart = '';
  climPeriodEnd = '';
  climRequestedDays = 30;
  climAttemptedStation: any = null;

  private map: L.Map | null = null;
  private marker: L.Marker | null = null;
  private mosaicOverlay: L.ImageOverlay | null = null;
  private rainViewerLayer: L.TileLayer | null = null;
  private temperatureLabelsLayer: L.LayerGroup | null = null;
  private selectedTempLabelMarker: L.Marker | null = null;
  private temperatureGridPoints: Array<{ lat: number; lon: number; tempC: number }> = [];
  private temperatureLabelsDebounce: ReturnType<typeof setTimeout> | null = null;
  private temperatureLabelsRequestId = 0;
  private mosaicObjectUrl: string | null = null;
  private readonly radarBounds: L.LatLngBoundsExpression = [[40.8, -5.6], [52.0, 10.2]];
  private readonly subs = new Subscription();
  private mosaicRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private mapInitialized = false;

  ngOnInit(): void {
    this.loadTemperatureUnitPreference();
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
    this.detachTemperatureLabelListeners();
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
    if (!this.mfStatus || !this.showTemperatureMap) {
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
    if (this.temperatureLabelSource === 'meteofrance-dpobs') {
      return 'METEO_FRANCE.TEMPERATURE_MAP_HINT_MF';
    }
    if (this.temperatureLabelSource === 'open-meteo') {
      return 'METEO_FRANCE.TEMPERATURE_MAP_HINT_OPENMETEO';
    }
    return 'METEO_FRANCE.TEMPERATURE_MAP_HINT';
  }

  private readonly onMapMoveForTemperatureLabels = (): void => {
    this.scheduleTemperatureLabelsLoad();
  };

  private readonly onMapZoomForTemperatureLabels = (): void => {
    if (this.temperatureGridPoints.length) {
      this.renderTemperatureLabels();
    } else {
      this.scheduleTemperatureLabelsLoad();
    }
  };

  /** Minimum screen spacing between temperature labels (px). */
  private readonly temperatureLabelMinPxX = 44;
  private readonly temperatureLabelMinPxY = 22;
  private readonly temperatureLabelMaxStations = 120;

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
      this.setLocation(e.latlng.lat, e.latlng.lng, false);
    });

    this.mapInitialized = true;
    this.setupRadarLayer();
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
    this.map.on('moveend', this.onMapMoveForTemperatureLabels);
    this.map.on('zoomend', this.onMapZoomForTemperatureLabels);
    this.scheduleTemperatureLabelsLoad();
  }

  private removeTemperatureLabels(): void {
    this.detachTemperatureLabelListeners();
    this.clearTemperatureLabelsDebounce();
    this.temperatureGridPoints = [];
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
    this.map?.off('moveend', this.onMapMoveForTemperatureLabels);
    this.map?.off('zoomend', this.onMapZoomForTemperatureLabels);
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
    this.temperatureLabelsDebounce = setTimeout(() => this.loadTemperatureLabels(), 350);
  }

  private loadTemperatureLabels(): void {
    if (!this.showTemperatureMap || !this.map || !this.temperatureLabelsLayer) {
      return;
    }
    const bounds = this.map.getBounds();
    const capacity = this.computeTemperatureLabelCapacity();
    const requestId = ++this.temperatureLabelsRequestId;
    this.isLoadingTemperatureLabels = true;

    this.subs.add(
      this.apiService.getWeatherTemperatureLabels(
        bounds.getSouth(),
        bounds.getNorth(),
        bounds.getWest(),
        bounds.getEast(),
        capacity.cols,
        capacity.rows,
        capacity.maxStations
      ).subscribe({
        next: (data) => {
          if (requestId !== this.temperatureLabelsRequestId || !this.showTemperatureMap) {
            return;
          }
          if (data?.error) {
            this.temperatureLabelsErrorKey = 'METEO_FRANCE.TEMPERATURE_LABELS_ERROR';
            this.temperatureLabelSource = null;
            this.temperatureGridPoints = [];
          } else {
            this.temperatureLabelsErrorKey = '';
            const src = data?.source || 'open-meteo';
            this.temperatureLabelSource = src.startsWith('meteofrance') ? 'meteofrance-dpobs' : 'open-meteo';
            this.temperatureGridPoints = Array.isArray(data?.points) ? data.points : [];
          }
          this.renderTemperatureLabels();
          this.isLoadingTemperatureLabels = false;
        },
        error: () => {
          if (requestId !== this.temperatureLabelsRequestId) {
            return;
          }
          this.isLoadingTemperatureLabels = false;
        }
      })
    );
  }

  private computeTemperatureLabelCapacity(): { cols: number; rows: number; maxStations: number } {
    if (!this.map) {
      return { cols: 8, rows: 6, maxStations: 80 };
    }
    const size = this.map.getSize();
    const cols = Math.max(4, Math.min(16, Math.ceil(size.x / this.temperatureLabelMinPxX)));
    const rows = Math.max(3, Math.min(12, Math.ceil(size.y / this.temperatureLabelMinPxY)));
    const maxStations = Math.min(this.temperatureLabelMaxStations, cols * rows * 2);
    return { cols, rows, maxStations };
  }

  private renderTemperatureLabels(): void {
    if (!this.temperatureLabelsLayer || !this.map) {
      return;
    }
    this.temperatureLabelsLayer.clearLayers();
    const visible = this.filterNonOverlappingTemperatureLabels(this.temperatureGridPoints);
    for (const point of visible) {
      if (point.tempC == null || !Number.isFinite(point.tempC)) {
        continue;
      }
      if (this.isNearSelectedPoint(point.lat, point.lon)) {
        continue;
      }
      const label = this.formatTemperatureLabel(point.tempC);
      const icon = L.divIcon({
        className: 'mf-temp-label',
        html: `<span>${label}</span>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      });
      L.marker([point.lat, point.lon], { icon, interactive: false }).addTo(this.temperatureLabelsLayer);
    }
    this.updateSelectedTemperatureLabel();
  }

  private filterNonOverlappingTemperatureLabels(
    points: Array<{ lat: number; lon: number; tempC: number }>
  ): Array<{ lat: number; lon: number; tempC: number }> {
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
    if (!this.map || !this.showTemperatureMap) {
      this.removeSelectedTemperatureLabel();
      return;
    }
    const tempC = this.resolveSelectedTemperatureCelsius();
    if (tempC == null) {
      this.removeSelectedTemperatureLabel();
      return;
    }
    const label = this.formatTemperatureLabel(tempC);
    const icon = L.divIcon({
      className: 'mf-temp-label mf-temp-label--selected',
      html: `<span>${label}</span>`,
      iconSize: [0, 0],
      iconAnchor: [18, 46]
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
  }

  private removeSelectedTemperatureLabel(): void {
    if (this.selectedTempLabelMarker && this.map) {
      this.map.removeLayer(this.selectedTempLabelMarker);
      this.selectedTempLabelMarker = null;
    }
  }

  formatTemperatureLabel(valueCelsius: number): string {
    const display = this.celsiusToDisplay(valueCelsius);
    const rounded = Math.round(display);
    const unit = this.temperatureUnit === 'fahrenheit' ? '°F' : '°C';
    return `${rounded}${unit}`;
  }

  private resolveSelectedTemperatureCelsius(): number | null {
    if (this.temperatureLabelSource === 'meteofrance-dpobs') {
      return this.findNearestGridTempC(this.lat, this.lon);
    }
    const tempC = this.currentWeather?.main?.temp;
    return tempC != null && Number.isFinite(tempC) ? tempC : null;
  }

  private findNearestGridTempC(lat: number, lon: number): number | null {
    if (!this.temperatureGridPoints.length) {
      return null;
    }
    let best: number | null = null;
    let bestDist = Infinity;
    for (const point of this.temperatureGridPoints) {
      if (point.tempC == null || !Number.isFinite(point.tempC)) {
        continue;
      }
      const dist = (point.lat - lat) ** 2 + (point.lon - lon) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = point.tempC;
      }
    }
    return best;
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
