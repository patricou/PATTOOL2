import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostBinding,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { ApiService } from '../services/api.service';
import { CameraLookTracker } from '../direction/camera-look-tracker';
import { computeFinderTurnGuide, normalizeDeg, type FinderTurnGuide } from '../direction/direction-attitude';
import { clampCamHeightPx, loadCamHeightPx, saveCamHeightPx } from '../shared/preview-cam-size';
import { applyMultiplicativeWheelScale, normalizeWheelDeltaPixels } from '../shared/wheel-zoom.util';
import {
  displayedFov,
  panoramaPath,
  projectVisiblePeaks,
  screenAngleDeg,
  screenRelativeRollDeg,
  silhouetteFillPath,
  silhouetteScreenPoints,
  silhouetteStrokePath,
  type PeakLabel,
  type ReliefHorizon,
  type ReliefPeak
} from './relief-horizon';

const CAM_HEIGHT_KEY = 'pat.relief-finder.cam-height-px';
const RADIUS_KEY = 'pat.relief-finder.radius-km';
const CAM_IMAGE_KEY = 'pat.relief-finder.cam-image';
const CAM_ZOOM_KEY = 'pat.relief-finder.cam-zoom';
const CAM_ZOOM_MIN = 1;
const CAM_ZOOM_MAX = 8;
const CAM_ZOOM_STEP = 0.25;
const LANDSCAPE_FS_BODY_CLASS = 'rf-landscape-fs';

