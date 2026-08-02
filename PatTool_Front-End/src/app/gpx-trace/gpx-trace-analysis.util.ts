/**
 * Parse a GPX file and extract every useful detail for the Monde « Trace GPX » page.
 */

export interface GpxTimedPoint {
  lat: number;
  lon: number;
  eleM?: number | null;
  timeIso?: string | null;
}

export interface GpxWaypointDetail {
  lat: number;
  lon: number;
  eleM?: number | null;
  name?: string | null;
  desc?: string | null;
  timeIso?: string | null;
  sym?: string | null;
}

export interface GpxBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface GpxAnalysis {
  fileName: string;
  fileSizeBytes: number;
  name: string | null;
  description: string | null;
  author: string | null;
  creator: string | null;
  keywords: string | null;
  metadataTimeIso: string | null;
  linkHref: string | null;
  linkText: string | null;
  trackCount: number;
  routeCount: number;
  waypointCount: number;
  segmentCount: number;
  trackPointCount: number;
  routePointCount: number;
  trackNames: string[];
  points: GpxTimedPoint[];
  waypoints: GpxWaypointDetail[];
  distanceM: number | null;
  elevationGainM: number | null;
  elevationLossM: number | null;
  elevMinM: number | null;
  elevMaxM: number | null;
  elevStartM: number | null;
  elevEndM: number | null;
  startLat: number | null;
  startLon: number | null;
  endLat: number | null;
  endLon: number | null;
  bounds: GpxBounds | null;
  startTimeIso: string | null;
  endTimeIso: string | null;
  durationSec: number | null;
  avgSpeedKmh: number | null;
  maxSpeedKmh: number | null;
  movingTimeSec: number | null;
  /** True when elevation profile was filled from a DEM (no ele in the GPX). */
  elevationFromDem?: boolean;
}

const ELEV_INTERPOLATE_MAX_GAP = 80;
/** Ignore speed spikes above this (km/h) — GPS noise / teleports. */
const MAX_PLAUSIBLE_SPEED_KMH = 100;
/** Pairwise raw fallback: ignore tiny consecutive steps (m) when no dense profile. */
const ELEV_PAIRWISE_MIN_STEP_M = 3;
/** Consecutive points farther than this (m) are treated as a gap (not moving distance). */
const MAX_SEGMENT_GAP_M = 5000;

function localName(el: Element): string {
  return (el.localName || el.tagName || '').toLowerCase();
}

function childText(parent: Element, name: string): string | null {
  for (let i = 0; i < parent.children.length; i++) {
    const ch = parent.children[i];
    if (localName(ch) === name) {
      const t = (ch.textContent || '').trim();
      return t || null;
    }
  }
  return null;
}

function normalizeIso(raw: string | null | undefined): string | null {
  const t = (raw || '').trim();
  if (!t) {
    return null;
  }
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString();
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function readEle(node: Element): number | null {
  const raw = childText(node, 'ele');
  if (raw == null) {
    return null;
  }
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : null;
}

function latLonFromNode(node: Element): { lat: number; lon: number } | null {
  const lat = parseFloat(node.getAttribute('lat') || '');
  const lon = parseFloat(node.getAttribute('lon') || '');
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return { lat, lon };
}

function pointFromNode(node: Element): GpxTimedPoint | null {
  const ll = latLonFromNode(node);
  if (!ll) {
    return null;
  }
  return {
    lat: ll.lat,
    lon: ll.lon,
    eleM: readEle(node),
    timeIso: normalizeIso(childText(node, 'time'))
  };
}

function waypointFromNode(node: Element): GpxWaypointDetail | null {
  const p = pointFromNode(node);
  if (!p) {
    return null;
  }
  return {
    ...p,
    name: childText(node, 'name'),
    desc: childText(node, 'desc'),
    sym: childText(node, 'sym')
  };
}

function movingAverage(values: number[], window: number): number[] {
  const w = Math.max(3, window % 2 === 0 ? window + 1 : window);
  if (values.length < w) {
    return values.slice();
  }
  const half = Math.floor(w / 2);
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      sum += values[j];
      c++;
    }
    out.push(sum / c);
  }
  return out;
}

