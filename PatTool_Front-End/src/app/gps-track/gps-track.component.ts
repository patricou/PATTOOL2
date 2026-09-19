import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  TemplateRef,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModal, NgbModalRef, NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { firstValueFrom, from, of, Subscription } from 'rxjs';
import { catchError, map, mergeMap, reduce } from 'rxjs/operators';

import { LeafletBasemapOption, LeafletBasemapService } from '../shared/leaflet-basemap.service';
import { L, RotatableLeafletMap } from '../shared/leaflet-rotate-setup';
import {
  attachLeafletMapWheelZoom,
  LEAFLET_SMOOTH_WHEEL_MAP_OPTIONS,
  LeafletMapWheelZoomHandle
} from '../shared/leaflet-map-wheel-zoom';
import { GpsBasemapPickerComponent } from '../shared/gps-basemap-picker.component';
import { CalendarEntry, CalendarService } from '../calendar/calendar.service';
import { MembersService } from '../services/members.service';
import { environment } from '../../environments/environment';
import { ApiService, GpsFollowSession, GpsLinkedActivity } from '../services/api.service';
import { FileService } from '../services/file.service';
import { GpsRecordingService, GpsLiveSnapshot, GpsUserFix } from '../services/gps-recording.service';
import {
  GpsOfflineMapProgress,
  GpsOfflineMapService
} from '../services/gps-offline-map.service';
import { GpsOfflinePackMeta, GpsOfflineTilesStore } from './gps-offline-tiles.store';
import { CachedOsmTileLayer } from '../shared/leaflet-cached-tile.layer';
import { GpsNav3dComponent, GpsNav3dFix } from '../gps-routing/gps-nav-3d.component';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import { GpsMapOrientation } from '../shared/gps-map-orientation';
import { parseTrackFileToLatLonPoints } from '../photo-timeline/track-route-stats.util';
import {
  analysisNeedsDemElevation,
  analyzeGpxFileContent,
  enrichAnalysisWithDemElevations,
  isGpxFileName,
  sampleLatLonsForElevation
} from '../gpx-trace/gpx-trace-analysis.util';
import { GpsHandoffPayload, readGpsHandoff } from './gps-handoff';
import {
  buildTrackGpx,
  coordsToArrays,
  decodeTrackBuffer,
  downloadTextFile,
  downsampleTrackPoints,
  elevationGainLoss,
  GpsTrackPt,
  haversineMeters,
  MAX_PLANNED_TRACK_POINTS,
  slugFileName,
  isTrackFileName,
  displayTrackFileName,
  exportTrackFileName,
  splitTrackSegments,
  trackHeadingAt,
  trackSlopeAt
} from './gps-geo.util';

interface GpsPlaceView {
  lat: number;
  lon: number;
  eleM: number | null;
  address: string;
  loading: boolean;
}

interface GpsLinkActivity {
  id: string;
  title: string;
  label: string;
  start: Date;
}

interface GpsTrackSaveStats {
  distanceM?: number | null;
  durationSec?: number | null;
  ascentM?: number | null;
  descentM?: number | null;
  fromLabel?: string;
  toLabel?: string;
}

@Component({
  selector: 'app-gps-track',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, GpsNav3dComponent, TraceViewerModalComponent, GpsBasemapPickerComponent],
  templateUrl: './gps-track.component.html',
  styleUrls: ['./gps-track.component.css']
})
export class GpsTrackComponent implements AfterViewInit, OnDestroy {
  @ViewChild('mapHost') mapHost?: ElementRef<HTMLDivElement>;
  @ViewChild('mapShell') mapShell?: ElementRef<HTMLElement>;
  @ViewChild('slopeFsRoot') slopeFsRoot?: ElementRef<HTMLElement>;
  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;
  @ViewChild('sessionsListModal') sessionsListModal?: TemplateRef<unknown>;
  @ViewChild('sessionDetailModal') sessionDetailModal?: TemplateRef<unknown>;
  @ViewChild(TraceViewerModalComponent) traceViewer?: TraceViewerModalComponent;

  snap: GpsLiveSnapshot = this.recording.snapshot;
  errorMessage = '';
  successMessage = '';
  isParsing = false;
  savingTrack = false;
  openingSessionTrace = false;
  isDragOver = false;
  mapBaseLayerId = 'opentopomap';
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
  sessionSearch = '';
  sessionFilter: 'all' | 'recorded' | 'imported' | 'active' = 'all';
  sessionSort: 'date_desc' | 'date_asc' | 'distance' | 'ascent' | 'title' | 'duration' = 'date_desc';
  sessionDetail: GpsFollowSession | null = null;
  linkActivityOpen = false;
  linkActivityId = '';
  linkActivitySearch = '';
  linkActivityFilter: 'all' | 'upcoming' | 'past' = 'all';
  linkActivitySort: 'date_desc' | 'date_asc' | 'title' = 'date_desc';
  linkActivities: GpsLinkActivity[] = [];
  linkActivitiesLoading = false;
  linkingActivity = false;
  startPlace: GpsPlaceView | null = null;
  finishPlace: GpsPlaceView | null = null;
  currentPlace: GpsPlaceView | null = null;
  offlineMeta: GpsOfflinePackMeta = { tileCount: 0, bytes: 0, updatedAt: null };
  offlineProgress: GpsOfflineMapProgress = { done: 0, total: 0, failed: 0 };
  offlineDownloading = false;
  offlineError = '';
  offlineFallback = false;

  readonly mapOrientations: { id: GpsMapOrientation; labelKey: string; icon: string }[] = [
    { id: 'north', labelKey: 'GPS_ROUTING.ORIENT_NORTH', icon: 'fa-compass' },
    { id: 'heading', labelKey: 'GPS_ROUTING.ORIENT_HEADING', icon: 'fa-location-arrow' },
    { id: 'route', labelKey: 'GPS_ROUTING.ORIENT_ROUTE', icon: 'fa-road' }
  ];

  get basemapOptions(): LeafletBasemapOption[] {
    return this.basemap.getAvailableLayers();
  }

  setMapBaseLayer(layerId: string): void {
    if (!this.map || !layerId) {
      this.mapBaseLayerId = layerId || this.mapBaseLayerId;
      return;
    }
    this.mapBaseLayerId = layerId;
    this.preferredBasemapId = layerId;
    this.offlineFallback = false;
    this.applyGpsBaseLayer();
  }

