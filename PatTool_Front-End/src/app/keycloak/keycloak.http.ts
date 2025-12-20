import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { KeycloakService } from './keycloak.service';
import { Observable, from, throwError } from 'rxjs';
import { switchMap, catchError } from 'rxjs/operators';

/**
 * This provides an HTTP interceptor that adds the Keycloak token to each request.
 * Only adds token to API requests, not to static assets or i18n files.
 */
@Injectable({
  providedIn: 'root'
})
export class KeycloakHttpInterceptor implements HttpInterceptor {
    constructor(private keycloakService: KeycloakService) {}

    intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
        // Skip adding token for static assets, i18n files, and other non-API requests
        const url = req.url.toLowerCase();
        
        // Check if this is a static asset or i18n file
        const isStaticAsset = url.includes('/assets/') || 
                             url.includes('/i18n/') ||
                             url.endsWith('.json') && (url.includes('/i18n/') || url.includes('keycloak.json'));
        
        // Check if this is an external URL that's not an API endpoint
        const isExternalNonApi = url.startsWith('http') && 
                                 !url.includes('/api/') && 
                                 !url.includes('/database/') && 
                                 !url.includes('/uploadfile') &&
                                 !url.includes('keycloak');

        if (isStaticAsset || isExternalNonApi) {
            return next.handle(req);
        }

        // For API requests, try to add the token
        // Handle case where token might not be available yet (during initialization)
        return from(this.keycloakService.getToken()).pipe(
            switchMap(token => {
                if (token) {
                    const authReq = req.clone({
                        headers: req.headers.set('Authorization', 'Bearer ' + token)
                    });
                    return next.handle(authReq).pipe(
                        catchError((error: HttpErrorResponse) => {
                            // Handle 401 Unauthorized - session expired
                            if (error.status === 401) {
                                console.log('Received 401 Unauthorized - session expired, redirecting to login');
                                this.keycloakService.redirectToLogin();
                                return throwError(() => error);
                            }
                            return throwError(() => error);
                        })
                    );
                } else {
                    // If no token available, proceed without auth header
                    // This allows the request to fail with 401 which will be caught and handled
                    return next.handle(req).pipe(
                        catchError((error: HttpErrorResponse) => {
                            // Handle 401 Unauthorized - session expired
                            if (error.status === 401) {
                                console.log('Received 401 Unauthorized - no token available, redirecting to login');
                                this.keycloakService.redirectToLogin();
                            }
                            return throwError(() => error);
                        })
                    );
                }
            }),
            catchError(error => {
                // If token retrieval fails (session expired), redirect to login
                console.log('Token retrieval failed - redirecting to login');
                this.keycloakService.redirectToLogin();
                // Return error to prevent the request from proceeding
                return throwError(() => error);
            })
        );
    }
}