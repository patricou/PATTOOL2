import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, from } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';

export interface TimelinePhoto {
    fileId: string;
    fileName: string;
    fileType: string;
    uploaderName: string;
    eventId: string;
    eventName: string;
    eventType: string;
    eventDate: string;
}

export interface FsPhotoLink {
    path: string;
    description: string;
}

export interface TimelineGroup {
    eventId: string;
    eventName: string;
    eventType: string;
    eventDescription?: string;
    eventDate: string;
    visibility?: string;
    friendGroupId?: string;
    friendGroupIds?: string[];
    photos: TimelinePhoto[];
    videos?: TimelinePhoto[];
    fsPhotoLinks: FsPhotoLink[];
    ownerFirstName?: string;
    ownerLastName?: string;
    ownerUserName?: string;
}

export interface TimelineResponse {
    groups: TimelineGroup[];
    totalPhotos: number;
    totalGroups: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
    onThisDay: TimelinePhoto[];
}

@Injectable()
export class PhotoTimelineService {

    private API_URL: string = environment.API_URL;

    constructor(private _http: HttpClient, private _keycloakService: KeycloakService) {}

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

    getTimeline(userId: string, page: number = 0, size: number = 12, search?: string, visibility?: string, eventId?: string): Observable<TimelineResponse> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers => {
                const h = headers.set('user-id', userId);
                let url = `${this.API_URL}photos/timeline?page=${page}&size=${size}`;
                if (search != null && search.trim() !== '') {
                    url += '&search=' + encodeURIComponent(search.trim());
                }
                if (visibility != null && visibility.trim() !== '' && visibility.trim() !== 'all') {
                    url += '&visibility=' + encodeURIComponent(visibility.trim());
                }
                if (eventId != null && eventId.trim() !== '') {
                    url += '&eventId=' + encodeURIComponent(eventId.trim());
                }
                return this._http.get<TimelineResponse>(url, { headers: h });
            })
        );
    }

    /** Video timeline (separate stream for "mur de photos"). Same structure as getTimeline but for videos only. */
    getVideoTimeline(userId: string, page: number = 0, size: number = 12, search?: string, visibility?: string, eventId?: string): Observable<TimelineResponse> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers => {
                const h = headers.set('user-id', userId);
                let url = `${this.API_URL}photos/timeline/videos?page=${page}&size=${size}`;
                if (search != null && search.trim() !== '') {
                    url += '&search=' + encodeURIComponent(search.trim());
                }
                if (visibility != null && visibility.trim() !== '' && visibility.trim() !== 'all') {
                    url += '&visibility=' + encodeURIComponent(visibility.trim());
                }
                if (eventId != null && eventId.trim() !== '') {
                    url += '&eventId=' + encodeURIComponent(eventId.trim());
                }
                return this._http.get<TimelineResponse>(url, { headers: h });
            })
        );
    }

    getOnThisDay(userId: string, visibility?: string): Observable<TimelinePhoto[]> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers => {
                const h = headers.set('user-id', userId);
                let url = `${this.API_URL}photos/timeline/onthisday`;
                if (visibility != null && visibility.trim() !== '' && visibility.trim() !== 'all') {
                    url += '?visibility=' + encodeURIComponent(visibility.trim());
                }
                return this._http.get<TimelinePhoto[]>(url, { headers: h });
            })
        );
    }
}
