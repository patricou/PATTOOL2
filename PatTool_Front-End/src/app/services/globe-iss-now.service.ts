import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NavigationStart, Router } from '@angular/router';
import { filter } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

/** Réponse proxifiée ISS (/api/external/globe/iss/now). */
interface GlobeOpenNotifyIssResponse {
  iss_position?: {
    latitude?: string;
    longitude?: string;
    altitude_km?: string;
    velocity_kmh?: string;
  };
}

export interface GlobeIssNowSnapshot {
  lat: number;
  lon: number;
  altKm: number | null;
  velocityKmh: number | null;
  fetchedAtMs: number;
  prevLat?: number | null;
  prevLon?: number | null;
}

export interface GlobeIssForecastPoint {
  lat: number;
  lon: number;
  atSec: number;
}

export interface GlobeIssForecastSnapshot {
  points: GlobeIssForecastPoint[];
  approximate: boolean;
  fetchedAtMs: number;
}

const SESSION_CACHE_KEY = 'pat.world-globe.iss-now.cache';
const FORECAST_SESSION_CACHE_KEY = 'pat.world-globe.iss-forecast.cache';
/** Position utilisable immédiatement à l’ouverture (avec extrapolation légère). */
const DISPLAY_MAX_AGE_MS = 900_000;
const FORECAST_DISPLAY_MAX_AGE_MS = 900_000;
/** Prefetch périodique tant que l’app est ouverte. */
const PREFETCH_INTERVAL_MS = 45_000;
const ISS_FORECAST_MINUTES = 60;
const ISS_FORECAST_STEP_SEC = 120;
const ISS_DEFAULT_VELOCITY_KMH = 27_600;

interface IssForecastResponse {
  approximate?: boolean;
  points?: { latitude: number; longitude: number; timestamp: number }[];
}