function interpolateElevation(points: GpxTimedPoint[]): number[] | null {
  const raw: (number | null)[] = points.map((p) =>
    p.eleM != null && Number.isFinite(p.eleM) ? p.eleM : null
  );
  const n = raw.length;
  if (n < 2 || !raw.some((v) => v != null)) {
    return null;
  }
  const filled: (number | null)[] = raw.slice();
  let i = 0;
  while (i < n) {
    if (filled[i] != null) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && filled[i] == null) {
      i++;
    }
    const gapLen = i - start;
    const leftVal = start > 0 ? filled[start - 1] : null;
    const rightVal = i < n ? filled[i] : null;
    if (leftVal != null && rightVal != null) {
      if (gapLen > ELEV_INTERPOLATE_MAX_GAP) {
        return null;
      }
      for (let k = start; k < i; k++) {
        const t = (k - (start - 1)) / (i - (start - 1));
        filled[k] = leftVal + (rightVal - leftVal) * t;
      }
    } else if (leftVal != null && i === n) {
      for (let k = start; k < i; k++) {
        filled[k] = leftVal;
      }
    } else if (rightVal != null && start === 0) {
      for (let k = start; k < i; k++) {
        filled[k] = rightVal;
      }
    } else {
      return null;
    }
  }
  if (!filled.every((v) => v != null && Number.isFinite(v!))) {
    return null;
  }
  return filled as number[];
}

function computeElevationGainLoss(points: GpxTimedPoint[]): {
  gainM: number | null;
  lossM: number | null;
} {
  const dense = interpolateElevation(points);
  if (dense != null && dense.length >= 2) {
    // Sum every signed step after smoothing (no per-step floor: dense tracks
    // often have Δh ≪ 1 m between consecutive smoothed samples).
    const win =
      dense.length >= 200 ? 21 : dense.length >= 80 ? 15 : dense.length >= 35 ? 11 : 0;
    const sm = win >= 5 ? movingAverage(dense, win) : dense;
    let gain = 0;
    let loss = 0;
    for (let j = 1; j < sm.length; j++) {
      const d = sm[j] - sm[j - 1];
      if (d > 0) {
        gain += d;
      } else if (d < 0) {
        loss += -d;
      }
    }
    return { gainM: Math.round(gain), lossM: Math.round(loss) };
  }

  let gain = 0;
  let loss = 0;
  let any = false;
  for (let j = 1; j < points.length; j++) {
    const a = points[j - 1].eleM;
    const b = points[j].eleM;
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) {
      continue;
    }
    any = true;
    const d = b - a;
    if (d > ELEV_PAIRWISE_MIN_STEP_M) {
      gain += d;
    } else if (d < -ELEV_PAIRWISE_MIN_STEP_M) {
      loss += -d;
    }
  }
  return any ? { gainM: Math.round(gain), lossM: Math.round(loss) } : { gainM: null, lossM: null };
}

function computeDistanceM(points: GpxTimedPoint[]): number | null {
  if (points.length < 2) {
    return null;
  }
  let m = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = haversineMeters(
      points[i - 1].lat,
      points[i - 1].lon,
      points[i].lat,
      points[i].lon
    );
    if (seg <= MAX_SEGMENT_GAP_M) {
      m += seg;
    }
  }
  return m;
}

