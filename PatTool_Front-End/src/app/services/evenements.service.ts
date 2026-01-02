import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, from, Subject } from 'rxjs';
import { map, switchMap, catchError } from 'rxjs/operators';
import { Evenement } from '../model/evenement';
import { Commentary } from '../model/commentary';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';

export interface StreamedEvent {
	type: 'total' | 'event' | 'complete';
	data: any;
}

export interface StreamedFile {
	type: 'total' | 'file' | 'complete' | 'error';
	data: any;
}


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
	// GET  + {id}
	getEvenement(id: string): Observable<Evenement> {
		return this.getHeaderWithToken().pipe(
			switchMap(headers => this._http.get<any>(this.API_URL + "even/" + id, { headers: headers })
				.pipe(
					map(evenement => {
						return 							new Evenement(
								evenement.author,
								evenement.closeInscriptionDate,
								evenement.comments,
								evenement.creationDate,
								evenement.endEventDate,
								evenement.beginEventDate,
								evenement.evenementName,
								evenement.id,
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
							evenement.urlEvents || [],
							evenement.commentaries || [],
							evenement.thumbnail,
							evenement.friendGroupId,
							evenement.friendGroupIds,
							evenement.discussionId
						)
					})
				)
			)
		);
	}

	// GET /{id}/files - Load all files for an event (on-demand)
	getEventFiles(id: string): Observable<any[]> {
		const url = this.API_URL + "even/" + id + "/files";
		
		return this.getHeaderWithToken().pipe(
			switchMap(headers => {
				return this._http.get<any[]>(url, { headers: headers }).pipe(
					map(files => {
						return files || [];
					}),
					catchError(error => {
						console.error('Error loading event files:', error);
						throw error; // Re-throw to be handled by subscribe error handler
					})
				);
			}),
			catchError(error => {
				console.error('Error in getEventFiles:', error);
				throw error;
			})
		);
	}

	// Stream files using Server-Sent Events (SSE)
	streamEventFiles(id: string): Observable<StreamedFile> {
		const subject = new Subject<StreamedFile>();
		
		this.getHeaderWithToken().subscribe({
			next: (headers) => {
				const token = headers.get('Authorization') || '';
				const url = this.API_URL + "even/" + id + "/files/stream";
				
				// Use fetch API since EventSource doesn't support custom headers
				this.streamFilesWithFetch(url, token, subject).catch(err => {
					subject.error(err);
				});
			},
			error: (err) => {
				subject.error(err);
			}
		});
		
		return subject.asObservable();
	}

	private async streamFilesWithFetch(
		url: string, 
		authToken: string, 
		subject: Subject<StreamedFile>
	): Promise<void> {
		try {
			const response = await fetch(url, {
				headers: {
					'Authorization': authToken,
					'Accept': 'text/event-stream'
				},
				cache: 'no-cache'
			});

			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`);
			}

			const reader = response.body?.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			if (!reader) {
				subject.error(new Error('No reader available'));
				return;
			}

			let currentEventType: string | null = null;
			let currentData: string = '';

			while (true) {
				const { done, value } = await reader.read();
				
				if (done) {
					// Process any remaining data
					if (currentEventType && currentData) {
						this.processSSEFileEvent(currentEventType, currentData, subject);
					}
					subject.complete();
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || ''; // Keep incomplete line in buffer

				for (const line of lines) {
					if (line.trim() === '') {
						// Empty line indicates end of event - process it
						if (currentEventType && currentData) {
							this.processSSEFileEvent(currentEventType, currentData, subject);
							currentEventType = null;
							currentData = '';
						}
						continue;
					}
					
					if (line.startsWith('event:')) {
						// Process previous event if exists
						if (currentEventType && currentData) {
							this.processSSEFileEvent(currentEventType, currentData, subject);
						}
						currentEventType = line.substring(6).trim();
						currentData = '';
						continue;
					}
					
					if (line.startsWith('data:')) {
						const data = line.substring(5).trim();
						if (currentData) {
							currentData += '\n' + data; // Handle multi-line data
						} else {
							currentData = data;
						}
					}
				}
			}
		} catch (error) {
			subject.error(error);
		}
	}

	private processSSEFileEvent(eventType: string, data: string, subject: Subject<StreamedFile>): void {
		if (eventType === 'total') {
			subject.next({
				type: 'total',
				data: Number(data)
			});
		} else if (eventType === 'file') {
			// Try to parse as JSON
			try {
				const parsed = JSON.parse(data);
				subject.next({
					type: 'file',
					data: parsed
				});
			} catch (e) {
				// If not JSON, send as string
				subject.next({
					type: 'file',
					data: data
				});
			}
		} else if (eventType === 'complete') {
			subject.next({
				type: 'complete',
				data: null
			});
		} else if (eventType === 'error') {
			subject.next({
				type: 'error',
				data: data
			});
		}
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

	// Stream events using Server-Sent Events (SSE)
	streamEvents(name: string, userId: string, visibilityFilter?: string): Observable<StreamedEvent> {
		const subject = new Subject<StreamedEvent>();
		
		this.getHeaderWithToken().subscribe({
			next: (headers) => {
				const token = headers.get('Authorization') || '';
				const url = this.API_URL + "even/stream/" + encodeURIComponent(name);
				
				// Use fetch API since EventSource doesn't support custom headers
				this.streamWithFetch(url, token, userId, subject, visibilityFilter).catch(err => {
					subject.error(err);
				});
			},
			error: (err) => {
				subject.error(err);
			}
		});
		
		return subject.asObservable();
	}

	private async streamWithFetch(
		url: string, 
		authToken: string, 
		userId: string,
		subject: Subject<StreamedEvent>,
		visibilityFilter?: string
	): Promise<void> {
		try {
			const headers: { [key: string]: string } = {
				'Authorization': authToken,
				'user-id': userId || '',
				'Accept': 'text/event-stream'
			};
			
			// Add visibility filter header if provided
			if (visibilityFilter && visibilityFilter.trim() !== '' && visibilityFilter !== 'all') {
				headers['visibility-filter'] = visibilityFilter.trim();
			}
			
			const response = await fetch(url, {
				headers: headers,
				cache: 'no-cache'
			});

			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`);
			}

			const reader = response.body?.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			if (!reader) {
				subject.error(new Error('No reader available'));
				return;
			}

			let currentEventType: string | null = null;
			let currentData: string = '';

			while (true) {
				const { done, value } = await reader.read();
				
				if (done) {
					// Process any remaining data
					if (currentEventType && currentData) {
						this.processSSEEvent(currentEventType, currentData, subject);
					}
					subject.complete();
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || ''; // Keep incomplete line in buffer

				for (const line of lines) {
					if (line.trim() === '') {
						// Empty line indicates end of event - process it
						if (currentEventType && currentData) {
							this.processSSEEvent(currentEventType, currentData, subject);
							currentEventType = null;
							currentData = '';
						}
						continue;
					}
					
					if (line.startsWith('event:')) {
						// Process previous event if exists
						if (currentEventType && currentData) {
							this.processSSEEvent(currentEventType, currentData, subject);
						}
						currentEventType = line.substring(6).trim();
						currentData = '';
						continue;
					}
					
					if (line.startsWith('data:')) {
						const data = line.substring(5).trim();
						if (currentData) {
							currentData += '\n' + data; // Handle multi-line data
						} else {
							currentData = data;
						}
					}
				}
			}
		} catch (error) {
			subject.error(error);
		}
	}

	private processSSEEvent(eventType: string, data: string, subject: Subject<StreamedEvent>): void {
		if (eventType === 'total') {
			subject.next({
				type: 'total',
				data: Number(data)
			});
		} else if (eventType === 'event') {
			// Try to parse as JSON and convert to Evenement
			try {
				const parsed = JSON.parse(data);
				// Convert to Evenement object
				const evenement = new Evenement(
					parsed.author,
					parsed.closeInscriptionDate ? new Date(parsed.closeInscriptionDate) : new Date(),
					parsed.comments || '',
					parsed.creationDate ? new Date(parsed.creationDate) : new Date(),
					parsed.endEventDate ? new Date(parsed.endEventDate) : new Date(),
					parsed.beginEventDate ? new Date(parsed.beginEventDate) : new Date(),
					parsed.evenementName || '',
					parsed.id || '',
					parsed.members || [],
					parsed.openInscriptionDate ? new Date(parsed.openInscriptionDate) : new Date(),
					parsed.status || '',
					parsed.type || '',
					parsed.fileUploadeds || [],
					parsed.startHour || '',
					parsed.diffculty || '',
					parsed.startLocation || '',
					parsed.durationEstimation || '',
					parsed.ratingPlus || 0,
					parsed.ratingMinus || 0,
					parsed.visibility || '',
					parsed.urlEvents || [],
					parsed.commentaries || [],
					parsed.thumbnail,
					parsed.friendGroupId,
					parsed.friendGroupIds,
					parsed.discussionId
				);
				subject.next({
					type: 'event',
					data: evenement
				});
			} catch (e) {
				// If not JSON, send as string
				subject.next({
					type: 'event',
					data: data
				});
			}
		} else if (eventType === 'complete') {
			subject.next({
				type: 'complete',
				data: null
			});
		}
	}

	// Add commentary to an event
	addCommentary(eventId: string, commentary: Commentary): Observable<Evenement> {
		const url = this.API_URL + "even/" + eventId + "/commentaries";
		return this.getHeaderWithToken().pipe(
			switchMap(headers => this._http.post<Evenement>(url, commentary, { headers: headers }))
		);
	}

	// Update a commentary in an event
	updateCommentary(eventId: string, commentId: string, commentary: Commentary): Observable<Evenement> {
		const url = this.API_URL + "even/" + eventId + "/commentaries/" + commentId;
		return this.getHeaderWithToken().pipe(
			switchMap(headers => this._http.put<Evenement>(url, commentary, { headers: headers }))
		);
	}

	// Delete a commentary from an event
	deleteCommentary(eventId: string, commentId: string): Observable<Evenement> {
		const url = this.API_URL + "even/" + eventId + "/commentaries/" + commentId;
		return this.getHeaderWithToken().pipe(
			switchMap(headers => this._http.delete<Evenement>(url, { headers: headers }))
		);
	}

}
