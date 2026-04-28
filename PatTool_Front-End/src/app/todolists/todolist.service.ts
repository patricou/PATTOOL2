import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable, forkJoin, from, map, switchMap } from 'rxjs';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';
import { MembersService } from '../services/members.service';

export type TodoStatus = 'open' | 'in_progress' | 'done' | 'archived';
export type TodoPriority = 'low' | 'normal' | 'high';
export type TodoVisibility = 'private' | 'public' | 'friends' | 'friendGroups' | string;

export interface TodoItem {
    id?: string;
    title: string;
    description?: string | null;
    status: TodoStatus;
    dueDate?: string | null;
    assigneeMemberId?: string | null;
    priority?: TodoPriority;
    completedAt?: string | null;
}

export interface TodoList {
    id?: string;
    ownerMemberId?: string;
    name: string;
    description?: string | null;
    imageDataUrl?: string | null;
    dueDate?: string | null;
    status?: TodoStatus;
    createdAt?: string;
    updatedAt?: string;
    visibility?: TodoVisibility;
    friendGroupId?: string | null;
    friendGroupIds?: string[] | null;
    /** MongoDB id of a personal calendar appointment, when this list is linked to the agenda. */
    calendarAppointmentId?: string | null;
    /** MongoDB id of an activity (événement), when this list is linked to it. */
    evenementId?: string | null;
    items: TodoItem[];
}

/** Body for {@code PATCH .../todolists/{id}/assignment}. */
export interface TodoListAssignmentPayload {
    calendarAppointmentId?: string | null;
    evenementId?: string | null;
}

export interface TodoVisibilityRecipient {
    memberId: string;
    displayName: string;
    userName?: string | null;
    hasEmail: boolean;
}

export interface TodoVisibilityPreviewPayload {
    visibility?: TodoVisibility;
    friendGroupId?: string | null;
    friendGroupIds?: string[] | null;
}

export interface TodoShareEmailPayload {
    /** Free-text e-mail addresses entered by the user. */
    toEmails?: string[];
    /** Member ids: the back-end resolves their addresses without leaking them client-side. */
    toMemberIds?: string[];
    customMessage?: string;
    senderName?: string;
    mailLang?: string;
    listUrl?: string;
}

export interface TodoShareEmailResponse {
    sent: number;
    skipped: number;
    total: number;
}

/**
 * Thin client over {@code /api/todolists}. Headers are produced like the calendar service: a
 * single Keycloak token + the resolved member id are attached to every call so the back-end
 * can derive the owner without trusting the body.
 */
@Injectable({ providedIn: 'root' })
export class TodoListService {

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

    listAccessible(): Observable<TodoList[]> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.get<TodoList[]>(`${environment.API_URL}todolists`, { headers })
            )
        );
    }

    getOne(id: string): Observable<TodoList> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.get<TodoList>(`${environment.API_URL}todolists/${id}`, { headers })
            )
        );
    }

    create(body: TodoList): Observable<TodoList> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.post<TodoList>(`${environment.API_URL}todolists`, body, { headers })
            )
        );
    }

    update(id: string, body: TodoList): Observable<TodoList> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.put<TodoList>(`${environment.API_URL}todolists/${id}`, body, { headers })
            )
        );
    }

    /** Owner only: attach this list to an appointment and/or clear event link, or the reverse. */
    patchAssignment(id: string, body: TodoListAssignmentPayload): Observable<TodoList> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.patch<TodoList>(`${environment.API_URL}todolists/${id}/assignment`, body, { headers })
            )
        );
    }

    delete(id: string): Observable<unknown> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.delete(`${environment.API_URL}todolists/${id}`, { headers })
            )
        );
    }

    updateItemStatus(id: string, itemId: string, status: TodoStatus): Observable<TodoList> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.patch<TodoList>(
                    `${environment.API_URL}todolists/${id}/items/${itemId}/status`,
                    null,
                    { headers, params: new HttpParams().set('status', status) }
                )
            )
        );
    }

    previewVisibilityRecipients(body: TodoVisibilityPreviewPayload): Observable<TodoVisibilityRecipient[]> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.post<TodoVisibilityRecipient[]>(
                    `${environment.API_URL}todolists/visibility-recipients-preview`,
                    body,
                    { headers }
                )
            )
        );
    }

    getVisibilityRecipients(id: string): Observable<TodoVisibilityRecipient[]> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.get<TodoVisibilityRecipient[]>(
                    `${environment.API_URL}todolists/${id}/visibility-recipients`,
                    { headers }
                )
            )
        );
    }

    /** Share a list by e-mail. Recipients are validated server-side. */
    shareByEmail(id: string, body: TodoShareEmailPayload): Observable<TodoShareEmailResponse> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.post<TodoShareEmailResponse>(
                    `${environment.API_URL}todolists/${id}/share-email`,
                    body,
                    { headers }
                )
            )
        );
    }
}