function emptyAnalysis(fileName: string, fileSizeBytes: number): GpxAnalysis {
  return {
    fileName,
    fileSizeBytes,
    name: null,
    description: null,
    author: null,
    creator: null,
    keywords: null,
    metadataTimeIso: null,
    linkHref: null,
    linkText: null,
    trackCount: 0,
    routeCount: 0,
    waypointCount: 0,
    segmentCount: 0,
    trackPointCount: 0,
    routePointCount: 0,
    trackNames: [],
    points: [],
    waypoints: [],
    distanceM: null,
    elevationGainM: null,
    elevationLossM: null,
    elevMinM: null,
    elevMaxM: null,
    elevStartM: null,
    elevEndM: null,
    startLat: null,
    startLon: null,
    endLat: null,
    endLon: null,
    bounds: null,
    startTimeIso: null,
    endTimeIso: null,
    durationSec: null,
    avgSpeedKmh: null,
    maxSpeedKmh: null,
    movingTimeSec: null
  };
}

export function analyzeGpxFileContent(
  fileName: string,
  text: string,
  fileSizeBytes: number
): GpxAnalysis {
  const out = emptyAnalysis(fileName, fileSizeBytes);
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'application/xml');
  if (xml.getElementsByTagName('parsererror').length) {
    return out;
  }

  const gpxRoot =
    xml.documentElement && localName(xml.documentElement) === 'gpx'
      ? xml.documentElement
      : null;
  if (gpxRoot) {
    out.creator = (gpxRoot.getAttribute('creator') || '').trim() || null;
  }

  const metadataNodes = xml.getElementsByTagName('metadata');
  if (metadataNodes.length > 0) {
    const md = metadataNodes.item(0)!;
    out.name = out.name || childText(md, 'name');
    out.description = out.description || childText(md, 'desc');
    out.keywords = childText(md, 'keywords');
    out.metadataTimeIso = normalizeIso(childText(md, 'time'));
    const authorEl = Array.from(md.children).find((c) => localName(c) === 'author');
    if (authorEl) {
      out.author =
        childText(authorEl, 'name') ||
        (authorEl.textContent || '').trim() ||
        null;
    }
    const linkEl = Array.from(md.children).find((c) => localName(c) === 'link');
    if (linkEl) {
      out.linkHref = (linkEl.getAttribute('href') || '').trim() || null;
      out.linkText = childText(linkEl, 'text');
    }
  }

  const tracks = xml.getElementsByTagName('trk');
  out.trackCount = tracks.length;
  const trackPoints: GpxTimedPoint[] = [];
  for (let t = 0; t < tracks.length; t++) {
    const trk = tracks.item(t)!;
    const tName = childText(trk, 'name');
    if (tName) {
      out.trackNames.push(tName);
    }
    if (!out.name && tName) {
      out.name = tName;
    }
    if (!out.description) {
      out.description = childText(trk, 'desc');
    }
    const segs = trk.getElementsByTagName('trkseg');
    out.segmentCount += segs.length;
    const pts = trk.getElementsByTagName('trkpt');
    for (let i = 0; i < pts.length; i++) {
      const p = pointFromNode(pts.item(i)!);
      if (p) {
        trackPoints.push(p);
      }
    }
  }
  out.trackPointCount = trackPoints.length;

  const routes = xml.getElementsByTagName('rte');
  out.routeCount = routes.length;
  const routePoints: GpxTimedPoint[] = [];
  for (let r = 0; r < routes.length; r++) {
    const rte = routes.item(r)!;
    const rName = childText(rte, 'name');
    if (rName) {
      out.trackNames.push(rName);
    }
    if (!out.name && rName) {
      out.name = rName;
    }
    const pts = rte.getElementsByTagName('rtept');
    for (let i = 0; i < pts.length; i++) {
      const p = pointFromNode(pts.item(i)!);
      if (p) {
        routePoints.push(p);
      }
    }
  }
  out.routePointCount = routePoints.length;

  const wpts = xml.getElementsByTagName('wpt');
  out.waypointCount = wpts.length;
  for (let i = 0; i < wpts.length; i++) {
    const w = waypointFromNode(wpts.item(i)!);
    if (w) {
      out.waypoints.push(w);
    }
  }

  // Prefer track geometry; fall back to route points.
  out.points = trackPoints.length > 0 ? trackPoints : routePoints;

  if (out.points.length === 0) {
    applyEmbeddedTrackStats(out, extractEmbeddedTrackStats(xml));
    return out;
  }

  applyPointDerivedStats(out);
  applyEmbeddedTrackStats(out, extractEmbeddedTrackStats(xml));
  return out;
}

