import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import * as L from 'leaflet';

import { LeafletBasemapOption, LeafletBasemapService } from '../shared/leaflet-basemap.service';
import { ApiService } from '../services/api.service';
import {
  analysisNeedsDemElevation,
  analyzeGpxFileContent,
  enrichAnalysisWithDemElevations,
  GpxAnalysis,
  isGpxFileName,
  sampleLatLonsForElevation
} from './gpx-trace-analysis.util';
import { firstValueFrom } from 'rxjs';

/**
 * Monde — Trace GPX: upload a GPX file and display full track analytics + map + elevation profile.
 */
@Component({
  selector: 'app-gpx-trace',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './gpx-trace.component.html',
  styleUrls: ['./gpx-trace.component.css']
})
export class GpxTraceComponent implements AfterViewInit, OnDestroy {

  @ViewChild('mapHost') mapHost?: ElementRef<HTMLDivElement>;
  @ViewChild('mapShell') mapShell?: ElementRef<HTMLElement>;
  @ViewChild('elevCanvas') elevCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;

  analysis: GpxAnalysis | null = null;
  errorMessage = '';
  isParsing = false;
  isDragOver = false;
  mapBaseLayerId = 'osm-standard';
  mapFullscreen = false;

  get basemapOptions(): LeafletBasemapOption[] {
    return this.basemap.getAvailableLayers();
  }