@Component({
  selector: 'app-relief-finder',
  standalone: true,
  imports: [CommonModule, RouterModule, TranslateModule],
  templateUrl: './relief-finder.component.html',
  styleUrls: ['./relief-finder.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ReliefFinderComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('camStage') camStage?: ElementRef<HTMLElement>;
  private camEl?: ElementRef<HTMLVideoElement>;
  @HostBinding('class.rf--landscape') landscapeImmersive = false;

  @ViewChild('cam')
  set camRef(el: ElementRef<HTMLVideoElement> | undefined) {
    this.camEl = el;
    queueMicrotask(() => {
      void this.attachCameraStream();
    });
  }

  lookTracker!: CameraLookTracker;
  camLive = false;
  camDenied = false;
  camImageOn = true;
  isFullscreen = false;
  camHeightPx: number | null = null;
  stream: MediaStream | null = null;
  readonly camZoomMin = CAM_ZOOM_MIN;
  readonly camZoomMax = CAM_ZOOM_MAX;
  readonly camZoomStep = CAM_ZOOM_STEP;
  camZoom = CAM_ZOOM_MIN;
  camDigitalZoom = 1;
  camVideoTransform = 'scale(1)';
  private camZoomCaps: { min: number; max: number } | null = null;
  private camZoomGesturesBound = false;
  private camPinchStartDist = 0;
  private camPinchStartZoom = CAM_ZOOM_MIN;
  private readonly onCamWheelNative = (ev: WheelEvent): void => this.onCamWheel(ev);
  private readonly onCamTouchStartNative = (ev: TouchEvent): void => this.onCamTouchStart(ev);
  private readonly onCamTouchMoveNative = (ev: TouchEvent): void => this.onCamTouchMove(ev);
  private readonly onCamTouchEndNative = (ev: TouchEvent): void => this.onCamTouchEnd(ev);
  private landscapeOrientationMql: MediaQueryList | null = null;
  private readonly onLandscapeOrientationMedia = (): void => this.syncLandscapeImmersive();

  lat: number | null = null;
  lon: number | null = null;
  geoStatus: 'idle' | 'pending' | 'ready' | 'denied' | 'error' = 'idle';
  radiusKm = 60;
  readonly radiusOptions = [30, 60, 100];

  horizon: ReliefHorizon | null = null;
  loading = false;
  loadError = '';
  silhouetteFill = '';
  silhouetteStroke = '';
  panoramaFill = '';
  peakLabels: PeakLabel[] = [];
  selected: ReliefPeak | null = null;
  finderGuide: FinderTurnGuide | null = null;
  fovWindows: { x: number; w: number }[] = [];

  private horizonSub: Subscription | null = null;
  private paintTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly api: ApiService,
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.lookTracker = new CameraLookTracker(this.zone, () => this.onLookUpdate());
    this.camHeightPx = loadCamHeightPx(CAM_HEIGHT_KEY);
    this.camImageOn = loadCamImageOn();
    this.loadCamZoomPref();
    try {
      const stored = Number(localStorage.getItem(RADIUS_KEY));
      if (this.radiusOptions.includes(stored)) {
        this.radiusKm = stored;
      }
    } catch {
      /* ignore */
    }
    void this.lookTracker.start(false);
    if (this.camImageOn) {
      void this.startCamera();
    }
    this.locateGps();
  }

  ngAfterViewInit(): void {
    this.paintTimer = setInterval(() => this.onLookUpdate(), 80);
    this.bindCamZoomGestures();
    this.setupLandscapeWatchers();
    this.syncLandscapeImmersive();
  }

  ngOnDestroy(): void {
    if (this.paintTimer) {
      clearInterval(this.paintTimer);
    }
    this.horizonSub?.unsubscribe();
    this.lookTracker.stop();
    this.stopCamera();
    this.unbindCamZoomGestures();
    this.teardownLandscapeWatchers();
    this.setLandscapeImmersive(false);
  }

  @HostListener('document:fullscreenchange')
  onFs(): void {
    this.isFullscreen = !!document.fullscreenElement;
    this.cdr.markForCheck();
  }

  @HostListener('window:orientationchange')
  @HostListener('window:resize')
  onViewportChanged(): void {
    this.syncLandscapeImmersive();
    this.onLookUpdate();
  }

  async enableSensors(): Promise<void> {
    await this.lookTracker.start(true);
    this.cdr.markForCheck();
  }

  onCamImageToggle(ev: Event): void {
    const on = (ev.target as HTMLInputElement).checked;
    this.setCamImageOn(on);
  }

  setCamImageOn(on: boolean): void {
    this.camImageOn = on;
    try {
      localStorage.setItem(CAM_IMAGE_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (on) {
      void this.startCamera();
    } else {
      this.stopCamera();
    }
    this.cdr.markForCheck();
  }

  async startCamera(): Promise<void> {
    this.camDenied = false;
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      if (!this.camImageOn) {
        this.stopCamera();
        return;
      }
      await this.attachCameraStream();
      this.refreshCameraZoomCaps();
      this.syncCamZoomOutputs();
      this.bindCamZoomGestures();
    } catch {
      this.camDenied = true;
      this.camLive = false;
    }
    this.cdr.markForCheck();
  }

  stopCamera(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.camLive = false;
    this.camZoomCaps = null;
    const video = this.camEl?.nativeElement;
    if (video) {
      video.srcObject = null;
    }
    this.cdr.markForCheck();
  }

  private async attachCameraStream(): Promise<void> {
    const video = this.camEl?.nativeElement;
    if (!video || !this.stream) {
      return;
    }
    video.srcObject = this.stream;
    try {
      await video.play();
      this.camLive = true;
      this.refreshCameraZoomCaps();
      this.syncCamZoomOutputs();
    } catch {
      this.camLive = false;
    }
    this.cdr.markForCheck();
  }

  async toggleFullscreen(): Promise<void> {
    const stage = this.camStage?.nativeElement;
    if (!stage) {
      return;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      const el = stage as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
      if (stage.requestFullscreen) {
        await stage.requestFullscreen();
      } else if (el.webkitRequestFullscreen) {
        await Promise.resolve(el.webkitRequestFullscreen());
      }
    } catch {
      /* ignore */
    }
  }

  onCamResizePointer(ev: PointerEvent): void {
    if (this.isFullscreen || this.landscapeImmersive || ev.button !== 0) {
      return;
    }
    const startY = ev.clientY;
    const startH = this.camStage?.nativeElement.clientHeight ?? 280;
    const move = (e: PointerEvent) => {
      this.camHeightPx = clampCamHeightPx(startH + (e.clientY - startY));
      saveCamHeightPx(CAM_HEIGHT_KEY, this.camHeightPx);
      this.cdr.markForCheck();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  resetCamHeight(): void {
    this.camHeightPx = null;
    saveCamHeightPx(CAM_HEIGHT_KEY, null);
    this.cdr.markForCheck();
  }

  locateGps(): void {
    if (!navigator.geolocation) {
      this.geoStatus = 'error';
      this.cdr.markForCheck();
      return;
    }
    this.geoStatus = 'pending';
    this.cdr.markForCheck();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.lat = pos.coords.latitude;
        this.lon = pos.coords.longitude;
        this.geoStatus = 'ready';
        this.loadHorizon();
        this.cdr.markForCheck();
      },
      (err) => {
        this.geoStatus = err.code === err.PERMISSION_DENIED ? 'denied' : 'error';
        this.cdr.markForCheck();
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 }
    );
  }

  setRadius(km: number): void {
    this.radiusKm = km;
    try {
      localStorage.setItem(RADIUS_KEY, String(km));
    } catch {
      /* ignore */
    }
    this.loadHorizon();
  }

  loadHorizon(): void {
    if (this.lat == null || this.lon == null) {
      return;
    }
    this.loading = true;
    this.loadError = '';
    this.horizonSub?.unsubscribe();
    this.horizonSub = this.api.getReliefHorizon(this.lat, this.lon, this.radiusKm).subscribe({
      next: (res) => {
        this.horizon = res;
        this.loading = false;
        if (this.selected) {
          const next = res.peaks.find(
            (p) => p.name === this.selected?.name && Math.abs(p.lat - this.selected.lat) < 1e-4
          );
          this.selected = next ?? null;
        }
        this.onLookUpdate();
        this.cdr.markForCheck();
      },
      error: () => {
        this.loading = false;
        this.loadError = 'error';
        this.cdr.markForCheck();
      }
    });
  }

  selectPeak(peak: ReliefPeak): void {
    this.selected = peak;
    this.onLookUpdate();
  }

  visiblePeaks(): ReliefPeak[] {
    return (this.horizon?.peaks || []).filter((p) => p.visible);
  }

  hiddenCount(): number {
    return (this.horizon?.peaks || []).filter((p) => !p.visible).length;
  }

  azText(): string {
    const az = this.lookTracker.azimuthDeg;
    return az == null ? '—' : `${Math.round(normalizeDeg(az))}°`;
  }

  elText(): string {
    const el = this.lookTracker.elevationDeg;
    return el == null ? '—' : `${el.toFixed(1)}°`;
  }

  cardinal(): string {
    const az = this.lookTracker.azimuthDeg;
    if (az == null) {
      return '';
    }
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(normalizeDeg(az) / 45) % 8];
  }

  horizonTilt(): string {
    const r = screenRelativeRollDeg(this.lookTracker.rollDeg ?? 0, screenAngleDeg());
    return `rotate(${-r}deg)`;
  }

  get camZoomLabel(): string {
    const z = this.camZoom;
    const txt = Math.abs(z - Math.round(z)) < 0.05 ? String(Math.round(z)) : z.toFixed(1);
    return `${txt}×`;
  }

  camZoomIn(): void {
    this.setCamZoom(this.camZoom + CAM_ZOOM_STEP, true);
  }

  camZoomOut(): void {
    this.setCamZoom(this.camZoom - CAM_ZOOM_STEP, true);
  }

  resetCamZoom(): void {
    this.setCamZoom(CAM_ZOOM_MIN, true);
  }

  onCamZoomInput(ev: Event): void {
    const n = Number((ev.target as HTMLInputElement).value);
    if (!Number.isFinite(n)) {
      return;
    }
    this.setCamZoom(n, true);
  }

  fovWindowStyle(win: { x: number; w: number }): Record<string, string> {
    return {
      left: `${win.x}%`,
      width: `${win.w}%`
    };
  }

  private onLookUpdate(): void {
    const h = this.horizon;
    const camAz = this.lookTracker.azimuthDeg;
    const camEl = this.lookTracker.elevationDeg;
    if (!h || camAz == null || camEl == null) {
      this.silhouetteFill = '';
      this.silhouetteStroke = '';
      this.peakLabels = [];
      this.finderGuide = null;
      this.fovWindows = [];
      this.cdr.markForCheck();
      return;
    }
    const fov = displayedFov(this.camEl?.nativeElement, this.camStage?.nativeElement, this.camZoom);
    const pts = silhouetteScreenPoints(h, camAz, camEl, fov.hfov, fov.vfov);
    this.silhouetteFill = silhouetteFillPath(pts);
    this.silhouetteStroke = silhouetteStrokePath(pts);
    this.panoramaFill = panoramaPath(h.horizonElDeg);
    this.peakLabels = projectVisiblePeaks(h.peaks, camAz, camEl, fov.hfov, fov.vfov);
    const start = normalizeDeg(camAz - fov.hfov / 2);
    const wPct = (fov.hfov / 360) * 100;
    const xPct = (start / 360) * 100;
    this.fovWindows =
      xPct + wPct <= 100
        ? [{ x: xPct, w: wPct }]
        : [
            { x: xPct, w: 100 - xPct },
            { x: 0, w: xPct + wPct - 100 }
          ];
    if (this.selected) {
      const lab = this.peakLabels.find(
        (l) => l.peak.name === this.selected?.name && Math.abs(l.peak.lat - this.selected.lat) < 1e-4
      );
      const proj = lab
        ? {
            xPct: lab.xPct,
            yPct: lab.yPct,
            inView: lab.inView,
            inFront: true,
            sepDeg: Math.hypot(lab.xPct - 50, lab.yPct - 50) * 0.4,
            centered: lab.inView && Math.hypot(lab.xPct - 50, lab.yPct - 50) < 6
          }
        : null;
      this.finderGuide = computeFinderTurnGuide(
        camAz,
        camEl,
        this.selected.azDeg,
        this.selected.elDeg,
        proj
      );
    } else {
      this.finderGuide = null;
    }
    this.cdr.markForCheck();
  }

  distLabel(peak: ReliefPeak): string {
    return peak.distKm >= 10 ? `${Math.round(peak.distKm)} km` : `${peak.distKm.toFixed(1)} km`;
  }

  private onCamWheel(ev: WheelEvent): void {
    if (this.isCamZoomIgnoreTarget(ev.target)) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    this.setCamZoom(
      applyMultiplicativeWheelScale(
        this.camZoom,
        normalizeWheelDeltaPixels(ev),
        CAM_ZOOM_MIN,
        CAM_ZOOM_MAX
      ),
      false
    );
  }

  private onCamTouchStart(ev: TouchEvent): void {
    if (ev.touches.length !== 2) {
      this.camPinchStartDist = 0;
      return;
    }
    this.camPinchStartDist = this.touchDistance(ev.touches[0], ev.touches[1]);
    this.camPinchStartZoom = this.camZoom;
  }

  private onCamTouchMove(ev: TouchEvent): void {
    if (ev.touches.length !== 2 || this.camPinchStartDist < 8) {
      return;
    }
    ev.preventDefault();
    const dist = this.touchDistance(ev.touches[0], ev.touches[1]);
    this.setCamZoom((this.camPinchStartZoom * dist) / this.camPinchStartDist, false, false);
  }

  private onCamTouchEnd(ev?: TouchEvent): void {
    if (this.camPinchStartDist > 0 && (!ev || ev.touches.length < 2)) {
      this.setCamZoom(this.camZoom, true);
      this.camPinchStartDist = 0;
    }
  }

  private touchDistance(a: Touch, b: Touch): number {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  private isCamZoomIgnoreTarget(target: EventTarget | null): boolean {
    const el = target instanceof Element ? target : null;
    return !!el?.closest('button, input, label, a, select, textarea, .rf-cam__zoom, .rf-resize');
  }

  private setCamZoom(next: number, snap: boolean, persist = true): void {
    let z = Math.min(CAM_ZOOM_MAX, Math.max(CAM_ZOOM_MIN, next));
    if (snap) {
      z = Math.round(z / CAM_ZOOM_STEP) * CAM_ZOOM_STEP;
    }
    z = parseFloat(z.toFixed(2));
    if (z === this.camZoom && persist) {
      this.persistCamZoomPref();
      return;
    }
    this.camZoom = z;
    this.syncCamZoomOutputs();
    this.onLookUpdate();
    if (persist) {
      this.persistCamZoomPref();
    }
    this.cdr.markForCheck();
  }

  private syncCamZoomOutputs(): void {
    const caps = this.camZoomCaps;
    const track = this.stream?.getVideoTracks()[0];
    if (caps && track) {
      const hw = Math.min(caps.max, Math.max(caps.min, this.camZoom));
      this.camDigitalZoom = this.camZoom / hw;
      this.camVideoTransform = `scale(${this.camDigitalZoom})`;
      void track
        .applyConstraints({ advanced: [{ zoom: hw }] } as unknown as MediaTrackConstraints)
        .catch(() => {
          this.camDigitalZoom = this.camZoom;
          this.camVideoTransform = `scale(${this.camDigitalZoom})`;
          this.cdr.markForCheck();
        });
      return;
    }
    this.camDigitalZoom = this.camZoom;
    this.camVideoTransform = `scale(${this.camDigitalZoom})`;
  }

  private refreshCameraZoomCaps(): void {
    try {
      const track = this.stream?.getVideoTracks()[0];
      const caps = track?.getCapabilities?.() as
        | (MediaTrackCapabilities & { zoom?: number | { min?: number; max?: number } })
        | undefined;
      const z = caps?.zoom;
      if (z && typeof z === 'object' && Number.isFinite(z.max) && (z.max ?? 0) > (z.min ?? 1)) {
        this.camZoomCaps = { min: z.min ?? 1, max: z.max as number };
        return;
      }
    } catch {
      /* iOS / navigateurs sans zoom capteur */
    }
    this.camZoomCaps = null;
  }

  private bindCamZoomGestures(): void {
    const el = this.camStage?.nativeElement;
    if (!el || this.camZoomGesturesBound) {
      return;
    }
    el.addEventListener('wheel', this.onCamWheelNative, { passive: false, capture: true });
    el.addEventListener('touchstart', this.onCamTouchStartNative, { passive: true, capture: true });
    el.addEventListener('touchmove', this.onCamTouchMoveNative, { passive: false, capture: true });
    el.addEventListener('touchend', this.onCamTouchEndNative, { passive: true, capture: true });
    el.addEventListener('touchcancel', this.onCamTouchEndNative, { passive: true, capture: true });
    this.camZoomGesturesBound = true;
  }

  private unbindCamZoomGestures(): void {
    const el = this.camStage?.nativeElement;
    if (!el || !this.camZoomGesturesBound) {
      return;
    }
    el.removeEventListener('wheel', this.onCamWheelNative, true);
    el.removeEventListener('touchstart', this.onCamTouchStartNative, true);
    el.removeEventListener('touchmove', this.onCamTouchMoveNative, true);
    el.removeEventListener('touchend', this.onCamTouchEndNative, true);
    el.removeEventListener('touchcancel', this.onCamTouchEndNative, true);
    this.camZoomGesturesBound = false;
  }

  private loadCamZoomPref(): void {
    try {
      const raw = Number(localStorage.getItem(CAM_ZOOM_KEY));
      if (Number.isFinite(raw)) {
        this.camZoom = Math.min(CAM_ZOOM_MAX, Math.max(CAM_ZOOM_MIN, raw));
        this.camDigitalZoom = this.camZoom;
        this.camVideoTransform = `scale(${this.camDigitalZoom})`;
        return;
      }
    } catch {
      /* ignore */
    }
    this.camZoom = CAM_ZOOM_MIN;
    this.camDigitalZoom = CAM_ZOOM_MIN;
    this.camVideoTransform = 'scale(1)';
  }

  private persistCamZoomPref(): void {
    try {
      localStorage.setItem(CAM_ZOOM_KEY, String(this.camZoom));
    } catch {
      /* ignore */
    }
  }

  private setupLandscapeWatchers(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    this.landscapeOrientationMql = window.matchMedia('(orientation: landscape)');
    if (typeof this.landscapeOrientationMql.addEventListener === 'function') {
      this.landscapeOrientationMql.addEventListener('change', this.onLandscapeOrientationMedia);
    } else {
      (
        this.landscapeOrientationMql as MediaQueryList & {
          addListener?: (cb: () => void) => void;
        }
      ).addListener?.(this.onLandscapeOrientationMedia);
    }
  }

  private teardownLandscapeWatchers(): void {
    if (!this.landscapeOrientationMql) {
      return;
    }
    if (typeof this.landscapeOrientationMql.removeEventListener === 'function') {
      this.landscapeOrientationMql.removeEventListener('change', this.onLandscapeOrientationMedia);
    } else {
      (
        this.landscapeOrientationMql as MediaQueryList & {
          removeListener?: (cb: () => void) => void;
        }
      ).removeListener?.(this.onLandscapeOrientationMedia);
    }
    this.landscapeOrientationMql = null;
  }

  private isMobileLikeViewport(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    const touch = (navigator.maxTouchPoints || 0) > 0;
    return coarse || (narrow && touch);
  }

  private isLandscapeOrientation(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    if (this.landscapeOrientationMql) {
      return this.landscapeOrientationMql.matches;
    }
    return window.matchMedia('(orientation: landscape)').matches;
  }

  private syncLandscapeImmersive(): void {
    const on = this.isMobileLikeViewport() && this.isLandscapeOrientation();
    this.setLandscapeImmersive(on);
  }

  private setLandscapeImmersive(on: boolean): void {
    if (this.landscapeImmersive === on) {
      if (on) {
        document.body.classList.add(LANDSCAPE_FS_BODY_CLASS);
      } else {
        document.body.classList.remove(LANDSCAPE_FS_BODY_CLASS);
      }
      return;
    }
    this.landscapeImmersive = on;
    document.body.classList.toggle(LANDSCAPE_FS_BODY_CLASS, on);
    this.cdr.markForCheck();
    requestAnimationFrame(() => this.onLookUpdate());
  }
}

function loadCamImageOn(): boolean {
  try {
    return localStorage.getItem(CAM_IMAGE_KEY) !== '0';
  } catch {
    return true;
  }
}
