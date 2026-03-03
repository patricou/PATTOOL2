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
  getLocationByIp(): Observable<{ status: string; lat?: number; lon?: number }> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<{ status: string; lat?: number; lon?: number }>(this.API_URL + 'external/geocode/location-by-ip', { headers: headers })
      )
    );
  }
}
