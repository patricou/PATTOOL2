import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { KeycloakService } from '../keycloak/keycloak.service';
import { environment } from '../../environments/environment';
import { Observable, from } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';

@Injectable()
export class CacheService {
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

  saveCache(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post(this.API_URL + "cache/save", {}, { headers: headers })
      )
    );
  }

  loadCache(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post(this.API_URL + "cache/load", {}, { headers: headers })
      )
    );
  }

  clearCache(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post(this.API_URL + "cache/clear", {}, { headers: headers })
      )
    );
  }

  cacheFileExists(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(this.API_URL + "cache/exists", { headers: headers })
      )
    );
  }

  isShutdownAuthorized(user: any): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post(this.API_URL + "cache/shutdown/authorized", user, { headers: headers })
      )
    );
  }

  shutdownApplication(user: any): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post(this.API_URL + "cache/shutdown", user, { headers: headers })
      )
    );
  }

  getCacheStats(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(this.API_URL + "cache/stats", { headers: headers })
      )
    );
  }

  getConnectionLogs(startDate?: Date, endDate?: Date): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        let params = new HttpParams();
        if (startDate) {
          params = params.set('startDate', startDate.toISOString());
        }
        if (endDate) {
          params = params.set('endDate', endDate.toISOString());
        }
        return this._http.get(this.API_URL + "system/connection-logs", { 
          headers: headers,
          params: params
        });
      })
    );
  }
}

