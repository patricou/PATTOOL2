import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { GpsOfflinePackMeta, GpsOfflineTilesStore } from '../gps-track/gps-offline-tiles.store';
import {
  GPS_OFFLINE_BUFFER_M,
  GPS_OFFLINE_HERE_BUFFER_M,
  GPS_OFFLINE_MAX_TILES,
  GPS_OFFLINE_MAX_Z,
  GPS_OFFLINE_MIN_Z,
  GpsLatLon,
  GpsTileXYZ,
  gpsTileId,
  offlineBasemapParts,
  offlinePackStyleId,
  offlineTileStyle,
  tilesAroundPoints
} from '../gps-track/gps-offline-tiles.util';
import { cachedBasemapTileUrl } from '../shared/leaflet-cached-tile.layer';

export interface GpsOfflineMapProgress {
  done: number;
  total: number;
  failed: number;
}

const EMPTY_PROGRESS: GpsOfflineMapProgress = { done: 0, total: 0, failed: 0 };

export function formatOfflinePackSize(bytes: number | null | undefined): string {
  const n = bytes || 0;
  if (n < 1024) {
    return `${n} o`;
  }
  if (n < 1024 * 1024) {
    return `${Math.round(n / 1024)} Ko`;
  }
  return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} Mo`;
}

const LAST_STYLE_KEY = 'pat.gps.offlineMap.lastStyle';

@Injectable({ providedIn: 'root' })
export class GpsOfflineMapService {
  readonly meta$ = new BehaviorSubject<GpsOfflinePackMeta>({
    tileCount: 0,
    bytes: 0,
    updatedAt: null
  });
  readonly progress$ = new BehaviorSubject<GpsOfflineMapProgress>(EMPTY_PROGRESS);
  readonly downloading$ = new BehaviorSubject(false);
  readonly lastError$ = new BehaviorSubject<string | null>(null);
  readonly styles$ = new BehaviorSubject<string[]>([]);

  private abort: AbortController | null = null;
  private knownStyles = new Set<string>();
  private lastStyle: string | null = null;

  constructor(private readonly store: GpsOfflineTilesStore) {
    this.lastStyle = this.readLastStyle();
    void this.store.ensurePersistent();
    void this.refreshMeta();
  }

  get downloading(): boolean {
    return this.downloading$.value;
  }

  async refreshMeta(): Promise<GpsOfflinePackMeta> {
    const meta = await this.store.meta();
    this.meta$.next(meta);
    const styles = await this.store.listStyles();
    this.knownStyles = new Set(styles);
    this.styles$.next(styles);
    return meta;
  }

  hasStyle(style: string): boolean {
    const id = offlinePackStyleId(style);
    return this.knownStyles.has(id) || (id === 'osm-standard' && this.knownStyles.has('osm'));
  }

  /**
   * Pack to show when the device is offline: the selected basemap if it was downloaded,
   * otherwise the last downloaded basemap.
   */
  displayStyle(basemapId: string, cartesLayerId?: string): string {
    const selected = offlinePackStyleId(basemapId, cartesLayerId);
    if (this.hasStyle(selected)) {
      return selected;
    }
    if (this.lastStyle && this.hasStyle(this.lastStyle)) {
      return this.lastStyle;
    }
    const first = this.styles$.value[0];
    return first || selected;
  }

  async downloadAround(
    points: GpsLatLon[],
    aroundHere = false,
    basemapId = 'osm-standard',
    cartesLayerId?: string
  ): Promise<boolean> {
    if (this.downloading) {
      return false;
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.lastError$.next('GPS.OFFLINE_MAP_NEED_NET');
      return false;
    }
    const style = offlinePackStyleId(basemapId, cartesLayerId);
    const tiles = tilesAroundPoints(points, {
      bufferM: aroundHere ? GPS_OFFLINE_HERE_BUFFER_M : GPS_OFFLINE_BUFFER_M,
      minZ: GPS_OFFLINE_MIN_Z,
      maxZ: GPS_OFFLINE_MAX_Z,
      maxTiles: GPS_OFFLINE_MAX_TILES
    });
    const jobs = this.jobsFor(style, tiles);
    if (!jobs.length) {
      this.lastError$.next('GPS.OFFLINE_MAP_NEED_POINTS');
      return false;
    }
    this.lastError$.next(null);
    await this.store.ensurePersistent();
    this.downloading$.next(true);
    this.progress$.next({ done: 0, total: jobs.length, failed: 0 });
    this.abort = new AbortController();
    let done = 0;
    let failed = 0;
    const limit = 4;
    let cursor = 0;
    const run = async (): Promise<void> => {
      while (cursor < jobs.length && !this.abort?.signal.aborted) {
        const job = jobs[cursor++];
        const ok = await this.fetchOne(style, job.part, job.tile, this.abort!.signal);
        done += 1;
        if (!ok) {
          failed += 1;
        }
        this.progress$.next({ done, total: jobs.length, failed });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, () => run()));
      await this.refreshMeta();
      if (this.abort?.signal.aborted) {
        this.lastError$.next(null);
        return false;
      }
      if (failed > 0 && failed === jobs.length) {
        this.lastError$.next('GPS.OFFLINE_MAP_ERR');
        return false;
      }
      this.rememberStyle(style);
      return true;
    } catch {
      this.lastError$.next('GPS.OFFLINE_MAP_ERR');
      return false;
    } finally {
      this.downloading$.next(false);
      this.abort = null;
    }
  }

  cancel(): void {
    this.abort?.abort();
  }

  async clear(): Promise<void> {
    this.cancel();
    await this.store.clear();
    this.lastStyle = null;
    try {
      localStorage.removeItem(LAST_STYLE_KEY);
    } catch {
      /* private mode */
    }
    this.progress$.next(EMPTY_PROGRESS);
    await this.refreshMeta();
  }

  private async fetchOne(style: string, part: number, tile: GpsTileXYZ, signal: AbortSignal): Promise<boolean> {
    const id = gpsTileId(tile.z, tile.x, tile.y, offlineTileStyle(style, part));
    if (await this.store.has(id)) {
      return true;
    }
    if (part === 0 && (style === 'osm-standard' || style === 'osm')) {
      if (await this.store.has(gpsTileId(tile.z, tile.x, tile.y))) {
        return true;
      }
    }
    const url = cachedBasemapTileUrl(style, part)
      .replace('{z}', String(tile.z))
      .replace('{x}', String(tile.x))
      .replace('{y}', String(tile.y));
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) {
        return false;
      }
      const blob = await res.blob();
      if (blob.size < 32) {
        return false;
      }
      await this.store.put(id, blob);
      return true;
    } catch {
      return false;
    }
  }

  private jobsFor(style: string, tiles: GpsTileXYZ[]): Array<{ tile: GpsTileXYZ; part: number }> {
    const parts = offlineBasemapParts(style);
    const jobs: Array<{ tile: GpsTileXYZ; part: number }> = [];
    for (const tile of tiles) {
      parts.forEach((spec, part) => {
        if (tile.z < (spec.minZ ?? 0) || tile.z > (spec.maxZ ?? 30)) {
          return;
        }
        jobs.push({ tile, part });
      });
    }
    return jobs;
  }

  private rememberStyle(style: string): void {
    this.lastStyle = style;
    try {
      localStorage.setItem(LAST_STYLE_KEY, style);
    } catch {
      /* private mode */
    }
  }

  private readLastStyle(): string | null {
    try {
      const value = localStorage.getItem(LAST_STYLE_KEY);
      return value && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  }
}
