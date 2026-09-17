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
import { ActivatedRoute } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import * as L from 'leaflet';
import { firstValueFrom, Subscription } from 'rxjs';

import { LeafletBasemapOption, LeafletBasemapService } from '../shared/leaflet-basemap.service';
import { ApiService, GpsFollowSession } from '../services/api.service';
import { FileService } from '../services/file.service';
import { GpsRecordingService, GpsLiveSnapshot, GpsUserFix } from '../services/gps-recording.service';
import { GpsNav3dComponent, GpsNav3dFix } from '../gps-routing/gps-nav-3d.component';
import { GpsMapOrientation } from '../shared/gps-map-orientation';
import { parseTrackFileToLatLonPoints } from '../photo-timeline/track-route-stats.util';
import {
  analysisNeedsDemElevation,
  analyzeGpxFileContent,
  enrichAnalysisWithDemElevations,
  isGpxFileName,
  sampleLatLonsForElevation
} from '../gpx-trace/gpx-trace-analysis.util';
import { readGpsHandoff } from './gps-handoff';
import {
  coordsToArrays,
  decodeTrackBuffer,
  elevationGainLoss,
  GpsTrackPt,
  haversineMeters,
  splitTrackSegments,
  trackSlopeAt
} from './gps-geo.util';

interface GpsPlaceView {
  lat: number;
  lon: number;
  eleM: number | null;
  address: string;
  loading: boolean;
}

@Component({
  selector: 'app-gps-track',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, GpsNav3dComponent],
  templateUrl: './gps-track.component.html',
  styleUrls: ['./gps-track.component.css']
})
export class GpsTrackComponent implements AfterViewInit, OnDestroy {
  @ViewChild('mapHost') mapHost?: ElementRef<HTMLDivElement>;
  @ViewChild('mapShell') mapShell?: ElementRef<HTMLElement>;
  @ViewChild('slopeFsRoot') slopeFsRoot?: ElementRef<HTMLElement>;
  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;

  snap: GpsLiveSnapshot = this.recording.snapshot;
  errorMessage = '';
  isParsing = false;
  isDragOver = false;
  mapBaseLayerId = 'osm-standard';
  mapFullscreen = false;
  slopeFullscreen = false;
  private mapFsNative = false;
  private slopeFsNative = false;
  slopeCoef = 1;
  readonly slopeCoefMin = 0.5;
  readonly slopeCoefMax = 10;
  readonly slopeCoefStep = 0.5;
  nav3dActive = false;
  followUser = true;
  mapOrientation: GpsMapOrientation = 'heading';
  sessions: GpsFollowSession[] = [];
  sessionsLoading = false;
  startPlace: GpsPlaceView | null = null;
  finishPlace: GpsPlaceView | null = null;
  currentPlace: GpsPlaceView | null = null;

  readonly mapOrientations: { id: GpsMapOrientation; labelKey: string; icon: string }[] = [
    { id: 'north', labelKey: 'GPS_ROUTING.ORIENT_NORTH', icon: 'fa-compass' },
    { id: 'heading', labelKey: 'GPS_ROUTING.ORIENT_HEADING', icon: 'fa-location-arrow' },
    { id: 'route', labelKey: 'GPS_ROUTING.ORIENT_ROUTE', icon: 'fa-road' }
  ];

  get basemapOptions(): LeafletBasemapOption[] {
    return this.basemap.getAvailableLayers();
  }

  get nav3dFix(): GpsNav3dFix | null {
    const u = this.snap.user;
    if (!u) {
      return null;
    }
    return { lat: u.lat, lon: u.lon, speedKmh: u.speedKmh, headingDeg: u.headingDeg };
  }

  get nav3dCoords(): number[][] {
    if (this.snap.track.length >= 2) {
      return coordsToArrays(this.snap.track);
    }
    if (this.snap.recorded.length >= 2) {
      return coordsToArrays(this.snap.recorded);
    }
    return [];
  }

  get trackSlope(): { pct: number | null; deg: number | null } {
    return trackSlopeAt(this.snap.track, this.snap.nearestIndex) ?? { pct: null, deg: null };
  }

  get trackSlopeNeedleDeg(): number {
    return this.clampSlopeNeedle(this.scaleSlopeDeg(this.trackSlope.deg));
  }

  get slopeNeedleDeg(): number {
    return this.clampSlopeNeedle(this.scaleSlopeDeg(this.snap.user?.slopeDeg));
  }

  /** Phone pitch from the calibrated zero, amplified by the user coefficient. */
  get inclineNeedleDeg(): number {
    return this.clampSlopeNeedle(this.scaleSlopeDeg(this.snap.inclineDeg));
  }