/** True when the track has geometry but no usable elevation profile in the file. */
export function analysisNeedsDemElevation(a: GpxAnalysis): boolean {
  if (!a || a.points.length < 2) {
    return false;
  }
  if (a.elevationGainM != null && a.elevMinM != null) {
    return false;
  }
  return !a.points.some((p) => p.eleM != null && Number.isFinite(p.eleM));
}

/** Evenly sample track points for a DEM elevation lookup (Open-Meteo batches ~100). */
export function sampleLatLonsForElevation(
  points: GpxTimedPoint[],
  maxSamples = 80
): { lat: number; lon: number; index: number }[] {
  if (!points.length) {
    return [];
  }
  const indices = sampleIndices(points.length, Math.max(2, Math.min(maxSamples, 100)));
  return indices.map((index) => ({
    lat: points[index].lat,
    lon: points[index].lon,
    index
  }));
}

/**
 * Fill missing point elevations from a DEM sample set, then recompute elev stats.
 * `altitudesM[i]` corresponds to `samples[i]`.
 */
export function enrichAnalysisWithDemElevations(
  analysis: GpxAnalysis,
  samples: { lat: number; lon: number; index: number }[],
  altitudesM: (number | null | undefined)[]
): GpxAnalysis {
  if (!analysis.points.length || samples.length === 0) {
    return analysis;
  }
  const elevByIndex = new Map<number, number>();
  for (let i = 0; i < samples.length; i++) {
    const alt = altitudesM[i];
    if (alt != null && Number.isFinite(alt)) {
      elevByIndex.set(samples[i].index, alt);
    }
  }
  if (elevByIndex.size === 0) {
    return analysis;
  }

  const sortedIdx = [...elevByIndex.keys()].sort((a, b) => a - b);
  for (let s = 0; s < sortedIdx.length; s++) {
    const i0 = sortedIdx[s];
    const e0 = elevByIndex.get(i0)!;
    analysis.points[i0].eleM = e0;
    if (s + 1 >= sortedIdx.length) {
      continue;
    }
    const i1 = sortedIdx[s + 1];
    const e1 = elevByIndex.get(i1)!;
    const span = i1 - i0;
    if (span <= 1) {
      continue;
    }
    for (let k = i0 + 1; k < i1; k++) {
      const t = (k - i0) / span;
      analysis.points[k].eleM = e0 + (e1 - e0) * t;
    }
  }
  // Leading / trailing gaps: extend nearest known sample.
  const firstKnown = sortedIdx[0];
  const lastKnown = sortedIdx[sortedIdx.length - 1];
  const firstEle = elevByIndex.get(firstKnown)!;
  const lastEle = elevByIndex.get(lastKnown)!;
  for (let k = 0; k < firstKnown; k++) {
    analysis.points[k].eleM = firstEle;
  }
  for (let k = lastKnown + 1; k < analysis.points.length; k++) {
    analysis.points[k].eleM = lastEle;
  }

  recomputeElevationStats(analysis);
  analysis.elevationFromDem = true;
  return analysis;
}

export function isGpxFileName(fileName: string): boolean {
  return /\.gpx$/i.test(fileName || '');
}

function sampleIndices(n: number, maxSamples: number): number[] {
  if (n <= maxSamples) {
    return Array.from({ length: n }, (_, i) => i);
  }
  const out: number[] = [0];
  for (let s = 1; s < maxSamples - 1; s++) {
    out.push(Math.round((s * (n - 1)) / (maxSamples - 1)));
  }
  out.push(n - 1);
  return [...new Set(out)].sort((a, b) => a - b);
}