  get nav3dFix(): GpsNav3dFix | null {
    const u = this.snap.user;
    if (!u) {
      return null;
    }
    return { lat: u.lat, lon: u.lon, speedKmh: u.speedKmh, headingDeg: u.headingDeg };
  }

  get canSaveAsTrack(): boolean {
    return this.snap.recorded.length >= 2 && this.snap.status !== 'recording';
  }

  get canDownloadOfflineMap(): boolean {
    return this.snap.track.length >= 2 || this.snap.recorded.length >= 2;
  }

  get canDownloadOfflineHere(): boolean {
    return !!this.snap.user && Number.isFinite(this.snap.user.lat) && Number.isFinite(this.snap.user.lon);
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

  private map: RotatableLeafletMap | null = null;
  private mapWheelZoom: LeafletMapWheelZoomHandle | null = null;
  private lastAppliedBearingDeg: number | null = null;
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
  private offlineSub: Subscription | null = null;
  private preferredBasemapId = 'opentopomap';
  private lastOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
  private sessionsListModalRef: NgbModalRef | null = null;
  private sessionDetailModalRef: NgbModalRef | null = null;
  private linkActivitySub: Subscription | null = null;

  constructor(
    readonly recording: GpsRecordingService,
    private readonly basemap: LeafletBasemapService,
    private readonly api: ApiService,
    private readonly files: FileService,
    private readonly members: MembersService,
    private readonly calendar: CalendarService,
    private readonly offlineMap: GpsOfflineMapService,
    private readonly offlineTiles: GpsOfflineTilesStore,
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly cdr: ChangeDetectorRef,
    private readonly hostEl: ElementRef<HTMLElement>,
    private readonly zone: NgZone,
    private readonly modal: NgbModal
  ) {}

  ngAfterViewInit(): void {
    this.basemap.loadOptionalLayers(this.api);
    this.ensureMap();
    this.recording.ensureLocationWatch();
    this.loadSlopeCoef();
    this.sub = this.recording.snapshot$.subscribe((snap) => {
      this.snap = snap;
      this.applyOfflineBasemap(snap.online);
      this.paintMap();
      this.refreshPlaces(snap);
      this.cdr.detectChanges();
    });
    this.offlineSub = new Subscription();
    this.offlineSub.add(this.offlineMap.meta$.subscribe((m) => {
      this.offlineMeta = m;
      this.cdr.markForCheck();
    }));
    this.offlineSub.add(this.offlineMap.progress$.subscribe((p) => {
      this.offlineProgress = p;
      this.cdr.markForCheck();
    }));
    this.offlineSub.add(this.offlineMap.downloading$.subscribe((d) => {
      this.offlineDownloading = d;
      this.cdr.markForCheck();
    }));
    this.offlineSub.add(this.offlineMap.lastError$.subscribe((e) => {
      this.offlineError = e || '';
      this.cdr.markForCheck();
    }));
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
        void this.openTrackFromFile(fileId, fileName || 'track.gpx');
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
        void this.openTrackFromHandoff(handoff);
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
    this.offlineSub?.unsubscribe();
    this.offlineMap.cancel();
    this.startGeocodeSub?.unsubscribe();
    this.finishGeocodeSub?.unsubscribe();
    this.currentGeocodeSub?.unsubscribe();
    this.slopeCoefSaveSub?.unsubscribe();
    this.linkActivitySub?.unsubscribe();
    this.closeSessionDetail();
    this.closeSessionsList();
    this.resizeObserver?.disconnect();
    this.recording.stopLocationWatchIfIdle();
    this.mapWheelZoom?.detach();
    this.mapWheelZoom = null;
    this.lastAppliedBearingDeg = null;
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

  get canRecenterTrack(): boolean {
    return this.snap.track.length >= 2 || this.snap.recorded.length >= 2;
  }

  recenterOnTrack(): void {
    if (!this.map || !this.canRecenterTrack) {
      return;
    }
    const pts: L.LatLngExpression[] = [];
    for (const p of this.snap.track) {
      pts.push([p.lat, p.lon]);
    }
    for (const p of this.snap.recorded) {
      pts.push([p.lat, p.lon]);
    }
    if (pts.length < 2) {
      return;
    }
    const bounds = L.latLngBounds(pts);
    if (!bounds.isValid()) {
      return;
    }
    this.followUser = false;
    this.didFitTrack = true;
    this.map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
  }

  get canOpenTraceViewer(): boolean {
    return this.snap.track.length >= 2 || this.snap.recorded.length >= 2;
  }

  openInTraceViewer(): void {
    if (!this.traceViewer || !this.canOpenTraceViewer) {
      return;
    }
    const fileId = (this.snap.sourceFileId || '').trim();
    const fileName = this.currentTrackFileName() || this.snap.title || 'track.gpx';
    if (fileId) {
      this.traceViewer.openFromFile(fileId, fileName, undefined, this.snap.title);
      return;
    }
    const src = this.snap.track.length >= 2 ? this.snap.track : this.snap.recorded;
    const points = src.map((p) => ({ lat: p.lat, lng: p.lon }));
    if (points.length < 2) {
      return;
    }
    this.traceViewer.openWithTrackPoints(points, fileName, {
      initialBaseLayerId: this.mapBaseLayerId
    });
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
    this.successMessage = '';
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

  exportGpx(): void {
    const points = this.snap.recorded.length >= 2 ? this.snap.recorded : this.snap.track;
    if (points.length < 2) {
      this.errorMessage = 'GPS.ERR_SAVE_TRACK';
      this.successMessage = '';
      return;
    }
    this.downloadRecordedGpx(points, this.trackExportTitle());
  }

  async saveAsTrack(): Promise<void> {
    if (!this.canSaveAsTrack || this.savingTrack) {
      return;
    }
    const points = this.snap.recorded;
    if (points.length < 2) {
      this.errorMessage = 'GPS.ERR_SAVE_TRACK';
      this.successMessage = '';
      return;
    }
    this.savingTrack = true;
    this.errorMessage = '';
    this.successMessage = '';
    const title = this.trackExportTitle();
    const fileName = `pattool-${slugFileName(title, 'sortie')}.gpx`;
    this.recording.promoteRecordedAsTrack({ title, sourceFileName: fileName });
    this.downloadRecordedGpx(points, title, fileName);
    const itineraryOk = await this.persistRecordedItinerary(points, title);
    this.savingTrack = false;
    this.successMessage = itineraryOk ? 'GPS.SAVE_AS_TRACK_OK' : 'GPS.SAVE_AS_TRACK_OK_OFFLINE';
    this.didFitTrack = false;
    this.refreshSessions();
    this.cdr.markForCheck();
  }

  async saveSessionAsTrack(session: GpsFollowSession, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (!session.id || this.savingTrack) {
      return;
    }
    const count = session.recordedPointCount ?? session.recordedPoints?.length ?? 0;
    if (count < 2 && (session.recordedPoints?.length ?? 0) < 2) {
      this.errorMessage = 'GPS.ERR_SAVE_TRACK';
      this.successMessage = '';
      return;
    }
    if (this.recording.isBusy()) {
      this.savingTrack = true;
      this.errorMessage = '';
      this.successMessage = '';
      try {
        const full = await firstValueFrom(this.api.getGpsSession(session.id));
        const points = this.pointsFromSession(full);
        if (points.length < 2) {
          this.errorMessage = 'GPS.ERR_SAVE_TRACK';
          return;
        }
        const title = (full.title || session.title || this.trackExportTitle()).trim();
        this.downloadRecordedGpx(points, title, undefined, {
          distanceM: full.doneM,
          durationSec: full.durationSec,
          ascentM: full.ascentDoneM,
          descentM: full.descentDoneM
        });
        const itineraryOk = await this.persistRecordedItinerary(points, title, {
          distanceM: full.doneM,
          durationSec: full.durationSec,
          ascentM: full.ascentDoneM,
          descentM: full.descentDoneM
        });
        this.successMessage = itineraryOk ? 'GPS.SAVE_AS_TRACK_OK' : 'GPS.SAVE_AS_TRACK_OK_OFFLINE';
      } catch {
        this.errorMessage = 'GPS.ERR_LOAD_SESSION';
      } finally {
        this.savingTrack = false;
        this.cdr.markForCheck();
      }
      return;
    }
    await this.loadRemoteSessionById(session.id);
    await this.saveAsTrack();
  }

  canDownloadSession(session: GpsFollowSession | null | undefined): boolean {
    if (!session) {
      return false;
    }
    const recorded = session.recordedPointCount ?? session.recordedPoints?.length ?? 0;
    return recorded >= 2 || this.sessionPlannedPointCount(session) >= 2;
  }

  async downloadSessionGpx(session: GpsFollowSession, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (this.savingTrack) {
      return;
    }
    this.savingTrack = true;
    this.errorMessage = '';
    this.successMessage = '';
    try {
      const pack = await this.sessionGpxPack(session);
      if (!pack) {
        return;
      }
      this.downloadRecordedGpx(pack.points, pack.title, pack.fileName, pack.stats);
      this.successMessage = 'GPS.DOWNLOAD_OK';
    } finally {
      this.savingTrack = false;
      this.cdr.markForCheck();
    }
  }

  toggleLinkActivityPicker(): void {
    this.linkActivityOpen = !this.linkActivityOpen;
    this.errorMessage = '';
    if (this.linkActivityOpen) {
      this.ensureLinkActivities();
    }
  }

  async confirmLinkSessionToActivity(activityId?: string): Promise<void> {
    const id = (activityId || this.linkActivityId || '').trim();
    const session = this.sessionDetail;
    if (!id || !session || this.linkingActivity) {
      return;
    }
    this.linkActivityId = id;
    this.linkingActivity = true;
    this.errorMessage = '';
    this.successMessage = '';
    try {
      const pack = await this.sessionGpxPack(session);
      if (!pack) {
        return;
      }
      const user = await firstValueFrom(this.members.getUserId({ skipGeolocation: true }));
      if (!user?.id) {
        this.errorMessage = 'GPS.LINK_ACTIVITY_ERR';
        return;
      }
      const file = new File([pack.gpx], pack.fileName, { type: 'application/gpx+xml' });
      const form = new FormData();
      form.append('file', file, file.name);
      const base = (environment.API_URL4FILE || '/uploadfile').replace(/\/$/, '');
      const uploadUrl = `${base}/${user.id}/${id}`;
      await firstValueFrom(this.files.postFileToUrl(form, user, uploadUrl));
      await this.persistLinkedActivity(session, id);
      this.successMessage = 'GPS.LINK_ACTIVITY_OK';
      this.linkActivityOpen = false;
    } catch {
      this.errorMessage = 'GPS.LINK_ACTIVITY_ERR';
    } finally {
      this.linkingActivity = false;
      this.cdr.markForCheck();
    }
  }

  get sessionLinkedActivities(): GpsLinkActivity[] {
    const session = this.sessionDetail;
    if (!session) {
      return [];
    }
    const byId = new Map<string, GpsLinkActivity>();
    for (const a of session.linkedActivities || []) {
      if (a?.id) {
        byId.set(a.id, this.toSessionLinkedActivity(a));
      }
    }
    const ids = new Set(
      [...(session.linkedActivityIds || []), ...byId.keys()]
        .map((v) => (v || '').trim())
        .filter(Boolean)
    );
    for (const a of this.linkActivities) {
      if (ids.has(a.id) && !byId.has(a.id)) {
        byId.set(a.id, a);
      }
    }
    for (const id of ids) {
      if (!byId.has(id)) {
        byId.set(id, { id, title: id, label: id, start: new Date(0) });
      }
    }
    return Array.from(byId.values()).sort((a, b) => b.start.getTime() - a.start.getTime());
  }

  isSessionLinkedTo(activityId: string): boolean {
    const id = (activityId || '').trim();
    return !!id && this.sessionLinkedActivities.some((a) => a.id === id);
  }

  openLinkedActivity(activityId: string, event?: Event): void {
    event?.stopPropagation();
    const id = (activityId || '').trim();
    if (!id) {
      return;
    }
    this.closeSessionDetail();
    this.closeSessionsList();
    void this.router.navigate(['/details-evenement', id]);
  }

  private toSessionLinkedActivity(a: GpsLinkedActivity): GpsLinkActivity {
    const start = a.beginEventDate ? new Date(a.beginEventDate) : new Date(0);
    const title = (a.title || '').trim() || a.id;
    const datePart = !Number.isNaN(start.getTime()) && start.getTime() > 0
      ? start.toLocaleDateString()
      : '';
    return {
      id: a.id,
      title,
      label: datePart ? `${title} — ${datePart}` : title,
      start
    };
  }

  private async persistLinkedActivity(session: GpsFollowSession, activityId: string): Promise<void> {
    const id = activityId.trim();
    if (!id) {
      return;
    }
    const ids = Array.from(new Set([...(session.linkedActivityIds || []), id].map((v) => v.trim()).filter(Boolean)));
    const picked = this.linkActivities.find((a) => a.id === id);
    const linked = [...(session.linkedActivities || [])];
    if (picked && !linked.some((a) => a.id === id)) {
      linked.push({
        id: picked.id,
        title: picked.title,
        beginEventDate: Number.isNaN(picked.start.getTime()) ? null : picked.start.toISOString()
      });
    }
    session.linkedActivityIds = ids;
    session.linkedActivities = linked;
    this.sessionDetail = { ...session };
    this.sessions = this.sessions.map((s) => (s.id && s.id === session.id ? { ...session } : s));
    const clientSessionId = (session.clientSessionId || '').trim();
    if (!clientSessionId) {
      return;
    }
    try {
      const saved = await firstValueFrom(this.api.syncGpsSession({
        clientSessionId,
        linkedActivityIds: ids
      }));
      if (saved) {
        session.linkedActivityIds = saved.linkedActivityIds || ids;
        session.linkedActivities = saved.linkedActivities || linked;
        this.sessionDetail = { ...session, ...saved, linkedActivityIds: session.linkedActivityIds, linkedActivities: session.linkedActivities };
        this.sessions = this.sessions.map((s) => (s.id && s.id === session.id ? { ...s, ...this.sessionDetail } : s));
      }
    } catch {
      /* File is already on the activity; ids will also be recovered from the filename. */
    }
  }

  private resetLinkActivityUi(): void {
    this.linkActivityOpen = false;
    this.linkActivityId = '';
    this.linkActivitySearch = '';
    this.linkActivityFilter = 'all';
    this.linkingActivity = false;
  }

  get filteredLinkActivities(): GpsLinkActivity[] {
    const query = this.linkActivitySearch.trim().toLowerCase();
    const now = Date.now();
    let list = this.linkActivities;
    if (this.linkActivityFilter === 'upcoming') {
      list = list.filter((a) => a.start.getTime() >= now);
    } else if (this.linkActivityFilter === 'past') {
      list = list.filter((a) => a.start.getTime() < now);
    }
    if (query) {
      list = list.filter((a) =>
        a.title.toLowerCase().includes(query) || a.label.toLowerCase().includes(query)
      );
    }
    const sorted = list.slice();
    if (this.linkActivitySort === 'title') {
      sorted.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    } else if (this.linkActivitySort === 'date_asc') {
      sorted.sort((a, b) => a.start.getTime() - b.start.getTime());
    } else {
      sorted.sort((a, b) => b.start.getTime() - a.start.getTime());
    }
    return sorted;
  }

  private ensureLinkActivities(): void {
    if (this.linkActivities.length || this.linkActivitiesLoading) {
      return;
    }
    this.linkActivitiesLoading = true;
    this.linkActivitySub?.unsubscribe();
    const rangeFrom = new Date();
    rangeFrom.setFullYear(rangeFrom.getFullYear() - 12);
    const rangeTo = new Date();
    rangeTo.setFullYear(rangeTo.getFullYear() + 1);
    const chunkMs = 360 * 24 * 60 * 60 * 1000;
    const chunks: Array<{ start: Date; end: Date }> = [];
    let cursor = rangeFrom.getTime();
    const endMs = rangeTo.getTime();
    while (cursor < endMs) {
      const next = Math.min(cursor + chunkMs, endMs);
      chunks.push({ start: new Date(cursor), end: new Date(next) });
      cursor = next;
    }
    this.linkActivitySub = from(chunks).pipe(
      mergeMap(
        (ch) => this.calendar.getEntries(ch.start, ch.end).pipe(
          map((rows) => rows || []),
          catchError(() => of([] as CalendarEntry[]))
        ),
        4
      ),
      reduce((acc, rows) => {
        for (const e of rows) {
          if (e.kind === 'ACTIVITY' && e.id) {
            acc.set(e.id, e);
          }
        }
        return acc;
      }, new Map<string, CalendarEntry>())
    ).subscribe({
      next: (merged) => {
        this.linkActivities = Array.from(merged.values())
          .map((e) => {
            const start = e.start ? new Date(e.start) : new Date(0);
            const datePart = !Number.isNaN(start.getTime()) && start.getTime() > 0
              ? start.toLocaleDateString()
              : '';
            return {
              id: e.id,
              title: e.title || '',
              label: datePart ? `${e.title} — ${datePart}` : e.title,
              start
            };
          })
          .sort((a, b) => b.start.getTime() - a.start.getTime());
        this.linkActivitiesLoading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.linkActivities = [];
        this.linkActivitiesLoading = false;
        this.cdr.markForCheck();
      }
    });
  }

  private async sessionGpxPack(session: GpsFollowSession): Promise<{
    points: GpsTrackPt[];
    title: string;
    fileName: string;
    gpx: string;
    stats?: GpsTrackSaveStats;
  } | null> {
    if (!session.id) {
      this.errorMessage = 'GPS.ERR_SAVE_TRACK';
      this.successMessage = '';
      return null;
    }
    try {
      const full = await firstValueFrom(this.api.getGpsSession(session.id));
      const points = this.sessionGpxPoints(full);
      if (points.length < 2) {
        this.errorMessage = 'GPS.ERR_SAVE_TRACK';
        this.successMessage = '';
        return null;
      }
      const title = (full.title || session.title || this.trackExportTitle()).trim();
      const fileName = exportTrackFileName(full.sourceFileName || session.sourceFileName, title);
      const stats: GpsTrackSaveStats = {
        distanceM: full.doneM,
        durationSec: full.durationSec,
        ascentM: full.ascentDoneM,
        descentM: full.descentDoneM
      };
      const gpx = buildTrackGpx({
        points,
        name: title,
        desc: this.gpxDescription(points, stats),
        type: 'recorded'
      });
      return { points, title, fileName, gpx, stats };
    } catch {
      this.errorMessage = 'GPS.ERR_LOAD_SESSION';
      this.successMessage = '';
      return null;
    }
  }

  private sessionGpxPoints(session: GpsFollowSession): GpsTrackPt[] {
    const recorded = this.pointsFromSession(session);
    if (recorded.length >= 2) {
      return recorded;
    }
    return (session.plannedTrack || [])
      .filter((c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
      .map((c) => ({ lat: c[0], lon: c[1] }));
  }

  clear(): void {
    this.errorMessage = '';
    this.successMessage = '';
    this.recording.clearTrack();
    this.paintMap();
  }

  setMapOrientation(orientation: GpsMapOrientation): void {
    if (this.mapOrientation === orientation) {
      this.applyMapBearing(true);
      return;
    }
    this.mapOrientation = orientation;
    this.applyMapBearing(true);
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
        this.applyMapBearing(true);
        this.map?.invalidateSize();
      }, 80);
    }
  }

  onNav3dClosed(): void {
    this.nav3dActive = false;
    this.lastPaintKey = '';
    setTimeout(() => {
      this.paintMap();
      this.applyMapBearing(true);
      this.map?.invalidateSize();
    }, 80);
  }

  async downloadOfflineMap(): Promise<void> {
    const points = this.snap.track.length >= 2 ? this.snap.track : this.snap.recorded;
    if (points.length < 2) {
      this.offlineError = 'GPS.OFFLINE_MAP_NEED_POINTS';
      return;
    }
    this.successMessage = '';
    const ok = await this.offlineMap.downloadAround(points, false);
    if (ok) {
      this.successMessage = 'GPS.OFFLINE_MAP_DONE';
    }
    this.cdr.markForCheck();
  }

  async downloadOfflineHere(): Promise<void> {
    const u = this.snap.user;
    if (!u) {
      this.offlineError = 'GPS.OFFLINE_MAP_NEED_POINTS';
      return;
    }
    this.successMessage = '';
    const ok = await this.offlineMap.downloadAround([{ lat: u.lat, lon: u.lon }], true);
    if (ok) {
      this.successMessage = 'GPS.OFFLINE_MAP_DONE';
    }
    this.cdr.markForCheck();
  }

  cancelOfflineMap(): void {
    this.offlineMap.cancel();
  }

  async clearOfflineMap(): Promise<void> {
    await this.offlineMap.clear();
    this.successMessage = '';
    this.cdr.markForCheck();
  }

  formatOfflineSize(bytes: number | null | undefined): string {
    const n = bytes || 0;
    if (n < 1024) {
      return `${n} o`;
    }
    if (n < 1024 * 1024) {
      return `${Math.round(n / 1024)} Ko`;
    }
    return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} Mo`;
  }

  private applyOfflineBasemap(online: boolean): void {
    if (online === this.lastOnline) {
      return;
    }
    this.lastOnline = online;
    if (!this.map) {
      return;
    }
    if (!online && this.offlineMeta.tileCount > 0 && this.mapBaseLayerId !== 'osm-standard') {
      this.preferredBasemapId = this.mapBaseLayerId;
      this.mapBaseLayerId = 'osm-standard';
      this.offlineFallback = true;
      this.applyGpsBaseLayer();
      return;
    }
    if (!online) {
      this.basemap.silenceBrokenTiles(this.baseLayer);
      return;
    }
    if (online && this.offlineFallback) {
      this.mapBaseLayerId = this.preferredBasemapId;
      this.offlineFallback = false;
      this.applyGpsBaseLayer();
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

  get filteredSessions(): GpsFollowSession[] {
    const query = this.sessionSearch.trim().toLowerCase();
    const list = this.sessions.filter((s) => this.sessionMatchesFilters(s, query));
    return list.slice().sort((a, b) => this.compareSessions(a, b));
  }

  refreshSessions(): void {
    this.sessionsLoading = true;
    this.api.listGpsSessions().subscribe({
      next: (list) => {
        this.sessions = (list || []).slice().sort((a, b) => this.compareSessionsByDate(a, b, -1));
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
    this.closeSessionDetail();
    this.closeSessionsList();
    void this.loadRemoteSessionById(session.id);
  }

  openSessionsList(): void {
    if (!this.sessionsListModal || this.sessionsListModalRef) {
      this.refreshSessions();
      return;
    }
    this.refreshSessions();
    this.sessionsListModalRef = this.modal.open(this.sessionsListModal, {
      centered: true,
      scrollable: true,
      size: 'lg',
      windowClass: 'gps-sessions-list-modal'
    });
    this.sessionsListModalRef.closed.subscribe(() => {
      this.sessionsListModalRef = null;
    });
    this.sessionsListModalRef.dismissed.subscribe(() => {
      this.sessionsListModalRef = null;
    });
  }

  closeSessionsList(): void {
    this.sessionsListModalRef?.dismiss();
    this.sessionsListModalRef = null;
  }

  openSessionDetail(session: GpsFollowSession): void {
    if (!this.sessionDetailModal) {
      return;
    }
    this.sessionDetail = session;
    this.resetLinkActivityUi();
    this.closeSessionDetail();
    this.ensureLinkActivities();
    this.sessionDetailModalRef = this.modal.open(this.sessionDetailModal, {
      centered: true,
      scrollable: true,
      size: 'lg',
      windowClass: 'gps-session-detail-modal'
    });
    this.sessionDetailModalRef.closed.subscribe(() => {
      this.sessionDetailModalRef = null;
    });
    this.sessionDetailModalRef.dismissed.subscribe(() => {
      this.sessionDetailModalRef = null;
    });
  }

  closeSessionDetail(): void {
    this.sessionDetailModalRef?.dismiss();
    this.sessionDetailModalRef = null;
  }

  openSessionOnMap(): void {
    const session = this.sessionDetail;
    this.closeSessionDetail();
    this.closeSessionsList();
    if (session) {
      this.loadSession(session);
    }
  }

  canOpenSessionInTraceViewer(session: GpsFollowSession | null | undefined): boolean {
    if (!session) {
      return false;
    }
    if ((session.recordedPointCount || session.recordedPoints?.length || 0) >= 2) {
      return true;
    }
    if ((session.sourceFileId || '').trim()) {
      return true;
    }
    return (session.plannedTrack?.length || 0) >= 2;
  }

  async openSessionInTraceViewer(session: GpsFollowSession): Promise<void> {
    if (!this.traceViewer || !session.id || this.openingSessionTrace) {
      return;
    }
    this.openingSessionTrace = true;
    this.errorMessage = '';
    this.cdr.markForCheck();
    try {
      const full = await firstValueFrom(this.api.getGpsSession(session.id));
      const title = (full.title || session.title || 'track').trim();
      const fileName = exportTrackFileName(full.sourceFileName || session.sourceFileName, title);
      const recorded = this.pointsFromSession(full);
      if (recorded.length >= 2) {
        this.closeSessionDetail();
        this.traceViewer.openWithTrackPoints(
          recorded.map((p) => ({ lat: p.lat, lng: p.lon })),
          fileName,
          { initialBaseLayerId: this.mapBaseLayerId, titleLabel: title }
        );
        return;
      }
      const fileId = (full.sourceFileId || '').trim();
      if (fileId) {
        this.closeSessionDetail();
        this.traceViewer.openFromFile(fileId, fileName, undefined, title);
        return;
      }
      const planned = this.pointsFromPlannedTrack(full);
      if (planned.length >= 2) {
        this.closeSessionDetail();
        this.traceViewer.openWithTrackPoints(planned, fileName, {
          initialBaseLayerId: this.mapBaseLayerId,
          titleLabel: title
        });
        return;
      }
      this.errorMessage = 'GPS.ERR_NO_POINTS';
    } catch {
      this.errorMessage = 'GPS.ERR_LOAD_SESSION';
    } finally {
      this.openingSessionTrace = false;
      this.cdr.markForCheck();
    }
  }

  sessionStatusKey(session: GpsFollowSession | null | undefined): string {
    switch (session?.status) {
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

  sessionFileName(session: GpsFollowSession | null | undefined): string {
    return displayTrackFileName(session?.sourceFileName);
  }

  sessionListFileName(session: GpsFollowSession | null | undefined): string {
    const file = this.sessionFileName(session);
    if (!file) {
      return '';
    }
    const title = (session?.title || '').trim();
    if (!title) {
      return file;
    }
    const fileNorm = this.listTextKey(file.replace(/\.[^.]+$/, ''));
    const titleNorm = this.listTextKey(title);
    if (!fileNorm || fileNorm === titleNorm || titleNorm.includes(fileNorm) || fileNorm.includes(titleNorm)) {
      return '';
    }
    return file;
  }

  onSessionRowKey(event: Event, session: GpsFollowSession): void {
    event.preventDefault();
    this.openSessionDetail(session);
  }

  sessionListDate(session: GpsFollowSession | null | undefined): string {
    const formatted = this.formatSessionDate(this.sessionDateValue(session));
    return formatted === '—' ? '' : formatted;
  }

  private sessionMatchesFilters(session: GpsFollowSession, query: string): boolean {
    if (!this.sessionMatchesKind(session)) {
      return false;
    }
    if (!query) {
      return true;
    }
    const title = (session.title || '').toLowerCase();
    const file = this.sessionFileName(session).toLowerCase();
    return title.includes(query) || file.includes(query);
  }

  private sessionMatchesKind(session: GpsFollowSession): boolean {
    switch (this.sessionFilter) {
      case 'recorded':
        return this.sessionHasRecording(session);
      case 'imported':
        return !!this.sessionFileName(session) && !this.sessionHasRecording(session);
      case 'active':
        return session.status === 'recording' || session.status === 'paused';
      default:
        return true;
    }
  }

  private sessionHasRecording(session: GpsFollowSession): boolean {
    return (session.recordedPointCount || 0) >= 2 || (session.doneM || 0) > 10;
  }

  private compareSessions(a: GpsFollowSession, b: GpsFollowSession): number {
    switch (this.sessionSort) {
      case 'distance':
        return this.compareNum(b.doneM ?? b.plannedDistanceM, a.doneM ?? a.plannedDistanceM)
          || this.compareSessionsByDate(a, b, -1);
      case 'ascent':
        return this.compareNum(b.ascentDoneM ?? b.plannedAscentM, a.ascentDoneM ?? a.plannedAscentM)
          || this.compareSessionsByDate(a, b, -1);
      case 'duration':
        return this.compareNum(b.durationSec, a.durationSec) || this.compareSessionsByDate(a, b, -1);
      case 'title':
        return (a.title || this.sessionFileName(a) || '').localeCompare(
          b.title || this.sessionFileName(b) || '',
          undefined,
          { sensitivity: 'base' }
        );
      case 'date_asc':
        return this.compareSessionsByDate(a, b, 1);
      default:
        return this.compareSessionsByDate(a, b, -1);
    }
  }

  private compareSessionsByDate(a: GpsFollowSession, b: GpsFollowSession, dir: number): number {
    return (this.sessionDateMs(a) - this.sessionDateMs(b)) * dir;
  }

  private compareNum(a: number | null | undefined, b: number | null | undefined): number {
    const av = a != null && Number.isFinite(a) ? a : -1;
    const bv = b != null && Number.isFinite(b) ? b : -1;
    return av - bv;
  }

  private sessionDateValue(session: GpsFollowSession | null | undefined): string | null {
    const value = session?.startedAt || session?.finishedAt || session?.createdAt || session?.updatedAt || null;
    return value ? String(value) : null;
  }

  private sessionDateMs(session: GpsFollowSession | null | undefined): number {
    const raw = this.sessionDateValue(session);
    if (!raw) {
      return 0;
    }
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : 0;
  }

  currentTrackFileName(): string {
    return displayTrackFileName(this.snap.sourceFileName);
  }

  sessionPlannedPointCount(session: GpsFollowSession | null | undefined): number {
    return session?.plannedTrack?.length || 0;
  }

  sessionAvgSpeedKmh(session: GpsFollowSession | null | undefined): number | null {
    const dist = session?.doneM;
    const dur = session?.durationSec;
    if (dist == null || dur == null || !Number.isFinite(dist) || !Number.isFinite(dur) || dur < 1) {
      return null;
    }
    return (dist / 1000) / (dur / 3600);
  }

  formatSessionDate(value: string | null | undefined): string {
    if (!value) {
      return '—';
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      return '—';
    }
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'short',
        timeStyle: 'short'
      }).format(d);
    } catch {
      return d.toLocaleString();
    }
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
    this.successMessage = '';
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
      if (!this.errorMessage) {
        this.closeSessionsList();
        this.refreshSessions();
      }
      this.cdr.markForCheck();
    }
  }

  private async loadFromFileId(fileId: string, fileName: string): Promise<void> {
    this.isParsing = true;
    this.errorMessage = '';
    this.successMessage = '';
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
    this.errorMessage = '';
    this.successMessage = '';
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
    if (await this.reuseSavedOuting(fileId, fileName)) {
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

  private trackExportTitle(): string {
    const raw = (this.snap.title || '').trim();
    if (raw && raw.toLowerCase() !== 'gps') {
      return raw;
    }
    const day = new Date().toISOString().slice(0, 10);
    return `GPS ${day}`;
  }

  private pointsFromSession(session: GpsFollowSession): GpsTrackPt[] {
    return (session.recordedPoints || [])
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p) => ({
        lat: p.lat,
        lon: p.lon,
        eleM: p.eleM ?? null,
        gapBefore: p.gapBefore === true
      }));
  }

  private pointsFromPlannedTrack(session: GpsFollowSession): Array<{ lat: number; lng: number }> {
    const out: Array<{ lat: number; lng: number }> = [];
    for (const c of session.plannedTrack || []) {
      if (!Array.isArray(c) || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
        continue;
      }
      out.push({ lat: c[0], lng: c[1] });
    }
    return out;
  }

  private downloadRecordedGpx(
    points: GpsTrackPt[],
    title: string,
    fileName?: string,
    stats?: GpsTrackSaveStats
  ): void {
    const gpx = buildTrackGpx({
      points,
      name: title,
      desc: this.gpxDescription(points, stats),
      type: 'recorded'
    });
    const name = fileName || `pattool-${slugFileName(title, 'sortie')}.gpx`;
    downloadTextFile(name, gpx, 'application/gpx+xml;charset=utf-8');
  }

  private gpxDescription(points: GpsTrackPt[], stats?: GpsTrackSaveStats): string {
    const elev = elevationGainLoss(points);
    const dist = stats?.distanceM ?? this.snap.doneM;
    const duration = stats?.durationSec ?? this.snap.durationSec;
    const bits = [
      dist != null && Number.isFinite(dist) ? this.formatKm(dist) : '',
      elev.gainM ? `D+ ${this.formatElev(elev.gainM)}` : '',
      elev.lossM ? `D- ${this.formatElev(elev.lossM)}` : '',
      duration ? this.formatDuration(duration) : ''
    ].filter(Boolean);
    return bits.join(' · ');
  }

  private async persistRecordedItinerary(
    points: GpsTrackPt[],
    title: string,
    stats?: GpsTrackSaveStats
  ): Promise<boolean> {
    const from = points[0];
    const to = points[points.length - 1];
    if (!from || !to) {
      return false;
    }
    const coords = downsampleTrackPoints(points, MAX_PLANNED_TRACK_POINTS).map((p) =>
      p.eleM != null && Number.isFinite(p.eleM) ? [p.lat, p.lon, p.eleM] : [p.lat, p.lon]
    );
    const elev = elevationGainLoss(points);
    const fromLabel = stats?.fromLabel || (stats ? title : (this.startPlace?.address || title));
    const toLabel = stats?.toLabel || (stats ? title : (this.finishPlace?.address || this.currentPlace?.address || title));
    try {
      await firstValueFrom(
        this.api.createGpsItinerary({
          profile: 'foot-walking',
          from: { lat: from.lat, lon: from.lon, label: fromLabel },
          to: { lat: to.lat, lon: to.lon, label: toLabel },
          vias: [],
          distanceMeters: (stats?.distanceM ?? this.snap.doneM) || undefined,
          durationSeconds: (stats?.durationSec ?? this.snap.durationSec) || undefined,
          ascentMeters: (stats?.ascentM ?? this.snap.ascentDoneM) || elev.gainM || undefined,
          descentMeters: (stats?.descentM ?? this.snap.descentDoneM) || elev.lossM || undefined,
          coordinates: coords
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  private async openTrackFromFile(fileId: string, fileName: string): Promise<void> {
    if (await this.reuseSavedOuting(fileId, fileName)) {
      return;
    }
    await this.loadFromFileId(fileId, fileName);
  }

  private async openTrackFromHandoff(handoff: GpsHandoffPayload): Promise<void> {
    if (await this.reuseSavedOuting(handoff.fileId || null, handoff.fileName || handoff.title || null)) {
      return;
    }
    this.applyPoints(handoff.points, {
      title: handoff.title || (isTrackFileName(handoff.fileName) ? handoff.fileName : '') || 'GPS',
      sourceType: handoff.fileId ? 'file' : 'import',
      sourceFileId: handoff.fileId || null,
      sourceFileName: isTrackFileName(handoff.fileName) ? handoff.fileName : null
    });
  }

  private async reuseSavedOuting(fileId?: string | null, fileName?: string | null): Promise<boolean> {
    if (this.isSameOpenOuting(fileId, fileName) && this.snap.clientSessionId && this.snap.track.length >= 2) {
      return true;
    }
    if (this.isLiveOuting()) {
      return false;
    }
    const existing = await this.findSavedOuting(fileId, fileName);
    if (!existing?.id) {
      return false;
    }
    await this.loadRemoteSessionById(existing.id);
    return true;
  }

  private isLiveOuting(): boolean {
    return this.snap.status === 'recording' || this.snap.status === 'paused';
  }

  private isSameOpenOuting(fileId?: string | null, fileName?: string | null): boolean {
    const id = (fileId || '').trim();
    const curId = (this.snap.sourceFileId || '').trim();
    if (id && curId && id === curId) {
      return true;
    }
    const name = this.fileNameKey(fileName);
    const curName = this.fileNameKey(this.snap.sourceFileName);
    return !id && !!name && !!curName && name === curName && this.snap.track.length >= 2;
  }

  private async findSavedOuting(
    fileId?: string | null,
    fileName?: string | null
  ): Promise<GpsFollowSession | null> {
    const id = (fileId || '').trim();
    const name = this.fileNameKey(fileName);
    if (!id && !name) {
      return null;
    }
    let list = this.sessions;
    try {
      list = (await firstValueFrom(this.api.listGpsSessions())) || [];
      this.sessions = list;
      this.sessionsLoading = false;
    } catch {
      if (!list.length) {
        return null;
      }
    }
    if (id) {
      const byId = list.find((s) => (s.sourceFileId || '').trim() === id);
      if (byId) {
        return byId;
      }
    }
    if (!name) {
      return null;
    }
    return list.find((s) => this.fileNameKey(s.sourceFileName) === name) || null;
  }

  private fileNameKey(name?: string | null): string {
    const raw = (name || '').trim().toLowerCase().replace(/\\/g, '/');
    if (!raw || raw === 'track' || raw === 'track.gpx') {
      return '';
    }
    return raw.split('/').pop() || raw;
  }

  private listTextKey(value: string): string {
    return value
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/[.,;:/\\()[\]{}|→]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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
      plannedDescentM: meta.plannedDescentM,
      resetRecording: !this.isLiveOuting()
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

  private applyGpsBaseLayer(): void {
    if (!this.map) {
      return;
    }
    this.removeGpsBaseLayers();
    const useCachedOsm = this.offlineFallback || this.mapBaseLayerId === 'osm-standard';
    if (useCachedOsm) {
      this.baseLayer = new CachedOsmTileLayer(this.offlineTiles);
      this.baseLayer.addTo(this.map);
      this.baseLayer.bringToBack();
    } else {
      this.baseLayer = this.basemap.applyBaseLayer(this.map, this.mapBaseLayerId, null);
    }
    if (this.baseLayer instanceof L.TileLayer) {
      this.baseLayer.redraw();
    }
    this.basemap.silenceBrokenTiles(this.baseLayer);
    requestAnimationFrame(() => this.map?.invalidateSize());
  }

  private removeGpsBaseLayers(): void {
    if (!this.map) {
      this.baseLayer = null;
      return;
    }
    const toRemove: L.Layer[] = [];
    this.map.eachLayer((layer) => {
      if (layer === this.trackLayer || layer === this.userMarker) {
        return;
      }
      if (layer instanceof L.TileLayer) {
        toRemove.push(layer);
        return;
      }
      if (layer instanceof L.LayerGroup && !(layer instanceof L.FeatureGroup)) {
        toRemove.push(layer);
      }
    });
    for (const layer of toRemove) {
      this.map.removeLayer(layer);
    }
    this.baseLayer = null;
  }

  private ensureMap(): void {
    const el = this.mapHost?.nativeElement;
    if (!el || this.map) {
      return;
    }
    this.map = L.map(el, {
      zoomControl: true,
      attributionControl: true,
      ...LEAFLET_SMOOTH_WHEEL_MAP_OPTIONS,
      zoomAnimation: false,
      markerZoomAnimation: false,
      rotate: true,
      bearing: 0,
      touchRotate: false,
      shiftKeyRotate: false,
      rotateControl: false
    } as L.MapOptions) as RotatableLeafletMap;
    this.mapWheelZoom = attachLeafletMapWheelZoom(this.map);
    this.applyGpsBaseLayer();
    this.trackLayer = L.featureGroup().addTo(this.map);
    this.map.setView([46.6, 2.5], 6);
    this.applyMapBearing(true);
    setTimeout(() => this.map?.invalidateSize(), 0);
  }

  private paintMap(): void {
    this.ensureMap();
    if (!this.map || !this.trackLayer || this.nav3dActive) {
      this.syncUserMarker(this.snap.user);
      return;
    }
    const liveSplit = this.isLiveOuting();
    const key = `${this.snap.track.length}|${liveSplit ? this.snap.nearestIndex : 'all'}|${this.snap.recorded.length}`;
    if (key !== this.lastPaintKey) {
      this.lastPaintKey = key;
      this.trackLayer.clearLayers();
      const track = this.snap.track;
      if (track.length >= 2) {
        const idx = liveSplit
          ? Math.max(0, Math.min(this.snap.nearestIndex, Math.max(0, track.length - 1)))
          : 0;
        const remain = track.slice(idx).map((p) => [p.lat, p.lon] as L.LatLngExpression);
        if (liveSplit) {
          const done = track.slice(0, idx + 1).map((p) => [p.lat, p.lon] as L.LatLngExpression);
          if (done.length >= 2) {
            L.polyline(done, { color: '#343a40', weight: 5, opacity: 0.85 }).addTo(this.trackLayer);
          }
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
    this.applyMapBearing();
  }

  private pathHeadingDeg(): number {
    const planned = this.snap.track;
    if (planned.length >= 2) {
      const heading = trackHeadingAt(planned, this.snap.nearestIndex);
      if (heading != null) {
        return heading;
      }
    }
    const recorded = this.snap.recorded;
    if (recorded.length >= 2) {
      const heading = trackHeadingAt(recorded, recorded.length - 1);
      if (heading != null) {
        return heading;
      }
    }
    return 0;
  }

  private currentMapBearingDeg(): number {
    if (this.mapOrientation === 'north') {
      return 0;
    }
    if (this.mapOrientation === 'heading') {
      const walk = this.snap.user?.headingDeg;
      if (walk != null && Number.isFinite(walk)) {
        return walk;
      }
    }
    return this.pathHeadingDeg();
  }

  private applyMapBearing(force = false): void {
    if (!this.map || this.nav3dActive || typeof this.map.setBearing !== 'function') {
      return;
    }
    const bearing = ((this.currentMapBearingDeg() % 360) + 360) % 360;
    if (!force && this.lastAppliedBearingDeg != null) {
      const delta = Math.abs(bearing - this.lastAppliedBearingDeg);
      if (Math.min(delta, 360 - delta) < 0.5) {
        return;
      }
    }
    try {
      this.map.setBearing(bearing);
      this.lastAppliedBearingDeg = bearing;
      if (force) {
        this.map.invalidateSize({ animate: false });
      }
    } catch {
      // leaflet-rotate not ready
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
