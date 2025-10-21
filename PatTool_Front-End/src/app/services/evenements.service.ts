import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, from } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { Evenement } from '../model/evenement';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';


@Injectable()
export class EvenementsService {

	private API_URL: string = environment.API_URL;

	constructor(private _http: HttpClient, private _keycloakService: KeycloakService) {
	}
	// Get the header with token for Keycloak Security
	private getHeaderWithToken(): Observable<HttpHeaders> {
		return from(this._keycloakService.getToken()).pipe(
			map(token => new HttpHeaders({
				'Accept': 'application/json',
				'Content-Type': 'application/json',
				'Authorization': 'Bearer ' + token
			}))
		);
	}
	// GET + %name%
	getEvents(name: string, pageNumber: number, elementsByPage: number, userId: string): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers =>
				this._http.get(this.API_URL + "even/" + name + "/" + pageNumber + "/" + elementsByPage + "/" + userId, { headers: headers })
			)
		);
	}

	// GET  + {id}
	getEvenement(id: string): Observable<Evenement> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers => this._http.get<any>(this.API_URL + "even/" + id, { headers: headers })
				.pipe(
					map(evenement => {
						// Handle backward compatibility: convert string photosUrl to array if needed
						let photosUrlArray: string[] = [];
						if (evenement.photosUrl) {
							if (Array.isArray(evenement.photosUrl)) {
								photosUrlArray = evenement.photosUrl;
							} else if (typeof evenement.photosUrl === 'string' && evenement.photosUrl.trim() !== '') {
								// Check if it's a comma-separated string of URLs
								const urlString = evenement.photosUrl.trim();
								if (urlString.includes(',')) {
									// Split by comma and clean up each URL
									photosUrlArray = urlString.split(',').map((url: string) => url.trim()).filter((url: string) => url !== '');
								} else {
									// Single URL
									photosUrlArray = [urlString];
								}
							}
						}
						
						return new Evenement(
							evenement.author,
							evenement.closeInscriptionDate,
							evenement.comments,
							evenement.creationDate,
							evenement.endEventDate,
							evenement.beginEventDate,
							evenement.evenementName,
							evenement.id,
							evenement.map,
							photosUrlArray,
							evenement.members,
							evenement.openInscriptionDate,
							evenement.status,
							evenement.type,
							evenement.fileUploadeds,
							evenement.startHour,
							evenement.diffculty,
							evenement.startLocation,
							evenement.durationEstimation,
							evenement.ratingPlus,
							evenement.ratingMinus,
							evenement.visibility,
							evenement.urlEvents || []
						)
					})
				)
			)
		);
	}

	// POST
	postEvenement(evenement: Evenement): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers =>
				this._http.post(this.API_URL + 'even', evenement, { headers: headers })
			)
		);
	}

	// PUT
	putEvenement(evenement: Evenement): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers =>
				this._http.put(this.API_URL + 'even', evenement, { headers: headers })
			)
		);
	}

	// PUT : update for uploaded file --> when one is deleted
	put4FileEvenement(evenement: Evenement): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers =>
				this._http.put(this.API_URL + 'file', evenement, { headers: headers })
			)
		);
	}

	// DELETE
	delEvenement(id: string): Observable<any> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers =>
				this._http.delete(this.API_URL + 'even/' + id, { headers: headers })
			)
		);
	}

}
