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
    photos: TimelinePhoto[];
    videos?: TimelinePhoto[];
    fsPhotoLinks: FsPhotoLink[];
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

    getTimeline(userId: string, page: number = 0, size: number = 1): Observable<TimelineResponse> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers => {
                const h = headers.set('user-id', userId);
                return this._http.get<TimelineResponse>(
                    `${this.API_URL}photos/timeline?page=${page}&size=${size}`,
                    { headers: h }
                );
            })
        );
    }

    /** Video timeline (separate stream for "mur de photos"). Same structure as getTimeline but for videos only. */
    getVideoTimeline(userId: string, page: number = 0, size: number = 1): Observable<TimelineResponse> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers => {
                const h = headers.set('user-id', userId);
                return this._http.get<TimelineResponse>(
                    `${this.API_URL}photos/timeline/videos?page=${page}&size=${size}`,
                    { headers: h }
                );
            })
        );
    }

    getOnThisDay(userId: string): Observable<TimelinePhoto[]> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers => {
                const h = headers.set('user-id', userId);
                return this._http.get<TimelinePhoto[]>(
                    `${this.API_URL}photos/timeline/onthisday`,
                    { headers: h }
                );
            })
        );
    }
}
