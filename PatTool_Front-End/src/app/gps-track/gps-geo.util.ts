/** Geometry helpers for the Monde GPS follow page. */

export interface GpsTrackPt {
  lat: number;
  lon: number;
  eleM?: number | null;
  /** First point after a pause — do not join to the previous sample. */
  gapBefore?: boolean;
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function cumulativeDistancesM(points: GpsTrackPt[]): number[] {
  const out = [0];
  let along = 0;
  for (let i = 1; i < points.length; i++) {
    along += haversineMeters(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    out.push(along);
  }
  return out;
}

export function nearestTrackIndex(points: GpsTrackPt[], lat: number, lon: number): number {
  if (!points.length) {
    return 0;
  }
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = haversineMeters(lat, lon, points[i].lat, points[i].lon);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return bestI;
}

/** Grade of the imported track around `index`, looking ~30 m ahead (or behind near the end). */
export function trackSlopeAt(
  points: GpsTrackPt[],
  index: number,
  targetM = 30,
  minM = 8
): { pct: number; deg: number } | null {
  if (!points.length) {
    return null;
  }
  const i = Math.max(0, Math.min(index, points.length - 1));
  const start = points[i];
  const startEle = start.eleM;
  if (startEle == null || !Number.isFinite(startEle)) {
    return null;
  }

  const sample = (dir: 1 | -1): { dist: number; ele: number } | null => {
    let dist = 0;
    let last = start;
    let k = i;
    while (true) {
      const n = k + dir;
      if (n < 0 || n >= points.length) {
        break;
      }
      const p = points[n];
      dist += haversineMeters(last.lat, last.lon, p.lat, p.lon);
      last = p;
      k = n;
      if (dist >= targetM) {
        break;
      }
    }
    const ele = last.eleM;
    if (dist < minM || ele == null || !Number.isFinite(ele)) {
      return null;
    }
    return { dist, ele };
  };

  const fwd = sample(1);
  const hit = fwd ?? sample(-1);
  if (!hit) {
    return null;
  }
  const rise = fwd ? hit.ele - startEle : startEle - hit.ele;
  const pct = (rise / hit.dist) * 100;
  const deg = (Math.atan(rise / hit.dist) * 180) / Math.PI;
  return { pct, deg };
}

export function elevationGainLoss(points: GpsTrackPt[]): { gainM: number; lossM: number } {
  let gain = 0;
  let loss = 0;
  let prev: number | null = null;
  for (const p of points) {
    if (p.gapBefore) {
      prev = null;
    }
    const ele = p.eleM;
    if (ele == null || !Number.isFinite(ele)) {
      continue;
    }
    if (prev != null) {
      const d = ele - prev;
      if (d > 0.4) {
        gain += d;
      } else if (d < -0.4) {
        loss += -d;
      }
    }
    prev = ele;
  }
  return { gainM: gain, lossM: loss };
}

export function splitTrackSegments(points: GpsTrackPt[]): GpsTrackPt[][] {
  const segs: GpsTrackPt[][] = [];
  let cur: GpsTrackPt[] = [];
  for (const p of points) {
    if (p.gapBefore && cur.length) {
      segs.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) {
    segs.push(cur);
  }
  return segs;
}

export function coordsToArrays(points: GpsTrackPt[]): number[][] {
  return points.map((p) =>
    p.eleM != null && Number.isFinite(p.eleM) ? [p.lat, p.lon, p.eleM] : [p.lat, p.lon]
  );
}

export function arraysToPoints(coords: number[][] | undefined | null): GpsTrackPt[] {
  if (!coords?.length) {
    return [];
  }
  const out: GpsTrackPt[] = [];
  for (const c of coords) {
    if (!Array.isArray(c) || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
      continue;
    }
    out.push({
      lat: c[0],
      lon: c[1],
      eleM: c.length >= 3 && Number.isFinite(c[2]) ? c[2] : null
    });
  }
  return out;
}

export function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function decodeTrackBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer);
  }
  return new TextDecoder('utf-8').decode(buffer);
}