  get slopeFullScaleDeg(): number {
    const c = this.slopeCoef > 0 ? this.slopeCoef : 1;
    return 90 / c;
  }

  get slopeFullScaleLabel(): string {
    return this.slopeFullScaleDeg.toFixed(1);
  }

  scaleSlopeDeg(d: number | null | undefined): number | null {
    if (d == null || !Number.isFinite(d)) {
      return null;
    }
    return Math.max(-90, Math.min(90, d * this.slopeCoef));
  }

  scaleSlopePct(p: number | null | undefined): number | null {
    if (p == null || !Number.isFinite(p)) {
      return null;
    }
    const v = p * this.slopeCoef;
    if (!Number.isFinite(v) || Math.abs(v) > 800) {
      return v >= 0 ? 800 : -800;
    }
    return v;
  }

  private clampSlopeNeedle(d: number | null | undefined): number {
    if (d == null || !Number.isFinite(d)) {
      return 0;
    }
    return Math.max(-180, Math.min(180, d));
  }

  private map: L.Map | null = null;
  private baseLayer: L.TileLayer | L.LayerGroup | null = null;
  private trackLayer: L.FeatureGroup | null = null;
  private userMarker: L.Marker | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private sub: Subscription | null = null;
  private querySub: Subscription | null = null;
  private lastPaintKey = '';
  private didFitTrack = false;
  private handledHandoff = false;
  private startGeocodeSub: Subscription | null = null;
  private finishGeocodeSub: Subscription | null = null;
  private currentGeocodeSub: Subscription | null = null;
  private lastStartKey = '';
  private lastFinishKey = '';
  private lastCurrentGeocoded: { lat: number; lon: number } | null = null;
  private lastCurrentGeocodeAt = 0;
  private hideTitleTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTitleTries = 0;
  private hideTitleRafOuter: number | null = null;
  private hideTitleRafInner: number | null = null;
  private pageAlive = true;
  private slopeCoefSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private slopeCoefSaveSub: Subscription | null = null;

  constructor(
    readonly recording: GpsRecordingService,
    private readonly basemap: LeafletBasemapService,
    private readonly api: ApiService,
    private readonly files: FileService,
    private readonly route: ActivatedRoute,
    private readonly cdr: ChangeDetectorRef,
    private readonly hostEl: ElementRef<HTMLElement>,
    private readonly zone: NgZone
  ) {}

