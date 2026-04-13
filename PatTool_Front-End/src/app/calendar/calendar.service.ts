import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, from, switchMap, map } from 'rxjs';
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
}

export interface CalendarReminderMailResult {
    emailsSent: number;
    skippedNoEmail: number;
}

export interface CalendarVisibilityRecipient {
    memberId: string;
    displayName: string;
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

    constructor(
        private http: HttpClient,
        private keycloak: KeycloakService,
        private membersService: MembersService
    ) { }

    private withUserHeaders(): Observable<HttpHeaders> {
        return this.membersService.getUserId({ skipGeolocation: true }).pipe(
            switchMap(member =>
                from(this.keycloak.getToken()).pipe(
                    map(token => {
                        let h = new HttpHeaders({
                            'Accept': 'application/json',
                            'Content-Type': 'application/json',
                            'user-id': member.id || ''
                        });
                        if (token) {
                            h = h.set('Authorization', 'Bearer ' + token);
                        }
                        return h;
                    })
                )
            )
        );
    }

    getEntries(rangeStart: Date, rangeEnd: Date): Observable<CalendarEntry[]> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.get<CalendarEntry[]>(`${environment.API_URL}calendar/entries`, {
                    headers,
                    params: {
                        from: rangeStart.toISOString(),
                        to: rangeEnd.toISOString()
                    }
                })
            )
        );
    }

    createAppointment(body: CalendarAppointmentPayload): Observable<unknown> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.post(`${environment.API_URL}calendar/appointments`, body, { headers })
            )
        );
    }

    updateAppointment(id: string, body: CalendarAppointmentPayload): Observable<unknown> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.put(`${environment.API_URL}calendar/appointments/${id}`, body, { headers })
            )
        );
    }

    deleteAppointment(id: string): Observable<unknown> {
        return this.withUserHeaders().pipe(
            switchMap(headers =>
                this.http.delete(`${environment.API_URL}calendar/appointments/${id}`, { headers })
            )
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
