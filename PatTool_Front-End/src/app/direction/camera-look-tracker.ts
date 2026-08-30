import { NgZone } from '@angular/core';
import {
  AttitudeOptions,
  CameraAttitude,
  GyroMagComplementary,
  Vec3,
  cameraElevationFromBetaGamma,
  cameraElevationFromGravity,
  cameraFromDeviceOrientation,
  cameraFromEarthToDeviceQuat,
  cameraFromMagAccel,
  normalizeDeg
} from './direction-attitude';
import {
  DIRECTION_HARDIRON_KEY,
  NORD_CAL_STORAGE_KEY,
  loadSharedTrueNorth,
  type PersistedNordCal
} from '../shared/compass-north.engine';
import {
  applyLookDeclination,
  canonicalizeLookCal,
  composeLookAzimuth,
  composeLookElevation,
  loadPattoolCal,
  resetLookOffsetsFromSamples,
  setLookFromRawToTarget
} from './direction-pattool-cal';

interface GenericSensor {
  start(): void;
  stop(): void;
  addEventListener(type: string, listener: EventListener): void;
  x?: number;
  y?: number;
  z?: number;
  quaternion?: number[];
}

type HeadingSource = 'rotation-vector' | 'mag-accel' | 'deviceorientation' | 'gyro-lock';

const SOURCE_RANK: Record<HeadingSource, number> = {
  'mag-accel': 4,
  'gyro-lock': 3,
  deviceorientation: 2,
  'rotation-vector': 1
};

/**
 * Visée caméra arrière (même pipeline que la page Calibrage direction).
 */
export class CameraLookTracker {
  azimuthDeg: number | null = null;
  /** Cap magnétomètre brut, avant décalage Nord / poses. */
  rawAzimuthDeg: number | null = null;
  elevationDeg: number | null = null;
  rollDeg: number | null = null;
  sensorsOn = false;
  denied = false;
  needTap = false;
  source: HeadingSource | null = null;
  /** Décalage manuel azimut (0 = pas de calage Nord / visée à la main). */
  manualOffsetDeg = 0;
  /** Décalage manuel élévation (calage « position exacte »). */
  manualElOffsetDeg = 0;
  /** Même interrupteur que la page Direction (Nord vrai). */
  trueNorth = true;
  declinationDeg: number | null = null;

  private mag: Vec3 = { x: 0, y: 0, z: 0 };
  private accel: Vec3 = { x: 0, y: 0, z: 9.81 };
  private gyro: Vec3 = { x: 0, y: 0, z: 0 };
  private hasMag = false;
  private hasAccel = false;
  private hasGravity = false;
  private hasGyro = false;
  private hasRotationVector = false;
  private accelFromGeneric = false;
  private gyroFromGeneric = false;
  private magAzimuthDeg: number | null = null;
  private rawElevationDeg: number | null = null;
  private smoothedElevationDeg: number | null = null;
  private lastBetaDeg: number | null = null;
  private lastGammaDeg: number | null = null;
  private generics: GenericSensor[] = [];
  private orientName: 'deviceorientationabsolute' | 'deviceorientation' | null = null;
  private fusion = new GyroMagComplementary();
  private lastQuatAtt: CameraAttitude | null = null;
  private lastPaint = 0;
  /** Capteurs toujours à jour, mais plus de zone.run / callback UI. */
  private uiPaused = false;
  private readonly onOrient = (e: DeviceOrientationEvent): void => this.handleOrient(e);
  private readonly onMotion = (e: DeviceMotionEvent): void => this.handleMotion(e);

  constructor(
    private readonly zone: NgZone,
    private readonly onUpdate: () => void
  ) {}

