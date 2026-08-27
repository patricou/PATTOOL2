import {
  AfterViewInit,
  ChangeDetectionStrategy,
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
import { RouterModule } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { ApiService } from '../services/api.service';
import { CameraLookTracker } from '../direction/camera-look-tracker';
import { computeFinderTurnGuide, normalizeDeg, type FinderTurnGuide } from '../direction/direction-attitude';
import { clampCamHeightPx, loadCamHeightPx, saveCamHeightPx } from '../shared/preview-cam-size';
import {
  displayedFov,
  panoramaPath,
  projectVisiblePeaks,
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
  }

  ngOnDestroy(): void {
    if (this.paintTimer) {
      clearInterval(this.paintTimer);
    }
    this.horizonSub?.unsubscribe();
    this.lookTracker.stop();
    this.stopCamera();
  }

  @HostListener('document:fullscreenchange')
  onFs(): void {
    this.isFullscreen = !!document.fullscreenElement;
    this.cdr.markForCheck();
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
    if (this.isFullscreen || ev.button !== 0) {
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
    const rl = this.lookTracker.rollDeg ?? 0;
    return `rotate(${-rl}deg)`;
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
    const fov = displayedFov(this.camEl?.nativeElement, this.camStage?.nativeElement);
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
}

function loadCamImageOn(): boolean {
  try {
    return localStorage.getItem(CAM_IMAGE_KEY) !== '0';
  } catch {
    return true;
  }
}
