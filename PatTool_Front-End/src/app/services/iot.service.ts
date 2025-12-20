import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { KeycloakService } from '../keycloak/keycloak.service';
import { Member } from '../model/member';
import { environment } from '../../environments/environment';
import { Observable, from } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';

@Injectable({
  providedIn: 'root'
})
export class IotService {

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

  openOrClosePortail(user: Member): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post(this.API_URL + "opcl", user, { headers: headers })
      )
    );
  }

  testEThernetShield(user: Member): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post(this.API_URL + "testarduino", user, { headers: headers })
      )
    );
  }

}