function applyPointDerivedStats(out: GpxAnalysis): void {
  out.startLat = out.points[0].lat;
  out.startLon = out.points[0].lon;
  out.endLat = out.points[out.points.length - 1].lat;
  out.endLon = out.points[out.points.length - 1].lon;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of out.points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  out.bounds = { minLat, maxLat, minLon, maxLon };

  out.distanceM = computeDistanceM(out.points);
  recomputeElevationStats(out);

  let startMs: number | null = null;
  let endMs: number | null = null;
  for (const p of out.points) {
    if (!p.timeIso) {
      continue;
    }
    const ms = Date.parse(p.timeIso);
    if (Number.isNaN(ms)) {
      continue;
    }
    if (startMs == null || ms < startMs) {
      startMs = ms;
    }
    if (endMs == null || ms > endMs) {
      endMs = ms;
    }
  }
  if (startMs != null) {
    out.startTimeIso = new Date(startMs).toISOString();
  }
  if (endMs != null) {
    out.endTimeIso = new Date(endMs).toISOString();
  }
  if (startMs != null && endMs != null && endMs > startMs) {
    out.durationSec = Math.round((endMs - startMs) / 1000);
  }

  let maxSpeed = 0;
  let movingSec = 0;
  for (let i = 1; i < out.points.length; i++) {
    const a = out.points[i - 1];
    const b = out.points[i];
    if (!a.timeIso || !b.timeIso) {
      continue;
    }
    const t0 = Date.parse(a.timeIso);
    const t1 = Date.parse(b.timeIso);
    if (Number.isNaN(t0) || Number.isNaN(t1) || t1 <= t0) {
      continue;
    }
    const dtH = (t1 - t0) / 3600000;
    const distM = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    if (distM > MAX_SEGMENT_GAP_M || dtH <= 0) {
      continue;
    }
    const speed = distM / 1000 / dtH;
    if (speed > 0.5) {
      movingSec += (t1 - t0) / 1000;
    }
    if (speed > maxSpeed && speed <= MAX_PLAUSIBLE_SPEED_KMH) {
      maxSpeed = speed;
    }
  }
  out.maxSpeedKmh = maxSpeed > 0 ? Math.round(maxSpeed * 10) / 10 : null;
  out.movingTimeSec = movingSec > 0 ? Math.round(movingSec) : null;

  if (out.distanceM != null && out.durationSec != null && out.durationSec > 0) {
    out.avgSpeedKmh = Math.round((out.distanceM / 1000 / (out.durationSec / 3600)) * 10) / 10;
  }
}

function recomputeElevationStats(out: GpxAnalysis): void {
  let elevMin: number | null = null;
  let elevMax: number | null = null;
  for (const p of out.points) {
    if (p.eleM != null && Number.isFinite(p.eleM)) {
      elevMin = elevMin == null ? p.eleM : Math.min(elevMin, p.eleM);
      elevMax = elevMax == null ? p.eleM : Math.max(elevMax, p.eleM);
    }
  }
  out.elevMinM = elevMin != null ? Math.round(elevMin) : null;
  out.elevMaxM = elevMax != null ? Math.round(elevMax) : null;
  out.elevStartM =
    out.points[0]?.eleM != null && Number.isFinite(out.points[0].eleM)
      ? Math.round(out.points[0].eleM)
      : null;
  const last = out.points[out.points.length - 1];
  out.elevEndM =
    last?.eleM != null && Number.isFinite(last.eleM) ? Math.round(last.eleM) : null;
  const elev = computeElevationGainLoss(out.points);
  out.elevationGainM = elev.gainM;
  out.elevationLossM = elev.lossM;
}

