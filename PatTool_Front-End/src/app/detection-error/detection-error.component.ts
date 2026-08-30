import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  NgZone,
  OnDestroy,
  OnInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { CameraLookTracker } from '../direction/camera-look-tracker';
import { circularDiff, normalizeDeg } from '../direction/direction-attitude';
import { magneticDeclinationDeg } from '../nord/magnetic-declination';
import { CompassRoseComponent } from '../shared/compass-rose/compass-rose.component';
import { loadSharedTrueNorth } from '../shared/compass-north.engine';

const DIR_AWAY_DEG = 40;
const EL_AWAY_DEG = 18;
const OK_DEG = 2;
const WARN_DEG = 8;
const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

type AxisKind = 'direction' | 'elevation';
type AxisPhase = 'idle' | 'turn' | 'return' | 'done';
type Verdict = 'ok' | 'warn' | 'bad';

export interface AxisTest {
  phase: AxisPhase;
  recorded: number | null;
  returned: number | null;
  peakAway: number;
  turnedAway: boolean;
}

export interface SensorRow {
  label: string;
  value: string;
}

export interface SensorTile {
  id: string;
  labelKey: string;
  status: 'live' | 'idle' | 'unsupported';
  rows: SensorRow[];
}

interface ExtraSensorLike {
  start(): void;
  stop(): void;
  addEventListener(type: string, listener: EventListener): void;
  x?: number;
  y?: number;
  z?: number;
  quaternion?: number[];
  illuminance?: number;
}

