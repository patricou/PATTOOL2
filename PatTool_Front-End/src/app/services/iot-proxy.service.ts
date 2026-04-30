import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { BrowserOpenUrlResponse, IotProxyTarget } from '../model/iot-proxy-target';

@Injectable({ providedIn: 'root' })
export class IotProxyService {

    private readonly API_URL = environment.API_URL;

    constructor(private http: HttpClient) {}

    /**
     * Headers only; KeycloakHttpInterceptor attaches Authorization (single getToken path, no duplicate refresh).
     */
    private headersJsonGet(userId?: string): HttpHeaders {
        let h = new HttpHeaders({ Accept: 'application/json' });
        if (userId) {
            h = h.set('user-id', userId);
        }
        return h;
    }

    private headersJsonBody(userId?: string): HttpHeaders {
        return this.headersJsonGet(userId).set('Content-Type', 'application/json');
    }

    list(userId?: string): Observable<IotProxyTarget[]> {
        return this.http.get<IotProxyTarget[]>(this.API_URL + 'iot-proxies', {
            headers: this.headersJsonGet(userId)
        });
    }

    getById(id: string, userId?: string): Observable<IotProxyTarget> {
        return this.http.get<IotProxyTarget>(
            this.API_URL + 'iot-proxies/target/' + encodeURIComponent(id),
            { headers: this.headersJsonGet(userId) }
        );
    }

    create(payload: IotProxyTarget, userId?: string): Observable<IotProxyTarget> {
        return this.http.post<IotProxyTarget>(this.API_URL + 'iot-proxies', payload, {
            headers: this.headersJsonBody(userId)
        });
    }

    update(id: string, payload: IotProxyTarget, userId?: string): Observable<IotProxyTarget> {
        return this.http.put<IotProxyTarget>(
            this.API_URL + 'iot-proxies/target/' + encodeURIComponent(id),
            payload,
            { headers: this.headersJsonBody(userId) }
        );
    }

    delete(id: string, userId?: string): Observable<void> {
        return this.http.delete<void>(
            this.API_URL + 'iot-proxies/target/' + encodeURIComponent(id),
            { headers: this.headersJsonGet(userId) }
        );
    }

    /** Short-lived signed URL for opening the LAN proxy in a new tab (no Bearer on navigation). */
    mintBrowserOpenUrl(publicSlug: string, path?: string, userId?: string): Observable<BrowserOpenUrlResponse> {
        const body: Record<string, string> = {};
        if (path !== undefined && path !== null && path.length > 0) {
            body['path'] = path;
        }
        return this.http.post<BrowserOpenUrlResponse>(
            this.API_URL + 'iot-proxies/' + encodeURIComponent(publicSlug) + '/browser-open-url',
            Object.keys(body).length ? body : {},
            { headers: this.headersJsonBody(userId) }
        );
    }

    /** Resolves {@code /api/...} against the configured backend origin when API_URL is absolute (dev); otherwise same host (prod relative). */
    resolveBackendAbsoluteUrl(relativeUrlWithQuery: string): string {
        const path = relativeUrlWithQuery.startsWith('/') ? relativeUrlWithQuery : '/' + relativeUrlWithQuery;
        const api = this.API_URL.trim();
        if (api.startsWith('http://') || api.startsWith('https://')) {
            try {
                return new URL(api).origin + path;
            } catch {
                return path;
            }
        }
        return `${window.location.protocol}//${window.location.host}${path}`;
    }
}
