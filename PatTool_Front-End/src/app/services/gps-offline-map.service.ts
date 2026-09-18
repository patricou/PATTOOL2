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
  tilesAroundPoints
} from '../gps-track/gps-offline-tiles.util';
import { cachedOsmTileUrl } from '../shared/leaflet-cached-tile.layer';

export interface GpsOfflineMapProgress {
  done: number;
  total: number;
  failed: number;
}

const EMPTY_PROGRESS: GpsOfflineMapProgress = { done: 0, total: 0, failed: 0 };

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

  private abort: AbortController | null = null;

  constructor(private readonly store: GpsOfflineTilesStore) {
    void this.refreshMeta();
  }

  get downloading(): boolean {
    return this.downloading$.value;
  }

  async refreshMeta(): Promise<GpsOfflinePackMeta> {
    const meta = await this.store.meta();
    this.meta$.next(meta);
    return meta;
  }

  async downloadAround(points: GpsLatLon[], aroundHere = false): Promise<boolean> {
    if (this.downloading) {
      return false;
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.lastError$.next('GPS.OFFLINE_MAP_NEED_NET');
      return false;
    }
    const tiles = tilesAroundPoints(points, {
      bufferM: aroundHere ? GPS_OFFLINE_HERE_BUFFER_M : GPS_OFFLINE_BUFFER_M,
      minZ: GPS_OFFLINE_MIN_Z,
      maxZ: GPS_OFFLINE_MAX_Z,
      maxTiles: GPS_OFFLINE_MAX_TILES
    });
    if (!tiles.length) {
      this.lastError$.next('GPS.OFFLINE_MAP_NEED_POINTS');
      return false;
    }
    this.lastError$.next(null);
    this.downloading$.next(true);
    this.progress$.next({ done: 0, total: tiles.length, failed: 0 });
    this.abort = new AbortController();
    const urlTpl = cachedOsmTileUrl();
    let done = 0;
    let failed = 0;
    const limit = 4;
    let cursor = 0;
    const run = async (): Promise<void> => {
      while (cursor < tiles.length && !this.abort?.signal.aborted) {
        const i = cursor++;
        const tile = tiles[i];
        const ok = await this.fetchOne(tile, urlTpl, this.abort!.signal);
        done += 1;
        if (!ok) {
          failed += 1;
        }
        this.progress$.next({ done, total: tiles.length, failed });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(limit, tiles.length) }, () => run()));
      await this.refreshMeta();
      if (this.abort?.signal.aborted) {
        this.lastError$.next(null);
        return false;
      }
      if (failed > 0 && failed === tiles.length) {
        this.lastError$.next('GPS.OFFLINE_MAP_ERR');
        return false;
      }
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
    this.progress$.next(EMPTY_PROGRESS);
    await this.refreshMeta();
  }

  private async fetchOne(tile: GpsTileXYZ, urlTpl: string, signal: AbortSignal): Promise<boolean> {
    const id = gpsTileId(tile.z, tile.x, tile.y);
    if (await this.store.has(id)) {
      return true;
    }
    const url = urlTpl
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
}
