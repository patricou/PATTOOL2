import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { KeycloakService } from '../keycloak/keycloak.service';
import { ChatResponse } from '../model/chat-response';
import { environment } from '../../environments/environment';
import { Observable, from } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';

@Injectable({
  providedIn: 'root'
})
export class PatgptService {
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

  getPatGptResponse(question: string, sendWithHistorical: boolean, lastxquestion: boolean): Observable<any> {

    const requestBody = { userInput: question };

    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post<any>(this.API_URL + "chat/" + sendWithHistorical + "/" + lastxquestion, requestBody, { headers: headers }).pipe(
          map((response: any) => new ChatResponse(response))
        )
      )
    );
  }

  delPatGptHistorical(): Observable<any> {

    //alert("Historical called");

    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.delete(this.API_URL + "delchat/", { headers: headers })
      )
    );
  }

}