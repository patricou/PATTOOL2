const DB_NAME = 'pattool-deezer-offline';
const DB_VERSION = 2;
const STORE = 'tracks';
const META = 'meta';

export interface DeezerOfflineMeta {
  id: number;
  videoId: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  bytes: number;
  savedAt: number;
}

export interface DeezerOfflineTrack extends DeezerOfflineMeta {
  /** AAC bytes. An ArrayBuffer survives a WebView restart. */
  data: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no_idb'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'id' });
      }
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      if (oldVersion >= 1 && oldVersion < 2 && tx) {
        const tracks = tx.objectStore(STORE);
        const meta = tx.objectStore(META);
        const cursorReq = tracks.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) {
            return;
          }
          const row = cursor.value as DeezerOfflineTrack;
          meta.put(toMeta(row));
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb_open'));
  });
}

function asBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) {
    return data.byteLength > 0 ? data : null;
  }
  if (ArrayBuffer.isView(data)) {
    if (data.byteLength <= 0) {
      return null;
    }
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return copy;
  }
  return null;
}

/** Sound of Deezer favorites and playlists, kept on this device. */
export class DeezerOfflineAudioStore {
  async list(): Promise<DeezerOfflineMeta[]> {
    const db = await openDb();
    try {
      let rows = await readMeta(db, META);
      if (!rows.length && db.objectStoreNames.contains(STORE)) {
        rows = await readMeta(db, STORE);
      }
      return rows
        .filter((row) => row && row.id && row.videoId)
        .sort((a, b) => `${a.artist} ${a.title}`.localeCompare(`${b.artist} ${b.title}`, undefined, { sensitivity: 'base' }));
    } finally {
      db.close();
    }
  }

  async ids(): Promise<Map<number, string>> {
    const rows = await this.list();
    const map = new Map<number, string>();
    for (const row of rows) {
      map.set(Number(row.id), row.videoId);
    }
    return map;
  }

  async load(id: number): Promise<DeezerOfflineTrack | null> {
    const db = await openDb();
    try {
      const row = await new Promise<DeezerOfflineTrack | undefined>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
        req.onsuccess = () => resolve(req.result as DeezerOfflineTrack | undefined);
        req.onerror = () => reject(req.error);
      });
      if (!row) {
        return null;
      }
      const data = asBuffer(row.data);
      if (!data) {
        return null;
      }
      return { ...row, data };
    } finally {
      db.close();
    }
  }

  async save(track: DeezerOfflineTrack): Promise<void> {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE, META], 'readwrite');
        tx.objectStore(STORE).put(track);
        tx.objectStore(META).put(toMeta(track));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('idb_abort'));
      });
    } finally {
      db.close();
    }
  }
}

function readMeta(db: IDBDatabase, store: string): Promise<DeezerOfflineMeta[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => {
      const rows = (req.result || []) as DeezerOfflineTrack[];
      resolve(rows.filter((row) => row && row.id).map((row) => toMeta(row)));
    };
    req.onerror = () => reject(req.error);
  });
}

function toMeta(track: DeezerOfflineTrack): DeezerOfflineMeta {
  return {
    id: track.id,
    videoId: track.videoId,
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    durationSec: track.durationSec || 0,
    bytes: track.bytes || 0,
    savedAt: track.savedAt || Date.now()
  };
}
