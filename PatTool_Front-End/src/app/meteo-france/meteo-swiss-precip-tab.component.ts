import { Component, Input, OnChanges, OnDestroy, OnInit, SimpleChanges, ViewChild, ElementRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ApiService } from '../services/api.service';
import { LeafletBasemapOption, LeafletBasemapService } from '../shared/leaflet-basemap.service';
import * as L from 'leaflet';
import { Subscription } from 'rxjs';

interface MsPrecipFrame {
  dt: number;
  offsetHours?: number;
  maxMm?: number;
}

@Component({
  selector: 'app-meteo-swiss-precip-tab',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './meteo-swiss-precip-tab.component.html',
  styleUrls: ['./meteo-swiss-precip-tab.component.css']
})
export class MeteoSwissPrecipTabComponent implements OnInit, OnChanges, OnDestroy {

  private static readonly CH_CENTER: L.LatLngExpression = [46.82, 8.23];
  private static readonly CH_ZOOM = 8;
  private static readonly PLAY_INTERVAL_MS = 900;
  private static readonly CACHE_POLL_MS = 5_000;
  private static readonly CACHE_POLL_MAX = 36;

  @Input() horizonHours = 48;
  @Input() active = false;

  @ViewChild('mapShell') mapShell?: ElementRef<HTMLElement>;

  mapFullscreen = false;
  loading = false;
  errorKey = '';
  frames: MsPrecipFrame[] = [];
  frameIndex = 0;
  playing = false;
  opacity = 0.9;
  bounds: L.LatLngBoundsExpression = [[45.82, 5.96], [47.81, 10.49]];
  private readonly mapMaxBounds: L.LatLngBoundsExpression = [[45.4, 5.4], [48.2, 11.0]];
  loadedAt = '';
  itemId = '';

  readonly legendStops = [
    { mm: 0.5, color: '#a6d8ff', label: '< 0.5' },
    { mm: 2, color: '#4da6ff', label: '0.5–2' },
    { mm: 5, color: '#00cc66', label: '2–5' },
    { mm: 10, color: '#ffcc00', label: '5–10' },
    { mm: 20, color: '#ff9900', label: '10–20' },
    { mm: 99, color: '#cc0000', label: '20+' }
  ];

  mapBaseLayerId = 'osm-standard';
  private map: L.Map | null = null;
  private overlay: L.ImageOverlay | null = null;
  private baseLayer: L.TileLayer | L.LayerGroup | null = null;
  private playTimer: ReturnType<typeof setInterval> | null = null;
  private frameObjectUrl: string | null = null;
  private frameRequestId = 0;
  private subs = new Subscription();
  private mapInitialized = false;
  private pendingActivate = false;
  private fitBoundsOnNextFrame = true;
  private userAdjustedMapView = false;
  private destroyed = false;
  private layoutTimer: ReturnType<typeof setTimeout> | null = null;
  private cachePollTimer: ReturnType<typeof setTimeout> | null = null;
  private cachePollCount = 0;
  private capabilitiesRequestId = 0;
  currentFrameDry = false;

  constructor(
    private apiService: ApiService,
    private basemapService: LeafletBasemapService,
    private translate: TranslateService
  ) {}

  ngOnInit(): void {
    if (this.active) {
      this.bootstrap();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['active']?.currentValue === true && !changes['active']?.firstChange) {
      this.activate();
    }
    if (changes['horizonHours'] && this.active && this.mapInitialized) {
      this.loadCapabilities(true);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopCacheWatch();
    this.stopPlayback();
    this.clearLayoutTimer();
    this.exitMapFullscreenIfActive();
    this.revokeFrameUrl();
    this.destroyMap();
    this.subs.unsubscribe();
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

  /** Called by parent when tab becomes visible. */
  activate(): void {
    if (!this.mapInitialized) {
      this.pendingActivate = true;
      this.loading = true;
      this.bootstrap();
      return;
    }
    if (!this.frames.length) {
      this.loadCapabilities();
    }
    this.scheduleLayoutRefresh(120, () => {
      this.map?.invalidateSize();
      if (this.frames.length) {
        if (!this.userAdjustedMapView) {
          this.scheduleFitMapToBounds();
        }
        this.loadCurrentFrame();
      }
    });
  }

  private scheduleLayoutRefresh(delayMs: number, fn?: () => void): void {
    this.clearLayoutTimer();
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = null;
      if (this.destroyed) {
        return;
      }
      if (fn) {
        fn();
        return;
      }
      this.map?.invalidateSize();
    }, delayMs);
  }