  ngAfterViewInit(): void {
    this.basemap.loadOptionalLayers(this.api);
    this.ensureMap();
    this.recording.ensureLocationWatch();
    this.loadSlopeCoef();
    this.sub = this.recording.snapshot$.subscribe((snap) => {
      this.snap = snap;
      this.paintMap();
      this.refreshPlaces(snap);
      this.cdr.detectChanges();
    });
    const el = this.mapHost?.nativeElement;
    if (el && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.map?.invalidateSize());
      this.resizeObserver.observe(el);
    }
    this.querySub = this.route.queryParamMap.subscribe((q) => {
      const fileId = (q.get('fileId') || '').trim();
      const fileName = (q.get('fileName') || '').trim();
      const sessionId = (q.get('sessionId') || '').trim();
      if (fileId) {
        void this.loadFromFileId(fileId, fileName || 'track.gpx');
        return;
      }
      if (sessionId) {
        void this.loadRemoteSessionById(sessionId);
        return;
      }
      if (this.handledHandoff) {
        return;
      }
      this.handledHandoff = true;
      const handoff = readGpsHandoff();
      if (handoff) {
        this.applyPoints(handoff.points, {
          title: handoff.title || handoff.fileName,
          sourceType: handoff.fileId ? 'file' : 'import',
          sourceFileId: handoff.fileId || null,
          sourceFileName: handoff.fileName || null
        });
      }
    });
    this.refreshSessions();
    this.queueHidePageTitle();
  }

  ngOnDestroy(): void {
    this.pageAlive = false;
    this.cancelHideTitleWork();
    this.clearSlopeCoefSaveTimer();
    this.exitMapFullscreenIfActive();
    this.exitSlopeFullscreenIfActive();
    this.sub?.unsubscribe();
    this.querySub?.unsubscribe();
    this.startGeocodeSub?.unsubscribe();
    this.finishGeocodeSub?.unsubscribe();
    this.currentGeocodeSub?.unsubscribe();
    this.slopeCoefSaveSub?.unsubscribe();
    this.resizeObserver?.disconnect();
    this.recording.stopLocationWatchIfIdle();
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }

  private cancelHideTitleWork(): void {
    if (this.hideTitleTimer != null) {
      clearTimeout(this.hideTitleTimer);
      this.hideTitleTimer = null;
    }
    if (this.hideTitleRafOuter != null) {
      cancelAnimationFrame(this.hideTitleRafOuter);
      this.hideTitleRafOuter = null;
    }
    if (this.hideTitleRafInner != null) {
      cancelAnimationFrame(this.hideTitleRafInner);
      this.hideTitleRafInner = null;
    }
  }

  private queueHidePageTitle(): void {
    this.hideTitleTries = 0;
    this.cancelHideTitleWork();
    this.zone.runOutsideAngular(() => {
      const run = (): void => {
        if (!this.pageAlive) {
          return;
        }
        this.scrollPastPageTitle();
        this.hideTitleTries += 1;
        if (!this.pageTitleIsOffscreen() && this.hideTitleTries < 16) {
          this.hideTitleTimer = setTimeout(run, this.hideTitleTries < 5 ? 40 : 120);
        } else {
          this.map?.invalidateSize();
        }
      };
      this.hideTitleRafOuter = requestAnimationFrame(() => {
        this.hideTitleRafOuter = null;
        this.hideTitleRafInner = requestAnimationFrame(() => {
          this.hideTitleRafInner = null;
          run();
        });
      });
    });
  }

  private pageTitleIsOffscreen(): boolean {
    const title = this.hostEl.nativeElement.querySelector('.pat-title') as HTMLElement | null;
    if (!title) {
      return true;
    }
    return title.getBoundingClientRect().bottom <= this.fixedChromeBottom() + 2;
  }

  private scrollPastPageTitle(): void {
    const next = this.pageTitleHideScrollTop();
    if (next == null) {
      return;
    }
    const current = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    if (next <= current) {
      return;
    }
    document.documentElement.scrollTop = next;
    document.body.scrollTop = next;
    window.scrollTo(0, next);
  }

  /** ScrollY where .pat-title sits just under the navbar / tickers. */
  private pageTitleHideScrollTop(): number | null {
    const title = this.hostEl.nativeElement.querySelector('.pat-title') as HTMLElement | null;
    if (!title) {
      return null;
    }
    const y = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    const titleBottomDoc = y + title.getBoundingClientRect().bottom;
    return Math.max(0, Math.ceil(titleBottomDoc - this.fixedChromeBottom() + 6));
  }

  private fixedChromeBottom(): number {
    let bottom = 0;
    document.querySelectorAll('.navbar.fixed-top, .news-ticker, .currency-ticker, .stock-ticker').forEach((el) => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return;
      }
      const r = el.getBoundingClientRect();
      if (r.height > 1) {
        bottom = Math.max(bottom, r.bottom);
      }
    });
    return bottom;
  }

  openFilePicker(): void {
    this.fileInput?.nativeElement.click();
  }

  onFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      void this.loadLocalFile(file);
    }
    input.value = '';
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      void this.loadLocalFile(file);
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver = true;
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver = false;
  }

  async start(): Promise<void> {
    this.errorMessage = '';
    await this.recording.enableInclineFromUserGesture();
    await this.recording.startRecording();
  }

  async enableIncline(): Promise<void> {
    await this.recording.enableInclineFromUserGesture();
  }

  async calibrateIncline(): Promise<void> {
    await this.recording.calibrateInclineZero();
  }

  resetInclineCal(): void {
    this.recording.resetInclineCalibration();
  }

  bumpSlopeCoef(dir: 1 | -1): void {
    this.onSlopeCoefChange(this.slopeCoef + dir * this.slopeCoefStep);
  }

  onSlopeCoefChange(raw: number | string | null | undefined): void {
    this.slopeCoef = this.clampSlopeCoef(raw);
    this.persistSlopeCoefLocal();
    this.scheduleSlopeCoefSave();
  }

  async pause(): Promise<void> {
    await this.recording.pauseRecording();
  }

  async stop(): Promise<void> {
    await this.recording.stopRecording();
    this.refreshSessions();
  }

  clear(): void {
    this.errorMessage = '';
    this.recording.clearTrack();
    this.paintMap();
  }

  toggleNav3d(): void {
    if (!this.nav3dCoords.length) {
      return;
    }
    this.nav3dActive = !this.nav3dActive;
    if (!this.nav3dActive) {
      this.lastPaintKey = '';
      setTimeout(() => {
        this.paintMap();
        this.map?.invalidateSize();
      }, 80);
    }
  }

  onNav3dClosed(): void {
    this.nav3dActive = false;
    this.lastPaintKey = '';
    setTimeout(() => {
      this.paintMap();
      this.map?.invalidateSize();
    }, 80);
  }

  onBasemapChange(): void {
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
    this.requestElementFullscreen(shell, () => {
      this.mapFullscreen = true;
      this.refreshMapLayout();
    });
  }

  toggleSlopeFullscreen(): void {
    if (this.slopeFullscreen) {
      this.exitSlopeFullscreenIfActive();
      return;
    }
    this.setSlopeFullscreen(true);
    this.cdr.detectChanges();
    const root = this.slopeFsRoot?.nativeElement;
    if (root) {
      this.requestElementFullscreen(root, () => undefined);
    }
  }

  @HostListener('document:keydown.escape')
  onEscapeFullscreen(): void {
    if (this.slopeFullscreen && !this.nativeFullscreenElement()) {
      this.setSlopeFullscreen(false);
    }
    if (this.mapFullscreen && !this.nativeFullscreenElement()) {
      this.mapFullscreen = false;
      this.refreshMapLayout();
    }
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  onFullscreenChange(): void {
    const mapActive = this.isElementFullscreen(this.mapShell?.nativeElement);
    const slopeActive = this.isElementFullscreen(this.slopeFsRoot?.nativeElement);
    if (mapActive) {
      this.mapFsNative = true;
      this.slopeFsNative = false;
      this.mapFullscreen = true;
      this.setSlopeFullscreen(false);
      this.refreshMapLayout();
      return;
    }
    if (slopeActive) {
      this.slopeFsNative = true;
      this.mapFsNative = false;
      this.setSlopeFullscreen(true);
      if (this.mapFullscreen) {
        this.mapFullscreen = false;
        this.refreshMapLayout();
      }
      return;
    }
    if (this.nativeFullscreenElement()) {
      return;
    }
    if (this.mapFsNative) {
      this.mapFsNative = false;
      this.mapFullscreen = false;
      this.refreshMapLayout();
    }
    if (this.slopeFsNative) {
      this.slopeFsNative = false;
      this.setSlopeFullscreen(false);
    }
  }

  refreshSessions(): void {
    this.sessionsLoading = true;
    this.api.listGpsSessions().subscribe({
      next: (list) => {
        this.sessions = list || [];
        this.sessionsLoading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.sessions = [];
        this.sessionsLoading = false;
        this.cdr.markForCheck();
      }
    });
  }

  loadSession(session: GpsFollowSession): void {
    if (!session.id) {
      return;
    }
    void this.loadRemoteSessionById(session.id);
  }

  deleteSession(session: GpsFollowSession, event: Event): void {
    event.stopPropagation();
    if (!session.id) {
      return;
    }
    this.api.deleteGpsSession(session.id).subscribe({
      next: () => this.refreshSessions(),
      error: () => this.refreshSessions()
    });
  }

  formatKm(meters: number | null | undefined): string {
    if (meters == null || !Number.isFinite(meters)) {
      return '—';
    }
    return `${(meters / 1000).toFixed(meters >= 10000 ? 1 : 2)} km`;
  }

  formatElev(meters: number | null | undefined): string {
    if (meters == null || !Number.isFinite(meters)) {
      return '—';
    }
    return `${Math.round(meters)} m`;
  }

  formatSpeed(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) {
      return '—';
    }
    return `${v.toFixed(1)} km/h`;
  }

  formatSlope(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) {
      return '—';
    }
    const sign = v > 0.15 ? '+' : v < -0.15 ? '' : '';
    return `${sign}${v.toFixed(1)} %`;
  }

  formatSlopeDeg(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) {
      return '—';
    }
    const sign = v > 0.15 ? '+' : v < -0.15 ? '' : '';
    return `${sign}${v.toFixed(1)}°`;
  }

  formatSlopeLine(pct: number | null | undefined, deg: number | null | undefined): string {
    const hasPct = pct != null && Number.isFinite(pct);
    const hasDeg = deg != null && Number.isFinite(deg);
    if (!hasPct && !hasDeg) {
      return '—';
    }
    if (hasPct && hasDeg) {
      return `${this.formatSlope(pct)} · ${this.formatSlopeDeg(deg)}`;
    }
    return hasPct ? this.formatSlope(pct) : this.formatSlopeDeg(deg);
  }

  formatPlaceGps(place: GpsPlaceView | null | undefined): string {
    if (!place) {
      return '—';
    }
    const gps = `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`;
    if (place.eleM != null && Number.isFinite(place.eleM)) {
      return `${gps} · ${Math.round(place.eleM)} m`;
    }
    return gps;
  }

  copyGps(place: GpsPlaceView | null | undefined): void {
    if (!place) {
      return;
    }
    const text = `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`;
    void navigator.clipboard?.writeText(text);
  }

  formatDuration(sec: number | null | undefined): string {
    if (sec == null || !Number.isFinite(sec) || sec < 0) {
      return '0:00';
    }
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`;
    }
    return `${m}:${r.toString().padStart(2, '0')}`;
  }

  statusLabelKey(): string {
    switch (this.snap.status) {
      case 'recording':
        return 'GPS.STATUS_RECORDING';
      case 'paused':
        return 'GPS.STATUS_PAUSED';
      case 'finished':
        return 'GPS.STATUS_FINISHED';
      default:
        return 'GPS.STATUS_IDLE';
    }
  }

  private async loadLocalFile(file: File): Promise<void> {
    this.errorMessage = '';
    if (file.size > 40 * 1024 * 1024) {
      this.errorMessage = 'GPS.ERR_TOO_LARGE';
      return;
    }
    this.isParsing = true;
    this.cdr.markForCheck();
    try {
      const text = await file.text();
      await this.parseTrackText(file.name, text, file.size, null);
    } catch {
      this.errorMessage = 'GPS.ERR_PARSE';
    } finally {
      this.isParsing = false;
      this.cdr.markForCheck();
    }
  }

  private async loadFromFileId(fileId: string, fileName: string): Promise<void> {
    this.isParsing = true;
    this.cdr.markForCheck();
    try {
      const buffer = await firstValueFrom(this.files.getFile(fileId));
      const text = decodeTrackBuffer(buffer);
      await this.parseTrackText(fileName, text, buffer.byteLength, fileId);
    } catch {
      this.errorMessage = 'GPS.ERR_LOAD_FILE';
    } finally {
      this.isParsing = false;
      this.cdr.markForCheck();
    }
  }

  private async loadRemoteSessionById(id: string): Promise<void> {
    this.isParsing = true;
    this.cdr.markForCheck();
    try {
      const session = await firstValueFrom(this.api.getGpsSession(id));
      this.recording.loadRemoteSession(session);
    } catch {
      this.errorMessage = 'GPS.ERR_LOAD_SESSION';
    } finally {
      this.isParsing = false;
      this.cdr.markForCheck();
    }
  }

  private async parseTrackText(
    fileName: string,
    text: string,
    fileSize: number,
    fileId: string | null
  ): Promise<void> {
    let points: GpsTrackPt[] = [];
    let title = fileName;
    let ascent: number | null = null;
    let descent: number | null = null;
    if (isGpxFileName(fileName) || /<gpx[\s>]/i.test(text)) {
      const analysis = analyzeGpxFileContent(fileName, text, fileSize);
      points = analysis.points.map((p) => ({ lat: p.lat, lon: p.lon, eleM: p.eleM ?? null }));
      title = analysis.name || fileName;
      ascent = analysis.elevationGainM;
      descent = analysis.elevationLossM;
      if (analysisNeedsDemElevation(analysis)) {
        await this.enrichGpxDem(analysis);
        points = analysis.points.map((p) => ({ lat: p.lat, lon: p.lon, eleM: p.eleM ?? null }));
        ascent = analysis.elevationGainM;
        descent = analysis.elevationLossM;
      }
    } else {
      points = parseTrackFileToLatLonPoints(fileName, text);
    }
    if (points.length < 2) {
      this.errorMessage = 'GPS.ERR_NO_POINTS';
      return;
    }
    const elev = elevationGainLoss(points);
    this.applyPoints(points, {
      title,
      sourceType: fileId ? 'file' : 'import',
      sourceFileId: fileId,
      sourceFileName: fileName,
      plannedAscentM: ascent ?? elev.gainM,
      plannedDescentM: descent ?? elev.lossM
    });
  }

  private async enrichGpxDem(analysis: ReturnType<typeof analyzeGpxFileContent>): Promise<void> {
    const samples = sampleLatLonsForElevation(analysis.points, 80);
    if (samples.length < 2) {
      return;
    }
    try {
      const res = await firstValueFrom(
        this.api.lookupElevationsBatch(samples.map((s) => ({ lat: s.lat, lon: s.lon })))
      );
      enrichAnalysisWithDemElevations(analysis, samples, res?.altitudesM || []);
    } catch {
      /* keep GPX stats */
    }
  }

  private applyPoints(
    points: GpsTrackPt[],
    meta: {
      title?: string;
      sourceType?: 'import' | 'file' | 'session';
      sourceFileId?: string | null;
      sourceFileName?: string | null;
      plannedAscentM?: number | null;
      plannedDescentM?: number | null;
    }
  ): void {
    this.recording.setTrack({
      points,
      title: meta.title,
      sourceType: meta.sourceType,
      sourceFileId: meta.sourceFileId,
      sourceFileName: meta.sourceFileName,
      plannedAscentM: meta.plannedAscentM,
      plannedDescentM: meta.plannedDescentM
    });
    this.didFitTrack = false;
    setTimeout(() => this.map?.invalidateSize(), 0);
  }

  private refreshPlaces(snap: GpsLiveSnapshot): void {
    const startPt = snap.track[0] ?? snap.recorded[0] ?? null;
    const finishPt = snap.track.length ? snap.track[snap.track.length - 1] : null;
    this.startPlace = this.syncAnchorPlace('start', startPt, this.startPlace);
    this.finishPlace = this.syncAnchorPlace('finish', finishPt, this.finishPlace);
    this.syncCurrentPlace(snap.user);
  }

  private syncAnchorPlace(
    kind: 'start' | 'finish',
    pt: GpsTrackPt | null,
    current: GpsPlaceView | null
  ): GpsPlaceView | null {
    if (!pt) {
      if (kind === 'start') {
        this.lastStartKey = '';
        this.startGeocodeSub?.unsubscribe();
      } else {
        this.lastFinishKey = '';
        this.finishGeocodeSub?.unsubscribe();
      }
      return null;
    }
    const key = this.coordKey(pt.lat, pt.lon);
    const prevKey = kind === 'start' ? this.lastStartKey : this.lastFinishKey;
    if (key === prevKey && current) {
      current.eleM = pt.eleM ?? current.eleM;
      return current;
    }
    if (kind === 'start') {
      this.lastStartKey = key;
    } else {
      this.lastFinishKey = key;
    }
    const place: GpsPlaceView = {
      lat: pt.lat,
      lon: pt.lon,
      eleM: pt.eleM ?? null,
      address: '',
      loading: true
    };
    this.geocodePlace(kind, place);
    return place;
  }

  private syncCurrentPlace(user: GpsUserFix | null): void {
    if (!user) {
      this.currentPlace = null;
      this.lastCurrentGeocoded = null;
      this.currentGeocodeSub?.unsubscribe();
      return;
    }
    if (!this.currentPlace) {
      this.currentPlace = {
        lat: user.lat,
        lon: user.lon,
        eleM: user.eleM,
        address: '',
        loading: true
      };
      this.lastCurrentGeocoded = { lat: user.lat, lon: user.lon };
      this.lastCurrentGeocodeAt = Date.now();
      this.geocodePlace('current', this.currentPlace);
      return;
    }
    this.currentPlace.lat = user.lat;
    this.currentPlace.lon = user.lon;
    this.currentPlace.eleM = user.eleM;
    const prev = this.lastCurrentGeocoded;
    const moved = prev ? haversineMeters(prev.lat, prev.lon, user.lat, user.lon) : Number.POSITIVE_INFINITY;
    const elapsed = Date.now() - this.lastCurrentGeocodeAt;
    if (moved >= 50 && elapsed >= 12000) {
      this.currentPlace.loading = true;
      this.lastCurrentGeocoded = { lat: user.lat, lon: user.lon };
      this.lastCurrentGeocodeAt = Date.now();
      this.geocodePlace('current', this.currentPlace);
    }
  }

  private geocodePlace(kind: 'start' | 'finish' | 'current', place: GpsPlaceView): void {
    const prev =
      kind === 'start' ? this.startGeocodeSub : kind === 'finish' ? this.finishGeocodeSub : this.currentGeocodeSub;
    prev?.unsubscribe();
    const sub = this.api.geocodeReverse(place.lat, place.lon).subscribe({
      next: (data) => {
        place.address = this.formatReverseGeocodeAddress(data);
        place.loading = false;
        this.cdr.detectChanges();
      },
      error: () => {
        place.loading = false;
        this.cdr.detectChanges();
      }
    });
    if (kind === 'start') {
      this.startGeocodeSub = sub;
    } else if (kind === 'finish') {
      this.finishGeocodeSub = sub;
    } else {
      this.currentGeocodeSub = sub;
    }
  }

  private coordKey(lat: number, lon: number): string {
    return `${lat.toFixed(5)},${lon.toFixed(5)}`;
  }

  private formatReverseGeocodeAddress(data: unknown): string {
    const row = data as {
      error?: unknown;
      address?: Record<string, unknown>;
      display_name?: string;
      displayName?: string;
    } | null;
    if (!row || row.error) {
      return '';
    }
    const addr = row.address;
    if (addr && typeof addr === 'object') {
      const parts: string[] = [];
      const road = this.asText(addr['road'] ?? addr['street'] ?? addr['path'] ?? addr['pedestrian']);
      const houseNumber = this.asText(addr['house_number'] ?? addr['housenumber']);
      if (houseNumber && road) {
        parts.push(`${houseNumber} ${road}`);
      } else if (road) {
        parts.push(road);
      } else {
        const named = this.asText(
          addr['name'] ?? addr['tourism'] ?? addr['peak'] ?? addr['natural'] ?? addr['hamlet']
        );
        if (named) {
          parts.push(named);
        }
      }
      const postcode = this.asText(addr['postcode']);
      const locality = this.asText(
        addr['city'] ?? addr['town'] ?? addr['village'] ?? addr['municipality'] ?? addr['suburb']
      );
      if (postcode && locality) {
        parts.push(`${postcode} ${locality}`);
      } else {
        if (postcode) {
          parts.push(postcode);
        }
        if (locality) {
          parts.push(locality);
        }
      }
      const region = this.asText(addr['state'] ?? addr['region'] ?? addr['county']);
      if (region && region !== locality) {
        parts.push(region);
      }
      const country = this.asText(addr['country']);
      if (country) {
        parts.push(country);
      }
      if (parts.length > 0) {
        return parts.join(', ');
      }
    }
    return this.asText(row.display_name ?? row.displayName);
  }

  private asText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private ensureMap(): void {
    const el = this.mapHost?.nativeElement;
    if (!el || this.map) {
      this.map?.invalidateSize();
      return;
    }
    this.map = L.map(el, { zoomControl: true, attributionControl: true });
    this.baseLayer = this.basemap.applyBaseLayer(this.map, this.mapBaseLayerId, null);
    this.trackLayer = L.featureGroup().addTo(this.map);
    this.map.setView([46.6, 2.5], 6);
    setTimeout(() => this.map?.invalidateSize(), 0);
  }

  private paintMap(): void {
    this.ensureMap();
    if (!this.map || !this.trackLayer || this.nav3dActive) {
      this.syncUserMarker(this.snap.user);
      return;
    }
    const key = `${this.snap.track.length}|${this.snap.nearestIndex}|${this.snap.recorded.length}`;
    if (key !== this.lastPaintKey) {
      this.lastPaintKey = key;
      this.trackLayer.clearLayers();
      const track = this.snap.track;
      const idx = Math.max(0, Math.min(this.snap.nearestIndex, Math.max(0, track.length - 1)));
      if (track.length >= 2) {
        const done = track.slice(0, idx + 1).map((p) => [p.lat, p.lon] as L.LatLngExpression);
        const remain = track.slice(idx).map((p) => [p.lat, p.lon] as L.LatLngExpression);
        if (done.length >= 2) {
          L.polyline(done, { color: '#343a40', weight: 5, opacity: 0.85 }).addTo(this.trackLayer);
        }
        if (remain.length >= 2) {
          L.polyline(remain, { color: '#0d6efd', weight: 5, opacity: 0.95 }).addTo(this.trackLayer);
        }
        L.circleMarker([track[0].lat, track[0].lon], {
          radius: 7, color: '#fff', weight: 2, fillColor: '#198754', fillOpacity: 1
        }).addTo(this.trackLayer);
        const last = track[track.length - 1];
        L.circleMarker([last.lat, last.lon], {
          radius: 7, color: '#fff', weight: 2, fillColor: '#dc3545', fillOpacity: 1
        }).addTo(this.trackLayer);
      }
      if (this.snap.recorded.length >= 2) {
        for (const seg of splitTrackSegments(this.snap.recorded)) {
          if (seg.length < 2) {
            continue;
          }
          L.polyline(
            seg.map((p) => [p.lat, p.lon] as L.LatLngExpression),
            { color: '#fd7e14', weight: 3, opacity: 0.8, dashArray: '6 8' }
          ).addTo(this.trackLayer);
        }
      }
    }
    this.syncUserMarker(this.snap.user);
    if (this.followUser && this.snap.user && (this.snap.status === 'recording' || this.snap.status === 'paused')) {
      this.map.setView([this.snap.user.lat, this.snap.user.lon], Math.max(this.map.getZoom(), 15), { animate: false });
    } else if (!this.didFitTrack && this.snap.track.length >= 2) {
      const b = this.trackLayer.getBounds();
      if (b.isValid()) {
        this.map.fitBounds(b, { padding: [28, 28], maxZoom: 16 });
        this.didFitTrack = true;
      }
    }
  }

  private syncUserMarker(user: GpsUserFix | null): void {
    if (!this.map || !user) {
      return;
    }
    const heading = user.headingDeg ?? 0;
    if (!this.userMarker) {
      const icon = L.divIcon({
        className: 'gps-user-marker',
        html: '<div class="gps-user-marker-arrow"></div>',
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });
      this.userMarker = L.marker([user.lat, user.lon], { icon, zIndexOffset: 1200 }).addTo(this.map);
    } else {
      this.userMarker.setLatLng([user.lat, user.lon]);
    }
    const el = this.userMarker.getElement()?.querySelector('.gps-user-marker-arrow') as HTMLElement | null;
    if (el) {
      el.style.transform = `rotate(${heading}deg)`;
    }
  }

  private refreshMapLayout(): void {
    setTimeout(() => this.map?.invalidateSize(), 120);
  }

  private readonly slopeCoefStorageKey = 'pat.gps.slopeCoef.v1';

  private clampSlopeCoef(raw: number | string | null | undefined): number {
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? '').replace(',', '.'));
    if (!Number.isFinite(n)) {
      return 1;
    }
    const rounded = Math.round(n * 10) / 10;
    return Math.max(this.slopeCoefMin, Math.min(this.slopeCoefMax, rounded));
  }

  private loadSlopeCoef(): void {
    this.slopeCoef = this.readSlopeCoefLocal();
    this.slopeCoefSaveSub?.unsubscribe();
    this.slopeCoefSaveSub = this.api.getGpsSlopeScale().subscribe({
      next: (pref) => {
        this.slopeCoef = this.clampSlopeCoef(pref?.slopeCoef);
        this.persistSlopeCoefLocal();
        this.cdr.detectChanges();
      },
      error: () => undefined
    });
  }

  private readSlopeCoefLocal(): number {
    try {
      const raw = localStorage.getItem(this.slopeCoefStorageKey);
      return this.clampSlopeCoef(raw);
    } catch {
      return 1;
    }
  }

  private persistSlopeCoefLocal(): void {
    try {
      localStorage.setItem(this.slopeCoefStorageKey, String(this.slopeCoef));
    } catch {
      /* ignore */
    }
  }

  private scheduleSlopeCoefSave(): void {
    this.clearSlopeCoefSaveTimer();
    this.slopeCoefSaveTimer = setTimeout(() => this.saveSlopeCoefRemote(), 450);
  }

  private clearSlopeCoefSaveTimer(): void {
    if (this.slopeCoefSaveTimer != null) {
      clearTimeout(this.slopeCoefSaveTimer);
      this.slopeCoefSaveTimer = null;
    }
  }

  private saveSlopeCoefRemote(): void {
    this.slopeCoefSaveSub?.unsubscribe();
    this.slopeCoefSaveSub = this.api.saveGpsSlopeScale(this.slopeCoef).subscribe({
      next: (pref) => {
        this.slopeCoef = this.clampSlopeCoef(pref?.slopeCoef);
        this.persistSlopeCoefLocal();
      },
      error: () => undefined
    });
  }

  private requestElementFullscreen(el: HTMLElement, onCssFallback: () => void): void {
    const request = el.requestFullscreen?.bind(el)
      ?? (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(el);
    if (!request) {
      onCssFallback();
      return;
    }
    request().catch(() => onCssFallback());
  }

  private nativeFullscreenElement(): Element | null {
    const doc = document as Document & { webkitFullscreenElement?: Element };
    return document.fullscreenElement || doc.webkitFullscreenElement || null;
  }

  private isElementFullscreen(el: HTMLElement | undefined | null): boolean {
    return !!el && this.nativeFullscreenElement() === el;
  }

  private exitNativeFullscreen(): void {
    const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> };
    const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(document);
    exit?.().catch(() => undefined);
  }

  private exitMapFullscreenIfActive(): void {
    if (this.isElementFullscreen(this.mapShell?.nativeElement)) {
      this.exitNativeFullscreen();
      return;
    }
    if (this.mapFullscreen) {
      this.mapFullscreen = false;
      this.refreshMapLayout();
    }
  }

  private exitSlopeFullscreenIfActive(): void {
    if (this.isElementFullscreen(this.slopeFsRoot?.nativeElement)) {
      this.exitNativeFullscreen();
    }
    this.setSlopeFullscreen(false);
  }

  private setSlopeFullscreen(on: boolean): void {
    this.slopeFullscreen = on;
    if (typeof document === 'undefined') {
      return;
    }
    document.body.classList.toggle('gps-slope-fs', on);
    if (!on) {
      this.refreshMapLayout();
    }
  }
}
