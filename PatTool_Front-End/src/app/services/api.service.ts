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

  // ===================================================================
  // Twelve Data — stock exchange proxy
  // Backend: /api/external/stock/* (no auth required — server-side API key)
  // ===================================================================

  /**
   * List of instruments available on Twelve Data, optionally filtered by country.
   * Response can be huge (20k+) on unfiltered queries, so callers should always
   * pass a country. The first call is network-heavy; subsequent ones are cached
   * server-side for 24 h.
   */
  getStockSymbols(country?: string): Observable<StockSymbol[]> {
    let params = new HttpParams();
    if (country) params = params.set('country', country);
    return this._http.get<StockSymbol[]>(
      this.API_URL + 'external/stock/symbols',
      { params }
    );
  }

  /**
   * Full-text symbol search (ticker or company name).
   * Lets the user type e.g. "airbus" and pick the matching ticker from the
   * returned list (symbol + company + exchange + country).
   *
   * @param query  search text (2..64 chars, backend enforces)
   * @param size   optional max results (1..50, default 20)
   */
  searchStockSymbols(query: string, size?: number): Observable<StockSymbolSearchResult[]> {
    let params = new HttpParams().set('q', query);
    if (size !== undefined && size !== null) {
      params = params.set('size', size.toString());
    }
    return this._http.get<StockSymbolSearchResult[]>(
      this.API_URL + 'external/stock/search',
      { params }
    );
  }

  /**
   * Real-time quote for a single symbol.
   * <p>
   * Forwards the Keycloak JWT when available so the backend can tag the
   * cached quote with the caller's initials (used by the global ticker).
   * Anonymous fallback keeps the call working before the user logs in.
   */
  getStockQuote(symbol: string): Observable<StockQuote> {
    const url = this.API_URL + 'external/stock/quote';
    const params = new HttpParams().set('symbol', symbol);
    return this.getHeaderWithToken().pipe(
      switchMap(headers => this._http.get<StockQuote>(url, { headers, params })),
      catchError(() => this._http.get<StockQuote>(url, { params }))
    );
  }

  /**
   * Batch quotes. Returns a map keyed by symbol. Missing / errored symbols are
   * simply absent from the map, so callers can do {@code map[sym] ?? null}.
   * <p>
   * Same auth handling as {@link #getStockQuote}: JWT is forwarded when the
   * user is logged in so their initials get attached to every symbol in the
   * response.
   */
  getStockQuotesBatch(symbols: string[]): Observable<{ [symbol: string]: StockQuote }> {
    const url = this.API_URL + 'external/stock/quote/batch';
    const params = new HttpParams().set('symbols', symbols.join(','));
    return this.getHeaderWithToken().pipe(
      switchMap(headers => this._http.get<{ [symbol: string]: StockQuote }>(url, { headers, params })),
      catchError(() => this._http.get<{ [symbol: string]: StockQuote }>(url, { params }))
    );
  }

  /**
   * Snapshot of every quote currently in the backend's in-memory cache —
   * no call is made to Twelve Data. Used by the global ticker so it only
   * shows what users have already looked up, costing zero API credits.
   * Each entry carries {@code loaded_by} / {@code last_loaded_by} initials.
   */
  getCachedStockQuotes(): Observable<{ [symbol: string]: StockQuote }> {
    return this._http.get<{ [symbol: string]: StockQuote }>(
      this.API_URL + 'external/stock/quote/cached'
    );
  }

  /**
   * Purge the backend quote cache that feeds the ticker (quotes, time series,
   * loader initials, cached upstream errors). Symbol search/metadata caches
   * are preserved on the server because re-populating them would burn quota
   * for no UX gain. Returns the number of entries the server removed.
   */
  clearCachedStockQuotes(): Observable<{ removed: number }> {
    return this._http.delete<{ removed: number }>(
      this.API_URL + 'external/stock/quote/cached'
    );
  }

  /**
   * Historical OHLCV candles.
   * @param interval   one of: 1min, 5min, 15min, 30min, 45min, 1h, 2h, 4h, 1day, 1week, 1month
   * @param outputsize 1..5000 (default 30)
   */
  getStockTimeSeries(
    symbol: string,
    interval: string = '1day',
    outputsize: number = 30
  ): Observable<StockTimeSeries> {
    const params = new HttpParams()
      .set('symbol', symbol)
      .set('interval', interval)
      .set('outputsize', outputsize.toString());
    return this._http.get<StockTimeSeries>(
      this.API_URL + 'external/stock/timeseries',
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

// ===================================================================
// Twelve Data — stock exchange types
// Numeric fields come back as strings from the upstream API; the UI
// parses them with parseFloat where needed. Keeping them as string here
// means "null / not reported" is preserved verbatim instead of being
// coerced to 0.
// ===================================================================

/** Single stock quote (mirror of backend TwelveDataQuoteDto / CachedStockQuoteDto). */
export interface StockQuote {
  symbol: string;
  name?: string;
  exchange?: string;
  currency?: string;
  datetime?: string;
  timestamp?: number;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  volume?: string;
  previous_close?: string;
  change?: string;
  percent_change?: string;
  average_volume?: string;
  is_market_open?: boolean;

  /**
   * Populated only on responses from {@code /quote/cached}: initials of the
   * most recent user who looked this symbol up (e.g. "PD"). Anonymous
   * callers are not recorded.
   */
  last_loaded_by?: string;
  /** Up to 5 unique initials, most-recent first. */
  loaded_by?: string[];
}

/** One OHLCV candle from /time_series. */
export interface StockBar {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/** Full /time_series response: meta block + ordered candles (newest first in Twelve Data). */
export interface StockTimeSeries {
  meta?: {
    symbol?: string;
    interval?: string;
    currency?: string;
    exchange?: string;
    type?: string;
  };
  values?: StockBar[];
  status?: string;
}

/** Entry from /stocks — used to build the symbol picker. */
export interface StockSymbol {
  symbol: string;
  name?: string;
  currency?: string;
  exchange?: string;
  country?: string;
  type?: string;
}

/**
 * Entry from /symbol_search — used by the autocomplete.
 * Field names follow Twelve Data's raw response.
 */
export interface StockSymbolSearchResult {
  symbol: string;
  instrument_name?: string;
  exchange?: string;
  mic_code?: string;
  exchange_timezone?: string;
  instrument_type?: string;
  country?: string;
  currency?: string;
}