@Injectable({ providedIn: 'root' })
export class GlobeIssNowService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  private snapshot: GlobeIssNowSnapshot | null = null;
  private forecastSnapshot: GlobeIssForecastSnapshot | null = null;
  private inflight: Promise<GlobeIssNowSnapshot | null> | null = null;
  private forecastInflight: Promise<GlobeIssForecastSnapshot | null> | null = null;
  private prefetchTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.snapshot = this.readSessionCache();
    this.forecastSnapshot = this.readForecastSessionCache();
    this.router.events.pipe(filter((e): e is NavigationStart => e instanceof NavigationStart)).subscribe((e) => {
      if (e.url.includes('world-globe')) {
        this.prefetch();
      }
    });
  }

  /** Lance le prefetch au démarrage de l’app (données souvent prêtes avant l’ouverture du globe). */
  startBackgroundPrefetch(): void {
    this.prefetch();
    if (this.prefetchTimer != null) {
      return;
    }
    this.prefetchTimer = setInterval(() => this.prefetch(), PREFETCH_INTERVAL_MS);
  }

  prefetch(): void {
    void this.refresh(false);
    void this.refreshForecast(false);
  }

  getForecastSnapshot(): GlobeIssForecastSnapshot | null {
    const cached = this.forecastSnapshot;
    if (!cached || Date.now() - cached.fetchedAtMs > FORECAST_DISPLAY_MAX_AGE_MS) {
      return null;
    }
    return cached;
  }

  /** Trace prévue approximative immédiate (sans attendre l’API forecast). */
  buildApproximateForecast(snap: GlobeIssNowSnapshot): GlobeIssForecastSnapshot | null {
    const pts = GlobeIssNowService.buildFallbackForecastPoints(snap);
    if (pts.length === 0) {
      return null;
    }
    return { points: pts, approximate: true, fetchedAtMs: Date.now() };
  }

  storeForecastSnapshot(snapshot: GlobeIssForecastSnapshot): void {
    this.forecastSnapshot = snapshot;
    this.writeForecastSessionCache(snapshot);
  }

  refreshForecast(forceNetwork = true): Promise<GlobeIssForecastSnapshot | null> {
    if (this.forecastInflight) {
      return this.forecastInflight;
    }
    if (!forceNetwork && this.forecastSnapshot && Date.now() - this.forecastSnapshot.fetchedAtMs < 30_000) {
      return Promise.resolve(this.forecastSnapshot);
    }
    const snap = this.snapshotForDisplay();
    if (!snap) {
      return Promise.resolve(null);
    }
    this.forecastInflight = this.fetchForecastFromNetwork(snap.lat, snap.lon)
      .then((network) => {
        if (network && network.points.length > 0) {
          this.storeForecastSnapshot(network);
          return network;
        }
        const approx = this.buildApproximateForecast(snap);
        if (approx) {
          this.storeForecastSnapshot(approx);
        }
        return approx;
      })
      .finally(() => {
        this.forecastInflight = null;
      });
    return this.forecastInflight;
  }

  getSnapshot(): GlobeIssNowSnapshot | null {
    return this.snapshotForDisplay(Date.now());
  }

  /** Position extrapolée pour affichage immédiat (cache session ou prefetch mémoire). */
  snapshotForDisplay(nowMs = Date.now()): GlobeIssNowSnapshot | null {
    const base = this.snapshot;
    if (!base) {
      return null;
    }
    if (nowMs - base.fetchedAtMs > DISPLAY_MAX_AGE_MS) {
      return null;
    }
    return this.extrapolateSnapshot(base, nowMs);
  }

  refresh(forceNetwork = true): Promise<GlobeIssNowSnapshot | null> {
    if (this.inflight) {
      return this.inflight;
    }
    if (!forceNetwork && this.snapshot && Date.now() - this.snapshot.fetchedAtMs < 5_000) {
      return Promise.resolve(this.snapshotForDisplay());
    }
    this.inflight = this.fetchFromNetwork()
      .then((snap) => {
        if (snap) {
          const prev = this.snapshot;
          this.snapshot = {
            ...snap,
            prevLat: prev?.lat ?? snap.prevLat ?? null,
            prevLon: prev?.lon ?? snap.prevLon ?? null
          };
          this.writeSessionCache(this.snapshot);
          void this.refreshForecast(true);
        }
        return this.snapshotForDisplay();
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchFromNetwork(): Promise<GlobeIssNowSnapshot | null> {
    try {
      const data = await firstValueFrom(
        this.http.get<GlobeOpenNotifyIssResponse>(`${environment.API_URL}external/globe/iss/now`)
      );
      const latStr = data?.iss_position?.latitude;
      const lonStr = data?.iss_position?.longitude;
      if (latStr == null || lonStr == null) {
        return null;
      }
      const lat = parseFloat(latStr);
      const lon = parseFloat(lonStr);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return null;
      }
      let altKm: number | null = null;
      const altStr = data?.iss_position?.altitude_km;
      if (altStr != null && altStr !== '') {
        const parsedAlt = parseFloat(altStr);
        altKm = Number.isFinite(parsedAlt) && parsedAlt >= 0 && parsedAlt <= 2000 ? parsedAlt : null;
      }
      let velocityKmh: number | null = null;
      const velStr = data?.iss_position?.velocity_kmh;
      if (velStr != null && velStr !== '') {
        const v = parseFloat(velStr);
        velocityKmh = Number.isFinite(v) && v >= 0 && v <= 50000 ? v : null;
      }
      return { lat, lon, altKm, velocityKmh, fetchedAtMs: Date.now() };
    } catch {
      return null;
    }
  }

  private extrapolateSnapshot(base: GlobeIssNowSnapshot, nowMs: number): GlobeIssNowSnapshot {
    const ageSec = (nowMs - base.fetchedAtMs) / 1000;
    if (ageSec <= 2) {
      return base;
    }
    const vel = base.velocityKmh;
    const prevLat = base.prevLat;
    const prevLon = base.prevLon;
    if (
      vel == null ||
      vel < 1000 ||
      prevLat == null ||
      prevLon == null ||
      !Number.isFinite(prevLat) ||
      !Number.isFinite(prevLon)
    ) {
      return base;
    }
    const bearing = GlobeIssNowService.initialBearingDeg(prevLat, prevLon, base.lat, base.lon);
    const distKm = vel * (ageSec / 3600);
    if (distKm <= 0 || distKm > 8000) {
      return base;
    }
    const next = GlobeIssNowService.destinationPoint(base.lat, base.lon, bearing, distKm);
    return { ...base, lat: next.lat, lon: next.lon };
  }

  private readSessionCache(): GlobeIssNowSnapshot | null {
    if (typeof sessionStorage === 'undefined') {
      return null;
    }
    try {
      const raw = sessionStorage.getItem(SESSION_CACHE_KEY);
      if (!raw) {
        return null;
      }
      const entry = JSON.parse(raw) as GlobeIssNowSnapshot;
      if (
        entry?.fetchedAtMs == null ||
        Date.now() - entry.fetchedAtMs > DISPLAY_MAX_AGE_MS ||
        !Number.isFinite(entry.lat) ||
        !Number.isFinite(entry.lon)
      ) {
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  }

  private writeSessionCache(entry: GlobeIssNowSnapshot): void {
    if (typeof sessionStorage === 'undefined') {
      return;
    }
    try {
      sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(entry));
    } catch {
      /* quota / mode privé */
    }
  }

  private async fetchForecastFromNetwork(
    lat: number,
    lon: number
  ): Promise<GlobeIssForecastSnapshot | null> {
    try {
      const data = await firstValueFrom(
        this.http.get<IssForecastResponse>(`${environment.API_URL}external/globe/iss/forecast`, {
          params: {
            minutes: String(ISS_FORECAST_MINUTES),
            stepSec: String(ISS_FORECAST_STEP_SEC)
          }
        })
      );
      const nowSec = Math.floor(Date.now() / 1000);
      const pts: GlobeIssForecastPoint[] = [];
      for (const p of [...(data?.points ?? [])].sort((a, b) => a.timestamp - b.timestamp)) {
        if (p.timestamp <= nowSec) {
          continue;
        }
        const plat = p.latitude;
        const plon = p.longitude;
        if (!Number.isFinite(plat) || !Number.isFinite(plon) || Math.abs(plat) > 90 || Math.abs(plon) > 180) {
          continue;
        }
        pts.push({ lat: plat, lon: plon, atSec: p.timestamp });
      }
      if (pts.length === 0) {
        return null;
      }
      return { points: pts, approximate: !!data?.approximate, fetchedAtMs: Date.now() };
    } catch {
      return null;
    }
  }

  private static buildFallbackForecastPoints(snap: GlobeIssNowSnapshot): GlobeIssForecastPoint[] {
    const lat = snap.lat;
    const lon = snap.lon;
    const speedKmh = snap.velocityKmh ?? ISS_DEFAULT_VELOCITY_KMH;
    let fromLat = snap.prevLat;
    let fromLon = snap.prevLon;
    if (
      fromLat == null ||
      fromLon == null ||
      !Number.isFinite(fromLat) ||
      !Number.isFinite(fromLon) ||
      (Math.abs(fromLat - lat) < 1e-7 && Math.abs(fromLon - lon) < 1e-7)
    ) {
      const back = GlobeIssNowService.destinationPoint(lat, lon, 270, Math.max(25, speedKmh / 120));
      fromLat = back.lat;
      fromLon = back.lon;
    }
    const bearing = GlobeIssNowService.initialBearingDeg(fromLat, fromLon, lat, lon);
    const stepSec = ISS_FORECAST_STEP_SEC;
    const steps = Math.floor((ISS_FORECAST_MINUTES * 60) / stepSec);
    const orbitTurnDegPerStep = (360 / (92 * 60)) * stepSec;
    const distKm = speedKmh * (stepSec / 3600);
    const nowSec = Math.floor(Date.now() / 1000);
    const pts: GlobeIssForecastPoint[] = [];
    let curLat = lat;
    let curLon = lon;
    let curBrng = bearing;
    for (let i = 0; i < steps; i++) {
      const next = GlobeIssNowService.destinationPoint(curLat, curLon, curBrng, distKm);
      pts.push({ lat: next.lat, lon: next.lon, atSec: nowSec + (i + 1) * stepSec });
      curLat = next.lat;
      curLon = next.lon;
      curBrng = (curBrng + orbitTurnDegPerStep + 360) % 360;
    }
    return pts;
  }

  private readForecastSessionCache(): GlobeIssForecastSnapshot | null {
    if (typeof sessionStorage === 'undefined') {
      return null;
    }
    try {
      const raw = sessionStorage.getItem(FORECAST_SESSION_CACHE_KEY);
      if (!raw) {
        return null;
      }
      const entry = JSON.parse(raw) as GlobeIssForecastSnapshot;
      if (
        entry?.fetchedAtMs == null ||
        Date.now() - entry.fetchedAtMs > FORECAST_DISPLAY_MAX_AGE_MS ||
        !Array.isArray(entry.points) ||
        entry.points.length === 0
      ) {
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  }

  private writeForecastSessionCache(entry: GlobeIssForecastSnapshot): void {
    if (typeof sessionStorage === 'undefined') {
      return;
    }
    try {
      sessionStorage.setItem(FORECAST_SESSION_CACHE_KEY, JSON.stringify(entry));
    } catch {
      /* quota / mode privé */
    }
  }

  private static initialBearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const r1 = (lat1 * Math.PI) / 180;
    const r2 = (lat2 * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos(r2);
    const x = Math.cos(r1) * Math.sin(r2) - Math.sin(r1) * Math.cos(r2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  private static destinationPoint(
    latDeg: number,
    lonDeg: number,
    bearingDeg: number,
    distKm: number
  ): { lat: number; lon: number } {
    const R = 6371;
    const br = (bearingDeg * Math.PI) / 180;
    const lat1 = (latDeg * Math.PI) / 180;
    const lon1 = (lonDeg * Math.PI) / 180;
    const angDist = distKm / R;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angDist) + Math.cos(lat1) * Math.sin(angDist) * Math.cos(br)
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(br) * Math.sin(angDist) * Math.cos(lat1),
        Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
      );
    return {
      lat: (lat2 * 180) / Math.PI,
      lon: ((((lon2 * 180) / Math.PI + 540) % 360) - 180)
    };
  }
}
