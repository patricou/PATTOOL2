import { GpsFollowPoint, GpsFollowSession } from '../services/api.service';
import { GpsTrackPt } from './gps-geo.util';

const DB_NAME = 'pattool-gps';
const DB_VERSION = 1;
const STORE_SESSION = 'session';
const STORE_POINTS = 'points';
const ACTIVE_KEY = 'active';

export interface GpsOfflineSession {
  clientSessionId: string;
  mongoId?: string | null;
  title: string;
  sourceType: 'import' | 'file' | 'session';
  sourceFileId?: string | null;
  sourceFileName?: string | null;
  status: 'idle' | 'recording' | 'paused' | 'finished';
  plannedTrack: GpsTrackPt[];
  plannedDistanceM: number | null;
  plannedAscentM: number | null;
  plannedDescentM: number | null;
  doneM: number | null;
  remainingM: number | null;
  ascentDoneM: number | null;
  descentDoneM: number | null;
  durationSec: number | null;
  startedAtMs?: number | null;
  finishedAtMs?: number | null;
  updatedAtMs: number;
}

export interface GpsOfflinePoint extends GpsFollowPoint {
  clientPointId: string;
  clientSessionId: string;
  synced: boolean;
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
      if (!db.objectStoreNames.contains(STORE_SESSION)) {
        db.createObjectStore(STORE_SESSION);
      }
      if (!db.objectStoreNames.contains(STORE_POINTS)) {
        const store = db.createObjectStore(STORE_POINTS, { keyPath: 'clientPointId' });
        store.createIndex('bySession', 'clientSessionId', { unique: false });
        store.createIndex('byUnsynced', 'synced', { unique: false });
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

export class GpsSessionOfflineStore {
  async loadActive(): Promise<{ session: GpsOfflineSession | null; points: GpsOfflinePoint[] }> {
    try {
      const db = await openDb();
      const tx = db.transaction([STORE_SESSION, STORE_POINTS], 'readonly');
      const session = (await reqToPromise(
        tx.objectStore(STORE_SESSION).get(ACTIVE_KEY)
      )) as GpsOfflineSession | undefined;
      const points: GpsOfflinePoint[] = [];
      if (session?.clientSessionId) {
        const index = tx.objectStore(STORE_POINTS).index('bySession');
        const all = (await reqToPromise(index.getAll(session.clientSessionId))) as GpsOfflinePoint[];
        points.push(...(all || []));
        points.sort((a, b) => (a.timeMs || 0) - (b.timeMs || 0));
      }
      db.close();
      return { session: session || null, points };
    } catch {
      return { session: null, points: [] };
    }
  }

  async saveSession(session: GpsOfflineSession): Promise<void> {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_SESSION, 'readwrite');
      tx.objectStore(STORE_SESSION).put(session, ACTIVE_KEY);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {
      /* ignore */
    }
  }

  async addPoints(points: GpsOfflinePoint[]): Promise<void> {
    if (!points.length) {
      return;
    }
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_POINTS, 'readwrite');
      const store = tx.objectStore(STORE_POINTS);
      for (const p of points) {
        store.put(p);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {
      /* ignore */
    }
  }

  async markSynced(clientPointIds: string[]): Promise<void> {
    if (!clientPointIds.length) {
      return;
    }
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_POINTS, 'readwrite');
      const store = tx.objectStore(STORE_POINTS);
      for (const id of clientPointIds) {
        const existing = (await reqToPromise(store.get(id))) as GpsOfflinePoint | undefined;
        if (existing) {
          existing.synced = true;
          store.put(existing);
        }
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {
      /* ignore */
    }
  }

  unsyncedFrom(points: GpsOfflinePoint[]): GpsFollowPoint[] {
    return points
      .filter((p) => !p.synced)
      .map(({ clientSessionId: _s, synced: _y, ...rest }) => rest);
  }

  toApiSession(session: GpsOfflineSession, points: GpsFollowPoint[]): GpsFollowSession {
    return {
      clientSessionId: session.clientSessionId,
      id: session.mongoId || undefined,
      title: session.title,
      sourceType: session.sourceType,
      sourceFileId: session.sourceFileId || undefined,
      sourceFileName: session.sourceFileName || undefined,
      status: session.status,
      plannedTrack: session.plannedTrack.map((p) =>
        p.eleM != null && Number.isFinite(p.eleM) ? [p.lat, p.lon, p.eleM] : [p.lat, p.lon]
      ),
      plannedDistanceM: session.plannedDistanceM,
      plannedAscentM: session.plannedAscentM,
      plannedDescentM: session.plannedDescentM,
      recordedPoints: points,
      doneM: session.doneM,
      remainingM: session.remainingM,
      ascentDoneM: session.ascentDoneM,
      descentDoneM: session.descentDoneM,
      durationSec: session.durationSec,
      startedAt: session.startedAtMs ? new Date(session.startedAtMs).toISOString() : undefined,
      finishedAt: session.finishedAtMs ? new Date(session.finishedAtMs).toISOString() : undefined
    };
  }
}
