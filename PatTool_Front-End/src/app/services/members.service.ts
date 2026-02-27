import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable, from, race, timer, of } from 'rxjs';
import { map, switchMap, catchError, take } from 'rxjs/operators';

import { Member } from '../model/member';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';
import { CommonvaluesService } from './commonvalues.service';
import { PositionService } from './position.service';


@Injectable()
export class MembersService {

    private API_URL: string = environment.API_URL;
    private user: Member = new Member("", "", "", "", "", [], "");

    constructor(
        private _http: HttpClient, 
        private _keycloakService: KeycloakService,
        private _commonValuesService: CommonvaluesService,
        private _positionService: PositionService
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
                    
                    // Don't block on geolocation: user may take time to Allow/Block, and home-evenements
                    // needs user.id quickly to load non-public events. Wait max 2s for position, then POST.
                    const positionWithTimeout = race(
                        this._positionService.getCurrentPosition().pipe(catchError(() => of(null))),
                        timer(2000).pipe(map(() => null))
                    ).pipe(take(1));
                    
                    return positionWithTimeout.pipe(
                        switchMap(position => {
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
                            
                            // Add GPS coordinates if available (within the 2s window)
                            if (position && position.latitude != null && position.longitude != null) {
                                userToSend.requestLatitude = position.latitude;
                                userToSend.requestLongitude = position.longitude;
                            }
                            
                            return this._http.post<any>(this.API_URL + 'memb/user', userToSend, { headers: headers }).pipe(
                        map((res: any) => {
                            let now = new Date();
                            // console.log("3|------------------> OK : "+now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds()+'.'+now.getMilliseconds() );
                            // Create a proper Member object with all fields including whatsappLink and positions
                            const rolesArray = res.roles ? (typeof res.roles === 'string' ? res.roles.split(',').map((r: string) => r.trim()) : res.roles) : [];
                            
                            // Parse positions array if present
                            let positions = undefined;
                            if (res.positions && Array.isArray(res.positions)) {
                                positions = res.positions.map((p: any) => ({
                                    datetime: p.datetime ? new Date(p.datetime) : undefined,
                                    type: p.type,
                                    latitude: p.latitude,
                                    longitude: p.longitude
                                }));
                            }
                            
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
                                (res.visible !== undefined && res.visible !== null) ? res.visible : true,
                                positions
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

    /**
     * Get list of all members (PatTool users). Requires authentication.
     */
    getListMembers(): Observable<Member[]> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => new HttpHeaders({
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            })),
            switchMap(headers => this._http.get<any[]>(this.API_URL + 'memb', { headers: headers }).pipe(
                map((raw: any[]) => (raw || []).map((m: any) => {
                    const rolesArray = m.roles ? (typeof m.roles === 'string' ? m.roles.split(',').map((r: string) => r.trim()).filter((r: string) => r.length) : m.roles) : [];
                    return new Member(
                        m.id || '',
                        m.addressEmail || '',
                        m.firstName || '',
                        m.lastName || '',
                        m.userName || '',
                        rolesArray,
                        m.keycloakId || '',
                        m.registrationDate ? new Date(m.registrationDate) : undefined,
                        m.lastConnectionDate ? new Date(m.lastConnectionDate) : undefined,
                        m.locale || undefined,
                        m.whatsappLink || undefined,
                        m.visible !== undefined ? m.visible : true
                    );
                }))
            ))
        );
    }

}
