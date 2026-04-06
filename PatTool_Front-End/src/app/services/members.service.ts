import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable, from, of, EMPTY } from 'rxjs';
import { map, switchMap, catchError, finalize, shareReplay, take } from 'rxjs/operators';
import { TranslateService } from '@ngx-translate/core';

import { Member } from '../model/member';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';
import { CommonvaluesService } from './commonvalues.service';
import { PositionCoordinates, PositionService } from './position.service';

/** Options for {@link MembersService.getUserId}. */
export interface GetUserIdOptions {
    /**
     * When true, POST /memb/user immediately without waiting for GPS (e.g. Links route).
     * When false, waits for browser geolocation (same API/options as address-geocode "Ma Position"),
     * up to the timeout in {@link PositionService#getGpsPosition}.
     */
    skipGeolocation?: boolean;
}

@Injectable()
export class MembersService {

    private API_URL: string = environment.API_URL;
    private user: Member = new Member("", "", "", "", "", [], "");

    /** Coalesces parallel getUserId() calls (e.g. app shell + photo wall) into a single POST /memb/user. */
    private registration$: Observable<Member> | null = null;

    constructor(
        private _http: HttpClient, 
        private _keycloakService: KeycloakService,
        private _commonValuesService: CommonvaluesService,
        private _positionService: PositionService,
        private _translate: TranslateService
    ) { }

    /** Locale actually shown in the app (TranslateService), then CommonvaluesService (browser). */
    private resolveLocaleForBackend(): string {
        const fromTranslate = (this._translate.currentLang || this._translate.getDefaultLang() || '').trim();
        if (fromTranslate.length > 0) {
            return fromTranslate;
        }
        return this._commonValuesService.getLang();
    }

    // GET  + {userName}
    setUser(member: Member) {
        this.user = member;
    };

    getUserId(options?: GetUserIdOptions): Observable<Member> {

        if (this.user.id == "") {
            this.registration$ ??= from(this._keycloakService.getToken()).pipe(
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
                    this.user.locale = this.resolveLocaleForBackend();

                    const position$ = options?.skipGeolocation
                        ? of(null)
                        : this._positionService.getCurrentPosition().pipe(catchError(() => of(null)));

                    return position$.pipe(
                        switchMap(position => this.postMembUserRegister(headers, position))
                    );
                }),
                finalize(() => {
                    this.registration$ = null;
                }),
                shareReplay({ bufferSize: 1, refCount: false })
            );
            return this.registration$;
        }
        return from([this.user]);
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
     * After fast POST /memb/user (no GPS), sends GPS when the browser provides it — does not block the UI.
     * Uses POST /memb/user/gps so we do not re-run connection email / connection log / lastConnectionDate.
     */
    pushGpsPositionWhenAvailable(): void {
        if (!this.user?.id) {
            return;
        }
        this._positionService.getCurrentPosition().pipe(
            take(1),
            switchMap((pos) => {
                if (!pos || pos.latitude == null || pos.longitude == null) {
                    return EMPTY;
                }
                return from(this._keycloakService.getToken()).pipe(
                    switchMap((token: string) =>
                        this._http.post(
                            this.API_URL + 'memb/user/gps',
                            { latitude: pos.latitude, longitude: pos.longitude },
                            {
                                headers: new HttpHeaders({
                                    Accept: 'application/json',
                                    'Content-Type': 'application/json',
                                    Authorization: 'Bearer ' + token
                                })
                            }
                        )
                    )
                );
            }),
            catchError(() => EMPTY)
        ).subscribe({ error: () => { /* silent */ } });
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
