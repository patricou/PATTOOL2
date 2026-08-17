import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ApiService } from '../services/api.service';
import {
  AttitudeOptions,
  CameraAttitude,
  GyroMagComplementary,
  HardIronCal,
  Vec3,
  cameraElevationFromGravity,
  cameraFromDeviceOrientation,
  cameraFromEarthToDeviceQuat,
  cameraFromMagAccel,
  CircularLowPass,
  circularDiff,
  circularMeanDeg,
  dipoleDeclinationDeg,
  haversineM,
  hypot3,
  initialBearingDeg,
  normalizeDeg,
  solarPosition,
  wrapSignedDeg
} from './direction-attitude';
import { magneticFieldAt } from '../nord/magnetic-declination';
import {
  DIRECTION_HARDIRON_KEY,
  NORD_CAL_STORAGE_KEY,
  writeSharedNordCal,
  type PersistedNordCal
} from '../shared/compass-north.engine';
import {
  PATTOOL_POSES,
  PattoolCalFile,
  PattoolCalMixMode,
  PattoolCalSnapshot,
  averageQuat,
  averageVec,
  canonicalizeLookCal,
  clearPattoolCal,
  composeLookAzimuth,
  composeLookElevation,
  loadPattoolCalMixMode,
  patchLookOffsets,
  savePattoolCalMixMode,
  sameCalSampleSet,
  snapshotFromPayload,
  snapshotsFromExport,
  mergeCalSamples,
  persistPattoolCalFromSamples
} from './direction-pattool-cal';
import { clampCamHeightPx, loadCamHeightPx, saveCamHeightPx } from '../shared/preview-cam-size';

type SensorStatus = 'off' | 'live' | 'missing' | 'denied';
type HeadingSource = 'rotation-vector' | 'mag-accel' | 'deviceorientation' | 'gyro-lock';
type NorthCalMethod = 'figure8' | 'manual' | 'gps' | 'sun';

const SOURCE_RANK: Record<HeadingSource, number> = {
  'rotation-vector': 3,
  'gyro-lock': 2,
  'mag-accel': 1,
  deviceorientation: 0
};

interface ParamRow {
  id: string;
  labelKey: string;
  value: string;
  warn?: boolean;
}

interface DashSection {
  id: string;
  labelKey: string;
  rows: ParamRow[];
}

interface SensorCard {
  id: string;
  labelKey: string;
  status: SensorStatus;
  lines: { k: string; v: string }[];
}

