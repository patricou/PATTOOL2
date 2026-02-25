import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { KeycloakService } from '../keycloak/keycloak.service';
import { environment } from '../../environments/environment';
import { Observable, from } from 'rxjs';
import { map, switchMap, timeout, catchError } from 'rxjs/operators';
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
			timeout(5000), // Avoid blocking if Keycloak is slow
			map((token: string) => {
				return new HttpHeaders({
					'Accept': 'application/json',
					'Content-Type': 'application/json',
					'Authorization': 'Bearer ' + token
				});
			}),
			catchError(() => {
				// Timeout or error: return empty auth so request is sent (backend may return 401 or public data)
				return from(Promise.resolve(new HttpHeaders({
					'Accept': 'application/json',
					'Content-Type': 'application/json'
				})));
			})
		);
	}

	getLinks(user: Member): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers => {
				// Add user-id header for filtering
				const headersWithUser = headers.set('user-id', user.id || '');
				return this._http.get(this.API_URL + "urllink", { headers: headersWithUser });
			})
		);
	}

	getCategories(user: Member): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers => {
				// Add user-id header for filtering
				const headersWithUser = headers.set('user-id', user.id || '');
				return this._http.get(this.API_URL + "categories", { headers: headersWithUser });
			})
		);
	}

	// PUT
	updateVisibility(urllink: urllink): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers =>
				this._http.put(this.API_URL + 'visibility', urllink, { headers: headers })
			)
		);
	}

	// ==================== CATEGORIES CRUD ====================

	createCategory(category: Category): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers =>
				this._http.post(this.API_URL + 'categories', category, { headers: headers })
			)
		);
	}

	updateCategory(id: string, category: Category): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers =>
				this._http.put(this.API_URL + 'categories/' + id, category, { headers: headers })
			)
		);
	}

	deleteCategory(id: string): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers =>
				this._http.delete(this.API_URL + 'categories/' + id, { headers: headers })
			)
		);
	}

	// ==================== URLLINKS CRUD ====================

	createUrlLink(urlLink: urllink): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers =>
				this._http.post(this.API_URL + 'urllink', urlLink, { headers: headers })
			)
		);
	}

	updateUrlLink(id: string, urlLink: urllink): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers =>
				this._http.put(this.API_URL + 'urllink/' + id, urlLink, { headers: headers })
			)
		);
	}

	deleteUrlLink(id: string): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers =>
				this._http.delete(this.API_URL + 'urllink/' + id, { headers: headers })
			)
		);
	}

}
