import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, from } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';

@Injectable({
  providedIn: 'root'
})
export class ExceptionReportService {

    private API_URL: string = environment.API_URL;

    constructor(private _http: HttpClient, private _keycloakService: KeycloakService) {
    }

    /**
     * Get the token for Keycloak Security
     */
    getHeaderWithToken(): Observable<HttpHeaders> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Author': 'Zeus',
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                });
            })
        );
    }

    /**
     * Manually trigger exception report
     */
    sendExceptionReport(): Observable<string> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers =>
                this._http.post<string>(
                    `${this.API_URL}exception-report/send`,
                    {},
                    { headers, responseType: 'text' as 'json' }
                )
            )
        );
    }

    /**
     * Retrieve the latest exception report preview (HTML)
     */
    getExceptionReportPreview(): Observable<string> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers =>
                this._http.get<string>(
                    `${this.API_URL}exception-report/preview`,
                    { headers, responseType: 'text' as 'json' }
                )
            )
        );
    }
}
