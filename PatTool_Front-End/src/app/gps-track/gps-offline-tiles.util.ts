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

/** One raster sheet of a basemap. Zoom bounds skip sheets that do not exist at that level. */
export interface OfflineBasemapPart {
  minZ?: number;
  maxZ?: number;
}

/**
 * Parts downloaded for each catalogue id. Must match MapTileProxyService templates.
 * Legacy packs stored under style "osm" are read as osm-standard.
 */
export const OFFLINE_BASEMAP_PARTS: Record<string, OfflineBasemapPart[]> = {
  'osm': [{}],
  'osm-standard': [{}],
  'voyager': [{}],
  'osm-fr': [{}, {}],
  'esri-imagery': [{}],
  'opentopomap': [{}],
  'ign-plan': [{}],
  'ign-topo': [{}],
  'ign-classic': [{ maxZ: 12 }, { minZ: 12 }],
  'ign-ortho': [{}],
  'ign-cadastre': [{}],
  'ign-limites': [{}],
  'ign-relief': [{}],
  'ign-routes': [{}],
  'ign-maps': [{}],
  'ign-scan-regional': [{ maxZ: 12 }],
  'cyclosm': [{}],
  'swisstopo-pixelkarte': [{}],
  'swisstopo-swissimage': [{}],
  'opencyclemap': [{}],
  'thunderforest-outdoors': [{}]
};

const CARTES_GOUV_STYLE: Record<string, string> = {
  'ign-maps': 'ign-maps',
  'ign-plan': 'ign-plan',
  'ign-scan-regional': 'ign-scan-regional',
  'ign-ortho': 'ign-ortho',
  'ign-cadastre': 'ign-cadastre',
  'ign-limites': 'ign-limites',
  'ign-relief': 'ign-relief'
};

/** Catalogue id stored in the tile pack (cartes.gouv.fr is an embed, so its IGN sheet is stored). */
export function offlinePackStyleId(basemapId: string, cartesLayerId?: string): string {
  const id = (basemapId || '').trim();
  if (id === 'cartes-gouv') {
    return CARTES_GOUV_STYLE[cartesLayerId || ''] || 'ign-plan';
  }
  if (id === 'osm') {
    return 'osm-standard';
  }
  return id || 'osm-standard';
}

export function offlineBasemapParts(style: string): OfflineBasemapPart[] {
  return OFFLINE_BASEMAP_PARTS[style] || [{}];
}

export function offlineTileStyle(style: string, part: number): string {
  return `${style}#${part}`;
}

/** Style id from a stored tile key (`style#part|z|x|y` or legacy `osm|z|x|y`). */
export function styleFromTileId(id: string): string {
  const head = (id || '').split('|')[0] || '';
  const hash = head.indexOf('#');
  const style = hash >= 0 ? head.slice(0, hash) : head;
  return style === 'osm' ? 'osm-standard' : style;
}
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

/** Geographic rectangle of the map window on screen, plus its Leaflet zoom. */
export interface GpsViewWindow {
  south: number;
  west: number;
  north: number;
  east: number;
  zoom: number;
}

export interface LeafletViewSource {
  getBounds(): {
    isValid(): boolean;
    getSouth(): number;
    getWest(): number;
    getNorth(): number;
    getEast(): number;
  };
  getZoom(): number;
}

const WEB_MERCATOR_MAX_LAT = 85.05112878;

/** Bounds and zoom of the map the user is looking at. */
export function viewWindowFromMap(map: LeafletViewSource | null | undefined): GpsViewWindow | null {
  if (!map) {
    return null;
  }
  const bounds = map.getBounds();
  const zoom = map.getZoom();
  if (!bounds?.isValid() || !Number.isFinite(zoom)) {
    return null;
  }
  return {
    south: bounds.getSouth(),
    west: bounds.getWest(),
    north: bounds.getNorth(),
    east: bounds.getEast(),
    zoom
  };
}

/**
 * Same width and height as `view`, centered on a point (GPS “around me”).
 * The zoom stays the one on screen.
 */
