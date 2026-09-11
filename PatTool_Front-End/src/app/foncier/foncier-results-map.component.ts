import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import * as L from 'leaflet';

import { LeafletBasemapOption, LeafletBasemapService } from '../shared/leaflet-basemap.service';
import { ApiService } from '../services/api.service';

export interface FoncierMapPoint {
  id: string;
  lat: number;
  lon: number;
  label: string;
  number?: number;
}

@Component({
  selector: 'app-foncier-results-map',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './foncier-results-map.component.html',
  styleUrls: ['./foncier-results-map.component.css']
})
export class FoncierResultsMapComponent implements AfterViewInit, OnChanges, OnDestroy {

  @Input() points: FoncierMapPoint[] = [];
  @Input() centerLat: number | null | undefined;
  @Input() centerLon: number | null | undefined;
  @Input() selectedId: string | null = null;
  @Input() defaultLayerId = 'osm-standard';
  @Output() pointSelect = new EventEmitter<string>();

  @ViewChild('mapShell') mapShell?: ElementRef<HTMLElement>;
  @ViewChild('mapHost') mapHost?: ElementRef<HTMLDivElement>;

  mapBaseLayerId = 'osm-standard';
  mapFullscreen = false;
  mapFullscreenCssFallback = false;

  private map?: L.Map;
  private baseLayer: L.TileLayer | L.LayerGroup | null = null;
  private mapLayer?: L.FeatureGroup;
  private markers = new Map<string, L.CircleMarker>();
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    private readonly basemap: LeafletBasemapService,
    private readonly api: ApiService,
    private readonly ngZone: NgZone,
    private readonly cdr: ChangeDetectorRef
  ) {}

  get basemapOptions(): LeafletBasemapOption[] {
    return this.basemap.getAvailableLayers();
  }

  ngAfterViewInit(): void {
    this.basemap.loadOptionalLayers(this.api);
    if (this.basemap.isValidLayerId(this.defaultLayerId)) {
      this.mapBaseLayerId = this.defaultLayerId;
    }
    setTimeout(() => this.ensureMap(), 0);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.map) {
      return;
    }
    if (changes['points'] || changes['centerLat'] || changes['centerLon']) {
      this.refreshMarkers(true);
    } else if (changes['selectedId']) {
      this.syncSelectedMarker();
    }
  }

  ngOnDestroy(): void {
    this.exitMapFullscreen();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.map?.remove();
    this.map = undefined;
  }

  onBasemapChange(): void {
    if (!this.map) {
      return;
    }
    this.baseLayer = this.basemap.applyBaseLayer(this.map, this.mapBaseLayerId, this.baseLayer);
  }

  toggleMapFullscreen(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const shell = this.mapShell?.nativeElement;
    if (!shell) {
      return;
    }
    if (this.mapFullscreen) {
      this.exitMapFullscreen();
      return;
    }
    const request = shell.requestFullscreen?.bind(shell)
      ?? (shell as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> })
        .webkitRequestFullscreen?.bind(shell);
    if (!request) {
      this.mapFullscreenCssFallback = true;
      this.mapFullscreen = true;
      this.refreshMapAfterResize();
      return;
    }
    request().catch(() => {
      this.mapFullscreenCssFallback = true;
      this.mapFullscreen = true;
      this.refreshMapAfterResize();
    });
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  onMapFullscreenChange(): void {
    const shell = this.mapShell?.nativeElement;
    const doc = document as Document & { webkitFullscreenElement?: Element };
    const active = !!(shell && (document.fullscreenElement === shell || doc.webkitFullscreenElement === shell));
    if (this.mapFullscreen === active && !this.mapFullscreenCssFallback) {
      return;
    }
    if (!active) {
      this.mapFullscreenCssFallback = false;
    }
    this.mapFullscreen = active || this.mapFullscreenCssFallback;
    this.refreshMapAfterResize();
  }

  @HostListener('document:keydown.escape')
  onMapFullscreenEscape(): void {
    if (this.mapFullscreen) {
      this.exitMapFullscreen();
    }
  }

  private exitMapFullscreen(): void {
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void> };
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(document);
      exit?.().catch(() => {
        this.mapFullscreen = false;
        this.mapFullscreenCssFallback = false;
        this.refreshMapAfterResize();
      });
      return;
    }
    if (this.mapFullscreen) {
      this.mapFullscreen = false;
      this.mapFullscreenCssFallback = false;
      this.refreshMapAfterResize();
    }
  }

  private refreshMapAfterResize(): void {
    setTimeout(() => this.map?.invalidateSize(), 120);
  }

  private ensureMap(): void {
    const el = this.mapHost?.nativeElement;
    if (!el) {
      return;
    }
    if (this.map) {
      this.map.invalidateSize();
      this.refreshMarkers(false);
      return;
    }
    this.map = L.map(el, {
      zoomControl: true,
      attributionControl: true
    });
    this.baseLayer = this.basemap.applyBaseLayer(this.map, this.mapBaseLayerId, null);
    this.mapLayer = L.featureGroup().addTo(this.map);
    this.setFallbackView();
    this.blockOverlayMapClicks();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.map?.invalidateSize());
      this.resizeObserver.observe(el);
    }
    setTimeout(() => {
      this.map?.invalidateSize();
      this.refreshMarkers(true);
    }, 0);
  }

  private blockOverlayMapClicks(): void {
    const shell = this.mapShell?.nativeElement;
    if (!shell) {
      return;
    }
    shell.querySelectorAll('.foncier-basemap, .foncier-map-fs-btn').forEach((node) => {
      L.DomEvent.disableClickPropagation(node as HTMLElement);
      L.DomEvent.disableScrollPropagation(node as HTMLElement);
    });
  }

  private refreshMarkers(fitMap: boolean): void {
    if (!this.map || !this.mapLayer) {
      return;
    }
    this.mapLayer.clearLayers();
    this.markers.clear();
    const mapped = this.points.filter((point) =>
      Number.isFinite(point.lat) && Number.isFinite(point.lon));
    for (const point of mapped) {
      const marker = L.circleMarker([point.lat, point.lon], this.markerStyle(point.id));
      marker.bindTooltip(this.escapeHtml(point.label), {
        direction: 'top',
        offset: [0, -8],
        opacity: 0.95,
        className: 'foncier-map-tooltip'
      });
      marker.on('click', (event) => {
        L.DomEvent.stop(event);
        this.ngZone.run(() => this.pointSelect.emit(point.id));
      });
      marker.addTo(this.mapLayer);
      this.markers.set(point.id, marker);
    }
    if (fitMap) {
      this.fitToContent(mapped);
    } else {
      this.syncSelectedMarker();
    }
    this.cdr.markForCheck();
  }

  private fitToContent(mapped: FoncierMapPoint[]): void {
    if (!this.map) {
      return;
    }
    if (mapped.length === 1) {
      this.map.setView([mapped[0].lat, mapped[0].lon], 15);
      this.syncSelectedMarker();
      return;
    }
    if (mapped.length > 1) {
      const bounds = L.latLngBounds(mapped.map((point) => [point.lat, point.lon] as L.LatLngTuple));
      this.map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
      this.syncSelectedMarker();
      return;
    }
    this.setFallbackView();
  }

  private setFallbackView(): void {
    if (!this.map) {
      return;
    }
    if (Number.isFinite(this.centerLat) && Number.isFinite(this.centerLon)) {
      this.map.setView([this.centerLat as number, this.centerLon as number], 13);
      return;
    }
    this.map.setView([46.2, 2.2], 6);
  }

  private syncSelectedMarker(): void {
    this.markers.forEach((marker, id) => {
      marker.setStyle(this.markerStyle(id));
      if (id === this.selectedId) {
        marker.bringToFront();
      }
    });
  }

  private markerStyle(id: string) {
    const selected = !!this.selectedId && id === this.selectedId;
    return {
      radius: selected ? 10 : 7,
      weight: selected ? 2 : 1,
      color: '#fff',
      fillColor: selected ? '#1d4ed8' : '#4d7c0f',
      fillOpacity: 0.92
    };
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
