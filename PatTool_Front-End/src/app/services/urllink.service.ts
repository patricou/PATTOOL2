import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { KeycloakService } from '../keycloak/keycloak.service';
import { environment } from '../../environments/environment';
import { Observable, from } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { urllink } from '../model/urllink';
import { Category } from '../model/Category';
import { Member } from '../model/member';

@Injectable()
export class UrllinkService {

	private API_URL: string = environment.API_URL;

	constructor(private _http: HttpClient, private _keycloakService: KeycloakService) {
	}
	// Get the header with token for Keycloak Security
	private getHeaderWithToken(): Observable<HttpHeaders> {
		return from(this._keycloakService.getToken()).pipe(
			map((token: string) => {
				return new HttpHeaders({
					'Accept': 'application/json',
					'Content-Type': 'application/json',
					'Authorization': 'Bearer ' + token
				});
			})
		);
	}

	getLinks(user: Member): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers =>
				this._http.get(this.API_URL + "urllink/" + user.id, { headers: headers })
			)
		);
	}

	getCategories(): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers =>
				this._http.get(this.API_URL + "categories", { headers: headers })
			)
		);
	}

	// PUT
	updateVisibility(urllink: urllink): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers =>
				this._http.put(this.API_URL + 'visibility/', urllink, { headers: headers })
			)
		);
	}

}
