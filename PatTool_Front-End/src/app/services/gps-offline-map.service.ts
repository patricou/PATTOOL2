import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { GpsOfflinePackMeta, GpsOfflineTilesStore } from '../gps-track/gps-offline-tiles.store';
import {
  GPS_OFFLINE_BUFFER_M,
  GPS_OFFLINE_HERE_BUFFER_M,
  GPS_OFFLINE_MAX_TILES,
  GPS_OFFLINE_MAX_Z,
  GPS_OFFLINE_MIN_Z,
  GpsLatLon,
  GpsOfflineInventory,
  GpsTileXYZ,
  GpsViewWindow,
  gpsTileId,
  offlineBasemapMaxZoom,
  offlineBasemapParts,
  offlinePackStyleId,
  offlineTileStyle,
  tilesAroundPoints,
  tilesInView
} from '../gps-track/gps-offline-tiles.util';
import { cachedBasemapTileUrl } from '../shared/leaflet-cached-tile.layer';

export interface GpsOfflineMapProgress {
  done: number;
  total: number;
  failed: number;
  /** Catalogue id of the basemap being downloaded. */
  style?: string | null;
}

const EMPTY_PROGRESS: GpsOfflineMapProgress = { done: 0, total: 0, failed: 0 };

/** What the shared offline modal should download. One store serves every map screen. */
export interface GpsOfflineDownloadRequest {
  basemapId: string;
  cartesLayerId?: string;
  view: GpsViewWindow | null;
  aroundView?: GpsViewWindow | null;
}

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
  /** Last claimed download overlay wins, so a page and the trace viewer do not stack two spinners. */
  readonly overlayOwner$ = new BehaviorSubject(0);
  /** Opens the single offline-tile modal (trace viewer, GPS, routing, GPX). */
  readonly downloadUi$ = new Subject<GpsOfflineDownloadRequest>();

  private abort: AbortController | null = null;
  private overlaySeq = 0;
  private overlayStack: number[] = [];
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

  openDownloadUi(request: GpsOfflineDownloadRequest): void {
    this.downloadUi$.next(request);
  }

  claimOverlay(): number {
    const id = ++this.overlaySeq;
    this.overlayStack.push(id);
    this.overlayOwner$.next(id);
    return id;
  }

  releaseOverlay(id: number): void {
    this.overlayStack = this.overlayStack.filter((item) => item !== id);
    this.overlayOwner$.next(this.overlayStack[this.overlayStack.length - 1] ?? 0);
  }

  inventory(): Promise<GpsOfflineInventory> {
    return this.store.inventory();
  }

  async refreshMeta(): Promise<GpsOfflinePackMeta> {
    const meta = await this.store.meta();
    const styles = await this.store.listStyles();
    this.knownStyles = new Set(styles);
    this.styles$.next(styles);
    this.meta$.next(meta);
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

  /** Tiles for the map window: current zoom, one level out, and every higher zoom. */
  async downloadView(
    view: GpsViewWindow,
    basemapId = 'osm-standard',
    cartesLayerId?: string
  ): Promise<boolean> {
    const style = offlinePackStyleId(basemapId, cartesLayerId);
    return this.downloadTiles(
      style,
      tilesInView(view, { maxZ: offlineBasemapMaxZoom(style) }),
      'GPS.OFFLINE_MAP_NEED_VIEW'
    );
  }

  async downloadAround(
    points: GpsLatLon[],
    aroundHere = false,
    basemapId = 'osm-standard',
    cartesLayerId?: string
  ): Promise<boolean> {
    const style = offlinePackStyleId(basemapId, cartesLayerId);
    const tiles = tilesAroundPoints(points, {
      bufferM: aroundHere ? GPS_OFFLINE_HERE_BUFFER_M : GPS_OFFLINE_BUFFER_M,
      minZ: GPS_OFFLINE_MIN_Z,
      maxZ: GPS_OFFLINE_MAX_Z,
      maxTiles: GPS_OFFLINE_MAX_TILES
    });
    return this.downloadTiles(style, tiles, 'GPS.OFFLINE_MAP_NEED_POINTS');
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

  private async downloadTiles(style: string, tiles: GpsTileXYZ[], emptyKey: string): Promise<boolean> {
    if (this.downloading) {
      return false;
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.lastError$.next('GPS.OFFLINE_MAP_NEED_NET');
      return false;
    }
    const jobs = this.jobsFor(style, tiles);
    if (!jobs.length) {
      this.lastError$.next(emptyKey);
      return false;
    }
    this.lastError$.next(null);
    await this.store.ensurePersistent();
    this.progress$.next({ done: 0, total: jobs.length, failed: 0, style });
    this.downloading$.next(true);
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
        this.progress$.next({ done, total: jobs.length, failed, style });
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
