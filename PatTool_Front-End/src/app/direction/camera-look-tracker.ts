import { NgZone } from '@angular/core';
import {
  AttitudeOptions,
  CameraAttitude,
  GyroMagComplementary,
  Vec3,
  cameraFromDeviceOrientation,
  cameraFromEarthToDeviceQuat,
  cameraFromMagAccel,
  normalizeDeg,
  wrapSignedDeg
} from './direction-attitude';
import {
  clearManualAzOffset,
  clearManualElOffset,
  loadManualAzOffset,
  loadManualElOffset,
  loadPattoolCal,
  saveManualAzOffset,
  saveManualElOffset,
  sightingOffsetsFromLook
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
  'rotation-vector': 3,
  'gyro-lock': 2,
  'mag-accel': 1,
  deviceorientation: 0
};

/**
 * Visée caméra arrière (même pipeline que la page Calibrage direction).
 */
export class CameraLookTracker {
  azimuthDeg: number | null = null;
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
  private generics: GenericSensor[] = [];
  private orientName: 'deviceorientationabsolute' | 'deviceorientation' | null = null;
  private fusion = new GyroMagComplementary();
  private lastPaint = 0;
  private readonly onOrient = (e: DeviceOrientationEvent): void => this.handleOrient(e);
  private readonly onMotion = (e: DeviceMotionEvent): void => this.handleMotion(e);

  constructor(
    private readonly zone: NgZone,
    private readonly onUpdate: () => void
  ) {}

  async start(fromTap: boolean): Promise<void> {
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
   * Le décalage est mémorisé (même clé que la page Calibrage direction).
   */
  markCameraAsNorth(): boolean {
    if (this.magAzimuthDeg == null) {
      return false;
    }
    const calOff = loadPattoolCal()?.derived.azOffsetDeg ?? 0;
    saveManualAzOffset(wrapSignedDeg(-(this.magAzimuthDeg + calOff)));
    clearManualElOffset();
    this.lastPaint = 0;
    this.publish();
    return true;
  }

  /**
   * La visée caméra actuelle devient la direction de l’astre (azimut + élévation).
   * L’utilisateur a placé l’objet réel sur le pointeur du viseur.
   */
  markCameraAsTarget(targetAzDeg: number, targetElDeg: number): boolean {
    if (this.magAzimuthDeg == null || this.rawElevationDeg == null) {
      return false;
    }
    if (!Number.isFinite(targetAzDeg) || !Number.isFinite(targetElDeg)) {
      return false;
    }
    const calOff = loadPattoolCal()?.derived.azOffsetDeg ?? 0;
    const off = sightingOffsetsFromLook(
      this.magAzimuthDeg,
      this.rawElevationDeg,
      targetAzDeg,
      targetElDeg,
      calOff
    );
    saveManualAzOffset(off.azOffsetDeg);
    saveManualElOffset(off.elOffsetDeg);
    this.lastPaint = 0;
    this.publish();
    return true;
  }

  hasManualAlign(): boolean {
    return this.manualOffsetDeg !== 0 || this.manualElOffsetDeg !== 0;
  }

  clearManualNorth(): void {
    clearManualAzOffset();
    clearManualElOffset();
    this.lastPaint = 0;
    this.publish();
  }

  stop(): void {
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
      this.applyAtt(att, 'rotation-vector');
    }
  }

  private onMag(raw: Vec3): void {
    if (this.hasMag) {
      this.mag = {
        x: this.mag.x * 0.72 + raw.x * 0.28,
        y: this.mag.y * 0.72 + raw.y * 0.28,
        z: this.mag.z * 0.72 + raw.z * 0.28
      };
    } else {
      this.mag = raw;
    }
    this.hasMag = true;
    this.fuse();
  }

  private handleOrient(e: DeviceOrientationEvent): void {
    if (this.hasRotationVector || this.hasMag) {
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
    const incoming = SOURCE_RANK[src];
    const current = this.source != null ? SOURCE_RANK[this.source] : -1;
    if (incoming < current) {
      return;
    }
    this.source = src;
    this.rawElevationDeg = att.elevationDeg * (loadPattoolCal()?.derived.elSign ?? 1);
    this.rollDeg = att.rollDeg;
    this.magAzimuthDeg = att.azimuthDeg;
    this.publish();
  }

  private publish(): void {
    let az = this.magAzimuthDeg;
    if (az == null) {
      return;
    }
    const d = loadPattoolCal()?.derived;
    this.manualOffsetDeg = loadManualAzOffset();
    this.manualElOffsetDeg = loadManualElOffset();
    this.azimuthDeg = normalizeDeg(az + (d?.azOffsetDeg ?? 0) + this.manualOffsetDeg);
    if (this.rawElevationDeg != null) {
      this.elevationDeg = this.rawElevationDeg + this.manualElOffsetDeg;
    }
    const now = performance.now();
    if (now - this.lastPaint < 40) {
      return;
    }
    this.lastPaint = now;
    this.zone.run(() => this.onUpdate());
  }
}
