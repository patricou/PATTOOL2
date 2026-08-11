import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, forkJoin, from, map, switchMap } from 'rxjs';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';
import { MembersService } from '../services/members.service';

export type NoteVisibility = 'private' | 'public' | 'friends' | 'friendGroups' | string;

export interface Note {
    id?: string;
    ownerMemberId?: string;
    ownerDisplayName?: string | null;
    title?: string | null;
    content?: string | null;
    color?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    gpsAccuracy?: number | null;
    createdAt?: string;
    updatedAt?: string;
    visibility?: NoteVisibility;
    friendGroupId?: string | null;
    friendGroupIds?: string[] | null;
    /** Compressed photo data URLs (`data:image/...;base64,...`). */
    imageDataUrls?: string[] | null;
    /** Personal agenda appointment id (mutually exclusive with evenementId). */
    calendarAppointmentId?: string | null;
    /** Activity (evenement) id (mutually exclusive with calendarAppointmentId). */
    evenementId?: string | null;
}

export interface NotePayload {
    title?: string | null;
    content?: string | null;
    color?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    gpsAccuracy?: number | null;
    ownerDisplayName?: string | null;
    visibility?: NoteVisibility;
    friendGroupId?: string | null;
    friendGroupIds?: string[] | null;
    imageDataUrls?: string[] | null;
    calendarAppointmentId?: string | null;
    evenementId?: string | null;
}

export interface NoteVisibilityRecipient {
    memberId: string;
    displayName: string;
    userName?: string | null;
    hasEmail: boolean;
}

export interface NoteVisibilityPreviewPayload {
    visibility?: NoteVisibility;
    friendGroupId?: string | null;
    friendGroupIds?: string[] | null;
}

/**
 * Thin client over {@code /api/notes}. Headers match the to-do list service: Keycloak token
 * + member id so the back-end derives the owner without trusting the body.
 */
@Injectable({ providedIn: 'root' })
export class NoteService {

    constructor(
        private http: HttpClient,
        private keycloak: KeycloakService,
        private membersService: MembersService
    ) { }

    private withUserHeaders(): Observable<HttpHeaders> {
        return forkJoin({
            member: this.membersService.getUserId({ skipGeolocation: true }),
            token: from(this.keycloak.getToken())
        }).pipe(
            map(({ member, token }) => {
                let h = new HttpHeaders({
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'user-id': member.id || ''
                });
                if (token) {
                    h = h.set('Authorization', 'Bearer ' + token);
                }
                return h;
            })
        );
    }

    listAccessible(): Observable<Note[]> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.get<Note[]>(`${environment.API_URL}notes`, { headers })
            )
        );
    }

    getOne(id: string): Observable<Note> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.get<Note>(`${environment.API_URL}notes/${id}`, { headers })
            )
        );
    }

    create(body: NotePayload): Observable<Note> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.post<Note>(`${environment.API_URL}notes`, body, { headers })
            )
        );
    }

    update(id: string, body: NotePayload): Observable<Note> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.put<Note>(`${environment.API_URL}notes/${id}`, body, { headers })
            )
        );
    }

    delete(id: string): Observable<void> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.delete<void>(`${environment.API_URL}notes/${id}`, { headers })
            )
        );
    }

    previewVisibilityRecipients(body: NoteVisibilityPreviewPayload): Observable<NoteVisibilityRecipient[]> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.post<NoteVisibilityRecipient[]>(
                    `${environment.API_URL}notes/visibility-recipients-preview`,
                    body,
                    { headers }
                )
            )
        );
    }
}