export function viewWindowAround(view: GpsViewWindow, lat: number, lon: number): GpsViewWindow | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) {
    return null;
  }
  const latHalf = Math.abs(view.north - view.south) / 2;
  const lonSpan = view.east >= view.west ? view.east - view.west : 360 - (view.west - view.east);
  const lonHalf = Math.abs(lonSpan) / 2;
  return {
    south: lat - latHalf,
    north: lat + latHalf,
    west: lon - lonHalf,
    east: lon + lonHalf,
    zoom: view.zoom
  };
}

/**
 * Slippy-map tiles that cover the displayed window.
 * The on-screen zoom is filled first, then one level closer and one level wider,
 * so a single zoom step still has tiles. Extent is the window, not a track corridor.
 */
export function tilesInView(
  view: GpsViewWindow,
  opts?: { zoomSpan?: number; minZ?: number; maxZ?: number; maxTiles?: number }
): GpsTileXYZ[] {
  const maxTiles = opts?.maxTiles ?? GPS_OFFLINE_MAX_TILES;
  const absMin = opts?.minZ ?? 0;
  const absMax = opts?.maxZ ?? 19;
  const span = Math.max(0, Math.floor(opts?.zoomSpan ?? 1));
  const z0 = Math.round(view.zoom);
  if (!Number.isFinite(z0) || !Number.isFinite(view.south) || !Number.isFinite(view.north)
    || !Number.isFinite(view.west) || !Number.isFinite(view.east)) {
    return [];
  }
  const south = clampMercatorLat(Math.min(view.south, view.north));
  const north = clampMercatorLat(Math.max(view.south, view.north));
  const levels: number[] = [];
  const pushLevel = (z: number): void => {
    if (z >= absMin && z <= absMax && !levels.includes(z)) {
      levels.push(z);
    }
  };
  pushLevel(z0);
  for (let d = 1; d <= span; d++) {
    pushLevel(z0 + d);
    pushLevel(z0 - d);
  }

  const seen = new Set<string>();
  const out: GpsTileXYZ[] = [];
  const add = (z: number, x: number, y: number): boolean => {
    const n = 2 ** z;
    const xx = ((x % n) + n) % n;
    if (y < 0 || y >= n) {
      return true;
    }
    const id = `${z}/${xx}/${y}`;
    if (seen.has(id)) {
      return true;
    }
    if (out.length >= maxTiles) {
      return false;
    }
    seen.add(id);
    out.push({ z, x: xx, y });
    return true;
  };

  for (const z of levels) {
    if (!coverViewAtZoom(south, view.west, north, view.east, z, add)) {
      return out;
    }
  }
  return out;
}

function clampMercatorLat(lat: number): number {
  return Math.max(-WEB_MERCATOR_MAX_LAT, Math.min(WEB_MERCATOR_MAX_LAT, lat));
}

function coverViewAtZoom(
  south: number,
  west: number,
  north: number,
  east: number,
  z: number,
  add: (z: number, x: number, y: number) => boolean
): boolean {
  const n = 2 ** z;
  let fWest = (west + 180) / 360;
  let fEast = (east + 180) / 360;
  if (fEast < fWest) {
    fEast += 1;
  }
  if (fEast - fWest >= 1) {
    fWest = 0;
    fEast = 1 - 1e-12;
  }
  const xStart = Math.floor(fWest * n);
  const xEnd = Math.floor(Math.min(fEast, fWest + 1 - 1e-12) * n);
  const count = Math.min(n, Math.max(1, xEnd - xStart + 1));
  const yNorth = lonLatToTile(0, north, z).y;
  const ySouth = lonLatToTile(0, south, z).y;
  const y0 = Math.min(yNorth, ySouth);
  const y1 = Math.max(yNorth, ySouth);
  for (let i = 0; i < count; i++) {
    const x = xStart + i;
    for (let y = y0; y <= y1; y++) {
      if (!add(z, x, y)) {
        return false;
      }
    }
  }
  return true;
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
