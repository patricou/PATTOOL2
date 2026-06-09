import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/** Compact OpenFlights entry keyed by ICAO in airports-icao.json. */
export interface AirportIcaoEntry {
  n?: string;
  c?: string;
  i?: string;
  co?: string;
}

export interface ResolvedAirport {
  icao: string;
  name: string | null;
  city: string | null;
  iata: string | null;
  country: string | null;
}

/**
 * Resolves ICAO airport codes to name / city / IATA using bundled OpenFlights data.
 * Used as a client fallback when the backend has not enriched the flight state yet.
 */
@Injectable({ providedIn: 'root' })
export class AirportLookupService {
  private loadPromise: Promise<Map<string, AirportIcaoEntry>> | null = null;

  constructor(private readonly http: HttpClient) {}

  /** Synchronous resolve after {@link ensureLoaded} has completed. */
  resolveCached(icao: string | null | undefined, map: Map<string, AirportIcaoEntry>): ResolvedAirport | null {
    const code = (icao ?? '').trim().toUpperCase();
    if (code.length !== 4) {
      return null;
    }
    const entry = map.get(code);
    if (!entry) {
      return { icao: code, name: null, city: null, iata: null, country: null };
    }
    return {
      icao: code,
      name: entry.n?.trim() || null,
      city: entry.c?.trim() || null,
      iata: entry.i?.trim() || null,
      country: entry.co?.trim() || null
    };
  }

  ensureLoaded(): Promise<Map<string, AirportIcaoEntry>> {
    if (!this.loadPromise) {
      this.loadPromise = firstValueFrom(
        this.http.get<Record<string, AirportIcaoEntry>>('assets/airports-icao.json')
      ).then((raw) => {
        const map = new Map<string, AirportIcaoEntry>();
        for (const [icao, entry] of Object.entries(raw ?? {})) {
          map.set(icao.toUpperCase(), entry);
        }
        return map;
      }).catch(() => new Map<string, AirportIcaoEntry>());
    }
    return this.loadPromise;
  }
}
