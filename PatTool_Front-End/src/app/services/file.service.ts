import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';

import { Observable, from, of, throwError, firstValueFrom } from 'rxjs';
import { finalize, map, shareReplay, switchMap, tap } from 'rxjs/operators';

import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';
import { Member } from '../model/member';


export interface PatOriginalSizeMetadata {
    originalSizeBytes?: number;
    originalSizeKilobytes?: number;
    rawHeaderValue?: string;
}

export interface ImageDownloadResult {
    buffer: ArrayBuffer;
    headers: HttpHeaders;
    metadata?: PatOriginalSizeMetadata;
}

@Injectable()
export class FileService {

    private API_URL: string = environment.API_URL;
    private API_URL4FILE: string = environment.API_URL4FILE;
    private API_URL4FILEONDISK: string = environment.API_URL4FILEONDISK;
    private API_URL4UPLOADFILEONDISK: string = environment.API_URL4UPLOADFILEONDISK;
    private user: Member = new Member("", "", "", "", "", [], "");
    /** Reuse Bearer token briefly so wall thumbnail bursts do not call Keycloak per image. */
    private minimalAuthHeaders$?: Observable<HttpHeaders>;
    private minimalAuthHeadersAt = 0;
    private static readonly MINIMAL_HEADERS_TTL_MS = 20_000;
    /** GPX/KML text already read in this session. Android WebView often cannot expose the same file as an ArrayBuffer. */
    private readonly fileTextCache = new Map<string, string>();
    private readonly fileTextInflight = new Map<string, Observable<string>>();
    private static readonly FILE_TEXT_CACHE_MAX = 8;

    constructor(private _http: HttpClient, private _keycloakService: KeycloakService) {
    }

    // List images from disk for a given relative path (minimal headers to avoid 400 + CORS when token/user header is large)
    listImagesFromDisk(relativePath: string): Observable<string[]> {
        return this.getHeaderWithTokenMinimal().pipe(
            switchMap(headers =>
                this._http.get<string[]>(`${this.API_URL4FILEONDISK}/list?relativePath=${encodeURIComponent(relativePath)}`, { headers })
            )
        );
    }

    // Get an image binary from disk for given path and filename (minimal headers to avoid 400 + CORS)
    getImageFromDisk(relativePath: string, fileName: string, compress: boolean = false): Observable<ArrayBuffer> {
        return this.getHeaderWithTokenMinimal().pipe(
            switchMap(headers =>
                this._http.get(`${this.API_URL4FILEONDISK}/image?relativePath=${encodeURIComponent(relativePath)}&fileName=${encodeURIComponent(fileName)}${compress ? '&compress=true' : ''}`,
                    { headers, responseType: 'arraybuffer' })
            )
        );
    }

    getImageFromDiskWithMetadata(relativePath: string, fileName: string, compress: boolean = false): Observable<ImageDownloadResult> {
        return this.getHeaderWithTokenMinimal().pipe(
            switchMap(headers =>
                this._http.get(`${this.API_URL4FILEONDISK}/image?relativePath=${encodeURIComponent(relativePath)}&fileName=${encodeURIComponent(fileName)}${compress ? '&compress=true' : ''}`,
                    { headers, responseType: 'arraybuffer', observe: 'response' })
            ),
            map((response: HttpResponse<ArrayBuffer>) => ({
                buffer: response.body || new ArrayBuffer(0),
                headers: response.headers,
                metadata: this.extractPatMetadata(response.headers)
            }))
        );
    }

