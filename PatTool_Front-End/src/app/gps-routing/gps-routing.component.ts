import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import * as L from 'leaflet';
import { Subject, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';

import { LeafletBasemapOption, LeafletBasemapService } from '../shared/leaflet-basemap.service';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import {
  ApiService,
  OpenRouteDirections,
  OpenRouteProfile,
  OpenRouteStep
} from '../services/api.service';

interface PlacePoint {
  lat: number;
  lon: number;
  label: string;
}

interface GeocodeHit {
  lat: number;
  lon: number;
  displayName: string;
}

type PickTarget = 'from' | 'to' | null;

/**
 * GPS routing page (Monde) — OpenRouteService via PatTool backend proxy.
 */
@Component({
  selector: 'app-gps-routing',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, TraceViewerModalComponent],
  templateUrl: './gps-routing.component.html',
  styleUrls: ['./gps-routing.component.css']
})
export class GpsRoutingComponent implements OnInit, AfterViewInit, OnDestroy {

  @ViewChild('mapHost') mapHost?: ElementRef<HTMLDivElement>;
  @ViewChild('mapShell') mapShell?: ElementRef<HTMLElement>;
  @ViewChild(TraceViewerModalComponent) traceViewerModal?: TraceViewerModalComponent;

  readonly profiles: { id: OpenRouteProfile; labelKey: string; icon: string }[] = [
    { id: 'driving-car', labelKey: 'GPS_ROUTING.MODE_CAR', icon: 'fa-car' },
    { id: 'cycling-regular', labelKey: 'GPS_ROUTING.MODE_BIKE', icon: 'fa-bicycle' },
    { id: 'foot-walking', labelKey: 'GPS_ROUTING.MODE_WALK', icon: 'fa-male' }
  ];

  profile: OpenRouteProfile = 'driving-car';
  fromQuery = '';
  toQuery = '';
  fromResults: GeocodeHit[] = [];
  toResults: GeocodeHit[] = [];
  fromPoint: PlacePoint | null = null;
  toPoint: PlacePoint | null = null;
  pickTarget: PickTarget = null;

  route: OpenRouteDirections | null = null;
  steps: OpenRouteStep[] = [];
  isConfigured: boolean | null = null;
  isRouting = false;
  isLocating = false;
  isSearchingFrom = false;
  isSearchingTo = false;
  errorMessage = '';

  mapBaseLayerId = 'osm-standard';
  mapFullscreen = false;

  private map?: L.Map;
  private baseLayer: L.TileLayer | L.LayerGroup | null = null;
  private routeLayer?: L.FeatureGroup;
  private fromSearch$ = new Subject<string>();
  private toSearch$ = new Subject<string>();
  private subs: Subscription[] = [];

  constructor(
    private readonly api: ApiService,
    private readonly basemap: LeafletBasemapService,
    private readonly translate: TranslateService,
    private readonly cdr: ChangeDetectorRef,
    private readonly ngZone: NgZone
  ) {}

  ngOnInit(): void {
    this.api.getOpenRouteStatus().subscribe({
      next: (status) => {
        this.isConfigured = !!status?.configured;
        if (!this.isConfigured) {
          this.errorMessage = 'GPS_ROUTING.NOT_CONFIGURED';
        }
        this.cdr.detectChanges();
      },
      error: () => {
        this.isConfigured = false;
        this.errorMessage = 'GPS_ROUTING.NOT_CONFIGURED';
        this.cdr.detectChanges();
      }
    });

    this.subs.push(
      this.fromSearch$.pipe(debounceTime(350)).subscribe((q) => this.runGeocode('from', q)),
      this.toSearch$.pipe(debounceTime(350)).subscribe((q) => this.runGeocode('to', q))
    );
  }

  ngAfterViewInit(): void {
    this.ensureMap();
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.map?.remove();
    this.map = undefined;
  }

  onFromQueryChange(): void {
    this.fromPoint = null;
    this.fromSearch$.next(this.fromQuery);
  }

  onToQueryChange(): void {
    this.toPoint = null;
    this.toSearch$.next(this.toQuery);
  }

  selectFrom(hit: GeocodeHit): void {
    this.fromPoint = { lat: hit.lat, lon: hit.lon, label: hit.displayName };
    this.fromQuery = hit.displayName;
    this.fromResults = [];
    this.refreshMarkers();
    this.cdr.detectChanges();
  }

