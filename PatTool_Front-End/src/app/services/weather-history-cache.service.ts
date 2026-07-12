import { Injectable } from '@angular/core';

/** Session cache for MF DPClim and MeteoSwiss SMN history responses (main tabs + timeline). */
@Injectable({ providedIn: 'root' })
export class WeatherHistoryCacheService {
  private readonly climEntries = new Map<string, unknown>();
  private readonly msHistEntries = new Map<string, unknown>();

  climKey(
    lat: number,
    lon: number,
    days: number,
    frequency: string,
    stationId?: string
  ): string {
    return `${lat.toFixed(4)},${lon.toFixed(4)}|${days}|${frequency}|${stationId || ''}`;
  }

  msHistKey(lat: number, lon: number, days: number, stationId?: string): string {
    return `${lat.toFixed(4)},${lon.toFixed(4)}|${days}|${stationId || ''}`;
  }

  getClim(key: string): unknown | undefined {
    return this.climEntries.get(key);
  }

  setClim(key: string, data: unknown): void {
    if (data && typeof data === 'object' && !(data as { error?: string }).error) {
      this.climEntries.set(key, data);
    }
  }

  clearClim(): number {
    const n = this.climEntries.size;
    this.climEntries.clear();
    return n;
  }

  getMsHist(key: string): unknown | undefined {
    return this.msHistEntries.get(key);
  }

  setMsHist(key: string, data: unknown): void {
    if (data && typeof data === 'object' && !(data as { error?: string }).error) {
      this.msHistEntries.set(key, data);
    }
  }

  clearMsHist(): number {
    const n = this.msHistEntries.size;
    this.msHistEntries.clear();
    return n;
  }
}
