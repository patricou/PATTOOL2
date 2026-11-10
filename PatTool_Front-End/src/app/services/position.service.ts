import { Injectable } from '@angular/core';
import { Observable, from, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';

export interface PositionCoordinates {
    latitude: number;
    longitude: number;
}

/**
 * Service to capture user position (GPS or IP-based)
 * Centralized service to be used by all components
 */
@Injectable({
    providedIn: 'root'
})
export class PositionService {

    private API_URL: string = environment.API_URL;

    constructor(private http: HttpClient) { }

    /**
     * Get current GPS position using browser Geolocation API
     * @returns Observable with coordinates or null if unavailable
     */
    getGpsPosition(): Observable<PositionCoordinates | null> {
        return new Observable(observer => {
            if (!navigator.geolocation) {
                console.warn('Geolocation is not supported by this browser');
                observer.next(null);
                observer.complete();
                return;
            }

            // Request position with timeout
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    observer.next({
                        latitude: position.coords.latitude,
                        longitude: position.coords.longitude
                    });
                    observer.complete();
                },
                (error) => {
                    // A refused permission is expected: callers fall back to the network location.
                    if (error?.code !== 1) {
                        console.warn('Error getting GPS position:', error.message);
                    }
                    observer.next(null);
                    observer.complete();
                },
                {
                    enableHighAccuracy: true,
                    timeout: 15000,
                    // Match address-geocode "Ma Position" so a recent fix is reused and POST /memb/user often gets coords quickly
                    maximumAge: 60000
                }
            );
        });
    }

    /**
     * Get position from IP using backend service (fallback when GPS is not available)
     * @returns Observable with coordinates or null if unavailable
     */
    getIpPosition(): Observable<PositionCoordinates | null> {
        return this.http.get<{ status?: string; lat?: number; lon?: number }>(
            this.API_URL + 'external/geocode/location-by-ip'
        ).pipe(
            map((res) => {
                const lat = typeof res?.lat === 'number' ? res.lat : Number(res?.lat);
                const lon = typeof res?.lon === 'number' ? res.lon : Number(res?.lon);
                if (res?.status === 'success' && Number.isFinite(lat) && Number.isFinite(lon)) {
                    return { latitude: lat, longitude: lon };
                }
                return null;
            }),
            catchError(() => of(null))
        );
    }

    /**
     * Try to get GPS position first, fallback to IP-based if GPS fails
     * @returns Observable with coordinates or null if both fail
     */
    getCurrentPosition(): Observable<PositionCoordinates | null> {
        return from(this.geolocationPermission()).pipe(
            switchMap((state) => {
                if (state === 'denied') {
                    return this.getIpPosition();
                }
                return this.getGpsPosition().pipe(
                    switchMap((gps) => gps ? of(gps) : this.getIpPosition()),
                    catchError(() => this.getIpPosition())
                );
            })
        );
    }

    /** `unknown` when the browser has no Permissions API. */
    private geolocationPermission(): Promise<'granted' | 'prompt' | 'denied' | 'unknown'> {
        const query = navigator.permissions?.query;
        if (!query) {
            return Promise.resolve('unknown');
        }
        return query.call(navigator.permissions, { name: 'geolocation' }).then(
            (status) => (status.state === 'granted' || status.state === 'prompt' || status.state === 'denied')
                ? status.state
                : 'unknown',
            () => 'unknown'
        );
    }
}
