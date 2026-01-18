import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { KeycloakService } from '../keycloak/keycloak.service';
import { Member } from '../model/member';
import { environment } from '../../environments/environment';
import { Observable, from } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';

@Injectable()
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

  getGoveeDevices(user: Member): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post(this.API_URL + "govee/devices", user, { headers: headers })
      )
    );
  }

  getAllGoveeDevicesWithStates(user: Member): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post(this.API_URL + "govee/devices/all", user, { headers: headers })
      )
    );
  }

  getGoveeDeviceState(device: string, model: string): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        const requestBody = { device, model };
        return this._http.post(this.API_URL + "govee/device/state", requestBody, { headers: headers });
      })
    );
  }

  getThermometerHistory(deviceId: string): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        const requestBody = { deviceId };
        return this._http.post(this.API_URL + "govee/thermometer/history", requestBody, { headers: headers });
      })
    );
  }

  clearThermometerHistory(deviceId?: string): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        const requestBody = deviceId ? { deviceId } : {};
        return this._http.request('DELETE', this.API_URL + "govee/thermometer/history", {
          body: requestBody,
          headers: headers
        });
      })
    );
  }

  refreshThermometers(user: Member): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post(this.API_URL + "govee/thermometer/refresh", user, { headers: headers })
      )
    );
  }

  getSchedulerStatus(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(this.API_URL + "govee/thermometer/scheduler/status", { headers: headers })
      )
    );
  }

  toggleScheduler(enabled: boolean): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        const requestBody = { enabled };
        return this._http.post(this.API_URL + "govee/thermometer/scheduler/toggle", requestBody, { headers: headers });
      })
    );
  }

}
