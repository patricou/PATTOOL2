import { Injectable } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { ApiService, MeteoFranceHistoryCachePreference } from './api.service';

export interface MfClimCacheQuery {
  lat: number;
  lon: number;
  days: number;
  frequency: string;
  stationId?: string;
}

export interface MsHistCacheQuery {
  lat: number;
  lon: number;
  days: number;
  stationId?: string;
}

interface HistoryCacheEntry {
  data: unknown;
  loadedAt: number;
}

/** Session cache for MF DPClim and MeteoSwiss SMN history (Meteo-France tabs, timeline, trace viewer). */
@Injectable({ providedIn: 'root' })
export class WeatherHistoryCacheService {
  private readonly climEntries = new Map<string, HistoryCacheEntry>();
  private readonly msHistEntries = new Map<string, HistoryCacheEntry>();
  private retentionDays = 14;

  constructor(private apiService: ApiService) {
    this.loadRetentionPreference();
  }

  getRetentionDays(): number {
    return this.retentionDays;
  }

  setRetentionDays(days: number): void {
    const n = Math.round(Number(days));
    this.retentionDays = Number.isFinite(n)
      ? Math.max(1, Math.min(90, n))
      : 14;
    this.purgeExpired();
  }

  /** @deprecated Prefer {@link lookupClim} — kept for call-site cache-key tracking. */
  climKey(lat: number, lon: number, days: number, frequency: string, stationId?: string): string {
    return this.climKeys({ lat, lon, days, frequency, stationId })[0];
  }

  /** @deprecated Prefer {@link lookupMsHist}. */
  msHistKey(lat: number, lon: number, days: number, stationId?: string): string {
    return this.msHistKeys({ lat, lon, days, stationId })[0];
  }

  lookupClim(query: MfClimCacheQuery): unknown | undefined {
    this.purgeExpired();
    for (const key of this.climKeys(query)) {
      const hit = this.climEntries.get(key);
      if (hit && !this.isExpired(hit.loadedAt)) {
        return hit.data;
      }
    }
    return undefined;
  }

  setClim(query: MfClimCacheQuery, data: unknown): void {
    if (!this.isStorable(data)) {
      return;
    }
    const loadedAt = Date.now();
    for (const key of this.climKeys(query, data)) {
      this.climEntries.set(key, { data, loadedAt });
    }
  }

  clearClim(): number {
    const n = this.climEntries.size;
    this.climEntries.clear();
    return n;
  }

  lookupMsHist(query: MsHistCacheQuery): unknown | undefined {
    this.purgeExpired();
    for (const key of this.msHistKeys(query)) {
      const hit = this.msHistEntries.get(key);
      if (hit && !this.isExpired(hit.loadedAt)) {
        return hit.data;
      }
    }
    return undefined;
  }

  setMsHist(query: MsHistCacheQuery, data: unknown): void {
    if (!this.isStorable(data)) {
      return;
    }
    const loadedAt = Date.now();
    for (const key of this.msHistKeys(query, data)) {
      this.msHistEntries.set(key, { data, loadedAt });
    }
  }

  clearMsHist(): number {
    const n = this.msHistEntries.size;
    this.msHistEntries.clear();
    return n;
  }

  saveRetentionPreference(days: number): Observable<MeteoFranceHistoryCachePreference> {
    this.setRetentionDays(days);
    return this.apiService.saveMeteoFranceHistoryCachePreferences(this.retentionDays).pipe(
      tap({
        next: (pref) => {
          if (pref?.historyCacheDays != null) {
            this.setRetentionDays(pref.historyCacheDays);
          }
        }
      })
    );
  }

  private loadRetentionPreference(): void {
    this.apiService.getMeteoFranceHistoryCachePreferences().subscribe({
      next: (pref: MeteoFranceHistoryCachePreference) => {
        if (pref?.historyCacheDays != null) {
          this.setRetentionDays(pref.historyCacheDays);
        }
      },
      error: () => { /* default 14 days */ }
    });
  }

  private purgeExpired(): void {
    for (const [key, entry] of this.climEntries.entries()) {
      if (this.isExpired(entry.loadedAt)) {
        this.climEntries.delete(key);
      }
    }
    for (const [key, entry] of this.msHistEntries.entries()) {
      if (this.isExpired(entry.loadedAt)) {
        this.msHistEntries.delete(key);
      }
    }
  }

  private isExpired(loadedAt: number): boolean {
    return Date.now() - loadedAt > this.retentionDays * 86_400_000;
  }

  private climKeys(query: MfClimCacheQuery, data?: unknown): string[] {
    const keys = new Set<string>();
    const frequency = query.frequency;
    const days = query.days;
    const requestStation = this.normalizeStationId(query.stationId);
    const resolvedStation = this.normalizeStationId(this.stationIdFromData(data));
    if (requestStation) {
      keys.add(`mf|${requestStation}|${frequency}|${days}`);
    }
    if (resolvedStation) {
      keys.add(`mf|${resolvedStation}|${frequency}|${days}`);
    }
    keys.add(`mf|${query.lat.toFixed(4)},${query.lon.toFixed(4)}|${frequency}|${days}`);
    return [...keys];
  }

  private msHistKeys(query: MsHistCacheQuery, data?: unknown): string[] {
    const keys = new Set<string>();
    const days = query.days;
    const requestStation = this.normalizeStationId(query.stationId);
    const resolvedStation = this.normalizeStationId(this.stationIdFromData(data));
    if (requestStation) {
      keys.add(`ms|${requestStation}|${days}`);
    }
    if (resolvedStation) {
      keys.add(`ms|${resolvedStation}|${days}`);
    }
    keys.add(`ms|${query.lat.toFixed(4)},${query.lon.toFixed(4)}|${days}`);
    return [...keys];
  }

  private isStorable(data: unknown): boolean {
    return !!data && typeof data === 'object' && !(data as { error?: string }).error;
  }

  private stationIdFromData(data: unknown): string | undefined {
    if (!data || typeof data !== 'object') {
      return undefined;
    }
    const station = (data as { station?: { id?: string } }).station;
    return station?.id;
  }

  private normalizeStationId(stationId?: string): string {
    return (stationId || '').trim().toUpperCase();
  }
}
