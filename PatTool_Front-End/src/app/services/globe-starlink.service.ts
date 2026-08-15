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
import type { GlobeSatelliteNowSnapshot } from './globe-satellite-now.service';

export interface StarlinkMember {
  noradId: number;
  name: string;
  lat: number;
  lon: number;
  altKm: number | null;
  velocityKmh: number | null;
  elevationDeg: number;
  azimuthDeg: number;
}

export interface StarlinkPass {
  lead: StarlinkMember;
  members: StarlinkMember[];
  visibleNow: boolean;
  nextVisibleAtMs: number | null;
  computedAtMs: number;
}

interface StarlinkRec {
  noradId: number;
  name: string;
  satrec: SatRec;
}

const TLE_MAX_AGE_MS = 3_600_000;
const PASS_CACHE_MS = 20_000;
const VISIBLE_EL_DEG = 15;
const TRAIN_MIN_COUNT = 3;
const TRAIN_AZ_GAP_DEG = 22;
const FUTURE_STEP_MS = 120_000;
const FUTURE_HORIZON_MS = 90 * 60_000;
const CANDIDATE_RANGE_DEG = 50;
const EARTH_RADIUS_KM = 6371;

@Injectable({ providedIn: 'root' })
export class GlobeStarlinkService {
  private readonly http = inject(HttpClient);
  private catalog: StarlinkRec[] = [];
  private fetchedAtMs = 0;
  private inflight: Promise<boolean> | null = null;
  private failUntilMs = 0;
  private observerLat: number | null = null;
  private observerLon: number | null = null;
  private lastPass: StarlinkPass | null = null;
  private lastPassAtMs = 0;
  private lastObsKey = '';

  setObserver(lat: number | null, lon: number | null): void {
    if (
      lat == null ||
      lon == null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      return;
    }
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (key !== this.lastObsKey) {
      this.lastPass = null;
      this.lastPassAtMs = 0;
    }
    this.observerLat = lat;
    this.observerLon = lon;
    this.lastObsKey = key;
  }

  lastComputedPass(): StarlinkPass | null {
    return this.lastPass;
  }

