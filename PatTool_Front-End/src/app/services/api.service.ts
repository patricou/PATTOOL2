import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { KeycloakService } from '../keycloak/keycloak.service';
import { Observable, Subject, Subscription, from, of, throwError } from 'rxjs';
import { map, switchMap, catchError } from 'rxjs/operators';
import { environment } from '../../environments/environment';

/**
 * Per-user North calibration of the ISS compass (GET/PUT /external/globe/iss/compass/calibration).
 * Four identification methods are supported:
 * - 'sensor': North handled by the device sensors (offset 0).
 * - 'manual': user pointed the phone top to North; offset corrects the raw heading.
 * - 'gps':    calibrated by walking (true GPS course).
 * - 'sun':    calibrated by aiming at the Sun (computed solar azimuth).
 */
export interface IssCompassCalibration {
  method: 'sensor' | 'manual' | 'gps' | 'sun';
  northOffsetDeg: number;
  calibratedAt?: string | null;
}

/** Current state of a tracked flight (proxy GET /external/globe/flight/state, OpenSky Network). */
export interface FlightState {
  icao24?: string | null;
  callsign?: string | null;
  originCountry?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  baroAltitudeM?: number | null;
  geoAltitudeM?: number | null;
  velocityMs?: number | null;
  trueTrackDeg?: number | null;
  verticalRateMs?: number | null;
  onGround?: boolean | null;
  lastContact?: number | null;
  /** ICAO code of estimated departure airport (OpenSky flights/aircraft). */
  departureAirport?: string | null;
  /** ICAO code of estimated arrival airport (OpenSky flights/aircraft). */
  arrivalAirport?: string | null;
  departureAirportName?: string | null;
  arrivalAirportName?: string | null;
  departureAirportIata?: string | null;
  arrivalAirportIata?: string | null;
  /** Municipality for departure airport (ICAO lookup). */
  departureCity?: string | null;
  /** Municipality for arrival airport (ICAO lookup). */
  arrivalCity?: string | null;
  /** Destination country (ICAO lookup or adsbdb). */
  arrivalCountry?: string | null;
  /** Estimated departure time (OpenSky firstSeen, Unix epoch seconds UTC). */
  departureTimeEpoch?: number | null;
  /** Estimated arrival time (OpenSky lastSeen, Unix epoch seconds UTC). */
  arrivalTimeEpoch?: number | null;
}

/** Per-user last tracked flight (GET/PUT /external/globe/flight/tracking). */
export interface FlightTrackingPreference {
  mode: 'callsign' | 'icao24';
  query: string;
  pollIntervalSec?: number | null;
}

/** Per-user trace viewer switches and basemap (GET/PUT /external/trace-viewer/preferences). */
export interface TraceViewerPreference {
  showAddress?: boolean | null;
  showWeather?: boolean | null;
  showWeatherStations?: boolean | null;
  autoRefreshRadar?: boolean | null;
  showHikingTrailsOverlay?: boolean | null;
  showCyclingTrailsOverlay?: boolean | null;
  followDeviceLocation?: boolean | null;
  keepScreenAwake?: boolean | null;
  showGpsCoordinates?: boolean | null;
  baseLayerId?: string | null;
  persisted?: boolean | null;
}

/** Waypoint of a full flight track (OpenSky /tracks/all). */
export interface FlightTrackPoint {
  time?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  baroAltitudeM?: number | null;
  trueTrackDeg?: number | null;
  onGround?: boolean | null;
}

/** Full flight trajectory from departure to arrival (or current position if in flight). */
export interface FlightTrack {
  icao24?: string | null;
  callsign?: string | null;
  startTime?: number | null;
  endTime?: number | null;
  points?: FlightTrackPoint[] | null;
}

/** ISS visible-pass e-mail alert configuration (GET/PUT /external/globe/iss/alert, per user). */
export interface IssAlertConfig {
  enabled: boolean;
  email: string;
  place: string;
  placeLabel: string;
  lat: number | null;
  lon: number | null;
  minQuality: string;
  leadMinutes: number;
}

/** One user's ISS alert (GET /external/globe/iss/alerts, admin only). */
export interface IssAlertAdminEntry {
  userId: string;
  owner?: string;
  enabled: boolean;
  email: string;
  place: string;
  placeLabel: string;
  lat?: number | null;
  lon?: number | null;
  minQuality: string;
}

/** Shared ISS globe UI switches (GET/PUT /external/globe/iss/global-prefs, all users). */
export interface GlobeIssGlobalPrefs {
  overlayEnabled?: boolean;
  historicalTraceEnabled?: boolean;
  historicalTraceDatesEnabled?: boolean;
  traceVisible?: boolean;
  keepEarthCentered?: boolean;
  tickerEnabled?: boolean;
  liveEmbedEnabled?: boolean;
  liveHdEmbedEnabled?: boolean;
  pollIntervalSec?: number;
}

