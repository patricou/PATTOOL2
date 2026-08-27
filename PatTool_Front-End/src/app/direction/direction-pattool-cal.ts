import {
  AttitudeOptions,
  CameraAttitude,
  Vec3,
  cameraElevationFromGravity,
  cameraFromDeviceOrientation,
  cameraFromEarthToDeviceQuat,
  cameraFromMagAccel,
  circularDiff,
  circularMeanDeg,
  normalizeDeg,
  wrapSignedDeg
} from './direction-attitude';

export const PATTOOL_CAL_KEY = 'pat.direction.pattool-cal.v2';
/** Décalage azimut manuel (page Calibrage + bouton « C’est le Nord » du viseur). */
export const MANUAL_AZ_OFFSET_KEY = 'pat.direction.az-offset.v1';
/** Décalage élévation manuel (bouton « Position exacte » du viseur). */
export const MANUAL_EL_OFFSET_KEY = 'pat.direction.el-offset.v1';

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
    id: 'tilt',
    titleKey: 'DIRECTION.PAT_TILT_TITLE',
    hintKey: 'DIRECTION.PAT_TILT_HINT',
    expectedAz: null,
    expectedEl: 45
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
export type PattoolCalMixMode = 'latest' | 'average';

export const PATTOOL_CAL_MIX_KEY = 'pat.direction.pattool-cal-mix.v1';

export interface PattoolCalDerived {
  family: PattoolCalFamily;
  conjugateQuat: boolean;
  cameraMinusZ: boolean;
  azOffsetDeg: number;
  elSign: 1 | -1;
  meanErrDeg: number;
  /** Élévation : gravité si elle colle mieux aux poses que le quaternion. */
  elSource?: 'gravity' | 'attitude';
  /** Ajouté à l’élévation mesurée (degrés). */
  elOffsetDeg?: number;
}

