import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  NgZone,
  OnDestroy,
  OnInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { ApiService } from '../services/api.service';
import { magneticDeclinationDeg } from './magnetic-declination';

const STORAGE_KEY = 'pat.nord.calibration.v1';
const PAINT_MIN_MS = 50;
const MAG_HZ = 50;
const FUSION_GYRO_LOCKED = 0.97;
const FUSION_GYRO_LIVE = 0.82;
const FIGURE8_MIN_SAMPLES = 80;
const FIGURE8_MIN_SPAN_UT = 18;
const SETTLE_MS = 1800;
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
}

interface MagBias {
  x: number;
  y: number;
  z: number;
}

interface MagScale {
  x: number;
  y: number;
  z: number;
}

interface PersistedNord {
  bias: MagBias;
  scale: MagScale;
  northOffsetDeg: number;
  trueNorth: boolean;
  calibratedAt: string;
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
}

@Component({
  selector: 'app-nord',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './nord.component.html',
  styleUrls: ['./nord.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class NordComponent implements OnInit, OnDestroy {
  sensorsEnabled = false;
  permissionDenied = false;
  permissionNeeded = false;

  headingMagDeg: number | null = null;
  headingTrueDeg: number | null = null;
  headingSource: HeadingSource | null = null;
  /** 0° = à plat (écran vers le ciel), 90° = vertical. */
  pitchDeg: number | null = null;
  /** Roulis, 0° = pas de bascule gauche/droite. */
  rollDeg: number | null = null;
  northOffsetDeg = 0;
  trueNorth = true;
  declinationDeg: number | null = null;
  calibrated = false;
  calibratedAt: string | null = null;

  calPhase: CalPhase = 'idle';
  calProgressPct = 0;
  calOctants = 0;
  calSpanUt = 0;
  settleRemainMs = SETTLE_MS;

  magFieldUt: number | null = null;
  stabilityDeg: number | null = null;
  gpsLat: number | null = null;
  gpsLon: number | null = null;
  gpsAccuracyM: number | null = null;
  gpsHeadingDeg: number | null = null;
  gpsSpeedMs: number | null = null;
  addressLabel: string | null = null;
  addressBusy = false;
  addressError: string | null = null;

  tiles: SensorTile[] = NordComponent.initialTiles();

  /** Pas de 0/90/180/270 : les lettres N/E/S/O occupent déjà ces positions. */
  readonly bezelDegrees = [30, 60, 120, 150, 210, 240, 300, 330];
  readonly octantBits = [0, 1, 2, 3, 4, 5, 6, 7];

  private octantMask = 0;
  private bias: MagBias = { x: 0, y: 0, z: 0 };
  private scale: MagScale = { x: 1, y: 1, z: 1 };
  private magMin = { x: Infinity, y: Infinity, z: Infinity };
  private magMax = { x: -Infinity, y: -Infinity, z: -Infinity };
  private magSamples = 0;
  private figure8Headings: number[] = [];

  private fusedHeading: number | null = null;
  private roseUnwrappedDeg = 0;
  private roseInited = false;
  private lastFusionTs: number | null = null;
  private headingSamples: number[] = [];
  private lastPaintMs = 0;

  private accel = { x: 0, y: 0, z: 9.81 };
  private gyro = { x: 0, y: 0, z: 0 };
  private hasAccel = false;
  private accelFromGeneric = false;
  private hasGyro = false;
  private hasMag = false;

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
  private settleTimer: ReturnType<typeof setInterval> | null = null;
  private reverseGeocodeSub: Subscription | null = null;
  private lastAddressLat: number | null = null;
  private lastAddressLon: number | null = null;
  private lastAddressAtMs = 0;
  private handleOrientation = (e: DeviceOrientationEvent): void => this.onDeviceOrientation(e);
  private handleMotion = (e: DeviceMotionEvent): void => this.onDeviceMotion(e);
  private handleBattery = (): void => {
    /* bound later */
  };

  constructor(
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef,
    private readonly api: ApiService
  ) {}

  ngOnInit(): void {
    this.loadPersisted();
    this.probeUnsupported();
    void this.startAll(false);
  }

  ngOnDestroy(): void {
    this.stopAll();
  }

  async enableSensors(): Promise<void> {
    this.permissionNeeded = false;
    this.permissionDenied = false;
    await this.startAll(true);
  }

  startCalibration(): void {
    this.calPhase = 'figure8';
    this.calProgressPct = 0;
    this.calOctants = 0;
    this.calSpanUt = 0;
    this.octantMask = 0;
    this.magSamples = 0;
    this.figure8Headings = [];
    this.magMin = { x: Infinity, y: Infinity, z: Infinity };
    this.magMax = { x: -Infinity, y: -Infinity, z: -Infinity };
    this.calibrated = false;
    this.northOffsetDeg = 0;
    this.clearSettleTimer();
  }

  resetCalibration(): void {
    this.calPhase = 'idle';
    this.calibrated = false;
    this.calibratedAt = null;
    this.northOffsetDeg = 0;
    this.bias = { x: 0, y: 0, z: 0 };
    this.scale = { x: 1, y: 1, z: 1 };
    this.octantMask = 0;
    this.fusedHeading = null;
    this.roseInited = false;
    this.clearSettleTimer();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
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
    this.trueNorth = !this.trueNorth;
    this.persist();
    this.applyDeclination();
  }

  roseRotationDeg(): number {
    return this.roseUnwrappedDeg;
  }

  displayedHeading(): number | null {
    return this.trueNorth ? this.headingTrueDeg : this.headingMagDeg;
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

  octantOn(bit: number): boolean {
    return (this.octantMask & (1 << bit)) !== 0;
  }

  headingText(): string {
    const h = this.displayedHeading();
    if (h == null) {
      return '—';
    }
    return String(((Math.round(h) % 360) + 360) % 360);
  }

  pitchText(): string {
    return this.pitchDeg == null ? '—' : `${this.pitchDeg.toFixed(0)}°`;
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

  pitchGaugePercent(): number {
    if (this.pitchDeg == null) {
      return 0;
    }
    return Math.max(0, Math.min(100, (Math.min(Math.abs(this.pitchDeg), 90) / 90) * 100));
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
    const abs = Math.abs(d).toFixed(1);
    return d >= 0 ? `${abs}° E` : `${abs}° W`;
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
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW'
  ];

  private static initialTiles(): SensorTile[] {
    const ids: { id: string; labelKey: string }[] = [
      { id: 'magnetometer', labelKey: 'NORD.S_MAG' },
      { id: 'accelerometer', labelKey: 'NORD.S_ACCEL' },
      { id: 'gravity', labelKey: 'NORD.S_GRAVITY' },
      { id: 'linear-accel', labelKey: 'NORD.S_LINEAR' },
      { id: 'gyroscope', labelKey: 'NORD.S_GYRO' },
      { id: 'abs-orient', labelKey: 'NORD.S_ABS' },
      { id: 'rel-orient', labelKey: 'NORD.S_REL' },
      { id: 'ambient-light', labelKey: 'NORD.S_LIGHT' },
      { id: 'device-orientation', labelKey: 'NORD.S_DO' },
      { id: 'device-motion', labelKey: 'NORD.S_DM' },
      { id: 'geolocation', labelKey: 'NORD.S_GPS' },
      { id: 'battery', labelKey: 'NORD.S_BATTERY' },
      { id: 'network', labelKey: 'NORD.S_NET' },
      { id: 'screen', labelKey: 'NORD.S_SCREEN' },
      { id: 'proximity', labelKey: 'NORD.S_PROX' }
    ];
    return ids.map((s) => ({ ...s, status: 'idle', rows: [] }));
  }

  private tile(id: string): SensorTile {
    return this.tiles.find((t) => t.id === id)!;
  }

  private setTile(
    id: string,
    status: SensorStatus,
    rows: { label: string; value: string }[]
  ): void {
    const t = this.tile(id);
    t.status = status;
    t.rows = rows;
  }

  private probeUnsupported(): void {
    const w = window as unknown as Record<string, unknown>;
    const map: { id: string; ctor: string }[] = [
      { id: 'magnetometer', ctor: 'Magnetometer' },
      { id: 'accelerometer', ctor: 'Accelerometer' },
      { id: 'gravity', ctor: 'GravitySensor' },
      { id: 'linear-accel', ctor: 'LinearAccelerationSensor' },
      { id: 'gyroscope', ctor: 'Gyroscope' },
      { id: 'abs-orient', ctor: 'AbsoluteOrientationSensor' },
      { id: 'rel-orient', ctor: 'RelativeOrientationSensor' },
      { id: 'ambient-light', ctor: 'AmbientLightSensor' }
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
    this.setTile('proximity', 'unsupported', []);
  }

  private async startAll(fromUserGesture: boolean): Promise<void> {
    const doe = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    const dme = window.DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    if (typeof doe?.requestPermission === 'function') {
      if (!fromUserGesture) {
        this.permissionNeeded = true;
        this.cdr.markForCheck();
        return;
      }
      try {
        const ori = await doe.requestPermission();
        if (ori !== 'granted') {
          this.permissionDenied = true;
          this.cdr.markForCheck();
          return;
        }
        if (typeof dme?.requestPermission === 'function') {
          try {
            await dme.requestPermission();
          } catch {
            /* optional */
          }
        }
      } catch {
        this.permissionDenied = true;
        this.cdr.markForCheck();
        return;
      }
    }

    this.sensorsEnabled = true;
    this.startGenericSensors();
    this.startOrientation();
    this.startMotion();
    this.startGeo();
    this.startBattery();
    this.startNetwork();
    this.startScreen();
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
        this.onMagSample(x, y, z);
        this.setTile('magnetometer', 'live', this.xyzRows(x, y, z, 'µT'));
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
        this.updateAttitudeFromAccel();
        this.setTile('accelerometer', 'live', this.xyzRows(x, y, z, 'm/s²'));
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
        this.setTile('gyroscope', 'live', this.xyzRows(x, y, z, 'rad/s'));
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
      'ambient-light',
      w['AmbientLightSensor'] as (new (opts: { frequency: number }) => GenericSensorLike) | undefined,
      (s) => {
        this.setTile('ambient-light', 'live', [
          { label: 'lux', value: this.fmt(s.illuminance, 0) }
        ]);
      }
    );
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
      const error = (): void => {
        this.setTile(id, 'error', []);
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
        this.updateAttitudeFromAccel();
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
        this.tickFusion();
      }
    }
    this.setTile('device-motion', 'live', rows);
    this.schedulePaint();
  }

  private onMagSample(x: number, y: number, z: number): void {
    const c = this.correctMag(x, y, z);
    this.magFieldUt = Math.hypot(c.x, c.y, c.z);
    if (this.calPhase === 'figure8') {
      this.ingestFigure8(x, y, z);
    }
    const heading = this.headingFromMagAccel(c.x, c.y, c.z, this.accel.x, this.accel.y, this.accel.z);
    if (heading != null) {
      this.publishMagHeading(heading, 'magnetometer');
    }
  }

  private ingestFigure8(x: number, y: number, z: number): void {
    this.magSamples++;
    this.magMin.x = Math.min(this.magMin.x, x);
    this.magMin.y = Math.min(this.magMin.y, y);
    this.magMin.z = Math.min(this.magMin.z, z);
    this.magMax.x = Math.max(this.magMax.x, x);
    this.magMax.y = Math.max(this.magMax.y, y);
    this.magMax.z = Math.max(this.magMax.z, z);
    const bit = (x >= 0 ? 1 : 0) | (y >= 0 ? 2 : 0) | (z >= 0 ? 4 : 0);
    this.octantMask |= 1 << bit;
    const spanX = this.magMax.x - this.magMin.x;
    const spanY = this.magMax.y - this.magMin.y;
    const spanZ = this.magMax.z - this.magMin.z;
    this.calSpanUt = Math.min(spanX, spanY, spanZ);
    this.calOctants = this.popcount(this.octantMask);
    const cover = this.calOctants / 8;
    const spanScore = Math.min(1, this.calSpanUt / FIGURE8_MIN_SPAN_UT);
    const nScore = Math.min(1, this.magSamples / FIGURE8_MIN_SAMPLES);
    this.calProgressPct = Math.round(100 * (0.45 * cover + 0.35 * spanScore + 0.2 * nScore));
    if (this.calOctants >= 6 && this.calSpanUt >= FIGURE8_MIN_SPAN_UT && this.magSamples >= FIGURE8_MIN_SAMPLES) {
      this.finishFigure8();
    }
  }

  private advanceFigure8WithoutMag(): void {
    if (this.headingMagDeg == null) {
      return;
    }
    this.figure8Headings.push(this.headingMagDeg);
    const bins = new Set(this.figure8Headings.map((h) => Math.floor(h / 45) % 8));
    this.calOctants = bins.size;
    this.octantMask = 0;
    for (const b of bins) {
      this.octantMask |= 1 << b;
    }
    this.magSamples = this.figure8Headings.length;
    this.calSpanUt = 0;
    const cover = this.calOctants / 8;
    const nScore = Math.min(1, this.magSamples / FIGURE8_MIN_SAMPLES);
    this.calProgressPct = Math.round(100 * (0.6 * cover + 0.4 * nScore));
    if (this.calOctants >= 6 && this.magSamples >= FIGURE8_MIN_SAMPLES) {
      this.beginSettle();
    }
  }

  private finishFigure8(): void {
    this.bias = {
      x: (this.magMax.x + this.magMin.x) / 2,
      y: (this.magMax.y + this.magMin.y) / 2,
      z: (this.magMax.z + this.magMin.z) / 2
    };
    const sx = (this.magMax.x - this.magMin.x) / 2;
    const sy = (this.magMax.y - this.magMin.y) / 2;
    const sz = (this.magMax.z - this.magMin.z) / 2;
    const avg = (sx + sy + sz) / 3;
    this.scale = {
      x: avg / Math.max(sx, 1e-3),
      y: avg / Math.max(sy, 1e-3),
      z: avg / Math.max(sz, 1e-3)
    };
    this.beginSettle();
  }

  private beginSettle(): void {
    this.calPhase = 'settle';
    this.calProgressPct = 100;
    this.settleRemainMs = SETTLE_MS;
    this.headingSamples = [];
    this.clearSettleTimer();
    const started = Date.now();
    this.settleTimer = setInterval(() => {
      const left = SETTLE_MS - (Date.now() - started);
      this.settleRemainMs = Math.max(0, left);
      if (left <= 0) {
        this.clearSettleTimer();
        this.lockNorth();
      }
      this.schedulePaint();
    }, 80);
  }

  private lockNorth(): void {
    this.northOffsetDeg = 0;
    this.calibrated = true;
    this.calibratedAt = new Date().toISOString();
    this.calPhase = 'done';
    this.persist();
  }

  private publishMagHeading(raw: number, source: HeadingSource): void {
    const corrected = this.normalizeDeg(raw + this.northOffsetDeg);
    this.headingSource = source;
    if (this.fusedHeading == null || !this.hasGyro) {
      this.fusedHeading = corrected;
    } else {
      const a = this.calibrated ? 1 - FUSION_GYRO_LOCKED : 1 - FUSION_GYRO_LIVE;
      this.fusedHeading = this.circularLerp(this.fusedHeading, corrected, a);
    }
    this.headingMagDeg = this.fusedHeading;
    this.pushStability(this.headingMagDeg);
    this.applyDeclination();
    if (this.calPhase === 'figure8' && !this.hasMag) {
      this.advanceFigure8WithoutMag();
    }
    this.schedulePaint();
  }

  private tickFusion(): void {
    if (this.fusedHeading == null || !this.hasGyro) {
      return;
    }
    const now = performance.now();
    if (this.lastFusionTs == null) {
      this.lastFusionTs = now;
      return;
    }
    const dt = Math.min(0.08, (now - this.lastFusionTs) / 1000);
    this.lastFusionTs = now;
    const up = this.normalizeVec(this.accel.x, this.accel.y, this.accel.z);
    if (!up) {
      return;
    }
    const yawRate = -(this.gyro.x * up.x + this.gyro.y * up.y + this.gyro.z * up.z);
    const gyroDeg = (yawRate * 180) / Math.PI;
    this.fusedHeading = this.normalizeDeg(this.fusedHeading + gyroDeg * dt);
    this.headingMagDeg = this.fusedHeading;
    this.applyDeclination();
    this.schedulePaint();
  }

  private applyDeclination(): void {
    if (this.headingMagDeg == null) {
      this.headingTrueDeg = null;
      return;
    }
    const d = this.declinationDeg ?? 0;
    this.headingTrueDeg = this.normalizeDeg(this.headingMagDeg + d);
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
    const target = this.normalizeDeg(-h);
    if (!this.roseInited) {
      this.roseUnwrappedDeg = -h;
      this.roseInited = true;
      return;
    }
    const current = this.normalizeDeg(this.roseUnwrappedDeg);
    this.roseUnwrappedDeg += this.circularDiff(target, current);
  }

  private updateAttitudeFromAccel(): void {
    const up = this.normalizeVec(this.accel.x, this.accel.y, this.accel.z);
    if (!up) {
      return;
    }
    const z = Math.max(-1, Math.min(1, up.z));
    const skyEl = (Math.asin(z) * 180) / Math.PI;
    const pitch = 90 - skyEl;
    const roll = (Math.atan2(up.x, Math.hypot(up.y, up.z)) * 180) / Math.PI;
    this.smoothAttitude(pitch, roll);
  }

  private updateAttitudeFromBetaGamma(betaDeg: number, gammaDeg: number): void {
    const b = (betaDeg * Math.PI) / 180;
    const g = (gammaDeg * Math.PI) / 180;
    const upZ = Math.cos(b) * Math.cos(g);
    const skyEl = (Math.asin(Math.max(-1, Math.min(1, upZ))) * 180) / Math.PI;
    this.smoothAttitude(90 - skyEl, gammaDeg);
  }

  private smoothAttitude(pitch: number, roll: number): void {
    const a = 0.28;
    this.pitchDeg = this.pitchDeg == null ? pitch : this.pitchDeg * (1 - a) + pitch * a;
    this.rollDeg = this.rollDeg == null ? roll : this.rollDeg * (1 - a) + roll * a;
  }

  private headingFromMagAccel(
    mx: number,
    my: number,
    mz: number,
    ax: number,
    ay: number,
    az: number
  ): number | null {
    const up = this.normalizeVec(ax, ay, az);
    if (!up) {
      return null;
    }
    const east = this.normalizeVec(
      up.y * mz - up.z * my,
      up.z * mx - up.x * mz,
      up.x * my - up.y * mx
    );
    if (!east) {
      return null;
    }
    const north = {
      x: up.y * east.z - up.z * east.y,
      y: up.z * east.x - up.x * east.z,
      z: up.x * east.y - up.y * east.x
    };
    const flat = Math.abs(up.z) >= Math.abs(up.y);
    const nx = flat ? 0 : 0;
    const ny = flat ? 1 : 0;
    const nz = flat ? 0 : -1;
    const d = nx * up.x + ny * up.y + nz * up.z;
    const hx = nx - up.x * d;
    const hy = ny - up.y * d;
    const hz = nz - up.z * d;
    const heading =
      (Math.atan2(hx * east.x + hy * east.y + hz * east.z, hx * north.x + hy * north.y + hz * north.z) *
        180) /
      Math.PI;
    return this.normalizeDeg(heading - this.screenAngle());
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

  private correctMag(x: number, y: number, z: number): MagBias {
    return {
      x: (x - this.bias.x) * this.scale.x,
      y: (y - this.bias.y) * this.scale.y,
      z: (z - this.bias.z) * this.scale.z
    };
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
    const payload: PersistedNord = {
      bias: this.bias,
      scale: this.scale,
      northOffsetDeg: this.northOffsetDeg,
      trueNorth: this.trueNorth,
      calibratedAt: this.calibratedAt ?? new Date().toISOString()
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }

  private loadPersisted(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }
      const data = JSON.parse(raw) as PersistedNord;
      if (data.bias) {
        this.bias = data.bias;
      }
      if (data.scale) {
        this.scale = data.scale;
      }
      this.northOffsetDeg = Number.isFinite(data.northOffsetDeg) ? data.northOffsetDeg : 0;
      this.trueNorth = data.trueNorth !== false;
      if (data.calibratedAt) {
        this.calibrated = true;
        this.calibratedAt = data.calibratedAt;
        this.calPhase = 'done';
      }
    } catch {
      /* ignore */
    }
  }

  private stopAll(): void {
    this.clearSettleTimer();
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
  }

  private clearSettleTimer(): void {
    if (this.settleTimer != null) {
      clearInterval(this.settleTimer);
      this.settleTimer = null;
    }
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

  private circularLerp(fromDeg: number, toDeg: number, t: number): number {
    const f = (fromDeg * Math.PI) / 180;
    const to = (toDeg * Math.PI) / 180;
    const x = Math.cos(f) * (1 - t) + Math.cos(to) * t;
    const y = Math.sin(f) * (1 - t) + Math.sin(to) * t;
    return this.normalizeDeg((Math.atan2(y, x) * 180) / Math.PI);
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

  private popcount(mask: number): number {
    let n = 0;
    let m = mask;
    while (m) {
      n += m & 1;
      m >>= 1;
    }
    return n;
  }
}
