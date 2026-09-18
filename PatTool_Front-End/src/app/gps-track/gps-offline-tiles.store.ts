import { Injectable } from '@angular/core';

const DB_NAME = 'pattool-gps-tiles';
const DB_VERSION = 1;
const STORE_TILES = 'tiles';
const STORE_META = 'meta';
const META_KEY = 'pack';

export interface GpsOfflineTileRecord {
  id: string;
  blob: Blob;
  bytes: number;
  savedAt: number;
}

export interface GpsOfflinePackMeta {
  tileCount: number;
  bytes: number;
  updatedAt: number | null;
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

@Injectable({ providedIn: 'root' })
export class GpsOfflineTilesStore {
  async get(id: string): Promise<Blob | null> {
    try {
      const db = await openDb();
      const rec = (await reqToPromise(
        db.transaction(STORE_TILES, 'readonly').objectStore(STORE_TILES).get(id)
      )) as GpsOfflineTileRecord | undefined;
      db.close();
      return rec?.blob || null;
    } catch {
      return null;
    }
  }

  async has(id: string): Promise<boolean> {
    try {
      const db = await openDb();
      const key = await reqToPromise(
        db.transaction(STORE_TILES, 'readonly').objectStore(STORE_TILES).getKey(id)
      );
      db.close();
      return key != null;
    } catch {
      return false;
    }
  }

  async put(id: string, blob: Blob): Promise<void> {
    if (!id || !blob || blob.size < 32) {
      return;
    }
    try {
      const db = await openDb();
      const tx = db.transaction([STORE_TILES, STORE_META], 'readwrite');
      const tiles = tx.objectStore(STORE_TILES);
      const existing = (await reqToPromise(tiles.get(id))) as GpsOfflineTileRecord | undefined;
      const rec: GpsOfflineTileRecord = {
        id,
        blob,
        bytes: blob.size,
        savedAt: Date.now()
      };
      tiles.put(rec);
      const metaStore = tx.objectStore(STORE_META);
      const meta = ((await reqToPromise(metaStore.get(META_KEY))) as GpsOfflinePackMeta | undefined) || {
        tileCount: 0,
        bytes: 0,
        updatedAt: null
      };
      if (existing) {
        meta.bytes = Math.max(0, meta.bytes - (existing.bytes || 0) + blob.size);
      } else {
        meta.tileCount += 1;
        meta.bytes += blob.size;
      }
      meta.updatedAt = rec.savedAt;
      metaStore.put(meta, META_KEY);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {
      /* quota / private mode */
    }
  }

  async meta(): Promise<GpsOfflinePackMeta> {
    try {
      const db = await openDb();
      const meta = (await reqToPromise(
        db.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(META_KEY)
      )) as GpsOfflinePackMeta | undefined;
      db.close();
      return meta || { tileCount: 0, bytes: 0, updatedAt: null };
    } catch {
      return { tileCount: 0, bytes: 0, updatedAt: null };
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await openDb();
      const tx = db.transaction([STORE_TILES, STORE_META], 'readwrite');
      tx.objectStore(STORE_TILES).clear();
      tx.objectStore(STORE_META).put({ tileCount: 0, bytes: 0, updatedAt: null }, META_KEY);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {
      /* ignore */
    }
  }
}
