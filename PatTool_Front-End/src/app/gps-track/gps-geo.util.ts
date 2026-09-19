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

/** Initial bearing in degrees (0 = north, 90 = east). */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const lat1r = toRad(lat1);
  const lat2r = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(lat2r);
  const x = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Heading of the path around `index`, looking ~8 m ahead (or behind near the end). */
export function trackHeadingAt(points: GpsTrackPt[], index: number, minM = 8): number | null {
  if (points.length < 2) {
    return null;
  }
  const i = Math.max(0, Math.min(index, points.length - 1));
  const start = points[i];
  for (let k = i + 1; k < points.length; k++) {
    if (haversineMeters(start.lat, start.lon, points[k].lat, points[k].lon) >= minM) {
      return bearingDeg(start.lat, start.lon, points[k].lat, points[k].lon);
    }
  }
  for (let k = i - 1; k >= 0; k--) {
    if (haversineMeters(points[k].lat, points[k].lon, start.lat, start.lon) >= minM) {
      return bearingDeg(points[k].lat, points[k].lon, start.lat, start.lon);
    }
  }
  const other = i < points.length - 1 ? points[i + 1] : points[i - 1];
  return bearingDeg(start.lat, start.lon, other.lat, other.lon);
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

/** Planned-track cap shared with the GPS session / itinerary backends. */
export const MAX_PLANNED_TRACK_POINTS = 8000;

export function downsampleTrackPoints(points: GpsTrackPt[], max: number): GpsTrackPt[] {
  if (points.length <= max) {
    return points.slice();
  }
  const out: GpsTrackPt[] = [];
  const last = points.length - 1;
  let prev = -1;
  for (let i = 0; i < max - 1; i++) {
    const idx = Math.round((i * last) / (max - 1));
    if (idx === prev) {
      continue;
    }
    out.push(points[idx]);
    prev = idx;
  }
  if (prev !== last) {
    out.push(points[last]);
  }
  return out;
}

export function escapeXml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function slugFileName(value: string, fallback = 'track'): string {
  const slug = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .toLowerCase();
  return slug || fallback;
}

const TRACK_FILE_EXT = /\.(gpx|kml|kmz|tcx|geojson|json)$/i;

/** True when the value looks like an imported track file, not a route title. */
export function isTrackFileName(name?: string | null): boolean {
  const raw = (name || '').trim();
  if (!raw || raw.length > 180) {
    return false;
  }
  const base = raw.replace(/\\/g, '/').split('/').pop() || raw;
  if (!TRACK_FILE_EXT.test(base)) {
    return false;
  }
  if (/[,→]/.test(base) || /\s{2,}/.test(base)) {
    return false;
  }
  return true;
}

export function displayTrackFileName(name?: string | null): string {
  if (!isTrackFileName(name)) {
    return '';
  }
  const raw = (name || '').trim().replace(/\\/g, '/');
  return raw.split('/').pop() || raw;
}

export function exportTrackFileName(name: string | null | undefined, title: string): string {
  const shown = displayTrackFileName(name);
  if (shown) {
    return shown;
  }
  return `pattool-${slugFileName(title, 'sortie')}.gpx`;
}

export function buildTrackGpx(opts: {
  points: GpsTrackPt[];
  name: string;
  desc?: string;
  type?: string;
}): string {
  const now = new Date().toISOString();
  const safeName = escapeXml(opts.name || 'GPS');
  const safeDesc = escapeXml(opts.desc || '');
  const safeType = escapeXml(opts.type || 'recorded');
  const segs = splitTrackSegments(opts.points).filter((s) => s.length);
  const trksegs = (segs.length ? segs : [opts.points])
    .map((seg) => {
      const trkpts = seg
        .map((p) => {
          const ele =
            p.eleM != null && Number.isFinite(p.eleM)
              ? `\n        <ele>${p.eleM.toFixed(1)}</ele>`
              : '';
          return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${ele}</trkpt>`;
        })
        .join('\n');
      return `    <trkseg>\n${trkpts}\n    </trkseg>`;
    })
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="PatTool GPS"',
    '  xmlns="http://www.topografix.com/GPX/1/1"',
    '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
    '  <metadata>',
    `    <name>${safeName}</name>`,
    safeDesc ? `    <desc>${safeDesc}</desc>` : '',
    `    <time>${now}</time>`,
    '  </metadata>',
    '  <trk>',
    `    <name>${safeName}</name>`,
    `    <type>${safeType}</type>`,
    trksegs,
    '  </trk>',
    '</gpx>',
    ''
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function downloadTextFile(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