interface EmbeddedTrackStats {
  distanceM: number | null;
  elevationGainM: number | null;
  elevationLossM: number | null;
  durationSec: number | null;
  movingTimeSec: number | null;
  avgSpeedKmh: number | null;
  maxSpeedKmh: number | null;
}

/** Garmin TrackStatsExtension / ClueTrust gpxdata summary tags when present in the file. */
function extractEmbeddedTrackStats(xml: Document): EmbeddedTrackStats {
  const empty: EmbeddedTrackStats = {
    distanceM: null,
    elevationGainM: null,
    elevationLossM: null,
    durationSec: null,
    movingTimeSec: null,
    avgSpeedKmh: null,
    maxSpeedKmh: null
  };
  const all = xml.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all.item(i)!;
    const name = localName(el);
    const raw = (el.textContent || '').trim();
    if (!raw) {
      continue;
    }
    const num = parseFloat(raw);
    if (!Number.isFinite(num)) {
      continue;
    }
    switch (name) {
      case 'distance':
        // Garmin TrackStats / gpxdata store metres.
        if (empty.distanceM == null && num > 0) {
          empty.distanceM = num;
        }
        break;
      case 'ascent':
      case 'elevationgain':
      case 'totalascent':
        if (empty.elevationGainM == null) {
          empty.elevationGainM = Math.round(num);
        }
        break;
      case 'descent':
      case 'elevationloss':
      case 'totaldescent':
        if (empty.elevationLossM == null) {
          empty.elevationLossM = Math.round(num);
        }
        break;
      case 'movingtime':
      case 'timertime':
        if (empty.movingTimeSec == null && num > 0) {
          empty.movingTimeSec = Math.round(num);
        }
        if (empty.durationSec == null && name === 'timertime' && num > 0) {
          empty.durationSec = Math.round(num);
        }
        break;
      case 'totaltime':
      case 'elapsedtime':
        if (empty.durationSec == null && num > 0) {
          empty.durationSec = Math.round(num);
        }
        break;
      case 'maxspeed': {
        // Garmin stores m/s; values > 80 are already km/h.
        if (empty.maxSpeedKmh == null && num > 0) {
          empty.maxSpeedKmh = Math.round((num > 80 ? num : num * 3.6) * 10) / 10;
        }
        break;
      }
      case 'avgspeed':
      case 'averagespeed': {
        if (empty.avgSpeedKmh == null && num > 0) {
          empty.avgSpeedKmh = Math.round((num > 80 ? num : num * 3.6) * 10) / 10;
        }
        break;
      }
      default:
        break;
    }
  }
  return empty;
}

function applyEmbeddedTrackStats(out: GpxAnalysis, emb: EmbeddedTrackStats): void {
  if (out.distanceM == null && emb.distanceM != null) {
    out.distanceM = emb.distanceM;
  }
  if (out.elevationGainM == null && emb.elevationGainM != null) {
    out.elevationGainM = emb.elevationGainM;
  }
  if (out.elevationLossM == null && emb.elevationLossM != null) {
    out.elevationLossM = emb.elevationLossM;
  }
  if (out.durationSec == null && emb.durationSec != null) {
    out.durationSec = emb.durationSec;
  }
  if (out.movingTimeSec == null && emb.movingTimeSec != null) {
    out.movingTimeSec = emb.movingTimeSec;
  }
  if (out.maxSpeedKmh == null && emb.maxSpeedKmh != null) {
    out.maxSpeedKmh = emb.maxSpeedKmh;
  }
  if (out.avgSpeedKmh == null && emb.avgSpeedKmh != null) {
    out.avgSpeedKmh = emb.avgSpeedKmh;
  } else if (
    out.avgSpeedKmh == null &&
    out.distanceM != null &&
    out.durationSec != null &&
    out.durationSec > 0
  ) {
    out.avgSpeedKmh = Math.round((out.distanceM / 1000 / (out.durationSec / 3600)) * 10) / 10;
  }
}
