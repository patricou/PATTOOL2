import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  SimpleChanges,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ApiService } from '../services/api.service';
import { LeafletBasemapOption, LeafletBasemapService } from '../shared/leaflet-basemap.service';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import * as L from 'leaflet';
import { Subscription, take } from 'rxjs';

interface ArpegeLayer {
  name: string;
  title?: string;
  style?: string;
  category?: string;
  elevations?: string[];
  defaultElevation?: string;
}

interface ArpegeDomainOption {
  id: string;
  label: string;
  wmsService?: string;
}

interface ArpegeForecastStep {
  time: string;
  offsetMinutes?: number;
  values?: Record<string, unknown>;
}

@Component({
  selector: 'app-meteo-france-arpege-tab',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, TraceViewerModalComponent],
  templateUrl: './meteo-france-arpege-tab.component.html',
  styleUrls: ['./meteo-france-arpege-tab.component.css', './meteo-france-maps.shared.css']
})
export class MeteoFranceArpegeTabComponent implements OnInit, OnChanges, OnDestroy {

  private static readonly DEFAULT_ZOOM = 7;
  private static readonly PLAY_INTERVAL_MS = 700;
  private static readonly THROTTLE_POLL_MS = 5000;
  private static readonly DOMAIN_EUROPE = '01-EUROPE';
  private static readonly DOMAIN_GLOBE = '025-GLOBE';
  private static readonly EUROPE_BOUNDS: L.LatLngBoundsExpression = [[20.0, -32.0], [72.0, 42.0]];

  @Input() lat = 48.8566;
  @Input() lon = 2.3522;
  @Input() mapBaseLayerId = 'osm-standard';
  @Input() active = false;
  @Input() authValid = false;
  @Input() configured = false;
  @Input() statusMessageKey = '';
  @Input() locationLabel = '';
  @Input() locationCoords = '';

  @ViewChild('mapShell') mapShell?: ElementRef<HTMLElement>;
  @ViewChild(TraceViewerModalComponent) traceViewerModalComponent?: TraceViewerModalComponent;

  mapFullscreen = false;
  loading = false;
  errorKey = '';
  layers: ArpegeLayer[] = [];
  domains: ArpegeDomainOption[] = [
    { id: MeteoFranceArpegeTabComponent.DOMAIN_EUROPE, label: 'Europe 0.1°' },
    { id: MeteoFranceArpegeTabComponent.DOMAIN_GLOBE, label: 'Globe 0.25°' }
  ];
  selectedDomain = MeteoFranceArpegeTabComponent.DOMAIN_EUROPE;
  selectedLayer = '';
  selectedStyle = '';
  referenceTimes: string[] = [];
  elevations: string[] = [];
  selectedElevation = '';
  timeSteps: string[] = [];
  frameIndex = 0;
  referenceTime = '';
  playing = false;
  opacity = 0.72;
  localMapBaseLayerId = 'osm-standard';
  horizonMinutes = 6120;
  stepMinutes = 60;
  step3hMinutes = 180;
  hourlyUntilMinutes = 2880;
  pointForecastLoading = false;
  pointForecastSteps: ArpegeForecastStep[] = [];
  pointForecastLayers: string[] = [];
  showForecastTable = false;
  wmsThrottled = false;
  wmsRetryAfterSeconds = 0;
  /** Rate-limit map banner is shown briefly, then auto-hidden. */
  private throttleBannerVisible = false;
  private throttleBannerTimer: ReturnType<typeof setTimeout> | null = null;
  featureInfoLoading = false;
  featureInfoValue: string | null = null;
  tilesCacheKnown = false;
  tilesFromCache = false;
  tilesLoading = false;
  forecastCacheTtlMinutes: number | null = null;
  clearingForecastCache = false;
  private cacheProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheProbeGen = 0;
  private tilesCacheHits = 0;
  private tilesCacheMisses = 0;
  private clearCacheSub: Subscription | null = null;

  private map: L.Map | null = null;
  private baseLayer: L.TileLayer | L.LayerGroup | null = null;
  private wmsLayer: L.TileLayer | null = null;
  private locationMarker: L.Marker | null = null;
  private featureInfoPopup: L.Popup | null = null;
  private mapInitialized = false;
  private destroyed = false;
  private playTimer: ReturnType<typeof setInterval> | null = null;
  private throttleTimer: ReturnType<typeof setInterval> | null = null;
  private layoutTimer: ReturnType<typeof setTimeout> | null = null;
  private pointForecastSub: Subscription | null = null;
  private featureInfoSub: Subscription | null = null;
  private capsRequestId = 0;

