import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { KeycloakService } from './keycloak.service';
import { Observable, from, throwError } from 'rxjs';
import { switchMap, catchError } from 'rxjs/operators';

/**
 * This provides an HTTP interceptor that adds the Keycloak token to each request.
 * Only adds token to API requests, not to static assets or i18n files.
 */
@Injectable()
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
                            // For GET event detail: do NOT redirect on 401/403 - let component show "ask owner" or error
                            const isEventDetailRequest = req.method === 'GET' && /\/api\/even\/[^/]+$/i.test(req.url);
                            if (isEventDetailRequest && (error.status === 401 || error.status === 403)) {
                                return throwError(() => error);
                            }
                            // Handle 401 Unauthorized - session expired
                            if (error.status === 401) {
                                console.warn('[KEYCLOAK INTERCEPTOR] ⚠️ Received 401 Unauthorized - session expired, redirecting to login');
                                console.warn('[KEYCLOAK INTERCEPTOR] Request URL:', error.url);
                                console.trace('[KEYCLOAK INTERCEPTOR] Stack trace:');
                                this.keycloakService.redirectToLogin();
                                return throwError(() => error);
                            }
                            return throwError(() => error);
                        })
                    );
                } else {
                    // If no token available, proceed without auth header
                    const isEventDetailRequest = req.method === 'GET' && /\/api\/even\/[^/]+$/i.test(req.url);
                    return next.handle(req).pipe(
                        catchError((error: HttpErrorResponse) => {
                            // For GET event detail: do NOT redirect - let component show "ask owner" message
                            if (isEventDetailRequest && (error.status === 401 || error.status === 403)) {
                                return throwError(() => error);
                            }
                            // Handle 401 Unauthorized - session expired
                            if (error.status === 401) {
                                console.warn('[KEYCLOAK INTERCEPTOR] ⚠️ Received 401 Unauthorized - no token available, redirecting to login');
                                console.warn('[KEYCLOAK INTERCEPTOR] Request URL:', error.url);
                                console.trace('[KEYCLOAK INTERCEPTOR] Stack trace:');
                                this.keycloakService.redirectToLogin();
                            }
                            return throwError(() => error);
                        })
                    );
                }
            }),
            catchError(error => {
                // If token retrieval fails, check if we should still proceed (no redirect)
                const isDiscussionFileRequest = req.url.includes('/api/discussions/files/');
                // GET event detail by ID: allow request without token so backend can return 403 (no access)
                // and the details-evenement component can show "ask owner for access" instead of redirecting
                const isEventDetailRequest = req.method === 'GET' && /\/api\/even\/[^/]+$/i.test(req.url);
                
                if (isDiscussionFileRequest) {
                    // For discussion file requests, proceed without token
                    console.debug('[KEYCLOAK INTERCEPTOR] Token retrieval failed for discussion file request - proceeding without token (file may not exist)');
                    return next.handle(req).pipe(
                        catchError((httpError: HttpErrorResponse) => {
                            if (httpError.status === 404) {
                                return throwError(() => httpError);
                            }
                            if (httpError.status === 401) {
                                console.debug('[KEYCLOAK INTERCEPTOR] 401 on discussion file request - not redirecting (may be missing file)');
                                return throwError(() => httpError);
                            }
                            return throwError(() => httpError);
                        })
                    );
                }
                
                if (isEventDetailRequest) {
                    console.debug('[KEYCLOAK INTERCEPTOR] Token retrieval failed for event detail request - proceeding without token (backend will return 403 if no access)');
                    return next.handle(req).pipe(
                        catchError((httpError: HttpErrorResponse) => {
                            // Do NOT redirect on 401/403 for event detail - let component show "ask owner" message
                            if (httpError.status === 401 || httpError.status === 403) {
                                return throwError(() => httpError);
                            }
                            return throwError(() => httpError);
                        })
                    );
                }
                
                // For other requests, redirect to login if token retrieval fails
                console.warn('[KEYCLOAK INTERCEPTOR] ⚠️ Token retrieval failed - redirecting to login');
                console.trace('[KEYCLOAK INTERCEPTOR] Stack trace:');
                this.keycloakService.redirectToLogin();
                return throwError(() => error);
            })
        );
    }
}