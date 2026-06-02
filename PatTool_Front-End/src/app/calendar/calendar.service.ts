import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, from, forkJoin, of } from 'rxjs';
import { map, switchMap, tap, take } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';
import { MembersService } from '../services/members.service';

export interface CalendarEntry {
    kind: 'APPOINTMENT' | 'ACTIVITY';
    id: string;
    title: string;
    start: string;
    end: string;
    thumbnailFileId?: string | null;
    notes?: string | null;
    ownerMemberId?: string | null;
    visibility?: string | null;
    friendGroupId?: string | null;
    friendGroupIds?: string[] | null;
    /** Linked to-do list id when the back-end attached one to this row. */
    todoListId?: string | null;
}

export interface CalendarReminderMailResult {
    emailsSent: number;
    skippedNoEmail: number;
}

export interface CalendarVisibilityRecipient {
    memberId: string;
    displayName: string;
    userName?: string | null;
    hasEmail: boolean;
}

export interface CalendarVisibilityPreviewPayload {
    visibility?: string;
    friendGroupId?: string | null;
    friendGroupIds?: string[] | null;
}

export interface CalendarAppointmentPayload {
    title: string;
    notes?: string | null;
    startDate: string;
    endDate: string;
    visibility?: string;
    friendGroupId?: string | null;
    friendGroupIds?: string[] | null;
}

@Injectable({ providedIn: 'root' })
export class CalendarService {

    /** Réduit les appels forkJoin + token lors des changements de vue FullCalendar successifs (~TTL alignée au cache graphe serveur). */
    private static readonly HEADERS_CACHE_MS = 25_000;
    private static readonly ENTRIES_CACHE_MS = 45_000;

    private cachedHeaders: HttpHeaders | null = null;
    private headersCacheExpiryMs = 0;
    private entriesCacheKey = '';
    private entriesCache: CalendarEntry[] | null = null;
    private entriesCacheExpiryMs = 0;

    constructor(
        private http: HttpClient,
        private keycloak: KeycloakService,
        private membersService: MembersService
    ) { }

    private withUserHeaders(): Observable<HttpHeaders> {
        const now = Date.now();
        if (this.cachedHeaders && now < this.headersCacheExpiryMs) {
            return of(this.cachedHeaders);
        }
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
            }),
            tap(h => {
                this.cachedHeaders = h;
                this.headersCacheExpiryMs = Date.now() + CalendarService.HEADERS_CACHE_MS;
            }),
            take(1)
        );
    }

    /** Warms member id + JWT cache before the first FullCalendar range fetch. */
    prewarmAuthHeaders(): void {
        this.withUserHeaders().pipe(take(1)).subscribe({ error: () => undefined });
    }

    getEntries(rangeStart: Date, rangeEnd: Date): Observable<CalendarEntry[]> {
        const key = `${rangeStart.getTime()}|${rangeEnd.getTime()}`;
        const now = Date.now();
        if (this.entriesCacheKey === key && this.entriesCache && now < this.entriesCacheExpiryMs) {
            return of(this.entriesCache);
        }
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.get<CalendarEntry[]>(`${environment.API_URL}calendar/entries`, {
                    headers,
                    params: {
                        from: rangeStart.toISOString(),
                        to: rangeEnd.toISOString()
                    }
                })
            ),
            tap(entries => {
                this.entriesCacheKey = key;
                this.entriesCache = entries;
                this.entriesCacheExpiryMs = Date.now() + CalendarService.ENTRIES_CACHE_MS;
            })
        );
    }

    invalidateEntriesCache(): void {
        this.entriesCacheKey = '';
        this.entriesCache = null;
        this.entriesCacheExpiryMs = 0;
    }

    createAppointment(body: CalendarAppointmentPayload): Observable<{ id: string }> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.post<{ id: string }>(`${environment.API_URL}calendar/appointments`, body, { headers })
            ),
            tap(() => this.invalidateEntriesCache())
        );
    }

    updateAppointment(id: string, body: CalendarAppointmentPayload): Observable<{ id: string }> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.put<{ id: string }>(`${environment.API_URL}calendar/appointments/${id}`, body, { headers })
            ),
            tap(() => this.invalidateEntriesCache())
        );
    }

    deleteAppointment(id: string): Observable<unknown> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.delete(`${environment.API_URL}calendar/appointments/${id}`, { headers })
            ),
            tap(() => this.invalidateEntriesCache())
        );
    }

    sendAppointmentReminderMail(id: string): Observable<CalendarReminderMailResult> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.post<CalendarReminderMailResult>(
                    `${environment.API_URL}calendar/appointments/${id}/reminder-mail`,
                    {},
                    { headers }
                )
            )
        );
    }

    getVisibilityRecipients(appointmentId: string): Observable<CalendarVisibilityRecipient[]> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.get<CalendarVisibilityRecipient[]>(
                    `${environment.API_URL}calendar/appointments/${appointmentId}/visibility-recipients`,
                    { headers }
                )
            )
        );
    }

    previewVisibilityRecipients(body: CalendarVisibilityPreviewPayload): Observable<CalendarVisibilityRecipient[]> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.post<CalendarVisibilityRecipient[]>(
                    `${environment.API_URL}calendar/appointments/visibility-recipients-preview`,
                    body,
                    { headers }
                )
            )
        );
    }
}