  constructor(
    private apiService: ApiService,
    private basemapService: LeafletBasemapService,
    private translate: TranslateService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.localMapBaseLayerId = this.mapBaseLayerId || 'osm-standard';
    if (this.active) {
      this.activate();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['mapBaseLayerId'] && this.mapBaseLayerId) {
      this.localMapBaseLayerId = this.mapBaseLayerId;
      if (this.map) {
        this.applyBaseLayer();
      }
    }
    if (changes['active']?.currentValue === true) {
      this.activate();
    }
    if ((changes['lat'] || changes['lon']) && this.active && this.mapInitialized) {
      this.centerOnInputLocation(false);
      this.loadPointForecast();
    }
    if ((changes['authValid'] || changes['configured'] || changes['statusMessageKey']) && this.active) {
      this.loadCapabilities();
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopPlayback();
    this.stopThrottlePolling();
    this.clearThrottleBanner();
    this.clearLayoutTimer();
    if (this.cacheProbeTimer) {
      clearTimeout(this.cacheProbeTimer);
      this.cacheProbeTimer = null;
    }
    this.clearCacheSub?.unsubscribe();
    this.pointForecastSub?.unsubscribe();
    this.featureInfoSub?.unsubscribe();
    this.exitMapFullscreenIfActive();
    this.destroyMap();
  }

  get availableMapBaseLayers(): LeafletBasemapOption[] {
    return this.basemapService.getAvailableLayers();
  }

  get currentTime(): string {
    return this.timeSteps[this.frameIndex] || '';
  }

  get displayStatusMessageKey(): string {
    if (this.wmsThrottled && this.authValid && this.throttleBannerVisible) {
      return 'METEO_FRANCE.AROMEPI_RATE_LIMITED';
    }
    if (this.statusMessageKey) {
      return this.statusMessageKey;
    }
    if (!this.configured) {
      return 'METEO_FRANCE.ARPEGE_NOT_CONFIGURED';
    }
    if (!this.authValid) {
      return 'METEO_FRANCE.ARPEGE_INVALID_TOKEN';
    }
    return this.errorKey;
  }

  get showElevationControl(): boolean {
    return this.elevations.length > 0;
  }

  get cloudLayers(): ArpegeLayer[] {
    return this.layers.filter((l) => l.category === 'cloud');
  }

  get precipLayers(): ArpegeLayer[] {
    return this.layers.filter((l) => l.category === 'precipitation');
  }

  get tempLayers(): ArpegeLayer[] {
    return this.layers.filter((l) => l.category === 'temperature');
  }

  get otherLayers(): ArpegeLayer[] {
    return this.layers.filter((l) =>
      l.category !== 'cloud' && l.category !== 'precipitation' && l.category !== 'temperature');
  }

  get currentOffsetMinutes(): number {
    return this.offsetMinutesBetween(this.referenceTime, this.currentTime);
  }

  get minOffsetMinutes(): number {
    if (!this.timeSteps.length) {
      return 0;
    }
    return this.offsetMinutesBetween(this.referenceTime, this.timeSteps[0]);
  }

  get maxOffsetMinutes(): number {
    if (!this.timeSteps.length) {
      return this.horizonMinutes;
    }
    return this.offsetMinutesBetween(this.referenceTime, this.timeSteps[this.timeSteps.length - 1]);
  }

  getMapBaseLayerLabel(layer: LeafletBasemapOption): string {
    return layer.labelKey ? this.translate.instant(layer.labelKey) : layer.label;
  }

  activate(): void {
    if (!this.mapInitialized) {
      this.scheduleLayoutRefresh(80, () => this.initMap());
    } else {
      this.scheduleLayoutRefresh(80, () => this.map?.invalidateSize());
    }
    this.loadCapabilities();
    this.startThrottlePolling();
  }

  centerOnSelectedLocation(): void {
    this.centerOnInputLocation(true);
  }

  reloadPointForecast(): void {
    this.loadPointForecast();
  }

  /** Called from parent options / AROME clear — refresh ARPEGE after shared cache wipe. */
  reloadAfterForecastCacheClear(): void {
    this.tilesCacheKnown = false;
    this.tilesFromCache = false;
    this.tilesCacheHits = 0;
    this.tilesCacheMisses = 0;
    if (this.active && this.authValid) {
      this.loadCapabilities(true);
    }
  }

  onClearForecastCaches(): void {
    if (this.clearingForecastCache || this.destroyed) {
      return;
    }
    this.clearingForecastCache = true;
    this.clearCacheSub?.unsubscribe();
    this.clearCacheSub = this.apiService.clearMeteoFranceForecastCaches().pipe(take(1)).subscribe({
      next: () => {
        this.clearingForecastCache = false;
        this.tilesCacheKnown = false;
        this.tilesFromCache = false;
        this.tilesCacheHits = 0;
        this.tilesCacheMisses = 0;
        this.loadCapabilities(true);
      },
      error: () => {
        this.clearingForecastCache = false;
      }
    });
  }

  onMapBaseLayerChange(): void {
    this.applyBaseLayer();
  }

  onDomainChange(domainId: string): void {
    if (!domainId || domainId === this.selectedDomain) {
      return;
    }
    this.selectedDomain = domainId;
    this.selectedLayer = '';
    this.selectedElevation = '';
    this.applyMapBoundsForDomain();
    this.loadCapabilities();
  }

  onReferenceRunChange(runIso: string): void {
    if (!runIso || runIso === this.referenceTime) {
      return;
    }
    this.referenceTime = runIso;
    this.loadCapabilities(true);
  }

  onElevationChange(elevation: string): void {
    this.selectedElevation = elevation || '';
    this.setupWmsLayer();
  }

  onLayerSelect(layerName: string): void {
    this.selectedLayer = layerName;
    this.onLayerChange();
  }

  onLayerChange(): void {
    const layer = this.layers.find((l) => l.name === this.selectedLayer);
    this.selectedStyle = layer?.style || '';
    this.syncElevationsForLayer(layer);
    this.setupWmsLayer();
  }

  onOpacityChange(): void {
    this.wmsLayer?.setOpacity(this.opacity);
  }

  onFrameSliderInput(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    if (!input) {
      return;
    }
    this.onFrameIndexChange(input.valueAsNumber);
  }

  onFrameIndexChange(index: number): void {
    const next = Math.max(0, Math.min(this.timeSteps.length - 1, Math.round(Number(index))));
    if (!Number.isFinite(next) || next === this.frameIndex) {
      return;
    }
    this.frameIndex = next;
    this.setupWmsLayer();
  }

  onStepFrame(delta: number): void {
    this.onFrameIndexChange(this.frameIndex + delta);
  }

  togglePlayback(): void {
    if (this.playing) {
      this.stopPlayback();
      return;
    }
    if (this.timeSteps.length < 2) {
      return;
    }
    this.playing = true;
    this.playTimer = setInterval(() => {
      if (!this.playing || this.destroyed) {
        return;
      }
      const next = this.frameIndex + 1;
      this.frameIndex = next >= this.timeSteps.length ? 0 : next;
      this.setupWmsLayer();
    }, MeteoFranceArpegeTabComponent.PLAY_INTERVAL_MS);
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

  openMapInTraceViewer(): void {
    if (!this.traceViewerModalComponent) {
      return;
    }
    let lat: number;
    let lon: number;
    let zoom: number;
    if (this.map) {
      const center = this.map.getCenter();
      lat = center.lat;
      lon = center.lng;
      zoom = this.map.getZoom();
    } else {
      lat = this.lat;
      lon = this.lon;
      zoom = MeteoFranceArpegeTabComponent.DEFAULT_ZOOM;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return;
    }
    const label = this.translate.instant('METEO_FRANCE.ARPEGE_TITLE');
    this.traceViewerModalComponent.openAtLocation(lat, lon, label, undefined, false, false, {
      zoom,
      initialBaseLayerId: this.localMapBaseLayerId
    });
  }

  formatTime(iso: string): string {
    if (!iso) {
      return '—';
    }
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) {
        return iso;
      }
      return d.toLocaleString(undefined, {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return iso;
    }
  }

  formatClockTime(iso: string): string {
    if (!iso) {
      return '—';
    }
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) {
        return iso;
      }
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  }

  formatOffsetFromNow(iso: string): string {
    if (!iso) {
      return '';
    }
    try {
      const target = new Date(iso).getTime();
      if (Number.isNaN(target)) {
        return '';
      }
      const hours = Math.round((target - Date.now()) / 3_600_000);
      if (hours === 0) {
        return 'H+0';
      }
      return hours > 0 ? `H+${hours}` : `H${hours}`;
    } catch {
      return '';
    }
  }

  formatOffsetMinutes(minutes: number | undefined, withPlusPrefix = false): string {
    if (minutes == null || !Number.isFinite(minutes)) {
      return '—';
    }
    const sign = minutes < 0 ? '-' : '+';
    const abs = Math.abs(Math.round(minutes));
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    const body = m === 0 ? `H${sign}${h}` : `H${sign}${h}h${String(m).padStart(2, '0')}`;
    return withPlusPrefix ? body : body;
  }

  formatLayerLabel(layerName: string): string {
    const key = `METEO_FRANCE.AROMEPI_LAYERS.${layerName}`;
    const translated = this.translate.instant(key);
    if (translated && translated !== key) {
      return translated;
    }
    const layer = this.layers.find((l) => l.name === layerName);
    return layer?.title || layerName.replace(/__/g, ' · ').replace(/_/g, ' ');
  }

  formatPointValue(layer: string, value: unknown): string {
    if (value == null || value === '') {
      return '—';
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Number.isInteger(value) ? String(value) : value.toFixed(1);
    }
    return String(value);
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

  private loadCapabilities(keepSelectedLayer = false): void {
    if (!this.authValid) {
      this.loading = false;
      this.errorKey = this.configured ? 'METEO_FRANCE.ARPEGE_INVALID_TOKEN' : 'METEO_FRANCE.ARPEGE_NOT_CONFIGURED';
      return;
    }
    const requestId = ++this.capsRequestId;
    this.loading = true;
    this.errorKey = '';
    const refForRequest = keepSelectedLayer ? this.referenceTime : undefined;
    this.apiService.getMeteoFranceArpegeCapabilities(this.selectedDomain, refForRequest).pipe(take(1)).subscribe({
      next: (caps) => {
        if (this.destroyed || requestId !== this.capsRequestId) {
          return;
        }
        if (caps?.error) {
          this.loading = false;
          this.errorKey = 'METEO_FRANCE.ARPEGE_LOAD_ERROR';
          return;
        }
        if (caps?.cacheTtlMinutes != null && Number.isFinite(Number(caps.cacheTtlMinutes))) {
          this.forecastCacheTtlMinutes = Number(caps.cacheTtlMinutes);
        }
        if (Array.isArray(caps?.domains) && caps.domains.length) {
          this.domains = caps.domains;
        }
        if (caps?.domain) {
          this.selectedDomain = String(caps.domain);
        }
        this.layers = Array.isArray(caps?.layers) ? caps.layers : [];
        this.timeSteps = Array.isArray(caps?.timeSteps) ? caps.timeSteps : [];
        this.referenceTimes = Array.isArray(caps?.referenceTimes) ? caps.referenceTimes : [];
        this.referenceTime =
          (refForRequest && this.referenceTimes.includes(refForRequest) ? refForRequest : null)
          || caps?.defaultReferenceTime
          || this.referenceTimes[this.referenceTimes.length - 1]
          || '';
        const globalElevations = Array.isArray(caps?.elevations) ? caps.elevations.map(String) : [];
        if (!keepSelectedLayer || !this.selectedLayer || !this.layers.some((l) => l.name === this.selectedLayer)) {
          if (this.layers.length) {
            const precip = this.layers.find((l) => l.category === 'precipitation');
            const cloud = this.layers.find((l) => l.category === 'cloud');
            const temp = this.layers.find((l) => l.category === 'temperature');
            const pick = precip || cloud || temp || this.layers[0];
            this.selectedLayer = pick.name;
            this.selectedStyle = pick.style || '';
          } else {
            this.selectedLayer = '';
            this.selectedStyle = '';
          }
        }
        const selected = this.layers.find((l) => l.name === this.selectedLayer);
        this.syncElevationsForLayer(selected, globalElevations, caps?.defaultElevation);
        if (Number.isFinite(caps?.forecastHorizonMinutes)) {
          this.horizonMinutes = Number(caps.forecastHorizonMinutes);
        }
        if (Number.isFinite(caps?.forecastStepMinutes)) {
          this.stepMinutes = Number(caps.forecastStepMinutes);
        }
        if (Number.isFinite(caps?.forecastStep3hMinutes)) {
          this.step3hMinutes = Number(caps.forecastStep3hMinutes);
        }
        if (Number.isFinite(caps?.forecastHourlyUntilMinutes)) {
          this.hourlyUntilMinutes = Number(caps.forecastHourlyUntilMinutes);
        }
        this.frameIndex = this.findFrameClosestToNow();
        this.loading = false;
        this.applyMapBoundsForDomain();
        this.setupWmsLayer();
        this.loadPointForecast();
        // Re-assert after the player slider mounts (range inputs can clamp to 0 on first paint).
        setTimeout(() => {
          if (this.destroyed) {
            return;
          }
          const closest = this.findFrameClosestToNow();
          if (closest !== this.frameIndex) {
            this.frameIndex = closest;
            this.setupWmsLayer();
          }
        }, 0);
      },
      error: () => {
        if (this.destroyed || requestId !== this.capsRequestId) {
          return;
        }
        this.loading = false;
        this.errorKey = 'METEO_FRANCE.ARPEGE_LOAD_ERROR';
      }
    });
  }

  private loadPointForecast(): void {
    if (!this.authValid || !Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return;
    }
    this.pointForecastSub?.unsubscribe();
    this.pointForecastLoading = true;
    this.pointForecastSub = this.apiService
      .getMeteoFranceArpegePointForecast(
        this.lat,
        this.lon,
        this.referenceTime || undefined,
        undefined,
        this.selectedDomain
      )
      .pipe(take(1))
      .subscribe({
        next: (data) => {
          this.pointForecastLoading = false;
          this.pointForecastLayers = Array.isArray(data?.layers) ? data.layers : [];
          this.pointForecastSteps = Array.isArray(data?.steps) ? data.steps : [];
        },
        error: () => {
          this.pointForecastLoading = false;
          this.pointForecastLayers = [];
          this.pointForecastSteps = [];
        }
      });
  }

  private syncElevationsForLayer(
    layer?: ArpegeLayer,
    globalElevations: string[] = [],
    globalDefault?: string
  ): void {
    const layerElevations = Array.isArray(layer?.elevations) ? layer!.elevations!.map(String) : [];
    this.elevations = layerElevations.length ? layerElevations : globalElevations;
    if (!this.elevations.length) {
      this.selectedElevation = '';
      return;
    }
    const preferred = layer?.defaultElevation || globalDefault || this.selectedElevation;
    this.selectedElevation = preferred && this.elevations.includes(String(preferred))
      ? String(preferred)
      : this.elevations[0];
  }

  /**
   * Pick the forecast step nearest to wall-clock now (not H+0 of the model run).
   * Prefer a slight future step over an equally close past one.
   */
  private findFrameClosestToNow(): number {
    if (!this.timeSteps.length) {
      return 0;
    }
    const nowMs = Date.now();
    let best = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    this.timeSteps.forEach((step, idx) => {
      const t = Date.parse(step);
      if (!Number.isFinite(t)) {
        return;
      }
      const delta = t - nowMs;
      const score = Math.abs(delta) + (delta < 0 ? 30_000 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = idx;
      }
    });
    return best;
  }

  private offsetMinutesBetween(referenceIso: string, timeIso: string): number {
    if (!referenceIso || !timeIso) {
      return 0;
    }
    try {
      const ref = new Date(referenceIso).getTime();
      const t = new Date(timeIso).getTime();
      if (Number.isNaN(ref) || Number.isNaN(t)) {
        return 0;
      }
      return Math.round((t - ref) / 60_000);
    } catch {
      return 0;
    }
  }

  private initMap(): void {
    if (this.map || this.destroyed) {
      return;
    }
    const container = document.getElementById('meteo-france-arpege-map');
    if (!container) {
      this.scheduleLayoutRefresh(120, () => this.initMap());
      return;
    }
    this.map = L.map(container, {
      center: [this.lat, this.lon],
      zoom: MeteoFranceArpegeTabComponent.DEFAULT_ZOOM,
      minZoom: 2,
      maxZoom: 12,
      worldCopyJump: false
    });
    this.applyMapBoundsForDomain();
    this.applyBaseLayer();
    this.updateLocationMarker();
    this.map.on('click', (e: L.LeafletMouseEvent) => this.onMapClick(e));
    this.mapInitialized = true;
    this.scheduleLayoutRefresh(60, () => {
      this.map?.invalidateSize();
      this.setupWmsLayer();
    });
  }

  private applyMapBoundsForDomain(): void {
    if (!this.map) {
      return;
    }
    if (this.selectedDomain === MeteoFranceArpegeTabComponent.DOMAIN_GLOBE) {
      // Leaflet has no clearMaxBounds; widen to world.
      this.map.setMaxBounds([[-85, -180], [85, 180]]);
      this.map.options.maxBoundsViscosity = 0;
      return;
    }
    this.map.setMaxBounds(MeteoFranceArpegeTabComponent.EUROPE_BOUNDS);
    this.map.options.maxBoundsViscosity = 0.7;
  }

  private applyBaseLayer(): void {
    if (!this.map) {
      return;
    }
    this.baseLayer = this.basemapService.applyBaseLayer(this.map, this.localMapBaseLayerId, this.baseLayer);
  }

  private setupWmsLayer(): void {
    if (!this.map || !this.mapInitialized || !this.authValid) {
      return;
    }
    if (!this.selectedLayer || !this.currentTime || !this.referenceTime) {
      return;
    }
    this.tilesCacheHits = 0;
    this.tilesCacheMisses = 0;
    this.setTilesLoading(true);
    // Keep last Live/Cache badge visible until the first sample of this layer arrives.
    const url = this.buildWmsUrl(
      this.selectedLayer,
      this.selectedStyle,
      this.currentTime,
      this.referenceTime
    );
    this.probeTileCacheHint(url);
    if (this.wmsLayer) {
      this.map.removeLayer(this.wmsLayer);
      this.wmsLayer = null;
    }
    const maxNativeZoom = this.selectedDomain === MeteoFranceArpegeTabComponent.DOMAIN_GLOBE ? 7 : 9;
    this.wmsLayer = this.createCacheAwareTileLayer(url, {
      opacity: this.opacity,
      zIndex: 500,
      maxNativeZoom,
      maxZoom: 12,
      updateWhenIdle: true,
      keepBuffer: 1,
      attribution: '&copy; Météo-France ARPEGE (via PatTool)'
    }, (fromCache) => this.applyTileCacheSample(fromCache));
    this.wmsLayer.on('loading', () => this.setTilesLoading(true));
    this.wmsLayer.on('load', () => this.setTilesLoading(false));
    this.wmsLayer.addTo(this.map);
  }

  private createCacheAwareTileLayer(
    url: string,
    options: L.TileLayerOptions,
    onCacheSample: (fromCache: boolean) => void
  ): L.TileLayer {
    const CacheAwareTileLayer = L.TileLayer.extend({
      createTile(coords: L.Coords, done: (error: Error | null, tile?: HTMLElement) => void) {
        const tile = document.createElement('img');
        tile.alt = '';
        (tile as HTMLImageElement & { _patBlobUrl?: string }).crossOrigin = 'anonymous';
        const tileUrl = (this as L.TileLayer).getTileUrl(coords);
        fetch(tileUrl, { cache: 'no-store', credentials: 'same-origin' })
          .then((res) => {
            if (!res.ok) {
              throw new Error(`tile HTTP ${res.status}`);
            }
            const hint = (res.headers.get('X-Pat-Cache') || '').toUpperCase();
            if (hint === 'HIT' || hint === 'MISS') {
              onCacheSample(hint === 'HIT');
            }
            return res.blob();
          })
          .then((blob) => {
            const objectUrl = URL.createObjectURL(blob);
            (tile as HTMLImageElement & { _patBlobUrl?: string })._patBlobUrl = objectUrl;
            tile.onload = () => done(null, tile);
            tile.onerror = () => done(new Error('tile decode failed'), tile);
            tile.src = objectUrl;
          })
          .catch((err: Error) => done(err, tile));
        return tile;
      }
    });
    const tileLayer = new (CacheAwareTileLayer as unknown as {
      new (urlTemplate: string, options?: L.TileLayerOptions): L.TileLayer;
    })(url, options);
    tileLayer.on('tileunload', (e: L.TileEvent) => {
      const img = e.tile as HTMLImageElement & { _patBlobUrl?: string };
      if (img?._patBlobUrl) {
        URL.revokeObjectURL(img._patBlobUrl);
        img._patBlobUrl = undefined;
      }
    });
    return tileLayer;
  }

  private setTilesLoading(loading: boolean): void {
    if (this.tilesLoading === loading || this.destroyed) {
      return;
    }
    this.tilesLoading = loading;
    this.cdr.detectChanges();
  }

  private applyTileCacheSample(fromCache: boolean): void {
    if (fromCache) {
      this.tilesCacheHits++;
    } else {
      this.tilesCacheMisses++;
    }
    const nextFromCache = this.tilesCacheMisses === 0;
    if (!this.tilesCacheKnown || this.tilesFromCache !== nextFromCache) {
      this.tilesCacheKnown = true;
      this.tilesFromCache = nextFromCache;
      this.cdr.detectChanges();
    }
  }

  /** Instant Live/Cache hint via probeOnly (server memory lookup, no MF fetch). */
  private probeTileCacheHint(urlTemplate: string): void {
    const map = this.map;
    if (!map || !urlTemplate || this.destroyed) {
      return;
    }
    const gen = ++this.cacheProbeGen;
    const maxNative = this.selectedDomain === MeteoFranceArpegeTabComponent.DOMAIN_GLOBE ? 7 : 9;
    const z = Math.min(Math.max(0, Math.round(map.getZoom())), maxNative);
    const point = map.project(map.getCenter(), z);
    const x = Math.floor(point.x / 256);
    const y = Math.floor(point.y / 256);
    const tileUrl = L.Util.template(urlTemplate, { s: '', r: '', z, x, y });
    const probeUrl = tileUrl + (tileUrl.includes('?') ? '&' : '?') + 'probeOnly=true';
    fetch(probeUrl, { cache: 'no-store', credentials: 'same-origin' })
      .then((res) => {
        if (this.destroyed || gen !== this.cacheProbeGen) {
          return;
        }
        const hint = (res.headers.get('X-Pat-Cache') || '').toUpperCase();
        if (hint === 'HIT' || hint === 'MISS') {
          this.applyTileCacheSample(hint === 'HIT');
        }
      })
      .catch(() => { /* ignore probe failures */ });
  }

  private buildWmsUrl(layer: string, style: string, time: string, referenceTime: string): string {
    return this.apiService.buildMeteoFranceArpegeWmsTileUrl(
      '{z}', '{x}', '{y}',
      layer,
      time,
      referenceTime,
      style || undefined,
      this.selectedDomain,
      this.selectedElevation || undefined
    );
  }

  private onMapClick(e: L.LeafletMouseEvent): void {
    if (!this.authValid || !this.selectedLayer || !this.currentTime || !this.referenceTime) {
      return;
    }
    this.featureInfoSub?.unsubscribe();
    this.featureInfoLoading = true;
    this.featureInfoValue = null;
    const lat = e.latlng.lat;
    const lon = e.latlng.lng;
    this.featureInfoSub = this.apiService
      .getMeteoFranceArpegeFeatureInfo(
        lat,
        lon,
        this.selectedLayer,
        this.currentTime,
        this.referenceTime,
        this.selectedStyle || undefined,
        this.selectedDomain,
        this.selectedElevation || undefined
      )
      .pipe(take(1))
      .subscribe({
        next: (data) => {
          this.featureInfoLoading = false;
          if (data?.error) {
            this.featureInfoValue = null;
            return;
          }
          const value = data?.value != null ? this.formatPointValue(this.selectedLayer, data.value) : '—';
          this.featureInfoValue = value;
          const html = `<strong>${this.formatLayerLabel(this.selectedLayer)}</strong><br/>`
            + `${this.formatTime(this.currentTime)} · ${this.formatOffsetMinutes(this.currentOffsetMinutes, true)}<br/>`
            + `<span>${value}</span>`;
          if (this.featureInfoPopup) {
            this.map?.closePopup(this.featureInfoPopup);
          }
          this.featureInfoPopup = L.popup()
            .setLatLng(e.latlng)
            .setContent(html)
            .openOn(this.map!);
        },
        error: () => {
          this.featureInfoLoading = false;
          this.featureInfoValue = null;
        }
      });
  }

  private startThrottlePolling(): void {
    this.stopThrottlePolling();
    this.pollThrottle();
    this.throttleTimer = setInterval(() => this.pollThrottle(), MeteoFranceArpegeTabComponent.THROTTLE_POLL_MS);
  }

  private stopThrottlePolling(): void {
    if (this.throttleTimer) {
      clearInterval(this.throttleTimer);
      this.throttleTimer = null;
    }
  }

  private pollThrottle(): void {
    if (!this.authValid || this.destroyed) {
      return;
    }
    this.apiService.getMeteoFranceArpegeThrottle().pipe(take(1)).subscribe({
      next: (status) => {
        const wasThrottled = this.wmsThrottled;
        this.wmsThrottled = !!status?.arpegeWmsThrottled;
        this.wmsRetryAfterSeconds = Number(status?.arpegeWmsRetryAfterSeconds) || 0;
        if (status?.forecastCacheTtlMinutes != null && Number.isFinite(Number(status.forecastCacheTtlMinutes))) {
          this.forecastCacheTtlMinutes = Number(status.forecastCacheTtlMinutes);
        }
        if (this.wmsThrottled && this.wmsRetryAfterSeconds > 0 && !wasThrottled) {
          this.showThrottleBannerBriefly();
        } else if (!this.wmsThrottled && wasThrottled) {
          this.clearThrottleBanner();
        }
      },
      error: () => {
        this.wmsThrottled = false;
        this.wmsRetryAfterSeconds = 0;
        this.clearThrottleBanner();
      }
    });
  }

  private showThrottleBannerBriefly(): void {
    this.throttleBannerVisible = true;
    if (this.throttleBannerTimer != null) {
      clearTimeout(this.throttleBannerTimer);
    }
    this.throttleBannerTimer = setTimeout(() => {
      this.throttleBannerTimer = null;
      this.throttleBannerVisible = false;
      if (!this.destroyed) {
        this.cdr.detectChanges();
      }
    }, 3000);
    this.cdr.detectChanges();
  }

  private clearThrottleBanner(): void {
    if (this.throttleBannerTimer != null) {
      clearTimeout(this.throttleBannerTimer);
      this.throttleBannerTimer = null;
    }
    this.throttleBannerVisible = false;
  }

  private scheduleCacheStatusProbe(): void {
    if (this.cacheProbeTimer) {
      clearTimeout(this.cacheProbeTimer);
    }
    this.cacheProbeTimer = setTimeout(() => {
      this.cacheProbeTimer = null;
      this.pollThrottle();
    }, 500);
  }

  private centerOnInputLocation(animate: boolean): void {
    if (!this.map || !Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return;
    }
    this.map.setView([this.lat, this.lon], this.map.getZoom(), { animate });
    this.updateLocationMarker();
  }

  private updateLocationMarker(): void {
    if (!this.map || !Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return;
    }
    const latLng: L.LatLngExpression = [this.lat, this.lon];
    if (this.locationMarker) {
      this.locationMarker.setLatLng(latLng);
      return;
    }
    this.locationMarker = L.marker(latLng, {
      icon: L.icon({
        iconUrl: 'assets/leaflet/images/marker-icon.png',
        shadowUrl: 'assets/leaflet/images/marker-shadow.png',
        iconSize: [25, 41],
        iconAnchor: [12, 41]
      })
    }).addTo(this.map);
  }

  private stopPlayback(): void {
    this.playing = false;
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
  }

  private destroyMap(): void {
    if (this.wmsLayer && this.map) {
      this.map.removeLayer(this.wmsLayer);
    }
    this.wmsLayer = null;
    this.locationMarker = null;
    this.featureInfoPopup = null;
    if (this.map) {
      this.map.off('click');
      this.map.remove();
      this.map = null;
    }
    this.mapInitialized = false;
  }

  private exitMapFullscreenIfActive(): void {
    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void>;
      webkitFullscreenElement?: Element;
    };
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      const exit = document.exitFullscreen?.bind(document)
        ?? doc.webkitExitFullscreen?.bind(document);
      exit?.().catch(() => undefined);
    }
    if (this.mapFullscreen) {
      this.mapFullscreen = false;
      this.refreshMapLayoutAfterResize();
    }
  }

  private refreshMapLayoutAfterResize(): void {
    this.scheduleLayoutRefresh(120, () => this.map?.invalidateSize());
  }

  private scheduleLayoutRefresh(delayMs: number, action: () => void): void {
    this.clearLayoutTimer();
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = null;
      if (!this.destroyed) {
        action();
      }
    }, delayMs);
  }

  private clearLayoutTimer(): void {
    if (this.layoutTimer) {
      clearTimeout(this.layoutTimer);
      this.layoutTimer = null;
    }
  }
}
