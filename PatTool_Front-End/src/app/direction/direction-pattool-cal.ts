import {
  AttitudeOptions,
  CameraAttitude,
  Vec3,
  cameraFromDeviceOrientation,
  cameraFromEarthToDeviceQuat,
  cameraFromMagAccel,
  circularDiff,
  circularMeanDeg,
  wrapSignedDeg
} from './direction-attitude';

export const PATTOOL_CAL_KEY = 'pat.direction.pattool-cal.v2';
/** Décalage azimut manuel (page Calibrage + bouton « C’est le Nord » du viseur). */
export const MANUAL_AZ_OFFSET_KEY = 'pat.direction.az-offset.v1';

export interface PattoolCalPose {
  id: string;
  titleKey: string;
  hintKey: string;
  expectedAz: number | null;
  expectedEl: number;
}

export const PATTOOL_POSES: readonly PattoolCalPose[] = [
  {
    id: 'n',
    titleKey: 'DIRECTION.PAT_N_TITLE',
    hintKey: 'DIRECTION.PAT_N_HINT',
    expectedAz: 0,
    expectedEl: 0
  },
  {
    id: 'w',
    titleKey: 'DIRECTION.PAT_W_TITLE',
    hintKey: 'DIRECTION.PAT_W_HINT',
    expectedAz: 270,
    expectedEl: 0
  },
  {
    id: 's',
    titleKey: 'DIRECTION.PAT_S_TITLE',
    hintKey: 'DIRECTION.PAT_S_HINT',
    expectedAz: 180,
    expectedEl: 0
  },
  {
    id: 'e',
    titleKey: 'DIRECTION.PAT_E_TITLE',
    hintKey: 'DIRECTION.PAT_E_HINT',
    expectedAz: 90,
    expectedEl: 0
  },
  {
    id: 'sky',
    titleKey: 'DIRECTION.PAT_SKY_TITLE',
    hintKey: 'DIRECTION.PAT_SKY_HINT',
    expectedAz: null,
    expectedEl: 90
  },
  {
    id: 'ground',
    titleKey: 'DIRECTION.PAT_GROUND_TITLE',
    hintKey: 'DIRECTION.PAT_GROUND_HINT',
    expectedAz: null,
    expectedEl: -90
  }
];

export interface PattoolCalSnapshot {
  sessionId?: string;
  poseId: string;
  poseIndex?: number;
  expectedAz?: number | null;
  expectedEl?: number;
  at: string;
  quat: number[] | null;
  mag: Vec3 | null;
  accel: Vec3 | null;
  gyro: Vec3 | null;
  orient: {
    alpha: number | null;
    beta: number | null;
    gamma: number | null;
    absolute: boolean;
    webkit: number | null;
  } | null;
  screenAngle: number;
  gps: { lat: number | null; lon: number | null; heading: number | null };
  computed: {
    az: number | null;
    el: number | null;
    rl: number | null;
    source: string | null;
    lookEast?: number | null;
    lookNorth?: number | null;
    lookUp?: number | null;
  };
  extras?: Record<string, unknown>;
}

export type PattoolCalFamily = 'quat' | 'mag' | 'do';

export interface PattoolCalDerived {
  family: PattoolCalFamily;
  conjugateQuat: boolean;
  cameraMinusZ: boolean;
  azOffsetDeg: number;
  elSign: 1 | -1;
  meanErrDeg: number;
}

export interface PattoolCalFile {
  version: 1;
  calibratedAt: string;
  userAgent: string;
  samples: PattoolCalSnapshot[];
  derived: PattoolCalDerived;
}

interface MethodCandidate {
  family: PattoolCalFamily;
  conjugateQuat: boolean;
  cameraMinusZ: boolean;
}

const CANDIDATES: MethodCandidate[] = [
  { family: 'quat', conjugateQuat: false, cameraMinusZ: true },
  { family: 'quat', conjugateQuat: false, cameraMinusZ: false },
  { family: 'quat', conjugateQuat: true, cameraMinusZ: true },
  { family: 'quat', conjugateQuat: true, cameraMinusZ: false },
  { family: 'mag', conjugateQuat: false, cameraMinusZ: true },
  { family: 'mag', conjugateQuat: false, cameraMinusZ: false },
  { family: 'do', conjugateQuat: false, cameraMinusZ: true },
  { family: 'do', conjugateQuat: false, cameraMinusZ: false }
];

