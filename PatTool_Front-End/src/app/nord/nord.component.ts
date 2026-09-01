import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { ApiService } from '../services/api.service';
import { CompassNorthEngine } from '../shared/compass-north.engine';
import { CompassRoseComponent } from '../shared/compass-rose/compass-rose.component';
import {
  needsMotionPermissionTap,
  requestMotionPermissionIfNeeded
} from '../shared/device-motion-permission.util';
import { magneticDeclinationDeg } from './magnetic-declination';

const PAINT_MIN_MS = 50;
const MAG_HZ = 50;
const EARTH_FIELD_MIN_UT = 22;
const EARTH_FIELD_MAX_UT = 72;
const STABILITY_WINDOW = 40;

type SensorStatus = 'unsupported' | 'denied' | 'idle' | 'live' | 'error';
type CalPhase = 'idle' | 'figure8' | 'settle' | 'done';
type HeadingSource = 'magnetometer' | 'webkit' | 'absolute-event' | 'abs-sensor' | 'gps';

export interface SensorTile {
  id: string;
  labelKey: string;
  status: SensorStatus;
  rows: { label: string; value: string }[];
  noteKey?: string;
  drivesNorth?: boolean;
}

interface GenericSensorLike {
  start(): void;
  stop(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  x?: number;
  y?: number;
  z?: number;
  illuminance?: number;
  quaternion?: number[];
  distance?: number;
  max?: number;
  near?: boolean;
}

/** Même ordre que l’écran diagnostic Samsung (*#0*#). */
const HARDWARE_TILE_IDS = [
  'accelerometer',
  'barometer',
  'proxy-light',
  'gyroscope',
  'magnetometer',
  'fingerprint'
] as const;

@Component({
  selector: 'app-nord',
  standalone: true,
  imports: [CommonModule, RouterModule, TranslateModule, CompassRoseComponent],
  templateUrl: './nord.component.html',
  styleUrls: ['./nord.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class NordComponent implements OnInit, AfterViewInit, OnDestroy {
  sensorsEnabled = false;
  permissionDenied = false;
  permissionNeeded = false;

  headingMagDeg: number | null = null;
  headingTrueDeg: number | null = null;
  headingSource: HeadingSource | null = null;
  /** 0° = à plat (écran vers le ciel) ; + = haut vers le ciel ; − = avant vers le sol. */
  pitchDeg: number | null = null;
  /** Roulis, 0° = pas de bascule gauche/droite. */
  rollDeg: number | null = null;
  northOffsetDeg = 0;
  trueNorth = true;
  declinationDeg: number | null = null;

  /** GPS + déclinaison : sans ça, le Nord géographique n’est pas calculable. */
  get trueNorthAvailable(): boolean {
    return this.declinationDeg != null && Number.isFinite(this.declinationDeg);
  }

  get trueNorthActive(): boolean {
    return this.trueNorth && this.trueNorthAvailable;
  }

  readonly northEngine = new CompassNorthEngine();

  get calPhase(): CalPhase {
    return this.northEngine.calPhase;
  }
  get calibrated(): boolean {
    return this.northEngine.magCalibrated || this.northEngine.calPhase === 'done';
  }

  magFieldUt: number | null = null;
  stabilityDeg: number | null = null;
  gpsLat: number | null = null;
  gpsLon: number | null = null;
  gpsAccuracyM: number | null = null;
  gpsAltitudeM: number | null = null;
  gpsAltitudeAccuracyM: number | null = null;
  gpsHeadingDeg: number | null = null;
  gpsSpeedMs: number | null = null;

  get hardwareTiles(): SensorTile[] {
    return HARDWARE_TILE_IDS.map((id) => this.tile(id));
  }

  get extraTiles(): SensorTile[] {
    return this.tiles.filter((t) => !(HARDWARE_TILE_IDS as readonly string[]).includes(t.id));
  }

  /** Capteur magnétique (API brute, azimut OS ou iOS) — pas le cap GPS. */
  get usesMagneticNorth(): boolean {
    return (
      this.headingSource === 'magnetometer' ||
      this.headingSource === 'webkit' ||
      this.headingSource === 'absolute-event' ||
      this.headingSource === 'abs-sensor'
    );
  }
  addressLabel: string | null = null;
  addressBusy = false;
  addressError: string | null = null;

  tiles: SensorTile[] = NordComponent.initialTiles();

  private headingSamples: number[] = [];
  private lastPaintMs = 0;

  private accel = { x: 0, y: 0, z: 9.81 };
  private gyro = { x: 0, y: 0, z: 0 };
  private magRaw: { x: number; y: number; z: number } | null = null;
  private baroHpa: number | null = null;
  private lightLux: number | null = null;
  private proxDistance: number | null = null;
  private proxNear: boolean | null = null;
  private hasAccel = false;
  private accelFromGeneric = false;
  private hasGyro = false;
  private hasMag = false;
  private gyroFromGeneric = false;

  private liveSensors: GenericSensorLike[] = [];
  private orientationEventName: 'deviceorientationabsolute' | 'deviceorientation' | null = null;
  private orientationListening = false;
  private motionListening = false;
  private geoWatchId: number | null = null;
  private batteryRef: { removeEventListener(type: string, listener: EventListener): void } | null =
    null;
  private networkRef: { removeEventListener(type: string, listener: EventListener): void } | null =
    null;
  private networkHandler: EventListener | null = null;
  private screenHandler: (() => void) | null = null;
  private reverseGeocodeSub: Subscription | null = null;
  private lastAddressLat: number | null = null;
  private lastAddressLon: number | null = null;
  private lastAddressAtMs = 0;
  private handleOrientation = (e: DeviceOrientationEvent): void => this.onDeviceOrientation(e);
  private handleMotion = (e: DeviceMotionEvent): void => this.onDeviceMotion(e);
  private handleDeviceLight = (e: Event): void => {
    const v = (e as Event & { value?: number }).value;
    if (typeof v === 'number' && Number.isFinite(v)) {
      this.lightLux = v;
      this.paintProxyLight();
      this.schedulePaint();
    }
  };
  private handleDeviceProximity = (e: Event): void => {
    const ev = e as Event & { value?: number; near?: boolean };
    if (typeof ev.value === 'number' && Number.isFinite(ev.value)) {
      this.proxDistance = ev.value;
    }
    if (typeof ev.near === 'boolean') {
      this.proxNear = ev.near;
    }
    this.paintProxyLight();
    this.schedulePaint();
  };
  private handleBattery = (): void => {
    /* bound later */
  };

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

  constructor(
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef,
    private readonly api: ApiService,
    private readonly hostEl: ElementRef<HTMLElement>
  ) {}

  ngOnInit(): void {
    this.loadPersisted();
    this.probeUnsupported();
    void this.startAll(false);
  }

  ngAfterViewInit(): void {
    this.queueHidePageTitle();
  }

  ngOnDestroy(): void {
    if (this.hideTitleTimer != null) {
      clearTimeout(this.hideTitleTimer);
      this.hideTitleTimer = null;
    }
    this.unbindTitleHideGuard();
    this.stopAll();
  }

  private queueHidePageTitle(): void {
    this.hideTitleTries = 0;
    this.bindTitleHideGuard();
    this.zone.runOutsideAngular(() => {
      const run = (): void => {
        this.scrollPastPageTitle();
        this.hideTitleTries += 1;
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

  async enableSensors(): Promise<void> {
    this.permissionNeeded = false;
    this.permissionDenied = false;
    await this.startAll(true);
  }

  refreshAddress(): void {
    this.addressError = null;
    this.addressBusy = true;
    this.cdr.markForCheck();
    if (!navigator.geolocation) {
      if (this.gpsLat != null && this.gpsLon != null) {
        this.resolveAddress(this.gpsLat, this.gpsLon);
        return;
      }
      this.addressBusy = false;
      this.addressError = 'NORD.ADDRESS_NEED_GPS';
      this.cdr.markForCheck();
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.gpsLat = pos.coords.latitude;
        this.gpsLon = pos.coords.longitude;
        this.gpsAccuracyM = pos.coords.accuracy;
        this.declinationDeg = magneticDeclinationDeg(this.gpsLat, this.gpsLon);
        this.applyDeclination();
        this.gpsAltitudeM =
          typeof pos.coords.altitude === 'number' && Number.isFinite(pos.coords.altitude)
            ? pos.coords.altitude
            : this.gpsAltitudeM;
        this.paintBarometer();
        this.resolveAddress(this.gpsLat, this.gpsLon);
      },
      () => {
        if (this.gpsLat != null && this.gpsLon != null) {
          this.resolveAddress(this.gpsLat, this.gpsLon);
          return;
        }
        this.addressBusy = false;
        this.addressError = 'NORD.ADDRESS_NEED_GPS';
        this.cdr.markForCheck();
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  toggleTrueNorth(): void {
    if (!this.trueNorthAvailable) {
      return;
    }
    this.trueNorth = !this.trueNorth;
    this.persist();
    this.applyDeclination();
  }

  roseRotationDeg(): number {
    return this.northEngine.roseUnwrappedDeg;
  }

  displayedHeading(): number | null {
    return this.trueNorthActive ? this.headingTrueDeg : this.headingMagDeg;
  }

  cardinalLabel(): string {
    const h = this.displayedHeading();
    if (h == null) {
      return '—';
    }
    const idx = ((Math.round(h / 22.5) % 16) + 16) % 16;
    return NordComponent.CARDINALS[idx];
  }

  fieldStatus(): 'ok' | 'interference' | 'unknown' {
    if (this.magFieldUt == null) {
      return 'unknown';
    }
    if (this.magFieldUt < EARTH_FIELD_MIN_UT || this.magFieldUt > EARTH_FIELD_MAX_UT) {
      return 'interference';
    }
    return 'ok';
  }

  stabilityStatus(): 'good' | 'jitter' | 'unknown' {
    if (this.stabilityDeg == null) {
      return 'unknown';
    }
    return this.stabilityDeg <= 2.5 ? 'good' : 'jitter';
  }

  headingText(): string {
    const h = this.displayedHeading();
    if (h == null) {
      return '—';
    }
    return String(((Math.round(h) % 360) + 360) % 360);
  }

  pitchText(): string {
    if (this.pitchDeg == null) {
      return '—';
    }
    const p = this.pitchDeg;
    if (Math.abs(p) < 0.5) {
      return '0°';
    }
    const abs = Math.abs(p).toFixed(0);
    return p > 0 ? `+${abs}°` : `−${abs}°`;
  }

  rollText(): string {
    if (this.rollDeg == null) {
      return '—';
    }
    const r = this.rollDeg;
    const abs = Math.abs(r).toFixed(0);
    if (Math.abs(r) < 1) {
      return '0°';
    }
    return r > 0 ? `${abs}° D` : `${abs}° G`;
  }

  altitudeText(): string {
    if (this.gpsAltitudeM == null || !Number.isFinite(this.gpsAltitudeM)) {
      return '—';
    }
    const m = `${this.gpsAltitudeM.toFixed(0)} m`;
    if (this.gpsAltitudeAccuracyM != null && Number.isFinite(this.gpsAltitudeAccuracyM)) {
      return `${m} ±${Math.max(0, this.gpsAltitudeAccuracyM).toFixed(0)}`;
    }
    return m;
  }

  pitchGaugePercent(): number {
    if (this.pitchDeg == null) {
      return 50;
    }
    const p = Math.max(-90, Math.min(90, this.pitchDeg));
    return ((p + 90) / 180) * 100;
  }

  pitchFillHeightPct(): number {
    if (this.pitchDeg == null) {
      return 0;
    }
    return (Math.min(90, Math.abs(this.pitchDeg)) / 90) * 50;
  }

  pitchFillBottomPct(): number {
    if (this.pitchDeg == null || this.pitchDeg >= 0) {
      return 50;
    }
    return 50 - this.pitchFillHeightPct();
  }

  headingSourceKey(): string {
    if (!this.headingSource) {
      return '';
    }
    return 'NORD.SRC_' + this.headingSource.replace(/-/g, '_');
  }

  declinationText(): string {
    if (this.declinationDeg == null) {
      return '—';
    }
    const d = this.declinationDeg;
    const abs = Math.abs(d).toFixed(2);
    return d >= 0 ? `${abs}° E` : `${abs}° O`;
  }

  private static readonly CARDINALS = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSO',
    'SO',
    'OSO',
    'O',
    'ONO',
    'NO',
    'NNO'
  ];

  private static initialTiles(): SensorTile[] {
    const ids: { id: string; labelKey: string }[] = [
      { id: 'accelerometer', labelKey: 'NORD.S_ACCEL' },
      { id: 'barometer', labelKey: 'NORD.S_BARO' },
      { id: 'proxy-light', labelKey: 'NORD.S_PROXY_LIGHT' },
      { id: 'gyroscope', labelKey: 'NORD.S_GYRO' },
      { id: 'magnetometer', labelKey: 'NORD.S_MAG' },
      { id: 'fingerprint', labelKey: 'NORD.S_FINGER' },
      { id: 'gravity', labelKey: 'NORD.S_GRAVITY' },
      { id: 'linear-accel', labelKey: 'NORD.S_LINEAR' },
      { id: 'abs-orient', labelKey: 'NORD.S_ABS' },
      { id: 'rel-orient', labelKey: 'NORD.S_REL' },
      { id: 'device-orientation', labelKey: 'NORD.S_DO' },
      { id: 'device-motion', labelKey: 'NORD.S_DM' },
      { id: 'geolocation', labelKey: 'NORD.S_GPS' },
      { id: 'battery', labelKey: 'NORD.S_BATTERY' },
      { id: 'network', labelKey: 'NORD.S_NET' },
      { id: 'screen', labelKey: 'NORD.S_SCREEN' }
    ];
    return ids.map((s) => ({ ...s, status: 'idle', rows: [] }));
  }

  private tile(id: string): SensorTile {
    return this.tiles.find((t) => t.id === id)!;
  }

  private setTile(
    id: string,
    status: SensorStatus,
    rows: { label: string; value: string }[],
    noteKey?: string
  ): void {
    const t = this.tile(id);
    t.status = status;
    t.rows = rows;
    if (noteKey !== undefined) {
      t.noteKey = noteKey;
    }
  }

  private probeUnsupported(): void {
    const w = window as unknown as Record<string, unknown>;
    const map: { id: string; ctor: string }[] = [
      { id: 'accelerometer', ctor: 'Accelerometer' },
      { id: 'gravity', ctor: 'GravitySensor' },
      { id: 'linear-accel', ctor: 'LinearAccelerationSensor' },
      { id: 'gyroscope', ctor: 'Gyroscope' },
      { id: 'abs-orient', ctor: 'AbsoluteOrientationSensor' },
      { id: 'rel-orient', ctor: 'RelativeOrientationSensor' }
    ];
    for (const m of map) {
      if (typeof w[m.ctor] !== 'function') {
        this.setTile(m.id, 'unsupported', []);
      }
    }
    if (!('DeviceOrientationEvent' in window)) {
      this.setTile('device-orientation', 'unsupported', []);
    }
    if (!('DeviceMotionEvent' in window)) {
      this.setTile('device-motion', 'unsupported', []);
    }
    if (!navigator.geolocation) {
      this.setTile('geolocation', 'unsupported', []);
    }
    if (!('getBattery' in navigator)) {
      this.setTile('battery', 'unsupported', []);
    }
    if (!('connection' in navigator || 'mozConnection' in navigator)) {
      this.setTile('network', 'unsupported', []);
    }
    this.setTile('magnetometer', 'idle', [], 'NORD.S_MAG_NOTE');
    this.setTile('barometer', 'idle', [], 'NORD.S_BARO_NOTE');
    this.setTile('proxy-light', 'idle', [], 'NORD.S_PROXY_LIGHT_NOTE');
    this.setTile('fingerprint', 'idle', [], 'NORD.S_FINGER_NOTE');
  }

  private async startAll(fromUserGesture: boolean): Promise<void> {
    if (needsMotionPermissionTap()) {
      if (!fromUserGesture) {
        this.permissionNeeded = true;
        this.cdr.markForCheck();
        return;
      }
      if ((await requestMotionPermissionIfNeeded()) === 'denied') {
        this.permissionDenied = true;
        this.cdr.markForCheck();
        return;
      }
    }

    this.sensorsEnabled = true;
    await this.requestSensorPermissions();
    this.startGenericSensors();
    this.startOrientation();
    this.startMotion();
    this.startLegacyLightProximity();
    this.startGeo();
    this.startBattery();
    this.startNetwork();
    this.startScreen();
    void this.startFingerprint();
    this.paintBarometer();
    this.paintProxyLight();
    this.paintMagneticTile();
    this.cdr.markForCheck();
  }

  private startGenericSensors(): void {
    const w = window as unknown as Record<string, unknown>;
    this.tryGeneric(
      'magnetometer',
      w['Magnetometer'] as (new (opts: { frequency: number }) => GenericSensorLike) | undefined,
      (s) => {
        const x = s.x ?? 0;
        const y = s.y ?? 0;
        const z = s.z ?? 0;
        this.hasMag = true;
        this.northEngine.hasMag = true;
        this.onMagSample(x, y, z);
      }
    );
    this.tryGeneric(
      'barometer',
      (w['Barometer'] ?? w['AmbientPressureSensor'] ?? w['PressureSensor']) as
        | (new (opts: { frequency: number }) => GenericSensorLike)
        | undefined,
      (s) => {
        const anyS = s as GenericSensorLike & { reading?: number; pressure?: number };
        const hPa = anyS.reading ?? anyS.pressure ?? anyS.x;
        if (typeof hPa === 'number' && Number.isFinite(hPa)) {
          this.baroHpa = hPa;
          this.paintBarometer();
        }
      }
    );
    this.tryGeneric(
      'accelerometer',
      w['Accelerometer'] as (new (opts: { frequency: number }) => GenericSensorLike) | undefined,
      (s) => {
        const x = s.x ?? 0;
        const y = s.y ?? 0;
        const z = s.z ?? 0;
        this.accel = { x, y, z };
        this.hasAccel = true;
        this.accelFromGeneric = true;
        this.northEngine.accel = this.accel;
        this.northEngine.hasAccel = true;
        if (this.calPhase === 'figure8' && this.northEngine.ingestFigure8Accel(x, y, z)) {
          this.beginSettle();
        }
        this.updateAttitudeFromAccel();
        this.setTile('accelerometer', 'live', this.accelRows(x, y, z));
        this.schedulePaint();
      }
    );
    this.tryGeneric(
      'gravity',
      w['GravitySensor'] as (new (opts: { frequency: number }) => GenericSensorLike) | undefined,
      (s) => {
        const x = s.x ?? 0;
        const y = s.y ?? 0;
        const z = s.z ?? 0;
        this.accel = { x, y, z };
        this.hasAccel = true;
        this.accelFromGeneric = true;
        this.northEngine.accel = this.accel;
        this.northEngine.hasAccel = true;
        if (this.calPhase === 'figure8' && this.northEngine.ingestFigure8Accel(x, y, z)) {
          this.beginSettle();
        }
        this.updateAttitudeFromAccel();
        this.setTile('gravity', 'live', this.xyzRows(x, y, z, 'm/s²'));
        this.schedulePaint();
      }
    );
    this.tryGeneric(
      'linear-accel',
      w['LinearAccelerationSensor'] as
        | (new (opts: { frequency: number }) => GenericSensorLike)
        | undefined,
      (s) => {
        this.setTile(
          'linear-accel',
          'live',
          this.xyzRows(s.x ?? 0, s.y ?? 0, s.z ?? 0, 'm/s²')
        );
      }
    );
    this.tryGeneric(
      'gyroscope',
      w['Gyroscope'] as (new (opts: { frequency: number }) => GenericSensorLike) | undefined,
      (s) => {
        const x = s.x ?? 0;
        const y = s.y ?? 0;
        const z = s.z ?? 0;
        this.gyro = { x, y, z };
        this.hasGyro = true;
        this.gyroFromGeneric = true;
        this.northEngine.gyro = this.gyro;
        this.northEngine.hasGyro = true;
        this.setTile('gyroscope', 'live', this.gyroRows(x, y, z), 'NORD.S_OIS_NOTE');
        this.tickFusion();
      }
    );
    this.tryGeneric(
      'abs-orient',
      w['AbsoluteOrientationSensor'] as
        | (new (opts: { frequency: number; referenceFrame?: string }) => GenericSensorLike)
        | undefined,
      (s) => {
        const q = s.quaternion;
        const heading = q ? this.headingFromQuaternion(q) : null;
        this.setTile('abs-orient', 'live', [
          { label: 'q0', value: this.fmt(q?.[0]) },
          { label: 'q1', value: this.fmt(q?.[1]) },
          { label: 'q2', value: this.fmt(q?.[2]) },
          { label: 'q3', value: this.fmt(q?.[3]) },
          { label: 'cap', value: heading == null ? '—' : `${heading.toFixed(1)}°` }
        ]);
        if (!this.hasMag && heading != null) {
          this.publishMagHeading(heading, 'abs-sensor');
        }
      },
      { referenceFrame: 'screen' }
    );
    this.tryGeneric(
      'rel-orient',
      w['RelativeOrientationSensor'] as
        | (new (opts: { frequency: number }) => GenericSensorLike)
        | undefined,
      (s) => {
        const q = s.quaternion;
        this.setTile('rel-orient', 'live', [
          { label: 'q0', value: this.fmt(q?.[0]) },
          { label: 'q1', value: this.fmt(q?.[1]) },
          { label: 'q2', value: this.fmt(q?.[2]) },
          { label: 'q3', value: this.fmt(q?.[3]) }
        ]);
      }
    );
    this.tryGeneric(
      'proxy-light',
      w['AmbientLightSensor'] as (new (opts: { frequency: number }) => GenericSensorLike) | undefined,
      (s) => {
        if (typeof s.illuminance === 'number' && Number.isFinite(s.illuminance)) {
          this.lightLux = s.illuminance;
          this.paintProxyLight();
        }
      }
    );
    this.tryGeneric(
      'proxy-light',
      w['ProximitySensor'] as (new (opts: { frequency: number }) => GenericSensorLike) | undefined,
      (s) => {
        if (typeof s.distance === 'number' && Number.isFinite(s.distance)) {
          this.proxDistance = s.distance;
        }
        if (typeof s.near === 'boolean') {
          this.proxNear = s.near;
        }
        this.paintProxyLight();
      }
    );
  }

  private async requestSensorPermissions(): Promise<void> {
    const names = ['accelerometer', 'gyroscope', 'magnetometer', 'ambient-light-sensor'] as const;
    const perms = navigator.permissions;
    if (!perms?.query) {
      return;
    }
    for (const name of names) {
      try {
        await perms.query({ name: name as PermissionName });
      } catch {
        /* PermissionName non reconnu */
      }
    }
  }

  private tryGeneric(
    id: string,
    Ctor:
      | (new (opts: { frequency: number; referenceFrame?: string }) => GenericSensorLike)
      | undefined,
    onReading: (s: GenericSensorLike) => void,
    extra?: { referenceFrame?: string }
  ): void {
    if (typeof Ctor !== 'function') {
      return;
    }
    try {
      const sensor = extra?.referenceFrame
        ? new Ctor({ frequency: MAG_HZ, referenceFrame: extra.referenceFrame })
        : new Ctor({ frequency: MAG_HZ });
      const reading = (): void => onReading(sensor);
      const error = (ev: Event): void => {
        const t = this.tile(id);
        if (t.status === 'live') {
          return;
        }
        const err = (ev as Event & { error?: { name?: string; message?: string } }).error;
        const cause = err?.name || err?.message || 'error';
        this.setTile(id, 'error', [...t.rows, { label: 'cause', value: String(cause) }]);
      };
      sensor.addEventListener('reading', reading);
      sensor.addEventListener('error', error);
      sensor.start();
      this.liveSensors.push(sensor);
    } catch {
      this.setTile(id, 'denied', []);
    }
  }

  private startOrientation(): void {
    if (this.orientationListening || !('DeviceOrientationEvent' in window)) {
      return;
    }
    const absolute = 'ondeviceorientationabsolute' in window;
    this.orientationEventName = absolute ? 'deviceorientationabsolute' : 'deviceorientation';
    this.zone.runOutsideAngular(() => {
      window.addEventListener(this.orientationEventName!, this.handleOrientation, true);
    });
    this.orientationListening = true;
  }

  private startLegacyLightProximity(): void {
    window.addEventListener('devicelight', this.handleDeviceLight);
    window.addEventListener('deviceproximity', this.handleDeviceProximity);
    window.addEventListener('userproximity', this.handleDeviceProximity);
  }

  private async startFingerprint(): Promise<void> {
    const rows: { label: string; value: string }[] = [{ label: '*#0*#', value: 'web: non' }];
    try {
      const pk = window.PublicKeyCredential;
      if (pk && typeof pk.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
        const uv = await pk.isUserVerifyingPlatformAuthenticatorAvailable();
        rows.push({ label: 'WebAuthn', value: uv ? 'oui' : 'non' });
      } else {
        rows.push({ label: 'WebAuthn', value: '—' });
      }
    } catch {
      rows.push({ label: 'WebAuthn', value: '—' });
    }
    this.setTile('fingerprint', 'unsupported', rows, 'NORD.S_FINGER_NOTE');
    this.schedulePaint();
  }

  private startMotion(): void {
    if (this.motionListening || !('DeviceMotionEvent' in window)) {
      return;
    }
    this.zone.runOutsideAngular(() => {
      window.addEventListener('devicemotion', this.handleMotion, true);
    });
    this.motionListening = true;
  }

  private startGeo(): void {
    if (!navigator.geolocation || this.geoWatchId != null) {
      return;
    }
    this.geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.gpsLat = pos.coords.latitude;
        this.gpsLon = pos.coords.longitude;
        this.gpsAccuracyM = pos.coords.accuracy;
        this.gpsAltitudeM =
          typeof pos.coords.altitude === 'number' && Number.isFinite(pos.coords.altitude)
            ? pos.coords.altitude
            : null;
        this.gpsAltitudeAccuracyM =
          typeof pos.coords.altitudeAccuracy === 'number' && Number.isFinite(pos.coords.altitudeAccuracy)
            ? pos.coords.altitudeAccuracy
            : null;
        this.gpsHeadingDeg =
          typeof pos.coords.heading === 'number' && Number.isFinite(pos.coords.heading)
            ? this.normalizeDeg(pos.coords.heading)
            : null;
        this.gpsSpeedMs =
          typeof pos.coords.speed === 'number' && Number.isFinite(pos.coords.speed)
            ? pos.coords.speed
            : null;
        this.declinationDeg = magneticDeclinationDeg(this.gpsLat, this.gpsLon);
        this.applyDeclination();
        this.setTile('geolocation', 'live', [
          { label: 'lat', value: this.gpsLat.toFixed(5) },
          { label: 'lon', value: this.gpsLon.toFixed(5) },
          { label: '±m', value: this.fmt(this.gpsAccuracyM, 0) },
          { label: 'cap', value: this.gpsHeadingDeg == null ? '—' : `${this.gpsHeadingDeg.toFixed(0)}°` },
          { label: 'm/s', value: this.fmt(this.gpsSpeedMs, 1) }
        ]);
        this.paintBarometer();
        if (
          !this.hasMag &&
          this.headingSource !== 'webkit' &&
          this.headingSource !== 'absolute-event' &&
          this.gpsHeadingDeg != null &&
          (this.gpsSpeedMs ?? 0) > 1
        ) {
          this.publishMagHeading(this.gpsHeadingDeg, 'gps');
        }
        this.schedulePaint();
        this.maybeResolveAddressFromGps(this.gpsLat, this.gpsLon);
      },
      () => this.setTile('geolocation', 'denied', []),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
  }

  private startBattery(): void {
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<{
        level: number;
        charging: boolean;
        chargingTime: number;
        dischargingTime: number;
        addEventListener(type: string, listener: EventListener): void;
        removeEventListener(type: string, listener: EventListener): void;
      }>;
    };
    if (typeof nav.getBattery !== 'function') {
      return;
    }
    void nav.getBattery().then((b) => {
      const update = (): void => {
        this.setTile('battery', 'live', [
          { label: '%', value: `${Math.round(b.level * 100)}` },
          { label: 'charge', value: b.charging ? 'oui' : 'non' }
        ]);
        this.schedulePaint();
      };
      this.handleBattery = update;
      b.addEventListener('levelchange', update);
      b.addEventListener('chargingchange', update);
      this.batteryRef = b;
      update();
    });
  }

  private startNetwork(): void {
    const nav = navigator as Navigator & {
      connection?: {
        downlink?: number;
        rtt?: number;
        effectiveType?: string;
        type?: string;
        saveData?: boolean;
        addEventListener(type: string, listener: EventListener): void;
        removeEventListener(type: string, listener: EventListener): void;
      };
      mozConnection?: {
        downlink?: number;
        rtt?: number;
        effectiveType?: string;
        type?: string;
        saveData?: boolean;
        addEventListener(type: string, listener: EventListener): void;
        removeEventListener(type: string, listener: EventListener): void;
      };
    };
    const c = nav.connection ?? nav.mozConnection;
    if (!c) {
      return;
    }
    const update = (): void => {
      this.setTile('network', 'live', [
        { label: 'type', value: String(c.effectiveType ?? c.type ?? '—') },
        { label: 'Mb/s', value: this.fmt(c.downlink, 1) },
        { label: 'rtt', value: c.rtt != null ? `${c.rtt} ms` : '—' },
        { label: 'data', value: c.saveData ? 'éco' : 'plein' }
      ]);
      this.schedulePaint();
    };
    c.addEventListener('change', update);
    this.networkHandler = update;
    this.networkRef = c;
    update();
  }

  private startScreen(): void {
    const update = (): void => {
      const so = (screen as Screen & { orientation?: { type?: string; angle?: number } }).orientation;
      const angle =
        typeof so?.angle === 'number'
          ? so.angle
          : typeof (window as Window & { orientation?: number }).orientation === 'number'
            ? (window as Window & { orientation?: number }).orientation!
            : 0;
      this.setTile('screen', 'live', [
        { label: 'type', value: so?.type ?? '—' },
        { label: 'angle', value: `${angle}°` },
        { label: 'w×h', value: `${window.innerWidth}×${window.innerHeight}` }
      ]);
      this.schedulePaint();
    };
    this.screenHandler = update;
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    try {
      screen.orientation?.addEventListener('change', update);
    } catch {
      /* ignore */
    }
    update();
  }

  private onDeviceOrientation(e: DeviceOrientationEvent): void {
    const anyE = e as DeviceOrientationEvent & {
      webkitCompassHeading?: number;
      webkitCompassAccuracy?: number;
    };
    const rows = [
      { label: 'α', value: this.fmt(e.alpha, 1) },
      { label: 'β', value: this.fmt(e.beta, 1) },
      { label: 'γ', value: this.fmt(e.gamma, 1) },
      { label: 'abs', value: e.absolute ? 'oui' : 'non' }
    ];
    if (typeof anyE.webkitCompassHeading === 'number') {
      rows.push({ label: 'webkit', value: `${anyE.webkitCompassHeading.toFixed(1)}°` });
    }
    if (typeof anyE.webkitCompassAccuracy === 'number') {
      rows.push({ label: '±', value: `${anyE.webkitCompassAccuracy.toFixed(0)}°` });
    }
    this.setTile('device-orientation', 'live', rows);

    const beta = Number.isFinite(e.beta as number) ? (e.beta as number) : null;
    const gamma = Number.isFinite(e.gamma as number) ? (e.gamma as number) : null;
    if (!this.hasAccel && beta != null && gamma != null) {
      this.updateAttitudeFromBetaGamma(beta, gamma);
    }
    this.paintMagneticTile();
    if (this.hasMag) {
      this.schedulePaint();
      return;
    }
    if (
      typeof anyE.webkitCompassHeading === 'number' &&
      Number.isFinite(anyE.webkitCompassHeading)
    ) {
      this.publishMagHeading(
        this.normalizeDeg(anyE.webkitCompassHeading - this.screenAngle()),
        'webkit'
      );
      return;
    }
    if (
      e.alpha != null &&
      Number.isFinite(e.alpha) &&
      (e.absolute || this.orientationEventName === 'deviceorientationabsolute')
    ) {
      const heading = this.compassHeadingW3c(
        e.alpha,
        e.beta ?? 0,
        e.gamma ?? 0,
        this.screenAngle()
      );
      this.publishMagHeading(heading, 'absolute-event');
    }
  }

  private onDeviceMotion(e: DeviceMotionEvent): void {
    const a = e.accelerationIncludingGravity;
    const lin = e.acceleration;
    const r = e.rotationRate;
    const rows: { label: string; value: string }[] = [];
    if (a) {
      rows.push(
        { label: 'ax', value: this.fmt(a.x) },
        { label: 'ay', value: this.fmt(a.y) },
        { label: 'az', value: this.fmt(a.z) }
      );
      if (!this.accelFromGeneric && a.x != null && a.y != null && a.z != null) {
        this.accel = { x: a.x, y: a.y, z: a.z };
        this.hasAccel = true;
        this.northEngine.accel = this.accel;
        this.northEngine.hasAccel = true;
        this.updateAttitudeFromAccel();
        this.setTile('accelerometer', 'live', this.accelRows(a.x, a.y, a.z));
      }
    }
    if (lin) {
      rows.push(
        { label: 'lx', value: this.fmt(lin.x) },
        { label: 'ly', value: this.fmt(lin.y) },
        { label: 'lz', value: this.fmt(lin.z) }
      );
    }
    if (r) {
      rows.push(
        { label: 'ωα', value: this.fmt(r.alpha, 1) },
        { label: 'ωβ', value: this.fmt(r.beta, 1) },
        { label: 'ωγ', value: this.fmt(r.gamma, 1) }
      );
      if (!this.hasGyro && r.alpha != null && r.beta != null && r.gamma != null) {
        const k = Math.PI / 180;
        this.gyro = { x: r.beta * k, y: r.gamma * k, z: r.alpha * k };
        this.hasGyro = true;
        this.northEngine.gyro = this.gyro;
        this.northEngine.hasGyro = true;
        if (!this.gyroFromGeneric) {
          this.setTile('gyroscope', 'live', this.gyroRows(r.beta * k, r.gamma * k, r.alpha * k), 'NORD.S_OIS_NOTE');
        }
        this.tickFusion();
      }
    }
    this.setTile('device-motion', 'live', rows);
    this.schedulePaint();
  }

  private onMagSample(x: number, y: number, z: number): void {
    this.magRaw = { x, y, z };
    this.northEngine.accel = this.accel;
    const c = this.northEngine.correctMag(x, y, z);
    this.magFieldUt = Math.hypot(c.x, c.y, c.z);
    if (this.calPhase === 'figure8' && this.northEngine.ingestFigure8Mag(x, y, z)) {
      this.beginSettle();
    }
    const heading =
      this.northEngine.headingFromMagAccel(c.x, c.y, c.z, this.screenAngle()) ??
      this.headingFromMagFlat(c.x, c.y);
    if (heading != null) {
      this.publishMagHeading(heading, 'magnetometer');
    } else {
      this.paintMagneticTile();
    }
  }

  private beginSettle(): void {
    if (this.northEngine.calPhase === 'settle') {
      return;
    }
    this.headingSamples = [];
    this.northEngine.beginSettle(() => this.lockNorth(), () => this.schedulePaint());
  }

  private lockNorth(): void {
    this.persist();
    this.schedulePaint();
  }

  private publishMagHeading(raw: number, source: HeadingSource): void {
    const corrected = this.normalizeDeg(raw + this.northOffsetDeg);
    this.headingSource = source;
    this.headingMagDeg = this.northEngine.fuseMagHeading(corrected, this.calibrated);
    this.pushStability(this.headingMagDeg);
    this.applyDeclination();
    this.paintMagneticTile();
    if (this.calPhase === 'figure8' && !this.hasMag) {
      if (this.northEngine.ingestFigure8Heading(this.headingMagDeg)) {
        this.beginSettle();
      }
    }
    this.schedulePaint();
  }

  private tickFusion(): void {
    this.northEngine.accel = this.accel;
    this.northEngine.gyro = this.gyro;
    this.northEngine.hasGyro = this.hasGyro;
    const fused = this.northEngine.tickGyro(this.calibrated);
    if (fused == null) {
      return;
    }
    this.headingMagDeg = fused;
    this.applyDeclination();
    this.schedulePaint();
  }

  private applyDeclination(): void {
    if (this.headingMagDeg == null || this.declinationDeg == null) {
      this.headingTrueDeg = null;
      this.syncRose();
      return;
    }
    this.headingTrueDeg = this.normalizeDeg(this.headingMagDeg + this.declinationDeg);
    this.syncRose();
  }

  private maybeResolveAddressFromGps(lat: number, lon: number): void {
    const now = Date.now();
    const moved =
      this.lastAddressLat == null ||
      this.lastAddressLon == null ||
      Math.abs(lat - this.lastAddressLat) > 0.002 ||
      Math.abs(lon - this.lastAddressLon) > 0.002;
    if (!moved && this.addressLabel && now - this.lastAddressAtMs < 45000) {
      return;
    }
    if (!moved && this.addressLabel) {
      return;
    }
    this.resolveAddress(lat, lon);
  }

  private resolveAddress(lat: number, lon: number): void {
    this.lastAddressLat = lat;
    this.lastAddressLon = lon;
    this.lastAddressAtMs = Date.now();
    this.addressBusy = true;
    this.addressError = null;
    this.reverseGeocodeSub?.unsubscribe();
    this.reverseGeocodeSub = this.api.geocodeReverse(lat, lon).subscribe({
      next: (res: { display_name?: string; displayName?: string }) => {
        const name = String(res?.display_name || res?.displayName || '').trim();
        this.addressLabel = name || null;
        this.addressBusy = false;
        if (!name) {
          this.addressError = 'NORD.ADDRESS_NOT_FOUND';
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.addressBusy = false;
        this.addressError = 'NORD.ADDRESS_ERROR';
        this.cdr.markForCheck();
      }
    });
  }

  /**
   * Angle CSS continu : on n’écrit jamais 359→0, sinon la transition (ou le navigateur)
   * interpolait un tour complet au passage du N sous la flèche.
   */
  private syncRose(): void {
    const h = this.displayedHeading();
    if (h == null) {
      return;
    }
    this.northEngine.unwrapRose(h);
  }

  private updateAttitudeFromAccel(): void {
    const up = this.normalizeVec(this.accel.x, this.accel.y, this.accel.z);
    if (!up) {
      return;
    }
    const sa = ((this.screenAngle() % 360) + 360) % 360;
    let topX = 0;
    let topY = 1;
    if (sa === 90) {
      topX = 1;
      topY = 0;
    } else if (sa === 180) {
      topX = 0;
      topY = -1;
    } else if (sa === 270) {
      topX = -1;
      topY = 0;
    }
    const topDotUp = topX * up.x + topY * up.y;
    const pitch = (Math.atan2(topDotUp, up.z) * 180) / Math.PI;
    const rightX = topY;
    const rightY = -topX;
    const roll = (Math.atan2(rightX * up.x + rightY * up.y, up.z) * 180) / Math.PI;
    this.smoothAttitude(pitch, roll);
  }

  private updateAttitudeFromBetaGamma(betaDeg: number, gammaDeg: number): void {
    this.smoothAttitude(betaDeg, gammaDeg);
  }

  private smoothAttitude(pitch: number, roll: number): void {
    const a = 0.28;
    this.pitchDeg = this.pitchDeg == null ? pitch : this.pitchDeg * (1 - a) + pitch * a;
    this.rollDeg = this.rollDeg == null ? roll : this.rollDeg * (1 - a) + roll * a;
  }

  private headingFromQuaternion(q: ReadonlyArray<number>): number | null {
    if (q.length < 4) {
      return null;
    }
    const [x, y, z, w] = q;
    const east = 2 * (x * y - z * w) - 2 * (x * z + y * w);
    const north = 1 - 2 * (x * x + z * z) - 2 * (y * z - x * w);
    if (east * east + north * north < 1e-8) {
      return null;
    }
    return this.normalizeDeg((Math.atan2(east, north) * 180) / Math.PI);
  }

  private compassHeadingW3c(
    alphaDeg: number,
    betaDeg: number,
    gammaDeg: number,
    screenAngleDeg: number
  ): number {
    if (Math.abs(betaDeg) < 12 && Math.abs(gammaDeg) < 12) {
      return this.normalizeDeg(360 - alphaDeg - screenAngleDeg);
    }
    const d2r = Math.PI / 180;
    const x = betaDeg * d2r;
    const y = gammaDeg * d2r;
    const z = alphaDeg * d2r;
    const cX = Math.cos(x);
    const cY = Math.cos(y);
    const cZ = Math.cos(z);
    const sX = Math.sin(x);
    const sY = Math.sin(y);
    const sZ = Math.sin(z);
    const vx = -cZ * sY - sZ * sX * cY;
    const vy = -sZ * sY + cZ * sX * cY;
    if (vx * vx + vy * vy < 1e-10) {
      return this.normalizeDeg(360 - alphaDeg - screenAngleDeg);
    }
    let heading = Math.atan(vx / vy);
    if (vy < 0) {
      heading += Math.PI;
    } else if (vx < 0) {
      heading += 2 * Math.PI;
    }
    return this.normalizeDeg((heading * 180) / Math.PI - screenAngleDeg);
  }

  private pushStability(heading: number): void {
    this.headingSamples.push(heading);
    while (this.headingSamples.length > STABILITY_WINDOW) {
      this.headingSamples.shift();
    }
    if (this.headingSamples.length < 8) {
      this.stabilityDeg = null;
      return;
    }
    const mean = this.circularMean(this.headingSamples);
    let acc = 0;
    for (const s of this.headingSamples) {
      const d = this.circularDiff(s, mean);
      acc += d * d;
    }
    this.stabilityDeg = Math.sqrt(acc / this.headingSamples.length);
  }

  private screenAngle(): number {
    try {
      const so = (screen as Screen & { orientation?: { angle?: number } }).orientation;
      if (typeof so?.angle === 'number') {
        return so.angle;
      }
    } catch {
      /* ignore */
    }
    const wo = (window as Window & { orientation?: number }).orientation;
    return typeof wo === 'number' ? wo : 0;
  }

  private persist(): void {
    this.northEngine.persistShared(this.northOffsetDeg, this.trueNorth);
  }

  private loadPersisted(): void {
    const loaded = this.northEngine.loadShared();
    this.northOffsetDeg = loaded.northOffsetDeg;
    this.trueNorth = loaded.trueNorth;
  }

  private stopAll(): void {
    this.northEngine.destroy();
    this.reverseGeocodeSub?.unsubscribe();
    this.reverseGeocodeSub = null;
    for (const s of this.liveSensors) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    this.liveSensors = [];
    if (this.orientationListening && this.orientationEventName) {
      window.removeEventListener(this.orientationEventName, this.handleOrientation, true);
    }
    this.orientationListening = false;
    if (this.motionListening) {
      window.removeEventListener('devicemotion', this.handleMotion, true);
    }
    this.motionListening = false;
    if (this.geoWatchId != null) {
      navigator.geolocation.clearWatch(this.geoWatchId);
      this.geoWatchId = null;
    }
    if (this.screenHandler) {
      window.removeEventListener('resize', this.screenHandler);
      window.removeEventListener('orientationchange', this.screenHandler);
      try {
        screen.orientation?.removeEventListener('change', this.screenHandler);
      } catch {
        /* ignore */
      }
      this.screenHandler = null;
    }
    if (this.batteryRef) {
      try {
        this.batteryRef.removeEventListener('levelchange', this.handleBattery);
        this.batteryRef.removeEventListener('chargingchange', this.handleBattery);
      } catch {
        /* ignore */
      }
      this.batteryRef = null;
    }
    if (this.networkRef && this.networkHandler) {
      try {
        this.networkRef.removeEventListener('change', this.networkHandler);
      } catch {
        /* ignore */
      }
      this.networkRef = null;
      this.networkHandler = null;
    }
    window.removeEventListener('devicelight', this.handleDeviceLight);
    window.removeEventListener('deviceproximity', this.handleDeviceProximity);
    window.removeEventListener('userproximity', this.handleDeviceProximity);
  }

  private schedulePaint(): void {
    const now = performance.now();
    if (now - this.lastPaintMs < PAINT_MIN_MS) {
      return;
    }
    this.lastPaintMs = now;
    this.zone.run(() => this.cdr.markForCheck());
  }

  private xyzRows(x: number, y: number, z: number, unit: string): { label: string; value: string }[] {
    return [
      { label: 'x', value: `${this.fmt(x)} ${unit}` },
      { label: 'y', value: `${this.fmt(y)} ${unit}` },
      { label: 'z', value: `${this.fmt(z)} ${unit}` },
      { label: '|v|', value: `${Math.hypot(x, y, z).toFixed(1)} ${unit}` }
    ];
  }

  private accelRows(x: number, y: number, z: number): { label: string; value: string }[] {
    const xAng = (Math.atan2(x, Math.hypot(y, z)) * 180) / Math.PI;
    const yAng = (Math.atan2(y, Math.hypot(x, z)) * 180) / Math.PI;
    const zAng = (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI;
    return [
      ...this.xyzRows(x, y, z, 'm/s²'),
      { label: 'x-angle', value: `${xAng.toFixed(0)}°` },
      { label: 'y-angle', value: `${yAng.toFixed(0)}°` },
      { label: 'z-angle', value: `${zAng.toFixed(0)}°` }
    ];
  }

  private gyroRows(x: number, y: number, z: number): { label: string; value: string }[] {
    return [
      { label: 'Y', value: `${this.fmt(z)} rad/s` },
      { label: 'P', value: `${this.fmt(x)} rad/s` },
      { label: 'R', value: `${this.fmt(y)} rad/s` },
      { label: 'ωx', value: `${this.fmt(x)} rad/s` },
      { label: 'ωy', value: `${this.fmt(y)} rad/s` },
      { label: 'ωz', value: `${this.fmt(z)} rad/s` },
      { label: 'OIS', value: '—' }
    ];
  }

  private headingFromMagFlat(mx: number, my: number): number | null {
    if (mx * mx + my * my < 16) {
      return null;
    }
    return this.normalizeDeg((Math.atan2(-mx, my) * 180) / Math.PI - this.screenAngle());
  }

  private paintMagneticTile(): void {
    const t = this.tile('magnetometer');
    const rows: { label: string; value: string }[] = this.magRaw
      ? this.xyzRows(this.magRaw.x, this.magRaw.y, this.magRaw.z, 'µT')
      : [
          { label: 'x', value: '—' },
          { label: 'y', value: '—' },
          { label: 'z', value: '—' }
        ];
    const az = this.headingMagDeg;
    rows.push(
      { label: 'azimut', value: az == null ? '—' : `${az.toFixed(2)}°` },
      { label: 'pitch', value: this.pitchDeg == null ? '—' : `${this.pitchDeg.toFixed(2)}°` },
      { label: 'roll', value: this.rollDeg == null ? '—' : `${this.rollDeg.toFixed(2)}°` }
    );
    const live = this.hasMag || az != null;
    t.drivesNorth = this.usesMagneticNorth;
    this.setTile(
      'magnetometer',
      live ? 'live' : t.status,
      rows,
      this.hasMag ? 'NORD.S_MAG_NOTE' : 'NORD.S_MAG_NOTE_OS'
    );
  }

  private paintBarometer(): void {
    const rows: { label: string; value: string }[] = [
      { label: 'hPa', value: this.baroHpa == null ? '—' : this.baroHpa.toFixed(2) },
      {
        label: 'altitude',
        value: this.gpsAltitudeM == null ? '—' : `${this.gpsAltitudeM.toFixed(1)} m`
      }
    ];
    if (this.gpsAltitudeAccuracyM != null) {
      rows.push({ label: '±m', value: this.fmt(this.gpsAltitudeAccuracyM, 0) });
    }
    const live = this.baroHpa != null || this.gpsAltitudeM != null;
    this.setTile('barometer', live ? 'live' : 'idle', rows, 'NORD.S_BARO_NOTE');
  }

  private paintProxyLight(): void {
    const rows: { label: string; value: string }[] = [
      { label: 'prox', value: this.proxNear == null ? '—' : this.proxNear ? 'près' : 'loin' },
      {
        label: 'dist',
        value: this.proxDistance == null ? '—' : `${this.fmt(this.proxDistance, 2)} m`
      },
      { label: 'lux', value: this.lightLux == null ? '—' : this.fmt(this.lightLux, 0) }
    ];
    const live = this.proxNear != null || this.proxDistance != null || this.lightLux != null;
    this.setTile('proxy-light', live ? 'live' : 'idle', rows, 'NORD.S_PROXY_LIGHT_NOTE');
  }

  private fmt(n: number | null | undefined, digits = 2): string {
    return n == null || !Number.isFinite(n) ? '—' : n.toFixed(digits);
  }

  private normalizeDeg(deg: number): number {
    let d = deg % 360;
    if (d < 0) {
      d += 360;
    }
    return d;
  }

  private circularDiff(a: number, b: number): number {
    return ((((a - b) % 360) + 540) % 360) - 180;
  }

  private circularMean(degrees: number[]): number {
    let x = 0;
    let y = 0;
    for (const d of degrees) {
      const r = (d * Math.PI) / 180;
      x += Math.cos(r);
      y += Math.sin(r);
    }
    return this.normalizeDeg((Math.atan2(y, x) * 180) / Math.PI);
  }

  private normalizeVec(
    x: number,
    y: number,
    z: number
  ): { x: number; y: number; z: number } | null {
    const n = Math.hypot(x, y, z);
    if (n < 1e-8) {
      return null;
    }
    return { x: x / n, y: y / n, z: z / n };
  }

}
