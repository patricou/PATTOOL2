import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { BrowserOpenUrlResponse, IotProxyServerSettings, IotProxyTarget } from '../model/iot-proxy-target';

/** Path + query to pass to {@link IotProxyService#mintBrowserOpenUrl} for a full browser URL vs proxy upstream. */
export interface ProxyOpenPathParts {
    path?: string;
    forwardQuery?: string;
}

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

    /** Limits, timeouts and open-token policy for this backend (role Iot). */
    getServerSettings(userId?: string): Observable<IotProxyServerSettings> {
        return this.http.get<IotProxyServerSettings>(
            this.API_URL + 'iot-proxies/server-settings',
            { headers: this.headersJsonGet(userId) }
        );
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
    mintBrowserOpenUrl(publicSlug: string, path?: string, userId?: string, forwardQuery?: string): Observable<BrowserOpenUrlResponse> {
        const body: Record<string, string> = {};
        if (path !== undefined && path !== null && path.length > 0) {
            body['path'] = path;
        }
        if (forwardQuery !== undefined && forwardQuery !== null && forwardQuery.length > 0) {
            body['forwardQuery'] = this.stripIotOpenFromQueryClient(forwardQuery);
        }
        return this.http.post<BrowserOpenUrlResponse>(
            this.API_URL + 'iot-proxies/' + encodeURIComponent(publicSlug) + '/browser-open-url',
            Object.keys(body).length ? body : {},
            { headers: this.headersJsonBody(userId) }
        );
    }

    /**
     * First IoT proxy whose upstream hostname matches the link hostname only — same rule as the IoT cameras page:
     * {@code http} vs {@code https} and port are ignored (only the host / IP from the URL is compared).
     */
    findMatchingProxyForLinkUrl(linkUrl: string, proxies: IotProxyTarget[]): IotProxyTarget | undefined {
        const linkHost = this.extractUrlHostLikeCameras(linkUrl);
        if (!linkHost) {
            return undefined;
        }
        for (const p of proxies || []) {
            const ph = this.extractUrlHostLikeCameras(p.upstreamBaseUrl || '');
            if (ph && ph === linkHost) {
                return p;
            }
        }
        return undefined;
    }

    /**
     * Path under {@code upstreamBaseUrl} for the forwarder, plus query (without leading {@code ?}).
     * Host must match the upstream host (IP/hostname only); port and scheme may differ from the link URL, like camera proxy matching.
     */
    buildProxyOpenPathParts(linkUrl: string, upstreamBaseUrl: string): ProxyOpenPathParts | null {
        let link: URL;
        try {
            const t = String(linkUrl || '').trim();
            link = new URL(t.includes('://') ? t : `http://${t}`);
        } catch {
            return null;
        }
        let up: URL;
        try {
            const raw = String(upstreamBaseUrl || '').trim();
            up = new URL(raw.includes('://') ? raw : `http://${raw}`);
        } catch {
            return null;
        }
        const linkHost = this.normalizePlainHostKey(link.hostname);
        const upHost = this.normalizePlainHostKey(up.hostname);
        if (!linkHost || !upHost || linkHost !== upHost) {
            return null;
        }
        const basePath = up.pathname.replace(/\/$/, '');
        const lp = link.pathname;
        let tail: string;
        if (!basePath || basePath === '/') {
            tail = lp.startsWith('/') ? lp : `/${lp}`;
        } else {
            if (!lp.startsWith(basePath)) {
                return null;
            }
            tail = lp.slice(basePath.length);
            if (!tail.startsWith('/')) {
                tail = `/${tail}`;
            }
        }
        if (tail === '') {
            tail = '/';
        }
        const search = link.search && link.search.length > 1 ? link.search.substring(1) : '';
        const out: ProxyOpenPathParts = {};
        if (search) {
            out.forwardQuery = this.stripIotOpenFromQueryClient(search);
        }
        if (tail === '/' && !out.forwardQuery) {
            return out;
        }
        out.path = tail === '/' ? '/' : tail;
        return out;
    }

    /**
     * Host key for comparison (IoT cameras / local network): scheme and port ignored;
     * bare IP or full URL allowed.
     */
    private extractUrlHostLikeCameras(urlLike: string | undefined | null): string | null {
        if (!urlLike || !String(urlLike).trim()) {
            return null;
        }
        const t = String(urlLike).trim();
        try {
            const u = new URL(t.includes('://') ? t : `http://${t}`);
            return this.normalizePlainHostKey(u.hostname);
        } catch {
            return null;
        }
    }

    private normalizePlainHostKey(host: string | undefined | null): string | null {
        if (!host || !String(host).trim()) {
            return null;
        }
        let s = String(host).trim().toLowerCase();
        if (s.startsWith('[') && s.endsWith(']')) {
            s = s.slice(1, -1);
        }
        return s || null;
    }

    private stripIotOpenFromQueryClient(raw: string): string {
        if (!raw) {
            return '';
        }
        const parts = raw.split('&').filter((part) => {
            const key = part.indexOf('=') >= 0 ? part.substring(0, part.indexOf('=')) : part;
            return key.toLowerCase() !== 'iotopen';
        });
        return parts.join('&');
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