  selectTo(hit: GeocodeHit): void {
    this.toPoint = { lat: hit.lat, lon: hit.lon, label: hit.displayName };
    this.toQuery = hit.displayName;
    this.toResults = [];
    this.refreshMarkers();
    this.cdr.detectChanges();
  }

  useMyPositionAsFrom(): void {
    if (!navigator.geolocation) {
      this.errorMessage = 'GPS_ROUTING.GEOLOCATION_UNSUPPORTED';
      return;
    }
    this.isLocating = true;
    this.errorMessage = '';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.ngZone.run(() => {
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;
          this.fromPoint = {
            lat,
            lon,
            label: this.translate.instant('GPS_ROUTING.MY_POSITION')
          };
          this.fromQuery = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
          this.fromResults = [];
          this.isLocating = false;
          this.refreshMarkers();
          this.cdr.detectChanges();
          this.api.geocodeReverse(lat, lon).subscribe({
            next: (data: any) => {
              const name = data?.display_name || data?.displayName;
              if (name && this.fromPoint) {
                this.fromPoint = { ...this.fromPoint, label: name };
                this.fromQuery = name;
                this.cdr.detectChanges();
              }
            },
            error: () => { /* keep coords label */ }
          });
        });
      },
      () => {
        this.ngZone.run(() => {
          this.isLocating = false;
          this.errorMessage = 'GPS_ROUTING.GEOLOCATION_ERROR';
          this.cdr.detectChanges();
        });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  }

  swapEnds(): void {
    const tmpPoint = this.fromPoint;
    const tmpQuery = this.fromQuery;
    this.fromPoint = this.toPoint;
    this.fromQuery = this.toQuery;
    this.toPoint = tmpPoint;
    this.toQuery = tmpQuery;
    this.fromResults = [];
    this.toResults = [];
    this.refreshMarkers();
  }

  setPickTarget(target: PickTarget): void {
    this.pickTarget = this.pickTarget === target ? null : target;
  }

  setProfile(profile: OpenRouteProfile): void {
    this.profile = profile;
  }

  calculateRoute(): void {
    if (!this.fromPoint || !this.toPoint) {
      this.errorMessage = 'GPS_ROUTING.POINTS_REQUIRED';
      return;
    }
    if (this.isConfigured === false) {
      this.errorMessage = 'GPS_ROUTING.NOT_CONFIGURED';
      return;
    }

    this.isRouting = true;
    this.errorMessage = '';
    this.route = null;
    this.steps = [];

    const lang = this.translate.currentLang || this.translate.defaultLang || 'en';
    this.api.getOpenRouteDirections(
      this.profile,
      this.fromPoint.lat,
      this.fromPoint.lon,
      this.toPoint.lat,
      this.toPoint.lon,
      lang
    ).subscribe({
      next: (data) => {
        this.route = data;
        this.steps = data?.steps || [];
        this.isRouting = false;
        this.drawRoute();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.isRouting = false;
        const code = err?.error?.error;
        if (err?.status === 503 || code === 'not_configured') {
          this.isConfigured = false;
          this.errorMessage = 'GPS_ROUTING.NOT_CONFIGURED';
        } else if (err?.status === 404 || code === 'no_route') {
          this.errorMessage = 'GPS_ROUTING.NO_ROUTE';
        } else {
          this.errorMessage = 'GPS_ROUTING.ROUTE_ERROR';
        }
        this.clearRouteLine();
        this.cdr.detectChanges();
      }
    });
  }

  clearRoute(): void {
    this.route = null;
    this.steps = [];
    this.errorMessage = '';
    this.clearRouteLine();
  }

  get availableMapBaseLayers(): LeafletBasemapOption[] {
    return this.basemap.getAvailableLayers();
  }

  getMapBaseLayerLabel(layer: LeafletBasemapOption): string {
    return layer.labelKey ? this.translate.instant(layer.labelKey) : layer.label;
  }