  private clearLayoutTimer(): void {
    if (this.layoutTimer) {
      clearTimeout(this.layoutTimer);
      this.layoutTimer = null;
    }
  }

  get currentFrame(): MsPrecipFrame | null {
    return this.frames[this.frameIndex] ?? null;
  }

  get currentTimeLabel(): string {
    const frame = this.currentFrame;
    if (!frame) {
      return '—';
    }
    return new Date(frame.dt * 1000).toLocaleString(undefined, {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  get currentMaxMmLabel(): string {
    const frame = this.currentFrame;
    if (!frame || frame.maxMm == null || frame.maxMm < 0.001) {
      return '';
    }
    const mm = frame.maxMm < 0.1 ? frame.maxMm.toFixed(2) : frame.maxMm.toFixed(1);
    return this.translate.instant('METEO_FRANCE.MS_PRECIP_MAX_MM', { mm });
  }

  get offsetLabel(): string {
    const frame = this.currentFrame;
    if (!frame || frame.offsetHours == null) {
      return '';
    }
    const h = frame.offsetHours;
    if (h <= 0) {
      return this.translate.instant('METEO_FRANCE.MS_PRECIP_NOW');
    }
    return this.translate.instant('METEO_FRANCE.MS_PRECIP_OFFSET_H', { hours: h });
  }

  get availableMapBaseLayers(): LeafletBasemapOption[] {
    return this.basemapService.getAvailableLayers();
  }

  getMapBaseLayerLabel(layer: LeafletBasemapOption): string {
    return layer.labelKey ? this.translate.instant(layer.labelKey) : layer.label;
  }

  onMapBaseLayerChange(): void {
    if (!this.map) {
      return;
    }
    this.baseLayer = this.basemapService.applyBaseLayer(this.map, this.mapBaseLayerId, this.baseLayer);
    this.bringPrecipOverlayToFront();
  }

  onFrameIndexChange(index: number): void {
    const max = Math.max(0, this.frames.length - 1);
    this.frameIndex = Math.max(0, Math.min(max, Math.round(index)));
    this.currentFrameDry = this.isFrameDry(this.currentFrame);
    if (this.playing) {
      this.stopPlayback();
    }
    this.loadCurrentFrame();
  }

  togglePlayback(): void {
    if (this.playing) {
      this.stopPlayback();
      return;
    }
    if (this.frames.length < 2) {
      return;
    }
    this.playing = true;
    this.playTimer = setInterval(() => this.advanceFrame(), MeteoSwissPrecipTabComponent.PLAY_INTERVAL_MS);
    this.advanceFrame();
  }

  refresh(): void {
    this.fitBoundsOnNextFrame = true;
    this.userAdjustedMapView = false;
    this.loadCapabilities(true);
  }

  focusSwitzerland(): void {
    this.fitBoundsOnNextFrame = true;
    this.userAdjustedMapView = false;
    this.fitMapToBounds();
  }

  onOpacityChange(): void {
    if (this.overlay) {
      this.overlay.setOpacity(this.opacity);
      this.bringPrecipOverlayToFront();
    }
  }

  private bootstrap(): void {
    this.scheduleLayoutRefresh(0, () => {
      this.initMap();
      this.loadCapabilities(true);
    });
  }

  private initMap(): void {
    if (this.mapInitialized) {
      return;
    }
    const container = document.getElementById('meteo-swiss-precip-map');
    if (!container) {
      return;
    }
    this.map = L.map(container, {
      center: MeteoSwissPrecipTabComponent.CH_CENTER,
      zoom: MeteoSwissPrecipTabComponent.CH_ZOOM,
      zoomControl: true,
      maxBounds: this.mapMaxBounds,
      maxBoundsViscosity: 0.85,
      minZoom: 6
    });
    this.baseLayer = this.basemapService.applyBaseLayer(this.map, this.mapBaseLayerId, this.baseLayer);
    this.map.on('zoomend dragend', () => {
      this.userAdjustedMapView = true;
    });
    this.mapInitialized = true;
    if (this.pendingActivate) {
      this.pendingActivate = false;
      this.scheduleLayoutRefresh(100);
    }
  }

  private destroyMap(): void {
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    this.overlay = null;
    this.mapInitialized = false;
  }

  private loadCapabilities(force = false): void {
    if (!force && this.loading) {
      return;
    }
    this.stopCacheWatch();
    const requestId = ++this.capabilitiesRequestId;
    this.loading = true;
    this.errorKey = '';
    this.subs.add(
      this.apiService.getMeteoSwissPrecipCapabilities(this.horizonHours).subscribe({
        next: (caps) => {
          if (requestId !== this.capabilitiesRequestId || this.destroyed) {
            return;
          }
          if (caps?.error) {
            const errorKey = this.resolveErrorKey(String(caps.error));
            if (errorKey === 'METEO_FRANCE.MS_PRECIP_LOADING') {
              this.frames = [];
              this.startCacheWatch();
              return;
            }
            this.loading = false;
            this.errorKey = errorKey;
            this.frames = [];
            return;
          }
          this.loading = false;
          const south = Number(caps.south);
          const north = Number(caps.north);
          const west = Number(caps.west);
          const east = Number(caps.east);
          if ([south, north, west, east].every(Number.isFinite)) {
            this.bounds = [[south, west], [north, east]];
          }
          this.loadedAt = caps.loadedAt ?? '';
          this.itemId = caps.itemId ?? '';
          this.frames = Array.isArray(caps.frames) ? caps.frames : [];
          this.frameIndex = 0;
          if (!this.frames.length) {
            this.errorKey = 'METEO_FRANCE.MS_PRECIP_EMPTY';
            return;
          }
          this.currentFrameDry = this.isFrameDry(this.frames[0]);
          this.fitBoundsOnNextFrame = true;
          this.scheduleFitMapToBounds();
          this.loadCurrentFrame();
        },
        error: () => {
          if (requestId !== this.capabilitiesRequestId || this.destroyed) {
            return;
          }
          this.loading = false;
          this.errorKey = 'METEO_FRANCE.MS_PRECIP_ERROR';
        }
      })
    );
  }

  private startCacheWatch(): void {
    if (this.cachePollTimer) {
      return;
    }
    this.cachePollCount = 0;
    this.pollCacheStatus();
  }

  private pollCacheStatus(): void {
    if (this.destroyed || !this.active) {
      this.stopCacheWatch();
      return;
    }
    this.cachePollCount++;
    if (this.cachePollCount > MeteoSwissPrecipTabComponent.CACHE_POLL_MAX) {
      this.loading = false;
      this.errorKey = 'METEO_FRANCE.MS_PRECIP_LOADING';
      this.stopCacheWatch();
      return;
    }
    this.subs.add(
      this.apiService.getMeteoSwissStatus().subscribe({
        next: (status) => this.handleCacheStatus(status),
        error: () => this.scheduleCachePoll()
      })
    );
  }

  private handleCacheStatus(status: any): void {
    const precipReady = status?.ready && (status?.precipFrameCount ?? 0) > 0;
    if (precipReady) {
      this.stopCacheWatch();
      this.loadCapabilities(true);
      return;
    }
    if (status?.ready && !status?.loading && (status?.precipFrameCount ?? 0) <= 0) {
      this.loading = false;
      this.errorKey = 'METEO_FRANCE.MS_PRECIP_EMPTY';
      this.stopCacheWatch();
      return;
    }
    if (!status?.loading && status?.lastError) {
      this.loading = false;
      this.errorKey = 'METEO_FRANCE.MS_PRECIP_ERROR';
      this.stopCacheWatch();
      return;
    }
    this.scheduleCachePoll();
  }

  private scheduleCachePoll(): void {
    this.clearCachePollTimer();
    this.cachePollTimer = setTimeout(() => {
      this.cachePollTimer = null;
      this.pollCacheStatus();
    }, MeteoSwissPrecipTabComponent.CACHE_POLL_MS);
  }

  private stopCacheWatch(): void {
    this.clearCachePollTimer();
    this.cachePollCount = 0;
  }

  private clearCachePollTimer(): void {
    if (this.cachePollTimer) {
      clearTimeout(this.cachePollTimer);
      this.cachePollTimer = null;
    }
  }

  private loadCurrentFrame(): void {
    const frame = this.currentFrame;
    if (!frame || !this.map) {
      return;
    }
    const requestId = ++this.frameRequestId;
    this.currentFrameDry = false;
    this.subs.add(
      this.apiService.getMeteoSwissPrecipFrame(frame.dt).subscribe({
        next: (blob) => {
          if (requestId !== this.frameRequestId || !this.map) {
            return;
          }
          this.currentFrameDry = this.isFrameDry(frame);
          if (!blob || blob.size < 50) {
            if (this.overlay) {
              this.map.removeLayer(this.overlay);
              this.overlay = null;
            }
            this.revokeFrameUrl();
            this.errorKey = 'METEO_FRANCE.MS_PRECIP_FRAME_ERROR';
            return;
          }
          this.revokeFrameUrl();
          this.frameObjectUrl = URL.createObjectURL(blob);
          if (this.overlay) {
            this.map.removeLayer(this.overlay);
          }
          this.overlay = L.imageOverlay(this.frameObjectUrl, this.bounds, {
            opacity: this.opacity,
            interactive: false,
            zIndex: 500,
            className: 'ms-precip-overlay'
          });
          this.overlay.addTo(this.map);
          this.bringPrecipOverlayToFront();
          this.map.invalidateSize();
          if (this.fitBoundsOnNextFrame && !this.userAdjustedMapView) {
            this.fitMapToBounds();
            this.fitBoundsOnNextFrame = false;
          }
        },
        error: () => {
          if (requestId === this.frameRequestId) {
            this.errorKey = 'METEO_FRANCE.MS_PRECIP_FRAME_ERROR';
          }
        }
      })
    );
  }

  private advanceFrame(): void {
    if (!this.frames.length) {
      return;
    }
    this.frameIndex = (this.frameIndex + 1) % this.frames.length;
    this.loadCurrentFrame();
  }

  private stopPlayback(): void {
    this.playing = false;
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
  }

  private resolveErrorKey(message: string): string {
    const lower = message.toLowerCase();
    if (lower.includes('loading')) {
      return 'METEO_FRANCE.MS_PRECIP_LOADING';
    }
    if (lower.includes('empty') || lower.includes('no precipitation')) {
      return 'METEO_FRANCE.MS_PRECIP_EMPTY';
    }
    return 'METEO_FRANCE.MS_PRECIP_ERROR';
  }

  private bringPrecipOverlayToFront(): void {
    this.overlay?.bringToFront();
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
    this.scheduleLayoutRefresh(120);
  }

  private isFrameDry(frame: MsPrecipFrame | null): boolean {
    if (!frame) {
      return false;
    }
    const maxMm = typeof frame.maxMm === 'number' ? frame.maxMm : null;
    return maxMm != null && maxMm < 0.001;
  }

  private fitMapToBounds(): void {
    if (!this.map) {
      return;
    }
    this.map.fitBounds(this.bounds, {
      padding: [24, 24],
      maxZoom: 9,
      animate: false
    });
  }

  private scheduleFitMapToBounds(): void {
    this.scheduleLayoutRefresh(160, () => {
      this.map?.invalidateSize();
      if (!this.userAdjustedMapView) {
        this.fitMapToBounds();
      }
    });
  }

  private revokeFrameUrl(): void {
    if (this.frameObjectUrl) {
      URL.revokeObjectURL(this.frameObjectUrl);
      this.frameObjectUrl = null;
    }
  }
}
