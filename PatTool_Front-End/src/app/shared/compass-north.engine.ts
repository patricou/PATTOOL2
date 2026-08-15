/** Calage Nord partagé (Direction + page Nord + Boussole Astres) : figure-8, hard-iron, fusion gyro. */

export const NORD_CAL_STORAGE_KEY = 'pat.nord.calibration.v1';
/** Même hard-iron que la page Direction (`pat.direction.hardiron.v1`). */
export const DIRECTION_HARDIRON_KEY = 'pat.direction.hardiron.v1';

export const FIGURE8_MIN_SAMPLES = 80;
export const FIGURE8_MIN_SPAN_UT = 18;
export const SETTLE_MS = 1800;
/** Constante de temps (s) : le mag corrige le gyro, sans coller au bruit 50 Hz. */
const MAG_TAU_LOCKED_S = 2.4;
const MAG_TAU_LIVE_S = 0.7;
/** Seuil (rad/s) sous lequel on estime le biais gyro (téléphone quasi immobile). */
const GYRO_STILL_RAD_S = 0.035;

export type SensorCalPhase = 'idle' | 'figure8' | 'settle' | 'done';

export interface MagVec {
  x: number;
  y: number;
  z: number;
}

export interface PersistedNordCal {
  bias: MagVec;
  scale: MagVec;
  northOffsetDeg: number;
  trueNorth: boolean;
  calibratedAt: string;
}