  onMapBaseLayerChange(): void {
    if (!this.map) {
      return;
    }
    this.baseLayer = this.basemap.applyBaseLayer(this.map, this.mapBaseLayerId, this.baseLayer);
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

  openInTraceViewer(): void {
    if (!this.traceViewerModal || !this.route?.coordinates?.length) {
      return;
    }
    const points = this.route.coordinates
      .filter((c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
      .map((c) => ({ lat: c[0], lng: c[1] }));
    if (!points.length) {
      return;
    }
    const fromLabel = this.fromPoint?.label || this.translate.instant('GPS_ROUTING.FROM');
    const toLabel = this.toPoint?.label || this.translate.instant('GPS_ROUTING.TO');
    const title = `${fromLabel} → ${toLabel}`;
    this.traceViewerModal.openWithTrackPoints(points, title, {
      initialBaseLayerId: this.mapBaseLayerId
    });
  }

  exportGpx(): void {
    const coords = this.route?.coordinates;
    if (!coords?.length) {
      return;
    }
    const points = coords.filter(
      (c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])
    );
    if (!points.length) {
      return;
    }

    const fromLabel = this.fromPoint?.label || this.translate.instant('GPS_ROUTING.FROM');
    const toLabel = this.toPoint?.label || this.translate.instant('GPS_ROUTING.TO');
    const name = `${fromLabel} → ${toLabel}`;
    const profileLabel = this.translate.instant(
      this.profiles.find((p) => p.id === this.profile)?.labelKey || 'GPS_ROUTING.TITLE'
    );
    const gpx = this.buildGpx(points, name, profileLabel);
    const blob = new Blob([gpx], { type: 'application/gpx+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.buildGpxFileName(fromLabel, toLabel);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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

  formatDuration(seconds?: number | null): string {
    if (seconds == null || !Number.isFinite(seconds)) {
      return '—';
    }
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h > 0) {
      return `${h} h ${m} min`;
    }
    if (m > 0) {
      return `${m} min`;
    }
    return `${total} s`;
  }

  private runGeocode(side: 'from' | 'to', query: string): void {
    const q = query?.trim();
    if (!q || q.length < 3) {
      if (side === 'from') {
        this.fromResults = [];
      } else {
        this.toResults = [];
      }
      this.cdr.detectChanges();
      return;
    }

    const coords = this.parseCoordinates(q);
    if (coords) {
      const hit: GeocodeHit = {
        lat: coords.lat,
        lon: coords.lon,
        displayName: `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}`
      };
      if (side === 'from') {
        this.selectFrom(hit);
      } else {
        this.selectTo(hit);
      }
      return;
    }

    if (side === 'from') {
      this.isSearchingFrom = true;
    } else {
      this.isSearchingTo = true;
    }

    this.api.geocodeSearch(q).subscribe({
      next: (data: any[]) => {
        const hits = (data || []).map((item: any) => ({
          lat: typeof item.lat === 'number' ? item.lat : parseFloat(item.lat) || 0,
          lon: typeof item.lon === 'number' ? item.lon : parseFloat(item.lon) || 0,
          displayName: item.displayName || item.display_name || ''
        })).filter((h: GeocodeHit) => h.displayName && Number.isFinite(h.lat) && Number.isFinite(h.lon));
        if (side === 'from') {
          this.fromResults = hits.slice(0, 6);
          this.isSearchingFrom = false;
        } else {
          this.toResults = hits.slice(0, 6);
          this.isSearchingTo = false;
        }
        this.cdr.detectChanges();
      },
      error: () => {
        if (side === 'from') {
          this.fromResults = [];
          this.isSearchingFrom = false;
        } else {
          this.toResults = [];
          this.isSearchingTo = false;
        }
        this.cdr.detectChanges();
      }
    });
  }

  private parseCoordinates(raw: string): { lat: number; lon: number } | null {
    const cleaned = raw.trim().replace(/;/g, ',').replace(/\s+/g, ' ');
    let match = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) {
      match = cleaned.match(/^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/);
    }
    if (!match) {
      return null;
    }
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return null;
    }
    return { lat, lon };
  }

  private ensureMap(): void {
    const el = this.mapHost?.nativeElement;
    if (!el || this.map) {
      this.map?.invalidateSize();
      return;
    }
    this.basemap.loadOptionalLayers(this.api);
    this.map = L.map(el, { zoomControl: true, attributionControl: true });
    this.baseLayer = this.basemap.applyBaseLayer(this.map, this.mapBaseLayerId, null);
    this.routeLayer = L.featureGroup().addTo(this.map);
    this.map.setView([46.6, 2.5], 6);
    this.map.on('click', (e: L.LeafletMouseEvent) => {
      this.ngZone.run(() => this.onMapClick(e.latlng.lat, e.latlng.lng));
    });
    setTimeout(() => this.map?.invalidateSize(), 0);
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
      if (this.route?.coordinates?.length) {
        this.refreshMarkers(true);
      }
    }, 120);
  }

