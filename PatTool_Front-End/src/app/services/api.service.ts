import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { KeycloakService } from '../keycloak/keycloak.service';
import { Observable, from } from 'rxjs';
import { map, switchMap, catchError } from 'rxjs/operators';
import { environment } from '../../environments/environment';

@Injectable()
export class ApiService {

  private API_URL: string = environment.API_URL;

  constructor(private _http: HttpClient, private _keycloakService: KeycloakService) {
  }

  // Get the header with token for Keycloak Security
  private getHeaderWithToken(): Observable<HttpHeaders> {
    return from(this._keycloakService.getToken()).pipe(
      map((token: string) => {
        return new HttpHeaders({
          'Accept': 'application/json',
          'Content-Type': 'application/json; charset=UTF-8',
          'Authorization': 'Bearer ' + token
        });
      })
    );
  }

  /**
   * Get current weather for a city
   * @param city City name
   * @param countryCode Optional country code
   */
  getCurrentWeather(city: string, countryCode?: string): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        let params = new HttpParams().set('city', city);
        if (countryCode) {
          params = params.set('countryCode', countryCode);
        }
        return this._http.get(this.API_URL + 'external/weather/current', { 
          headers: headers,
          params: params
        });
      })
    );
  }

  /**
   * Get current weather by coordinates
   * @param lat Latitude
   * @param lon Longitude
   * @param alt Optional altitude in meters
   */
  getCurrentWeatherByCoordinates(lat: number, lon: number, alt?: number | null): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        let params = new HttpParams()
          .set('lat', lat.toString())
          .set('lon', lon.toString());
        if (alt !== null && alt !== undefined && !isNaN(alt)) {
          params = params.set('alt', alt.toString());
        }
        return this._http.get(this.API_URL + 'external/weather/current/coordinates', { 
          headers: headers,
          params: params
        });
      })
    );
  }

  /**
   * Get 5-day forecast for a city
   * @param city City name
   * @param countryCode Optional country code
   */
  getForecast(city: string, countryCode?: string): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        let params = new HttpParams().set('city', city);
        if (countryCode) {
          params = params.set('countryCode', countryCode);
        }
        return this._http.get(this.API_URL + 'external/weather/forecast', { 
          headers: headers,
          params: params
        });
      })
    );
  }

  /**
   * Get 5-day forecast by coordinates
   * @param lat Latitude
   * @param lon Longitude
   * @param alt Optional altitude in meters
   */
  getForecastByCoordinates(lat: number, lon: number, alt?: number | null): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        let params = new HttpParams()
          .set('lat', lat.toString())
          .set('lon', lon.toString());
        if (alt !== null && alt !== undefined && !isNaN(alt)) {
          params = params.set('alt', alt.toString());
        }
        return this._http.get(this.API_URL + 'external/weather/forecast/coordinates', { 
          headers: headers,
          params: params
        });
      })
    );
  }


  /**
   * Get all available altitudes with sources for coordinates.
   * Tries with auth first; if that fails (e.g. not logged in), retries without token (backend allows anonymous GET).
   */
  getAllAltitudes(lat: number, lon: number, alt?: number | null): Observable<any> {
    const url = this.API_URL + 'external/weather/altitudes';
    let params = new HttpParams().set('lat', lat.toString()).set('lon', lon.toString());
    if (alt !== null && alt !== undefined && !isNaN(alt)) {
      params = params.set('alt', alt.toString());
    }
    const requestNoAuth = () => this._http.get(url, {
      headers: new HttpHeaders({ 'Accept': 'application/json', 'Content-Type': 'application/json; charset=UTF-8' }),
      params
    });
    return this.getHeaderWithToken().pipe(
      switchMap(headers => this._http.get(url, { headers: headers, params: params })),
      catchError(() => requestNoAuth())
    );
  }

  /**
   * Get API status
   */
  getApiStatus(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(this.API_URL + 'external/weather/status', { headers: headers })
      )
    );
  }

  /**
   * Get Thunderforest API key for map tiles
   */
  getThunderforestApiKey(): Observable<string> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<{apiKey: string}>(this.API_URL + 'external/thunderforest/apikey', { headers: headers })
      ),
      map(response => response.apiKey || '')
    );
  }

  /**
   * Get IGN API key for map tiles
   */
  getIgnApiKey(): Observable<string> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<{apiKey: string}>(this.API_URL + 'external/ign/apikey', { headers: headers })
      ),
      map(response => response.apiKey || '')
    );
  }

  /**
   * Geocode: address query → list of results (lat, lon, displayName, address).
   * Uses backend proxy to Nominatim.
   */
  geocodeSearch(query: string): Observable<any[]> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        const params = new HttpParams().set('q', query);
        return this._http.get<any[]>(this.API_URL + 'external/geocode/search', { headers: headers, params: params });
      })
    );
  }

  /**
   * Reverse geocode: (lat, lon) → full Nominatim response (display_name, address, extratags, etc.).
   * Uses backend proxy to Nominatim.
   */
  geocodeReverse(lat: number, lon: number): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        const params = new HttpParams().set('lat', lat.toString()).set('lon', lon.toString());
        return this._http.get<any>(this.API_URL + 'external/geocode/reverse', { headers: headers, params: params });
      })
    );
  }

  /**
   * Get approximate location (lat, lon) from client IP via backend.
   */
  getLocationByIp(): Observable<{ status: string; lat?: number; lon?: number; countryCode?: string }> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<{ status: string; lat?: number; lon?: number; countryCode?: string }>(this.API_URL + 'external/geocode/location-by-ip', { headers: headers })
      )
    );
  }

  // ===================================================================
  // NewsAPI endpoints (backend proxy: /api/external/news/*)
  // ===================================================================

  /**
   * Top headlines. At least one of country / category / q should be set; backend
   * will fall back to country=us if none is provided to avoid a 400.
   */
  getTopHeadlines(options: {
    provider?: 'newsapi' | 'newsdata';
    country?: string;
    category?: string;
    q?: string;
    pageSize?: number;
    page?: number;
  }): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        let params = new HttpParams();
        if (options.provider) params = params.set('provider', options.provider);
        if (options.country)  params = params.set('country', options.country);
        if (options.category) params = params.set('category', options.category);
        if (options.q)        params = params.set('q', options.q);
        if (options.pageSize) params = params.set('pageSize', options.pageSize.toString());
        if (options.page)     params = params.set('page', options.page.toString());
        return this._http.get(this.API_URL + 'external/news/top-headlines', { headers, params });
      })
    );
  }

  /**
   * Full-text article search (NewsAPI /everything, NewsData.io /latest).
   * Requires {@code q}.
   */
  getEverything(options: {
    provider?: 'newsapi' | 'newsdata';
    q: string;
    language?: string;
    from?: string;
    to?: string;
    sortBy?: 'publishedAt' | 'relevancy' | 'popularity';
    pageSize?: number;
    page?: number;
  }): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        let params = new HttpParams().set('q', options.q);
        if (options.provider) params = params.set('provider', options.provider);
        if (options.language) params = params.set('language', options.language);
        if (options.from)     params = params.set('from', options.from);
        if (options.to)       params = params.set('to', options.to);
        if (options.sortBy)   params = params.set('sortBy', options.sortBy);
        if (options.pageSize) params = params.set('pageSize', options.pageSize.toString());
        if (options.page)     params = params.set('page', options.page.toString());
        return this._http.get(this.API_URL + 'external/news/everything', { headers, params });
      })
    );
  }

  /** Available news sources, optionally filtered. */
  getNewsSources(options: {
    provider?: 'newsapi' | 'newsdata';
    country?: string;
    category?: string;
    language?: string;
  } = {}): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        let params = new HttpParams();
        if (options.provider) params = params.set('provider', options.provider);
        if (options.country)  params = params.set('country', options.country);
        if (options.category) params = params.set('category', options.category);
        if (options.language) params = params.set('language', options.language);
        return this._http.get(this.API_URL + 'external/news/sources', { headers, params });
      })
    );
  }

  /** Status probe for the selected News provider, used by the status panel. */
  getNewsApiStatus(provider?: 'newsapi' | 'newsdata'): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        let params = new HttpParams();
        if (provider) params = params.set('provider', provider);
        return this._http.get(this.API_URL + 'external/news/status', { headers, params });
      })
    );
  }

  /**
   * Drop every cached response on the server for the selected provider
   * (bypasses the 30-min TTL). The next call will hit the network and
   * burn one quota slot. Used by the "force refresh" button.
   */
  clearNewsApiCache(provider?: 'newsapi' | 'newsdata'): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        let params = new HttpParams();
        if (provider) params = params.set('provider', provider);
        return this._http.post(this.API_URL + 'external/news/cache/clear', {}, { headers, params });
      })
    );
  }

  // ===================================================================
  // Frankfurter — currency exchange rates (ECB) proxy
  // Backend: /api/external/currency/* (no auth required — public data)
  // ===================================================================

  /**
   * All currencies supported by Frankfurter.
   * @returns Map of ISO code -> English display name (e.g. { "USD": "US Dollar", ... }).
   */
  getCurrencies(): Observable<{ [code: string]: string }> {
    return this._http.get<{ [code: string]: string }>(
      this.API_URL + 'external/currency/currencies'
    );
  }

  /**
   * Latest exchange rates published by the ECB.
   * @param base    Base currency (default EUR if omitted).
   * @param symbols Optional list of target currency codes (e.g. ['USD','GBP']).
   */
  getLatestRates(base?: string, symbols?: string[]): Observable<FrankfurterRates> {
    let params = new HttpParams();
    if (base) params = params.set('base', base);
    if (symbols && symbols.length) params = params.set('symbols', symbols.join(','));
    return this._http.get<FrankfurterRates>(
      this.API_URL + 'external/currency/latest',
      { params }
    );
  }

  /**
   * Historical rates for a single date.
   * @param date    ISO date (yyyy-MM-dd).
   * @param base    Optional base currency.
   * @param symbols Optional list of target currency codes.
   */
  getHistoricalRates(date: string, base?: string, symbols?: string[]): Observable<FrankfurterRates> {
    let params = new HttpParams().set('date', date);
    if (base) params = params.set('base', base);
    if (symbols && symbols.length) params = params.set('symbols', symbols.join(','));
    return this._http.get<FrankfurterRates>(
      this.API_URL + 'external/currency/historical',
      { params }
    );
  }

  /**
   * Time series of rates between two ISO dates (inclusive).
   * If {@code end} is omitted, Frankfurter returns data up to today.
   */
  getTimeseriesRates(
    start: string,
    end?: string,
    base?: string,
    symbols?: string[]
  ): Observable<FrankfurterTimeseries> {
    let params = new HttpParams().set('start', start);
    if (end) params = params.set('end', end);
    if (base) params = params.set('base', base);
    if (symbols && symbols.length) params = params.set('symbols', symbols.join(','));
    return this._http.get<FrankfurterTimeseries>(
      this.API_URL + 'external/currency/timeseries',
      { params }
    );
  }
}

/** Frankfurter /latest and /historical response shape. */
export interface FrankfurterRates {
  amount: number;
  base: string;
  date: string;
  rates: { [currency: string]: number };
}

/** Frankfurter /timeseries response shape. */
export interface FrankfurterTimeseries {
  amount: number;
  base: string;
  start_date: string;
  end_date: string;
  rates: { [isoDate: string]: { [currency: string]: number } };
}
