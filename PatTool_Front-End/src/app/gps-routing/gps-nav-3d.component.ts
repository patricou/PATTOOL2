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
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Map as MapLibreMap, Marker, NavigationControl } from 'maplibre-gl';
import { OpenRouteStep } from '../services/api.service';
import { environment } from '../../environments/environment';
import { GpsMapOrientation } from '../shared/gps-map-orientation';

/**
 * GPS-style 3D navigation using MapLibre (pitched map + bearing).
 * Route is drawn as an SVG overlay (map.project) so it does not depend on
 * MapLibre's GeoJSON worker, which is fragile under Angular + CSP.
 */
@Component({
  selector: 'app-gps-nav-3d',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './gps-nav-3d.component.html',
  styleUrls: ['./gps-nav-3d.component.css']
})
export class GpsNav3dComponent implements AfterViewInit, OnChanges, OnDestroy {

  @ViewChild('canvasHost') canvasHost?: ElementRef<HTMLDivElement>;
  @ViewChild('nav3dRoot') nav3dRoot?: ElementRef<HTMLDivElement>;
  @ViewChild('routeCasing') routeCasing?: ElementRef<SVGPolylineElement>;
  @ViewChild('routeDone') routeDone?: ElementRef<SVGPolylineElement>;
  @ViewChild('routeRemain') routeRemain?: ElementRef<SVGPolylineElement>;

  @Input() coordinates: number[][] = [];
  @Input() steps: OpenRouteStep[] = [];
  @Input() orientation: GpsMapOrientation = 'heading';
  /** When true, camera recenters on the user every 5 seconds. */
  @Input() followUser = false;

  @Output() closed = new EventEmitter<void>();

  nextInstruction = '';
  distanceToNextM: number | null = null;
  remainingDistanceM: number | null = null;
  userSpeedKmh: number | null = null;
  statusKey = 'GPS_ROUTING.NAV3D_LOCATING';
  hasFix = false;
  /** MapLibre zoom level (typically 3–20). */
  zoomLevel = 16;
  fullscreen = false;

  private readonly tileApiBase = `${environment.API_URL}external/map/tile`;
  private readonly snapDistanceM = 120;
  private readonly zoomMin = 5;
  private readonly zoomMax = 20;
  private readonly pitch = 62;
  /** Max vertices projected per frame for SVG performance. */
  private readonly overlayMaxPoints = 800;
  private readonly followIntervalMs = 5000;

  private map?: MapLibreMap;
  private userMarker?: Marker;
  private resizeObserver?: ResizeObserver;
  private watchId: number | null = null;
  private followIntervalId: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private mapReady = false;
  private onRender?: () => void;

  private userLat = 0;
  private userLon = 0;
  private viewSnapLat = 0;
  private viewSnapLon = 0;
  private userHeadingDeg = 0;
  private hasGpsHeading = false;
  private routeHeadingDeg = 0;
  private nearestIndex = 0;
  private cumulativeDistances: number[] = [];
  private routeCoords: number[][] = []; // [lat, lon, ele?]

  constructor(
    private readonly ngZone: NgZone,
    private readonly cdr: ChangeDetectorRef,
    private readonly translate: TranslateService
  ) {}

