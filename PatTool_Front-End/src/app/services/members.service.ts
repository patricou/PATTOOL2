import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable, from } from 'rxjs';
import { map, switchMap, catchError } from 'rxjs/operators';

import { Member } from '../model/member';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';
import { CommonvaluesService } from './commonvalues.service';


@Injectable()
export class MembersService {

    private API_URL: string = environment.API_URL;
    private user: Member = new Member("", "", "", "", "", [], "");

    constructor(
        private _http: HttpClient, 
        private _keycloakService: KeycloakService,
        private _commonValuesService: CommonvaluesService
    ) { }

    // GET  + {userName}
    setUser(member: Member) {
        this.user = member;
    };

    getUserId(): Observable<Member> {

        if (this.user.id == "") {            
            return from(this._keycloakService.getToken()).pipe(
                map((token: string) => {
                    let now = new Date();
                    // console.log("1|------------------> GetToken : "+now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds()+'.'+now.getMilliseconds());
                    return new HttpHeaders({
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token,
                        'Author': 'Zeus himself',
                        'User': JSON.stringify(this.user)
                    });
                }),
                switchMap(headers => {
                    let now = new Date();
                    // Set the user's language preference before sending
                    this.user.locale = this._commonValuesService.getLang();
                    
                    // Convert roles array to comma-separated string for backend (backend expects String, not array)
                    const userToSend: any = { ...this.user };
                    if (userToSend.roles && Array.isArray(userToSend.roles)) {
                        userToSend.roles = userToSend.roles.join(', ');
                    } else if (!userToSend.roles || (typeof userToSend.roles !== 'string')) {
                        // If roles is not an array or string, set to empty string
                        userToSend.roles = '';
                    }
                    // Remove visible from request - backend will preserve existing value from DB
                    // This prevents the visible flag from being reset when user logs in/connects
                    delete userToSend.visible;
                    
                    // console.log("2|------------------> Just before user POST request : "+now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds()+'.'+now.getMilliseconds());
                    return this._http.post<any>(this.API_URL + 'memb/user', userToSend, { headers: headers }).pipe(
                        map((res: any) => {
                            let now = new Date();
                            // console.log("3|------------------> OK : "+now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds()+'.'+now.getMilliseconds() );
                            // Create a proper Member object with all fields including whatsappLink
                            const rolesArray = res.roles ? (typeof res.roles === 'string' ? res.roles.split(',').map((r: string) => r.trim()) : res.roles) : [];
                            const member = new Member(
                                res.id || '',
                                res.addressEmail || '',
                                res.firstName || '',
                                res.lastName || '',
                                res.userName || '',
                                rolesArray,
                                res.keycloakId || '',
                                res.registrationDate ? new Date(res.registrationDate) : undefined,
                                res.lastConnectionDate ? new Date(res.lastConnectionDate) : undefined,
                                res.locale || undefined,
                                res.whatsappLink || undefined,
                                (res.visible !== undefined && res.visible !== null) ? res.visible : true
                            );
                            // Update the internal user object
                            this.user = member;
                            return member;
                        }),
                        catchError((error: any) => {
                            console.error("¦=================> Error:", error);
                            alert("Issue to get the Id of the user : " + error);
                            throw error;
                        })
                    );
                })
            );
        } else {
            let now = new Date();
            console.log("4|------------------> user.id was alreday set : "+this.user.id+ " at "+now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds()+'.'+now.getMilliseconds() );
            return from([this.user]);
        }
    };

    getUser(): Member {
        return this.user;
    }

}
