import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
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
                    console.warn('Error getting GPS position:', error.message);
                    observer.next(null);
                    observer.complete();
                },
                {
                    enableHighAccuracy: true,
                    timeout: 10000, // 10 seconds timeout
                    maximumAge: 0 // Don't use cached position
                }
            );
        });
    }

    /**
     * Get position from IP using backend service (fallback when GPS is not available)
     * @returns Observable with coordinates or null if unavailable
     */
    getIpPosition(): Observable<PositionCoordinates | null> {
        // This will be handled by the backend when no GPS coordinates are provided
        // The backend will automatically get IP-based coordinates
        return of(null);
    }

    /**
     * Try to get GPS position first, fallback to IP-based if GPS fails
     * @returns Observable with coordinates or null if both fail
     */
    getCurrentPosition(): Observable<PositionCoordinates | null> {
        return this.getGpsPosition().pipe(
            catchError(() => {
                // If GPS fails, return null (backend will use IP-based)
                return of(null);
            })
        );
    }
}
