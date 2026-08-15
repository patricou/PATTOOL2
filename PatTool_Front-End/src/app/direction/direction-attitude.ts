/**
 * Attitude caméra arrière — visée −Z dans le repère Terre ENU.
 *
 * AbsoluteOrientationSensor / TYPE_ROTATION_VECTOR : quaternion [x,y,z,w] = rotation
 * appareil → Terre (W3C). On NE conjugue PAS. La caméra arrière vise −Z appareil :
 * lookENU = q * (0,0,−1) * q⁻¹, puis azimut = atan2(Est, Nord), élévation = atan2(Haut, horiz).
 *
 * Calibrage Galaxy S23 (poses N/O/S/E + zénith/nadir) : remap(AXIS_X, AXIS_MINUS_Z) +
 * getOrientation collait l’azimut à 0° (le lacet partait dans le roulis). Le vecteur visée
 * suit les 4 cardinaux. Gravité → élévation/roulis ; mag OS → lacet.
 *
 * Repère appareil : X droite, Y haut, Z vers l’utilisateur. Terre ENU.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface CameraAttitude {
  /** Azimut de la visée, 0° = Nord, horaire. */
  azimuthDeg: number;
  /** Élévation de la visée : 0° horizon, + ciel, − sol. */
  elevationDeg: number;
  /** Roulis autour de la visée : 0° horizon horizontal. */
  rollDeg: number;
  lookEast: number;
  lookNorth: number;
  lookUp: number;
}