  private map: L.Map | null = null;
  private baseLayer: L.TileLayer | L.LayerGroup | null = null;
  private trackLayer: L.FeatureGroup | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    private readonly basemap: LeafletBasemapService,
    private readonly api: ApiService,
    private readonly ngZone: NgZone,
    private readonly cdr: ChangeDetectorRef
  ) {}

  ngAfterViewInit(): void {
    this.basemap.loadOptionalLayers(this.api);
    this.ensureMap();
    const el = this.mapHost?.nativeElement;
    if (el && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.map?.invalidateSize());
      this.resizeObserver.observe(el);
    }
  }

  ngOnDestroy(): void {
    this.exitMapFullscreenIfActive();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
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
    setTimeout(() => this.map?.invalidateSize(), 120);
  }

  onFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      void this.loadFile(file);
    }
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      void this.loadFile(file);
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = true;
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;
  }

  openFilePicker(): void {
    this.fileInput?.nativeElement?.click();
  }

  clear(): void {
    this.analysis = null;
    this.errorMessage = '';
    this.isParsing = false;
    if (this.fileInput?.nativeElement) {
      this.fileInput.nativeElement.value = '';
    }
    this.clearTrackOnMap();
    this.clearElevationChart();
    this.cdr.markForCheck();
  }

  onBasemapChange(): void {
    if (!this.map) {
      return;
    }
    this.baseLayer = this.basemap.applyBaseLayer(this.map, this.mapBaseLayerId, this.baseLayer);
  }

  formatDistance(meters: number | null): string {
    if (meters == null || !Number.isFinite(meters)) {
      return '—';
    }
    if (meters < 1000) {
      return `${Math.round(meters)} m`;
    }
    return `${(meters / 1000).toFixed(2)} km`;
  }

  formatDuration(sec: number | null): string {
    if (sec == null || !Number.isFinite(sec) || sec < 0) {
      return '—';
    }
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) {
      return `${h} h ${m.toString().padStart(2, '0')} min`;
    }
    if (m > 0) {
      return `${m} min ${s.toString().padStart(2, '0')} s`;
    }
    return `${s} s`;
  }

  formatCoord(v: number | null): string {
    if (v == null || !Number.isFinite(v)) {
      return '—';
    }
    return v.toFixed(6);
  }

  formatElev(v: number | null): string {
    if (v == null || !Number.isFinite(v)) {
      return '—';
    }
    return `${v} m`;
  }

  formatSpeed(v: number | null): string {
    if (v == null || !Number.isFinite(v)) {
      return '—';
    }
    return `${v} km/h`;
  }

  formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return '—';
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  formatDateTime(iso: string | null): string {
    if (!iso) {
      return '—';
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return iso;
    }
    return d.toLocaleString();
  }

  private async loadFile(file: File): Promise<void> {
    this.errorMessage = '';
    if (!isGpxFileName(file.name) && !file.type.toLowerCase().includes('gpx')) {
      this.errorMessage = 'GPX_TRACE.ERR_NOT_GPX';
      this.analysis = null;
      return;
    }
    if (file.size > 40 * 1024 * 1024) {
      this.errorMessage = 'GPX_TRACE.ERR_TOO_LARGE';
      this.analysis = null;
      return;
    }

    this.isParsing = true;
    this.cdr.markForCheck();
    try {
      const text = await file.text();
      const analysis = analyzeGpxFileContent(file.name, text, file.size);
      if (analysis.points.length === 0 && analysis.waypointCount === 0) {
        this.errorMessage = 'GPX_TRACE.ERR_NO_POINTS';
        this.analysis = null;
        this.clearTrackOnMap();
        this.clearElevationChart();
        return;
      }
      this.analysis = analysis;
      this.cdr.detectChanges();
      // Wait for *ngIf canvas / layout before drawing.
      setTimeout(() => {
        this.ngZone.runOutsideAngular(() => {
          this.renderTrackOnMap(analysis);
          this.renderElevationChart(analysis);
        });
        this.map?.invalidateSize();
      }, 0);

      if (analysisNeedsDemElevation(analysis)) {
        void this.enrichMissingElevation(analysis);
      }
    } catch {
      this.errorMessage = 'GPX_TRACE.ERR_PARSE';
      this.analysis = null;
      this.clearTrackOnMap();
      this.clearElevationChart();
    } finally {
      this.isParsing = false;
      this.cdr.markForCheck();
    }
  }

  /** When the GPX has no ele tags, fill a DEM profile (Open-Meteo) and refresh elev stats/chart. */
  private async enrichMissingElevation(analysis: GpxAnalysis): Promise<void> {
    const samples = sampleLatLonsForElevation(analysis.points, 80);
    if (samples.length < 2) {
      return;
    }
    try {
      const res = await firstValueFrom(
        this.api.lookupElevationsBatch(samples.map((s) => ({ lat: s.lat, lon: s.lon })))
      );
      if (this.analysis !== analysis) {
        return;
      }
      const altitudes = res?.altitudesM || [];
      enrichAnalysisWithDemElevations(analysis, samples, altitudes);
      this.analysis = { ...analysis };
      this.cdr.detectChanges();
      setTimeout(() => {
        this.ngZone.runOutsideAngular(() => {
          this.renderElevationChart(analysis);
        });
      }, 0);
    } catch {
      // Keep point-derived / embedded stats; elev may stay empty.
    }
  }

  private ensureMap(): void {
    const el = this.mapHost?.nativeElement;
    if (!el || this.map) {
      this.map?.invalidateSize();
      return;
    }
    this.map = L.map(el, {
      zoomControl: true,
      attributionControl: true
    });
    this.baseLayer = this.basemap.applyBaseLayer(this.map, this.mapBaseLayerId, null);
    this.trackLayer = L.featureGroup().addTo(this.map);
    this.map.setView([46.6, 2.5], 6);
    setTimeout(() => this.map?.invalidateSize(), 0);
  }

  private clearTrackOnMap(): void {
    this.trackLayer?.clearLayers();
  }

  private renderTrackOnMap(analysis: GpxAnalysis): void {
    this.ensureMap();
    if (!this.map || !this.trackLayer) {
      return;
    }
    this.trackLayer.clearLayers();

    if (analysis.points.length >= 2) {
      const latLngs: L.LatLngExpression[] = analysis.points.map((p) => [p.lat, p.lon]);
      L.polyline(latLngs, {
        color: '#0d6efd',
        weight: 4,
        opacity: 0.9
      }).addTo(this.trackLayer);

      L.circleMarker([analysis.points[0].lat, analysis.points[0].lon], {
        radius: 7,
        color: '#198754',
        fillColor: '#198754',
        fillOpacity: 1,
        weight: 2
      })
        .bindTooltip('A', { permanent: false })
        .addTo(this.trackLayer);

      const last = analysis.points[analysis.points.length - 1];
      L.circleMarker([last.lat, last.lon], {
        radius: 7,
        color: '#dc3545',
        fillColor: '#dc3545',
        fillOpacity: 1,
        weight: 2
      })
        .bindTooltip('B', { permanent: false })
        .addTo(this.trackLayer);
    }

    for (const w of analysis.waypoints) {
      L.circleMarker([w.lat, w.lon], {
        radius: 5,
        color: '#fd7e14',
        fillColor: '#fd7e14',
        fillOpacity: 0.95,
        weight: 1
      })
        .bindTooltip(w.name || 'WPT', { permanent: false })
        .addTo(this.trackLayer);
    }

    const bounds = this.trackLayer.getBounds();
    if (bounds.isValid()) {
      this.map.fitBounds(bounds.pad(0.12));
    }
  }

  private clearElevationChart(): void {
    const canvas = this.elevCanvas?.nativeElement;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  private renderElevationChart(analysis: GpxAnalysis): void {
    const canvas = this.elevCanvas?.nativeElement;
    if (!canvas) {
      return;
    }
    const parent = canvas.parentElement;
    const cssW = Math.max(280, parent?.clientWidth || 640);
    const cssH = 180;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const elevs = analysis.points
      .map((p) => (p.eleM != null && Number.isFinite(p.eleM) ? p.eleM : null))
      .filter((v): v is number => v != null);

    ctx.fillStyle = '#f8f9fa';
    ctx.fillRect(0, 0, cssW, cssH);

    if (elevs.length < 2) {
      ctx.fillStyle = '#6c757d';
      ctx.font = '13px sans-serif';
      ctx.fillText('—', 16, cssH / 2);
      return;
    }

    const minE = Math.min(...elevs);
    const maxE = Math.max(...elevs);
    const padL = 44;
    const padR = 12;
    const padT = 16;
    const padB = 22;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;
    const span = Math.max(1, maxE - minE);

    // grid
    ctx.strokeStyle = '#dee2e6';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      const elevLabel = Math.round(maxE - (span * i) / 4);
      ctx.fillStyle = '#6c757d';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`${elevLabel}`, padL - 6, y + 4);
    }

    // area + line — sample along original points with elevation
    const series: number[] = [];
    for (const p of analysis.points) {
      if (p.eleM != null && Number.isFinite(p.eleM)) {
        series.push(p.eleM);
      }
    }
    const n = series.length;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = padL + (plotW * i) / Math.max(1, n - 1);
      const y = padT + plotH * (1 - (series[i] - minE) / span);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = '#0d6efd';
    ctx.lineWidth = 2;
    ctx.stroke();

    // fill under curve
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.lineTo(padL, padT + plotH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(13, 110, 253, 0.15)';
    ctx.fill();

    ctx.fillStyle = '#495057';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.round(minE)} m`, padL, cssH - 6);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(maxE)} m`, padL + plotW, cssH - 6);
  }
}