  async start(fromTap: boolean): Promise<void> {
    canonicalizeLookCal();
    this.trueNorth = loadSharedTrueNorth(this.trueNorth);
    this.needTap = false;
    this.denied = false;
    const doe = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    const dme = window.DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    if (typeof doe.requestPermission === 'function') {
      if (!fromTap) {
        this.needTap = true;
        this.onUpdate();
        return;
      }
      try {
        if ((await doe.requestPermission()) !== 'granted') {
          this.denied = true;
          this.onUpdate();
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
        this.onUpdate();
        return;
      }
    }
    this.sensorsOn = true;
    this.startGenerics();
    this.startOrientation();
    this.startMotion();
    this.onUpdate();
  }

  /**
   * La visée caméra actuelle devient le Nord géographique (azimut 0°).
   * Remplace le décalage d’azimut (ne s’empile pas sur les 7 poses).
   */
  markCameraAsNorth(): boolean {
    return this.markCameraAsAzimuth(0);
  }

  /**
   * La visée caméra actuelle devient le Sud géographique (azimut 180°),
   * ce qui cale le Nord comme N = S − 180°.
   */
  markCameraAsSouth(): boolean {
    return this.markCameraAsAzimuth(180);
  }

  markCameraAsAzimuth(targetAzDeg: number): boolean {
    if (this.magAzimuthDeg == null) {
      return false;
    }
    setLookFromRawToTarget(this.publishedRawAzimuthDeg(), targetAzDeg);
    this.lastPaint = 0;
    this.publish();
    return true;
  }

  /**
   * La visée caméra actuelle devient la direction de l’astre (azimut + élévation).
   */
  markCameraAsTarget(targetAzDeg: number, targetElDeg: number): boolean {
    if (this.magAzimuthDeg == null || this.rawElevationDeg == null) {
      return false;
    }
    if (!Number.isFinite(targetAzDeg) || !Number.isFinite(targetElDeg)) {
      return false;
    }
    setLookFromRawToTarget(
      this.publishedRawAzimuthDeg(),
      targetAzDeg,
      this.rawElevationDeg,
      targetElDeg
    );
    this.lastPaint = 0;
    this.publish();
    return true;
  }

  /** Même valeur que `publish()` passe à `composeLookAzimuth` (magnétique + déclinaison). */
  private publishedRawAzimuthDeg(): number {
    return applyLookDeclination(this.magAzimuthDeg!, this.trueNorthActive(), this.declinationDeg);
  }

  setTrueNorthCorrection(trueNorth: boolean, declinationDeg: number | null): void {
    const nextDec =
      declinationDeg != null && Number.isFinite(declinationDeg) ? declinationDeg : null;
    if (this.trueNorth === trueNorth && this.declinationDeg === nextDec) {
      return;
    }
    this.trueNorth = trueNorth;
    this.declinationDeg = nextDec;
    this.lastPaint = 0;
    this.publish();
  }

  private trueNorthActive(): boolean {
    return this.trueNorth && this.declinationDeg != null && Number.isFinite(this.declinationDeg);
  }

  hasManualAlign(): boolean {
    const d = loadPattoolCal()?.derived;
    return (d?.azOffsetDeg ?? 0) !== 0 || (d?.elOffsetDeg ?? 0) !== 0;
  }

  clearManualNorth(): void {
    resetLookOffsetsFromSamples();
    this.lastPaint = 0;
    this.publish();
  }

  /**
   * Figé l’UI (astro-compass pause / fiche objet) sans arrêter les capteurs :
   * azimut et élévation restent à jour pour la reprise.
   */
  setUiPaused(paused: boolean): void {
    if (this.uiPaused === paused) {
      return;
    }
    this.uiPaused = paused;
    if (!paused) {
      this.lastPaint = 0;
      this.zone.run(() => this.onUpdate());
    }
  }

  /** Instantané brut pour les pages de diagnostic (ne change pas la fusion). */
  sensorDebug(): {
    mag: Vec3 | null;
    accel: Vec3 | null;
    gyro: Vec3 | null;
    magFieldUt: number | null;
    hasMag: boolean;
    hasAccel: boolean;
    hasGyro: boolean;
    hasGravity: boolean;
    hasRotationVector: boolean;
    lastBetaDeg: number | null;
    lastGammaDeg: number | null;
    rawAzimuthDeg: number | null;
    rawElevationDeg: number | null;
  } {
    const mag = this.hasMag ? this.mag : null;
    return {
      mag,
      accel: this.hasAccel ? this.accel : null,
      gyro: this.hasGyro ? this.gyro : null,
      magFieldUt: mag ? Math.hypot(mag.x, mag.y, mag.z) : null,
      hasMag: this.hasMag,
      hasAccel: this.hasAccel,
      hasGyro: this.hasGyro,
      hasGravity: this.hasGravity,
      hasRotationVector: this.hasRotationVector,
      lastBetaDeg: this.lastBetaDeg,
      lastGammaDeg: this.lastGammaDeg,
      rawAzimuthDeg: this.rawAzimuthDeg,
      rawElevationDeg: this.rawElevationDeg
    };
  }

  stop(): void {
    this.uiPaused = false;
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
    this.sensorsOn = false;
    this.fusion.reset();
    this.smoothedElevationDeg = null;
    this.hasRotationVector = false;
    this.lastQuatAtt = null;
    this.source = null;
  }

  private attitudeOpt(): AttitudeOptions {
    const d = loadPattoolCal()?.derived;
    if (!d) {
      return {};
    }
    return { conjugateQuat: d.conjugateQuat, cameraMinusZ: d.cameraMinusZ };
  }

  private startGenerics(): void {
    const w = window as unknown as Record<string, unknown>;
    this.trySensor(
      w['Magnetometer'] as (new (o: { frequency: number }) => GenericSensor) | undefined,
      (s) => this.onMag({ x: s.x ?? 0, y: s.y ?? 0, z: s.z ?? 0 })
    );
    this.trySensor(
      w['Accelerometer'] as (new (o: { frequency: number }) => GenericSensor) | undefined,
      (s) => {
        this.accelFromGeneric = true;
        if (!this.hasGravity) {
          this.setAccel({ x: s.x ?? 0, y: s.y ?? 0, z: s.z ?? 0 });
        }
      }
    );
    this.trySensor(
      w['GravitySensor'] as (new (o: { frequency: number }) => GenericSensor) | undefined,
      (s) => {
        this.hasGravity = true;
        this.accelFromGeneric = true;
        this.setAccel({ x: s.x ?? 0, y: s.y ?? 0, z: s.z ?? 0 });
      }
    );
    this.trySensor(
      w['Gyroscope'] as (new (o: { frequency: number }) => GenericSensor) | undefined,
      (s) => {
        this.gyro = { x: s.x ?? 0, y: s.y ?? 0, z: s.z ?? 0 };
        this.hasGyro = true;
        this.gyroFromGeneric = true;
        this.fuse();
      }
    );
    this.trySensor(
      w['AbsoluteOrientationSensor'] as
        | (new (o: { frequency: number; referenceFrame?: string }) => GenericSensor)
        | undefined,
      (s) => this.onAbsQuat(s.quaternion),
      { referenceFrame: 'device' }
    );
  }

  private trySensor(
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
        s.start();
      });
      this.generics.push(s);
    } catch {
      /* missing / denied */
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

  private onAbsQuat(q: number[] | undefined): void {
    if (!q || q.length < 4) {
      return;
    }
    this.hasRotationVector = true;
    const att = cameraFromEarthToDeviceQuat({ x: q[0], y: q[1], z: q[2], w: q[3] }, this.attitudeOpt());
    if (att) {
      this.lastQuatAtt = att;
    }
    this.fuse();
  }

  private onMag(raw: Vec3): void {
    const v = applyStoredHardIron(raw);
    if (this.hasMag) {
      this.mag = {
        x: this.mag.x * 0.72 + v.x * 0.28,
        y: this.mag.y * 0.72 + v.y * 0.28,
        z: this.mag.z * 0.72 + v.z * 0.28
      };
    } else {
      this.mag = v;
    }
    this.hasMag = true;
    this.fuse();
  }

  private handleOrient(e: DeviceOrientationEvent): void {
    if (Number.isFinite(e.beta as number)) {
      this.lastBetaDeg = e.beta as number;
    }
    if (Number.isFinite(e.gamma as number)) {
      this.lastGammaDeg = e.gamma as number;
    }
    if (this.hasMag) {
      this.applyTiltElevation();
      return;
    }
    const anyE = e as DeviceOrientationEvent & { webkitCompassHeading?: number };
    const wk =
      typeof anyE.webkitCompassHeading === 'number' && Number.isFinite(anyE.webkitCompassHeading)
        ? anyE.webkitCompassHeading
        : null;
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
    const att = cameraFromDeviceOrientation(alpha, e.beta ?? 0, e.gamma ?? 0, this.attitudeOpt());
    if (att) {
      this.applyAtt(att, 'deviceorientation');
    }
  }

  private handleMotion(e: DeviceMotionEvent): void {
    const a = e.accelerationIncludingGravity;
    if (a && a.x != null && a.y != null && a.z != null && !this.accelFromGeneric && !this.hasGravity) {
      this.setAccel({ x: a.x, y: a.y, z: a.z });
    }
    const r = e.rotationRate;
    if (r && r.alpha != null && r.beta != null && r.gamma != null && !this.gyroFromGeneric) {
      const k = Math.PI / 180;
      this.gyro = { x: r.beta * k, y: r.gamma * k, z: r.alpha * k };
      this.hasGyro = true;
      this.fuse();
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
    if (this.hasMag) {
      this.fuse();
      return;
    }
    if (this.hasRotationVector) {
      this.applyTiltElevation();
      return;
    }
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
    const incoming = SOURCE_RANK[src];
    const current = this.source != null ? SOURCE_RANK[this.source] : -1;
    if (incoming < current) {
      return;
    }
    this.source = src;
    this.rollDeg = att.rollDeg;
    this.magAzimuthDeg = att.azimuthDeg;
    const d = loadPattoolCal()?.derived;
    const fromQuat = att.elevationDeg * (d?.elSign ?? 1);
    const tiltEl = d?.elSource === 'attitude' ? null : this.tiltElevationDeg();
    this.rawElevationDeg = this.smoothElevation(tiltEl ?? fromQuat, tiltEl != null);
    this.publish();
  }

  /**
   * Gravité dès qu’on a un accéléro (y compris DeviceMotion iOS).
   * Beta/gamma sautent près du zénith (180° ↔ −180°) et font claquer l’astre
   * sous le réticule.
   */
  private tiltElevationDeg(): number | null {
    if (this.hasAccel) {
      const g = cameraElevationFromGravity(this.accel);
      if (g != null) {
        return g;
      }
    }
    if (this.lastBetaDeg != null) {
      return cameraElevationFromBetaGamma(this.lastBetaDeg, this.lastGammaDeg ?? 0);
    }
    return null;
  }

  private smoothElevation(next: number, fromGravity: boolean): number {
    if (this.smoothedElevationDeg == null) {
      this.smoothedElevationDeg = next;
      return next;
    }
    const d = next - this.smoothedElevationDeg;
    // Euler beta wrap only. Gravity is continuous: horizon → zénith ≈ 90°,
    // il ne faut pas figer l’astre sous le réticule.
    if (!fromGravity && Math.abs(d) > 45) {
      return this.smoothedElevationDeg;
    }
    const a = Math.abs(d) > 20 ? 0.55 : 0.4;
    this.smoothedElevationDeg += d * a;
    return this.smoothedElevationDeg;
  }

  private applyTiltElevation(): void {
    const el = this.tiltElevationDeg();
    if (el == null || this.magAzimuthDeg == null) {
      return;
    }
    this.rawElevationDeg = this.smoothElevation(el, true);
    this.publish();
  }

  private publish(): void {
    const az = this.magAzimuthDeg;
    if (az == null) {
      return;
    }
    const d = loadPattoolCal()?.derived ?? null;
    this.manualOffsetDeg = d?.azOffsetDeg ?? 0;
    this.manualElOffsetDeg = d?.elOffsetDeg ?? 0;
    this.rawAzimuthDeg = az;
    this.azimuthDeg = composeLookAzimuth(
      applyLookDeclination(az, this.trueNorthActive(), this.declinationDeg),
      d
    );
    if (this.rawElevationDeg != null) {
      this.elevationDeg = composeLookElevation(this.rawElevationDeg, d);
    }
    if (this.uiPaused) {
      return;
    }
    const now = performance.now();
    if (now - this.lastPaint < 40) {
      return;
    }
    this.lastPaint = now;
    this.zone.run(() => this.onUpdate());
  }
}

function applyStoredHardIron(v: Vec3): Vec3 {
  const cal = loadStoredHardIron();
  if (!cal) {
    return v;
  }
  const s = cal.scale ?? { x: 1, y: 1, z: 1 };
  return {
    x: (v.x - cal.bias.x) * (s.x ?? 1),
    y: (v.y - cal.bias.y) * (s.y ?? 1),
    z: (v.z - cal.bias.z) * (s.z ?? 1)
  };
}

function loadStoredHardIron(): { bias: { x: number; y: number; z: number }; scale?: { x?: number; y?: number; z?: number } } | null {
  for (const key of [NORD_CAL_STORAGE_KEY, DIRECTION_HARDIRON_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        continue;
      }
      const d = JSON.parse(raw) as PersistedNordCal;
      if (d?.bias) {
        return d;
      }
    } catch {
      /* try next key */
    }
  }
  return null;
}
