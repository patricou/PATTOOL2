import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable, from, race, timer, of } from 'rxjs';
import { map, switchMap, catchError, take } from 'rxjs/operators';

import { Member } from '../model/member';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';
import { CommonvaluesService } from './commonvalues.service';
import { PositionCoordinates, PositionService } from './position.service';

/** Options for {@link MembersService.getUserId}. */
export interface GetUserIdOptions {
    /**
     * When true, POST /memb/user immediately without waiting for GPS (saves ~2s on routes like Links).
     */
    skipGeolocation?: boolean;
}

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

    getUserId(options?: GetUserIdOptions): Observable<Member> {

        if (this.user.id == "") {            
            return from(this._keycloakService.getToken()).pipe(
                map((token: string) => {
                    return new HttpHeaders({
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token,
                        'Author': 'Zeus himself',
                        'User': JSON.stringify(this.user)
                    });
                }),
                switchMap(headers => {
                    this.user.locale = this._commonValuesService.getLang();

                    const positionWithTimeout = options?.skipGeolocation
                        ? of(null)
                        : race(
                            this._positionService.getCurrentPosition().pipe(catchError(() => of(null))),
                            timer(400).pipe(map(() => null))
                        ).pipe(take(1));

                    return positionWithTimeout.pipe(
                        switchMap(position => this.postMembUserRegister(headers, position))
                    );
                })
            );
        } else {
            return from([this.user]);
        }
    }

    private postMembUserRegister(headers: HttpHeaders, position: PositionCoordinates | null): Observable<Member> {
        const userToSend: any = { ...this.user };
        if (userToSend.roles && Array.isArray(userToSend.roles)) {
            userToSend.roles = userToSend.roles.join(', ');
        } else if (!userToSend.roles || (typeof userToSend.roles !== 'string')) {
            userToSend.roles = '';
        }
        delete userToSend.visible;

        if (position && position.latitude != null && position.longitude != null) {
            userToSend.requestLatitude = position.latitude;
            userToSend.requestLongitude = position.longitude;
        }

        return this._http.post<any>(this.API_URL + 'memb/user', userToSend, { headers: headers }).pipe(
            map((res: any) => {
                const rolesArray = res.roles ? (typeof res.roles === 'string' ? res.roles.split(',').map((r: string) => r.trim()) : res.roles) : [];

                let positions = undefined;
                if (res.positions && Array.isArray(res.positions)) {
                    positions = res.positions.map((p: any) => ({
                        datetime: p.datetime ? new Date(p.datetime) : undefined,
                        dateFrom: p.dateFrom ? new Date(p.dateFrom) : undefined,
                        dateTo: p.dateTo ? new Date(p.dateTo) : undefined,
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
                this.user = member;
                return member;
            }),
            catchError((error: any) => {
                console.error("¦=================> Error:", error);
                alert("Issue to get the Id of the user : " + error);
                throw error;
            })
        );
    }

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