/** One forecast source payload from GET /external/weather/forecast/stream (SSE). */
export interface ForecastSourceStreamEvent {
  source: 'openweathermap' | 'open-meteo' | 'meteofrance';
  list?: any[];
  error?: string;
}

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
  getCurrentWeatherByCoordinates(
    lat: number,
    lon: number,
    alt?: number | null,
    source?: 'openweathermap' | 'open-meteo' | 'meteofrance'
  ): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        let params = new HttpParams()
          .set('lat', lat.toString())
          .set('lon', lon.toString());
        if (alt !== null && alt !== undefined && !isNaN(alt)) {
          params = params.set('alt', alt.toString());
        }
        if (source) {
          params = params.set('source', source);
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
  getForecastByCoordinates(
    lat: number,
    lon: number,
    alt?: number | null,
    source?: 'openweathermap' | 'open-meteo' | 'meteofrance' | 'meteoswiss',
    horizonHours?: number,
    stepMinutes?: number
  ): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        let params = new HttpParams()
          .set('lat', lat.toString())
          .set('lon', lon.toString());
        if (alt !== null && alt !== undefined && !isNaN(alt)) {
          params = params.set('alt', alt.toString());
        }
        if (source) {
          params = params.set('source', source);
        }
        if (horizonHours != null && !isNaN(horizonHours)) {
          params = params.set('horizonHours', String(horizonHours));
        }
        if (stepMinutes != null && !isNaN(stepMinutes)) {
          params = params.set('stepMinutes', String(stepMinutes));
        }
        return this._http.get(this.API_URL + 'external/weather/forecast/coordinates', { 
          headers: headers,
          params: params
        });
      })
    );
  }

  /** MeteoSwiss Open Data cache status (forecast + precip map readiness). */
  getMeteoSwissStatus(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => this._http.get(this.API_URL + 'external/meteoswiss/status', { headers }))
    );
  }

  /** MeteoSwiss precipitation map animation — available hourly frames. */
  getMeteoSwissPrecipCapabilities(horizonHours?: number): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        let params = new HttpParams();
        if (horizonHours != null && !isNaN(horizonHours)) {
          params = params.set('horizonHours', String(horizonHours));
        }
        return this._http.get(this.API_URL + 'external/meteoswiss/precip/capabilities', {
          headers,
          params
        });
      })
    );
  }

  /** MeteoSwiss precipitation raster PNG for one UTC epoch (seconds). */
  getMeteoSwissPrecipFrame(dt: number): Observable<Blob> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        const params = new HttpParams().set('dt', String(dt));
        return this._http.get(this.API_URL + 'external/meteoswiss/precip/frame.png', {
          headers: headers.set('Accept', 'image/png,image/*,application/octet-stream,*/*'),
          params,
          responseType: 'blob'
        });
      })
    );
  }

  /** Aggregated forecast from OWM, Open-Meteo and Météo-France (seamless). */
  getAggregatedForecast(lat: number, lon: number, horizonHours?: number, stepMinutes?: number): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        let params = new HttpParams()
          .set('lat', lat.toString())
          .set('lon', lon.toString());
        if (horizonHours != null && !isNaN(horizonHours)) {
          params = params.set('horizonHours', String(horizonHours));
        }
        if (stepMinutes != null && !isNaN(stepMinutes)) {
          params = params.set('stepMinutes', String(stepMinutes));
        }
        return this._http.get(this.API_URL + 'external/weather/forecast/aggregated', {
          headers,
          params
        });
      })
    );
  }

  /**
   * SSE stream of forecast sources — each provider is emitted as soon as its upstream call completes.
   * Unsubscribing aborts the underlying fetch and cancels the stream reader.
   */
  streamForecastSources(
    lat: number,
    lon: number,
    horizonHours?: number,
    stepMinutes?: number,
    signal?: AbortSignal
  ): Observable<ForecastSourceStreamEvent> {
    const eventSubject = new Subject<ForecastSourceStreamEvent>();
    const abortController = new AbortController();
    const streamState: { reader: ReadableStreamDefaultReader<Uint8Array> | null } = { reader: null };
    let tokenSubscription: Subscription | null = null;

    const abortFromExternal = (): void => abortController.abort();
    if (signal) {
      if (signal.aborted) {
        return new Observable((subscriber) => {
          subscriber.complete();
          return undefined;
        });
      }
      signal.addEventListener('abort', abortFromExternal, { once: true });
    }

    tokenSubscription = this.getHeaderWithToken().subscribe({
      next: (headers) => {
        if (abortController.signal.aborted) {
          return;
        }
        const token = headers.get('Authorization') || '';
        const params = new URLSearchParams({
          lat: String(lat),
          lon: String(lon)
        });
        if (horizonHours != null && !isNaN(horizonHours)) {
          params.set('horizonHours', String(horizonHours));
        }
        if (stepMinutes != null && !isNaN(stepMinutes)) {
          params.set('stepMinutes', String(stepMinutes));
        }
        const url = `${this.API_URL}external/weather/forecast/stream?${params.toString()}`;
        this.consumeForecastSourceStream(url, token, eventSubject, abortController.signal, streamState).catch((err) => {
          if (!abortController.signal.aborted) {
            eventSubject.error(err);
          }
        });
      },
      error: (err) => {
        if (!abortController.signal.aborted) {
          eventSubject.error(err);
        }
      }
    });

    return new Observable<ForecastSourceStreamEvent>((subscriber) => {
      const subscription = eventSubject.subscribe(subscriber);
      return () => {
        abortController.abort();
        if (signal) {
          signal.removeEventListener('abort', abortFromExternal);
        }
        tokenSubscription?.unsubscribe();
        tokenSubscription = null;
        streamState.reader?.cancel().catch(() => undefined);
        streamState.reader = null;
        subscription.unsubscribe();
      };
    });
  }

  private async consumeForecastSourceStream(
    url: string,
    authToken: string,
    subject: Subject<ForecastSourceStreamEvent>,
    signal: AbortSignal,
    streamState: { reader: ReadableStreamDefaultReader<Uint8Array> | null }
  ): Promise<void> {
    const response = await fetch(url, {
      headers: {
        Authorization: authToken,
        Accept: 'text/event-stream'
      },
      cache: 'no-cache',
      signal
    });
    if (signal.aborted) {
      return;
    }
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      subject.error(new Error('No reader available'));
      return;
    }
    streamState.reader = reader;
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEventType: string | null = null;
    let currentData = '';

    const flushEvent = (): void => {
      if (!currentEventType) {
        currentData = '';
        return;
      }
      if (currentEventType === 'complete') {
        subject.complete();
      } else if (currentEventType === 'error') {
        subject.error(new Error(currentData || 'stream error'));
      } else {
        try {
          const parsed = JSON.parse(currentData) as ForecastSourceStreamEvent;
          subject.next(parsed);
        } catch {
          subject.error(new Error('Invalid forecast stream payload'));
        }
      }
      currentEventType = null;
      currentData = '';
    };

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (signal.aborted) {
        return;
      }
      if (done) {
        flushEvent();
        if (!subject.closed) {
          subject.complete();
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim() === '') {
          flushEvent();
          continue;
        }
        if (line.startsWith('event:')) {
          currentEventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const chunk = line.slice(5).trim();
          currentData = currentData ? `${currentData}\n${chunk}` : chunk;
        }
      }
    }
  }

  getMeteoFranceForecastPreferences(): Observable<MeteoFranceForecastPreference> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<MeteoFranceForecastPreference>(
          this.API_URL + 'external/meteofrance/forecast/preferences',
          { headers }
        )
      )
    );
  }

  saveMeteoFranceForecastPreferences(
    forecastHorizonHours: number,
    forecastStepMinutes: number
  ): Observable<MeteoFranceForecastPreference> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<MeteoFranceForecastPreference>(
          this.API_URL + 'external/meteofrance/forecast/preferences',
          { forecastHorizonHours, forecastStepMinutes },
          { headers }
        )
      )
    );
  }


  /** Météo-France radar / DPRadar status. */
  getMeteoFranceStatus(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(this.API_URL + 'external/meteofrance/status', { headers })
      )
    );
  }

  /** DPRadar observation metadata (validity_time). */
  getMeteoFranceRadarObservationMeta(
    zone = 'METROPOLE',
    observation = 'REFLECTIVITE',
    maille = 1000
  ): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        const params = new HttpParams()
          .set('zone', zone)
          .set('observation', observation)
          .set('maille', String(maille));
        return this._http.get(this.API_URL + 'external/meteofrance/radar/observation', { headers, params });
      })
    );
  }

  /** Fetch radar mosaic image via backend (handles auth). */
  fetchRadarMosaicBlob(url: string): Observable<Blob> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(url, {
          headers: headers.set('Accept', 'image/png,image/*,application/octet-stream,*/*'),
          responseType: 'blob'
        })
      )
    );
  }

  /** RainViewer tile metadata (host + frame paths), proxied by backend. */
  getRainViewerMaps(): Observable<any> {
    return this._http.get(this.API_URL + 'external/radar/rainviewer/maps');
  }

  /** Global radar auto-refresh settings (MongoDB appParameters, all users). */
  getMeteoFranceRadarPreferences(): Observable<MeteoFranceRadarPreference> {
    return this._http.get<MeteoFranceRadarPreference>(
      this.API_URL + 'external/meteofrance/radar/preferences'
    );
  }

  saveMeteoFranceRadarPreferences(
    prefs: Partial<Pick<MeteoFranceRadarPreference, 'radarRefreshSeconds' | 'autoRefreshEnabled'>>
  ): Observable<MeteoFranceRadarPreference> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<MeteoFranceRadarPreference>(
          this.API_URL + 'external/meteofrance/radar/preferences',
          prefs,
          { headers }
        )
      )
    );
  }

  /** Global map-layer switches + cloud opacity/intensity (MongoDB appParameters, all users). */
  getMeteoFranceMapLayerPreferences(): Observable<MeteoFranceMapLayerPreference> {
    return this._http.get<MeteoFranceMapLayerPreference>(
      this.API_URL + 'external/meteofrance/map-layer/preferences'
    );
  }

  saveMeteoFranceMapLayerPreferences(
    prefs: Partial<
      Pick<
        MeteoFranceMapLayerPreference,
        'showRadar' | 'showCloudLayer' | 'showTemperatureMap' | 'cloudOpacity' | 'cloudIntensity'
      >
    >
  ): Observable<MeteoFranceMapLayerPreference> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<MeteoFranceMapLayerPreference>(
          this.API_URL + 'external/meteofrance/map-layer/preferences',
          prefs,
          { headers }
        )
      )
    );
  }

  /** Per-user temperature observation cache TTL (MongoDB appParameters). */
  getMeteoFranceTemperatureCachePreferences(): Observable<MeteoFranceTemperatureCachePreference> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<MeteoFranceTemperatureCachePreference>(
          this.API_URL + 'external/meteofrance/temperature/cache/preferences',
          { headers }
        )
      )
    );
  }

  saveMeteoFranceTemperatureCachePreferences(
    temperatureCacheMinutes: number
  ): Observable<MeteoFranceTemperatureCachePreference> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<MeteoFranceTemperatureCachePreference>(
          this.API_URL + 'external/meteofrance/temperature/cache/preferences',
          { temperatureCacheMinutes },
          { headers }
        )
      )
    );
  }

  /** Per-user MF/MS station history cache retention (MongoDB appParameters). */
  getMeteoFranceHistoryCachePreferences(): Observable<MeteoFranceHistoryCachePreference> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<MeteoFranceHistoryCachePreference>(
          this.API_URL + 'external/meteofrance/history/cache/preferences',
          { headers }
        )
      )
    );
  }

  saveMeteoFranceHistoryCachePreferences(
    historyCacheDays: number
  ): Observable<MeteoFranceHistoryCachePreference> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<MeteoFranceHistoryCachePreference>(
          this.API_URL + 'external/meteofrance/history/cache/preferences',
          { historyCacheDays },
          { headers }
        )
      )
    );
  }

  /** Per-user AROME-PI map playback prefetch window (MongoDB appParameters). */
  getMeteoFranceAromepiPlaybackPreferences(): Observable<MeteoFranceAromepiPlaybackPreference> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<MeteoFranceAromepiPlaybackPreference>(
          this.API_URL + 'external/meteofrance/aromepi/playback/preferences',
          { headers }
        )
      )
    );
  }

  saveMeteoFranceAromepiPlaybackPreferences(
    prefetchAhead: number
  ): Observable<MeteoFranceAromepiPlaybackPreference> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<MeteoFranceAromepiPlaybackPreference>(
          this.API_URL + 'external/meteofrance/aromepi/playback/preferences',
          { prefetchAhead },
          { headers }
        )
      )
    );
  }

  /** Clears server-side MF + Open-Meteo temperature observation caches. */
  clearMeteoFranceTemperatureObservationCache(): Observable<MeteoFranceTemperatureCacheClearResult> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post<MeteoFranceTemperatureCacheClearResult>(
          this.API_URL + 'external/meteofrance/temperature/cache/clear',
          {},
          { headers }
        )
      )
    );
  }

  /** Per-user AROME-PI / ARPEGE forecast cache TTL (MongoDB appParameters). */
  getMeteoFranceForecastCachePreferences(): Observable<MeteoFranceForecastCachePreference> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<MeteoFranceForecastCachePreference>(
          this.API_URL + 'external/meteofrance/forecast/cache/preferences',
          { headers }
        )
      )
    );
  }

  saveMeteoFranceForecastCachePreferences(
    forecastCacheMinutes: number
  ): Observable<MeteoFranceForecastCachePreference> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<MeteoFranceForecastCachePreference>(
          this.API_URL + 'external/meteofrance/forecast/cache/preferences',
          { forecastCacheMinutes },
          { headers }
        )
      )
    );
  }

  /** Clears in-memory AROME-PI + ARPEGE forecast caches. */
  clearMeteoFranceForecastCaches(): Observable<MeteoFranceForecastCacheClearResult> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post<MeteoFranceForecastCacheClearResult>(
          this.API_URL + 'external/meteofrance/forecast/cache/clear',
          {},
          { headers }
        )
      )
    );
  }

  /** Dense screen grid (~1 cm) — POST list of lat/lon, proxied (MF IDW + Open-Meteo). */
  postWeatherTemperatureLabels(
    points: Array<{ lat: number; lon: number; stationId?: string }>,
    source?: 'meteofrance' | 'open-meteo' | 'openweathermap' | 'meteoswiss',
    refresh?: boolean
  ): Observable<WeatherTemperatureLabelGrid> {
    const body: {
      points: Array<{ lat: number; lon: number; stationId?: string }>;
      source?: string;
      refresh?: boolean;
    } = { points };
    if (source) {
      body.source = source;
    }
    if (refresh) {
      body.refresh = true;
    }
    return this._http.post<WeatherTemperatureLabelGrid>(
      this.API_URL + 'external/weather/map/temperature-labels',
      body
    );
  }

  /** DPObs v2 station temperatures in map bounds (actual station positions, no interpolated grid). */
  getMeteoFranceObsTemperatureLabels(
    minLat: number,
    maxLat: number,
    minLon: number,
    maxLon: number,
    maxStations = 24
  ): Observable<WeatherTemperatureLabelGrid> {
    const params = new HttpParams()
      .set('minLat', String(minLat))
      .set('maxLat', String(maxLat))
      .set('minLon', String(minLon))
      .set('maxLon', String(maxLon))
      .set('maxStations', String(maxStations));
    return this._http.get<WeatherTemperatureLabelGrid>(
      this.API_URL + 'external/meteofrance/obs/temperature-labels',
      { params }
    );
  }

  /** MeteoSwiss SwissMetNet station temperatures in map bounds (ogd-smn, open data). */
  getMeteoSwissObsTemperatureLabels(
    minLat: number,
    maxLat: number,
    minLon: number,
    maxLon: number,
    maxStations = 24
  ): Observable<WeatherTemperatureLabelGrid> {
    const params = new HttpParams()
      .set('minLat', String(minLat))
      .set('maxLat', String(maxLat))
      .set('minLon', String(minLon))
      .set('maxLon', String(maxLon))
      .set('maxStations', String(maxStations));
    return this._http.get<WeatherTemperatureLabelGrid>(
      this.API_URL + 'external/meteoswiss/obs/temperature-labels',
      { params }
    );
  }

  /** Nearest MeteoSwiss SMN station + hourly archived observations (ogd-smn, open data). */
  getMeteoSwissHistoryNearby(
    lat: number,
    lon: number,
    days = 7,
    stationId?: string,
    refresh = false
  ): Observable<any> {
    let params = new HttpParams()
      .set('lat', String(lat))
      .set('lon', String(lon))
      .set('days', String(days));
    if (stationId) {
      params = params.set('stationId', stationId);
    }
    if (refresh) {
      params = params.set('refresh', 'true');
    }
    return this._http.get(this.API_URL + 'external/meteoswiss/obs/history/nearby', { params });
  }

  /** Clears server-side MeteoSwiss SMN hourly history cache. */
  clearMeteoSwissHistoryCache(): Observable<WeatherHistoryCacheClearResult> {
    return this._http.post<WeatherHistoryCacheClearResult>(
      this.API_URL + 'external/meteoswiss/obs/history/cache/clear',
      {}
    );
  }

  /** Grid of current temperatures for map number labels (legacy GET). */
  getWeatherTemperatureLabels(
    minLat: number,
    maxLat: number,
    minLon: number,
    maxLon: number,
    cols: number,
    rows: number,
    maxStations?: number,
    source: 'meteofrance' | 'open-meteo' | 'openweathermap' = 'meteofrance'
  ): Observable<WeatherTemperatureLabelGrid> {
    let params = new HttpParams()
      .set('minLat', String(minLat))
      .set('maxLat', String(maxLat))
      .set('minLon', String(minLon))
      .set('maxLon', String(maxLon))
      .set('cols', String(cols))
      .set('rows', String(rows))
      .set('source', source);
    if (maxStations != null && maxStations > 0) {
      params = params.set('maxStations', String(maxStations));
    }
    return this._http.get<WeatherTemperatureLabelGrid>(
      this.API_URL + 'external/weather/map/temperature-labels',
      { params }
    );
  }

  /** Nearest MF climatological station + archived data (DPClim, proxied). */
  getMeteoFranceClimNearby(
    lat: number,
    lon: number,
    days = 30,
    frequency: 'quotidienne' | 'horaire' = 'quotidienne',
    department?: string,
    stationId?: string,
    refresh = false
  ): Observable<any> {
    let params = new HttpParams()
      .set('lat', String(lat))
      .set('lon', String(lon))
      .set('days', String(days))
      .set('frequency', frequency);
    if (department) {
      params = params.set('department', department);
    }
    if (stationId) {
      params = params.set('stationId', stationId);
    }
    if (refresh) {
      params = params.set('refresh', 'true');
    }
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(this.API_URL + 'external/meteofrance/clim/nearby', { headers, params })
      )
    );
  }

  /** Clears server-side MF DPClim nearby response cache. */
  clearMeteoFranceClimCache(): Observable<WeatherHistoryCacheClearResult> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post<WeatherHistoryCacheClearResult>(
          this.API_URL + 'external/meteofrance/clim/cache/clear',
          {},
          { headers }
        )
      )
    );
  }

  /** List climatological stations for a department. */
  getMeteoFranceClimStations(
    department: string,
    frequency: 'quotidienne' | 'horaire' = 'quotidienne'
  ): Observable<any> {
    const params = new HttpParams()
      .set('department', department)
      .set('frequency', frequency);
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(this.API_URL + 'external/meteofrance/clim/stations', { headers, params })
      )
    );
  }

  /** AROME-PI WMS capabilities (layers, time steps, domains, elevations). */
  getMeteoFranceAromepiCapabilities(domain?: string, referenceTime?: string): Observable<any> {
    let params = new HttpParams();
    if (domain) {
      params = params.set('domain', domain);
    }
    if (referenceTime) {
      params = params.set('referenceTime', referenceTime);
    }
    return this._http.get(this.API_URL + 'external/meteofrance/aromepi/capabilities', { params });
  }

  /** Current AROME-PI WMS throttle window (429 backoff). */
  getMeteoFranceAromepiThrottle(resetTileHint = false): Observable<{
    aromepiWmsThrottled?: boolean;
    aromepiWmsRetryAfterSeconds?: number;
    aromepiTilesCacheKnown?: boolean;
    aromepiTilesCached?: boolean;
    aromepiCapabilitiesCached?: boolean;
    forecastCacheTtlMinutes?: number;
  }> {
    let params = new HttpParams();
    if (resetTileHint) {
      params = params.set('resetTileHint', 'true');
    }
    return this._http.get<{
      aromepiWmsThrottled?: boolean;
      aromepiWmsRetryAfterSeconds?: number;
      aromepiTilesCacheKnown?: boolean;
      aromepiTilesCached?: boolean;
      aromepiCapabilitiesCached?: boolean;
      forecastCacheTtlMinutes?: number;
    }>(
      this.API_URL + 'external/meteofrance/aromepi/throttle',
      { params }
    );
  }

  /** Nearest Météo-France DPObs observation station for a point. */
  getMeteoFranceNearestObsStation(lat: number, lon: number): Observable<any> {
    const params = new HttpParams()
      .set('lat', String(lat))
      .set('lon', String(lon));
    return this._http.get(this.API_URL + 'external/meteofrance/obs/nearest-station', { params });
  }

  /** Build AROME-PI WMS tile URL (proxied, no JWT required on tile load). */
  buildMeteoFranceAromepiWmsTileUrl(
    z: number | string,
    x: number | string,
    y: number | string,
    layer: string,
    time: string,
    referenceTime: string,
    style?: string,
    domain?: string,
    elevation?: string,
    cacheBust?: number
  ): string {
    let params = new HttpParams()
      .set('layer', layer)
      .set('time', time)
      .set('referenceTime', referenceTime)
      .set('width', '256')
      .set('height', '256');
    if (style) {
      params = params.set('style', style);
    }
    if (domain) {
      params = params.set('domain', domain);
    }
    if (elevation) {
      params = params.set('elevation', elevation);
    }
    if (cacheBust && cacheBust > 0) {
      params = params.set('_', String(cacheBust));
    }
    return `${this.API_URL}external/meteofrance/aromepi/wms/${z}/${x}/${y}?${params.toString()}`;
  }

  /** AROME-PI GetFeatureInfo at a point. */
  getMeteoFranceAromepiFeatureInfo(
    lat: number,
    lon: number,
    layer: string,
    time: string,
    referenceTime: string,
    style?: string,
    domain?: string,
    elevation?: string
  ): Observable<any> {
    let params = new HttpParams()
      .set('lat', String(lat))
      .set('lon', String(lon))
      .set('layer', layer)
      .set('time', time)
      .set('referenceTime', referenceTime);
    if (style) {
      params = params.set('style', style);
    }
    if (domain) {
      params = params.set('domain', domain);
    }
    if (elevation) {
      params = params.set('elevation', elevation);
    }
    return this._http.get(this.API_URL + 'external/meteofrance/aromepi/featureinfo', { params });
  }

  /** AROME-PI point forecast timeline (0–6 h, 15 min steps). */
  getMeteoFranceAromepiPointForecast(
    lat: number,
    lon: number,
    referenceTime?: string,
    layers?: string[],
    domain?: string
  ): Observable<any> {
    let params = new HttpParams()
      .set('lat', String(lat))
      .set('lon', String(lon));
    if (referenceTime) {
      params = params.set('referenceTime', referenceTime);
    }
    if (domain) {
      params = params.set('domain', domain);
    }
    if (layers?.length) {
      layers.forEach((layer) => {
        params = params.append('layers', layer);
      });
    }
    return this._http.get(this.API_URL + 'external/meteofrance/aromepi/point-forecast', { params });
  }

  /** ARPEGE WMS capabilities (layers, time steps, domains, elevations). */
  getMeteoFranceArpegeCapabilities(domain?: string, referenceTime?: string): Observable<any> {
    let params = new HttpParams();
    if (domain) {
      params = params.set('domain', domain);
    }
    if (referenceTime) {
      params = params.set('referenceTime', referenceTime);
    }
    return this._http.get(this.API_URL + 'external/meteofrance/arpege/capabilities', { params });
  }

  /** Current ARPEGE WMS throttle window (429 backoff). */
  getMeteoFranceArpegeThrottle(resetTileHint = false): Observable<{
    arpegeWmsThrottled?: boolean;
    arpegeWmsRetryAfterSeconds?: number;
    arpegeTilesCacheKnown?: boolean;
    arpegeTilesCached?: boolean;
    arpegeCapabilitiesCached?: boolean;
    forecastCacheTtlMinutes?: number;
  }> {
    let params = new HttpParams();
    if (resetTileHint) {
      params = params.set('resetTileHint', 'true');
    }
    return this._http.get<{
      arpegeWmsThrottled?: boolean;
      arpegeWmsRetryAfterSeconds?: number;
      arpegeTilesCacheKnown?: boolean;
      arpegeTilesCached?: boolean;
      arpegeCapabilitiesCached?: boolean;
      forecastCacheTtlMinutes?: number;
    }>(
      this.API_URL + 'external/meteofrance/arpege/throttle',
      { params }
    );
  }

  /** Build ARPEGE WMS tile URL (proxied, no JWT required on tile load). */
  buildMeteoFranceArpegeWmsTileUrl(
    z: number | string,
    x: number | string,
    y: number | string,
    layer: string,
    time: string,
    referenceTime: string,
    style?: string,
    domain?: string,
    elevation?: string
  ): string {
    let params = new HttpParams()
      .set('layer', layer)
      .set('time', time)
      .set('referenceTime', referenceTime)
      .set('width', '256')
      .set('height', '256');
    if (style) {
      params = params.set('style', style);
    }
    if (domain) {
      params = params.set('domain', domain);
    }
    if (elevation) {
      params = params.set('elevation', elevation);
    }
    return `${this.API_URL}external/meteofrance/arpege/wms/${z}/${x}/${y}?${params.toString()}`;
  }

  /** ARPEGE GetFeatureInfo / point value at a location. */
  getMeteoFranceArpegeFeatureInfo(
    lat: number,
    lon: number,
    layer: string,
    time: string,
    referenceTime: string,
    style?: string,
    domain?: string,
    elevation?: string
  ): Observable<any> {
    let params = new HttpParams()
      .set('lat', String(lat))
      .set('lon', String(lon))
      .set('layer', layer)
      .set('time', time)
      .set('referenceTime', referenceTime);
    if (style) {
      params = params.set('style', style);
    }
    if (domain) {
      params = params.set('domain', domain);
    }
    if (elevation) {
      params = params.set('elevation', elevation);
    }
    return this._http.get(this.API_URL + 'external/meteofrance/arpege/featureinfo', { params });
  }

  /** ARPEGE point forecast timeline (0–102 h). */
  getMeteoFranceArpegePointForecast(
    lat: number,
    lon: number,
    referenceTime?: string,
    layers?: string[],
    domain?: string
  ): Observable<any> {
    let params = new HttpParams()
      .set('lat', String(lat))
      .set('lon', String(lon));
    if (referenceTime) {
      params = params.set('referenceTime', referenceTime);
    }
    if (domain) {
      params = params.set('domain', domain);
    }
    if (layers?.length) {
      layers.forEach((layer) => {
        params = params.append('layers', layer);
      });
    }
    return this._http.get(this.API_URL + 'external/meteofrance/arpege/point-forecast', { params });
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

  /** Cached sea-level elevation (m) for weather-station tooltips. */
  getStationElevation(lat: number, lon: number): Observable<{ altitudeM: number | null; source?: string }> {
    const url = this.API_URL + 'external/weather/elevation';
    const params = new HttpParams().set('lat', lat.toString()).set('lon', lon.toString());
    const requestNoAuth = () => this._http.get<{ altitudeM: number | null; source?: string }>(url, {
      headers: new HttpHeaders({ 'Accept': 'application/json', 'Content-Type': 'application/json; charset=UTF-8' }),
      params
    });
    return this.getHeaderWithToken().pipe(
      switchMap(headers => this._http.get<{ altitudeM: number | null; source?: string }>(url, { headers, params })),
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
  /**
   * ISS visible pass predictions for a place (geocode + Open Notify via backend).
   * @param index zero-based geocode candidate when the API returns status {@code ambiguous}.
   */
  /** Shared ISS globe UI switch states (MongoDB, same for every user). */
  getIssGlobalPrefs(): Observable<GlobeIssGlobalPrefs> {
    return this._http.get<GlobeIssGlobalPrefs>(this.API_URL + 'external/globe/iss/global-prefs');
  }

  setIssGlobalPrefs(prefs: GlobeIssGlobalPrefs): Observable<GlobeIssGlobalPrefs> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<GlobeIssGlobalPrefs>(
          this.API_URL + 'external/globe/iss/global-prefs',
          prefs,
          { headers }
        )
      )
    );
  }

  /** ISS trace recording toggle (MongoDB): globe client + server scheduler when enabled. */
  getIssTraceBackgroundRecording(): Observable<{ enabled: boolean; intervalMinutes: number }> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<{ enabled: boolean; intervalMinutes: number }>(
          this.API_URL + 'external/globe/iss/trace/background',
          { headers }
        )
      )
    );
  }

  setIssTraceBackgroundRecording(enabled: boolean): Observable<{ enabled: boolean; intervalMinutes: number }> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<{ enabled: boolean; intervalMinutes: number }>(
          this.API_URL + 'external/globe/iss/trace/background',
          { enabled },
          { headers }
        )
      )
    );
  }

  /** ISS trace display point-count limit (when enabled, server caps the returned trace to maxPoints). */
  getIssTraceDisplayLimit(): Observable<{ enabled: boolean; maxPoints: number }> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<{ enabled: boolean; maxPoints: number }>(
          this.API_URL + 'external/globe/iss/trace/display-limit',
          { headers }
        )
      )
    );
  }

  setIssTraceDisplayLimit(enabled: boolean): Observable<{ enabled: boolean; maxPoints: number }> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<{ enabled: boolean; maxPoints: number }>(
          this.API_URL + 'external/globe/iss/trace/display-limit',
          { enabled },
          { headers }
        )
      )
    );
  }

  /** Current ISS visible-pass e-mail alert configuration (place watched, recipient, quality). */
  getIssAlertConfig(): Observable<IssAlertConfig> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<IssAlertConfig>(this.API_URL + 'external/globe/iss/alert', { headers })
      )
    );
  }

  /** All configured ISS alert e-mails (admin only). */
  getIssAlertsAdmin(): Observable<IssAlertAdminEntry[]> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<IssAlertAdminEntry[]>(this.API_URL + 'external/globe/iss/alerts', { headers })
      )
    );
  }

  /** Delete the current user's ISS alert configuration. */
  deleteIssAlert(): Observable<void> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.delete<void>(this.API_URL + 'external/globe/iss/alert', { headers })
      )
    );
  }

  /** Delete one user's ISS alert configuration (admin only). */
  deleteIssAlertAdmin(userId: string): Observable<void> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.delete<void>(
          this.API_URL + 'external/globe/iss/alerts/' + encodeURIComponent(userId),
          { headers }
        )
      )
    );
  }

  /** Update the ISS alert configuration (place is geocoded server-side when it changes). */
  setIssAlertConfig(
    body: { enabled?: boolean; email?: string; place?: string; minQuality?: string }
  ): Observable<IssAlertConfig> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<IssAlertConfig>(this.API_URL + 'external/globe/iss/alert', body, { headers })
      )
    );
  }

  /** Update another user's ISS alert configuration (admin only). */
  setIssAlertConfigAdmin(
    userId: string,
    body: { enabled?: boolean; email?: string; place?: string; minQuality?: string }
  ): Observable<IssAlertConfig> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<IssAlertConfig>(
          this.API_URL + 'external/globe/iss/alerts/' + encodeURIComponent(userId),
          body,
          { headers }
        )
      )
    );
  }

  /**
   * Saved North calibration of the ISS compass for the current user, or null when none is stored
   * (backend answers 204 No Content, which HttpClient maps to a null body).
   */
  getIssCompassCalibration(): Observable<IssCompassCalibration | null> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<IssCompassCalibration | null>(
          this.API_URL + 'external/globe/iss/compass/calibration',
          { headers }
        )
      )
    );
  }

  /** Persist the user's chosen North calibration so it is reused on every compass open. */
  setIssCompassCalibration(body: IssCompassCalibration): Observable<IssCompassCalibration> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<IssCompassCalibration>(
          this.API_URL + 'external/globe/iss/compass/calibration',
          body,
          { headers }
        )
      )
    );
  }

  /**
   * Current state of a flight via the OpenSky proxy. {@code mode} is 'callsign' (radio call sign /
   * flight number) or 'icao24' (24-bit hex address). Returns null when the flight is not found (404).
   * Throws on upstream OpenSky failure (502).
   */
  getFlightState(mode: 'callsign' | 'icao24', query: string): Observable<FlightState | null> {
    const params = new HttpParams().set('mode', mode).set('q', query);
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<FlightState>(
          this.API_URL + 'external/globe/flight/state',
          { headers, params }
        )
      ),
      catchError((err: HttpErrorResponse) => {
        if (err.status === 404) {
          return from([null as FlightState | null]);
        }
        if (err.status === 502 || err.status === 503) {
          return throwError(() => err);
        }
        return from([null as FlightState | null]);
      })
    );
  }

  /**
   * Full flight track (departure → arrival) via OpenSky /tracks/all.
   * {@code time=0} (default) returns the live track when the aircraft is in flight.
   */
  getFlightTrack(icao24: string, time = 0): Observable<FlightTrack | null> {
    const params = new HttpParams().set('icao24', icao24).set('time', String(time));
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<FlightTrack>(
          this.API_URL + 'external/globe/flight/track',
          { headers, params }
        )
      ),
      catchError(() => from([null as FlightTrack | null]))
    );
  }

  /** Saved last tracked flight for the current user, or null when none is stored (204 → null body). */
  getFlightTracking(): Observable<FlightTrackingPreference | null> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<FlightTrackingPreference | null>(
          this.API_URL + 'external/globe/flight/tracking',
          { headers }
        )
      )
    );
  }

  /** Persist the user's last tracked flight so it is reused on the next visit. */
  setFlightTracking(body: FlightTrackingPreference): Observable<FlightTrackingPreference> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<FlightTrackingPreference>(
          this.API_URL + 'external/globe/flight/tracking',
          body,
          { headers }
        )
      )
    );
  }

  /** Forget the user's stored tracked flight. */
  deleteFlightTracking(): Observable<void> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.delete<void>(
          this.API_URL + 'external/globe/flight/tracking',
          { headers }
        )
      )
    );
  }

  /** Per-user trace viewer UI switches and basemap. */
  getTraceViewerPreferences(): Observable<TraceViewerPreference> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<TraceViewerPreference>(
          this.API_URL + 'external/trace-viewer/preferences',
          { headers }
        )
      )
    );
  }

  saveTraceViewerPreferences(
    prefs: Partial<TraceViewerPreference>
  ): Observable<TraceViewerPreference> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<TraceViewerPreference>(
          this.API_URL + 'external/trace-viewer/preferences',
          prefs,
          { headers }
        )
      )
    );
  }

  /** Send a test alert e-mail for the next upcoming visible pass over the configured place. */
  sendIssAlertTest(): Observable<{ ok: boolean; status: string }> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post<{ ok: boolean; status: string }>(
          this.API_URL + 'external/globe/iss/alert/test',
          {},
          { headers }
        )
      )
    );
  }

  getIssPassesByPlace(query: string, passCount = 5, index?: number): Observable<unknown> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        let params = new HttpParams().set('q', query).set('n', String(passCount));
        if (index != null && Number.isFinite(index)) {
          params = params.set('index', String(index));
        }
        return this._http.get<unknown>(this.API_URL + 'external/globe/iss/passes-by-place', {
          headers,
          params
        });
      })
    );
  }

  getIssPassesByCoordinates(lat: number, lon: number, passCount = 5): Observable<unknown> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        const params = new HttpParams()
          .set('lat', String(lat))
          .set('lon', String(lon))
          .set('n', String(passCount));
        return this._http.get<unknown>(this.API_URL + 'external/globe/iss/passes', {
          headers,
          params
        });
      })
    );
  }

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
  // IANA time zones — server-side conversion (java.time)
  // Backend: /api/external/timezone/* (no auth required)
  // ===================================================================

  getTimezoneZones(at?: string, dateTime?: string, zone?: string): Observable<{ zones: TimezoneZone[] }> {
    let params = new HttpParams();
    if (at) params = params.set('at', at);
    if (dateTime) params = params.set('dateTime', dateTime);
    if (zone) params = params.set('zone', zone);
    return this._http.get<{ zones: TimezoneZone[] }>(
      this.API_URL + 'external/timezone/zones',
      { params }
    );
  }

  getTimezoneNow(zone: string): Observable<TimezoneInstant> {
    const params = new HttpParams().set('zone', zone);
    return this._http.get<TimezoneInstant>(
      this.API_URL + 'external/timezone/now',
      { params }
    );
  }

  convertTimezone(dateTime: string, from: string, to: string): Observable<TimezoneConvertResponse> {
    const params = new HttpParams()
      .set('dateTime', dateTime)
      .set('from', from)
      .set('to', to);
    return this._http.get<TimezoneConvertResponse>(
      this.API_URL + 'external/timezone/convert',
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

  // ===================================================================
  // CoinGecko — crypto prices proxy
  // Backend: /api/external/crypto/* (no auth required — public data, server cache)
  // ===================================================================

  getCryptoPrices(): Observable<CryptoPricesResponse> {
    return this._http.get<CryptoPricesResponse>(
      this.API_URL + 'external/crypto/prices'
    );
  }

  getCryptoMarketChart(id: string, vs: 'eur' | 'usd' = 'eur', days = 30): Observable<CryptoMarketChartResponse> {
    const params = new HttpParams()
      .set('id', id)
      .set('vs', vs)
      .set('days', String(days));
    return this._http.get<CryptoMarketChartResponse>(
      this.API_URL + 'external/crypto/market-chart',
      { params }
    );
  }

  // ===================================================================
  // Électricité — ODRÉ, EDF, GeoNuclearData (+ ENTSO-E / EIA optionnels)
  // Backend: /api/external/electricity/*
  // ===================================================================

  getElectricityOverview(): Observable<ElectricityOverview> {
    return this._http.get<ElectricityOverview>(this.API_URL + 'external/electricity/overview');
  }

  getElectricityFrGeneration(hours = 24): Observable<ElectricityGenerationPoint[]> {
    return this._http.get<ElectricityGenerationPoint[]>(
      this.API_URL + 'external/electricity/fr/generation',
      { params: new HttpParams().set('hours', String(hours)) }
    );
  }

  getElectricityFrPlants(): Observable<ElectricityFrPlant[]> {
    return this._http.get<ElectricityFrPlant[]>(this.API_URL + 'external/electricity/fr/plants');
  }

  getElectricityFrUnavailabilities(active = true): Observable<ElectricityUnavailability[]> {
    return this._http.get<ElectricityUnavailability[]>(
      this.API_URL + 'external/electricity/fr/unavailabilities',
      { params: new HttpParams().set('active', String(active)) }
    );
  }

  getElectricityWorldNuclearPlants(): Observable<ElectricityNuclearPlant[]> {
    return this._http.get<ElectricityNuclearPlant[]>(
      this.API_URL + 'external/electricity/world/nuclear-plants'
    );
  }

  getElectricityEuNuclear(): Observable<ElectricityCountryNuclear[]> {
    return this._http.get<ElectricityCountryNuclear[]>(
      this.API_URL + 'external/electricity/eu/nuclear'
    );
  }

  getElectricityUsNuclear(): Observable<ElectricityCountryNuclear> {
    return this._http.get<ElectricityCountryNuclear>(
      this.API_URL + 'external/electricity/us/nuclear'
    );
  }

  // ===================================================================
  // Stellarium Web — sky map viewer + Noctua Sky catalogue proxy
  // Backend: /api/external/stellarium/* (no auth required — public data)
  // ===================================================================

  getStellariumConfig(lat?: number, lon?: number): Observable<StellariumConfig> {
    let params = new HttpParams();
    if (lat != null && lon != null) {
      params = params.set('lat', lat.toString()).set('lon', lon.toString());
    }
    return this._http.get<StellariumConfig>(
      this.API_URL + 'external/stellarium/config',
      { params }
    );
  }

  searchStellariumSkySources(query: string): Observable<StellariumSkySource[]> {
    const params = new HttpParams().set('q', query);
    return this._http.get<StellariumSkySource[]>(
      this.API_URL + 'external/stellarium/skysources',
      { params }
    );
  }

  getStellariumSkySourceByName(name: string): Observable<StellariumSkySource> {
    const encoded = encodeURIComponent(name);
    return this._http.get<StellariumSkySource>(
      this.API_URL + 'external/stellarium/skysources/name/' + encoded
    );
  }

  // ===================================================================
  // CERN — Open Data Portal & CDS Repository proxy
  // Backend: /api/external/cern/* (no auth required — public data)
  // ===================================================================

  getCernCatalog(): Observable<CernApiCatalog> {
    return this._http.get<CernApiCatalog>(this.API_URL + 'external/cern/catalog');
  }

  searchCernOpenData(
    q?: string,
    size = 10,
    page = 1,
    experiment?: string
  ): Observable<CernOpenDataSearchResult> {
    let params = new HttpParams().set('size', size).set('page', page);
    if (q) params = params.set('q', q);
    if (experiment) params = params.set('experiment', experiment);
    return this._http.get<CernOpenDataSearchResult>(
      this.API_URL + 'external/cern/opendata/records',
      { params }
    );
  }

  getCernOpenDataRecord(recid: number): Observable<CernOpenDataRecordDetail> {
    return this._http.get<CernOpenDataRecordDetail>(
      this.API_URL + 'external/cern/opendata/records/' + recid
    );
  }

  searchCernRepository(q?: string, size = 10, page = 1): Observable<CernRepositorySearchResult> {
    let params = new HttpParams().set('size', size).set('page', page);
    if (q) params = params.set('q', q);
    return this._http.get<CernRepositorySearchResult>(
      this.API_URL + 'external/cern/repository/records',
      { params }
    );
  }

  getCernRepositoryCommunities(size = 10, page = 1): Observable<CernRepositorySearchResult> {
    const params = new HttpParams().set('size', size).set('page', page);
    return this._http.get<CernRepositorySearchResult>(
      this.API_URL + 'external/cern/repository/communities',
      { params }
    );
  }

  searchCernZenodo(q?: string, size = 10, page = 1): Observable<CernOpenDataSearchResult> {
    let params = new HttpParams().set('size', size).set('page', page);
    if (q) params = params.set('q', q);
    return this._http.get<CernOpenDataSearchResult>(
      this.API_URL + 'external/cern/zenodo/records',
      { params }
    );
  }

  // ===================================================================
  // Chimie — PubChem proxy (periodic table, molecules, 2D/3D structures)
  // Backend: /api/external/chem/* (no auth required — public data)
  // ===================================================================

  getChemElements(): Observable<ChemElement[]> {
    return this._http.get<ChemElement[]>(this.API_URL + 'external/chem/elements');
  }

  getChemMoleculeByName(name: string): Observable<ChemMolecule> {
    const params = new HttpParams().set('name', name);
    return this._http.get<ChemMolecule>(this.API_URL + 'external/chem/molecule', { params });
  }

  getChemMoleculeByCid(cid: number): Observable<ChemMolecule> {
    return this._http.get<ChemMolecule>(this.API_URL + 'external/chem/molecule/' + cid);
  }

  chemAutocomplete(q: string, limit = 10): Observable<ChemAutocomplete> {
    const params = new HttpParams().set('q', q).set('limit', limit);
    return this._http.get<ChemAutocomplete>(this.API_URL + 'external/chem/autocomplete', { params });
  }

  getChemCidByFormula(formula: string): Observable<{ cid: number }> {
    const params = new HttpParams().set('value', formula);
    return this._http.get<{ cid: number }>(this.API_URL + 'external/chem/formula', { params });
  }

  /** Absolute URL of the proxied 2D structure PNG (works in dev and prod via API_URL). */
  chemImageUrl(cid: number): string {
    return this.API_URL + 'external/chem/image/' + cid;
  }

  // ===================================================================
  // TV watcher — free IPTV (iptv-org) catalog + HLS stream proxy
  // Backend: /api/external/tv/* (public)
  // ===================================================================

  getTvCountries(): Observable<TvCountry[]> {
    // Cache-buster query param (avoid custom headers that break CORS preflight).
    const params = new HttpParams().set('_', String(Date.now()));
    return this._http.get<TvCountry[]>(this.API_URL + 'external/tv/countries', { params });
  }

  getTvChannels(country: string, q?: string, group?: string): Observable<TvChannel[]> {
    let params = new HttpParams().set('country', country || 'fr');
    if (q && q.trim()) {
      params = params.set('q', q.trim());
    }
    if (group && group.trim()) {
      params = params.set('group', group.trim());
    }
    return this._http.get<TvChannel[]>(this.API_URL + 'external/tv/channels', { params });
  }

  getTvChannelCount(country: string = 'all'): Observable<{ country: string; count: number }> {
    const params = new HttpParams().set('country', country || 'all');
    return this._http.get<{ country: string; count: number }>(
      this.API_URL + 'external/tv/channel-count',
      { params }
    );
  }

  getTvGroups(country: string): Observable<string[]> {
    const params = new HttpParams().set('country', country || 'fr');
    return this._http.get<string[]>(this.API_URL + 'external/tv/groups', { params });
  }

  /**
   * Now / next EPG programmes for XMLTV channel ids (comma-separated, max ~80).
   * Keys in the response are canonical EPG ids (e.g. TF1.fr).
   */
  getTvEpgNow(country: string, ids: string[]): Observable<Record<string, TvEpgNow>> {
    const unique = [...new Set((ids || []).map((id) => (id || '').trim()).filter(Boolean))].slice(0, 80);
    if (!unique.length) {
      return of({});
    }
    const params = new HttpParams()
      .set('country', country || 'fr')
      .set('ids', unique.join(','));
    return this._http.get<Record<string, TvEpgNow>>(this.API_URL + 'external/tv/epg/now', { params });
  }

  /** Whether TF1 credentials are configured on the backend. */
  getTvTf1Status(): Observable<{ configured: boolean; channels?: string[] }> {
    return this._http.get<{ configured: boolean; channels?: string[] }>(
      this.API_URL + 'external/tv/live/tf1/status'
    );
  }

  /** Proxied HLS / media URL for a channel stream (Base64-URL path segment). */
  tvStreamProxyUrl(streamUrl: string): string {
    const bytes = new TextEncoder().encode(streamUrl);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const b64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return this.API_URL + 'external/tv/stream/' + b64;
  }

  /** GET /api/external/tv/favorites — JWT required, per-user list. */
  getTvFavorites(): Observable<TvFavorites> {
    return this.getHeaderWithToken().pipe(
      switchMap((headers) =>
        this._http.get<TvFavorites>(this.API_URL + 'external/tv/favorites', { headers })
      )
    );
  }

  /** PUT full favorites list. */
  saveTvFavorites(body: TvFavorites): Observable<TvFavorites> {
    return this.getHeaderWithToken().pipe(
      switchMap((headers) =>
        this._http.put<TvFavorites>(this.API_URL + 'external/tv/favorites', body, { headers })
      )
    );
  }

  /** PUT add one favorite channel. */
  addTvFavorite(channel: TvChannel): Observable<TvFavorites> {
    return this.getHeaderWithToken().pipe(
      switchMap((headers) =>
        this._http.put<TvFavorites>(this.API_URL + 'external/tv/favorites/item', channel, { headers })
      )
    );
  }

  /** DELETE remove one favorite by channel id. */
  removeTvFavorite(channelId: string): Observable<TvFavorites> {
    const params = new HttpParams().set('id', channelId || '');
    return this.getHeaderWithToken().pipe(
      switchMap((headers) =>
        this._http.delete<TvFavorites>(this.API_URL + 'external/tv/favorites/item', { headers, params })
      )
    );
  }

  /** GET last watched channel — JWT required, per-user. 204 when none. */
  getTvLastChannel(): Observable<TvChannel | null> {
    return this.getHeaderWithToken().pipe(
      switchMap((headers) =>
        this._http.get<TvChannel>(this.API_URL + 'external/tv/last-channel', {
          headers,
          observe: 'response'
        }).pipe(
          map((res) => (res.status === 204 ? null : res.body || null))
        )
      )
    );
  }

  /** PUT persist last watched channel for the current user. */
  saveTvLastChannel(channel: TvChannel): Observable<TvChannel> {
    return this.getHeaderWithToken().pipe(
      switchMap((headers) =>
        this._http.put<TvChannel>(this.API_URL + 'external/tv/last-channel', channel, { headers })
      )
    );
  }

  // ===================================================================
  // Loto — archives (scraping LesBonsNumeros côté serveur)
  // ===================================================================

  /** Tirages en base (GET public). */
  getLotoDraws(): Observable<LotoDrawRow[]> {
    return this._http.get<LotoDrawRow[]>(this.API_URL + 'loto/draws');
  }

  /** Import avec plage yyyy-MM (corps JSON, JWT admin). */
  syncLotoArchive(body: LotoSyncRequest): Observable<LotoSyncResult> {
    return this.getHeaderWithToken().pipe(
      switchMap((headers) =>
        this._http.post<LotoSyncResult>(this.API_URL + 'loto/sync', body, { headers })
      )
    );
  }

  /** Correction de la date de tirage (Mongo), JWT admin. */
  patchLotoDrawDate(body: LotoDrawDatePatch): Observable<LotoDrawRow> {
    return this.getHeaderWithToken().pipe(
      switchMap((headers) =>
        this._http.patch<LotoDrawRow>(this.API_URL + 'loto/draws', body, { headers })
      )
    );
  }

  // ===================================================================
  // EuroMillions — CSV import côté serveur (répertoire configuré)
  // ===================================================================

  getEuromillionsDraws(): Observable<EuromillionsDrawRow[]> {
    return this._http.get<EuromillionsDrawRow[]>(this.API_URL + 'euromillions/draws');
  }

  /** GET /api/euromillions/client-settings — date min assistant (Mongo appParameters sinon application.properties). */
  getEuromillionsClientSettings(): Observable<EuromillionsClientSettings> {
    return this._http.get<EuromillionsClientSettings>(this.API_URL + 'euromillions/client-settings');
  }

  /** PATCH /api/euromillions/client-settings — persiste euromillions.ai.min-draw-date (JWT admin). */
  patchEuromillionsClientSettings(body: EuromillionsClientSettingsPatch): Observable<EuromillionsClientSettings> {
    return this.getHeaderWithToken().pipe(
      switchMap((headers) =>
        this._http.patch<EuromillionsClientSettings>(
          this.API_URL + 'euromillions/client-settings',
          body,
          { headers }
        )
      )
    );
  }

  /** ZIP fdj.fr (archive février 2020+) → dossier configuré puis import Mongo (JWT admin). */
  fetchEuromillionsFdjArchiveAndImport(): Observable<EuromillionsSyncResult> {
    return this.getHeaderWithToken().pipe(
      switchMap((headers) =>
        this._http.post<EuromillionsSyncResult>(
          this.API_URL + 'euromillions/fdj-archive/import',
          {},
          { headers }
        )
      )
    );
  }

  patchEuromillionsDrawDate(body: EuromillionsDrawDatePatch): Observable<EuromillionsDrawRow> {
    return this.getHeaderWithToken().pipe(
      switchMap((headers) =>
        this._http.patch<EuromillionsDrawRow>(this.API_URL + 'euromillions/draws', body, { headers })
      )
    );
  }

  /** Liens optionnels (scanner interne, runbook) — JWT ; configurés dans pat.security-awareness.* */
  getSecurityAwarenessLinks(): Observable<SecurityAwarenessLinksDto> {
    return this.getHeaderWithToken().pipe(
      switchMap((headers) =>
        this._http.get<SecurityAwarenessLinksDto>(this.API_URL + 'config/security-awareness-links', {
          headers
        })
      )
    );
  }

  /** Sonde HTTP — JWT ; champ optionnel {@code includeActiveChecks} côté corps JSON. */
  passiveSiteProbe(body: PassiveProbeRequest): Observable<PassiveProbeResponse> {
    return this.getHeaderWithToken().pipe(
      switchMap((headers) =>
        this._http.post<PassiveProbeResponse>(this.API_URL + 'security-scan/passive-probe', body, { headers })
      )
    );
  }

  /** GET /api/admin/pattool-parameters — read-only application.properties snapshot (admin). */
  getPatToolParameters(): Observable<PatToolParametersResponse> {
    return this.getHeaderWithToken().pipe(
      switchMap((headers) =>
        this._http.get<PatToolParametersResponse>(this.API_URL + 'admin/pattool-parameters', { headers })
      )
    );
  }
}

/** GET /api/admin/pattool-parameters */
export interface PatToolParameterItem {
  key: string;
  value: string;
  description: string;
  /** application_properties | environment | mongodb | code_default | required | not_configured */
  origin: string;
  /** Java @Value fallback when defined in code */
  codeDefault?: string | null;
  sensitive: boolean;
  /** Plain-text hint from Java source analysis when curated i18n is missing */
  descriptionInferred?: string | null;
}

export interface PatToolParameterSection {
  id: string;
  labelKey: string;
  items: PatToolParameterItem[];
}

export interface PatToolParametersResponse {
  sections: PatToolParameterSection[];
  totalItems?: number;
}

/** POST /api/security-scan/passive-probe */
export interface PassiveProbeRequest {
  targetUrl: string;
  authorizationConfirmed: boolean;
  includeActiveChecks?: boolean;
}

export interface PassiveProbeResponse {
  requestedUrl: string;
  finalUrl: string | null;
  statusCode: number | null;
  checks: PassiveCheckRow[];
}

export interface PassiveCheckRow {
  id: string;
  severity: string;
  detail?: string | null;
}

/** GET /api/config/security-awareness-links */
export interface SecurityAwarenessLinksDto {
  scannerDashboardUrl?: string | null;
  internalRunbookUrl?: string | null;
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

/** IANA zone entry from /api/external/timezone/zones. */
export interface TimezoneZone {
  id: string;
  abbreviation: string;
  offset: string;
  offsetSeconds: number;
  label: string;
}

/** Date-time in a specific zone. */
export interface TimezoneInstant {
  dateTime: string;
  zone: string;
  abbreviation: string;
  iso: string;
  offset: string;
  dayDifference?: number | null;
}

/** Conversion result from /api/external/timezone/convert. */
export interface TimezoneConvertResponse {
  input: TimezoneInstant;
  outputs: TimezoneInstant[];
  instantUtc: string;
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

/** Tirage Loto importé (API PatTool /api/loto/draws). */
export interface LotoDrawRow {
  drawDate: string;
  numbers: number[];
  chance: number;
  gainDisplay?: string;
  detailUrl?: string;
}

/** Corps PATCH /api/loto/draws ({@code id} = URL fiche = clé Mongo). */
export interface LotoDrawDatePatch {
  id: string;
  drawDate: string;
}

/** Requête POST /api/loto/sync. */
export interface LotoSyncRequest {
  startYearMonth: string;
  endYearMonth: string;
}

/** Résultat du POST /api/loto/sync (import archives LesBonsNumeros). */
export interface LotoSyncResult {
  monthsProcessed: number;
  drawsUpserted: number;
  httpErrors: number;
  messages?: string[];
}

/** GET/PUT /api/external/meteofrance/radar/preferences (global, all users) */
export interface MeteoFranceRadarPreference {
  radarRefreshSeconds: number;
  autoRefreshEnabled: boolean;
  persistedInMongo?: boolean;
}

/** GET/PUT /api/external/meteofrance/map-layer/preferences (global, all users) */
export interface MeteoFranceMapLayerPreference {
  showRadar: boolean;
  showCloudLayer: boolean;
  showTemperatureMap: boolean;
  cloudOpacity: number;
  cloudIntensity: number;
  persistedInMongo?: boolean;
}

export interface MeteoFranceForecastPreference {
  forecastHorizonHours: number;
  forecastStepMinutes: number;
  persistedInMongo?: boolean;
}

export interface MeteoFranceTemperatureCachePreference {
  temperatureCacheMinutes: number;
  persistedInMongo?: boolean;
}

export interface MeteoFranceForecastCachePreference {
  forecastCacheMinutes: number;
  persistedInMongo?: boolean;
}

export interface MeteoFranceHistoryCachePreference {
  historyCacheDays: number;
  persistedInMongo?: boolean;
}

export interface MeteoFranceAromepiPlaybackPreference {
  prefetchAhead: number;
  persistedInMongo?: boolean;
}

export interface MeteoFranceTemperatureCacheClearResult {
  cleared?: boolean;
  mfCacheEntries?: number;
  openMeteoCacheEntries?: number;
}

export interface MeteoFranceForecastCacheClearResult {
  cleared?: boolean;
  totalEntries?: number;
  aromepi?: { totalEntries?: number };
  arpege?: { totalEntries?: number };
}

export interface WeatherHistoryCacheClearResult {
  cleared?: boolean;
  cacheEntries?: number;
}

/** GET /api/external/weather/map/temperature-labels */
export interface WeatherTemperatureLabelGrid {
  points?: Array<{
    lat: number;
    lon: number;
    tempC: number;
    stationId?: string;
    stationName?: string;
    humidityPct?: number;
    windDirectionDeg?: number;
    windSpeedMs?: number;
    windGustMs?: number;
    dewPointC?: number;
    precipitationMm?: number;
    pressureHpa?: number;
    observedAt?: string;
    source?: string;
    interpolated?: boolean;
  }>;
  cols?: number;
  rows?: number;
  source?: 'meteofrance-dpobs' | 'meteofrance-dpobs+open-meteo' | 'open-meteo' | string;
  fallback?: boolean;
  cached?: boolean;
  cacheTtlMinutes?: number;
  detailLevel?: string;
  count?: number;
  error?: string;
}

/** GET/PATCH /api/euromillions/client-settings */
export interface EuromillionsClientSettings {
  minDrawDateIso: string;
  /** Vrai lorsque {@code minDrawDateIso} provient du document Mongo {@code appParameters}. */
  minDrawDateFromMongoDatabase?: boolean;
}

/** Corps PATCH /api/euromillions/client-settings */
export interface EuromillionsClientSettingsPatch {
  minDrawDateIso: string;
}

/** Tirage EuroMillions (Mongo, /api/euromillions/draws). */
export interface EuromillionsDrawRow {
  drawDate: string;
  numbers: number[];
  stars: number[];
  gainDisplay?: string;
  drawCode: string;
}

/** PATCH /api/euromillions/draws : id = code tirage FDJ = clé Mongo. */
export interface EuromillionsDrawDatePatch {
  id: string;
  drawDate: string;
}

/** POST /api/euromillions/sync. */
export interface EuromillionsSyncResult {
  filesProcessed: number;
  drawsUpserted: number;
  rowsSkipped: number;
  httpErrors: number;
  messages?: string[];
}

// ===================================================================
// CERN — Open Data & CDS Repository
// ===================================================================

export interface CernApiCatalog {
  sources: CernApiSource[];
  relatedApis?: CernCatalogNote[];
}

export interface CernCatalogNote {
  name: string;
  upstreamBaseUrl: string | null;
  documentationUrl: string;
  note: string;
}

export interface CernApiSource {
  id: string;
  name: string;
  description: string;
  upstreamBaseUrl: string;
  documentationUrl: string;
  status: string;
  endpoints: CernApiEndpoint[];
}

export interface CernApiEndpoint {
  method: string;
  upstreamPath: string;
  patToolPath: string | null;
  description: string;
}

export interface CernOpenDataSearchResult {
  total: number;
  page: number;
  size: number;
  records: CernOpenDataRecordSummary[];
  experimentCounts: { [experiment: string]: number };
  typeCounts?: { [type: string]: number };
  yearCounts?: { [year: string]: number };
  availabilityCounts?: { [availability: string]: number };
  categoryCounts?: { [category: string]: number };
  collisionEnergyCounts?: { [energy: string]: number };
  collisionTypeCounts?: { [collisionType: string]: number };
}

export interface CernOpenDataRecordSummary {
  recid: number;
  title: string;
  type: string;
  experiments: string[];
  datePublished: string;
  availability: string;
  abstractPreview: string;
}

export interface CernOpenDataRecordDetail {
  recid: number;
  title: string;
  type: string;
  experiments: string[];
  accelerator: string;
  datePublished: string;
  availability: string;
  abstractText: string;
  keywords: string[];
  files: { key?: string; size?: number; uri?: string; checksum?: string }[];
  portalUrl: string;
  collisionEnergy?: string;
  collisionType?: string;
  numberEvents?: string;
}

export interface CernRepositorySearchResult {
  total: number;
  page: number;
  size: number;
  records: CernRepositoryRecordSummary[];
}

export interface CernRepositoryRecordSummary {
  id: string;
  title: string;
  publicationDate: string;
  resourceType: string;
}

// ===================================================================
// Chimie — PubChem
// ===================================================================

export interface ChemElement {
  atomicNumber: number;
  symbol: string;
  name: string;
  atomicMass: string;
  cpkHexColor: string;
  electronConfiguration: string;
  electronegativity: string;
  atomicRadius: string;
  ionizationEnergy: string;
  electronAffinity: string;
  oxidationStates: string;
  standardState: string;
  meltingPoint: string;
  boilingPoint: string;
  density: string;
  groupBlock: string;
  yearDiscovered: string;
  period: number;
  group: number;
  xpos: number;
  ypos: number;
}

export interface ChemAtom {
  atomicNumber: number;
  symbol: string;
  x: number;
  y: number;
  z: number;
}

export interface ChemBond {
  from: number;
  to: number;
  order: number;
}

export interface ChemMolecule {
  cid: number;
  name: string;
  molecularFormula: string;
  molecularWeight: string;
  iupacName: string;
  smiles: string;
  inchiKey: string;
  xlogp: string;
  charge: string;
  description: string;
  descriptionSource: string;
  descriptionUrl: string;
  imagePath: string;
  has3d: boolean;
  atoms: ChemAtom[];
  bonds: ChemBond[];
}

export interface ChemAutocomplete {
  query: string;
  suggestions: string[];
}

/** Stellarium Web viewer config (backend-built embed URLs). */
export interface StellariumConfig {
  lat: number;
  lon: number;
  placeLabel?: string;
  embedUrl: string;
  viewerUrl: string;
}

/** Noctua Sky catalogue entry (Stellarium Web API). */
export interface StellariumSkySource {
  interest?: number;
  match?: string;
  model?: string;
  model_data?: {
    ra?: number;
    de?: number;
    Vmag?: number;
    Bmag?: number;
    [key: string]: unknown;
  };
  names?: string[];
  short_name?: string;
  types?: string[];
}

/** CoinGecko proxy — one coin quote. */
export interface CryptoCoinQuote {
  id: string;
  symbol: string;
  name: string;
  priceEur?: number | null;
  priceUsd?: number | null;
  change24hPctEur?: number | null;
  change24hPctUsd?: number | null;
  marketCapEur?: number | null;
}

/** GET /api/external/crypto/prices */
export interface CryptoPricesResponse {
  updatedAt?: string;
  btc?: CryptoCoinQuote | null;
  eth?: CryptoCoinQuote | null;
  altcoins?: CryptoCoinQuote[];
}

/** GET /api/external/crypto/market-chart */
export interface CryptoMarketChartPoint {
  timestampMs: number;
  price: number;
}

export interface CryptoMarketChartResponse {
  id?: string;
  symbol?: string;
  name?: string;
  vsCurrency?: string;
  days?: number;
  points?: CryptoMarketChartPoint[];
  stale?: boolean;
  fetchedAt?: string;
}

/** GET /api/external/electricity/overview */
export interface ElectricityGenerationPoint {
  datetime?: string;
  nucleaire?: number | null;
  gaz?: number | null;
  eolien?: number | null;
  solaire?: number | null;
  hydraulique?: number | null;
  consommation?: number | null;
  bioenergies?: number | null;
  charbon?: number | null;
  fioul?: number | null;
  tauxCo2?: number | null;
}

export interface ElectricityFrPlant {
  centrale?: string;
  tranche?: string;
  puissanceInstalleeMw?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  region?: string;
  sousFiliere?: string;
  dateMiseEnService?: string;
  commune?: string;
}

export interface ElectricityUnavailability {
  identifiant?: string;
  nom?: string;
  filiere?: string;
  status?: string;
  type?: string;
  cause?: string;
  dateDebut?: string;
  dateFin?: string;
  puissanceMaximaleMw?: number | null;
  puissanceDisponibleMw?: number | null;
  informationComplementaire?: string;
}

export interface ElectricityNuclearPlant {
  id?: number;
  name?: string;
  country?: string;
  countryCode?: string;
  status?: string;
  reactorType?: string;
  capacityMw?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  operationalFrom?: string;
  operationalTo?: string;
}

export interface ElectricityCountryNuclear {
  countryCode?: string;
  countryName?: string;
  datetime?: string;
  nuclearMw?: number | null;
  source?: string;
  note?: string;
}

export interface ElectricityOverview {
  updatedAt?: string;
  frLatest?: ElectricityGenerationPoint | null;
  frHistory?: ElectricityGenerationPoint[];
  frPlantCount?: number;
  frInstalledNuclearMw?: number;
  frActiveUnavailabilityCount?: number;
  euNuclear?: ElectricityCountryNuclear[];
  usNuclear?: ElectricityCountryNuclear | null;
  entsoeConfigured?: boolean;
  eiaConfigured?: boolean;
  worldNuclearPlantCount?: number;
  worldOperationalCount?: number;
}

/** GET /api/external/tv/countries */
export interface TvCountry {
  code: string;
  name: string;
  flag?: string;
}

/** GET /api/external/tv/channels */
export interface TvChannel {
  id: string;
  name: string;
  logo?: string;
  group?: string;
  country?: string;
  streamUrl: string;
  quality?: string;
}

/** GET/PUT /api/external/tv/favorites — per authenticated user */
export interface TvFavorites {
  channels: TvChannel[];
}

/** GET /api/external/tv/epg/now */
export interface TvEpgProgramme {
  title?: string;
  description?: string;
  start?: string;
  stop?: string;
}

export interface TvEpgNow {
  now?: TvEpgProgramme | null;
  next?: TvEpgProgramme | null;
}
