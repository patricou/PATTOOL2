import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent } from '@angular/common/http';
import { KeycloakService } from './keycloak.service';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';

/**
 * This provides an HTTP interceptor that adds the Keycloak token to each request.
 */
@Injectable()
export class KeycloakHttpInterceptor implements HttpInterceptor {
    constructor(private keycloakService: KeycloakService) {}

    intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
        return from(this.keycloakService.getToken()).pipe(
            switchMap(token => {
                const authReq = req.clone({
                    headers: req.headers.set('Authorization', 'Bearer ' + token)
                });
                return next.handle(authReq);
            })
        );
    }
}