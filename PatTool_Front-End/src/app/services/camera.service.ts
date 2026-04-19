import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, from } from 'rxjs';
import { map, switchMap, timeout, catchError } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';
import { Camera } from '../model/camera';

@Injectable({ providedIn: 'root' })
export class CameraService {

    private API_URL: string = environment.API_URL;

    constructor(private _http: HttpClient, private _keycloakService: KeycloakService) {}

    private getHeaderWithToken(userId?: string): Observable<HttpHeaders> {
        return from(this._keycloakService.getToken()).pipe(
            timeout(5000),
            map((token: string) => {
                let headers = new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
                if (userId) {
                    headers = headers.set('user-id', userId);
                }
                return headers;
            }),
            catchError(() => {
                let headers = new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                });
                if (userId) {
                    headers = headers.set('user-id', userId);
                }
                return from(Promise.resolve(headers));
            })
        );
    }

    getCameras(userId?: string): Observable<Camera[]> {
        return this.getHeaderWithToken(userId).pipe(
            switchMap(headers => this._http.get<Camera[]>(this.API_URL + 'cameras', { headers }))
        );
    }

    getCameraById(id: string): Observable<Camera> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers => this._http.get<Camera>(this.API_URL + 'cameras/' + id, { headers }))
        );
    }

    getCameraByUid(uid: string): Observable<Camera> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers => this._http.get<Camera>(this.API_URL + 'cameras/uid/' + encodeURIComponent(uid), { headers }))
        );
    }

    createCamera(camera: Camera, userId?: string): Observable<Camera> {
        return this.getHeaderWithToken(userId).pipe(
            switchMap(headers => this._http.post<Camera>(this.API_URL + 'cameras', camera, { headers }))
        );
    }

    updateCamera(id: string, camera: Camera): Observable<Camera> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers => this._http.put<Camera>(this.API_URL + 'cameras/' + id, camera, { headers }))
        );
    }

    deleteCamera(id: string): Observable<any> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers => this._http.delete(this.API_URL + 'cameras/' + id, { headers }))
        );
    }

    /**
     * Asks the backend to clone an existing camera. The password (never
     * exposed to the frontend) is preserved server-side.
     * @param id source camera id
     * @param suffix optional suffix appended to the new camera name (default " (copy)")
     */
    duplicateCamera(id: string, suffix?: string): Observable<Camera> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers => {
                const params: any = {};
                if (suffix !== undefined) {
                    params.suffix = suffix;
                }
                return this._http.post<Camera>(
                    this.API_URL + 'cameras/' + id + '/duplicate',
                    null,
                    { headers, params }
                );
            })
        );
    }

    /**
     * Fetches a fresh snapshot for the given camera via the backend proxy.
     * The response is a binary blob (JPEG most of the time) that the caller
     * wraps in a {@code URL.createObjectURL(...)} to feed an {@code <img>} tag.
     * The {@code Authorization: Bearer} header is attached by this call, so
     * the {@code <img>} element never has to handle the JWT itself.
     */
    getSnapshot(id: string): Observable<Blob> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers => this._http.get(this.API_URL + 'cameras/' + id + '/snapshot', {
                headers,
                responseType: 'blob'
            }))
        );
    }
}
