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
import { ActivatedRoute, RouterModule } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { ApiService, DirectionCible } from '../services/api.service';
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
  CompassNorthEngine,
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
  applyLookDeclination,
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
import { applyMultiplicativeWheelScale, normalizeWheelDeltaPixels } from '../shared/wheel-zoom.util';
import * as L from 'leaflet';
import { CompassRoseComponent } from '../shared/compass-rose/compass-rose.component';
import { LeafletBasemapService } from '../shared/leaflet-basemap.service';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import {
  CIBLE_MARK_MIN_DIST_M,
  cibleImpliedGeoHeadingDeg,
  cibleLockDeltaDeg,
  cibleMarkBearingDeg,
  cibleMarkDistanceM,
  geocodeDisplayName,
  hasCibleMark,
  loadActiveCibleId,
  saveActiveCibleId
} from './direction-cible-store';

type SensorStatus = 'off' | 'live' | 'missing' | 'denied';
type HeadingSource = 'rotation-vector' | 'mag-accel' | 'deviceorientation' | 'gyro-lock';
type NorthCalMethod = 'figure8' | 'manual' | 'gps' | 'sun';
type DirPageTab = 'calibrage' | 'cible';

const SOURCE_RANK: Record<HeadingSource, number> = {
  'mag-accel': 4,
  'gyro-lock': 3,
  deviceorientation: 2,
  'rotation-vector': 1
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

interface Figure8Report {
  usedRawMag: boolean;
  offsetBefore: number;
  offsetAfter: number;
  headingBefore: number | null;
  headingAfter: number | null;
  fieldBefore: number | null;
  fieldAfter: number | null;
  bias: Vec3;
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
const CAM_ZOOM_KEY = 'pat.direction.cam-zoom';
const CAM_ZOOM_MIN = 1;
const CAM_ZOOM_MAX = 8;
const CAM_ZOOM_STEP = 0.25;
const PAINT_MS = 50;

function viseurPolar(r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [100 + Math.cos(a) * r, 100 + Math.sin(a) * r];
}

function viseurArrowPoints(deg: number): string {
  const a = ((deg - 90) * Math.PI) / 180;
  const p = a + Math.PI / 2;
  const [tx, ty] = viseurPolar(73, deg);
  const [bx, by] = viseurPolar(52, deg);
  const wx = 100 + Math.cos(a) * 62;
  const wy = 100 + Math.sin(a) * 62;
  const hw = 7.2;
  return [
    `${tx.toFixed(1)},${ty.toFixed(1)}`,
    `${(wx + Math.cos(p) * hw).toFixed(1)},${(wy + Math.sin(p) * hw).toFixed(1)}`,
    `${bx.toFixed(1)},${by.toFixed(1)}`,
    `${(wx - Math.cos(p) * hw).toFixed(1)},${(wy - Math.sin(p) * hw).toFixed(1)}`
  ].join(' ');
}

function viseurCard(label: string, deg: number, kind: 'n' | 'card'): {
  label: string;
  kind: 'n' | 'card';
  x: number;
  y: number;
  points: string;
} {
  const [x, y] = viseurPolar(83, deg);
  return { label, kind, x: +x.toFixed(1), y: +y.toFixed(1), points: viseurArrowPoints(deg) };
}

const VISEUR_CARDS = [
  viseurCard('N', 0, 'n'),
  viseurCard('E', 90, 'card'),
  viseurCard('S', 180, 'card'),
  viseurCard('O', 270, 'card')
];

const VISEUR_BEZEL_TICKS = (() => {
  let d = '';
  for (let deg = 0; deg < 360; deg += 15) {
    const major = deg % 90 === 0;
    const mid = deg % 45 === 0;
    const r0 = major ? 89.4 : mid ? 91 : 92.4;
    const [x0, y0] = viseurPolar(r0, deg);
    const [x1, y1] = viseurPolar(94.8, deg);
    d += `M${x0.toFixed(1)} ${y0.toFixed(1)}L${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  return d;
})();

@Component({
  selector: 'app-direction',
  standalone: true,
  imports: [CommonModule, RouterModule, TranslateModule, CompassRoseComponent, TraceViewerModalComponent],
  templateUrl: './direction.component.html',
  styleUrls: ['./direction.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DirectionComponent implements AfterViewInit, OnDestroy {
  @ViewChild('cam') camEl?: ElementRef<HTMLVideoElement>;
  @ViewChild('camStage') camStage?: ElementRef<HTMLElement>;
  @ViewChild('cibleEditMap') cibleEditMapEl?: ElementRef<HTMLDivElement>;
  @ViewChild('cibleEditDialog') cibleEditDialogEl?: ElementRef<HTMLElement>;
  @ViewChild('cibleEditName') cibleEditNameEl?: ElementRef<HTMLInputElement>;
  @ViewChild(TraceViewerModalComponent) traceViewerModal?: TraceViewerModalComponent;

  activeTab: DirPageTab = 'calibrage';
  cibles: DirectionCible[] = [];
  selectedCibleId: string | null = null;
  cibleName = '';
  ciblePhoto: string | null = null;
  cibleStageView: 'camera' | 'photo' = 'camera';
  cibleLoading = false;
  cibleSaving = false;
  cibleError: string | null = null;
  cibleUpdatedOk = false;
  cibleEditOpen = false;
  editName = '';
  editPhoto: string | null = null;
  editUserLat: number | null = null;
  editUserLon: number | null = null;
  editMarkLat: number | null = null;
  editMarkLon: number | null = null;
  editMarkAltM: number | null = null;
  editMarkAddress: string | null = null;
  editUserAddress: string | null = null;
  editMapFocus: 'user' | 'mark' = 'mark';
  editError: string | null = null;
  editMarkAddressBusy = false;
  editUserAddressBusy = false;
  private editMarkAddressSub: Subscription | null = null;
  private editUserAddressSub: Subscription | null = null;
  private editMap?: L.Map;
  private editUserMarker?: L.Marker;
  private editMarkMarker?: L.Marker;
  private editLine?: L.Polyline;
  private editLineHalo?: L.Polyline;
  private editLineLabel?: L.Marker;
  private editMapIgnoreClick = false;
  readonly viseurCards = VISEUR_CARDS;
  readonly viseurBezelTicks = VISEUR_BEZEL_TICKS;
  cibleJsonModal: DirectionCible | null = null;
  cibleJsonCopied = false;
  private cibleJsonCopyTimer: ReturnType<typeof setTimeout> | null = null;
  markLat: number | null = null;
  markLon: number | null = null;
  markAltM: number | null = null;
  markAddress: string | null = null;
  markAddressBusy = false;
  private markAddressSub: Subscription | null = null;
  userAddress: string | null = null;
  userAddressBusy = false;
  private userAddressSub: Subscription | null = null;
  private lastUserAddressLat: number | null = null;
  private lastUserAddressLon: number | null = null;
  cibleCheck: {
    status: 'ok' | 'warn' | 'need';
    movedM: number | null;
    headingAbs: number | null;
    gpsChanged: boolean;
    headingChanged: boolean;
    markTooClose: boolean;
    markDistM: number | null;
  } | null = null;
  sensorsOn = false;
  needTap = false;
  denied = false;
  camDenied = false;
  camLive = false;
  isFullscreen = false;
  camHeightPx: number | null = null;
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
  figure8ModalOpen = false;
  figure8Report: Figure8Report | null = null;
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
  private readonly northEngine = new CompassNorthEngine();
  private hardIron = new HardIronCal();
  private figure8Snap: {
    offset: number;
    heading: number | null;
    field: number | null;
  } | null = null;
  private figure8HardIronFresh = false;
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
  private lastQuatAtt: CameraAttitude | null = null;
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

  private tabQuerySub: Subscription | null = null;

  constructor(
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef,
    private readonly api: ApiService,
    private readonly translate: TranslateService,
    private readonly hostEl: ElementRef<HTMLElement>,
    private readonly route: ActivatedRoute,
    private readonly basemaps: LeafletBasemapService
  ) {}

  ngAfterViewInit(): void {
    this.tabQuerySub = this.route.queryParamMap.subscribe((params) => {
      this.applyTabFromQuery(params.get('tab'));
    });
    this.loadCal();
    this.loadPatCal();
    this.loadCibles();
    this.refreshPatDbCount();
    setTimeout(() => this.refreshPatDbCount(), 800);
    setTimeout(() => this.refreshPatDbCount(), 2500);
    this.loadFsParams();
    this.camHeightPx = loadCamHeightPx(CAM_HEIGHT_KEY);
    this.loadCamZoomPref();
    void this.boot(false);
    this.bindCamZoomGestures();
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
    this.tabQuerySub?.unsubscribe();
    this.tabQuerySub = null;
    this.markAddressSub?.unsubscribe();
    this.markAddressSub = null;
    this.userAddressSub?.unsubscribe();
    this.userAddressSub = null;
    this.editMarkAddressSub?.unsubscribe();
    this.editMarkAddressSub = null;
    this.editUserAddressSub?.unsubscribe();
    this.editUserAddressSub = null;
    this.destroyCibleEditMap();
    if (this.cibleJsonCopyTimer != null) {
      clearTimeout(this.cibleJsonCopyTimer);
      this.cibleJsonCopyTimer = null;
    }
    if (this.hideTitleTimer != null) {
      clearTimeout(this.hideTitleTimer);
      this.hideTitleTimer = null;
    }
    this.unbindTitleHideGuard();
    this.clearPatHold();
    this.endCamResize();
    this.unbindCamZoomGestures();
    this.leaveFullscreen();
    this.stopEverything();
    this.northEngine.destroy();
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
    if (this.cibleEditOpen) {
      this.closeCibleEdit();
      return;
    }
    if (this.cibleJsonModal) {
      this.closeCibleJson();
      return;
    }
    if (this.figure8ModalOpen) {
      this.closeFigure8Modal();
      return;
    }
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
        this.refreshCameraZoomCaps();
        this.syncCamZoomOutputs();
        this.bindCamZoomGestures();
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
    this.camZoomCaps = null;
    const video = this.camEl?.nativeElement;
    if (video) {
      video.srcObject = null;
    }
    this.cdr.markForCheck();
  }

  showCamZoom(): boolean {
    if (this.patWizard) {
      return false;
    }
    return this.showCiblePhotoOnStage() || this.camLive;
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

  private onCamWheel(ev: WheelEvent): void {
    if (!this.showCamZoom() || this.isCamZoomIgnoreTarget(ev.target)) {
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
    if (!this.showCamZoom() || ev.touches.length !== 2) {
      this.camPinchStartDist = 0;
      return;
    }
    this.camPinchStartDist = this.touchDistance(ev.touches[0], ev.touches[1]);
    this.camPinchStartZoom = this.camZoom;
  }

  private onCamTouchMove(ev: TouchEvent): void {
    if (!this.showCamZoom() || ev.touches.length !== 2 || this.camPinchStartDist < 8) {
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
    return !!el?.closest(
      'button, input, label, a, select, textarea, .dir-cam__zoom, .dir-cam-resize, .dir-cam__view-switch'
    );
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

  chooseCal(method: NorthCalMethod): void {
    if (method === 'figure8') {
      this.startCal();
      return;
    }
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
    this.figure8Snap = {
      offset: this.offsetDeg,
      heading: this.headingBeforeOffset(),
      field: this.magUt
    };
    this.figure8HardIronFresh = false;
    if (this.hasMag) {
      this.hardIron.reset();
      this.figure8HardIronFresh = true;
    }
    this.northEngine.startFigure8();
    this.northEngine.hasMag = this.hasMag;
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
    this.northEngine.cancelCal();
    this.cdr.markForCheck();
  }

  closeFigure8Modal(): void {
    this.figure8ModalOpen = false;
    this.cdr.markForCheck();
  }

  fig8Delta(before: number | null, after: number | null): string {
    if (before == null || after == null) {
      return '—';
    }
    const d = circularDiff(after, before);
    const abs = Math.abs(d).toFixed(1);
    if (Math.abs(d) < 0.05) {
      return '0°';
    }
    return d > 0 ? `+${abs}°` : `−${abs}°`;
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

  /** Traits du viseur : blancs la nuit, noirs en plein jour. */
  viseurIsNight(): boolean {
    const el = this.sunElevationDeg();
    if (el != null) {
      return el < -1;
    }
    const hour = new Date().getHours();
    return hour < 6 || hour >= 20;
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

  private applyTabFromQuery(raw: string | null): void {
    if (raw === 'cible') {
      this.setTab('cible');
      return;
    }
    if (raw === 'calibrage' || raw === 'nord') {
      this.setTab('calibrage');
    }
  }

  setTab(tab: DirPageTab): void {
    if (this.patWizard || this.activeTab === tab) {
      return;
    }
    this.activeTab = tab;
    if (tab === 'cible' && !this.camLive && !this.camDenied) {
      void this.startCamera();
    }
    this.cdr.markForCheck();
  }

  selectedCible(): DirectionCible | null {
    return this.cibles.find((c) => c.id === this.selectedCibleId) ?? null;
  }

  cibleLockDelta(): number | null {
    const c = this.selectedCible();
    return cibleLockDeltaDeg(
      this.magAzimuthDeg,
      c?.phoneHeadingDeg,
      c?.refAzimuthDeg,
      this.markBearingDeg()
    );
  }

  cibleLockDeltaText(): string {
    const d = this.cibleLockDelta();
    if (d == null) {
      return '—';
    }
    const abs = Math.abs(d).toFixed(0);
    if (Math.abs(d) < 0.5) {
      return '0°';
    }
    return d > 0 ? `+${abs}°` : `−${abs}°`;
  }

  cibleOnLock(): boolean {
    const d = this.cibleLockDelta();
    return d != null && Math.abs(d) < 3;
  }

  cibleMovedM(): number | null {
    const c = this.selectedCible();
    if (c?.userLat == null || c.userLon == null || this.gpsLat == null || this.gpsLon == null) {
      return null;
    }
    return haversineM(c.userLat, c.userLon, this.gpsLat, this.gpsLon);
  }

  checkCibleDrift(): void {
    const c = this.selectedCible();
    if (!c) {
      this.cibleCheck = {
        status: 'need',
        movedM: null,
        headingAbs: null,
        gpsChanged: false,
        headingChanged: false,
        markTooClose: false,
        markDistM: null
      };
      this.cdr.markForCheck();
      return;
    }
    const heading = this.cibleLockDelta();
    if (heading == null) {
      this.cibleCheck = {
        status: 'need',
        movedM: this.cibleMovedM(),
        headingAbs: null,
        gpsChanged: false,
        headingChanged: false,
        markTooClose: this.markTooClose(),
        markDistM: this.markDistanceM()
      };
      this.cdr.markForCheck();
      return;
    }
    const movedM = this.cibleMovedM();
    const acc = Math.max(this.gpsAccM ?? 0, c.userAccM ?? 0);
    const gpsLimit = Math.max(20, acc * 2);
    const markDistM = this.markDistanceM();
    const markTooClose = this.markTooClose();
    const expectedAz = this.markBearingDeg();
    const implied =
      c.phoneHeadingDeg != null &&
      c.refAzimuthDeg != null &&
      this.magAzimuthDeg != null &&
      expectedAz != null
        ? cibleImpliedGeoHeadingDeg(this.magAzimuthDeg, c.phoneHeadingDeg, c.refAzimuthDeg)
        : null;
    let headingAbs = Math.abs(heading);
    let headingChanged = headingAbs > 8;
    let gpsChanged = movedM != null && movedM > gpsLimit;
    if (expectedAz != null && implied != null) {
      headingAbs = Math.abs(circularDiff(implied, expectedAz));
      headingChanged = headingAbs > 8;
      gpsChanged = false;
    }
    this.cibleCheck = {
      status: gpsChanged || headingChanged || markTooClose ? 'warn' : 'ok',
      movedM,
      headingAbs,
      gpsChanged,
      headingChanged,
      markTooClose,
      markDistM
    };
    this.cdr.markForCheck();
  }

  onCibleNameInput(ev: Event): void {
    this.cibleName = ((ev.target as HTMLInputElement | null)?.value ?? '').slice(0, 80);
    this.cibleUpdatedOk = false;
    this.cdr.markForCheck();
  }

  cibleDraftDirty(): boolean {
    const saved = this.selectedCible();
    if (!saved) {
      return false;
    }
    if ((this.cibleName.trim() || '') !== (saved.name || '').trim()) {
      return true;
    }
    if ((this.ciblePhoto || '') !== (saved.photoDataUrl || '')) {
      return true;
    }
    const savedHasMark = hasCibleMark(saved.markLat, saved.markLon);
    const liveHasMark = hasCibleMark(this.markLat, this.markLon);
    if (savedHasMark !== liveHasMark) {
      return true;
    }
    if (liveHasMark && (this.markLat !== saved.markLat || this.markLon !== saved.markLon)) {
      return true;
    }
    if ((this.markAddress || '') !== (saved.markAddress || '')) {
      return true;
    }
    return false;
  }

  gpsText(): string {
    if (this.gpsLat == null || this.gpsLon == null) {
      return '—';
    }
    const acc = this.gpsAccM != null ? ` ±${this.gpsAccM.toFixed(0)} m` : '';
    return `${this.gpsLat.toFixed(5)}, ${this.gpsLon.toFixed(5)}${acc}`;
  }

  userAddressText(): string {
    if (this.userAddressBusy) {
      return '…';
    }
    return this.userAddress?.trim() || '—';
  }

  private maybeResolveUserAddress(): void {
    const lat = this.gpsLat;
    const lon = this.gpsLon;
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return;
    }
    if (this.lastUserAddressLat != null && this.lastUserAddressLon != null && this.userAddress) {
      if (haversineM(this.lastUserAddressLat, this.lastUserAddressLon, lat, lon) < 40) {
        return;
      }
    }
    this.lastUserAddressLat = lat;
    this.lastUserAddressLon = lon;
    this.userAddressBusy = true;
    this.userAddressSub?.unsubscribe();
    this.userAddressSub = this.api.geocodeReverse(lat, lon).subscribe({
      next: (res) => {
        this.userAddress = geocodeDisplayName(res);
        this.userAddressBusy = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.userAddressBusy = false;
        this.cdr.markForCheck();
      }
    });
  }

  hasMark(): boolean {
    return hasCibleMark(this.markLat, this.markLon);
  }

  markGpsText(): string {
    if (!hasCibleMark(this.markLat, this.markLon)) {
      return '—';
    }
    const alt =
      this.markAltM != null && Number.isFinite(this.markAltM) ? ` · ${Math.round(this.markAltM)} m` : '';
    return `${this.markLat!.toFixed(5)}, ${this.markLon!.toFixed(5)}${alt}`;
  }

  markAddressText(): string {
    if (this.markAddressBusy) {
      return '…';
    }
    return this.markAddress?.trim() || '—';
  }

  markDistanceM(): number | null {
    return cibleMarkDistanceM(this.gpsLat, this.gpsLon, this.markLat, this.markLon);
  }

  markBearingDeg(): number | null {
    return cibleMarkBearingDeg(this.gpsLat, this.gpsLon, this.markLat, this.markLon);
  }

  markBearingText(): string {
    const az = this.markBearingDeg();
    if (az == null) {
      return '—';
    }
    return `${az.toFixed(0)}°`;
  }

  markDistanceText(): string {
    const m = this.markDistanceM();
    if (m == null) {
      return '—';
    }
    if (m >= 1000) {
      return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
    }
    return `${m.toFixed(0)} m`;
  }

  markTooClose(): boolean {
    const m = this.markDistanceM();
    return m != null && m < CIBLE_MARK_MIN_DIST_M;
  }

  openTraceViewerForMark(): void {
    if (!this.traceViewerModal) {
      return;
    }
    const lat = this.markLat ?? this.gpsLat ?? 46.2;
    const lon = this.markLon ?? this.gpsLon ?? 6.15;
    const label = this.cibleName.trim() || this.translate.instant('DIRECTION.TARGET_MARK');
    this.traceViewerModal.openAtLocation(lat, lon, label, undefined, true, true);
  }

  onMarkLocationSelected(location: { lat: number; lng: number; alt?: number | null }): void {
    if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
      return;
    }
    this.markLat = location.lat;
    this.markLon = location.lng;
    this.markAltM = location.alt != null && Number.isFinite(location.alt) ? location.alt : null;
    this.markAddress = null;
    this.cibleError = null;
    this.cibleCheck = null;
    this.cibleUpdatedOk = false;
    this.resolveMarkAddress(true);
    this.cdr.markForCheck();
  }

  clearCibleMark(): void {
    this.markAddressSub?.unsubscribe();
    this.markAddressSub = null;
    this.markAddressBusy = false;
    this.markLat = null;
    this.markLon = null;
    this.markAltM = null;
    this.markAddress = null;
    const id = this.selectedCibleId;
    if (id) {
      this.api
        .updateDirectionCible(id, {
          name: this.cibleName.trim() || this.selectedCible()?.name || 'cible',
          clearMark: true
        })
        .subscribe({
          next: (saved) => this.replaceCible(saved),
          error: () => this.cdr.markForCheck()
        });
    }
    this.cdr.markForCheck();
  }

  private applyMarkFromCible(cible: DirectionCible): void {
    this.markLat = cible.markLat ?? null;
    this.markLon = cible.markLon ?? null;
    this.markAltM = cible.markAltM ?? null;
    this.markAddress = cible.markAddress?.trim() || null;
    if (hasCibleMark(this.markLat, this.markLon) && !this.markAddress) {
      this.resolveMarkAddress(true);
    }
  }

  private resolveMarkAddress(persist: boolean): void {
    if (!hasCibleMark(this.markLat, this.markLon)) {
      return;
    }
    const lat = this.markLat!;
    const lon = this.markLon!;
    this.markAddressBusy = true;
    this.markAddressSub?.unsubscribe();
    this.markAddressSub = this.api.geocodeReverse(lat, lon).subscribe({
      next: (res) => {
        this.markAddress = geocodeDisplayName(res);
        this.markAddressBusy = false;
        if (persist && this.markAddress) {
          this.persistMarkDraft();
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.markAddressBusy = false;
        this.cdr.markForCheck();
      }
    });
  }

  private persistMarkDraft(): void {
    const id = this.selectedCibleId;
    if (!id || !hasCibleMark(this.markLat, this.markLon)) {
      return;
    }
    this.api
      .updateDirectionCible(id, {
        name: this.cibleName.trim() || this.selectedCible()?.name || 'cible',
        markLat: this.markLat,
        markLon: this.markLon,
        markAltM: this.markAltM,
        markAddress: this.markAddress
      })
      .subscribe({
        next: (saved) => this.replaceCible(saved),
        error: () => this.cdr.markForCheck()
      });
  }

  private resolveCibleRefAzimuth(fallback?: number | null): number {
    return this.markBearingDeg() ?? fallback ?? this.azimuthDeg ?? 0;
  }

  captureCiblePhoto(): void {
    const video = this.camEl?.nativeElement;
    if (!video || !this.camLive || video.videoWidth < 8) {
      this.cibleError = 'DIRECTION.TARGET_PHOTO_NEED_CAM';
      this.cdr.markForCheck();
      return;
    }
    const crop = Math.max(1, this.camDigitalZoom);
    const srcW = video.videoWidth / crop;
    const srcH = video.videoHeight / crop;
    const sx = (video.videoWidth - srcW) / 2;
    const sy = (video.videoHeight - srcH) / 2;
    const maxW = 720;
    const ratio = Math.min(1, maxW / srcW);
    const w = Math.round(srcW * ratio);
    const h = Math.round(srcH * ratio);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.drawImage(video, sx, sy, srcW, srcH, 0, 0, w, h);
    this.ciblePhoto = canvas.toDataURL('image/jpeg', 0.72);
    this.cibleStageView = 'photo';
    this.cibleError = null;
    this.cibleUpdatedOk = false;
    this.cdr.markForCheck();
  }

  setCibleStageView(view: 'camera' | 'photo'): void {
    if (view === 'photo' && !this.ciblePhoto) {
      return;
    }
    this.cibleStageView = view;
    this.cdr.markForCheck();
  }

  showCiblePhotoOnStage(): boolean {
    return this.activeTab === 'cible' && !this.patWizard && this.cibleStageView === 'photo' && !!this.ciblePhoto;
  }

  clearCiblePhoto(): void {
    this.ciblePhoto = null;
    this.cibleStageView = 'camera';
    this.cibleUpdatedOk = false;
    this.cdr.markForCheck();
  }

  startNewCible(): void {
    this.selectedCibleId = null;
    this.cibleName = '';
    this.ciblePhoto = null;
    this.cibleStageView = 'camera';
    this.cibleError = null;
    this.cibleCheck = null;
    this.cibleUpdatedOk = false;
    this.markAddressSub?.unsubscribe();
    this.markAddressSub = null;
    this.markLat = null;
    this.markLon = null;
    this.markAltM = null;
    this.markAddress = null;
    this.markAddressBusy = false;
    this.cdr.markForCheck();
  }

  selectCible(cible: DirectionCible): void {
    if (!cible.id) {
      return;
    }
    this.selectedCibleId = cible.id;
    this.cibleName = cible.name;
    this.ciblePhoto = cible.photoDataUrl ?? null;
    this.applyMarkFromCible(cible);
    if (!this.ciblePhoto) {
      this.cibleStageView = 'camera';
    }
    this.cibleError = null;
    this.cibleCheck = null;
    this.cibleUpdatedOk = false;
    saveActiveCibleId(cible.id);
    this.api.setActiveDirectionCible(cible.id).subscribe({
      next: (saved) => this.replaceCible(saved),
      error: () => this.cdr.markForCheck()
    });
    this.cdr.markForCheck();
  }

  saveCibleEdits(): void {
    const id = this.selectedCibleId;
    const name = this.cibleName.trim();
    if (!id) {
      return;
    }
    if (!name) {
      this.cibleError = 'DIRECTION.TARGET_NAME_REQUIRED';
      this.cdr.markForCheck();
      return;
    }
    this.cibleSaving = true;
    this.cibleError = null;
    this.cibleUpdatedOk = false;
    const hasMark = hasCibleMark(this.markLat, this.markLon);
    this.api
      .updateDirectionCible(id, {
        name,
        photoDataUrl: this.ciblePhoto || '',
        markLat: hasMark ? this.markLat : null,
        markLon: hasMark ? this.markLon : null,
        markAltM: hasMark ? this.markAltM : null,
        markAddress: hasMark ? this.markAddress : null,
        clearMark: !hasMark
      })
      .subscribe({
        next: (saved) => {
          this.cibleSaving = false;
          this.cibleUpdatedOk = true;
          const keptPhoto = this.ciblePhoto;
          this.replaceCible(saved);
          this.ciblePhoto = keptPhoto;
          saveActiveCibleId(saved.id ?? id);
          this.cdr.markForCheck();
        },
        error: () => {
          this.cibleSaving = false;
          this.cibleError = 'DIRECTION.TARGET_SAVE_FAIL';
          this.cdr.markForCheck();
        }
      });
  }

  openCibleEditSelected(): void {
    const cible = this.selectedCible();
    if (cible) {
      this.openCibleEdit(cible);
    }
  }

  openCibleEdit(cible: DirectionCible, ev?: Event): void {
    ev?.preventDefault();
    ev?.stopPropagation();
    if (!cible.id) {
      return;
    }
    if (this.selectedCibleId !== cible.id) {
      this.selectCible(cible);
    }
    this.editName = (cible.name || '').slice(0, 80);
    this.editPhoto = cible.photoDataUrl ?? null;
    this.editUserLat = cible.userLat != null && Number.isFinite(cible.userLat) ? cible.userLat : this.gpsLat;
    this.editUserLon = cible.userLon != null && Number.isFinite(cible.userLon) ? cible.userLon : this.gpsLon;
    this.editMarkLat = cible.markLat != null && Number.isFinite(cible.markLat) ? cible.markLat : null;
    this.editMarkLon = cible.markLon != null && Number.isFinite(cible.markLon) ? cible.markLon : null;
    this.editMarkAltM = cible.markAltM != null && Number.isFinite(cible.markAltM) ? cible.markAltM : null;
    this.editMarkAddress = cible.markAddress?.trim() || null;
    this.editUserAddress = null;
    this.editMapFocus = hasCibleMark(this.editMarkLat, this.editMarkLon) ? 'user' : 'mark';
    this.editError = null;
    this.editMarkAddressBusy = false;
    this.editUserAddressBusy = false;
    this.cibleEditOpen = true;
    this.cdr.detectChanges();
    this.initCibleEditMap();
    this.focusCibleEditDialog();
    this.resolveEditUserAddress();
    if (this.editHasMark() && !this.editMarkAddress) {
      this.resolveEditMarkAddress();
    }
  }

  closeCibleEdit(): void {
    this.cibleEditOpen = false;
    this.editError = null;
    this.editMarkAddressSub?.unsubscribe();
    this.editMarkAddressSub = null;
    this.editUserAddressSub?.unsubscribe();
    this.editUserAddressSub = null;
    this.editMarkAddressBusy = false;
    this.editUserAddressBusy = false;
    this.destroyCibleEditMap();
    this.cdr.markForCheck();
  }

  private focusCibleEditDialog(): void {
    const dialog = this.cibleEditDialogEl?.nativeElement;
    const name = this.cibleEditNameEl?.nativeElement;
    const target = name ?? dialog;
    if (!target) {
      return;
    }
    const apply = (): void => {
      target.focus({ preventScroll: true });
    };
    apply();
    requestAnimationFrame(apply);
    setTimeout(apply, 80);
    setTimeout(apply, 200);
  }

  setEditMapFocus(focus: 'user' | 'mark'): void {
    this.editMapFocus = focus;
    this.cdr.markForCheck();
  }

  onEditNameInput(ev: Event): void {
    this.editName = ((ev.target as HTMLInputElement | null)?.value ?? '').slice(0, 80);
    this.editError = null;
    this.cdr.markForCheck();
  }

  recenterCibleEditMap(): void {
    if (!this.editMap || (!this.editHasUser() && !this.editHasMark())) {
      return;
    }
    this.syncEditMarkersToDraft(true);
    requestAnimationFrame(() => this.editMap?.invalidateSize());
  }

  openCibleEditInTraceViewer(): void {
    if (!this.traceViewerModal) {
      return;
    }
    const user = this.editHasUser() ? { lat: this.editUserLat!, lng: this.editUserLon! } : null;
    const mark = this.editHasMark()
      ? { lat: this.editMarkLat!, lng: this.editMarkLon!, alt: this.editMarkAltM }
      : null;
    const label = this.editName.trim() || this.translate.instant('DIRECTION.TARGET_EDIT_TITLE');
    this.traceViewerModal.openCiblePair(user, mark, label);
  }

  onCiblePairSelected(pair: {
    user: { lat: number; lng: number } | null;
    mark: { lat: number; lng: number; alt?: number | null } | null;
  }): void {
    if (pair.user && Number.isFinite(pair.user.lat) && Number.isFinite(pair.user.lng)) {
      this.editUserLat = pair.user.lat;
      this.editUserLon = pair.user.lng;
      this.editUserAddress = null;
      this.resolveEditUserAddress();
    }
    if (pair.mark && Number.isFinite(pair.mark.lat) && Number.isFinite(pair.mark.lng)) {
      this.editMarkLat = pair.mark.lat;
      this.editMarkLon = pair.mark.lng;
      this.editMarkAltM =
        pair.mark.alt != null && Number.isFinite(pair.mark.alt) ? pair.mark.alt : this.editMarkAltM;
      this.editMarkAddress = null;
      this.resolveEditMarkAddress();
    }
    this.cdr.detectChanges();
    this.syncEditMarkersToDraft(true);
    requestAnimationFrame(() => this.editMap?.invalidateSize());
    setTimeout(() => this.editMap?.invalidateSize(), 120);
    this.cdr.markForCheck();
  }

  useCurrentGpsForEdit(): void {
    if (this.gpsLat == null || this.gpsLon == null || !Number.isFinite(this.gpsLat) || !Number.isFinite(this.gpsLon)) {
      this.editError = 'DIRECTION.TARGET_EDIT_NEED_GPS';
      this.cdr.markForCheck();
      return;
    }
    this.editUserLat = this.gpsLat;
    this.editUserLon = this.gpsLon;
    this.editUserAddress = null;
    this.editError = null;
    this.syncEditMarkersToDraft(true);
    this.resolveEditUserAddress();
    this.cdr.markForCheck();
  }

  clearEditMark(): void {
    this.editMarkLat = null;
    this.editMarkLon = null;
    this.editMarkAltM = null;
    this.editMarkAddress = null;
    this.editMapFocus = 'mark';
    this.syncEditMarkersToDraft(false);
    this.cdr.markForCheck();
  }

  clearEditPhoto(): void {
    this.editPhoto = null;
    this.cdr.markForCheck();
  }

  captureCibleEditPhoto(): void {
    const dataUrl = this.snapCameraJpeg();
    if (!dataUrl) {
      this.editError = 'DIRECTION.TARGET_PHOTO_NEED_CAM';
      this.cdr.markForCheck();
      return;
    }
    this.editPhoto = dataUrl;
    this.editError = null;
    this.cdr.markForCheck();
  }

  onCibleEditPhotoFile(ev: Event): void {
    const input = ev.target as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (input) {
      input.value = '';
    }
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        this.editPhoto = this.imageToJpeg(img);
        this.editError = null;
        this.cdr.markForCheck();
      };
      img.onerror = () => {
        this.editError = 'DIRECTION.TARGET_EDIT_PHOTO_FAIL';
        this.cdr.markForCheck();
      };
      img.src = String(reader.result || '');
    };
    reader.onerror = () => {
      this.editError = 'DIRECTION.TARGET_EDIT_PHOTO_FAIL';
      this.cdr.markForCheck();
    };
    reader.readAsDataURL(file);
  }

  editHasUser(): boolean {
    return this.editUserLat != null && this.editUserLon != null
      && Number.isFinite(this.editUserLat) && Number.isFinite(this.editUserLon);
  }

  editHasMark(): boolean {
    return hasCibleMark(this.editMarkLat, this.editMarkLon);
  }

  editUserGpsText(): string {
    if (!this.editHasUser()) {
      return '—';
    }
    return `${this.editUserLat!.toFixed(5)}, ${this.editUserLon!.toFixed(5)}`;
  }

  editMarkGpsText(): string {
    if (!this.editHasMark()) {
      return '—';
    }
    const alt = this.editMarkAltM != null && Number.isFinite(this.editMarkAltM)
      ? ` · ${this.editMarkAltM.toFixed(0)} m`
      : '';
    return `${this.editMarkLat!.toFixed(5)}, ${this.editMarkLon!.toFixed(5)}${alt}`;
  }

  editMarkAddressText(): string {
    if (this.editMarkAddressBusy) {
      return '…';
    }
    return this.editMarkAddress?.trim() || '—';
  }

  editUserAddressText(): string {
    if (this.editUserAddressBusy) {
      return '…';
    }
    return this.editUserAddress?.trim() || '—';
  }

  editBearingText(): string {
    const az = cibleMarkBearingDeg(this.editUserLat, this.editUserLon, this.editMarkLat, this.editMarkLon);
    const m = cibleMarkDistanceM(this.editUserLat, this.editUserLon, this.editMarkLat, this.editMarkLon);
    if (az == null || m == null) {
      return '—';
    }
    const dist = m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${m.toFixed(0)} m`;
    return `${az.toFixed(2)}° · ${dist}`;
  }

  editDistanceM(): number | null {
    return cibleMarkDistanceM(this.editUserLat, this.editUserLon, this.editMarkLat, this.editMarkLon);
  }

  editMarkTooClose(): boolean {
    const m = this.editDistanceM();
    return m != null && m < CIBLE_MARK_MIN_DIST_M;
  }

  saveCibleEditModal(): void {
    const id = this.selectedCibleId;
    const name = this.editName.trim();
    if (!id) {
      return;
    }
    if (!name) {
      this.editError = 'DIRECTION.TARGET_NAME_REQUIRED';
      this.cdr.markForCheck();
      return;
    }
    this.cibleSaving = true;
    this.editError = null;
    this.cibleUpdatedOk = false;
    const hasMark = this.editHasMark();
    const hasUser = this.editHasUser();
    const refAzimuthDeg = hasUser && hasMark
      ? cibleMarkBearingDeg(this.editUserLat, this.editUserLon, this.editMarkLat, this.editMarkLon)
      : null;
    this.api
      .updateDirectionCible(id, {
        name,
        photoDataUrl: this.editPhoto || '',
        userLat: hasUser ? this.editUserLat : undefined,
        userLon: hasUser ? this.editUserLon : undefined,
        userAccM: hasUser ? null : undefined,
        markLat: hasMark ? this.editMarkLat : null,
        markLon: hasMark ? this.editMarkLon : null,
        markAltM: hasMark ? this.editMarkAltM : null,
        markAddress: hasMark ? this.editMarkAddress : null,
        clearMark: !hasMark,
        refAzimuthDeg
      })
      .subscribe({
        next: (saved) => {
          this.cibleSaving = false;
          this.cibleUpdatedOk = true;
          this.cibleName = name;
          this.ciblePhoto = this.editPhoto;
          this.markLat = this.editMarkLat;
          this.markLon = this.editMarkLon;
          this.markAltM = this.editMarkAltM;
          this.markAddress = this.editMarkAddress;
          this.replaceCible(saved);
          this.ciblePhoto = this.editPhoto;
          saveActiveCibleId(saved.id ?? id);
          this.closeCibleEdit();
          this.cdr.markForCheck();
        },
        error: () => {
          this.cibleSaving = false;
          this.editError = 'DIRECTION.TARGET_SAVE_FAIL';
          this.cdr.markForCheck();
        }
      });
  }

  private initCibleEditMap(): void {
    const el = this.cibleEditMapEl?.nativeElement;
    if (!el) {
      return;
    }
    this.destroyCibleEditMap();
    const center = this.editMapCenter();
    this.zone.runOutsideAngular(() => {
      this.editMap = L.map(el, {
        zoomControl: true,
        attributionControl: true,
        scrollWheelZoom: true,
        keyboard: false
      });
      this.basemaps.applyBaseLayer(this.editMap, 'osm-standard', null);
      this.editMap.setView(center, 14);
      this.editMap.on('click', (e: L.LeafletMouseEvent) => {
        this.zone.run(() => this.onEditMapClick(e.latlng.lat, e.latlng.lng));
      });
      this.syncEditMarkersToDraft(true);
      requestAnimationFrame(() => this.editMap?.invalidateSize());
      setTimeout(() => this.editMap?.invalidateSize(), 120);
    });
  }

  private editMapCenter(): [number, number] {
    if (this.editHasMark()) {
      return [this.editMarkLat!, this.editMarkLon!];
    }
    if (this.editHasUser()) {
      return [this.editUserLat!, this.editUserLon!];
    }
    return [46.2, 6.15];
  }

  private onEditMapClick(lat: number, lon: number): void {
    if (this.editMapIgnoreClick) {
      return;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return;
    }
    if (this.editMapFocus === 'user') {
      this.editUserLat = lat;
      this.editUserLon = lon;
      this.editUserAddress = null;
      this.resolveEditUserAddress();
    } else {
      this.editMarkLat = lat;
      this.editMarkLon = lon;
      this.editMarkAddress = null;
      this.resolveEditMarkAddress();
    }
    this.editError = null;
    this.syncEditMarkersToDraft(false);
    this.cdr.markForCheck();
  }

  private syncEditMarkersToDraft(fit: boolean): void {
    const map = this.editMap;
    if (!map) {
      return;
    }
    if (this.editHasUser()) {
      if (this.editUserMarker) {
        this.editUserMarker.setLatLng([this.editUserLat!, this.editUserLon!]);
      } else {
        this.editUserMarker = this.createEditPin(
          this.editUserLat!,
          this.editUserLon!,
          '#0066FF',
          'user'
        );
        this.editUserMarker.addTo(map);
      }
    } else if (this.editUserMarker) {
      map.removeLayer(this.editUserMarker);
      this.editUserMarker = undefined;
    }
    if (this.editHasMark()) {
      if (this.editMarkMarker) {
        this.editMarkMarker.setLatLng([this.editMarkLat!, this.editMarkLon!]);
      } else {
        this.editMarkMarker = this.createEditPin(
          this.editMarkLat!,
          this.editMarkLon!,
          '#FF0000',
          'mark'
        );
        this.editMarkMarker.addTo(map);
      }
    } else if (this.editMarkMarker) {
      map.removeLayer(this.editMarkMarker);
      this.editMarkMarker = undefined;
    }
    this.updateEditLine();
    const pts: L.LatLngExpression[] = [];
    if (this.editHasUser()) {
      pts.push([this.editUserLat!, this.editUserLon!]);
    }
    if (this.editHasMark()) {
      pts.push([this.editMarkLat!, this.editMarkLon!]);
    }
    if (fit && pts.length) {
      if (pts.length === 2) {
        map.fitBounds(L.latLngBounds(pts), { padding: [36, 36], maxZoom: 16 });
      } else {
        map.setView(pts[0] as L.LatLngExpression, 14);
      }
    }
  }

  private createEditPin(lat: number, lon: number, color: string, kind: 'user' | 'mark'): L.Marker {
    const icon = L.divIcon({
      className: kind === 'user' ? 'dir-edit-pin dir-edit-pin--user' : 'dir-edit-pin dir-edit-pin--mark',
      html: `<div style="width:25px;height:41px;position:relative">
        <svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg" style="display:block">
          <path d="M12.5 0C5.596 0 0 5.596 0 12.5c0 12.5 12.5 28.5 12.5 28.5s12.5-16 12.5-28.5C25 5.596 19.404 0 12.5 0z" fill="${color}" stroke="#FFFFFF" stroke-width="1"/>
          <circle cx="12.5" cy="12.5" r="5" fill="#FFFFFF"/>
        </svg>
      </div>`,
      iconSize: [25, 41],
      iconAnchor: [12.5, 41]
    });
    const marker = L.marker([lat, lon], { draggable: true, icon, zIndexOffset: kind === 'mark' ? 1100 : 1000 });
    marker.on('drag', () => this.applyEditMarkerDrag(kind, marker, false));
    marker.on('dragend', () => {
      this.editMapIgnoreClick = true;
      setTimeout(() => {
        this.editMapIgnoreClick = false;
      }, 250);
      this.applyEditMarkerDrag(kind, marker, true);
    });
    marker.on('click', (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e);
      this.zone.run(() => {
        this.editMapFocus = kind;
        this.cdr.markForCheck();
      });
    });
    return marker;
  }

  private applyEditMarkerDrag(kind: 'user' | 'mark', marker: L.Marker, geocode: boolean): void {
    const pos = marker.getLatLng();
    this.zone.run(() => {
      if (kind === 'user') {
        this.editUserLat = pos.lat;
        this.editUserLon = pos.lng;
        if (geocode) {
          this.editUserAddress = null;
          this.resolveEditUserAddress();
        }
      } else {
        this.editMarkLat = pos.lat;
        this.editMarkLon = pos.lng;
        if (geocode) {
          this.editMarkAddress = null;
          this.resolveEditMarkAddress();
        }
      }
      this.updateEditLine();
      this.cdr.markForCheck();
    });
  }

  private updateEditLine(): void {
    const map = this.editMap;
    if (!map) {
      return;
    }
    const pts: L.LatLngExpression[] = [];
    if (this.editHasUser()) {
      pts.push([this.editUserLat!, this.editUserLon!]);
    }
    if (this.editHasMark()) {
      pts.push([this.editMarkLat!, this.editMarkLon!]);
    }
    if (pts.length !== 2) {
      this.clearEditLine();
      return;
    }
    if (this.editLineHalo) {
      this.editLineHalo.setLatLngs(pts);
      this.editLineHalo.setStyle({ color: '#ffffff', weight: 3, opacity: 0.85 });
    } else {
      this.editLineHalo = L.polyline(pts, {
        color: '#ffffff',
        weight: 3,
        opacity: 0.85,
        lineCap: 'round',
        interactive: false
      }).addTo(map);
    }
    if (this.editLine) {
      this.editLine.setLatLngs(pts);
      this.editLine.setStyle({ color: '#0066FF', weight: 1.5, opacity: 1 });
    } else {
      this.editLine = L.polyline(pts, {
        color: '#0066FF',
        weight: 1.5,
        opacity: 1,
        lineCap: 'round',
        interactive: false
      }).addTo(map);
    }
    const az = cibleMarkBearingDeg(this.editUserLat, this.editUserLon, this.editMarkLat, this.editMarkLon);
    const mid: L.LatLngExpression = [
      (this.editUserLat! + this.editMarkLat!) / 2,
      (this.editUserLon! + this.editMarkLon!) / 2
    ];
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    const card = az != null ? names[Math.round(normalizeDeg(az) / 45) % 8] : '';
    const text = az == null ? '—' : `${az.toFixed(2)}° ${card}`;
    const icon = L.divIcon({
      className: 'dir-edit-bearing-wrap',
      html: `<div class="dir-edit-bearing">${text}</div>`,
      iconSize: [168, 32],
      iconAnchor: [84, 16]
    });
    if (this.editLineLabel) {
      this.editLineLabel.setLatLng(mid);
      this.editLineLabel.setIcon(icon);
    } else {
      this.editLineLabel = L.marker(mid, {
        icon,
        interactive: false,
        keyboard: false,
        zIndexOffset: 1400
      }).addTo(map);
    }
  }

  private clearEditLine(): void {
    const map = this.editMap;
    if (this.editLineLabel) {
      map?.removeLayer(this.editLineLabel);
      this.editLineLabel = undefined;
    }
    if (this.editLine) {
      map?.removeLayer(this.editLine);
      this.editLine = undefined;
    }
    if (this.editLineHalo) {
      map?.removeLayer(this.editLineHalo);
      this.editLineHalo = undefined;
    }
  }

  private resolveEditUserAddress(): void {
    if (!this.editHasUser()) {
      return;
    }
    const lat = this.editUserLat!;
    const lon = this.editUserLon!;
    this.editUserAddressBusy = true;
    this.editUserAddressSub?.unsubscribe();
    this.editUserAddressSub = this.api.geocodeReverse(lat, lon).subscribe({
      next: (res) => {
        this.editUserAddress = geocodeDisplayName(res);
        this.editUserAddressBusy = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.editUserAddressBusy = false;
        this.cdr.markForCheck();
      }
    });
  }

  private resolveEditMarkAddress(): void {
    if (!this.editHasMark()) {
      return;
    }
    const lat = this.editMarkLat!;
    const lon = this.editMarkLon!;
    this.editMarkAddressBusy = true;
    this.editMarkAddressSub?.unsubscribe();
    this.editMarkAddressSub = this.api.geocodeReverse(lat, lon).subscribe({
      next: (res) => {
        this.editMarkAddress = geocodeDisplayName(res);
        this.editMarkAddressBusy = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.editMarkAddressBusy = false;
        this.cdr.markForCheck();
      }
    });
  }

  private destroyCibleEditMap(): void {
    this.editUserMarker = undefined;
    this.editMarkMarker = undefined;
    this.editLine = undefined;
    this.editLineHalo = undefined;
    this.editLineLabel = undefined;
    if (this.editMap) {
      this.editMap.remove();
      this.editMap = undefined;
    }
  }

  private snapCameraJpeg(): string | null {
    const video = this.camEl?.nativeElement;
    if (!video || !this.camLive || video.videoWidth < 8) {
      return null;
    }
    const crop = Math.max(1, this.camDigitalZoom);
    const srcW = video.videoWidth / crop;
    const srcH = video.videoHeight / crop;
    const sx = (video.videoWidth - srcW) / 2;
    const sy = (video.videoHeight - srcH) / 2;
    return this.drawToJpeg(video, sx, sy, srcW, srcH);
  }

  private imageToJpeg(img: HTMLImageElement): string {
    return this.drawToJpeg(img, 0, 0, img.naturalWidth || img.width, img.naturalHeight || img.height);
  }

  private drawToJpeg(
    source: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number
  ): string {
    const maxW = 720;
    const ratio = Math.min(1, maxW / Math.max(1, sw));
    const w = Math.round(sw * ratio);
    const h = Math.round(sh * ratio);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, w);
    canvas.height = Math.max(1, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return '';
    }
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.72);
  }

  saveNewCible(): void {
    const name = this.cibleName.trim();
    const heading = this.magAzimuthDeg;
    if (!name) {
      this.cibleError = 'DIRECTION.TARGET_NAME_REQUIRED';
      this.cdr.markForCheck();
      return;
    }
    if (heading == null) {
      this.cibleError = 'DIRECTION.TARGET_NEED_SENSORS';
      this.cdr.markForCheck();
      return;
    }
    this.cibleSaving = true;
    this.cibleError = null;
    this.api
      .createDirectionCible({
        name,
        userLat: this.gpsLat,
        userLon: this.gpsLon,
        userAccM: this.gpsAccM,
        phoneHeadingDeg: heading,
        refAzimuthDeg: this.resolveCibleRefAzimuth(),
        phoneElevationDeg: this.elevationDeg,
        markLat: this.markLat,
        markLon: this.markLon,
        markAltM: this.markAltM,
        markAddress: this.markAddress,
        photoDataUrl: this.ciblePhoto,
        active: true
      })
      .subscribe({
        next: (saved) => {
          this.cibleSaving = false;
          this.replaceCible(saved);
          this.selectedCibleId = saved.id ?? null;
          saveActiveCibleId(saved.id ?? null);
          this.cdr.markForCheck();
        },
        error: () => {
          this.cibleSaving = false;
          this.cibleError = 'DIRECTION.TARGET_SAVE_FAIL';
          this.cdr.markForCheck();
        }
      });
  }

  recalibrateCible(): void {
    const id = this.selectedCibleId;
    const heading = this.magAzimuthDeg;
    if (!id || heading == null) {
      this.cibleError = 'DIRECTION.TARGET_NEED_SENSORS';
      this.cdr.markForCheck();
      return;
    }
    this.cibleSaving = true;
    this.cibleError = null;
    this.api
      .recalibrateDirectionCible(id, {
        name: this.cibleName.trim() || undefined,
        userLat: this.gpsLat,
        userLon: this.gpsLon,
        userAccM: this.gpsAccM,
        phoneHeadingDeg: heading,
        refAzimuthDeg: this.resolveCibleRefAzimuth(this.selectedCible()?.refAzimuthDeg),
        phoneElevationDeg: this.elevationDeg,
        markLat: this.markLat,
        markLon: this.markLon,
        markAltM: this.markAltM,
        markAddress: this.markAddress,
        photoDataUrl: this.ciblePhoto
      })
      .subscribe({
        next: (saved) => {
          this.cibleSaving = false;
          this.cibleCheck = null;
          this.replaceCible(saved);
          saveActiveCibleId(saved.id ?? id);
          this.cdr.markForCheck();
        },
        error: () => {
          this.cibleSaving = false;
          this.cibleError = 'DIRECTION.TARGET_SAVE_FAIL';
          this.cdr.markForCheck();
        }
      });
  }

  deleteCible(cible: DirectionCible, ev?: Event): void {
    ev?.stopPropagation();
    if (!cible.id) {
      return;
    }
    if (!window.confirm(this.translate.instant('DIRECTION.TARGET_DELETE_CONFIRM'))) {
      return;
    }
    this.api.deleteDirectionCible(cible.id).subscribe({
      next: () => {
        this.cibles = this.cibles.filter((c) => c.id !== cible.id);
        if (this.selectedCibleId === cible.id) {
          this.startNewCible();
          saveActiveCibleId(null);
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.cibleError = 'DIRECTION.TARGET_SAVE_FAIL';
        this.cdr.markForCheck();
      }
    });
  }

  openCibleJson(cible: DirectionCible, ev?: Event): void {
    ev?.stopPropagation();
    this.cibleJsonCopied = false;
    this.cibleJsonModal = cible;
    this.cdr.markForCheck();
  }

  closeCibleJson(): void {
    this.cibleJsonModal = null;
    this.cibleJsonCopied = false;
    if (this.cibleJsonCopyTimer != null) {
      clearTimeout(this.cibleJsonCopyTimer);
      this.cibleJsonCopyTimer = null;
    }
    this.cdr.markForCheck();
  }

  cibleJsonText(): string {
    if (!this.cibleJsonModal) {
      return '';
    }
    return JSON.stringify(this.cibleJsonModal, null, 2);
  }

  copyCibleJson(): void {
    const text = this.cibleJsonText();
    if (!text) {
      return;
    }
    const done = (): void => {
      this.cibleJsonCopied = true;
      if (this.cibleJsonCopyTimer != null) {
        clearTimeout(this.cibleJsonCopyTimer);
      }
      this.cibleJsonCopyTimer = setTimeout(() => {
        this.cibleJsonCopied = false;
        this.cibleJsonCopyTimer = null;
        this.cdr.markForCheck();
      }, 1600);
      this.cdr.markForCheck();
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(done).catch(() => undefined);
      return;
    }
    done();
  }

  private loadCibles(): void {
    this.cibleLoading = true;
    this.api.listDirectionCibles().subscribe({
      next: (res) => {
        this.cibleLoading = false;
        this.cibles = res.cibles ?? [];
        const active = this.cibles.find((c) => c.active) ?? this.cibles.find((c) => c.id === loadActiveCibleId());
        if (active?.id) {
          this.selectedCibleId = active.id;
          this.cibleName = active.name;
          this.ciblePhoto = active.photoDataUrl ?? null;
          this.applyMarkFromCible(active);
          saveActiveCibleId(active.id);
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.cibleLoading = false;
        this.cdr.markForCheck();
      }
    });
  }

  private replaceCible(saved: DirectionCible): void {
    if (!saved.id) {
      return;
    }
    const next = this.cibles.filter((c) => c.id !== saved.id).map((c) => ({ ...c, active: false }));
    this.cibles = [saved, ...next];
    this.selectedCibleId = saved.id;
    this.cibleName = saved.name;
    this.ciblePhoto = saved.photoDataUrl ?? this.ciblePhoto;
    this.applyMarkFromCible(saved);
    if (!this.ciblePhoto) {
      this.cibleStageView = 'camera';
    }
  }

  startPatWizard(): void {
    this.activeTab = 'calibrage';
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

  viseurUprightDeg(): number {
    return -this.roseDeg();
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
        this.maybeResolveUserAddress();
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
      this.lastQuatAtt = att;
    }
    this.fuse();
  }

  private onMag(raw: Vec3): void {
    if (this.calibrating && this.calMethod === 'figure8') {
      this.northEngine.hasMag = true;
      if (!this.figure8HardIronFresh) {
        this.hardIron.reset();
        this.figure8HardIronFresh = true;
      }
      this.calPct = this.hardIron.ingest(raw);
      if (this.hardIron.finish()) {
        const corrected = this.hardIron.correct(raw);
        this.mag = corrected;
        this.hasMag = true;
        this.magKnown = true;
        this.magUt = hypot3(this.mag);
        this.fuse();
        this.finishFigure8();
        return;
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
    if (this.hasMag) {
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
    if (this.calibrating && this.calMethod === 'figure8') {
      this.northEngine.hasAccel = true;
      if (!this.hasMag && this.northEngine.ingestFigure8Accel(v.x, v.y, v.z)) {
        this.calPct = this.northEngine.calProgressPct;
        this.pushPatBurst();
        this.fuse();
        this.finishFigure8();
        return;
      }
      this.calPct = Math.max(this.calPct, this.northEngine.calProgressPct);
    }
    this.pushPatBurst();
    this.fuse();
  }

  private fuse(): void {
    const magAtt =
      this.hasMag && this.hasAccel ? cameraFromMagAccel(this.mag, this.accel, this.attitudeOpt()) : null;
    if (magAtt) {
      if (this.hasGyro || this.lastQuatAtt) {
        this.applyAtt(
          this.fusion.tick(this.gyro, this.accel, magAtt, this.lastQuatAtt),
          this.hasGyro ? 'gyro-lock' : 'mag-accel'
        );
        return;
      }
      this.applyAtt(magAtt, 'mag-accel');
      return;
    }
    if (this.lastQuatAtt) {
      this.applyAtt(this.lastQuatAtt, 'rotation-vector');
    }
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
    if (this.calibrating && this.calMethod === 'figure8' && !this.hasMag) {
      if (this.northEngine.ingestFigure8Heading(att.azimuthDeg)) {
        this.finishFigure8();
        return;
      }
      this.calPct = Math.max(this.calPct, this.northEngine.calProgressPct);
    }
    this.publish();
  }

  private publish(): void {
    const az = this.headingBeforeOffset();
    if (az == null) {
      this.schedule();
      return;
    }
    this.azimuthDeg = composeLookAzimuth(az, this.patFile?.derived ?? null);
    this.schedule();
  }

  /** Cap caméra avant correction manuelle : magnétomètre, + déclinaison si Nord géographique. */
  private headingBeforeOffset(): number | null {
    if (this.magAzimuthDeg == null) {
      return null;
    }
    return applyLookDeclination(this.magAzimuthDeg, this.trueNorthActive, this.declinationDeg);
  }

  private finishFigure8(): void {
    if (!this.calibrating) {
      return;
    }
    this.calibrating = false;
    this.northEngine.cancelCal();
    if (this.hardIron.ready && this.figure8HardIronFresh) {
      this.saveCal();
    } else {
      this.syncSharedNordCal();
    }
    this.fusion.reset();
    this.fuse();
    const headingAfter = this.headingBeforeOffset();
    const headingBefore = this.figure8Snap?.heading ?? null;
    const offsetBefore = this.figure8Snap?.offset ?? this.offsetDeg;
    if (headingBefore != null && headingAfter != null) {
      const jump = circularDiff(headingAfter, headingBefore);
      this.setOffset(offsetBefore - jump);
    }
    this.figure8Report = {
      usedRawMag: this.hasMag && this.hardIron.ready,
      offsetBefore,
      offsetAfter: this.offsetDeg,
      headingBefore,
      headingAfter,
      fieldBefore: this.figure8Snap?.field ?? null,
      fieldAfter: this.magUt,
      bias: { ...this.hardIron.bias }
    };
    this.figure8ModalOpen = true;
    this.calMethod = null;
    this.cdr.markForCheck();
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
    const raw = this.headingBeforeOffset();
    if (raw == null) {
      return;
    }
    this.setOffset(circularDiff(targetTrueDeg, raw));
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
    const before = this.headingBeforeOffset();
    if (this.calMethod !== 'gps' || before == null) {
      return;
    }
    if (course == null || this.walkSpeedMps == null || this.walkSpeedMps < this.calMinSpeedMps) {
      return;
    }
    this.calAccum.push(circularDiff(course, before));
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
