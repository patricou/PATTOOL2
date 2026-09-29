import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

const DB_NAME = 'pattool-offline-traces';
const DB_VERSION = 1;
const STORE = 'traces';

export type OfflineTraceSource = 'photo-wall' | 'gps-routing';

export interface OfflineTraceSummary {
  id: string;
  fileName: string;
  title: string;
  source: OfflineTraceSource;
  activityName?: string;
  eventId?: string;
  fieldId?: string;
  bytes: number;
  savedAt: number;
  distanceKm?: number | null;
  elevationGainM?: number | null;
}

export interface OfflineTraceRecord extends OfflineTraceSummary {
  /** Raw track file (GPX, KML, TCX, …). ArrayBuffer survives a WebView restart. */
  data: ArrayBuffer;
}

export interface OfflineTraceSaveInput {
  id: string;
  fileName: string;
  title: string;
  source: OfflineTraceSource;
  activityName?: string;
  eventId?: string;
  fieldId?: string;
  data: ArrayBuffer;
  distanceKm?: number | null;
  elevationGainM?: number | null;
}

export function offlineTraceIdForWall(fieldId: string): string {
  return `wall:${fieldId.trim()}`;
}

/** Same itinerary text updates the existing copy instead of stacking duplicates. */
export function offlineTraceIdForRoute(gpx: string): string {
  return `route:${fnv1a(gpx)}`;
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
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
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
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

/** Android WebView can hand back a Blob or a typed array instead of an ArrayBuffer. */
function hasStoredPayload(data: unknown): boolean {
  if (data instanceof ArrayBuffer) {
    return data.byteLength > 0;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength > 0;
  }
  return typeof Blob !== 'undefined' && data instanceof Blob && data.size > 0;
}

async function clonePayload(data: unknown): Promise<ArrayBuffer | null> {
  try {
    if (data instanceof ArrayBuffer) {
      return data.byteLength > 0 ? data.slice(0) : null;
    }
    if (ArrayBuffer.isView(data)) {
      if (data.byteLength <= 0) {
        return null;
      }
      const copy = new ArrayBuffer(data.byteLength);
      new Uint8Array(copy).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return copy;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob && data.size > 0) {
      return await data.arrayBuffer();
    }
  } catch {
    return null;
  }
  return null;
}

function toSummary(rec: OfflineTraceRecord): OfflineTraceSummary {
  return {
    id: rec.id,
    fileName: rec.fileName,
    title: rec.title,
    source: rec.source,
    activityName: rec.activityName,
    eventId: rec.eventId,
    fieldId: rec.fieldId,
    bytes: rec.bytes,
    savedAt: rec.savedAt,
    distanceKm: rec.distanceKm ?? null,
    elevationGainM: rec.elevationGainM ?? null
  };
}

@Injectable({ providedIn: 'root' })
export class OfflineTracesStore {
  readonly summaries$ = new BehaviorSubject<OfflineTraceSummary[]>([]);
  private dbPromise: Promise<IDBDatabase> | null = null;
  private persistAsked = false;

  constructor(private readonly ngZone: NgZone) {
    void this.ensurePersistent();
    void this.refresh();
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

  async refresh(): Promise<OfflineTraceSummary[]> {
    try {
      const db = await this.db();
      const all = (await reqToPromise(
        db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
      )) as OfflineTraceRecord[] | undefined;
      const list = (all || [])
        .filter((rec) => rec?.id && hasStoredPayload(rec.data))
        .map(toSummary)
        .sort((a, b) => b.savedAt - a.savedAt);
      this.publish(list);
      return list;
    } catch {
      this.publish([]);
      return [];
    }
  }

  async save(input: OfflineTraceSaveInput): Promise<void> {
    if (!input?.id || !(input.data instanceof ArrayBuffer) || input.data.byteLength <= 0) {
      throw new Error('empty_trace');
    }
    await this.ensurePersistent();
    const data = input.data.slice(0);
    const rec: OfflineTraceRecord = {
      id: input.id,
      fileName: (input.fileName || 'track.gpx').trim() || 'track.gpx',
      title: (input.title || input.fileName || 'track').trim() || 'track',
      source: input.source,
      activityName: input.activityName?.trim() || undefined,
      eventId: input.eventId?.trim() || undefined,
      fieldId: input.fieldId?.trim() || undefined,
      bytes: data.byteLength,
      savedAt: Date.now(),
      distanceKm: input.distanceKm ?? null,
      elevationGainM: input.elevationGainM ?? null,
      data
    };
    const db = await this.db();
    await reqToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put(rec));
    await this.refresh();
    await this.enterZone(Promise.resolve());
  }

  async get(id: string): Promise<OfflineTraceRecord | null> {
    const key = (id || '').trim();
    if (!key) {
      return null;
    }
    try {
      const db = await this.db();
      const rec = (await reqToPromise(
        db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      )) as OfflineTraceRecord | undefined;
      if (!rec || !rec.id) {
        return await this.enterZone(Promise.resolve(null));
      }
      const bytes = await clonePayload(rec.data);
      if (!bytes) {
        return await this.enterZone(Promise.resolve(null));
      }
      const record: OfflineTraceRecord = { ...rec, data: bytes };
      return await this.enterZone(Promise.resolve(record));
    } catch {
      return await this.enterZone(Promise.resolve(null));
    }
  }

  async delete(id: string): Promise<void> {
    const key = (id || '').trim();
    if (!key) {
      return;
    }
    const db = await this.db();
    await reqToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key));
    await this.refresh();
    await this.enterZone(Promise.resolve());
  }

  /** IndexedDB callbacks can resolve outside Angular; re-enter so the UI updates. */
  private enterZone<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      p.then(
        (value) => this.ngZone.run(() => resolve(value)),
        (error) => this.ngZone.run(() => reject(error))
      );
    });
  }

  private publish(list: OfflineTraceSummary[]): void {
    this.ngZone.run(() => this.summaries$.next(list));
  }

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDb().then((db) => {
        db.addEventListener('versionchange', () => {
          db.close();
          this.dbPromise = null;
        });
        return db;
      });
    }
    return this.dbPromise;
  }
}