interface GenericSensor {
  start(): void;
  stop(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  x?: number;
  y?: number;
  z?: number;
  quaternion?: number[];
}

const PARAM_GROUPS: { id: string; labelKey: string; keys: string[] }[] = [
  { id: 'attitude', labelKey: 'DIRECTION.G_ATTITUDE', keys: ['az', 'el', 'rl', 'card', 'kind'] },
  { id: 'setup', labelKey: 'DIRECTION.G_SETUP', keys: ['src', 'off', 'pat'] },
  { id: 'field', labelKey: 'DIRECTION.G_FIELD', keys: ['dec', 'b'] },
  { id: 'gps', labelKey: 'DIRECTION.G_GPS', keys: ['gps'] },
  { id: 'look', labelKey: 'DIRECTION.G_LOOK', keys: ['look', 'q'] }
];
const CAL_KEY = DIRECTION_HARDIRON_KEY;
const FS_PARAMS_KEY = 'pat.direction.fs-params.v1';
const CAM_HEIGHT_KEY = 'pat.direction.cam-height-px';
const PAINT_MS = 50;

@Component({
  selector: 'app-direction',
  standalone: true,
  imports: [CommonModule, RouterModule, TranslateModule],
  templateUrl: './direction.component.html',
  styleUrls: ['./direction.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DirectionComponent implements AfterViewInit, OnDestroy {
  @ViewChild('cam') camEl?: ElementRef<HTMLVideoElement>;
  @ViewChild('camStage') camStage?: ElementRef<HTMLElement>;

  sensorsOn = false;
  needTap = false;
  denied = false;
  camDenied = false;
  camLive = false;
  isFullscreen = false;
  camHeightPx: number | null = null;
  private camResizing = false;
  private camResizePointerId: number | null = null;
  private camResizeStartY = 0;
  private camResizeStartH = 0;
  fsShowParams = true;
  trueNorth = true;
  calibrating = false;
  calPct = 0;
  calMethod: NorthCalMethod | null = null;
  calSamples = 0;
  readonly calNeededSamples = 8;
  readonly offsetMin = -180;
  readonly offsetMax = 180;
  offsetDeg = 0;
  showSensors = false;
  showPatExtra = false;
  showQuickHint = false;
  source: HeadingSource | null = null;
  patWizard = false;
  patPhase: 'north' | 'poses' = 'poses';
  patCapturing = false;
  patStep = 0;
  patError: string | null = null;
  patFile: PattoolCalFile | null = null;
  patDbCount = 0;
  patDbUser = '';
  patDbLoading = false;
  patSaving = false;
  patSeriesDone = false;
  private hideTitleTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTitleTries = 0;
  private titleScrollPadPx = 0;
  private hideTitleGuardUntil = 0;
  private readonly hideTitleOnScroll = (): void => {
    if (Date.now() > this.hideTitleGuardUntil) {
      this.unbindTitleHideGuard();
      return;
    }
    if (!this.pageTitleIsOffscreen()) {
      this.scrollPastPageTitle();
    }
  };
  patMixMode: PattoolCalMixMode = 'latest';
  readonly patPoses = PATTOOL_POSES;

  azimuthDeg: number | null = null;
  elevationDeg: number | null = null;
  rollDeg: number | null = null;
  magAzimuthDeg: number | null = null;
  declinationDeg: number | null = null;
  magUt: number | null = null;
  gpsLat: number | null = null;
  gpsLon: number | null = null;
  gpsAccM: number | null = null;
  lookEast: number | null = null;
  lookNorth: number | null = null;
  lookUp: number | null = null;
  quatTxt = '—';

  params: ParamRow[] = [];
  cards: SensorCard[] = DirectionComponent.emptyCards();
  liveCardList: SensorCard[] = [];
  unavailableCardList: SensorCard[] = [];
  dashSections: DashSection[] = [];
  magKnown = false;
  gpsKnown = false;

  /** GPS + déclinaison : sans ça, le Nord géographique n’est pas calculable. */
  get trueNorthAvailable(): boolean {
    return this.gpsKnown && this.declinationDeg != null && Number.isFinite(this.declinationDeg);
  }

  get trueNorthActive(): boolean {
    return this.trueNorth && this.trueNorthAvailable;
  }

  private mag: Vec3 = { x: 0, y: 0, z: 0 };
  private accel: Vec3 = { x: 0, y: 0, z: 9.81 };
  private readonly iosMotion =
    typeof navigator !== 'undefined' &&
    (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  private gyro: Vec3 = { x: 0, y: 0, z: 0 };
  private hasMag = false;
  private hasAccel = false;
  private hasGravity = false;
  private hasGyro = false;
  private hasRotationVector = false;
  private accelFromGeneric = false;
  private gyroFromGeneric = false;
  private stream: MediaStream | null = null;
  private generics: GenericSensor[] = [];
  private geoId: number | null = null;
  private orientName: 'deviceorientationabsolute' | 'deviceorientation' | null = null;
  private fusion = new GyroMagComplementary();
  private hardIron = new HardIronCal();
  private readonly azFilter = new CircularLowPass(0.15);
  private readonly rlFilter = new CircularLowPass(0.15);
  private lastPaint = 0;
  private displayedAz = 0;
  private displayedEl = 0;
  private displayedRl = 0;
  private azInited = false;
  private elInited = false;
  private rlInited = false;
  private readonly onOrient = (e: DeviceOrientationEvent): void => this.handleOrient(e);
  private readonly onMotion = (e: DeviceMotionEvent): void => this.handleMotion(e);
  private gpsPrev: { lat: number; lon: number; tMs: number } | null = null;
  private walkSpeedMps: number | null = null;
  private calAccum: number[] = [];
  private readonly calMinSpeedMps = 0.6;
  private lastQuat: number[] | null = null;
  private lastOrient: PattoolCalSnapshot['orient'] = null;
  private gpsHeading: number | null = null;
  private patSamples: PattoolCalSnapshot[] = [];
  private patSessionId: string | null = null;
  private patHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private patBurst: {
    quats: number[][];
    mags: Vec3[];
    accels: Vec3[];
    gyros: Vec3[];
    orients: NonNullable<PattoolCalSnapshot['orient']>[];
  } | null = null;

  constructor(
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef,
    private readonly api: ApiService,
    private readonly translate: TranslateService,
    private readonly hostEl: ElementRef<HTMLElement>
  ) {}

  ngAfterViewInit(): void {
    this.loadCal();
    this.loadPatCal();
    this.refreshPatDbCount();
    setTimeout(() => this.refreshPatDbCount(), 800);
    setTimeout(() => this.refreshPatDbCount(), 2500);
    this.loadFsParams();
    this.camHeightPx = loadCamHeightPx(CAM_HEIGHT_KEY);
    void this.boot(false);
    this.queueHidePageTitle();
  }

  private queueHidePageTitle(): void {
    this.hideTitleTries = 0;
    this.bindTitleHideGuard();
    this.zone.runOutsideAngular(() => {
      const run = (): void => {
        this.scrollPastPageTitle();
        this.hideTitleTries += 1;
        // Toujours réessayer : un hashchange (#/tools/direction) peut ramener le scroll à 0
        // après un premier masquage (cas « depuis astro-compass »).
        if (this.hideTitleTries < 22) {
          this.hideTitleTimer = setTimeout(run, this.hideTitleTries < 8 ? 50 : 120);
        } else {
          this.unbindTitleHideGuard();
        }
      };
      requestAnimationFrame(() => requestAnimationFrame(run));
    });
  }

  private bindTitleHideGuard(): void {
    this.unbindTitleHideGuard();
    this.hideTitleGuardUntil = Date.now() + 2400;
    window.addEventListener('scroll', this.hideTitleOnScroll, { passive: true });
    window.addEventListener('hashchange', this.hideTitleOnScroll);
  }

  private unbindTitleHideGuard(): void {
    window.removeEventListener('scroll', this.hideTitleOnScroll);
    window.removeEventListener('hashchange', this.hideTitleOnScroll);
    this.hideTitleGuardUntil = 0;
  }

  private pageTitleIsOffscreen(): boolean {
    const title = this.hostEl.nativeElement.querySelector('.pat-title') as HTMLElement | null;
    if (!title) {
      return true;
    }
    return title.getBoundingClientRect().bottom <= this.fixedChromeBottom() + 2;
  }

  private pageScroller(): HTMLElement {
    let el: HTMLElement | null = this.hostEl.nativeElement.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1) {
        return el;
      }
      el = el.parentElement;
    }
    return (document.scrollingElement as HTMLElement) || document.documentElement;
  }

  private ensureTitleScrollRoom(need: number): void {
    const scroller = this.pageScroller();
    const available = Math.max(0, scroller.scrollHeight - scroller.clientHeight - (scroller.scrollTop || 0));
    if (available >= need) {
      return;
    }
    const extra = need - available + 12;
    const currentPad = parseFloat(getComputedStyle(this.hostEl.nativeElement).paddingBottom) || 0;
    this.titleScrollPadPx = currentPad + extra;
    this.hostEl.nativeElement.style.paddingBottom = `${this.titleScrollPadPx}px`;
  }

  private scrollPastPageTitle(): void {
    const title = this.hostEl.nativeElement.querySelector('.pat-title') as HTMLElement | null;
    if (!title) {
      return;
    }
    const chromeBottom = this.fixedChromeBottom();
    const need = Math.ceil(title.getBoundingClientRect().bottom - chromeBottom + 6);
    if (need <= 0) {
      return;
    }
    this.ensureTitleScrollRoom(need);
    const scroller = this.pageScroller();
    const y = scroller.scrollTop || window.scrollY || 0;
    const next = Math.max(0, y + need);
    scroller.scrollTop = next;
    document.documentElement.scrollTop = next;
    document.body.scrollTop = next;
    window.scrollTo(0, next);
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

  ngOnDestroy(): void {
    if (this.hideTitleTimer != null) {
      clearTimeout(this.hideTitleTimer);
      this.hideTitleTimer = null;
    }
    this.unbindTitleHideGuard();
    this.clearPatHold();
    this.endCamResize();
    this.leaveFullscreen();
    this.stopEverything();
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  onFullscreenChange(): void {
    const stage = this.camStage?.nativeElement;
    const fs = this.fullscreenElement();
    this.isFullscreen = !!stage && fs === stage;
    this.cdr.markForCheck();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeQuickHint();
  }

  public startCamResize(ev: PointerEvent): void {
    if (this.isFullscreen) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    const el = this.camStage?.nativeElement;
    if (!el) {
      return;
    }
    this.camResizing = true;
    this.camResizePointerId = ev.pointerId;
    this.camResizeStartY = ev.clientY;
    this.camResizeStartH = el.getBoundingClientRect().height;
    try {
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  }

  public onCamResizeMove(ev: PointerEvent): void {
    if (!this.camResizing || ev.pointerId !== this.camResizePointerId) {
      return;
    }
    ev.preventDefault();
    this.camHeightPx = clampCamHeightPx(this.camResizeStartH + (ev.clientY - this.camResizeStartY));
    this.cdr.markForCheck();
  }

  public endCamResize(ev?: PointerEvent): void {
    if (!this.camResizing) {
      return;
    }
    if (ev && this.camResizePointerId != null && ev.pointerId !== this.camResizePointerId) {
      return;
    }
    this.camResizing = false;
    this.camResizePointerId = null;
    saveCamHeightPx(CAM_HEIGHT_KEY, this.camHeightPx);
    this.cdr.markForCheck();
  }

  public resetCamSize(ev: Event): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.camResizing = false;
    this.camResizePointerId = null;
    this.camHeightPx = null;
    saveCamHeightPx(CAM_HEIGHT_KEY, null);
    this.cdr.markForCheck();
  }

  async toggleFullscreen(): Promise<void> {
    const stage = this.camStage?.nativeElement;
    if (!stage) {
      return;
    }
    try {
      if (this.fullscreenElement()) {
        await this.leaveFullscreen();
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

  async enable(): Promise<void> {
    this.needTap = false;
    this.denied = false;
    await this.boot(true);
  }

  async startCamera(): Promise<void> {
    this.camDenied = false;
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      const video = this.camEl?.nativeElement;
      if (video) {
        video.srcObject = this.stream;
        await video.play();
        this.camLive = true;
      }
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

  chooseCal(method: NorthCalMethod): void {
    this.calMethod = method;
    this.calAccum = [];
    this.calSamples = 0;
    this.calibrating = false;
    this.calPct = 0;
    this.cdr.markForCheck();
  }

  startCal(): void {
    this.calMethod = 'figure8';
    this.calAccum = [];
    this.calSamples = 0;
    this.hardIron.reset();
    this.calibrating = true;
    this.calPct = 0;
    this.fusion.reset();
    this.cdr.markForCheck();
  }

  cancelCalMethod(): void {
    this.calMethod = null;
    this.calibrating = false;
    this.calAccum = [];
    this.calSamples = 0;
    this.cdr.markForCheck();
  }

  confirmManualNorth(): void {
    this.calibrateToTrueAzimuth(0);
    this.calMethod = null;
  }

  confirmSunNorth(): void {
    const sun = this.sunAzimuthDeg();
    if (sun == null) {
      return;
    }
    this.calibrateToTrueAzimuth(sun);
    this.calMethod = null;
  }

  sunAzimuthDeg(): number | null {
    if (this.gpsLat == null || this.gpsLon == null) {
      return null;
    }
    const sun = solarPosition(this.gpsLat, this.gpsLon, new Date());
    if (sun.elevationDeg < -1) {
      return null;
    }
    return sun.azimuthDeg;
  }

  sunElevationDeg(): number | null {
    if (this.gpsLat == null || this.gpsLon == null) {
      return null;
    }
    return solarPosition(this.gpsLat, this.gpsLon, new Date()).elevationDeg;
  }

  sunBelowHorizon(): boolean {
    const el = this.sunElevationDeg();
    return el != null && el < -1;
  }

  walkingFastEnough(): boolean {
    return this.walkSpeedMps != null && this.walkSpeedMps >= this.calMinSpeedMps;
  }

  forgetCal(): void {
    this.hardIron.reset();
    this.calibrating = false;
    try {
      localStorage.removeItem(CAL_KEY);
    } catch {
      /* ignore */
    }
    this.clearSharedNordHardIron();
    this.fusion.reset();
    this.cdr.markForCheck();
  }

  patPose() {
    return PATTOOL_POSES[this.patStep] ?? PATTOOL_POSES[0];
  }

  patCalibrated(): boolean {
    return !!this.patFile?.derived;
  }

  patSeriesCount(): number {
    return this.patFile?.seriesCount ?? 0;
  }

  setPatMixMode(mode: PattoolCalMixMode): void {
    if (this.patMixMode === mode) {
      return;
    }
    this.patMixMode = mode;
    savePattoolCalMixMode(mode);
    const samples = this.patFile?.samples ?? this.patSamples;
    if (samples.length >= 4) {
      this.commitPatCal(samples);
    }
    this.cdr.markForCheck();
  }

  patPoseDone(id: string): boolean {
    return this.patSamples.some((s) => s.poseId === id);
  }

  patCardFor(az: number | null | undefined): string {
    if (az == null || !Number.isFinite(az)) {
      return '—';
    }
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    return names[Math.round(normalizeDeg(az) / 45) % 8];
  }

  patAzDelta(): number | null {
    const want = this.patPose().expectedAz;
    const got = this.azInited ? this.displayedAz : this.azimuthDeg;
    if (want == null || got == null) {
      return null;
    }
    return circularDiff(got, want);
  }

  patElDelta(): number | null {
    const got = this.elInited ? this.displayedEl : this.elevationDeg;
    if (got == null) {
      return null;
    }
    return got - this.patPose().expectedEl;
  }

  patAligned(): boolean {
    const el = this.patElDelta();
    if (el == null) {
      return false;
    }
    const elTol = Math.abs(this.patPose().expectedEl) >= 80 ? 22 : 16;
    if (Math.abs(el) > elTol) {
      return false;
    }
    const az = this.patAzDelta();
    return az == null || Math.abs(az) <= 22;
  }

  patCoachKey(): string {
    if (!this.sensorsOn) {
      return 'DIRECTION.PAT_COACH_SENSORS';
    }
    if (this.patPhase === 'north') {
      return 'DIRECTION.PAT_COACH_NORTH';
    }
    if (this.patCapturing) {
      return 'DIRECTION.PAT_HOLD';
    }
    if (this.patSaving) {
      return 'DIRECTION.PAT_SAVING';
    }
    if (!this.patAligned()) {
      const id = this.patPose().id;
      if (id === 'tilt') {
        return 'DIRECTION.PAT_COACH_ALIGN_TILT';
      }
      if (id === 'sky') {
        return 'DIRECTION.PAT_COACH_ALIGN_SKY';
      }
      if (id === 'ground') {
        return 'DIRECTION.PAT_COACH_ALIGN_GROUND';
      }
      return 'DIRECTION.PAT_COACH_ALIGN';
    }
    return 'DIRECTION.PAT_COACH_SAVE';
  }

  patProgressN(): number {
    return this.patPhase === 'north' ? 1 : this.patStep + 2;
  }

  patProgressTotal(): number {
    return this.patPoses.length + 1;
  }

  confirmPatNorth(): void {
    if (this.magAzimuthDeg == null) {
      this.patError = 'DIRECTION.PAT_FAIL';
      this.cdr.markForCheck();
      return;
    }
    this.confirmManualNorth();
    this.patPhase = 'poses';
    this.patStep = 0;
    this.patError = null;
    this.cdr.markForCheck();
  }

  patExpectParams(): { az: number; card: string; el: number } {
    const pose = this.patPose();
    return {
      az: pose.expectedAz ?? 0,
      card: this.patCardFor(pose.expectedAz),
      el: pose.expectedEl
    };
  }

  patLiveParams(): { az: string; card: string; el: string } {
    const az = this.azInited ? this.displayedAz : this.azimuthDeg;
    const el = this.elInited ? this.displayedEl : this.elevationDeg;
    return {
      az: az != null ? az.toFixed(0) : '—',
      card: this.patCardFor(az),
      el: el != null ? `${el >= 0 ? '+' : ''}${el.toFixed(0)}` : '—'
    };
  }

  startPatWizard(): void {
    if (!this.sensorsOn) {
      void this.enable();
    }
    if (!this.camLive) {
      void this.startCamera();
    }
    this.cancelCalMethod();
    this.clearPatHold();
    this.patWizard = true;
    this.patPhase = 'north';
    this.patCapturing = false;
    this.patSeriesDone = false;
    this.patStep = 0;
    this.patSamples = [];
    this.patSessionId = DirectionComponent.newSessionId();
    this.patError = null;
    this.cdr.markForCheck();
  }

  cancelPatWizard(): void {
    this.clearPatHold();
    this.patWizard = false;
    this.patCapturing = false;
    this.patError = null;
    this.cdr.markForCheck();
  }

  forgetPatCal(): void {
    this.cancelPatWizard();
    this.patFile = null;
    this.patSamples = [];
    clearPattoolCal();
    this.fusion.reset();
    this.publish();
  }

  exportPatDb(): void {
    this.patError = null;
    this.patDbLoading = true;
    this.api.exportDirectionPattoolCal().subscribe({
      next: (data) => {
        this.patDbLoading = false;
        this.patDbCount = data.count ?? data.samples?.length ?? 0;
        if (data.ownerUsername) {
          this.patDbUser = data.ownerUsername;
        }
        if (this.patDbCount < 1) {
          this.patError = 'DIRECTION.PAT_EMPTY';
          this.cdr.markForCheck();
          return;
        }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `pattool-direction-cal-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.cdr.markForCheck();
      },
      error: () => {
        this.patDbLoading = false;
        this.patError = 'DIRECTION.PAT_SYNC_FAIL';
        this.cdr.markForCheck();
      }
    });
  }

  importPatFile(ev: Event): void {
    const input = ev.target as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {
      return;
    }
    this.patError = null;
    void file.text().then((text) => {
      try {
        const snaps = snapshotsFromExport(JSON.parse(text) as unknown);
        if (snaps.length < 4) {
          this.patError = 'DIRECTION.PAT_IMPORT_FAIL';
          this.cdr.markForCheck();
          return;
        }
        this.patSamples = snaps;
        this.commitPatCal(snaps);
        if (!this.patFile) {
          this.patError = 'DIRECTION.PAT_IMPORT_FAIL';
        } else {
          this.patSeriesDone = true;
          this.patError = null;
        }
      } catch {
        this.patError = 'DIRECTION.PAT_IMPORT_FAIL';
      }
      if (input) {
        input.value = '';
      }
      this.cdr.markForCheck();
    });
  }

  clearPatDb(): void {
    if (!window.confirm(this.translate.instant('DIRECTION.PAT_FORGET_CONFIRM'))) {
      return;
    }
    this.patError = null;
    this.api.deleteDirectionPattoolSamples().subscribe({
      next: () => {
        this.patDbCount = 0;
        this.patFile = null;
        this.patSamples = [];
        this.patSeriesDone = false;
        clearPattoolCal();
        this.fusion.reset();
        this.publish();
        this.cdr.markForCheck();
      },
      error: () => {
        this.patError = 'DIRECTION.PAT_SYNC_FAIL';
        this.cdr.markForCheck();
      }
    });
  }

  capturePatPose(): void {
    if (!this.patWizard || this.patPhase !== 'poses' || this.patCapturing || this.patSaving) {
      return;
    }
    this.patCapturing = true;
    this.patError = null;
    this.patBurst = { quats: [], mags: [], accels: [], gyros: [], orients: [] };
    this.pushPatBurst();
    this.patHoldTimer = setTimeout(() => this.zone.run(() => this.finishPatCapture()), 800);
    this.cdr.markForCheck();
  }

  onOffsetInput(ev: Event): void {
    const el = ev.target as HTMLInputElement | null;
    this.onOffset(el?.value ?? '0');
  }

  onOffset(raw: string): void {
    const n = Number(raw);
    this.setOffset(Number.isFinite(n) ? n : 0);
  }

  nudgeOffset(delta: number): void {
    this.setOffset(this.offsetDeg + delta);
  }

  resetOffset(): void {
    this.setOffset(0);
  }

  toggleSensors(): void {
    this.showSensors = !this.showSensors;
    this.cdr.markForCheck();
  }

  toggleQuickHint(): void {
    this.showQuickHint = !this.showQuickHint;
    this.cdr.markForCheck();
  }

  closeQuickHint(): void {
    if (!this.showQuickHint) {
      return;
    }
    this.showQuickHint = false;
    this.cdr.markForCheck();
  }

  togglePatExtra(): void {
    this.showPatExtra = !this.showPatExtra;
    this.cdr.markForCheck();
  }

  toggleTrueNorth(): void {
    if (!this.trueNorthAvailable) {
      return;
    }
    this.trueNorth = !this.trueNorth;
    this.syncSharedNordCal();
    this.publish();
  }

  toggleFsParams(): void {
    this.fsShowParams = !this.fsShowParams;
    try {
      localStorage.setItem(FS_PARAMS_KEY, this.fsShowParams ? '1' : '0');
    } catch {
      /* ignore */
    }
    this.cdr.markForCheck();
  }

  azText(): string {
    return this.azInited ? normalizeDeg(this.displayedAz).toFixed(0) : '—';
  }

  elText(): string {
    if (!this.elInited) {
      return '—';
    }
    return `${this.displayedEl >= 0 ? '+' : ''}${this.displayedEl.toFixed(0)}°`;
  }

  rollText(): string {
    if (!this.rlInited) {
      return '—';
    }
    return `${this.displayedRl >= 0 ? '+' : ''}${this.displayedRl.toFixed(0)}°`;
  }

  cardinal(): string {
    if (!this.azInited) {
      return '—';
    }
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    return names[Math.round(normalizeDeg(this.displayedAz) / 45) % 8];
  }

  trackParam(_i: number, p: ParamRow): string {
    return p.id;
  }

  trackCard(_i: number, c: SensorCard): string {
    return c.id;
  }

  trackLine(_i: number, ln: { k: string; v: string }): string {
    return ln.k;
  }

  trackDash(_i: number, s: DashSection): string {
    return s.id;
  }

  sensorLive(id: string): boolean {
    return this.cards.some((c) => c.id === id && c.status === 'live');
  }

  hardIronReady(): boolean {
    return this.hardIron.ready;
  }

  isI18nValue(p: ParamRow): boolean {
    return p.id === 'kind' || p.id === 'src';
  }

  roseDeg(): number {
    return this.azInited ? -this.displayedAz : 0;
  }

  horizonTilt(): string {
    return `rotate(${-(this.rlInited ? this.displayedRl : 0)}deg) translateY(${-((this.elInited ? this.displayedEl : 0) / 90) * 42}%)`;
  }

  sourceKey(): string {
    switch (this.source) {
      case 'rotation-vector':
        return 'DIRECTION.SRC_RV';
      case 'mag-accel':
        return 'DIRECTION.SRC_MAG';
      case 'deviceorientation':
        return 'DIRECTION.SRC_DO';
      case 'gyro-lock':
        return 'DIRECTION.SRC_GYRO';
      default:
        return 'DIRECTION.SRC_NONE';
    }
  }

  private async boot(fromTap: boolean): Promise<void> {
    const doe = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    const dme = window.DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    if (typeof doe.requestPermission === 'function') {
      if (!fromTap) {
        this.needTap = true;
        this.cdr.markForCheck();
        return;
      }
      try {
        if ((await doe.requestPermission()) !== 'granted') {
          this.denied = true;
          this.cdr.markForCheck();
          return;
        }
        if (typeof dme.requestPermission === 'function') {
          try {
            await dme.requestPermission();
          } catch {
            /* optional */
          }
        }
      } catch {
        this.denied = true;
        this.cdr.markForCheck();
        return;
      }
    }
    this.sensorsOn = true;
    this.markMissing();
    this.syncCardLists();
    this.startGenerics();
    this.startOrientation();
    this.startMotion();
    this.startGps();
    void this.startCamera();
    this.cdr.markForCheck();
  }

  private markMissing(): void {
    const w = window as unknown as Record<string, unknown>;
    const map: { id: string; ctor: string }[] = [
      { id: 'mag', ctor: 'Magnetometer' },
      { id: 'acc', ctor: 'Accelerometer' },
      { id: 'gyro', ctor: 'Gyroscope' },
      { id: 'abs', ctor: 'AbsoluteOrientationSensor' },
      { id: 'rel', ctor: 'RelativeOrientationSensor' }
    ];
    for (const m of map) {
      if (typeof w[m.ctor] !== 'function') {
        this.setCard(m.id, 'missing', []);
      }
    }
    if (!('DeviceOrientationEvent' in window)) {
      this.setCard('do', 'missing', []);
    }
    if (!('DeviceMotionEvent' in window)) {
      this.setCard('dm', 'missing', []);
    }
    if (!navigator.geolocation) {
      this.setCard('gps', 'missing', []);
    }
  }

  private startGenerics(): void {
    const w = window as unknown as Record<string, unknown>;
    this.trySensor(
      'mag',
      w['Magnetometer'] as (new (o: { frequency: number }) => GenericSensor) | undefined,
      (s) => {
        const v = { x: s.x ?? 0, y: s.y ?? 0, z: s.z ?? 0 };
        this.onMag(v);
        this.setCard('mag', 'live', this.xyz(this.mag, 'µT'));
      }
    );
    this.trySensor(
      'acc',
      w['Accelerometer'] as (new (o: { frequency: number }) => GenericSensor) | undefined,
      (s) => {
        const v = { x: s.x ?? 0, y: s.y ?? 0, z: s.z ?? 0 };
        this.accelFromGeneric = true;
        this.setCard('acc', 'live', this.xyz(v, 'm/s²'));
        if (!this.hasGravity) {
          this.setAccel(v);
        }
      }
    );
    this.trySensor(
      'grav',
      w['GravitySensor'] as (new (o: { frequency: number }) => GenericSensor) | undefined,
      (s) => {
        this.hasGravity = true;
        this.accelFromGeneric = true;
        this.setAccel({ x: s.x ?? 0, y: s.y ?? 0, z: s.z ?? 0 });
      }
    );
    this.trySensor(
      'gyro',
      w['Gyroscope'] as (new (o: { frequency: number }) => GenericSensor) | undefined,
      (s) => {
        this.gyro = { x: s.x ?? 0, y: s.y ?? 0, z: s.z ?? 0 };
        this.hasGyro = true;
        this.gyroFromGeneric = true;
        this.setCard('gyro', 'live', this.xyz(this.gyro, 'rad/s'));
        this.pushPatBurst();
        this.fuse();
      }
    );
    this.trySensor(
      'abs',
      w['AbsoluteOrientationSensor'] as
        | (new (o: { frequency: number; referenceFrame?: string }) => GenericSensor)
        | undefined,
      (s) => this.onAbsQuat(s.quaternion),
      { referenceFrame: 'device' }
    );
    this.trySensor(
      'rel',
      w['RelativeOrientationSensor'] as (new (o: { frequency: number }) => GenericSensor) | undefined,
      (s) => {
        const q = s.quaternion;
        this.setCard('rel', 'live', [
          { k: 'x', v: this.n(q?.[0]) },
          { k: 'y', v: this.n(q?.[1]) },
          { k: 'z', v: this.n(q?.[2]) },
          { k: 'w', v: this.n(q?.[3]) }
        ]);
      }
    );
  }

  private trySensor(
    id: string,
    Ctor: (new (o: { frequency: number; referenceFrame?: string }) => GenericSensor) | undefined,
    onRead: (s: GenericSensor) => void,
    extra?: { referenceFrame?: string }
  ): void {
    if (typeof Ctor !== 'function') {
      return;
    }
    try {
      const s = new Ctor({ frequency: 30, ...extra });
      this.zone.runOutsideAngular(() => {
        s.addEventListener('reading', () => onRead(s));
        s.addEventListener('error', () => {
          this.setCard(id, 'denied', []);
          this.cdr.markForCheck();
        });
        s.start();
      });
      this.generics.push(s);
    } catch {
      this.setCard(id, 'denied', []);
    }
  }

  private startOrientation(): void {
    if (!('DeviceOrientationEvent' in window)) {
      return;
    }
    const abs = 'ondeviceorientationabsolute' in window;
    this.orientName = abs ? 'deviceorientationabsolute' : 'deviceorientation';
    this.zone.runOutsideAngular(() => {
      window.addEventListener(this.orientName!, this.onOrient, true);
    });
  }

  private startMotion(): void {
    if (!('DeviceMotionEvent' in window)) {
      return;
    }
    this.zone.runOutsideAngular(() => {
      window.addEventListener('devicemotion', this.onMotion, true);
    });
  }

  private startGps(): void {
    if (!navigator.geolocation) {
      return;
    }
    this.geoId = navigator.geolocation.watchPosition(
      (p) => {
        this.gpsLat = p.coords.latitude;
        this.gpsLon = p.coords.longitude;
        this.gpsAccM = p.coords.accuracy;
        const field = magneticFieldAt(this.gpsLat, this.gpsLon);
        this.declinationDeg = field?.declinationDeg ?? dipoleDeclinationDeg(this.gpsLat, this.gpsLon);
        this.gpsKnown = true;
        const gpsLines = [
          { k: 'lat', v: this.gpsLat.toFixed(5) },
          { k: 'lon', v: this.gpsLon.toFixed(5) },
          { k: '±m', v: this.gpsAccM.toFixed(0) }
        ];
        if (Number.isFinite(p.coords.heading as number)) {
          gpsLines.push({ k: 'cap', v: `${(p.coords.heading as number).toFixed(0)}°` });
        }
        if (Number.isFinite(p.coords.speed as number)) {
          gpsLines.push({ k: 'v', v: `${(p.coords.speed as number).toFixed(1)} m/s` });
        }
        this.setCard('gps', 'live', gpsLines);
        this.ingestGpsFix(p);
        this.publish();
      },
      () => this.setCard('gps', 'denied', []),
      { enableHighAccuracy: true, maximumAge: 1500, timeout: 20000 }
    );
  }

  private onAbsQuat(q: number[] | undefined): void {
    if (!q || q.length < 4) {
      return;
    }
    this.quatTxt = q.map((n) => n.toFixed(3)).join('  ');
    this.setCard('abs', 'live', [
      { k: 'x', v: this.n(q[0]) },
      { k: 'y', v: this.n(q[1]) },
      { k: 'z', v: this.n(q[2]) },
      { k: 'w', v: this.n(q[3]) }
    ]);
    this.hasRotationVector = true;
    this.lastQuat = [q[0], q[1], q[2], q[3]];
    this.pushPatBurst();
    const att = cameraFromEarthToDeviceQuat({ x: q[0], y: q[1], z: q[2], w: q[3] }, this.attitudeOpt());
    if (att) {
      this.applyAtt(att, 'rotation-vector');
    }
  }

  private onMag(raw: Vec3): void {
    if (this.calibrating) {
      this.calPct = this.hardIron.ingest(raw);
      if (this.hardIron.finish()) {
        this.calibrating = false;
        this.saveCal();
      }
    }
    const corrected = this.hardIron.ready ? this.hardIron.correct(raw) : raw;
    if (this.hasMag) {
      this.mag = {
        x: this.mag.x * 0.72 + corrected.x * 0.28,
        y: this.mag.y * 0.72 + corrected.y * 0.28,
        z: this.mag.z * 0.72 + corrected.z * 0.28
      };
    } else {
      this.mag = corrected;
    }
    this.hasMag = true;
    this.magKnown = true;
    this.magUt = hypot3(this.mag);
    this.pushPatBurst();
    this.fuse();
  }

  private handleOrient(e: DeviceOrientationEvent): void {
    const anyE = e as DeviceOrientationEvent & { webkitCompassHeading?: number };
    const rows = [
      { k: 'α', v: this.n(e.alpha, 1) },
      { k: 'β', v: this.n(e.beta, 1) },
      { k: 'γ', v: this.n(e.gamma, 1) },
      { k: 'abs', v: e.absolute ? 'oui' : 'non' }
    ];
    if (typeof anyE.webkitCompassHeading === 'number') {
      rows.push({ k: 'webkit', v: `${anyE.webkitCompassHeading.toFixed(1)}°` });
    }
    this.setCard('do', 'live', rows);
    this.lastOrient = {
      alpha: e.alpha,
      beta: e.beta,
      gamma: e.gamma,
      absolute: !!e.absolute,
      webkit: typeof anyE.webkitCompassHeading === 'number' ? anyE.webkitCompassHeading : null
    };
    this.pushPatBurst();
    if (this.hasRotationVector || this.hasMag) {
      this.schedule();
      return;
    }
    const beta = e.beta ?? 0;
    const gamma = e.gamma ?? 0;
    const wk =
      typeof anyE.webkitCompassHeading === 'number' && Number.isFinite(anyE.webkitCompassHeading)
        ? anyE.webkitCompassHeading
        : null;
    // webkitCompassHeading = cap du *haut d'écran*, pas de la caméra.
    // On s'en sert seulement comme α abs. (360 − heading), puis la matrice donne la visée −Z.
    const alpha =
      wk != null
        ? normalizeDeg(360 - wk)
        : e.alpha != null && Number.isFinite(e.alpha)
          ? e.alpha
          : null;
    if (alpha == null) {
      return;
    }
    if (wk == null && !(e.absolute || this.orientName === 'deviceorientationabsolute')) {
      return;
    }
    const att = cameraFromDeviceOrientation(alpha, beta, gamma, this.attitudeOpt());
    if (att) {
      this.applyAtt(att, 'deviceorientation');
    }
  }

  private handleMotion(e: DeviceMotionEvent): void {
    const a = e.accelerationIncludingGravity;
    const r = e.rotationRate;
    const lines: { k: string; v: string }[] = [];
    if (a && a.x != null && a.y != null && a.z != null) {
      lines.push({ k: 'ax', v: this.n(a.x) }, { k: 'ay', v: this.n(a.y) }, { k: 'az', v: this.n(a.z) });
      if (!this.accelFromGeneric && !this.hasGravity) {
        this.setAccel(this.motionAccelToUp(a.x, a.y, a.z));
      }
    }
    if (r && r.alpha != null && r.beta != null && r.gamma != null) {
      const k = Math.PI / 180;
      if (!this.gyroFromGeneric) {
        this.gyro = { x: r.beta * k, y: r.gamma * k, z: r.alpha * k };
        this.hasGyro = true;
        this.pushPatBurst();
        this.fuse();
      }
      lines.push(
        { k: 'ωα', v: this.n(r.alpha, 1) },
        { k: 'ωβ', v: this.n(r.beta, 1) },
        { k: 'ωγ', v: this.n(r.gamma, 1) }
      );
    }
    if (lines.length) {
      this.setCard('dm', 'live', lines);
    }
  }

  private setAccel(v: Vec3): void {
    const a = this.hasAccel ? 0.16 : 1;
    this.accel = {
      x: this.accel.x * (1 - a) + v.x * a,
      y: this.accel.y * (1 - a) + v.y * a,
      z: this.accel.z * (1 - a) + v.z * a
    };
    this.hasAccel = true;
    this.pushPatBurst();
    this.fuse();
  }

  private fuse(): void {
    if (this.hasRotationVector) {
      return;
    }
    if (!this.hasMag || !this.hasAccel) {
      return;
    }
    const magAtt = cameraFromMagAccel(this.mag, this.accel, this.attitudeOpt());
    if (!magAtt) {
      return;
    }
    if (this.hasGyro) {
      this.applyAtt(this.fusion.tick(this.gyro, this.accel, magAtt), 'gyro-lock');
      return;
    }
    this.applyAtt(magAtt, 'mag-accel');
  }

  private applyAtt(att: CameraAttitude, src: HeadingSource): void {
    if (this.source === 'gyro-lock' && src === 'mag-accel') {
      src = 'gyro-lock';
    }
    const incoming = SOURCE_RANK[src];
    const current = this.source != null ? SOURCE_RANK[this.source] : -1;
    if (incoming < current) {
      this.schedule();
      return;
    }
    this.source = src;
    this.lookEast = att.lookEast;
    this.lookNorth = att.lookNorth;
    this.lookUp = att.lookUp;
    const cal = this.patFile?.derived;
    const g = this.hasAccel ? cameraElevationFromGravity(this.accel) : null;
    const fromQuat = att.elevationDeg * (cal?.elSign ?? 1);
    const raw = cal?.elSource === 'attitude' ? fromQuat : (g ?? fromQuat);
    this.elevationDeg = composeLookElevation(raw, cal ?? null);
    this.rollDeg = att.rollDeg;
    this.magAzimuthDeg = att.azimuthDeg;
    this.publish();
  }

  private publish(): void {
    let az = this.magAzimuthDeg;
    if (az == null) {
      this.schedule();
      return;
    }
    this.azimuthDeg = composeLookAzimuth(az, this.patFile?.derived ?? null);
    this.schedule();
  }

  private rebuildParams(): void {
    const fieldWarn = this.magUt != null && (this.magUt < 22 || this.magUt > 72);
    const azShow = this.azInited ? normalizeDeg(this.displayedAz) : this.azimuthDeg;
    const elShow = this.elInited ? this.displayedEl : this.elevationDeg;
    const rlShow = this.rlInited ? this.displayedRl : this.rollDeg;
    const rows: ParamRow[] = [];
    if (azShow != null) {
      rows.push(
        { id: 'az', labelKey: 'DIRECTION.AZIMUTH', value: `${azShow.toFixed(1)}°` },
        { id: 'el', labelKey: 'DIRECTION.ELEVATION', value: `${(elShow ?? 0).toFixed(1)}°` },
        { id: 'rl', labelKey: 'DIRECTION.ROLL', value: `${(rlShow ?? 0).toFixed(1)}°` },
        { id: 'card', labelKey: 'DIRECTION.CARDINAL', value: this.cardinal() },
        {
          id: 'kind',
          labelKey: 'DIRECTION.NORTH_KIND',
          value: this.trueNorthActive ? 'DIRECTION.TRUE' : 'DIRECTION.MAGNETIC'
        }
      );
    }
    if (this.gpsKnown && this.declinationDeg != null) {
      rows.push({
        id: 'dec',
        labelKey: 'DIRECTION.DECLINATION',
        value: `${this.declinationDeg.toFixed(1)}°`
      });
    }
    if (this.magKnown && this.magUt != null) {
      rows.push({
        id: 'b',
        labelKey: 'DIRECTION.FIELD',
        value: `${this.magUt.toFixed(1)} µT`,
        warn: fieldWarn
      });
    }
    if (this.source) {
      rows.push({ id: 'src', labelKey: 'DIRECTION.SOURCE', value: this.sourceKey() });
    }
    rows.push({ id: 'off', labelKey: 'DIRECTION.OFFSET', value: `${this.offsetDeg.toFixed(0)}°` });
    const pat = this.patFile?.derived;
    const n = this.patSeriesCount();
    const mix =
      n > 1
        ? ` · ${this.translate.instant(
            this.patMixMode === 'average' ? 'DIRECTION.PAT_MIX_AVG' : 'DIRECTION.PAT_MIX_LATEST',
            { n }
          )}`
        : '';
    rows.push({
      id: 'pat',
      labelKey: 'DIRECTION.PAT_TITLE',
      value: pat ? `${pat.family} · ${pat.azOffsetDeg}° · ${pat.meanErrDeg}°${mix}` : '—'
    });
    if (this.lookEast != null) {
      rows.push({
        id: 'look',
        labelKey: 'DIRECTION.LOOK_ENU',
        value: `${this.lookEast.toFixed(2)} / ${this.lookNorth!.toFixed(2)} / ${this.lookUp!.toFixed(2)}`
      });
    }
    if (this.sensorLive('abs') && this.quatTxt !== '—') {
      rows.push({ id: 'q', labelKey: 'DIRECTION.QUAT', value: this.quatTxt });
    }
    if (this.gpsKnown && this.gpsLat != null) {
      rows.push({
        id: 'gps',
        labelKey: 'DIRECTION.GPS',
        value: `${this.gpsLat.toFixed(5)}, ${this.gpsLon!.toFixed(5)} ±${this.gpsAccM?.toFixed(0)} m`
      });
    }
    this.params = this.mergeParams(rows);
    this.rebuildDash();
  }

  private mergeParams(next: ParamRow[]): ParamRow[] {
    const prev = new Map(this.params.map((p) => [p.id, p]));
    return next.map((row) => {
      const old = prev.get(row.id);
      if (!old) {
        return row;
      }
      old.value = row.value;
      old.warn = row.warn;
      return old;
    });
  }

  private schedule(): void {
    const now = performance.now();
    if (now - this.lastPaint < PAINT_MS) {
      return;
    }
    this.lastPaint = now;
    if (this.azimuthDeg != null) {
      this.displayedAz = this.azFilter.update(this.azimuthDeg);
      this.azInited = true;
    }
    if (this.elevationDeg != null) {
      if (!this.elInited) {
        this.displayedEl = this.elevationDeg;
        this.elInited = true;
      } else {
        this.displayedEl += (this.elevationDeg - this.displayedEl) * 0.15;
      }
    }
    if (this.rollDeg != null) {
      this.displayedRl = wrapSignedDeg(this.rlFilter.update(this.rollDeg));
      this.rlInited = true;
    }
    this.rebuildParams();
    this.cdr.markForCheck();
  }

  private setCard(id: string, status: SensorStatus, lines: { k: string; v: string }[]): void {
    const c = this.cards.find((x) => x.id === id);
    if (!c) {
      return;
    }
    if (c.status === 'live' && status !== 'live') {
      if (lines.length) {
        c.lines = lines;
      }
      return;
    }
    const statusChanged = c.status !== status;
    c.status = status;
    c.lines = lines;
    if (statusChanged) {
      this.syncCardLists();
    }
  }

  private syncCardLists(): void {
    this.liveCardList = this.cards.filter((c) => c.status === 'live');
    this.unavailableCardList = this.cards.filter((c) => c.status === 'missing' || c.status === 'denied');
    this.rebuildDash();
  }

  private rebuildDash(): void {
    this.dashSections = PARAM_GROUPS.map((g) => ({
      id: g.id,
      labelKey: g.labelKey,
      rows: this.params.filter((p) => g.keys.includes(p.id))
    })).filter((s) => s.rows.length);
  }

  private xyz(v: Vec3, unit: string): { k: string; v: string }[] {
    return [
      { k: 'x', v: `${v.x.toFixed(2)} ${unit}` },
      { k: 'y', v: `${v.y.toFixed(2)} ${unit}` },
      { k: 'z', v: `${v.z.toFixed(2)} ${unit}` }
    ];
  }

  private n(v: number | null | undefined, d = 2): string {
    return v == null || !Number.isFinite(v) ? '—' : v.toFixed(d);
  }

  private setOffset(deg: number): void {
    this.patFile = patchLookOffsets({ azOffsetDeg: deg });
    this.offsetDeg = this.patFile.derived.azOffsetDeg;
    this.syncSharedNordCal();
    this.publish();
  }

  /**
   * Aligne la visée caméra sur un azimut géographique (0 = Nord, soleil, cap GPS).
   * Un seul offset : on remplace, on n’empile pas sur les 7 poses.
   */
  private calibrateToTrueAzimuth(targetTrueDeg: number): void {
    if (this.magAzimuthDeg == null) {
      return;
    }
    this.setOffset(circularDiff(targetTrueDeg, this.magAzimuthDeg));
  }

  /** iOS DeviceMotion : accélération y compris gravité = vecteur gravité (vers le bas). W3C / Android = vers le haut. */
  private motionAccelToUp(x: number, y: number, z: number): Vec3 {
    return this.iosMotion ? { x: -x, y: -y, z: -z } : { x, y, z };
  }

  private ingestGpsFix(p: GeolocationPosition): void {
    const coords = p.coords;
    const tMs = Number.isFinite(p.timestamp) ? p.timestamp : Date.now();
    let course = Number.isFinite(coords.heading as number) ? (coords.heading as number) : null;
    const speed = Number.isFinite(coords.speed as number) ? (coords.speed as number) : null;
    this.walkSpeedMps = speed;
    const lat = coords.latitude;
    const lon = coords.longitude;
    const prev = this.gpsPrev;
    if (prev != null && Number.isFinite(lat) && Number.isFinite(lon)) {
      const dtSec = (tMs - prev.tMs) / 1000;
      const distM = haversineM(prev.lat, prev.lon, lat, lon);
      if (dtSec > 0.4 && dtSec < 8 && distM > 2.5) {
        const derived = distM / dtSec;
        if (this.walkSpeedMps == null || this.walkSpeedMps < derived) {
          this.walkSpeedMps = derived;
        }
        if (course == null) {
          course = initialBearingDeg(prev.lat, prev.lon, lat, lon);
        }
      }
    }
    this.gpsHeading = course;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      this.gpsPrev = { lat, lon, tMs };
    }
    if (this.calMethod !== 'gps' || this.magAzimuthDeg == null) {
      return;
    }
    if (course == null || this.walkSpeedMps == null || this.walkSpeedMps < this.calMinSpeedMps) {
      return;
    }
    this.calAccum.push(circularDiff(course, this.magAzimuthDeg));
    this.calSamples = this.calAccum.length;
    if (this.calSamples >= this.calNeededSamples) {
      this.setOffset(circularMeanDeg(this.calAccum));
      this.calMethod = null;
      this.calAccum = [];
      this.calSamples = 0;
    }
  }

  private loadFsParams(): void {
    try {
      const raw = localStorage.getItem(FS_PARAMS_KEY);
      if (raw === '0') {
        this.fsShowParams = false;
      } else if (raw === '1') {
        this.fsShowParams = true;
      }
    } catch {
      /* ignore */
    }
  }

  private loadCal(): void {
    try {
      const raw = localStorage.getItem(CAL_KEY);
      if (!raw) {
        return;
      }
      const data = JSON.parse(raw) as { bias: Vec3; scale: Vec3 };
      if (data.bias && data.scale) {
        this.hardIron.bias = data.bias;
        this.hardIron.scale = data.scale;
        this.hardIron.ready = true;
      }
    } catch {
      /* ignore */
    }
  }

  private loadPatCal(): void {
    this.patFile = canonicalizeLookCal();
    this.patMixMode = loadPattoolCalMixMode(this.patFile?.mixMode);
    this.offsetDeg = this.patFile?.derived.azOffsetDeg ?? 0;
  }

  private refreshPatDbCount(): void {
    this.patDbLoading = true;
    this.api.getDirectionPattoolSamples().subscribe({
      next: (res) => {
        this.patDbLoading = false;
        this.patDbCount = res.count ?? res.samples?.length ?? 0;
        this.patDbUser = res.ownerUsername ?? '';
        const snaps = (res.samples ?? []).map((s) => snapshotFromPayload(s));
        if (snaps.length >= 4 && !sameCalSampleSet(this.patFile?.samples, snaps)) {
          this.commitPatCal(snaps);
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.patDbLoading = false;
        this.cdr.markForCheck();
      }
    });
  }

  private static newSessionId(): string {
    const c = globalThis.crypto as Crypto | undefined;
    if (c && typeof c.randomUUID === 'function') {
      return c.randomUUID();
    }
    return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private attitudeOpt(): AttitudeOptions {
    const d = this.patFile?.derived;
    if (!d) {
      return {};
    }
    return { conjugateQuat: d.conjugateQuat, cameraMinusZ: d.cameraMinusZ };
  }

  private screenAngle(): number {
    const angle = screen.orientation?.angle;
    if (typeof angle === 'number' && Number.isFinite(angle)) {
      return angle;
    }
    const legacy = (window as Window & { orientation?: number }).orientation;
    return typeof legacy === 'number' ? legacy : 0;
  }

  private pushPatBurst(): void {
    const burst = this.patBurst;
    if (!burst) {
      return;
    }
    if (this.lastQuat) {
      burst.quats.push(this.lastQuat.slice());
    }
    if (this.hasMag) {
      burst.mags.push({ ...this.mag });
    }
    if (this.hasAccel) {
      burst.accels.push({ ...this.accel });
    }
    if (this.hasGyro) {
      burst.gyros.push({ ...this.gyro });
    }
    if (this.lastOrient) {
      burst.orients.push({ ...this.lastOrient });
    }
  }

  private clearPatHold(): void {
    if (this.patHoldTimer != null) {
      clearTimeout(this.patHoldTimer);
      this.patHoldTimer = null;
    }
    this.patBurst = null;
    this.patCapturing = false;
  }

  private finishPatCapture(): void {
    const pose = this.patPose();
    const burst = this.patBurst;
    this.patHoldTimer = null;
    this.patBurst = null;
    this.patCapturing = false;
    if (!burst) {
      this.cdr.markForCheck();
      return;
    }
    const accel = averageVec(burst.accels);
    const gEl = accel ? cameraElevationFromGravity(accel) : null;
    if (gEl != null && Math.abs(gEl - pose.expectedEl) > 35) {
      this.patError =
        pose.expectedEl < -45
          ? 'DIRECTION.PAT_POSE_NOT_GROUND'
          : pose.expectedEl > 60
            ? 'DIRECTION.PAT_POSE_NOT_SKY'
            : 'DIRECTION.PAT_POSE_MISMATCH';
      this.cdr.markForCheck();
      return;
    }
    const lastOri = burst.orients.length ? burst.orients[burst.orients.length - 1] : this.lastOrient;
    const sessionId = this.patSessionId ?? DirectionComponent.newSessionId();
    this.patSessionId = sessionId;
    const snap: PattoolCalSnapshot = {
      sessionId,
      poseId: pose.id,
      poseIndex: this.patStep,
      expectedAz: pose.expectedAz,
      expectedEl: pose.expectedEl,
      at: new Date().toISOString(),
      quat: averageQuat(burst.quats),
      mag: averageVec(burst.mags),
      accel,
      gyro: averageVec(burst.gyros),
      orient: lastOri,
      screenAngle: this.screenAngle(),
      gps: { lat: this.gpsLat, lon: this.gpsLon, heading: this.gpsHeading },
      computed: {
        az: this.azimuthDeg,
        el: this.elevationDeg,
        rl: this.rollDeg,
        source: this.source,
        lookEast: this.lookEast,
        lookNorth: this.lookNorth,
        lookUp: this.lookUp
      },
      extras: {
        trueNorth: this.trueNorth,
        declinationDeg: this.declinationDeg,
        magUt: this.magUt,
        hasRotationVector: this.hasRotationVector,
        hasMag: this.hasMag,
        hasAccel: this.hasAccel,
        hasGyro: this.hasGyro,
        burst: {
          quat: burst.quats.length,
          mag: burst.mags.length,
          accel: burst.accels.length,
          gyro: burst.gyros.length,
          orient: burst.orients.length
        }
      }
    };
    this.patSamples = this.patSamples.filter((s) => s.poseId !== pose.id);
    this.patSamples.push(snap);
    this.patSaving = true;
    this.cdr.markForCheck();
    this.api.saveDirectionPattoolSample({
      sessionId,
      poseId: snap.poseId,
      poseIndex: snap.poseIndex ?? this.patStep,
      expectedAz: snap.expectedAz ?? null,
      expectedEl: snap.expectedEl ?? pose.expectedEl,
      capturedAt: snap.at,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      quat: snap.quat,
      mag: snap.mag,
      accel: snap.accel,
      gyro: snap.gyro,
      orient: snap.orient,
      screenAngle: snap.screenAngle,
      gps: snap.gps,
      computed: snap.computed,
      extras: snap.extras
    }).subscribe({
      next: (res) => {
        this.patSaving = false;
        this.patDbCount = res.count;
        if (res.ownerUsername) {
          this.patDbUser = res.ownerUsername;
        }
        this.afterPatSampleSaved();
      },
      error: () => {
        this.patSaving = false;
        this.patError = 'DIRECTION.PAT_SYNC_FAIL';
        this.cdr.markForCheck();
      }
    });
  }

  private afterPatSampleSaved(): void {
    if (this.patStep + 1 < PATTOOL_POSES.length) {
      this.patStep += 1;
      this.cdr.markForCheck();
      return;
    }
    this.patWizard = false;
    this.patSeriesDone = true;
    this.commitPatCal(mergeCalSamples(this.patFile?.samples ?? [], this.patSamples));
    this.refreshPatDbCount();
    this.cdr.markForCheck();
  }

  private commitPatCal(samples: PattoolCalSnapshot[]): void {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const file = persistPattoolCalFromSamples(samples, ua, this.patMixMode);
    if (!file) {
      return;
    }
    this.patFile = file;
    savePattoolCalMixMode(this.patMixMode);
    this.offsetDeg = file.derived.azOffsetDeg;
    this.publish();
  }

  private saveCal(): void {
    try {
      localStorage.setItem(
        CAL_KEY,
        JSON.stringify({ bias: this.hardIron.bias, scale: this.hardIron.scale })
      );
    } catch {
      /* ignore */
    }
    this.syncSharedNordCal();
  }

  private syncSharedNordCal(): void {
    let prev: Partial<PersistedNordCal> = {};
    try {
      const raw = localStorage.getItem(NORD_CAL_STORAGE_KEY);
      if (raw) {
        prev = JSON.parse(raw) as PersistedNordCal;
      }
    } catch {
      /* ignore */
    }
    const payload: PersistedNordCal = {
      bias: this.hardIron.ready ? this.hardIron.bias : prev.bias ?? { x: 0, y: 0, z: 0 },
      scale: this.hardIron.ready ? this.hardIron.scale : prev.scale ?? { x: 1, y: 1, z: 1 },
      northOffsetDeg: this.offsetDeg,
      trueNorth: this.trueNorth,
      calibratedAt: this.hardIron.ready
        ? prev.calibratedAt || new Date().toISOString()
        : prev.calibratedAt ?? ''
    };
    try {
      localStorage.setItem(NORD_CAL_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* ignore */
    }
    if (this.hardIron.ready) {
      writeSharedNordCal(payload);
    }
  }

  private clearSharedNordHardIron(): void {
    let prev: Partial<PersistedNordCal> = {};
    try {
      const raw = localStorage.getItem(NORD_CAL_STORAGE_KEY);
      if (raw) {
        prev = JSON.parse(raw) as PersistedNordCal;
      }
    } catch {
      /* ignore */
    }
    try {
      localStorage.setItem(
        NORD_CAL_STORAGE_KEY,
        JSON.stringify({
          bias: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
          northOffsetDeg: this.offsetDeg,
          trueNorth: prev.trueNorth !== false,
          calibratedAt: ''
        } satisfies PersistedNordCal)
      );
    } catch {
      /* ignore */
    }
  }

  private fullscreenElement(): Element | null {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  }

  private async leaveFullscreen(): Promise<void> {
    if (!this.fullscreenElement()) {
      this.isFullscreen = false;
      return;
    }
    try {
      const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (doc.webkitExitFullscreen) {
        await Promise.resolve(doc.webkitExitFullscreen());
      }
    } catch {
      /* ignore */
    }
    this.isFullscreen = false;
  }

  private stopEverything(): void {
    this.leaveFullscreen();
    this.stopCamera();
    for (const s of this.generics) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    this.generics = [];
    if (this.orientName) {
      window.removeEventListener(this.orientName, this.onOrient, true);
    }
    window.removeEventListener('devicemotion', this.onMotion, true);
    if (this.geoId != null) {
      navigator.geolocation.clearWatch(this.geoId);
    }
  }

  private static emptyCards(): SensorCard[] {
    return [
      { id: 'abs', labelKey: 'DIRECTION.S_ABS', status: 'off', lines: [] },
      { id: 'mag', labelKey: 'DIRECTION.S_MAG', status: 'off', lines: [] },
      { id: 'acc', labelKey: 'DIRECTION.S_ACC', status: 'off', lines: [] },
      { id: 'gyro', labelKey: 'DIRECTION.S_GYRO', status: 'off', lines: [] },
      { id: 'rel', labelKey: 'DIRECTION.S_REL', status: 'off', lines: [] },
      { id: 'do', labelKey: 'DIRECTION.S_DO', status: 'off', lines: [] },
      { id: 'dm', labelKey: 'DIRECTION.S_DM', status: 'off', lines: [] },
      { id: 'gps', labelKey: 'DIRECTION.S_GPS', status: 'off', lines: [] }
    ];
  }
}