export function hypot3(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function normalizeVec(v: Vec3): Vec3 | null {
  const n = hypot3(v);
  if (n < 1e-9) {
    return null;
  }
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function normalizeDeg(deg: number): number {
  let d = deg % 360;
  if (d < 0) {
    d += 360;
  }
  return d;
}

export function circularDiff(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

/**
 * Roulis utile pour le viseur, dans ]-90°, 90°].
 * Près du zénith, le « droite horizon » dérivé de la visée s’anti-aligne avec +X
 * appareil → le roulis brut saute à ~±180° et inverse le haut/bas de l’image.
 */
export function uprightRollDeg(rollDeg: number): number {
  let r = ((rollDeg % 360) + 360) % 360;
  if (r > 180) {
    r -= 360;
  }
  if (r > 90) {
    r -= 180;
  } else if (r < -90) {
    r += 180;
  }
  return r;
}

export function circularLerp(fromDeg: number, toDeg: number, t: number): number {
  return normalizeDeg(fromDeg + circularDiff(toDeg, fromDeg) * t);
}

/** Like circularLerp but keeps a continuous (unwrapped) angle — no 0°/360° jump. */
export function circularApproach(fromDeg: number, toDeg: number, t: number): number {
  return fromDeg + circularDiff(toDeg, fromDeg) * t;
}

/**
 * Filtre passe-bas circulaire (sin/cos) — ne jamais moyenner des angles en 0..360.
 * ALPHA 0.15 : réactif mais sans saut 359°→0°.
 */
export class CircularLowPass {
  private sin = 0;
  private cos = 1;
  private primed = false;

  constructor(private readonly alpha = 0.15) {}

  reset(): void {
    this.primed = false;
  }

  update(deg: number): number {
    const rad = (deg * Math.PI) / 180;
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    if (!this.primed) {
      this.sin = s;
      this.cos = c;
      this.primed = true;
    } else {
      this.sin += this.alpha * (s - this.sin);
      this.cos += this.alpha * (c - this.cos);
    }
    return normalizeDeg((Math.atan2(this.sin, this.cos) * 180) / Math.PI);
  }
}

export function quatConjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  if (n < 1e-12) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

/** q * v * q⁻¹ — tourne le vecteur par le quaternion. */
export function rotateByQuat(q: Quat, v: Vec3): Vec3 {
  const t = {
    x: 2 * (q.y * v.z - q.z * v.y),
    y: 2 * (q.z * v.x - q.x * v.z),
    z: 2 * (q.x * v.y - q.y * v.x)
  };
  return {
    x: v.x + q.w * t.x + (q.y * t.z - q.z * t.y),
    y: v.y + q.w * t.y + (q.z * t.x - q.x * t.z),
    z: v.z + q.w * t.z + (q.x * t.y - q.y * t.x)
  };
}

export interface AttitudeOptions {
  /**
   * true = conjuguer q (si un capteur livrait Terre→appareil).
   * Défaut false : W3C AbsoluteOrientationSensor est déjà appareil→Terre.
   */
  conjugateQuat?: boolean;
  /** true = caméra arrière −Z. false = caméra écran +Z. */
  cameraMinusZ?: boolean;
}

/**
 * Quaternion [x,y,z,w] appareil → Terre ENU → matrice R (row-major) :
 * v_terre = R * v_appareil.
 */
function rotationMatrixFromVector(q: Quat): number[] {
  const n = quatNormalize(q);
  const q1 = n.x;
  const q2 = n.y;
  const q3 = n.z;
  const q0 = n.w;
  const sqQ1 = 2 * q1 * q1;
  const sqQ2 = 2 * q2 * q2;
  const sqQ3 = 2 * q3 * q3;
  const q1q2 = 2 * q1 * q2;
  const q3q0 = 2 * q3 * q0;
  const q1q3 = 2 * q1 * q3;
  const q2q0 = 2 * q2 * q0;
  const q2q3 = 2 * q2 * q3;
  const q1q0 = 2 * q1 * q0;
  return [
    1 - sqQ2 - sqQ3,
    q1q2 - q3q0,
    q1q3 + q2q0,
    q1q2 + q3q0,
    1 - sqQ1 - sqQ3,
    q2q3 - q1q0,
    q1q3 - q2q0,
    q2q3 + q1q0,
    1 - sqQ1 - sqQ2
  ];
}

/**
 * AOSP getRotationMatrix(gravity, geomagnetic).
 * Accéléro au repos = +g vers le ciel (W3C / Android, y compris Samsung).
 */
function rotationMatrixFromMagAccel(mag: Vec3, gravity: Vec3): number[] | null {
  let ax = gravity.x;
  let ay = gravity.y;
  let az = gravity.z;
  const normSqA = ax * ax + ay * ay + az * az;
  if (normSqA < 0.01 * 9.81 * 9.81) {
    return null;
  }
  let hx = mag.y * az - mag.z * ay;
  let hy = mag.z * ax - mag.x * az;
  let hz = mag.x * ay - mag.y * ax;
  const normH = Math.hypot(hx, hy, hz);
  if (normH < 0.1) {
    return null;
  }
  const invH = 1 / normH;
  hx *= invH;
  hy *= invH;
  hz *= invH;
  const invA = 1 / Math.sqrt(normSqA);
  ax *= invA;
  ay *= invA;
  az *= invA;
  const mx = ay * hz - az * hy;
  const my = az * hx - ax * hz;
  const mz = ax * hy - ay * hx;
  return [hx, hy, hz, mx, my, mz, ax, ay, az];
}

/**
 * R monde←appareil (row-major) : visée = ± colonne Z, haut d’écran = colonne Y.
 * Azimut / élévation / roulis = vecteur visée (pas getOrientation remappé).
 */
function cameraAttitudeFromDeviceToWorldMatrix(
  r: number[],
  cameraMinusZ = true
): CameraAttitude | null {
  const s = cameraMinusZ ? -1 : 1;
  const look: Vec3 = { x: s * r[2], y: s * r[5], z: s * r[8] };
  const top: Vec3 = { x: r[1], y: r[4], z: r[7] };
  const right: Vec3 = { x: r[0], y: r[3], z: r[6] };
  return attitudeFromLookAndTop(look, top, right);
}

function minusZ(opt?: AttitudeOptions): boolean {
  return opt?.cameraMinusZ !== false;
}

/**
 * AbsoluteOrientationSensor / TYPE_ROTATION_VECTOR (Samsung, Pixel, etc.).
 * q = rotation appareil → Terre ENU. Fusion OS gyro + gravité + mag.
 */
export function cameraFromEarthToDeviceQuat(q: Quat, opt?: AttitudeOptions): CameraAttitude | null {
  const n = quatNormalize(q);
  const qq = opt?.conjugateQuat === true ? quatConjugate(n) : n;
  return cameraAttitudeFromDeviceToWorldMatrix(rotationMatrixFromVector(qq), minusZ(opt));
}

/**
 * Élévation de la caméra arrière depuis la gravité (accéléro au repos).
 * Écran vers le ciel → −90° (nadir). Écran vers le sol / visée zénith → +90°.
 * Ne dépend pas du quaternion (souvent inversé près du zénith).
 */
export function cameraElevationFromGravity(accel: Vec3): number | null {
  const n = hypot3(accel);
  if (n < 2) {
    return null;
  }
  const inv = 1 / n;
  return (Math.atan2(-accel.z * inv, Math.hypot(accel.x, accel.y) * inv) * 180) / Math.PI;
}

/**
 * Élévation caméra arrière depuis DeviceOrientation beta/gamma (alpha ignoré).
 * Téléphone vertical → ~0°. Incliné vers le zénith (caméra vers le ciel) → positif.
 */
export function cameraElevationFromBetaGamma(betaDeg: number, gammaDeg: number): number {
  const b = (betaDeg * Math.PI) / 180;
  const g = (gammaDeg * Math.PI) / 180;
  const sb = Math.sin(b);
  const cb = Math.cos(b);
  const cg = Math.cos(g);
  const sg = Math.sin(g);
  const lookEast = -sg;
  const lookNorth = cg * sb;
  const lookUp = -cb * cg;
  const lookH = Math.hypot(lookEast, lookNorth);
  return (Math.atan2(lookUp, Math.max(lookH, 1e-6)) * 180) / Math.PI;
}

/**
 * DeviceOrientation W3C → même pipeline caméra Android.
 */
export function cameraFromDeviceOrientation(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
  opt?: AttitudeOptions
): CameraAttitude | null {
  const a = (alphaDeg * Math.PI) / 180;
  const b = (betaDeg * Math.PI) / 180;
  const g = (gammaDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  const cg = Math.cos(g);
  const sg = Math.sin(g);
  const r = [
    ca * cg - sa * sb * sg,
    -cb * sa,
    ca * sg + cg * sa * sb,
    sa * cg + ca * sb * sg,
    ca * cb,
    sa * sg - ca * cg * sb,
    -cb * sg,
    sb,
    cb * cg
  ];
  return cameraAttitudeFromDeviceToWorldMatrix(r, minusZ(opt));
}

/**
 * Repli accéléro + mag = AOSP getRotationMatrix (même algo que Samsung SensorManager).
 */
export function cameraFromMagAccel(mag: Vec3, accel: Vec3, opt?: AttitudeOptions): CameraAttitude | null {
  const r = rotationMatrixFromMagAccel(mag, accel);
  if (!r) {
    return null;
  }
  return cameraAttitudeFromDeviceToWorldMatrix(r, minusZ(opt));
}

/**
 * Azimut 0° = Nord, horaire.
 * Horizon : direction de la caméra. Zénith / nadir : haut du téléphone.
 */
export function attitudeFromLookAndTop(look: Vec3, top: Vec3, right: Vec3): CameraAttitude | null {
  const lookH = Math.hypot(look.x, look.y);
  const topH = Math.hypot(top.x, top.y);
  const wLook = lookH * lookH;
  const wTop = Math.max(0.05, 1 - wLook);
  let he = look.x * wLook;
  let hn = look.y * wLook;
  if (topH > 0.04) {
    he += top.x * wTop;
    hn += top.y * wTop;
  }
  if (he * he + hn * hn < 1e-10) {
    return null;
  }
  const azimuthDeg = normalizeDeg((Math.atan2(he, hn) * 180) / Math.PI);
  const elevationDeg = (Math.atan2(look.z, Math.max(lookH, 1e-6)) * 180) / Math.PI;
  const horizonRight: Vec3 =
    lookH < 1e-4 ? { x: 1, y: 0, z: 0 } : { x: look.y / lookH, y: -look.x / lookH, z: 0 };
  const rawRollDeg = (Math.atan2(dot(right, { x: 0, y: 0, z: 1 }), dot(right, horizonRight)) * 180) / Math.PI;
  return {
    azimuthDeg,
    elevationDeg,
    rollDeg: uprightRollDeg(rawRollDeg),
    lookEast: look.x,
    lookNorth: look.y,
    lookUp: look.z
  };
}

export interface ScreenProjection {
  xPct: number;
  yPct: number;
  inView: boolean;
  inFront: boolean;
  sepDeg: number;
  centered: boolean;
}

export interface FinderTurnGuide {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  ok: boolean;
  yawDeg: number;
  pitchDeg: number;
}

const GUIDE_DEAD_DEG = 8;
const GUIDE_SCREEN_DEAD_PCT = 5;

/**
 * Flèches de guidage : à l’écran si l’objet est dans le champ (compense le roulis),
 * sinon plus court chemin azimut / élévation.
 */
export function computeFinderTurnGuide(
  camAz: number | null,
  camEl: number | null,
  tgtAz: number | null,
  tgtEl: number | null,
  proj: ScreenProjection | null
): FinderTurnGuide | null {
  if (camAz == null || camEl == null || tgtAz == null || tgtEl == null) {
    return null;
  }
  const yawDeg = Math.round(circularDiff(tgtAz, camAz));
  const pitchDeg = Math.round(tgtEl - camEl);
  if (proj?.centered) {
    return { left: false, right: false, up: false, down: false, ok: true, yawDeg: 0, pitchDeg: 0 };
  }
  let left = false;
  let right = false;
  let up = false;
  let down = false;
  if (proj?.inView) {
    if (proj.xPct < 50 - GUIDE_SCREEN_DEAD_PCT) {
      left = true;
    } else if (proj.xPct > 50 + GUIDE_SCREEN_DEAD_PCT) {
      right = true;
    }
    if (proj.yPct < 50 - GUIDE_SCREEN_DEAD_PCT) {
      up = true;
    } else if (proj.yPct > 50 + GUIDE_SCREEN_DEAD_PCT) {
      down = true;
    }
  } else {
    if (Math.abs(yawDeg) > GUIDE_DEAD_DEG) {
      if (yawDeg > 0) {
        right = true;
      } else {
        left = true;
      }
    }
    if (Math.abs(pitchDeg) > GUIDE_DEAD_DEG) {
      if (pitchDeg > 0) {
        up = true;
      } else {
        down = true;
      }
    }
  }
  return {
    left,
    right,
    up,
    down,
    ok: !left && !right && !up && !down,
    yawDeg: Math.abs(yawDeg),
    pitchDeg: Math.abs(pitchDeg)
  };
}

const DEFAULT_HFOV_DEG = 62;
const CENTER_SEP_DEG = 2.8;

/** Projette un azimut/élévation ciel sur l’image caméra (visée −Z). */
export function projectCelestialToScreen(
  camAzDeg: number,
  camElDeg: number,
  _camRollDeg: number,
  tgtAzDeg: number,
  tgtElDeg: number,
  hfovDeg = DEFAULT_HFOV_DEG,
  vfovDeg?: number,
  centerSepDeg = CENTER_SEP_DEG
): ScreenProjection {
  const vfov = vfovDeg != null && vfovDeg > 5 ? vfovDeg : hfovDeg * 0.75;
  const dAz = circularDiff(tgtAzDeg, camAzDeg);
  const dEl = tgtElDeg - camElDeg;
  const cosEl = Math.cos((camElDeg * Math.PI) / 180);
  const xAng = dAz * Math.max(0.15, cosEl);
  const yAng = dEl;
  const sepDeg = Math.hypot(xAng, yAng);
  const inFront = Math.abs(dAz) < 90 && camElDeg * tgtElDeg > -80;
  const xPct = 50 + (xAng / (hfovDeg / 2)) * 50;
  // CSS top : 0 = haut de l’image. Caméra au-dessus de l’astre (dEl < 0) → yPct > 50.
  const yPct = 50 - (yAng / (vfov / 2)) * 50;
  const inView =
    inFront && xPct >= 4 && xPct <= 96 && yPct >= 4 && yPct <= 96 && sepDeg < Math.max(hfovDeg, vfov) * 0.7;
  return {
    xPct: Math.max(-8, Math.min(108, xPct)),
    yPct: Math.max(-8, Math.min(108, yPct)),
    inView,
    inFront,
    sepDeg,
    centered: inView && sepDeg <= centerSepDeg
  };
}

export function circularMeanDeg(degrees: ReadonlyArray<number>): number {
  if (!degrees.length) {
    return 0;
  }
  let x = 0;
  let y = 0;
  for (const d of degrees) {
    const r = (d * Math.PI) / 180;
    x += Math.cos(r);
    y += Math.sin(r);
  }
  return normalizeDeg((Math.atan2(y, x) * 180) / Math.PI);
}

export function wrapSignedDeg(deg: number): number {
  return circularDiff(deg, 0);
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function initialBearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const φ1 = lat1 * r;
  const φ2 = lat2 * r;
  const Δλ = (lon2 - lon1) * r;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeDeg((Math.atan2(y, x) * 180) / Math.PI);
}

/** Position du Soleil (azimut depuis le Nord vrai, élévation) — NOAA. */
export function solarPosition(
  latDeg: number,
  lonDeg: number,
  date: Date
): { azimuthDeg: number; elevationDeg: number } {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  let L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  if (L0 < 0) {
    L0 += 360;
  }
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mrad = M * rad;
  const C =
    Math.sin(Mrad) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mrad) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mrad) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const seconds = 21.448 - T * (46.815 + T * (0.00059 - T * 0.001813));
  const e0 = 23 + (26 + seconds / 60) / 60;
  const oblCorr = e0 + 0.00256 * Math.cos(omega * rad);
  const declRad = Math.asin(Math.sin(oblCorr * rad) * Math.sin(lambda * rad));
  const y = Math.tan((oblCorr / 2) * rad) * Math.tan((oblCorr / 2) * rad);
  const L0rad = L0 * rad;
  const eqTime =
    (4 *
      (y * Math.sin(2 * L0rad) -
        2 * e * Math.sin(Mrad) +
        4 * e * y * Math.sin(Mrad) * Math.cos(2 * L0rad) -
        0.5 * y * y * Math.sin(4 * L0rad) -
        1.25 * e * e * Math.sin(2 * Mrad))) /
    rad;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  let trueSolarTime = (minutes + eqTime + 4 * lonDeg) % 1440;
  if (trueSolarTime < 0) {
    trueSolarTime += 1440;
  }
  const ha = trueSolarTime / 4 - 180;
  const latRad = latDeg * rad;
  const haRad = ha * rad;
  const zenithRad = Math.acos(
    Math.min(
      1,
      Math.max(
        -1,
        Math.sin(latRad) * Math.sin(declRad) +
          Math.cos(latRad) * Math.cos(declRad) * Math.cos(haRad)
      )
    )
  );
  const elevationDeg = 90 - zenithRad / rad;
  let azimuthDeg: number;
  const azDenom = Math.cos(latRad) * Math.sin(zenithRad);
  if (Math.abs(azDenom) > 1e-6) {
    let azRad = (Math.sin(latRad) * Math.cos(zenithRad) - Math.sin(declRad)) / azDenom;
    azRad = Math.min(1, Math.max(-1, azRad));
    const az = Math.acos(azRad) / rad;
    azimuthDeg = ha > 0 ? (az + 180) % 360 : (540 - az) % 360;
  } else {
    azimuthDeg = latDeg > 0 ? 180 : 0;
  }
  return { azimuthDeg, elevationDeg };
}

/** Pôle magnétique nord ~2025, approximation dipolaire (déclinaison). */
export function dipoleDeclinationDeg(latDeg: number, lonDeg: number): number {
  const poleLat = (86.5 * Math.PI) / 180;
  const poleLon = (-164.0 * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const y = Math.sin(poleLon - lon);
  const x = Math.cos(lat) * Math.tan(poleLat) - Math.sin(lat) * Math.cos(poleLon - lon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

export class HardIronCal {
  min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  samples = 0;
  bias: Vec3 = { x: 0, y: 0, z: 0 };
  scale: Vec3 = { x: 1, y: 1, z: 1 };
  ready = false;
  private octantMask = 0;

  reset(): void {
    this.min = { x: Infinity, y: Infinity, z: Infinity };
    this.max = { x: -Infinity, y: -Infinity, z: -Infinity };
    this.samples = 0;
    this.bias = { x: 0, y: 0, z: 0 };
    this.scale = { x: 1, y: 1, z: 1 };
    this.ready = false;
    this.octantMask = 0;
  }

  ingest(raw: Vec3): number {
    this.samples++;
    this.min.x = Math.min(this.min.x, raw.x);
    this.min.y = Math.min(this.min.y, raw.y);
    this.min.z = Math.min(this.min.z, raw.z);
    this.max.x = Math.max(this.max.x, raw.x);
    this.max.y = Math.max(this.max.y, raw.y);
    this.max.z = Math.max(this.max.z, raw.z);
    this.octantMask |= 1 << ((raw.x >= 0 ? 1 : 0) | (raw.y >= 0 ? 2 : 0) | (raw.z >= 0 ? 4 : 0));
    const span = Math.min(
      this.max.x - this.min.x,
      this.max.y - this.min.y,
      this.max.z - this.min.z
    );
    const cover = this.octantCount() / 8;
    return Math.round(100 * (0.5 * cover + 0.5 * Math.min(1, span / 20)));
  }

  octantCount(): number {
    let n = 0;
    let m = this.octantMask;
    while (m) {
      n += m & 1;
      m >>= 1;
    }
    return n;
  }

  finish(): boolean {
    const spanX = this.max.x - this.min.x;
    const spanY = this.max.y - this.min.y;
    const spanZ = this.max.z - this.min.z;
    if (this.samples < 60 || Math.min(spanX, spanY, spanZ) < 12) {
      return false;
    }
    this.bias = {
      x: (this.max.x + this.min.x) / 2,
      y: (this.max.y + this.min.y) / 2,
      z: (this.max.z + this.min.z) / 2
    };
    const rx = spanX / 2;
    const ry = spanY / 2;
    const rz = spanZ / 2;
    const avg = (rx + ry + rz) / 3;
    this.scale = {
      x: avg / Math.max(rx, 1e-3),
      y: avg / Math.max(ry, 1e-3),
      z: avg / Math.max(rz, 1e-3)
    };
    this.ready = true;
    return true;
  }

  correct(raw: Vec3): Vec3 {
    return {
      x: (raw.x - this.bias.x) * this.scale.x,
      y: (raw.y - this.bias.y) * this.scale.y,
      z: (raw.z - this.bias.z) * this.scale.z
    };
  }
}

/**
 * Gyro pour lisser l’azimut seulement. Inclinaison / roulis = accéléro+mag (absolus).
 */
export class GyroMagComplementary {
  private azimuth: number | null = null;
  private lastTs: number | null = null;
  private gyroBias = 0;

  reset(): void {
    this.azimuth = null;
    this.lastTs = null;
    this.gyroBias = 0;
  }

  /**
   * @param gyroRadS vitesses en rad/s, axes appareil
   * @param accel vecteur « haut » (gravité / accéléro au repos)
   */
  tick(gyroRadS: Vec3, accel: Vec3, magRef: CameraAttitude): CameraAttitude {
    const now = performance.now();
    const dt = this.lastTs == null ? 0.02 : Math.min(0.08, (now - this.lastTs) / 1000);
    this.lastTs = now;
    if (this.azimuth == null) {
      this.azimuth = magRef.azimuthDeg;
      return magRef;
    }
    const up = normalizeVec(accel);
    if (up) {
      const yawRate = -(gyroRadS.x * up.x + gyroRadS.y * up.y + gyroRadS.z * up.z);
      if (Math.abs(yawRate) < 0.04) {
        this.gyroBias = this.gyroBias * 0.99 + yawRate * 0.01;
      }
      this.azimuth = normalizeDeg(this.azimuth + ((yawRate - this.gyroBias) * 180 * dt) / Math.PI);
    }
    const a = 1 - Math.exp(-dt / 0.55);
    this.azimuth = circularLerp(this.azimuth, magRef.azimuthDeg, a);
    return { ...magRef, azimuthDeg: this.azimuth };
  }
}
