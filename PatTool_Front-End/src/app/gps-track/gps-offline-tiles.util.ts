/** Slippy-map helpers for the GPS offline tile pack (OSM / Web Mercator). */

export interface GpsLatLon {
  lat: number;
  lon: number;
}

export interface GpsTileXYZ {
  z: number;
  x: number;
  y: number;
}

export const GPS_OFFLINE_STYLE = 'osm';
export const GPS_OFFLINE_MIN_Z = 12;
export const GPS_OFFLINE_MAX_Z = 16;
export const GPS_OFFLINE_BUFFER_M = 1000;
export const GPS_OFFLINE_HERE_BUFFER_M = 1500;
export const GPS_OFFLINE_MAX_TILES = 2800;

export function gpsTileId(z: number, x: number, y: number, style = GPS_OFFLINE_STYLE): string {
  return `${style}|${Math.round(z)}|${Math.round(x)}|${Math.round(y)}`;
}

export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return {
    x: Math.min(n - 1, Math.max(0, x)),
    y: Math.min(n - 1, Math.max(0, y))
  };
}

export function metersPerTile(lat: number, z: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

export function sampleTrack(points: GpsLatLon[], stepM: number): GpsLatLon[] {
  const valid = points.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90
  );
  if (valid.length <= 1) {
    return valid;
  }
  const out: GpsLatLon[] = [valid[0]];
  let acc = 0;
  for (let i = 1; i < valid.length; i++) {
    acc += haversineM(valid[i - 1], valid[i]);
    if (acc >= stepM) {
      out.push(valid[i]);
      acc = 0;
    }
  }
  const last = valid[valid.length - 1];
  const prev = out[out.length - 1];
  if (prev.lat !== last.lat || prev.lon !== last.lon) {
    out.push(last);
  }
  return out;
}

export function tilesAroundPoints(
  points: GpsLatLon[],
  opts?: {
    bufferM?: number;
    minZ?: number;
    maxZ?: number;
    maxTiles?: number;
  }
): GpsTileXYZ[] {
  const bufferM = opts?.bufferM ?? GPS_OFFLINE_BUFFER_M;
  const minZ = opts?.minZ ?? GPS_OFFLINE_MIN_Z;
  const maxZ = opts?.maxZ ?? GPS_OFFLINE_MAX_Z;
  const maxTiles = opts?.maxTiles ?? GPS_OFFLINE_MAX_TILES;
  const seed = points.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 85.05
  );
  if (!seed.length) {
    return [];
  }
  const seen = new Set<string>();
  const out: GpsTileXYZ[] = [];
  const add = (z: number, x: number, y: number): boolean => {
    const n = 2 ** z;
    if (x < 0 || y < 0 || x >= n || y >= n) {
      return true;
    }
    const id = `${z}/${x}/${y}`;
    if (seen.has(id)) {
      return true;
    }
    if (out.length >= maxTiles) {
      return false;
    }
    seen.add(id);
    out.push({ z, x, y });
    return true;
  };

  for (let z = minZ; z <= maxZ; z++) {
    const midLat = seed[Math.floor(seed.length / 2)].lat;
    const mpt = Math.max(40, metersPerTile(midLat, z));
    const pad = Math.max(1, Math.ceil(bufferM / mpt) + 1);
    const samples = sampleTrack(seed, Math.max(mpt * 0.55, 40));
    for (const p of samples) {
      const t = lonLatToTile(p.lon, p.lat, z);
      for (let dx = -pad; dx <= pad; dx++) {
        for (let dy = -pad; dy <= pad; dy++) {
          if (!add(z, t.x + dx, t.y + dy)) {
            return out;
          }
        }
      }
    }
  }
  return out;
}

function haversineM(a: GpsLatLon, b: GpsLatLon): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