export interface PattoolCalFile {
  version: 1;
  calibratedAt: string;
  userAgent: string;
  samples: PattoolCalSnapshot[];
  derived: PattoolCalDerived;
  mixMode?: PattoolCalMixMode;
  seriesCount?: number;
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

function poseMatchesGravity(snap: PattoolCalSnapshot, pose: PattoolCalPose): boolean {
  if (!snap.accel) {
    return true;
  }
  const g = cameraElevationFromGravity(snap.accel);
  if (g == null) {
    return true;
  }
  return Math.abs(g - pose.expectedEl) <= 35;
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
    if (!pose || !att || !poseMatchesGravity(snap, pose)) {
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
  userAgent = '',
  mixMode: PattoolCalMixMode = loadPattoolCalMixMode()
): PattoolCalFile | null {
  const derived = derivePattoolCalMixed(samples, mixMode);
  if (!derived) {
    return null;
  }
  return {
    version: 1,
    calibratedAt: new Date().toISOString(),
    userAgent,
    samples,
    derived,
    mixMode,
    seriesCount: usableCalSeries(samples).length
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
  const extra = deriveElevationFromSamples(samples, best, bestFit.elSign);
  return {
    family: best.family,
    conjugateQuat: best.conjugateQuat,
    cameraMinusZ: best.cameraMinusZ,
    azOffsetDeg: Math.round(bestFit.azOffsetDeg),
    elSign: bestFit.elSign,
    meanErrDeg: Math.round(bestFit.err * 10) / 10,
    elSource: extra.elSource,
    elOffsetDeg: extra.elOffsetDeg
  };
}

export function groupSnapshotsBySession(samples: PattoolCalSnapshot[]): PattoolCalSnapshot[][] {
  const bySession = new Map<string, PattoolCalSnapshot[]>();
  for (const s of samples) {
    const id = s.sessionId || '_';
    const arr = bySession.get(id) ?? [];
    arr.push(s);
    bySession.set(id, arr);
  }
  return [...bySession.values()];
}

function sessionTimeMs(snaps: PattoolCalSnapshot[]): number {
  let t = 0;
  for (const s of snaps) {
    const n = Date.parse(s.at);
    if (Number.isFinite(n) && n > t) {
      t = n;
    }
  }
  return t;
}

/** Séries dont on arrive à dériver un calibrage (≥ 4 poses cohérentes). */
export function usableCalSeries(samples: PattoolCalSnapshot[]): PattoolCalSnapshot[][] {
  return groupSnapshotsBySession(samples).filter((s) => !!derivePattoolCal(s));
}

export function derivePattoolCalMixed(
  samples: PattoolCalSnapshot[],
  mode: PattoolCalMixMode = 'latest'
): PattoolCalDerived | null {
  const series = usableCalSeries(samples);
  if (!series.length) {
    return derivePattoolCal(samples);
  }
  if (mode !== 'average' || series.length === 1) {
    const latest = series.reduce((a, b) => (sessionTimeMs(b) >= sessionTimeMs(a) ? b : a));
    return derivePattoolCal(latest);
  }
  const derived: PattoolCalDerived[] = [];
  for (const snaps of series) {
    const d = derivePattoolCal(snaps);
    if (d) {
      derived.push(d);
    }
  }
  return averageDerived(derived);
}

function averageDerived(list: PattoolCalDerived[]): PattoolCalDerived | null {
  if (!list.length) {
    return null;
  }
  if (list.length === 1) {
    return list[0];
  }
  const keyOf = (d: PattoolCalDerived) =>
    `${d.family}|${d.conjugateQuat ? 1 : 0}|${d.cameraMinusZ ? 1 : 0}`;
  const votes = new Map<string, number>();
  for (const d of list) {
    const k = keyOf(d);
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  const bestKey = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const same = list.filter((d) => keyOf(d) === bestKey);
  const proto = same[0];
  const elSign: 1 | -1 = same.filter((d) => d.elSign === -1).length > same.length / 2 ? -1 : 1;
  const gravityN = same.filter((d) => d.elSource === 'gravity').length;
  return {
    family: proto.family,
    conjugateQuat: proto.conjugateQuat,
    cameraMinusZ: proto.cameraMinusZ,
    azOffsetDeg: Math.round(wrapSignedDeg(circularMeanDeg(same.map((d) => d.azOffsetDeg)))),
    elSign,
    meanErrDeg: Math.round((same.reduce((s, d) => s + d.meanErrDeg, 0) / same.length) * 10) / 10,
    elSource: gravityN * 2 >= same.length ? 'gravity' : proto.elSource ?? 'attitude',
    elOffsetDeg: Math.round(same.reduce((s, d) => s + (d.elOffsetDeg ?? 0), 0) / same.length)
  };
}

function deriveElevationFromSamples(
  samples: PattoolCalSnapshot[],
  cand: MethodCandidate,
  elSign: 1 | -1
): { elSource: 'gravity' | 'attitude'; elOffsetDeg: number } {
  let gErr = 0;
  let aErr = 0;
  let gN = 0;
  const offs: number[] = [];
  for (const snap of samples) {
    const pose = poseOf(snap.poseId);
    const att = attitudeFromSnapshot(snap, cand);
    if (!pose || !att || !poseMatchesGravity(snap, pose)) {
      continue;
    }
    const attEl = att.elevationDeg * elSign;
    const g = snap.accel ? cameraElevationFromGravity(snap.accel) : null;
    aErr += Math.abs(attEl - pose.expectedEl);
    if (g != null) {
      gErr += Math.abs(g - pose.expectedEl);
      gN++;
    }
    const measured = g != null ? g : attEl;
    offs.push(pose.expectedEl - measured);
  }
  const elSource: 'gravity' | 'attitude' = gN >= 2 && gErr <= aErr ? 'gravity' : 'attitude';
  const elOffsetDeg = offs.length
    ? Math.round(offs.reduce((a, b) => a + b, 0) / offs.length)
    : 0;
  return { elSource, elOffsetDeg };
}

export function snapshotsFromExport(raw: unknown): PattoolCalSnapshot[] {
  const obj = raw as { samples?: unknown[] };
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(obj?.samples)
      ? obj.samples
      : [];
  return list
    .map((s) => snapshotFromPayload(s as Parameters<typeof snapshotFromPayload>[0]))
    .filter((s) => !!s.poseId);
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

/** Recalcule et mémorise le calibrage à partir des poses (base ou import). */
export function persistPattoolCalFromSamples(
  samples: PattoolCalSnapshot[],
  userAgent = '',
  mixMode?: PattoolCalMixMode
): PattoolCalFile | null {
  if (samples.length < 4) {
    return null;
  }
  const file = buildPattoolCalFile(samples, userAgent, mixMode ?? loadPattoolCalMixMode());
  if (!file) {
    return null;
  }
  savePattoolCal(file);
  clearManualAzOffset();
  clearManualElOffset();
  return file;
}

export function lookAzOffsetDeg(cal?: PattoolCalDerived | null): number {
  const d = cal === undefined ? loadPattoolCal()?.derived : cal;
  return d?.azOffsetDeg ?? 0;
}

export function lookElOffsetDeg(cal?: PattoolCalDerived | null): number {
  const d = cal === undefined ? loadPattoolCal()?.derived : cal;
  return d?.elOffsetDeg ?? 0;
}

/**
 * Nord vrai : on ajoute la déclinaison au cap magnétique *avant* l’offset de calage.
 * Direction et le viseur doivent passer par ici, sinon « C’est le Nord » décale le viseur.
 */
export function applyLookDeclination(
  rawAzDeg: number,
  trueNorth: boolean,
  declinationDeg?: number | null
): number {
  if (trueNorth && declinationDeg != null && Number.isFinite(declinationDeg)) {
    return normalizeDeg(rawAzDeg + declinationDeg);
  }
  return normalizeDeg(rawAzDeg);
}

/** Un seul décalage d’azimut : capteur (évent. + déclinaison) + calibrage. */
export function composeLookAzimuth(rawAzDeg: number, cal?: PattoolCalDerived | null): number {
  return normalizeDeg(rawAzDeg + lookAzOffsetDeg(cal));
}

/** Un seul décalage d’élévation : mesure (gravité / attitude) + calibrage. */
export function composeLookElevation(rawElDeg: number, cal?: PattoolCalDerived | null): number {
  return rawElDeg + lookElOffsetDeg(cal);
}

export function ensurePattoolCalStub(): PattoolCalFile {
  const existing = loadPattoolCal();
  if (existing) {
    return existing;
  }
  const file: PattoolCalFile = {
    version: 1,
    calibratedAt: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    samples: [],
    derived: {
      family: 'quat',
      conjugateQuat: false,
      cameraMinusZ: true,
      azOffsetDeg: 0,
      elSign: 1,
      meanErrDeg: 0,
      elSource: 'gravity',
      elOffsetDeg: 0
    },
    mixMode: loadPattoolCalMixMode(),
    seriesCount: 0
  };
  savePattoolCal(file);
  return file;
}

export function patchLookOffsets(partial: { azOffsetDeg?: number; elOffsetDeg?: number }): PattoolCalFile {
  const file = ensurePattoolCalStub();
  if (partial.azOffsetDeg != null && Number.isFinite(partial.azOffsetDeg)) {
    file.derived.azOffsetDeg = Math.round(wrapSignedDeg(partial.azOffsetDeg));
  }
  if (partial.elOffsetDeg != null && Number.isFinite(partial.elOffsetDeg)) {
    file.derived.elOffsetDeg = Math.round(partial.elOffsetDeg);
  }
  file.calibratedAt = new Date().toISOString();
  savePattoolCal(file);
  return file;
}

/** « Cette visée = cette cible » : remplace l’offset, ne l’empile pas. */
export function setLookFromRawToTarget(
  rawAzDeg: number,
  targetAzDeg: number,
  rawElDeg?: number | null,
  targetElDeg?: number | null
): PattoolCalFile {
  const file = ensurePattoolCalStub();
  file.derived.azOffsetDeg = wrapSignedDeg(targetAzDeg - rawAzDeg);
  if (rawElDeg != null && targetElDeg != null && Number.isFinite(rawElDeg) && Number.isFinite(targetElDeg)) {
    file.derived.elOffsetDeg = targetElDeg - rawElDeg;
  }
  file.calibratedAt = new Date().toISOString();
  savePattoolCal(file);
  return file;
}

export function resetLookOffsetsFromSamples(): PattoolCalFile | null {
  const file = loadPattoolCal();
  if (file?.samples && file.samples.length >= 4) {
    return persistPattoolCalFromSamples(file.samples, file.userAgent, file.mixMode);
  }
  return patchLookOffsets({ azOffsetDeg: 0, elOffsetDeg: 0 });
}

export function sameCalSampleSet(
  a?: PattoolCalSnapshot[] | null,
  b?: PattoolCalSnapshot[] | null
): boolean {
  if (!a?.length && !b?.length) {
    return true;
  }
  if (!a?.length || !b?.length || a.length !== b.length) {
    return false;
  }
  const sig = (s: PattoolCalSnapshot): string =>
    `${s.sessionId ?? ''}|${s.poseId}|${s.at}|${(s.quat ?? []).map((n) => n.toFixed(5)).join(',')}`;
  const sa = a.map(sig).sort();
  const sb = b.map(sig).sort();
  return sa.every((v, i) => v === sb[i]);
}

function leftoverManualOffset(): { az: number; el: number } | null {
  const az = loadManualAzOffset();
  const el = loadManualElOffset();
  if (az === 0 && el === 0) {
    return null;
  }
  return { az, el };
}

/** Une seule source d’azimut/élévation. Les poses ne sont recalculées que pour défaire l’ancien empilement. */
export function canonicalizeLookCal(): PattoolCalFile | null {
  const leftover = leftoverManualOffset();
  const file = loadPattoolCal();
  if (leftover && file?.samples && file.samples.length >= 4) {
    return persistPattoolCalFromSamples(file.samples, file.userAgent, file.mixMode);
  }
  if (leftover) {
    foldLegacyManualOffsets();
  }
  return loadPattoolCal();
}

/** Ancien offset « Nord » empilé par-dessus les poses : on le fusionne une fois. */
export function foldLegacyManualOffsets(): void {
  const az = loadManualAzOffset();
  const el = loadManualElOffset();
  if (az === 0 && el === 0) {
    return;
  }
  const file = ensurePattoolCalStub();
  file.derived.azOffsetDeg = Math.round(wrapSignedDeg(file.derived.azOffsetDeg + az));
  file.derived.elOffsetDeg = Math.round((file.derived.elOffsetDeg ?? 0) + el);
  savePattoolCal(file);
  clearManualAzOffset();
  clearManualElOffset();
}

export function clearPattoolCal(): void {
  localStorage.removeItem(PATTOOL_CAL_KEY);
}

export function loadPattoolCalMixMode(fallback?: PattoolCalMixMode): PattoolCalMixMode {
  try {
    const raw = localStorage.getItem(PATTOOL_CAL_MIX_KEY);
    if (raw === 'average' || raw === 'latest') {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return fallback === 'average' ? 'average' : 'latest';
}

export function savePattoolCalMixMode(mode: PattoolCalMixMode): void {
  localStorage.setItem(PATTOOL_CAL_MIX_KEY, mode === 'average' ? 'average' : 'latest');
}

export function mergeCalSamples(
  prev: PattoolCalSnapshot[],
  incoming: PattoolCalSnapshot[]
): PattoolCalSnapshot[] {
  const ids = new Set(incoming.map((s) => s.sessionId || '_'));
  return [...prev.filter((s) => !ids.has(s.sessionId || '_')), ...incoming];
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

export function loadManualElOffset(): number {
  try {
    const raw = localStorage.getItem(MANUAL_EL_OFFSET_KEY);
    if (raw == null || raw === '') {
      return 0;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(wrapSignedDeg(n)) : 0;
  } catch {
    return 0;
  }
}

export function saveManualElOffset(deg: number): void {
  localStorage.setItem(MANUAL_EL_OFFSET_KEY, String(Math.round(wrapSignedDeg(deg))));
}

export function clearManualElOffset(): void {
  localStorage.removeItem(MANUAL_EL_OFFSET_KEY);
}

/** Offsets pour que la visée capteur courante coïncide avec l’astre réel au pointeur. */
export function sightingOffsetsFromLook(
  magAzimuthDeg: number,
  rawElevationDeg: number,
  targetAzDeg: number,
  targetElDeg: number,
  pattoolAzOffsetDeg = 0
): { azOffsetDeg: number; elOffsetDeg: number } {
  return {
    azOffsetDeg: wrapSignedDeg(targetAzDeg - (magAzimuthDeg + pattoolAzOffsetDeg)),
    elOffsetDeg: wrapSignedDeg(targetElDeg - rawElevationDeg)
  };
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
