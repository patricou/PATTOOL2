import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface AdsbdRouteAirport {
  icao: string;
  iata: string | null;
  name: string | null;
  city: string | null;
}

interface AdsbdCallsignResponse {
  response?: {
    flightroute?: {
      destination?: {
        icao_code?: string;
        iata_code?: string;
        name?: string;
        municipality?: string;
      };
    };
  };
}

/** Planned route destination via public adsbdb.com (no API key). */
@Injectable({ providedIn: 'root' })
export class FlightRouteLookupService {
  private readonly cache = new Map<string, { at: number; value: AdsbdRouteAirport | null }>();
  private readonly cacheTtlMs = 6 * 3_600_000;

  constructor(private readonly http: HttpClient) {}

  async destinationForCallsign(callsign: string | null | undefined): Promise<AdsbdRouteAirport | null> {
    const cs = (callsign ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(cs)) {
      return null;
    }
    const now = Date.now();
    const hit = this.cache.get(cs);
    if (hit && now - hit.at < this.cacheTtlMs) {
      return hit.value;
    }
    let resolved: AdsbdRouteAirport | null = null;
    try {
      const body = await firstValueFrom(
        this.http.get<AdsbdCallsignResponse>(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`)
      );
      const dest = body?.response?.flightroute?.destination;
      const icao = dest?.icao_code?.trim().toUpperCase();
      if (icao && icao.length === 4) {
        resolved = {
          icao,
          iata: dest?.iata_code?.trim().toUpperCase() || null,
          name: dest?.name?.trim() || null,
          city: dest?.municipality?.trim() || null
        };
      }
    } catch {
      resolved = null;
    }
    this.cache.set(cs, { at: now, value: resolved });
    return resolved;
  }
}
