import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
  type SatRec
} from 'satellite.js';
import { environment } from '../../environments/environment';
import { satelliteUsesNetworkTle, type AstroSatelliteOption } from '../astro-compass/astro-compass-catalog';
import { GlobeStarlinkService } from './globe-starlink.service';

export interface GlobeSatelliteNowSnapshot {
  noradId: number;
  name: string;
  lat: number;
  lon: number;
  altKm: number | null;
  velocityKmh: number | null;
  computedAtMs: number;
}

interface CachedTle {
  noradId: number;
  name: string;
  line1: string;
  line2: string;
  satrec: SatRec;
  fetchedAtMs: number;
}

/** TLE usable for several hours; refresh periodically while the compass is open. */
const TLE_MAX_AGE_MS = 3_600_000;
/** After a 502 / empty TLE, wait before retrying (astro compass ticks every 1 s). */
const TLE_FAIL_RETRY_MS = 120_000;

@Injectable({ providedIn: 'root' })
export class GlobeSatelliteNowService {
  private readonly http = inject(HttpClient);
  private readonly starlink = inject(GlobeStarlinkService);
  private readonly tleByNorad = new Map<number, CachedTle>();
  private readonly inflight = new Map<number, Promise<CachedTle | null>>();
  private readonly failUntilMs = new Map<number, number>();

  setObserver(lat: number | null, lon: number | null): void {
    this.starlink.setObserver(lat, lon);
  }

  async ensureOption(sat: AstroSatelliteOption, forceNetwork = false): Promise<void> {
    if (sat.constellation === 'starlink') {
      await this.starlink.ensureCatalog(forceNetwork);
      this.starlink.refreshPass();
      return;
    }
    if (sat.skipLiveTle || sat.fixedGeo) {
      return;
    }
    await this.ensureTle(sat.noradId, forceNetwork);
  }

  starlinkPass() {
    return this.starlink.lastComputedPass();
  }

  snapshotForOption(sat: AstroSatelliteOption, nowMs = Date.now()): GlobeSatelliteNowSnapshot | null {
    if (sat.fixedGeo) {
      return {
        noradId: sat.noradId,
        name: sat.id,
        lat: sat.fixedGeo.lat,
        lon: sat.fixedGeo.lon,
        altKm: sat.fixedGeo.altKm,
        velocityKmh: 0,
        computedAtMs: nowMs
      };
    }
    if (sat.constellation === 'starlink') {
      return this.starlink.leadSnapshot(nowMs);
    }
    return this.snapshotForDisplay(sat.noradId, nowMs);
  }

  /** Prefetch TLEs for a set of NORAD ids (fire-and-forget). */
  prefetch(noradIds: ReadonlyArray<number>): void {
    for (const id of noradIds) {
      void this.ensureTle(id, false);
    }
  }

  async ensureTle(noradId: number, forceNetwork = false): Promise<CachedTle | null> {
    const existing = this.tleByNorad.get(noradId);
    if (!forceNetwork && existing && Date.now() - existing.fetchedAtMs < TLE_MAX_AGE_MS) {
      return existing;
    }
    if (!forceNetwork) {
      const until = this.failUntilMs.get(noradId);
      if (until != null && Date.now() < until) {
        return existing ?? null;
      }
    }
    const pending = this.inflight.get(noradId);
    if (pending) {
      return pending;
    }
    const job = this.fetchTle(noradId)
      .then((entry) => {
        if (entry) {
          this.tleByNorad.set(noradId, entry);
          this.failUntilMs.delete(noradId);
        } else {
          this.failUntilMs.set(noradId, Date.now() + TLE_FAIL_RETRY_MS);
        }
        return entry;
      })
      .finally(() => this.inflight.delete(noradId));
    this.inflight.set(noradId, job);
    return job;
  }

  /** Live geodetic position from cached TLE + SGP4 (null if TLE missing / propagate failed). */
  snapshotForDisplay(noradId: number, nowMs = Date.now()): GlobeSatelliteNowSnapshot | null {
    const tle = this.tleByNorad.get(noradId);
    if (!tle) {
      return null;
    }
    try {
      const date = new Date(nowMs);
      const pv = propagate(tle.satrec, date);
      // satellite.js types: propagate may return false-like boolean on failure.
      if (!pv || typeof (pv as unknown) === 'boolean') {
        return null;
      }
      const pos = GlobeSatelliteNowService.asEciVec((pv as { position?: unknown }).position);
      if (!pos) {
        return null;
      }
      const gmst = gstime(date);
      const gd = eciToGeodetic(pos, gmst);
      const lat = degreesLat(gd.latitude);
      const lon = degreesLong(gd.longitude);
      const altKm = Number.isFinite(gd.height) ? gd.height : null;
      let velocityKmh: number | null = null;
      const vel = GlobeSatelliteNowService.asEciVec((pv as { velocity?: unknown }).velocity);
      if (vel) {
        const speedKmS = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
        velocityKmh = speedKmS * 3600;
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
      }
      return {
        noradId,
        name: tle.name,
        lat,
        lon,
        altKm,
        velocityKmh,
        computedAtMs: nowMs
      };
    } catch {
      return null;
    }
  }

  private static asEciVec(value: unknown): { x: number; y: number; z: number } | null {
    if (!value || typeof value !== 'object') {
      return null;
    }
    const v = value as { x?: unknown; y?: unknown; z?: unknown };
    if (
      typeof v.x !== 'number' ||
      typeof v.y !== 'number' ||
      typeof v.z !== 'number' ||
      !Number.isFinite(v.x) ||
      !Number.isFinite(v.y) ||
      !Number.isFinite(v.z)
    ) {
      return null;
    }
    return { x: v.x, y: v.y, z: v.z };
  }

  private async fetchTle(noradId: number): Promise<CachedTle | null> {
    try {
      const text = await firstValueFrom(
        this.http.get(`${environment.API_URL}external/globe/satellites/${noradId}/tle`, {
          responseType: 'text'
        })
      );
      const lines = (text || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length < 2) {
        return null;
      }
      let name = `NORAD ${noradId}`;
      let line1: string;
      let line2: string;
      if (lines.length >= 3 && lines[1].startsWith('1 ') && lines[2].startsWith('2 ')) {
        name = lines[0];
        line1 = lines[1];
        line2 = lines[2];
      } else if (lines[0].startsWith('1 ') && lines[1].startsWith('2 ')) {
        line1 = lines[0];
        line2 = lines[1];
      } else {
        return null;
      }
      const satrec = twoline2satrec(line1, line2);
      if (!satrec || satrec.error) {
        return null;
      }
      return {
        noradId,
        name,
        line1,
        line2,
        satrec,
        fetchedAtMs: Date.now()
      };
    } catch {
      return null;
    }
  }
}
