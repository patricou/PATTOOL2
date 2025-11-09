import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';

import { Observable, from } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';

import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';
import { Member } from '../model/member';


@Injectable()
export class FileService {

    private API_URL: string = environment.API_URL;
    private API_URL4FILE: string = environment.API_URL4FILE;
    private API_URL4FILEONDISK: string = environment.API_URL4FILEONDISK;
    private API_URL4UPLOADFILEONDISK: string = environment.API_URL4UPLOADFILEONDISK;
    private user: Member = new Member("", "", "", "", "", [], "");

    constructor(private _http: HttpClient, private _keycloakService: KeycloakService) {
    }

    // List images from disk for a given relative path
    listImagesFromDisk(relativePath: string): Observable<string[]> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers =>
                this._http.get<string[]>(`${this.API_URL4FILEONDISK}/list?relativePath=${encodeURIComponent(relativePath)}`, { headers })
            )
        );
    }

    // Get an image binary from disk for given path and filename
    getImageFromDisk(relativePath: string, fileName: string, compress: boolean = false): Observable<ArrayBuffer> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers =>
                this._http.get(`${this.API_URL4FILEONDISK}/image?relativePath=${encodeURIComponent(relativePath)}&fileName=${encodeURIComponent(fileName)}${compress ? '&compress=true' : ''}`,
                    { headers, responseType: 'arraybuffer' })
            )
        );
    }

    // Get the token for Keycloak Security
    getHeaderWithToken(): Observable<HttpHeaders> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Author': 'Zeus',
                    'Authorization': 'Bearer ' + token,
                    'user': JSON.stringify(this.user)
                });
            })
        );
    }
    // GET file - returns original file
    getFile(fileId: string): Observable<any> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers =>
                this._http.get(this.API_URL + "file/" + fileId, { headers: headers, responseType: 'arraybuffer' })
            )
        );
    }

    // POST file to database    
    postFile(formData: FormData, user: Member): Observable<any> {
        this.user = user;
        // console.log("Upload URL:", this.API_URL4FILE);
        // console.log("User info:", JSON.stringify(user));

        return this.getHeaderWithToken().pipe(
            switchMap(headers => {
                // console.log("Request headers:", headers);
                return this._http.post(this.API_URL4FILE, formData, { headers: headers, responseType: 'json' });
            })
        );
    }

    // POST file to specific URL (for event-specific uploads) with sessionId support
    // NOTE: sessionId should already be added to FormData by the caller to avoid duplication
    postFileToUrl(formData: FormData, user: Member, url: string, sessionId?: string): Observable<any> {
        this.user = user;

        // NOTE: Do NOT add sessionId here - it should already be in FormData from the caller
        // Adding it here causes duplication when the caller also adds it

        // console.log("Upload URL:", url);
        // console.log("User info:", JSON.stringify(user));
        if (sessionId) {
            // console.log("Session ID:", sessionId);
        }

        return this.getHeaderWithToken().pipe(
            switchMap(headers => {
                // console.log("Request headers:", headers);
                return this._http.post(url, formData, { headers: headers, responseType: 'json' });
            })
        );
    }

    // Get upload logs (polling endpoint)
    getUploadLogs(sessionId: string): Observable<string[]> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers => {
                return this._http.get<string[]>(`${this.API_URL}file/upload-logs/${sessionId}`, { headers });
            })
        );
    }

    // POST file on disk    
    postFileOnDisk(formData: FormData, user: Member): Observable<any> {
        this.user = user;
        // console.log("Upload URL:", this.API_URL4FILEONDISK);
        // console.log("User info:", JSON.stringify(user));

        return this.getHeaderWithToken().pipe(
            switchMap(headers => {
                // console.log("Request headers:", headers);
                return this._http.post(this.API_URL4UPLOADFILEONDISK, formData, { headers: headers, responseType: 'text' });
            })
        );
    }
}