@Component({
  selector: 'app-detection-error',
  standalone: true,
  imports: [CommonModule, RouterModule, TranslateModule, CompassRoseComponent],
  templateUrl: './detection-error.component.html',
  styleUrls: ['./detection-error.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DetectionErrorComponent implements OnInit, OnDestroy {
  lookTracker!: CameraLookTracker;
  trueNorth = true;
  declinationDeg: number | null = null;
  roseUnwrapped = 0;

  dir: AxisTest = DetectionErrorComponent.emptyTest();
  el: AxisTest = DetectionErrorComponent.emptyTest();
  dirHistory: { recorded: number; returned: number; delta: number }[] = [];
  elHistory: { recorded: number; returned: number; delta: number }[] = [];

  alphaDeg: number | null = null;
  betaDeg: number | null = null;
  gammaDeg: number | null = null;
  webkitHeading: number | null = null;
  orientAbsolute: boolean | null = null;
  compassAccuracy: number | null = null;
  motionAccel: { x: number; y: number; z: number } | null = null;
  motionGravity: { x: number; y: number; z: number } | null = null;
  motionGyro: { alpha: number; beta: number; gamma: number } | null = null;
  motionIntervalMs: number | null = null;

  gpsLat: number | null = null;
  gpsLon: number | null = null;
  gpsAccuracyM: number | null = null;
  gpsAltitudeM: number | null = null;
  gpsAltitudeAccuracyM: number | null = null;
  gpsHeadingDeg: number | null = null;
  gpsSpeedMs: number | null = null;
  gpsStatus: 'idle' | 'live' | 'denied' | 'unsupported' | 'error' = 'idle';

  screenAngle: number | null = null;
  screenType = '';
  batteryPct: number | null = null;
  batteryCharging: boolean | null = null;
  networkType = '';
  networkDownlink: number | null = null;
  absQuat: number[] | null = null;
  relQuat: number[] | null = null;
  linearAccel: { x: number; y: number; z: number } | null = null;
  lightLux: number | null = null;

  private extras: ExtraSensorLike[] = [];
  private geoWatchId: number | null = null;
  private orientListening = false;
  private motionListening = false;
  private batteryRef: { removeEventListener(type: string, listener: EventListener): void } | null = null;
  private networkRef: { removeEventListener(type: string, listener: EventListener): void } | null = null;
  private readonly onOrient = (e: DeviceOrientationEvent): void => this.handleOrient(e);
  private readonly onMotion = (e: DeviceMotionEvent): void => this.handleMotion(e);
  private readonly onScreen = (): void => this.readScreen();
  private readonly onNetwork = (): void => this.readNetwork();
  private handleBattery: EventListener = () => undefined;

  readonly dirAwayNeed = DIR_AWAY_DEG;
  readonly elAwayNeed = EL_AWAY_DEG;

  constructor(
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.trueNorth = loadSharedTrueNorth(true);
    this.lookTracker = new CameraLookTracker(this.zone, () => this.onLookUpdate());
    void this.lookTracker.start(false);
    this.startExtras(false);
    this.cdr.markForCheck();
  }

  ngOnDestroy(): void {
    this.lookTracker.stop();
    this.stopExtras();
  }

  async enableSensors(): Promise<void> {
    await this.lookTracker.start(true);
    this.startExtras(true);
    this.cdr.markForCheck();
  }

  get sensorsOn(): boolean {
    return this.lookTracker.sensorsOn;
  }

  get azimuthDeg(): number | null {
    return this.lookTracker.azimuthDeg;
  }

  get elevationDeg(): number | null {
    return this.lookTracker.elevationDeg;
  }

  get rollDeg(): number | null {
    return this.lookTracker.rollDeg;
  }

  get trueNorthAvailable(): boolean {
    return this.declinationDeg != null && Number.isFinite(this.declinationDeg);
  }

  get trueNorthActive(): boolean {
    return this.trueNorth && this.trueNorthAvailable;
  }

  toggleTrueNorth(): void {
    if (!this.trueNorthAvailable) {
      return;
    }
    this.trueNorth = !this.trueNorth;
    this.lookTracker.setTrueNorthCorrection(this.trueNorth, this.declinationDeg);
    this.cdr.markForCheck();
  }

  roseRotationDeg(): number {
    return this.roseUnwrapped;
  }

  cardinalLabel(deg: number | null): string {
    if (deg == null || !Number.isFinite(deg)) {
      return '—';
    }
    const idx = ((Math.round(normalizeDeg(deg) / 22.5) % 16) + 16) % 16;
    return CARDINALS[idx];
  }

  fmtDeg(deg: number | null, digits = 1): string {
    if (deg == null || !Number.isFinite(deg)) {
      return '—';
    }
    const sign = deg > 0.05 ? '+' : deg < -0.05 ? '−' : '';
    return `${sign}${Math.abs(deg).toFixed(digits)}°`;
  }

  fmtHeading(deg: number | null): string {
    if (deg == null || !Number.isFinite(deg)) {
      return '—';
    }
    return `${normalizeDeg(deg).toFixed(1)}°`;
  }

  absLiveDelta(kind: AxisKind): number {
    const d = this.liveDelta(kind);
    return d == null ? 99 : Math.abs(d);
  }

  liveDelta(kind: AxisKind): number | null {
    const test = kind === 'direction' ? this.dir : this.el;
    const live = kind === 'direction' ? this.azimuthDeg : this.elevationDeg;
    if (test.recorded == null || live == null) {
      return null;
    }
    return kind === 'direction' ? circularDiff(live, test.recorded) : live - test.recorded;
  }

  resultDelta(kind: AxisKind): number | null {
    const test = kind === 'direction' ? this.dir : this.el;
    if (test.recorded == null || test.returned == null) {
      return null;
    }
    return kind === 'direction'
      ? circularDiff(test.returned, test.recorded)
      : test.returned - test.recorded;
  }

  verdict(delta: number | null): Verdict | null {
    if (delta == null) {
      return null;
    }
    const a = Math.abs(delta);
    if (a < OK_DEG) {
      return 'ok';
    }
    if (a < WARN_DEG) {
      return 'warn';
    }
    return 'bad';
  }

  verdictKey(kind: AxisKind): string {
    const v = this.verdict(this.resultDelta(kind));
    return v ? `DETECTION_ERROR.VERDICT_${v.toUpperCase()}` : '';
  }

  dirHintKey(): string {
    if (this.dir.phase === 'turn') {
      return 'DETECTION_ERROR.DIR_TURN';
    }
    if (this.dir.phase === 'return') {
      return 'DETECTION_ERROR.DIR_RETURN';
    }
    if (this.dir.phase === 'done') {
      return 'DETECTION_ERROR.DIR_DONE';
    }
    return 'DETECTION_ERROR.DIR_IDLE';
  }

  elHintKey(): string {
    if (this.el.phase === 'turn') {
      return 'DETECTION_ERROR.EL_TURN';
    }
    if (this.el.phase === 'return') {
      return 'DETECTION_ERROR.EL_RETURN';
    }
    if (this.el.phase === 'done') {
      return 'DETECTION_ERROR.EL_DONE';
    }
    return 'DETECTION_ERROR.EL_IDLE';
  }

  record(kind: AxisKind): void {
    const live = kind === 'direction' ? this.azimuthDeg : this.elevationDeg;
    if (live == null) {
      return;
    }
    const test = kind === 'direction' ? this.dir : this.el;
    test.phase = 'turn';
    test.recorded = live;
    test.returned = null;
    test.peakAway = 0;
    test.turnedAway = false;
    this.cdr.markForCheck();
  }

  confirmReturn(kind: AxisKind): void {
    const test = kind === 'direction' ? this.dir : this.el;
    const live = kind === 'direction' ? this.azimuthDeg : this.elevationDeg;
    if (!test.turnedAway || test.recorded == null || live == null) {
      return;
    }
    test.returned = live;
    test.phase = 'done';
    const delta =
      kind === 'direction' ? circularDiff(live, test.recorded) : live - test.recorded;
    const hist = { recorded: test.recorded, returned: live, delta };
    if (kind === 'direction') {
      this.dirHistory = [hist, ...this.dirHistory].slice(0, 6);
    } else {
      this.elHistory = [hist, ...this.elHistory].slice(0, 6);
    }
    this.cdr.markForCheck();
  }

  reset(kind: AxisKind): void {
    if (kind === 'direction') {
      this.dir = DetectionErrorComponent.emptyTest();
    } else {
      this.el = DetectionErrorComponent.emptyTest();
    }
    this.cdr.markForCheck();
  }

  elevFillBottomPct(): number {
    const p = this.elevationDeg ?? 0;
    if (p >= 0) {
      return 50;
    }
    return 50 + (p / 90) * 50;
  }

  elevFillHeightPct(): number {
    const p = this.elevationDeg;
    if (p == null) {
      return 0;
    }
    return (Math.abs(p) / 90) * 50;
  }

  elevMarkerPct(): number {
    const p = this.elevationDeg ?? 0;
    return 50 + (p / 90) * 50;
  }

  sourceKey(): string {
    const s = this.lookTracker.source;
    if (!s) {
      return '';
    }
    return `DETECTION_ERROR.SRC_${s.replace(/-/g, '_').toUpperCase()}`;
  }

  tiles(): SensorTile[] {
    const dbg = this.lookTracker.sensorDebug();
    const fmt3 = (v: { x: number; y: number; z: number } | null, unit: string, d = 2): SensorRow[] =>
      v
        ? [
            { label: 'X', value: `${v.x.toFixed(d)} ${unit}` },
            { label: 'Y', value: `${v.y.toFixed(d)} ${unit}` },
            { label: 'Z', value: `${v.z.toFixed(d)} ${unit}` }
          ]
        : [];

    return [
      {
        id: 'look',
        labelKey: 'DETECTION_ERROR.TILE_LOOK',
        status: this.azimuthDeg != null ? 'live' : this.sensorsOn ? 'idle' : 'unsupported',
        rows: [
          { label: 'az', value: this.fmtHeading(this.azimuthDeg) },
          { label: 'az raw', value: this.fmtHeading(dbg.rawAzimuthDeg) },
          { label: 'el', value: this.fmtDeg(this.elevationDeg) },
          { label: 'el raw', value: this.fmtDeg(dbg.rawElevationDeg) },
          { label: 'roll', value: this.fmtDeg(this.rollDeg) },
          { label: 'cardinal', value: this.cardinalLabel(this.azimuthDeg) },
          {
            label: 'Source',
            value: this.lookTracker.source ?? '—'
          }
        ]
      },
      {
        id: 'orient',
        labelKey: 'DETECTION_ERROR.TILE_ORIENT',
        status: this.alphaDeg != null || this.betaDeg != null ? 'live' : 'idle',
        rows: [
          { label: 'α (alpha)', value: this.fmtDeg(this.alphaDeg) },
          { label: 'β (beta)', value: this.fmtDeg(this.betaDeg) },
          { label: 'γ (gamma)', value: this.fmtDeg(this.gammaDeg) },
          { label: 'webkitCompass', value: this.fmtHeading(this.webkitHeading) },
          {
            label: 'absolute',
            value: this.orientAbsolute == null ? '—' : this.orientAbsolute ? 'yes' : 'no'
          },
          {
            label: 'précision',
            value: this.compassAccuracy == null ? '—' : `${this.compassAccuracy}°`
          }
        ]
      },
      {
        id: 'mag',
        labelKey: 'DETECTION_ERROR.TILE_MAG',
        status: dbg.hasMag ? 'live' : 'unsupported',
        rows: [
          ...fmt3(dbg.mag, 'µT'),
          {
            label: '|B|',
            value: dbg.magFieldUt == null ? '—' : `${dbg.magFieldUt.toFixed(1)} µT`
          }
        ]
      },
      {
        id: 'accel',
        labelKey: 'DETECTION_ERROR.TILE_ACCEL',
        status: dbg.hasAccel ? 'live' : this.motionGravity ? 'live' : 'unsupported',
        rows: [
          ...fmt3(dbg.accel ?? this.motionGravity, 'm/s²'),
          { label: 'gravity API', value: dbg.hasGravity ? 'yes' : 'no' }
        ]
      },
      {
        id: 'gyro',
        labelKey: 'DETECTION_ERROR.TILE_GYRO',
        status: dbg.hasGyro ? 'live' : this.motionGyro ? 'live' : 'unsupported',
        rows: dbg.gyro
          ? fmt3(dbg.gyro, 'rad/s', 3)
          : this.motionGyro
            ? [
                { label: 'α', value: `${this.motionGyro.alpha.toFixed(1)} °/s` },
                { label: 'β', value: `${this.motionGyro.beta.toFixed(1)} °/s` },
                { label: 'γ', value: `${this.motionGyro.gamma.toFixed(1)} °/s` }
              ]
            : []
      },
      {
        id: 'motion',
        labelKey: 'DETECTION_ERROR.TILE_MOTION',
        status: this.motionGravity || this.motionAccel ? 'live' : 'idle',
        rows: [
          ...(this.motionAccel
            ? [
                { label: 'lin. X', value: `${this.motionAccel.x.toFixed(2)} m/s²` },
                { label: 'lin. Y', value: `${this.motionAccel.y.toFixed(2)} m/s²` },
                { label: 'lin. Z', value: `${this.motionAccel.z.toFixed(2)} m/s²` }
              ]
            : [{ label: 'linéaire', value: '—' }]),
          {
            label: 'intervalle',
            value: this.motionIntervalMs == null ? '—' : `${this.motionIntervalMs.toFixed(0)} ms`
          }
        ]
      },
      {
        id: 'gps',
        labelKey: 'DETECTION_ERROR.TILE_GPS',
        status:
          this.gpsStatus === 'live' ? 'live' : this.gpsStatus === 'unsupported' ? 'unsupported' : 'idle',
        rows: [
          { label: 'latitude', value: this.gpsLat == null ? '—' : this.gpsLat.toFixed(6) },
          { label: 'longitude', value: this.gpsLon == null ? '—' : this.gpsLon.toFixed(6) },
          {
            label: 'précision',
            value: this.gpsAccuracyM == null ? '—' : `${this.gpsAccuracyM.toFixed(0)} m`
          },
          {
            label: 'altitude',
            value: this.gpsAltitudeM == null ? '—' : `${this.gpsAltitudeM.toFixed(1)} m`
          },
          {
            label: 'préc. alt.',
            value: this.gpsAltitudeAccuracyM == null ? '—' : `${this.gpsAltitudeAccuracyM.toFixed(0)} m`
          },
          { label: 'cap GPS', value: this.fmtHeading(this.gpsHeadingDeg) },
          {
            label: 'vitesse',
            value: this.gpsSpeedMs == null ? '—' : `${(this.gpsSpeedMs * 3.6).toFixed(1)} km/h`
          }
        ]
      },
      {
        id: 'decl',
        labelKey: 'DETECTION_ERROR.TILE_DECL',
        status: this.declinationDeg != null ? 'live' : 'idle',
        rows: [
          { label: 'declination', value: this.fmtDeg(this.declinationDeg) },
          { label: 'north', value: this.trueNorthActive ? 'true' : 'magnetic' },
          { label: 'rotation vector', value: dbg.hasRotationVector ? 'yes' : 'no' }
        ]
      },
      {
        id: 'absq',
        labelKey: 'DETECTION_ERROR.TILE_ABS_QUAT',
        status: this.absQuat ? 'live' : 'unsupported',
        rows: this.absQuat
          ? this.absQuat.map((v, i) => ({ label: 'xyzw'[i], value: v.toFixed(4) }))
          : []
      },
      {
        id: 'relq',
        labelKey: 'DETECTION_ERROR.TILE_REL_QUAT',
        status: this.relQuat ? 'live' : 'unsupported',
        rows: this.relQuat
          ? this.relQuat.map((v, i) => ({ label: 'xyzw'[i], value: v.toFixed(4) }))
          : []
      },
      {
        id: 'lin',
        labelKey: 'DETECTION_ERROR.TILE_LIN_ACCEL',
        status: this.linearAccel ? 'live' : 'unsupported',
        rows: fmt3(this.linearAccel, 'm/s²')
      },
      {
        id: 'light',
        labelKey: 'DETECTION_ERROR.TILE_LIGHT',
        status: this.lightLux != null ? 'live' : 'unsupported',
        rows: [{ label: 'lux', value: this.lightLux == null ? '—' : this.lightLux.toFixed(0) }]
      },
      {
        id: 'screen',
        labelKey: 'DETECTION_ERROR.TILE_SCREEN',
        status: this.screenAngle != null || this.screenType ? 'live' : 'idle',
        rows: [
          { label: 'angle', value: this.screenAngle == null ? '—' : `${this.screenAngle}°` },
          { label: 'type', value: this.screenType || '—' },
          { label: 'dpr', value: String(window.devicePixelRatio || '—') },
          { label: 'viewport', value: `${window.innerWidth} × ${window.innerHeight}` }
        ]
      },
      {
        id: 'sys',
        labelKey: 'DETECTION_ERROR.TILE_SYS',
        status: this.batteryPct != null || this.networkType ? 'live' : 'idle',
        rows: [
          {
            label: 'batterie',
            value:
              this.batteryPct == null
                ? '—'
                : `${Math.round(this.batteryPct * 100)}%${this.batteryCharging ? ' ⚡' : ''}`
          },
          { label: 'réseau', value: this.networkType || '—' },
          {
            label: 'débit',
            value: this.networkDownlink == null ? '—' : `${this.networkDownlink} Mb/s`
          }
        ]
      }
    ];
  }

  private onLookUpdate(): void {
    const az = this.azimuthDeg;
    if (az != null) {
      this.roseUnwrapped += circularDiff(az, normalizeDeg(this.roseUnwrapped));
    }
    this.advanceTest('direction', this.azimuthDeg, DIR_AWAY_DEG);
    this.advanceTest('elevation', this.elevationDeg, EL_AWAY_DEG);
    this.cdr.markForCheck();
  }

  private advanceTest(kind: AxisKind, live: number | null, awayNeed: number): void {
    const test = kind === 'direction' ? this.dir : this.el;
    if (test.phase !== 'turn' && test.phase !== 'return') {
      return;
    }
    if (test.recorded == null || live == null) {
      return;
    }
    const delta = kind === 'direction' ? circularDiff(live, test.recorded) : live - test.recorded;
    const away = Math.abs(delta);
    if (away > test.peakAway) {
      test.peakAway = away;
    }
    if (!test.turnedAway && away >= awayNeed) {
      test.turnedAway = true;
      test.phase = 'return';
    }
  }

  private startExtras(fromTap: boolean): void {
    this.startOrientation();
    this.startMotion();
    this.startGenericExtras();
    this.startGps();
    this.readScreen();
    window.addEventListener('orientationchange', this.onScreen);
    screen.orientation?.addEventListener?.('change', this.onScreen);
    this.readNetwork();
    const conn = (navigator as Navigator & { connection?: EventTarget }).connection;
    if (conn) {
      this.networkRef = conn;
      conn.addEventListener('change', this.onNetwork);
    }
    void this.startBattery();
    void fromTap;
  }

  private stopExtras(): void {
    if (this.orientListening) {
      window.removeEventListener('deviceorientationabsolute', this.onOrient, true);
      window.removeEventListener('deviceorientation', this.onOrient, true);
      this.orientListening = false;
    }
    if (this.motionListening) {
      window.removeEventListener('devicemotion', this.onMotion, true);
      this.motionListening = false;
    }
    for (const s of this.extras) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    this.extras = [];
    if (this.geoWatchId != null) {
      navigator.geolocation.clearWatch(this.geoWatchId);
      this.geoWatchId = null;
    }
    window.removeEventListener('orientationchange', this.onScreen);
    screen.orientation?.removeEventListener?.('change', this.onScreen);
    this.networkRef?.removeEventListener('change', this.onNetwork);
    this.networkRef = null;
    this.batteryRef?.removeEventListener('levelchange', this.handleBattery);
    this.batteryRef?.removeEventListener('chargingchange', this.handleBattery);
    this.batteryRef = null;
  }

  private startOrientation(): void {
    if (this.orientListening) {
      return;
    }
    this.orientListening = true;
    this.zone.runOutsideAngular(() => {
      window.addEventListener('deviceorientationabsolute', this.onOrient, true);
      window.addEventListener('deviceorientation', this.onOrient, true);
    });
  }

  private startMotion(): void {
    if (this.motionListening) {
      return;
    }
    this.motionListening = true;
    this.zone.runOutsideAngular(() => {
      window.addEventListener('devicemotion', this.onMotion, true);
    });
  }

  private startGenericExtras(): void {
    if (this.extras.length) {
      return;
    }
    const w = window as unknown as Record<string, unknown>;
    this.tryExtra(w['AbsoluteOrientationSensor'] as new (o: { frequency: number }) => ExtraSensorLike, (s) => {
      if (s.quaternion) {
        this.absQuat = [...s.quaternion];
      }
    });
    this.tryExtra(w['RelativeOrientationSensor'] as new (o: { frequency: number }) => ExtraSensorLike, (s) => {
      if (s.quaternion) {
        this.relQuat = [...s.quaternion];
      }
    });
    this.tryExtra(w['LinearAccelerationSensor'] as new (o: { frequency: number }) => ExtraSensorLike, (s) => {
      this.linearAccel = { x: s.x ?? 0, y: s.y ?? 0, z: s.z ?? 0 };
    });
    this.tryExtra(w['AmbientLightSensor'] as new (o: { frequency: number }) => ExtraSensorLike, (s) => {
      if (typeof s.illuminance === 'number') {
        this.lightLux = s.illuminance;
      }
    });
  }

  private tryExtra(
    Ctor: (new (o: { frequency: number }) => ExtraSensorLike) | undefined,
    onRead: (s: ExtraSensorLike) => void
  ): void {
    if (typeof Ctor !== 'function') {
      return;
    }
    try {
      const s = new Ctor({ frequency: 20 });
      this.zone.runOutsideAngular(() => {
        s.addEventListener('reading', () => {
          onRead(s);
          this.zone.run(() => this.cdr.markForCheck());
        });
      });
      s.start();
      this.extras.push(s);
    } catch {
      /* unsupported or denied */
    }
  }

  private startGps(): void {
    if (!navigator.geolocation) {
      this.gpsStatus = 'unsupported';
      return;
    }
    if (this.geoWatchId != null) {
      return;
    }
    this.geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.gpsLat = pos.coords.latitude;
        this.gpsLon = pos.coords.longitude;
        this.gpsAccuracyM = pos.coords.accuracy;
        this.gpsAltitudeM =
          typeof pos.coords.altitude === 'number' ? pos.coords.altitude : null;
        this.gpsAltitudeAccuracyM =
          typeof pos.coords.altitudeAccuracy === 'number' ? pos.coords.altitudeAccuracy : null;
        this.gpsHeadingDeg =
          typeof pos.coords.heading === 'number' && Number.isFinite(pos.coords.heading)
            ? pos.coords.heading
            : null;
        this.gpsSpeedMs =
          typeof pos.coords.speed === 'number' && Number.isFinite(pos.coords.speed)
            ? pos.coords.speed
            : null;
        this.gpsStatus = 'live';
        this.declinationDeg = magneticDeclinationDeg(this.gpsLat, this.gpsLon);
        this.lookTracker.setTrueNorthCorrection(this.trueNorth, this.declinationDeg);
        this.cdr.markForCheck();
      },
      (err) => {
        this.gpsStatus = err.code === 1 ? 'denied' : 'error';
        this.cdr.markForCheck();
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 12000 }
    );
  }

  private handleOrient(e: DeviceOrientationEvent): void {
    if (typeof e.alpha === 'number' && Number.isFinite(e.alpha)) {
      this.alphaDeg = e.alpha;
    }
    if (typeof e.beta === 'number' && Number.isFinite(e.beta)) {
      this.betaDeg = e.beta;
    }
    if (typeof e.gamma === 'number' && Number.isFinite(e.gamma)) {
      this.gammaDeg = e.gamma;
    }
    const wk = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
    if (typeof wk === 'number' && Number.isFinite(wk)) {
      this.webkitHeading = wk;
    }
    this.orientAbsolute = e.absolute === true || e.type === 'deviceorientationabsolute';
    const acc = (e as DeviceOrientationEvent & { webkitCompassAccuracy?: number }).webkitCompassAccuracy;
    if (typeof acc === 'number' && Number.isFinite(acc)) {
      this.compassAccuracy = acc;
    }
    this.zone.run(() => this.cdr.markForCheck());
  }

  private handleMotion(e: DeviceMotionEvent): void {
    const a = e.acceleration;
    if (a && a.x != null && a.y != null && a.z != null) {
      this.motionAccel = { x: a.x, y: a.y, z: a.z };
    }
    const g = e.accelerationIncludingGravity;
    if (g && g.x != null && g.y != null && g.z != null) {
      this.motionGravity = { x: g.x, y: g.y, z: g.z };
    }
    const r = e.rotationRate;
    if (r && r.alpha != null && r.beta != null && r.gamma != null) {
      this.motionGyro = { alpha: r.alpha, beta: r.beta, gamma: r.gamma };
    }
    if (typeof e.interval === 'number') {
      this.motionIntervalMs = e.interval;
    }
    this.zone.run(() => this.cdr.markForCheck());
  }

  private readScreen(): void {
    this.screenAngle = screen.orientation?.angle ?? (window.orientation as number) ?? null;
    this.screenType = screen.orientation?.type ?? '';
    this.cdr.markForCheck();
  }

  private readNetwork(): void {
    const conn = (
      navigator as Navigator & {
        connection?: { effectiveType?: string; downlink?: number };
      }
    ).connection;
    this.networkType = conn?.effectiveType ?? '';
    this.networkDownlink = typeof conn?.downlink === 'number' ? conn.downlink : null;
    this.cdr.markForCheck();
  }

  private async startBattery(): Promise<void> {
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<{
        level: number;
        charging: boolean;
        addEventListener(type: string, listener: EventListener): void;
        removeEventListener(type: string, listener: EventListener): void;
      }>;
    };
    if (typeof nav.getBattery !== 'function') {
      return;
    }
    try {
      const bat = await nav.getBattery();
      this.batteryRef = bat;
      this.handleBattery = () => {
        this.batteryPct = bat.level;
        this.batteryCharging = bat.charging;
        this.cdr.markForCheck();
      };
      this.handleBattery(new Event('levelchange'));
      bat.addEventListener('levelchange', this.handleBattery);
      bat.addEventListener('chargingchange', this.handleBattery);
    } catch {
      /* ignore */
    }
  }

  private static emptyTest(): AxisTest {
    return {
      phase: 'idle',
      recorded: null,
      returned: null,
      peakAway: 0,
      turnedAway: false
    };
  }
}
