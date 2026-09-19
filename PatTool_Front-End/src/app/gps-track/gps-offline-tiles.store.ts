import { Injectable } from '@angular/core';

const DB_NAME = 'pattool-gps-tiles';
const DB_VERSION = 1;
const STORE_TILES = 'tiles';
const STORE_META = 'meta';
const META_KEY = 'pack';
const CACHE_NAME = 'pattool-gps-tiles-v1';
const CACHE_PREFIX = 'https://pattool.local/gps-tile/';
const MIN_BYTES = 32;

export interface GpsOfflineTileRecord {
  id: string;
  /** Durable payload. ArrayBuffer survives Android/iOS WebView restarts; Blob often does not. */
  data?: ArrayBuffer;
  /** Legacy records written before ArrayBuffer persistence. */
  blob?: Blob;
  bytes: number;
  savedAt: number;
  mime?: string;
}

export interface GpsOfflinePackMeta {
  tileCount: number;
  bytes: number;
  updatedAt: number | null;
}

const EMPTY_META: GpsOfflinePackMeta = { tileCount: 0, bytes: 0, updatedAt: null };

function tileCacheUrl(id: string): string {
  return `${CACHE_PREFIX}${encodeURIComponent(id)}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no_idb'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TILES)) {
        db.createObjectStore(STORE_TILES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb_open'));
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function recordToBlob(rec: GpsOfflineTileRecord | undefined): Blob | null {
  if (!rec) {
    return null;
  }
  const mime = rec.mime || 'image/png';
  if (rec.data instanceof ArrayBuffer && rec.data.byteLength >= MIN_BYTES) {
    return new Blob([rec.data], { type: mime });
  }
  if (rec.blob instanceof Blob && rec.blob.size >= MIN_BYTES) {
    return rec.blob;
  }
  return null;
}

function recordBytes(rec: GpsOfflineTileRecord | undefined): number {
  if (!rec) {
    return 0;
  }
  if (rec.data instanceof ArrayBuffer && rec.data.byteLength >= MIN_BYTES) {
    return rec.data.byteLength;
  }
  if (rec.blob instanceof Blob && rec.blob.size >= MIN_BYTES) {
    return rec.blob.size;
  }
  return rec.bytes >= MIN_BYTES ? rec.bytes : 0;
}

@Injectable({ providedIn: 'root' })
export class GpsOfflineTilesStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private persistAsked = false;

  constructor() {
    void this.ensurePersistent();
    void this.migrateLegacy();
  }

  /** Rewrite Blob records as ArrayBuffer and mirror them to Cache Storage. */
  private async migrateLegacy(): Promise<void> {
    try {
      const db = await this.db();
      const all = (await reqToPromise(
        db.transaction(STORE_TILES, 'readonly').objectStore(STORE_TILES).getAll()
      )) as GpsOfflineTileRecord[] | undefined;
      if (!all?.length) {
        return;
      }
      for (const rec of all) {
        if (rec.data instanceof ArrayBuffer && rec.data.byteLength >= MIN_BYTES) {
          await this.cachePut(rec.id, new Blob([rec.data], { type: rec.mime || 'image/png' }));
          continue;
        }
        const blob = recordToBlob(rec);
        if (blob) {
          await this.put(rec.id, blob);
        }
      }
    } catch {
      /* ignore */
    }
  }

  async ensurePersistent(): Promise<void> {
    if (this.persistAsked || typeof navigator === 'undefined') {
      return;
    }
    this.persistAsked = true;
    try {
      await navigator.storage?.persist?.();
    } catch {
      /* private mode / unsupported */
    }
  }

  async get(id: string): Promise<Blob | null> {
    try {
      const db = await this.db();
      const rec = (await reqToPromise(
        db.transaction(STORE_TILES, 'readonly').objectStore(STORE_TILES).get(id)
      )) as GpsOfflineTileRecord | undefined;
      const fromIdb = recordToBlob(rec);
      if (fromIdb) {
        return fromIdb;
      }
    } catch {
      /* fall through to Cache API */
    }
    const fromCache = await this.cacheGet(id);
    if (fromCache) {
      void this.put(id, fromCache);
    }
    return fromCache;
  }

  async has(id: string): Promise<boolean> {
    try {
      const db = await this.db();
      const rec = (await reqToPromise(
        db.transaction(STORE_TILES, 'readonly').objectStore(STORE_TILES).get(id)
      )) as GpsOfflineTileRecord | undefined;
      if (recordBytes(rec) >= MIN_BYTES) {
        return true;
      }
    } catch {
      /* ignore */
    }
    return !!(await this.cacheGet(id));
  }

  async put(id: string, blob: Blob): Promise<void> {
    if (!id || !blob || blob.size < MIN_BYTES) {
      return;
    }
    await this.ensurePersistent();
    const mime = blob.type || 'image/png';
    let data: ArrayBuffer;
    try {
      data = await blob.arrayBuffer();
    } catch {
      return;
    }
    if (data.byteLength < MIN_BYTES) {
      return;
    }
    const durable = new Blob([data], { type: mime });
    try {
      const db = await this.db();
      const tx = db.transaction([STORE_TILES, STORE_META], 'readwrite');
      const tiles = tx.objectStore(STORE_TILES);
      const existing = (await reqToPromise(tiles.get(id))) as GpsOfflineTileRecord | undefined;
      const rec: GpsOfflineTileRecord = {
        id,
        data,
        bytes: data.byteLength,
        savedAt: Date.now(),
        mime
      };
      tiles.put(rec);
      const metaStore = tx.objectStore(STORE_META);
      const meta = ((await reqToPromise(metaStore.get(META_KEY))) as GpsOfflinePackMeta | undefined) || {
        ...EMPTY_META
      };
      if (existing) {
        const prevBytes = existing.bytes || recordBytes(existing);
        meta.bytes = Math.max(0, meta.bytes - prevBytes + data.byteLength);
      } else {
        meta.tileCount += 1;
        meta.bytes += data.byteLength;
      }
      meta.updatedAt = rec.savedAt;
      metaStore.put(meta, META_KEY);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* quota / private mode */
    }
    await this.cachePut(id, durable);
  }

  async meta(): Promise<GpsOfflinePackMeta> {
    try {
      const db = await this.db();
      const meta = (await reqToPromise(
        db.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(META_KEY)
      )) as GpsOfflinePackMeta | undefined;
      return meta || { ...EMPTY_META };
    } catch {
      return { ...EMPTY_META };
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await this.db();
      const tx = db.transaction([STORE_TILES, STORE_META], 'readwrite');
      tx.objectStore(STORE_TILES).clear();
      tx.objectStore(STORE_META).put({ ...EMPTY_META }, META_KEY);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* ignore */
    }
    try {
      if (typeof caches !== 'undefined') {
        await caches.delete(CACHE_NAME);
      }
    } catch {
      /* ignore */
    }
  }

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDb().then((db) => {
        db.onclose = () => {
          this.dbPromise = null;
        };
        db.addEventListener('versionchange', () => {
          db.close();
          this.dbPromise = null;
        });
        return db;
      });
    }
    return this.dbPromise;
  }

  private async cacheGet(id: string): Promise<Blob | null> {
    try {
      if (typeof caches === 'undefined') {
        return null;
      }
      const cache = await caches.open(CACHE_NAME);
      const res = await cache.match(tileCacheUrl(id));
      if (!res || !res.ok) {
        return null;
      }
      const blob = await res.blob();
      return blob.size >= MIN_BYTES ? blob : null;
    } catch {
      return null;
    }
  }

  private async cachePut(id: string, blob: Blob): Promise<void> {
    try {
      if (typeof caches === 'undefined') {
        return;
      }
      const cache = await caches.open(CACHE_NAME);
      await cache.put(
        tileCacheUrl(id),
        new Response(blob, {
          headers: {
            'Content-Type': blob.type || 'image/png',
            'Cache-Control': 'max-age=31536000, immutable'
          }
        })
      );
    } catch {
      /* quota / private mode */
    }
  }
}