export function loadDirectionHardIron(): { bias: MagVec; scale: MagVec } | null {
  try {
    const raw = localStorage.getItem(DIRECTION_HARDIRON_KEY);
    if (!raw) {
      return null;
    }
    const data = JSON.parse(raw) as { bias?: MagVec; scale?: MagVec };
    if (data.bias && data.scale) {
      return { bias: data.bias, scale: data.scale };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function saveDirectionHardIron(bias: MagVec, scale: MagVec): void {
  try {
    localStorage.setItem(DIRECTION_HARDIRON_KEY, JSON.stringify({ bias, scale }));
  } catch {
    /* ignore */
  }
}

export function clearDirectionHardIron(): void {
  try {
    localStorage.removeItem(DIRECTION_HARDIRON_KEY);
  } catch {
    /* ignore */
  }
}

/** Écrit le hard-iron partagé (Nord / astro-compass / Direction). */
export function writeSharedNordCal(payload: PersistedNordCal): void {
  try {
    localStorage.setItem(NORD_CAL_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
  saveDirectionHardIron(payload.bias, payload.scale);
}

export class CompassNorthEngine {
  bias: MagVec = { x: 0, y: 0, z: 0 };
  scale: MagVec = { x: 1, y: 1, z: 1 };
  calibratedAt: string | null = null;
  magCalibrated = false;

  calPhase: SensorCalPhase = 'idle';
  calProgressPct = 0;
  calOctants = 0;
  calSpanUt = 0;
  settleRemainMs = SETTLE_MS;
  octantMask = 0;
  readonly octantBits = [0, 1, 2, 3, 4, 5, 6, 7];

  hasMag = false;
  hasGyro = false;
  hasAccel = false;
  accel: MagVec = { x: 0, y: 0, z: 9.81 };
  gyro: MagVec = { x: 0, y: 0, z: 0 };

  fusedHeading: number | null = null;
  roseUnwrappedDeg = 0;

  private gyroYawBias = 0;
  private magMin = { x: Infinity, y: Infinity, z: Infinity };
  private magMax = { x: -Infinity, y: -Infinity, z: -Infinity };
  private magSamples = 0;
  private figure8Headings: number[] = [];
  private roseInited = false;
  private lastFusionTs: number | null = null;
  private settleTimer: ReturnType<typeof setInterval> | null = null;

  loadPersisted(): boolean {
    let loaded = false;
    try {
      const raw = localStorage.getItem(NORD_CAL_STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw) as PersistedNordCal;
        if (data.bias) {
          this.bias = data.bias;
        }
        if (data.scale) {
          this.scale = data.scale;
        }
        if (data.calibratedAt) {
          this.calibratedAt = data.calibratedAt;
          this.magCalibrated = true;
          this.calPhase = 'done';
          loaded = true;
        }
      }
    } catch {
      /* ignore */
    }
    const dir = loadDirectionHardIron();
    if (dir) {
      this.bias = dir.bias;
      this.scale = dir.scale;
      this.magCalibrated = true;
      this.calPhase = 'done';
      if (!this.calibratedAt) {
        this.calibratedAt = new Date().toISOString();
      }
      loaded = true;
    }
    return loaded;
  }

  /** Charge le hard-iron partagé. L’offset Direction remplace celui de Nord s’il est fourni. */
  loadShared(directionOffsetDeg?: number): { northOffsetDeg: number; trueNorth: boolean } {
    let northOffsetDeg = 0;
    let trueNorth = true;
    try {
      const raw = localStorage.getItem(NORD_CAL_STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw) as PersistedNordCal;
        if (Number.isFinite(data.northOffsetDeg)) {
          northOffsetDeg = data.northOffsetDeg;
        }
        trueNorth = data.trueNorth !== false;
      }
    } catch {
      /* ignore */
    }
    this.loadPersisted();
    if (directionOffsetDeg != null && Number.isFinite(directionOffsetDeg)) {
      northOffsetDeg = directionOffsetDeg;
    }
    return { northOffsetDeg, trueNorth };
  }

  persistHardIron(extra?: { northOffsetDeg?: number; trueNorth?: boolean }): void {
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
      bias: this.bias,
      scale: this.scale,
      northOffsetDeg: extra?.northOffsetDeg ?? prev.northOffsetDeg ?? 0,
      trueNorth: extra?.trueNorth ?? prev.trueNorth !== false,
      calibratedAt: this.calibratedAt ?? new Date().toISOString()
    };
    try {
      localStorage.setItem(NORD_CAL_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* ignore */
    }
    if (this.magCalibrated) {
      saveDirectionHardIron(this.bias, this.scale);
    }
  }

  persistShared(northOffsetDeg: number, trueNorth: boolean): void {
    this.persistHardIron({ northOffsetDeg, trueNorth });
  }

  startFigure8(): void {
    this.clearSettleTimer();
    this.calPhase = 'figure8';
    this.calProgressPct = 0;
    this.calOctants = 0;
    this.calSpanUt = 0;
    this.octantMask = 0;
    this.magSamples = 0;
    this.figure8Headings = [];
    this.gyroYawBias = 0;
    this.lastFusionTs = null;
    this.magMin = { x: Infinity, y: Infinity, z: Infinity };
    this.magMax = { x: -Infinity, y: -Infinity, z: -Infinity };
    this.magCalibrated = false;
  }

  cancelCal(): void {
    this.clearSettleTimer();
    this.calPhase = this.magCalibrated ? 'done' : 'idle';
    this.calProgressPct = 0;
  }

  resetHardIron(): void {
    this.clearSettleTimer();
    this.bias = { x: 0, y: 0, z: 0 };
    this.scale = { x: 1, y: 1, z: 1 };
    this.calibratedAt = null;
    this.magCalibrated = false;
    this.calPhase = 'idle';
    this.calProgressPct = 0;
    this.calOctants = 0;
    this.calSpanUt = 0;
    this.octantMask = 0;
    this.fusedHeading = null;
    this.roseUnwrappedDeg = 0;
    this.gyroYawBias = 0;
    this.lastFusionTs = null;
    try {
      localStorage.removeItem(NORD_CAL_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    clearDirectionHardIron();
  }

  octantOn(bit: number): boolean {
    return (this.octantMask & (1 << bit)) !== 0;
  }

  /** Allume un octant pendant le 8 (magnétomètre ou accéléro). */
  noteOctant(x: number, y: number, z: number): void {
    if (this.calPhase !== 'figure8') {
      return;
    }
    const bit = (x >= 0 ? 1 : 0) | (y >= 0 ? 2 : 0) | (z >= 0 ? 4 : 0);
    this.octantMask |= 1 << bit;
    this.calOctants = this.popcount(this.octantMask);
  }

  /**
   * Sans magnétomètre : le 8 s’appuie sur l’accéléro (même geste).
   * Avec magnétomètre : allume seulement les points, le hard-iron reste au mag.
   */
  ingestFigure8Accel(x: number, y: number, z: number): boolean {
    if (this.calPhase !== 'figure8') {
      return false;
    }
    this.noteOctant(x, y, z);
    if (this.hasMag) {
      return false;
    }
    this.magSamples++;
    const cover = this.calOctants / 8;
    const nScore = Math.min(1, this.magSamples / FIGURE8_MIN_SAMPLES);
    this.calProgressPct = Math.round(100 * (0.6 * cover + 0.4 * nScore));
    return this.calOctants >= 6 && this.magSamples >= FIGURE8_MIN_SAMPLES;
  }

  correctMag(x: number, y: number, z: number): MagVec {
    return {
      x: (x - this.bias.x) * this.scale.x,
      y: (y - this.bias.y) * this.scale.y,
      z: (z - this.bias.z) * this.scale.z
    };
  }

  /** @returns true si le figure-8 est terminé (prêt à figer). */
  ingestFigure8Mag(x: number, y: number, z: number): boolean {
    if (this.calPhase !== 'figure8') {
      return false;
    }
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
    if (
      this.calOctants >= 6 &&
      this.calSpanUt >= FIGURE8_MIN_SPAN_UT &&
      this.magSamples >= FIGURE8_MIN_SAMPLES
    ) {
      this.finishFigure8HardIron();
      return true;
    }
    return false;
  }

  /** Sans magnétomètre brut (iOS) : couverture en cap pendant le 8. */
  ingestFigure8Heading(headingDeg: number): boolean {
    if (this.calPhase !== 'figure8') {
      return false;
    }
    this.figure8Headings.push(headingDeg);
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
    return this.calOctants >= 6 && this.magSamples >= FIGURE8_MIN_SAMPLES;
  }

  finishFigure8HardIron(): void {
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
  }

  beginSettle(onDone: () => void, onTick?: () => void): void {
    this.calPhase = 'settle';
    this.calProgressPct = 100;
    this.settleRemainMs = SETTLE_MS;
    this.clearSettleTimer();
    const started = Date.now();
    this.settleTimer = setInterval(() => {
      const left = SETTLE_MS - (Date.now() - started);
      this.settleRemainMs = Math.max(0, left);
      onTick?.();
      if (left <= 0) {
        this.clearSettleTimer();
        this.magCalibrated = true;
        this.calibratedAt = new Date().toISOString();
        this.calPhase = 'done';
        this.persistHardIron();
        onDone();
      }
    }, 80);
  }

  headingFromMagAccel(mx: number, my: number, mz: number, screenAngleDeg: number): number | null {
    const up = this.normalizeVec(this.accel.x, this.accel.y, this.accel.z);
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
    // Toujours le haut de l’écran (lubber), jamais un bascule plat / caméra :
    // le switch |z|≥|y| faisait sauter le Nord vers ~45° d’inclinaison.
    const sa = ((screenAngleDeg % 360) + 360) % 360;
    let tx = 0;
    let ty = 1;
    if (sa === 90) {
      tx = 1;
      ty = 0;
    } else if (sa === 180) {
      tx = 0;
      ty = -1;
    } else if (sa === 270) {
      tx = -1;
      ty = 0;
    }
    const d = tx * up.x + ty * up.y;
    const hx = tx - up.x * d;
    const hy = ty - up.y * d;
    const hz = -up.z * d;
    if (Math.hypot(hx, hy, hz) < 0.12) {
      return null;
    }
    const heading =
      (Math.atan2(
        hx * east.x + hy * east.y + hz * east.z,
        hx * north.x + hy * north.y + hz * north.z
      ) *
        180) /
      Math.PI;
    return this.normalizeDeg(heading);
  }

  fuseMagHeading(correctedDeg: number, locked: boolean): number {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this.fusedHeading == null) {
      this.fusedHeading = correctedDeg;
      this.lastFusionTs = now;
      return correctedDeg;
    }
    const dt =
      this.lastFusionTs == null ? 0.02 : Math.min(0.08, (now - this.lastFusionTs) / 1000);
    this.lastFusionTs = now;
    const jump = Math.abs(this.circularDiff(correctedDeg, this.fusedHeading));
    if (jump < 0.2) {
      return this.fusedHeading;
    }
    const tau = locked ? MAG_TAU_LOCKED_S : MAG_TAU_LIVE_S;
    const a = 1 - Math.exp(-dt / Math.max(tau, 1e-3));
    this.fusedHeading = this.circularLerp(this.fusedHeading, correctedDeg, a);
    return this.fusedHeading;
  }

  tickGyro(locked: boolean): number | null {
    if (this.fusedHeading == null || !this.hasGyro) {
      return null;
    }
    const now = performance.now();
    if (this.lastFusionTs == null) {
      this.lastFusionTs = now;
      return this.fusedHeading;
    }
    const dt = Math.min(0.08, (now - this.lastFusionTs) / 1000);
    this.lastFusionTs = now;
    const up = this.normalizeVec(this.accel.x, this.accel.y, this.accel.z);
    if (!up) {
      return this.fusedHeading;
    }
    const yawRate = -(this.gyro.x * up.x + this.gyro.y * up.y + this.gyro.z * up.z);
    if (Math.abs(yawRate) < GYRO_STILL_RAD_S) {
      this.gyroYawBias = this.gyroYawBias * 0.992 + yawRate * 0.008;
    }
    const gyroDeg = ((yawRate - this.gyroYawBias) * 180) / Math.PI;
    if (Math.abs(gyroDeg) * dt < 0.02 && Math.abs(yawRate) < GYRO_STILL_RAD_S) {
      void locked;
      return this.fusedHeading;
    }
    this.fusedHeading = this.normalizeDeg(this.fusedHeading + gyroDeg * dt);
    void locked;
    return this.fusedHeading;
  }

  unwrapRose(headingDeg: number): number {
    const target = this.normalizeDeg(-headingDeg);
    if (!this.roseInited) {
      this.roseUnwrappedDeg = -headingDeg;
      this.roseInited = true;
      return this.roseUnwrappedDeg;
    }
    const current = this.normalizeDeg(this.roseUnwrappedDeg);
    this.roseUnwrappedDeg += this.circularDiff(target, current);
    return this.roseUnwrappedDeg;
  }

  unwrapAngle(currentUnwrapped: number, targetNorm: number, inited: boolean): {
    value: number;
    inited: boolean;
  } {
    const target = this.normalizeDeg(targetNorm);
    if (!inited) {
      return { value: target > 180 ? target - 360 : target, inited: true };
    }
    const current = this.normalizeDeg(currentUnwrapped);
    return { value: currentUnwrapped + this.circularDiff(target, current), inited: true };
  }

  normalizeDeg(deg: number): number {
    let d = deg % 360;
    if (d < 0) {
      d += 360;
    }
    return d;
  }

  circularDiff(a: number, b: number): number {
    return ((((a - b) % 360) + 540) % 360) - 180;
  }

  circularLerp(fromDeg: number, toDeg: number, t: number): number {
    const f = (fromDeg * Math.PI) / 180;
    const to = (toDeg * Math.PI) / 180;
    const x = Math.cos(f) * (1 - t) + Math.cos(to) * t;
    const y = Math.sin(f) * (1 - t) + Math.sin(to) * t;
    return this.normalizeDeg((Math.atan2(y, x) * 180) / Math.PI);
  }

  normalizeVec(x: number, y: number, z: number): MagVec | null {
    const n = Math.hypot(x, y, z);
    if (n < 1e-8) {
      return null;
    }
    return { x: x / n, y: y / n, z: z / n };
  }

  screenAngle(): number {
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

  destroy(): void {
    this.clearSettleTimer();
  }

  resetFusion(): void {
    this.fusedHeading = null;
    this.roseUnwrappedDeg = 0;
    this.roseInited = false;
    this.gyroYawBias = 0;
    this.lastFusionTs = null;
  }

  private clearSettleTimer(): void {
    if (this.settleTimer != null) {
      clearInterval(this.settleTimer);
      this.settleTimer = null;
    }
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