  private onMapClick(lat: number, lon: number): void {
    if (!this.pickTarget) {
      return;
    }
    const label = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const point: PlacePoint = { lat, lon, label };
    if (this.pickTarget === 'from') {
      this.fromPoint = point;
      this.fromQuery = label;
      this.fromResults = [];
    } else {
      this.toPoint = point;
      this.toQuery = label;
      this.toResults = [];
    }
    this.pickTarget = null;
    this.refreshMarkers();
    this.cdr.detectChanges();
  }

  private refreshMarkers(fitRoute = false): void {
    if (!this.map || !this.routeLayer) {
      return;
    }
    this.routeLayer.clearLayers();
    if (this.fromPoint) {
      L.circleMarker([this.fromPoint.lat, this.fromPoint.lon], {
        radius: 9,
        color: '#fff',
        weight: 2,
        fillColor: '#198754',
        fillOpacity: 0.95
      }).bindTooltip(this.translate.instant('GPS_ROUTING.FROM'), { permanent: false })
        .addTo(this.routeLayer);
    }
    if (this.toPoint) {
      L.circleMarker([this.toPoint.lat, this.toPoint.lon], {
        radius: 9,
        color: '#fff',
        weight: 2,
        fillColor: '#dc3545',
        fillOpacity: 0.95
      }).bindTooltip(this.translate.instant('GPS_ROUTING.TO'), { permanent: false })
        .addTo(this.routeLayer);
    }
    if (this.route?.coordinates?.length) {
      this.drawRoutePolyline(fitRoute);
      return;
    }
    const bounds = this.routeLayer.getBounds();
    if (bounds.isValid()) {
      this.map.fitBounds(bounds.pad(0.25));
    }
  }

  private drawRoute(): void {
    if (!this.map || !this.routeLayer) {
      this.ensureMap();
    }
    this.refreshMarkers(true);
  }

  private drawRoutePolyline(fit: boolean): void {
    if (!this.map || !this.routeLayer || !this.route?.coordinates?.length) {
      return;
    }
    const latLngs = this.route.coordinates
      .filter((c) => Array.isArray(c) && c.length >= 2)
      .map((c) => L.latLng(c[0], c[1]));
    if (!latLngs.length) {
      return;
    }
    L.polyline(latLngs, {
      color: '#0d6efd',
      weight: 5,
      opacity: 0.85
    }).addTo(this.routeLayer);
    if (fit) {
      this.map.fitBounds(L.latLngBounds(latLngs).pad(0.15));
    }
  }

  private clearRouteLine(): void {
    if (!this.routeLayer) {
      return;
    }
    this.routeLayer.clearLayers();
    this.refreshMarkers();
  }

  private buildGpx(points: number[][], name: string, profileLabel: string): string {
    const now = new Date().toISOString();
    const safeName = this.escapeXml(name);
    const safeDesc = this.escapeXml(
      `${profileLabel} · ${this.formatDistance(this.route?.distanceMeters)} · ${this.formatDuration(this.route?.durationSeconds)}`
    );
    const trkpts = points
      .map((c) => `      <trkpt lat="${c[0]}" lon="${c[1]}"></trkpt>`)
      .join('\n');
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="PatTool GPS"',
      '  xmlns="http://www.topografix.com/GPX/1/1"',
      '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
      '  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
      '  <metadata>',
      `    <name>${safeName}</name>`,
      `    <desc>${safeDesc}</desc>`,
      `    <time>${now}</time>`,
      '  </metadata>',
      '  <trk>',
      `    <name>${safeName}</name>`,
      `    <type>${this.escapeXml(this.profile)}</type>`,
      '    <trkseg>',
      trkpts,
      '    </trkseg>',
      '  </trk>',
      '</gpx>',
      ''
    ].join('\n');
  }

  private buildGpxFileName(fromLabel: string, toLabel: string): string {
    const slug = (value: string) =>
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .toLowerCase() || 'route';
    return `pattool-${slug(fromLabel)}-${slug(toLabel)}.gpx`;
  }

  private escapeXml(value: string): string {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