  async ensureCatalog(force = false): Promise<boolean> {
    if (!force && this.catalog.length > 0 && Date.now() - this.fetchedAtMs < TLE_MAX_AGE_MS) {
      return true;
    }
    if (!force && Date.now() < this.failUntilMs) {
      return this.catalog.length > 0;
    }
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.fetchCatalog()
      .then((ok) => {
        if (!ok) {
          this.failUntilMs = Date.now() + 120_000;
        }
        return ok;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  refreshPass(nowMs = Date.now()): StarlinkPass | null {
    if (
      this.lastPass &&
      nowMs - this.lastPassAtMs < PASS_CACHE_MS &&
      this.observerLat != null
    ) {
      return this.lastPass;
    }
    const pass = this.computePass(nowMs);
    if (pass) {
      this.lastPass = pass;
      this.lastPassAtMs = nowMs;
    }
    return pass;
  }

  leadSnapshot(nowMs = Date.now()): GlobeSatelliteNowSnapshot | null {
    const pass = this.refreshPass(nowMs);
    if (!pass) {
      return null;
    }
    const lead = this.propagateMember(this.recFor(pass.lead.noradId), new Date(nowMs), 0, 0);
    const src = lead ?? pass.lead;
    return {
      noradId: src.noradId,
      name: src.name,
      lat: src.lat,
      lon: src.lon,
      altKm: src.altKm,
      velocityKmh: src.velocityKmh,
      computedAtMs: nowMs
    };
  }

  private recFor(noradId: number): StarlinkRec | undefined {
    return this.catalog.find((r) => r.noradId === noradId);
  }

  private async fetchCatalog(): Promise<boolean> {
    try {
      const text = await firstValueFrom(
        this.http.get(`${environment.API_URL}external/globe/satellites/groups/starlink/tle`, {
          responseType: 'text'
        })
      );
      const parsed = GlobeStarlinkService.parseGroupTle(text || '');
      if (parsed.length < 10) {
        return false;
      }
      this.catalog = parsed;
      this.fetchedAtMs = Date.now();
      this.lastPass = null;
      return true;
    } catch {
      return false;
    }
  }

  private computePass(nowMs: number): StarlinkPass | null {
    if (this.catalog.length === 0 || this.observerLat == null || this.observerLon == null) {
      return null;
    }
    const obsLat = this.observerLat;
    const obsLon = this.observerLon;
    const nowVisible = this.visibleMembers(nowMs, obsLat, obsLon, VISIBLE_EL_DEG);
    if (nowVisible.length > 0) {
      return this.passFromVisible(nowVisible, true, null, nowMs);
    }
    const candidates = this.nearbyRecs(nowMs, obsLat, obsLon);
    const pool = candidates.length > 0 ? candidates : this.catalog;
    const endMs = nowMs + FUTURE_HORIZON_MS;
    for (let t = nowMs + FUTURE_STEP_MS; t <= endMs; t += FUTURE_STEP_MS) {
      const upcoming = this.visibleMembersAt(pool, t, obsLat, obsLon, 20);
      if (upcoming.length > 0) {
        return this.passFromVisible(upcoming, false, t, nowMs);
      }
    }
    return null;
  }

  private nearbyRecs(nowMs: number, obsLat: number, obsLon: number): StarlinkRec[] {
    const date = new Date(nowMs);
    const out: StarlinkRec[] = [];
    for (const rec of this.catalog) {
      const snap = this.propagateOnly(rec, date);
      if (!snap) {
        continue;
      }
      const range = GlobeStarlinkService.angularRangeDeg(obsLat, obsLon, snap.lat, snap.lon);
      if (range <= CANDIDATE_RANGE_DEG) {
        out.push(rec);
      }
    }
    return out;
  }

  private visibleMembers(
    nowMs: number,
    obsLat: number,
    obsLon: number,
    minEl: number
  ): StarlinkMember[] {
    return this.visibleMembersAt(this.catalog, nowMs, obsLat, obsLon, minEl);
  }

  private visibleMembersAt(
    recs: ReadonlyArray<StarlinkRec>,
    nowMs: number,
    obsLat: number,
    obsLon: number,
    minEl: number
  ): StarlinkMember[] {
    const date = new Date(nowMs);
    const out: StarlinkMember[] = [];
    for (const rec of recs) {
      const member = this.propagateMember(rec, date, obsLat, obsLon);
      if (member && member.elevationDeg >= minEl) {
        out.push(member);
      }
    }
    return out;
  }

  private passFromVisible(
    visible: StarlinkMember[],
    visibleNow: boolean,
    nextVisibleAtMs: number | null,
    computedAtMs: number
  ): StarlinkPass {
    const sorted = [...visible].sort((a, b) => b.elevationDeg - a.elevationDeg);
    const lead = sorted[0];
    const cluster = this.trainAround(sorted, lead);
    const members = cluster.length >= TRAIN_MIN_COUNT ? cluster : sorted.slice(0, 8);
    return {
      lead: cluster.length >= TRAIN_MIN_COUNT
        ? cluster.reduce((best, m) => (m.elevationDeg > best.elevationDeg ? m : best), cluster[0])
        : lead,
      members,
      visibleNow,
      nextVisibleAtMs,
      computedAtMs
    };
  }

  private trainAround(visible: StarlinkMember[], lead: StarlinkMember): StarlinkMember[] {
    return visible.filter(
      (m) => GlobeStarlinkService.azDiffDeg(m.azimuthDeg, lead.azimuthDeg) <= TRAIN_AZ_GAP_DEG
    );
  }

  private propagateMember(
    rec: StarlinkRec | undefined,
    date: Date,
    obsLat: number,
    obsLon: number
  ): StarlinkMember | null {
    if (!rec) {
      return null;
    }
    const snap = this.propagateOnly(rec, date);
    if (!snap) {
      return null;
    }
    const elevationDeg = GlobeStarlinkService.elevationDeg(
      obsLat,
      obsLon,
      snap.lat,
      snap.lon,
      snap.altKm ?? 550
    );
    const azimuthDeg = GlobeStarlinkService.bearingDeg(obsLat, obsLon, snap.lat, snap.lon);
    return { ...snap, elevationDeg, azimuthDeg };
  }

  private propagateOnly(
    rec: StarlinkRec,
    date: Date
  ): Omit<StarlinkMember, 'elevationDeg' | 'azimuthDeg'> | null {
    try {
      const pv = propagate(rec.satrec, date);
      if (!pv || typeof (pv as unknown) === 'boolean') {
        return null;
      }
      const pos = GlobeStarlinkService.asEciVec((pv as { position?: unknown }).position);
      if (!pos) {
        return null;
      }
      const gmst = gstime(date);
      const gd = eciToGeodetic(pos, gmst);
      const lat = degreesLat(gd.latitude);
      const lon = degreesLong(gd.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
      }
      const altKm = Number.isFinite(gd.height) ? gd.height : null;
      let velocityKmh: number | null = null;
      const vel = GlobeStarlinkService.asEciVec((pv as { velocity?: unknown }).velocity);
      if (vel) {
        const speedKmS = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
        velocityKmh = speedKmS * 3600;
      }
      return { noradId: rec.noradId, name: rec.name, lat, lon, altKm, velocityKmh };
    } catch {
      return null;
    }
  }

  private static parseGroupTle(text: string): StarlinkRec[] {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const out: StarlinkRec[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
      let name = `STARLINK`;
      let line1: string;
      let line2: string;
      if (i + 2 < lines.length && lines[i + 1].startsWith('1 ') && lines[i + 2].startsWith('2 ')) {
        name = lines[i].replace(/^0\s+/, '').trim() || name;
        line1 = lines[i + 1];
        line2 = lines[i + 2];
        i += 2;
      } else if (lines[i].startsWith('1 ') && lines[i + 1].startsWith('2 ')) {
        line1 = lines[i];
        line2 = lines[i + 1];
        i += 1;
      } else {
        continue;
      }
      const satrec = twoline2satrec(line1, line2);
      if (!satrec || satrec.error) {
        continue;
      }
      const noradId = Number.parseInt(line1.slice(2, 7), 10);
      if (!Number.isFinite(noradId) || noradId <= 0) {
        continue;
      }
      out.push({ noradId, name, satrec });
    }
    return out;
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

  private static azDiffDeg(a: number, b: number): number {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  private static angularRangeDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const r1 = (lat1 * Math.PI) / 180;
    const r2 = (lat2 * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const cosC = Math.sin(r1) * Math.sin(r2) + Math.cos(r1) * Math.cos(r2) * Math.cos(dLon);
    return (Math.acos(Math.max(-1, Math.min(1, cosC))) * 180) / Math.PI;
  }

  private static bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const r1 = (lat1 * Math.PI) / 180;
    const r2 = (lat2 * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos(r2);
    const x = Math.cos(r1) * Math.sin(r2) - Math.sin(r1) * Math.cos(r2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  private static elevationDeg(
    obsLat: number,
    obsLon: number,
    satLat: number,
    satLon: number,
    altKm: number
  ): number {
    const r1 = (obsLat * Math.PI) / 180;
    const r2 = (satLat * Math.PI) / 180;
    const dLon = ((satLon - obsLon) * Math.PI) / 180;
    const cosC = Math.sin(r1) * Math.sin(r2) + Math.cos(r1) * Math.cos(r2) * Math.cos(dLon);
    const gamma = Math.acos(Math.max(-1, Math.min(1, cosC)));
    const ratio = EARTH_RADIUS_KM / (EARTH_RADIUS_KM + Math.max(0, altKm));
    const elev = Math.atan2(Math.cos(gamma) - ratio, Math.sin(gamma));
    return (elev * 180) / Math.PI;
  }
}