  ngAfterViewInit(): void {
    this.rebuildRouteMeta();
    this.initMap();
    this.fallbackToRouteStart();
    this.startGeolocation();
    setTimeout(() => this.map?.resize(), 80);
    setTimeout(() => this.map?.resize(), 300);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['coordinates'] && !changes['coordinates'].firstChange) {
      this.rebuildRouteMeta();
      this.paintRouteOverlay();
      if (!this.hasFix) {
        this.fallbackToRouteStart();
      } else {
        this.updateNavigationState();
        if (this.followUser) {
          this.syncCamera(false);
        } else {
          this.syncUserMarkerOnly();
        }
      }
    }
    if (changes['orientation'] && !changes['orientation'].firstChange) {
      if (this.followUser) {
        this.syncCamera(true);
      }
    }
    if (changes['followUser'] && !changes['followUser'].firstChange) {
      this.syncFollowInterval();
      if (this.followUser) {
        this.syncCamera(true);
      }
    }
  }

  ngOnDestroy(): void {
    this.teardown();
  }

  close(): void {
    this.exitFullscreenIfActive();
    this.closed.emit();
  }

  zoomIn(): void {
    if (!this.map) {
      return;
    }
    this.map.zoomIn({ duration: 200 });
  }

  zoomOut(): void {
    if (!this.map) {
      return;
    }
    this.map.zoomOut({ duration: 200 });
  }

  resetZoom(): void {
    if (!this.map) {
      return;
    }
    this.map.easeTo({ zoom: 16, duration: 250 });
  }

  get canZoomIn(): boolean {
    return this.zoomLevel < this.zoomMax - 0.05;
  }

  get canZoomOut(): boolean {
    return this.zoomLevel > this.zoomMin + 0.05;
  }

  toggleFullscreen(): void {
    const root = this.nav3dRoot?.nativeElement;
    if (!root) {
      return;
    }
    if (this.fullscreen) {
      this.exitFullscreenIfActive();
      return;
    }
    const request = root.requestFullscreen?.bind(root)
      ?? (root as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(root);
    request?.().catch(() => {
      this.fullscreen = true;
      this.cdr.detectChanges();
      setTimeout(() => this.map?.resize(), 80);
    });
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  onFullscreenChange(): void {
    const root = this.nav3dRoot?.nativeElement;
    const doc = document as Document & { webkitFullscreenElement?: Element };
    const active = !!(root && (document.fullscreenElement === root || doc.webkitFullscreenElement === root));
    if (this.fullscreen !== active) {
      this.fullscreen = active;
      this.cdr.detectChanges();
    }
    setTimeout(() => this.map?.resize(), 100);
  }

  formatDistance(meters?: number | null): string {
    if (meters == null || !Number.isFinite(meters)) {
      return '—';
    }
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} km`;
    }
    return `${Math.round(meters)} m`;
  }

  private rebuildRouteMeta(): void {
    this.routeCoords = (this.coordinates || []).filter(
      (c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])
    );
    this.cumulativeDistances = [0];
    let along = 0;
    for (let i = 1; i < this.routeCoords.length; i++) {
      along += this.haversineM(
        this.routeCoords[i - 1][0],
        this.routeCoords[i - 1][1],
        this.routeCoords[i][0],
        this.routeCoords[i][1]
      );
      this.cumulativeDistances.push(along);
    }
    this.updateRouteHeading();
  }

  private haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const r = 6_371_000;
    const p1 = lat1 * Math.PI / 180;
    const p2 = lat2 * Math.PI / 180;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
    return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  private initMap(): void {
    const host = this.canvasHost?.nativeElement;
    if (!host || !this.routeCoords.length) {
      return;
    }
    const start = this.routeCoords[0];
    const tileUrl = `${this.tileApiBase}/{z}/{x}/{y}?style=voyager`;

    this.ngZone.runOutsideAngular(() => {
      const map = new MapLibreMap({
        container: host,
        style: {
          version: 8,
          sources: {
            basemap: {
              type: 'raster',
              tiles: [tileUrl],
              tileSize: 256,
              attribution: '© OpenStreetMap © CARTO',
              maxzoom: 19
            }
          },
          layers: [
            {
              id: 'basemap',
              type: 'raster',
              source: 'basemap'
            }
          ]
        },
        center: [start[1], start[0]],
        zoom: 16,
        pitch: this.pitch,
        bearing: 0,
        minZoom: this.zoomMin,
        maxZoom: this.zoomMax,
        attributionControl: false,
        dragRotate: true,
        pitchWithRotate: true
      });
      this.map = map;

      map.addControl(new NavigationControl({
        visualizePitch: true,
        showCompass: true,
        showZoom: false
      }), 'top-right');

      const onReady = () => {
        if (this.disposed || !this.map) {
          return;
        }
        this.mapReady = true;
        this.ensureUserMarker();
        this.syncCamera(false);
        this.paintRouteOverlay();
        this.ngZone.run(() => this.cdr.detectChanges());
      };

      if (map.loaded()) {
        onReady();
      } else {
        map.once('load', onReady);
      }

      this.onRender = () => this.paintRouteOverlay();
      map.on('render', this.onRender);

      map.on('zoom', () => {
        if (!this.map) {
          return;
        }
        this.zoomLevel = Math.round(this.map.getZoom() * 10) / 10;
        this.ngZone.run(() => this.cdr.detectChanges());
      });
    });

    this.resizeObserver = new ResizeObserver(() => this.map?.resize());
    this.resizeObserver.observe(host);
  }

  /**
   * Project route lat/lon onto screen via MapLibre and update SVG polylines.
   * Works with pitch/bearing; no GeoJSON worker required.
   */
  private paintRouteOverlay(): void {
    const map = this.map;
    if (!map || !this.mapReady || !this.routeCoords.length) {
      return;
    }
    const fullPts = this.projectCoords(this.routeCoords);
    const remainPts = this.projectCoords(this.routeCoords.slice(Math.max(0, this.nearestIndex)));
    this.routeCasing?.nativeElement?.setAttribute('points', fullPts);
    this.routeDone?.nativeElement?.setAttribute('points', fullPts);
    this.routeRemain?.nativeElement?.setAttribute('points', remainPts);
  }

  private projectCoords(coords: number[][]): string {
    const map = this.map;
    if (!map || coords.length < 1) {
      return '';
    }
    const step = Math.max(1, Math.ceil(coords.length / this.overlayMaxPoints));
    const parts: string[] = [];
    for (let i = 0; i < coords.length; i += step) {
      const c = coords[i];
      const p = map.project([c[1], c[0]]);
      parts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    }
    // Always include last point so the line reaches the destination.
    if ((coords.length - 1) % step !== 0) {
      const last = coords[coords.length - 1];
      const p = map.project([last[1], last[0]]);
      parts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    }
    return parts.join(' ');
  }

  private ensureUserMarker(): void {
    if (!this.map || this.userMarker) {
      return;
    }
    const el = document.createElement('div');
    el.className = 'gps-nav3d-user-marker';
    el.innerHTML = '<div class="gps-nav3d-user-marker-arrow"></div>';
    this.userMarker = new Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' })
      .setLngLat([this.userLon || this.routeCoords[0]?.[1] || 0, this.userLat || this.routeCoords[0]?.[0] || 0])
      .addTo(this.map);
  }

  private startGeolocation(): void {
    if (!navigator.geolocation) {
      this.statusKey = 'GPS_ROUTING.GEOLOCATION_UNSUPPORTED';
      this.cdr.detectChanges();
      this.fallbackToRouteStart();
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.ngZone.run(() => {
          this.hasFix = true;
          this.statusKey = 'GPS_ROUTING.NAV3D_FOLLOWING';
          this.userLat = pos.coords.latitude;
          this.userLon = pos.coords.longitude;
          this.userSpeedKmh = pos.coords.speed != null && pos.coords.speed >= 0
            ? pos.coords.speed * 3.6
            : null;
          if (pos.coords.heading != null && Number.isFinite(pos.coords.heading) && pos.coords.speed != null && pos.coords.speed > 0.8) {
            this.userHeadingDeg = pos.coords.heading;
            this.hasGpsHeading = true;
          }
          this.updateNavigationState();
          this.syncUserMarkerOnly();
          this.cdr.detectChanges();
        });
      },
      () => {
        this.ngZone.run(() => {
          if (!this.hasFix) {
            this.statusKey = 'GPS_ROUTING.NAV3D_NO_FIX';
            this.fallbackToRouteStart();
            this.cdr.detectChanges();
          }
        });
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
    this.syncFollowInterval();
  }

  private syncFollowInterval(): void {
    if (this.followUser) {
      this.startFollowInterval();
    } else {
      this.stopFollowInterval();
    }
  }

  private startFollowInterval(): void {
    if (this.followIntervalId != null || this.disposed) {
      return;
    }
    if (this.mapReady) {
      this.syncCamera(true);
    }
    this.followIntervalId = setInterval(() => {
      if (this.disposed || !this.followUser || !this.mapReady) {
        return;
      }
      this.syncCamera(true);
    }, this.followIntervalMs);
  }

  private stopFollowInterval(): void {
    if (this.followIntervalId != null) {
      clearInterval(this.followIntervalId);
      this.followIntervalId = null;
    }
  }

  private syncUserMarkerOnly(): void {
    if (!this.map || !this.mapReady) {
      return;
    }
    const markerHeading = this.hasGpsHeading ? this.userHeadingDeg : this.routeHeadingDeg;
    this.userMarker?.setLngLat([this.viewSnapLon, this.viewSnapLat]);
    this.userMarker?.setRotation(markerHeading);
  }

  private fallbackToRouteStart(): void {
    if (!this.routeCoords.length) {
      return;
    }
    const start = this.routeCoords[0];
    this.userLat = start[0];
    this.userLon = start[1];
    this.viewSnapLat = start[0];
    this.viewSnapLon = start[1];
    this.nearestIndex = 0;
    this.hasGpsHeading = false;
    this.updateRouteHeading();
    this.userHeadingDeg = this.routeHeadingDeg;
    this.updateNavigationState();
    this.syncCamera(false);
  }

  private updateNavigationState(): void {
    if (!this.routeCoords.length) {
      return;
    }
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.routeCoords.length; i++) {
      const d = this.haversineM(this.userLat, this.userLon, this.routeCoords[i][0], this.routeCoords[i][1]);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    this.nearestIndex = bestI;
    this.updateRouteHeading();
    this.paintRouteOverlay();

    const total = this.cumulativeDistances[this.cumulativeDistances.length - 1] || 0;
    const done = this.cumulativeDistances[bestI] || 0;
    this.remainingDistanceM = Math.max(0, total - done);

    let stepAlong = 0;
    let next: OpenRouteStep | null = null;
    let distToNext = 0;
    for (const step of this.steps || []) {
      const stepDist = step.distanceMeters || 0;
      if (stepAlong + stepDist > done + 2) {
        next = step;
        distToNext = stepAlong + stepDist - done;
        break;
      }
      stepAlong += stepDist;
    }
    if (!next && this.steps?.length) {
      next = this.steps[this.steps.length - 1];
      distToNext = this.remainingDistanceM;
    }
    this.nextInstruction = next?.instruction || next?.name || this.translate.instant('GPS_ROUTING.NAV3D_ARRIVE');
    this.distanceToNextM = distToNext;

    this.viewSnapLat = bestD > this.snapDistanceM ? this.routeCoords[bestI][0] : this.userLat;
    this.viewSnapLon = bestD > this.snapDistanceM ? this.routeCoords[bestI][1] : this.userLon;
  }

  private updateRouteHeading(): void {
    if (this.routeCoords.length < 2) {
      return;
    }
    const i = Math.min(this.nearestIndex, this.routeCoords.length - 2);
    const a = this.routeCoords[i];
    const b = this.routeCoords[i + 1];
    const lat1 = a[0] * Math.PI / 180;
    const lat2 = b[0] * Math.PI / 180;
    const dLon = (b[1] - a[1]) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    this.routeHeadingDeg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    if (!this.hasGpsHeading) {
      this.userHeadingDeg = this.routeHeadingDeg;
    }
  }

  private cameraBearing(): number {
    if (this.orientation === 'north') {
      return 0;
    }
    if (this.orientation === 'route') {
      return this.routeHeadingDeg;
    }
    return this.hasGpsHeading ? this.userHeadingDeg : this.routeHeadingDeg;
  }

  private syncCamera(animate: boolean): void {
    if (!this.map || !this.mapReady) {
      return;
    }
    const bearing = this.cameraBearing();
    const markerHeading = this.hasGpsHeading ? this.userHeadingDeg : this.routeHeadingDeg;
    this.userMarker?.setLngLat([this.viewSnapLon, this.viewSnapLat]);
    this.userMarker?.setRotation(markerHeading);

    const opts = {
      center: [this.viewSnapLon, this.viewSnapLat] as [number, number],
      bearing,
      pitch: this.pitch,
      duration: animate ? 400 : 0,
      essential: true
    };
    if (animate) {
      this.map.easeTo(opts);
    } else {
      this.map.jumpTo({
        center: opts.center,
        bearing: opts.bearing,
        pitch: opts.pitch
      });
    }
    this.zoomLevel = Math.round(this.map.getZoom() * 10) / 10;
    this.paintRouteOverlay();
  }

  private exitFullscreenIfActive(): void {
    const doc = document as Document & {
      webkitFullscreenElement?: Element;
      webkitExitFullscreen?: () => Promise<void>;
    };
    const root = this.nav3dRoot?.nativeElement;
    const activeEl = document.fullscreenElement || doc.webkitFullscreenElement;
    if (root && activeEl === root) {
      const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(document);
      exit?.().catch(() => {
        this.fullscreen = false;
        this.cdr.detectChanges();
      });
      return;
    }
    if (this.fullscreen) {
      this.fullscreen = false;
      this.cdr.detectChanges();
      setTimeout(() => this.map?.resize(), 80);
    }
  }

  private teardown(): void {
    this.disposed = true;
    this.exitFullscreenIfActive();
    this.stopFollowInterval();
    if (this.watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    if (this.map && this.onRender) {
      this.map.off('render', this.onRender);
    }
    this.onRender = undefined;
    this.userMarker?.remove();
    this.userMarker = undefined;
    this.map?.remove();
    this.map = undefined;
    this.mapReady = false;
  }
}