    // Get the token for Keycloak Security
    getHeaderWithToken(): Observable<HttpHeaders> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Author': 'Zeus',
                    'Authorization': 'Bearer ' + token,
                    'user': JSON.stringify(this.user)
                });
            })
        );
    }

    /** Minimal headers (Authorization only) to avoid 400 from Tomcat when header size is too large (e.g. big 'user' JSON). */
    private getHeaderWithTokenMinimal(): Observable<HttpHeaders> {
        const now = Date.now();
        if (this.minimalAuthHeaders$ && now - this.minimalAuthHeadersAt < FileService.MINIMAL_HEADERS_TTL_MS) {
            return this.minimalAuthHeaders$;
        }
        this.minimalAuthHeadersAt = now;
        this.minimalAuthHeaders$ = from(this._keycloakService.getToken()).pipe(
            map((token: string) => new HttpHeaders({ 'Authorization': 'Bearer ' + token })),
            shareReplay(1)
        );
        return this.minimalAuthHeaders$;
    }

    // GET file - returns original file (minimal headers to avoid 400 + CORS block)
    getFile(fileId: string): Observable<any> {
        return this.getHeaderWithTokenMinimal().pipe(
            switchMap(headers =>
                this._http.get(this.API_URL + "file/" + fileId, { headers: headers, responseType: 'arraybuffer' })
            )
        );
    }

    /**
     * Track files (GPX, KML, TCX, GeoJSON) as text.
     * The Android WebView often returns an empty or unusable body when the same XML file is requested as an ArrayBuffer,
     * which is why the photo wall could not open a trace. Text, then fetch, then a decoded buffer.
     */
    getFileText(fileId: string): Observable<string> {
        const id = (fileId || '').trim();
        if (!id) {
            return throwError(() => new Error('missing file id'));
        }
        const cached = this.fileTextCache.get(id);
        if (cached) {
            return of(cached);
        }
        const pending = this.fileTextInflight.get(id);
        if (pending) {
            return pending;
        }
        const req = from(this.loadFileText(id)).pipe(
            tap((text) => this.rememberFileText(id, text)),
            finalize(() => this.fileTextInflight.delete(id)),
            shareReplay({ bufferSize: 1, refCount: false })
        );
        this.fileTextInflight.set(id, req);
        return req;
    }

    /** Downscaled JPEG preview for grids (photo wall). Backend supports ?maxEdge= (longest side in px). */
    getFileWallPreview(fileId: string, maxEdge: number): Observable<ArrayBuffer> {
        const edge = Math.min(2048, Math.max(64, Math.floor(maxEdge)));
        return this.getHeaderWithTokenMinimal().pipe(
            switchMap(headers =>
                this._http.get(`${this.API_URL}file/${fileId}?maxEdge=${edge}`, {
                    headers,
                    responseType: 'arraybuffer'
                })
            )
        );
    }

    getFileWithMetadata(fileId: string): Observable<ImageDownloadResult> {
        return this.getHeaderWithTokenMinimal().pipe(
            switchMap(headers =>
                this._http.get(this.API_URL + "file/" + fileId, { headers: headers, responseType: 'arraybuffer', observe: 'response' })
            ),
            map((response: HttpResponse<ArrayBuffer>) => ({
                buffer: response.body || new ArrayBuffer(0),
                headers: response.headers,
                metadata: this.extractPatMetadata(response.headers)
            }))
        );
    }

    private extractPatMetadata(headers: HttpHeaders | null | undefined): PatOriginalSizeMetadata | undefined {
        if (!headers) {
            return undefined;
        }

        const metadata: PatOriginalSizeMetadata = {};

        // Try video-specific headers first
        const videoSizeBytes = headers.get('X-Pat-Video-Size-Bytes');
        if (videoSizeBytes) {
            const parsed = parseInt(videoSizeBytes, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                metadata.originalSizeBytes = parsed;
                metadata.originalSizeKilobytes = Math.max(1, Math.round(parsed / 1024));
            }
        }

        const videoSizeKB = headers.get('X-Pat-Video-Size-KB');
        if (videoSizeKB) {
            const parsed = parseInt(videoSizeKB, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                metadata.originalSizeKilobytes = parsed;
            }
        }

        // Fallback to image headers
        const originalSizeHeader = headers.get('X-Pat-Image-Size-Before');
        if (originalSizeHeader) {
            const parsed = parseInt(originalSizeHeader, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                metadata.originalSizeBytes = parsed;
                metadata.originalSizeKilobytes = Math.max(1, Math.round(parsed / 1024));
            }
        }

        const patHeader = headers.get('X-Pat-Exif');
        if (patHeader) {
            metadata.rawHeaderValue = patHeader;
            const bytesMatch = patHeader.match(/PatOriginalFileSizeBytes=(\d+)/i);
            if (bytesMatch) {
                const parsed = parseInt(bytesMatch[1], 10);
                if (Number.isFinite(parsed) && parsed > 0) {
                    metadata.originalSizeBytes = parsed;
                }
            }
            const kbMatch = patHeader.match(/PatOriginalFileSizeKB=(\d+)/i);
            if (kbMatch) {
                const parsed = parseInt(kbMatch[1], 10);
                if (Number.isFinite(parsed) && parsed > 0) {
                    metadata.originalSizeKilobytes = parsed;
                }
            }
        }

        if (metadata.originalSizeBytes || metadata.originalSizeKilobytes) {
            return metadata;
        }

        return undefined;
    }

    private async loadFileText(fileId: string): Promise<string> {
        const headers = await firstValueFrom(this.getHeaderWithTokenMinimal());
        const url = this.API_URL + 'file/' + fileId;
        const authorization = headers.get('Authorization') || '';
        const attempts: Array<() => Promise<string>> = [
            () => firstValueFrom(this._http.get(url, { headers, responseType: 'text' })),
            () => this.fetchFileText(url, authorization),
            async () => {
                const payload = await firstValueFrom(
                    this._http.get(url, { headers, responseType: 'arraybuffer' })
                );
                return this.decodeTrackBytes(payload);
            }
        ];
        let lastError: unknown;
        for (const attempt of attempts) {
            try {
                const text = await attempt();
                if (this.looksLikeTrackText(text)) {
                    return text.replace(/^\uFEFF/, '');
                }
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError instanceof Error ? lastError : new Error('track file unreadable');
    }

    private async fetchFileText(url: string, authorization: string): Promise<string> {
        const response = await fetch(url, {
            headers: authorization ? { Authorization: authorization } : {}
        });
        if (!response.ok) {
            throw new Error('track http ' + response.status);
        }
        return await response.text();
    }

    private looksLikeTrackText(text: string | null | undefined): text is string {
        if (!text) {
            return false;
        }
        const trimmed = text.trim();
        if (trimmed.length < 8) {
            return false;
        }
        const head = trimmed.slice(0, 240).toLowerCase();
        return !head.startsWith('<!doctype') && !head.startsWith('<html');
    }

    private rememberFileText(fileId: string, text: string): void {
        if (!this.looksLikeTrackText(text)) {
            return;
        }
        if (this.fileTextCache.has(fileId)) {
            this.fileTextCache.delete(fileId);
        }
        this.fileTextCache.set(fileId, text);
        while (this.fileTextCache.size > FileService.FILE_TEXT_CACHE_MAX) {
            const oldest = this.fileTextCache.keys().next().value as string | undefined;
            if (!oldest) {
                break;
            }
            this.fileTextCache.delete(oldest);
        }
    }

    /** Android WebView may hand back a string, a typed array, or an ArrayBuffer from another realm. */
    private decodeTrackBytes(payload: unknown): string {
        if (typeof payload === 'string') {
            return payload;
        }
        try {
            let bytes: Uint8Array | null = null;
            if (payload instanceof ArrayBuffer || Object.prototype.toString.call(payload) === '[object ArrayBuffer]') {
                bytes = new Uint8Array(payload as ArrayBuffer);
            } else if (ArrayBuffer.isView(payload)) {
                bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
            }
            if (!bytes || bytes.byteLength === 0) {
                return '';
            }
            try {
                return new TextDecoder('utf-8').decode(bytes);
            } catch {
                let out = '';
                const chunk = 0x8000;
                for (let i = 0; i < bytes.length; i += chunk) {
                    const slice = bytes.subarray(i, Math.min(bytes.length, i + chunk));
                    out += String.fromCharCode.apply(null, Array.from(slice));
                }
                return out;
            }
        } catch {
            return '';
        }
    }

    // POST file to database    
    postFile(formData: FormData, user: Member): Observable<any> {
        this.user = user;
        // console.log("Upload URL:", this.API_URL4FILE);
        // console.log("User info:", JSON.stringify(user));

        return this.getHeaderWithToken().pipe(
            switchMap(headers => {
                // console.log("Request headers:", headers);
                return this._http.post(this.API_URL4FILE, formData, { headers: headers, responseType: 'json' });
            })
        );
    }

    // POST file to specific URL (for event-specific uploads) with sessionId support
    // NOTE: sessionId should already be added to FormData by the caller to avoid duplication
    postFileToUrl(formData: FormData, user: Member, url: string, sessionId?: string): Observable<any> {
        this.user = user;

        // NOTE: Do NOT add sessionId here - it should already be in FormData from the caller
        // Adding it here causes duplication when the caller also adds it

        // Use minimal headers (Authorization only) to avoid 400/connection issues from large 'user' header
        return this.getHeaderWithTokenMinimal().pipe(
            switchMap(headers => {
                return this._http.post(url, formData, { headers: headers, responseType: 'json' });
            })
        );
    }

    // Get upload logs (polling endpoint). Send only Authorization to avoid 400 from Tomcat (large 'user' header)
    // and so error responses go through Spring and include CORS headers.
    getUploadLogs(sessionId: string): Observable<string[]> {
        return from(this._keycloakService.getToken()).pipe(
            switchMap((token: string) => {
                const headers = new HttpHeaders({ 'Authorization': 'Bearer ' + token });
                return this._http.get<string[]>(`${this.API_URL}file/upload-logs/${sessionId}`, { headers });
            })
        );
    }

    // POST file on disk - use minimal headers to avoid ERR_CONNECTION_RESET from Tomcat
    // (large 'user' header can exceed Tomcat max-http-header-size and cause connection reset)
    postFileOnDisk(formData: FormData, user: Member): Observable<any> {
        this.user = user;

        return this.getHeaderWithTokenMinimal().pipe(
            switchMap(headers =>
                this._http.post(this.API_URL4UPLOADFILEONDISK, formData, { headers, responseType: 'text' })
            )
        );
    }

    // PUT file - update evenement and delete file from GridFS (minimal headers to avoid 400 + CORS block)
    updateFile(evenement: any, user: Member): Observable<any> {
        this.user = user;
        return this.getHeaderWithTokenMinimal().pipe(
            switchMap(headers => {
                return this._http.put(this.API_URL + "file", evenement, { headers: headers, responseType: 'json' });
            })
        );
    }

    // GET video - returns video file with streaming support
    getVideo(videoId: string, range?: string): Observable<any> {
        const headers: any = {};
        if (range) {
            headers['Range'] = range;
        }
        return this.getHeaderWithToken().pipe(
            switchMap(tokenHeaders => {
                Object.assign(headers, tokenHeaders);
                return this._http.get(this.API_URL + "video/" + videoId, { 
                    headers: headers, 
                    responseType: 'arraybuffer',
                    observe: 'response'
                });
            })
        );
    }

    // GET video with metadata
    getVideoWithMetadata(videoId: string, quality: string = 'auto'): Observable<ImageDownloadResult> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers =>
                this._http.get(this.API_URL + "video/" + videoId + "?quality=" + quality, { 
                    headers: headers, 
                    responseType: 'arraybuffer', 
                    observe: 'response' 
                })
            ),
            map((response: HttpResponse<ArrayBuffer>) => ({
                buffer: response.body || new ArrayBuffer(0),
                headers: response.headers,
                metadata: this.extractPatMetadata(response.headers)
            }))
        );
    }

    // GET video metadata only
    getVideoMetadata(videoId: string): Observable<any> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers =>
                this._http.get(this.API_URL + "video/" + videoId + "/metadata", { 
                    headers: headers, 
                    responseType: 'json' 
                })
            )
        );
    }

    // Check if file is a video
    checkIfVideo(filename: string): Observable<boolean> {
        return this.getHeaderWithToken().pipe(
            switchMap(headers =>
                this._http.get<{isVideo: boolean}>(this.API_URL + "video/check/" + encodeURIComponent(filename), { 
                    headers: headers 
                })
            ),
            map(response => response.isVideo)
        );
    }
}