export function attitudeFromSnapshot(
  snap: PattoolCalSnapshot,
  cand: MethodCandidate
): CameraAttitude | null {
  const opt: AttitudeOptions = {
    conjugateQuat: cand.conjugateQuat,
    cameraMinusZ: cand.cameraMinusZ
  };
  if (cand.family === 'quat' && snap.quat && snap.quat.length >= 4) {
    return cameraFromEarthToDeviceQuat(
      { x: snap.quat[0], y: snap.quat[1], z: snap.quat[2], w: snap.quat[3] },
      opt
    );
  }
  if (
    cand.family === 'mag' &&
    snap.mag &&
    snap.accel &&
    Number.isFinite(snap.mag.x) &&
    Number.isFinite(snap.accel.x)
  ) {
    return cameraFromMagAccel(snap.mag, snap.accel, opt);
  }
  if (cand.family === 'do' && snap.orient?.alpha != null) {
    const alpha =
      snap.orient.webkit != null ? ((360 - snap.orient.webkit) % 360 + 360) % 360 : snap.orient.alpha;
    return cameraFromDeviceOrientation(alpha, snap.orient.beta ?? 0, snap.orient.gamma ?? 0, opt);
  }
  return null;
}

function poseOf(id: string): PattoolCalPose | undefined {
  return PATTOOL_POSES.find((p) => p.id === id);
}

function fitCandidate(
  samples: PattoolCalSnapshot[],
  cand: MethodCandidate
): { err: number; azOffsetDeg: number; elSign: 1 | -1 } | null {
  const azOffs: number[] = [];
  const elDots: number[] = [];
  const atts: { pose: PattoolCalPose; att: CameraAttitude }[] = [];
  for (const snap of samples) {
    const pose = poseOf(snap.poseId);
    const att = attitudeFromSnapshot(snap, cand);
    if (!pose || !att) {
      continue;
    }
    atts.push({ pose, att });
    if (pose.expectedAz != null) {
      azOffs.push(circularDiff(pose.expectedAz, att.azimuthDeg));
    }
    if (Math.abs(pose.expectedEl) > 45) {
      elDots.push(att.elevationDeg * pose.expectedEl);
    }
  }
  if (atts.length < 4) {
    return null;
  }
  const azOffsetDeg = wrapSignedDeg(azOffs.length ? circularMeanDeg(azOffs) : 0);
  const elSign: 1 | -1 = elDots.length && elDots.reduce((a, b) => a + b, 0) < 0 ? -1 : 1;
  let sum = 0;
  let n = 0;
  for (const { pose, att } of atts) {
    if (pose.expectedAz != null) {
      sum += Math.abs(circularDiff(att.azimuthDeg + azOffsetDeg, pose.expectedAz));
      n++;
    }
    sum += Math.abs(att.elevationDeg * elSign - pose.expectedEl);
    n++;
  }
  return { err: n ? sum / n : Infinity, azOffsetDeg, elSign };
}

export function snapshotFromPayload(p: {
  sessionId?: string;
  poseId: string;
  poseIndex?: number;
  expectedAz?: number | null;
  expectedEl?: number;
  capturedAt?: string;
  at?: string;
  quat?: number[] | null;
  mag?: Vec3 | null | Record<string, unknown>;
  accel?: Vec3 | null | Record<string, unknown>;
  gyro?: Vec3 | null | Record<string, unknown>;
  orient?: PattoolCalSnapshot['orient'];
  screenAngle?: number;
  gps?: PattoolCalSnapshot['gps'];
  computed?: PattoolCalSnapshot['computed'];
  extras?: Record<string, unknown>;
}): PattoolCalSnapshot {
  const vec = (v: Vec3 | null | Record<string, unknown> | undefined): Vec3 | null => {
    if (!v || typeof v !== 'object') {
      return null;
    }
    const x = Number((v as Vec3).x);
    const y = Number((v as Vec3).y);
    const z = Number((v as Vec3).z);
    if (![x, y, z].every(Number.isFinite)) {
      return null;
    }
    return { x, y, z };
  };
  return {
    sessionId: p.sessionId,
    poseId: p.poseId,
    poseIndex: p.poseIndex,
    expectedAz: p.expectedAz,
    expectedEl: p.expectedEl,
    at: p.capturedAt ?? p.at ?? '',
    quat: p.quat && p.quat.length >= 4 ? p.quat : null,
    mag: vec(p.mag),
    accel: vec(p.accel),
    gyro: vec(p.gyro),
    orient: p.orient ?? null,
    screenAngle: p.screenAngle ?? 0,
    gps: p.gps ?? { lat: null, lon: null, heading: null },
    computed: p.computed ?? { az: null, el: null, rl: null, source: null },
    extras: p.extras
  };
}

