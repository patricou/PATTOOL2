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
    private user : Member = new Member("", "", "", "", "", [], "");

    constructor(private _http: HttpClient, private _keycloakService: KeycloakService) {
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
        console.log("Upload URL:", this.API_URL4FILE);
        console.log("User info:", JSON.stringify(user));
        
        return this.getHeaderWithToken().pipe(
            switchMap(headers => {
                console.log("Request headers:", headers);
                return this._http.post(this.API_URL4FILE, formData, { headers: headers, responseType: 'json' });
            })
        );
    }

    // POST file to specific URL (for event-specific uploads)
    postFileToUrl(formData: FormData, user: Member, url: string): Observable<any> {
        this.user = user;
        console.log("Upload URL:", url);
        console.log("User info:", JSON.stringify(user));
        
        return this.getHeaderWithToken().pipe(
            switchMap(headers => {
                console.log("Request headers:", headers);
                return this._http.post(url, formData, { headers: headers, responseType: 'json' });
            })
        );
    }

    // POST file on disk    
    postFileOnDisk(formData: FormData, user: Member): Observable<any> {
        this.user = user;
        console.log("Upload URL:", this.API_URL4FILEONDISK);
        console.log("User info:", JSON.stringify(user));
        
        return this.getHeaderWithToken().pipe(
            switchMap(headers => {
                console.log("Request headers:", headers);
                return this._http.post(this.API_URL4FILEONDISK, formData, { headers: headers, responseType: 'text' });
            })
        );
    }
}