export function buildPattoolCalFile(
  samples: PattoolCalSnapshot[],
  userAgent = ''
): PattoolCalFile | null {
  const derived = derivePattoolCal(samples);
  if (!derived) {
    return null;
  }
  return {
    version: 1,
    calibratedAt: new Date().toISOString(),
    userAgent,
    samples,
    derived
  };
}

export function derivePattoolCal(samples: PattoolCalSnapshot[]): PattoolCalDerived | null {
  if (samples.length < 4) {
    return null;
  }
  let best: MethodCandidate | null = null;
  let bestFit: { err: number; azOffsetDeg: number; elSign: 1 | -1 } | null = null;
  const familyRank = (f: PattoolCalFamily): number => (f === 'quat' ? 0 : f === 'mag' ? 1 : 2);
  for (const cand of CANDIDATES) {
    const fit = fitCandidate(samples, cand);
    if (!fit) {
      continue;
    }
    const better =
      !bestFit ||
      fit.err + 0.5 * familyRank(cand.family) < bestFit.err + 0.5 * familyRank(best!.family);
    if (better) {
      bestFit = fit;
      best = cand;
    }
  }
  if (!best || !bestFit) {
    return null;
  }
  return {
    family: best.family,
    conjugateQuat: best.conjugateQuat,
    cameraMinusZ: best.cameraMinusZ,
    azOffsetDeg: Math.round(bestFit.azOffsetDeg),
    elSign: bestFit.elSign,
    meanErrDeg: Math.round(bestFit.err * 10) / 10
  };
}

export function loadPattoolCal(): PattoolCalFile | null {
  try {
    const raw = localStorage.getItem(PATTOOL_CAL_KEY);
    if (!raw) {
      return null;
    }
    const data = JSON.parse(raw) as PattoolCalFile;
    if (data?.version !== 1 || !data.derived || !Array.isArray(data.samples)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function savePattoolCal(file: PattoolCalFile): void {
  localStorage.setItem(PATTOOL_CAL_KEY, JSON.stringify(file));
}

export function clearPattoolCal(): void {
  localStorage.removeItem(PATTOOL_CAL_KEY);
}

export function loadManualAzOffset(): number {
  try {
    const raw = localStorage.getItem(MANUAL_AZ_OFFSET_KEY);
    if (raw == null || raw === '') {
      return 0;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(wrapSignedDeg(n)) : 0;
  } catch {
    return 0;
  }
}

export function saveManualAzOffset(deg: number): void {
  localStorage.setItem(MANUAL_AZ_OFFSET_KEY, String(Math.round(wrapSignedDeg(deg))));
}

export function clearManualAzOffset(): void {
  localStorage.removeItem(MANUAL_AZ_OFFSET_KEY);
}

export function averageVec(items: Vec3[]): Vec3 | null {
  if (!items.length) {
    return null;
  }
  const s = { x: 0, y: 0, z: 0 };
  for (const v of items) {
    s.x += v.x;
    s.y += v.y;
    s.z += v.z;
  }
  const n = items.length;
  return { x: s.x / n, y: s.y / n, z: s.z / n };
}

export function averageQuat(items: number[][]): number[] | null {
  if (!items.length) {
    return null;
  }
  const acc = [0, 0, 0, 0];
  const ref = items[0];
  for (const q of items) {
    const flip = q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0 ? -1 : 1;
    acc[0] += flip * q[0];
    acc[1] += flip * q[1];
    acc[2] += flip * q[2];
    acc[3] += flip * q[3];
  }
  const n = Math.hypot(acc[0], acc[1], acc[2], acc[3]);
  if (n < 1e-9) {
    return null;
  }
  return acc.map((v) => v / n);
}
