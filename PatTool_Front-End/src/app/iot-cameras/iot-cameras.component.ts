import {
    Component, OnInit, OnDestroy, ChangeDetectorRef, NgZone,
    ElementRef, ViewChild, HostListener
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { Camera } from '../model/camera';
import { Member } from '../model/member';
import { CameraService } from '../services/camera.service';
import { IotProxyService } from '../services/iot-proxy.service';
import { IotProxyTarget } from '../model/iot-proxy-target';
import { MembersService } from '../services/members.service';
import { Router } from '@angular/router';

type CameraViewMode = 'grid' | 'list';

/**
 * Per-camera live preview state.
 *
 * Snapshot polling workflow:
 *   1. When `live` is true we schedule a periodic fetch of GET /api/cameras/{id}/snapshot
 *      (authenticated with the Bearer token of the current user).
 *   2. Each response arrives as a Blob that we wrap in a short-lived object URL
 *      and feed to an <img> element. The previous object URL is revoked to avoid leaks.
 *   3. Too many consecutive errors pause the polling automatically.
 */
interface LiveState {
    live: boolean;
    blobUrl: string | null;
    intervalId: ReturnType<typeof setInterval> | null;
    inFlight: Subscription | null;
    errorCount: number;
    lastErrorMessage?: string;
}

/**
 * One draggable / resizable tile inside the mosaic modal. Positions are
 * persisted to localStorage ({@link IotCamerasComponent.MOSAIC_LAYOUT_KEY})
 * keyed by {@link cameraId} so users recover their preferred arrangement on
 * next visit. Coordinates are expressed in pixels relative to the mosaic
 * canvas element.
 */
interface MosaicTile {
    cameraId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
}

@Component({
    selector: 'app-iot-cameras',
    templateUrl: './iot-cameras.component.html',
    styleUrls: ['./iot-cameras.component.css'],
    standalone: true,
    imports: [CommonModule, FormsModule, TranslateModule, NavigationButtonsModule]
})
export class IotCamerasComponent implements OnInit, OnDestroy {

    user: Member = this._membersService.getUser();

    cameras: Camera[] = [];
    /** IoT LAN proxy rows — used to offer “open via proxy” when a camera host matches upstream. */
    proxyTargets: IotProxyTarget[] = [];
    isLoading = false;
    errorMessage = '';

    viewMode: CameraViewMode = 'grid';

    showEditor = false;
    editing: Camera = new Camera();
    isEditMode = false;

    confirmDeleteId: string | null = null;

    readonly knownTypes: string[] = ['snapshot', 'other'];

    /**
     * Interval between two snapshot fetches, in milliseconds. Adjustable from
     * the toolbar via {@link increaseInterval} / {@link decreaseInterval} in
     * steps of {@link INTERVAL_STEP_MS} between {@link MIN_INTERVAL_MS} and
     * {@link MAX_INTERVAL_MS}. Any currently running live preview is
     * re-scheduled at the new rate automatically.
     */
    snapshotIntervalMs = 800;
    readonly MIN_INTERVAL_MS = 200;
    readonly MAX_INTERVAL_MS = 10000;
    readonly INTERVAL_STEP_MS = 200;
    readonly maxConsecutiveErrors = 5;

    private liveStates = new Map<string, LiveState>();

    // ---------- Mosaic view state ----------
    private static readonly MOSAIC_LAYOUT_KEY = 'pattool.cameras.mosaic.layout';
    private static readonly MIN_TILE_WIDTH = 160;
    private static readonly MIN_TILE_HEIGHT = 120;

    showMosaic = false;
    isFullscreen = false;
    mosaicTiles: MosaicTile[] = [];
    private mosaicZTop = 10;
    private dragState: { tile: MosaicTile; offsetX: number; offsetY: number } | null = null;
    private resizeState: { tile: MosaicTile; startX: number; startY: number; startW: number; startH: number } | null = null;
    private boundPointerMove = (ev: PointerEvent) => this.onPointerMove(ev);
    private boundPointerUp = (ev: PointerEvent) => this.onPointerUp(ev);
    @ViewChild('mosaicCanvas') mosaicCanvas?: ElementRef<HTMLElement>;

    constructor(
        private _cameraService: CameraService,
        private _iotProxyService: IotProxyService,
        private _membersService: MembersService,
        private _router: Router,
        private _cdr: ChangeDetectorRef,
        private _zone: NgZone
    ) {}

    ngOnInit(): void {
        this.loadCameras();
    }

    ngOnDestroy(): void {
        this.liveStates.forEach(state => this.cleanupLiveState(state));
        this.liveStates.clear();
        document.removeEventListener('pointermove', this.boundPointerMove);
        document.removeEventListener('pointerup', this.boundPointerUp);
    }

    loadCameras(): void {
        this.isLoading = true;
        this.errorMessage = '';
        this._cameraService.getCameras(this.user?.id).subscribe({
            next: (cameras) => {
                this.cameras = this.sortCamerasByNameAsc(cameras || []);
                this._iotProxyService.list(this.user?.id).subscribe({
                    next: (proxies) => {
                        this.proxyTargets = proxies || [];
                        this.finishLoadCameras();
                    },
                    error: (err) => {
                        console.warn('Could not load IoT proxies for camera page', err);
                        this.proxyTargets = [];
                        this.finishLoadCameras();
                    }
                });
            },
            error: (err) => {
                console.error('Error loading cameras', err);
                this.errorMessage = err?.message || 'Error loading cameras';
                this.isLoading = false;
            }
        });
    }

    private finishLoadCameras(): void {
        this.isLoading = false;
        this.autoStartLivePreviews();
        this._cdr.markForCheck();
    }

    /** Default order: A→Z on {@link Camera#name}; empty names last. */
    private sortCamerasByNameAsc(cameras: Camera[]): Camera[] {
        return [...cameras].sort((a, b) => {
            const na = (a.name ?? '').trim();
            const nb = (b.name ?? '').trim();
            if (!na && !nb) {
                return 0;
            }
            if (!na) {
                return 1;
            }
            if (!nb) {
                return -1;
            }
            return na.localeCompare(nb, undefined, { sensitivity: 'base', numeric: true });
        });
    }

    setView(mode: CameraViewMode): void {
        this.viewMode = mode;
    }

    openCreate(): void {
        this.isEditMode = false;
        this.editing = new Camera();
        this.editing.owner = this.user?.id || '';
        this.showEditor = true;
    }

    openEdit(camera: Camera): void {
        this.isEditMode = true;
        this.editing = JSON.parse(JSON.stringify(camera));
        this.editing.password = '';
        this.showEditor = true;
    }

    closeEditor(): void {
        this.showEditor = false;
        this.editing = new Camera();
    }

    save(): void {
        if (!this.editing.name || !this.editing.name.trim()) {
            this.errorMessage = 'Name is required';
            return;
        }
        this.errorMessage = '';
        const payload: Camera = { ...this.editing } as Camera;
        if (this.isEditMode && (!payload.password || payload.password.length === 0)) {
            delete (payload as any).password;
        }
        if (this.isEditMode && this.editing.id) {
            this._cameraService.updateCamera(this.editing.id, payload).subscribe({
                next: () => {
                    this.closeEditor();
                    this.loadCameras();
                },
                error: (err) => {
                    console.error('Error updating camera', err);
                    this.errorMessage = err?.message || 'Error updating camera';
                }
            });
        } else {
            this._cameraService.createCamera(payload, this.user?.id).subscribe({
                next: () => {
                    this.closeEditor();
                    this.loadCameras();
                },
                error: (err) => {
                    console.error('Error creating camera', err);
                    this.errorMessage = err?.message || 'Error creating camera';
                }
            });
        }
    }

    duplicate(camera: Camera): void {
        if (!camera?.id) {
            return;
        }
        this.errorMessage = '';
        this._cameraService.duplicateCamera(camera.id).subscribe({
            next: () => this.loadCameras(),
            error: (err) => {
                console.error('Error duplicating camera', err);
                this.errorMessage = err?.message || 'Error duplicating camera';
            }
        });
    }

    askDelete(camera: Camera): void {
        this.confirmDeleteId = camera.id;
    }

    cancelDelete(): void {
        this.confirmDeleteId = null;
    }

    confirmDelete(): void {
        if (!this.confirmDeleteId) {
            return;
        }
        const id = this.confirmDeleteId;
        this._cameraService.deleteCamera(id).subscribe({
            next: () => {
                this.confirmDeleteId = null;
                this.loadCameras();
            },
            error: (err) => {
                console.error('Error deleting camera', err);
                this.errorMessage = err?.message || 'Error deleting camera';
                this.confirmDeleteId = null;
            }
        });
    }

    trackById(_: number, c: Camera): string {
        return c.uid || c.id || c.name;
    }

    externalUrl(camera: Camera): string {
        return camera?.webUrl || '';
    }

    /**
     * IoT proxy whose upstream host matches this camera after normalizing URLs to hostnames only
     * (scheme {@code http(s)://}, path, trailing slash stripped — comparison is equal host, not substring “contains”).
     * Camera {@link Camera#ip} may be a bare IP/host or a full URL; proxy {@link IotProxyTarget#upstreamBaseUrl} may be {@code http(s)://ip/…}.
     */
    matchingProxyForCamera(cam: Camera): IotProxyTarget | undefined {
        const candidates = this.collectCameraHostCandidates(cam);
        if (candidates.size === 0) {
            return undefined;
        }
        for (const p of this.proxyTargets) {
            const ph = this.parseHttpUrlHostname(p.upstreamBaseUrl || '');
            if (ph && candidates.has(ph)) {
                return p;
            }
        }
        return undefined;
    }

    openLanProxy(cam: Camera): void {
        const row = this.matchingProxyForCamera(cam);
        if (!row?.publicSlug) {
            return;
        }
        this.mintAndOpenLanProxySlug(row.publicSlug);
    }

    /**
     * IoT LAN proxy for the Reolink NVR web UI: proxy {@link IotProxyTarget#description} must contain both “nvr” and “reolink” (any case).
     */
    reolinkNvrProxy(): IotProxyTarget | undefined {
        return this.proxyTargets.find((p) => {
            const d = (p.description || '').toLowerCase();
            return d.includes('reolink') && d.includes('nvr');
        });
    }

    openReolinkNvrProxy(): void {
        const row = this.reolinkNvrProxy();
        if (!row?.publicSlug) {
            return;
        }
        this.mintAndOpenLanProxySlug(row.publicSlug);
    }

    private mintAndOpenLanProxySlug(publicSlug: string): void {
        this.errorMessage = '';
        this._iotProxyService.mintBrowserOpenUrl(publicSlug, undefined, this.user?.id).subscribe({
            next: (res) => {
                const abs = this._iotProxyService.resolveBackendAbsoluteUrl(res.relativeUrlWithQuery);
                window.open(abs, '_blank', 'noopener,noreferrer');
            },
            error: (err) => {
                console.error('mintBrowserOpenUrl', err);
                this.errorMessage = err?.message || err?.statusText || 'LAN proxy open failed';
                this._cdr.markForCheck();
            }
        });
    }

    /** Default upstream base URL for a new IoT proxy row (camera IP or host from web/snapshot URL). */
    suggestedProxyUpstreamForCamera(cam: Camera): string {
        const host =
            this.parseHttpUrlHostname(cam.ip) ??
            this.parseHttpUrlHostname(cam.webUrl) ??
            this.parseHttpUrlHostname(cam.snapshotUrl);
        if (!host) {
            return '';
        }
        return this.formatHttpLanBaseUrl(host);
    }

    /** Navigate to IoT LAN proxy page and open “add” with prefilled upstream/description when possible. */
    goCreateLanProxyForCamera(cam: Camera): void {
        this.errorMessage = '';
        const upstream = this.suggestedProxyUpstreamForCamera(cam).trim();
        const desc = (cam.name || '').trim() || 'Camera';
        const qp: Record<string, string> = { new: '1', desc };
        if (upstream) {
            qp['upstream'] = upstream;
        }
        this._router.navigate(['/iot/proxy'], { queryParams: qp }).catch((err) => console.error(err));
    }

    private formatHttpLanBaseUrl(host: string): string {
        const needBrackets = host.includes(':') && !host.startsWith('[');
        const h = needBrackets ? `[${host}]` : host;
        return `http://${h}/`;
    }

    /** Hostnames stripped of scheme/path for matching (see {@link #parseHttpUrlHostname}). */
    private collectCameraHostCandidates(cam: Camera): Set<string> {
        const set = new Set<string>();
        const ipH = this.parseHttpUrlHostname(cam.ip) ?? this.normalizePlainHost(cam.ip);
        if (ipH) {
            set.add(ipH);
        }
        const wh = this.parseHttpUrlHostname(cam.webUrl);
        if (wh) {
            set.add(wh);
        }
        const sh = this.parseHttpUrlHostname(cam.snapshotUrl);
        if (sh) {
            set.add(sh);
        }
        return set;
    }

    /** Lowercase hostname / bracketless IPv6; does not strip {@code http://} — prefer {@link #parseHttpUrlHostname} for URLs. */
    private normalizePlainHost(raw: string | undefined | null): string | null {
        if (!raw || !String(raw).trim()) {
            return null;
        }
        let s = String(raw).trim().toLowerCase();
        if (s.startsWith('[') && s.endsWith(']')) {
            s = s.slice(1, -1);
        }
        return s;
    }

    /**
     * Extracts hostname from an absolute or abbreviated URL string (camera IP field, proxy base URL, web/snapshot URLs).
     * Handles {@code http(s)://}, path, trailing slash; port is not part of the returned host (RFC host only).
     * Bare {@code 192.168.1.1} is parsed as {@code http://192.168.1.1}.
     */
    private parseHttpUrlHostname(urlLike: string | undefined | null): string | null {
        if (!urlLike || !String(urlLike).trim()) {
            return null;
        }
        const t = String(urlLike).trim();
        try {
            const u = new URL(t.includes('://') ? t : `http://${t}`);
            return this.normalizePlainHost(u.hostname);
        } catch {
            return null;
        }
    }

    // ===================== Live snapshot polling =====================

    increaseInterval(): void {
        this.applyIntervalMs(this.snapshotIntervalMs + this.INTERVAL_STEP_MS);
    }

    decreaseInterval(): void {
        this.applyIntervalMs(this.snapshotIntervalMs - this.INTERVAL_STEP_MS);
    }

    canIncreaseInterval(): boolean {
        return this.snapshotIntervalMs + this.INTERVAL_STEP_MS <= this.MAX_INTERVAL_MS;
    }

    canDecreaseInterval(): boolean {
        return this.snapshotIntervalMs - this.INTERVAL_STEP_MS >= this.MIN_INTERVAL_MS;
    }

    private applyIntervalMs(valueMs: number): void {
        const clamped = Math.max(this.MIN_INTERVAL_MS, Math.min(this.MAX_INTERVAL_MS, valueMs));
        if (clamped === this.snapshotIntervalMs) {
            return;
        }
        this.snapshotIntervalMs = clamped;
        this.rescheduleActivePolling();
    }

    /**
     * Re-schedules every live camera at the currently configured interval,
     * so changes made via {@link increaseInterval} / {@link decreaseInterval}
     * take effect immediately without stopping the stream.
     */
    private rescheduleActivePolling(): void {
        this._zone.runOutsideAngular(() => {
            this.liveStates.forEach((state, cameraId) => {
                if (!state.live) {
                    return;
                }
                if (state.intervalId !== null) {
                    clearInterval(state.intervalId);
                }
                const cam = this.cameras.find(c => c.id === cameraId);
                if (!cam) {
                    return;
                }
                state.intervalId = setInterval(() => {
                    this.fetchSnapshotOnce(cam);
                }, this.snapshotIntervalMs);
            });
        });
    }

    private autoStartLivePreviews(): void {
        for (const cam of this.cameras) {
            if (cam.id && cam.snapshotUrl && cam.snapshotUrl.trim().length > 0) {
                this.startLive(cam);
            }
        }
    }

    private getOrCreateState(cameraId: string): LiveState {
        let state = this.liveStates.get(cameraId);
        if (!state) {
            state = {
                live: false,
                blobUrl: null,
                intervalId: null,
                inFlight: null,
                errorCount: 0
            };
            this.liveStates.set(cameraId, state);
        }
        return state;
    }

    isLive(camera: Camera): boolean {
        if (!camera?.id) {
            return false;
        }
        return this.liveStates.get(camera.id)?.live === true;
    }

    liveSrc(camera: Camera): string | null {
        if (!camera?.id) {
            return null;
        }
        return this.liveStates.get(camera.id)?.blobUrl ?? null;
    }

    liveError(camera: Camera): string | undefined {
        if (!camera?.id) {
            return undefined;
        }
        return this.liveStates.get(camera.id)?.lastErrorMessage;
    }

    toggleLive(camera: Camera): void {
        if (!camera?.id) {
            return;
        }
        const state = this.getOrCreateState(camera.id);
        if (state.live) {
            this.stopLive(camera);
        } else {
            this.startLive(camera);
        }
    }

    /**
     * True when at least one camera with a snapshotUrl is currently streaming.
     * Drives the global pause/start toolbar button.
     */
    hasAnyLive(): boolean {
        for (const state of this.liveStates.values()) {
            if (state.live) {
                return true;
            }
        }
        return false;
    }

    /** True when at least one camera has a snapshotUrl configured. */
    hasAnySnapshotCapable(): boolean {
        return this.cameras.some(c => !!(c.snapshotUrl && c.snapshotUrl.trim().length > 0));
    }

    /**
     * Smart toolbar action:
     *   - if any live preview is running  → pause every one of them;
     *   - otherwise                       → start a live preview on every
     *                                       camera that has a snapshotUrl.
     */
    toggleAllLive(): void {
        if (this.hasAnyLive()) {
            for (const cam of this.cameras) {
                this.stopLive(cam);
            }
        } else {
            for (const cam of this.cameras) {
                if (cam.snapshotUrl && cam.snapshotUrl.trim().length > 0) {
                    this.startLive(cam);
                }
            }
        }
    }

    private startLive(camera: Camera): void {
        if (!camera?.id) {
            return;
        }
        const state = this.getOrCreateState(camera.id);
        if (state.live) {
            return;
        }
        state.live = true;
        state.errorCount = 0;
        state.lastErrorMessage = undefined;

        this.fetchSnapshotOnce(camera);

        this._zone.runOutsideAngular(() => {
            state.intervalId = setInterval(() => {
                this.fetchSnapshotOnce(camera);
            }, this.snapshotIntervalMs);
        });
    }

    private stopLive(camera: Camera): void {
        if (!camera?.id) {
            return;
        }
        const state = this.liveStates.get(camera.id);
        if (!state) {
            return;
        }
        state.live = false;
        this.cleanupLiveState(state);
        state.blobUrl = null;
        state.inFlight = null;
        state.intervalId = null;
        this._cdr.markForCheck();
    }

    private cleanupLiveState(state: LiveState): void {
        if (state.intervalId !== null) {
            clearInterval(state.intervalId);
        }
        if (state.inFlight) {
            state.inFlight.unsubscribe();
        }
        if (state.blobUrl) {
            URL.revokeObjectURL(state.blobUrl);
        }
    }

    // ===================== Mosaic view =====================

    /**
     * Opens the mosaic modal. Starts live polling on every snapshot-capable
     * camera that isn't already streaming, then (asynchronously, once the
     * modal canvas has been inserted into the DOM) builds the initial tile
     * layout from the saved state (or auto-grid if none).
     */
    openMosaic(): void {
        this.showMosaic = true;
        for (const cam of this.cameras) {
            if (cam.id && cam.snapshotUrl && cam.snapshotUrl.trim().length > 0) {
                const state = this.getOrCreateState(cam.id);
                if (!state.live) {
                    this.startLive(cam);
                }
            }
        }
        setTimeout(() => this.buildMosaicTiles(), 0);
    }

    closeMosaic(): void {
        if (this.isFullscreen) {
            this.exitFullscreen();
        }
        this.showMosaic = false;
    }

    /**
     * Resets every tile to a balanced auto-grid (closest rows×cols square
     * layout). Also clears the persisted layout so subsequent openings start
     * fresh until the user drags something.
     */
    autoLayout(): void {
        try {
            localStorage.removeItem(IotCamerasComponent.MOSAIC_LAYOUT_KEY);
        } catch {
            // ignore storage errors (quota, private mode)
        }
        this.buildMosaicTiles(true);
    }

    private buildMosaicTiles(forceAuto = false): void {
        const saved = forceAuto ? {} : this.loadMosaicLayout();
        const snapshotCams = this.cameras.filter(c => !!c.id && !!c.snapshotUrl && c.snapshotUrl.trim().length > 0);
        if (snapshotCams.length === 0) {
            this.mosaicTiles = [];
            return;
        }
        const canvas = this.mosaicCanvas?.nativeElement;
        const cw = Math.max(400, canvas?.clientWidth || 1200);
        const ch = Math.max(300, canvas?.clientHeight || 700);
        const cols = Math.ceil(Math.sqrt(snapshotCams.length));
        const rows = Math.ceil(snapshotCams.length / cols);
        const gap = 8;
        const tileW = Math.floor((cw - gap * (cols + 1)) / cols);
        const tileH = Math.floor((ch - gap * (rows + 1)) / rows);

        this.mosaicTiles = snapshotCams.map((cam, i) => {
            const savedTile = saved[cam.id!];
            if (savedTile) {
                return {
                    cameraId: cam.id!,
                    x: Math.max(0, Number(savedTile.x) || 0),
                    y: Math.max(0, Number(savedTile.y) || 0),
                    width: Math.max(IotCamerasComponent.MIN_TILE_WIDTH, Number(savedTile.width) || tileW),
                    height: Math.max(IotCamerasComponent.MIN_TILE_HEIGHT, Number(savedTile.height) || tileH),
                    zIndex: 10
                };
            }
            const row = Math.floor(i / cols);
            const col = i % cols;
            return {
                cameraId: cam.id!,
                x: gap + col * (tileW + gap),
                y: gap + row * (tileH + gap),
                width: tileW,
                height: tileH,
                zIndex: 10
            };
        });
        this.mosaicZTop = 10;
    }

    getMosaicCamera(cameraId: string): Camera | undefined {
        return this.cameras.find(c => c.id === cameraId);
    }

    trackTile(_: number, t: MosaicTile): string {
        return t.cameraId;
    }

    private bringToFront(tile: MosaicTile): void {
        this.mosaicZTop++;
        tile.zIndex = this.mosaicZTop;
    }

    startTileDrag(tile: MosaicTile, ev: PointerEvent): void {
        ev.preventDefault();
        this.bringToFront(tile);
        this.dragState = {
            tile,
            offsetX: ev.clientX - tile.x,
            offsetY: ev.clientY - tile.y
        };
        this._zone.runOutsideAngular(() => {
            document.addEventListener('pointermove', this.boundPointerMove);
            document.addEventListener('pointerup', this.boundPointerUp);
        });
    }

    startTileResize(tile: MosaicTile, ev: PointerEvent): void {
        ev.preventDefault();
        ev.stopPropagation();
        this.bringToFront(tile);
        this.resizeState = {
            tile,
            startX: ev.clientX,
            startY: ev.clientY,
            startW: tile.width,
            startH: tile.height
        };
        this._zone.runOutsideAngular(() => {
            document.addEventListener('pointermove', this.boundPointerMove);
            document.addEventListener('pointerup', this.boundPointerUp);
        });
    }

    private onPointerMove(ev: PointerEvent): void {
        // Read canvas bounds once per event so we can clamp tiles inside it.
        const canvas = this.mosaicCanvas?.nativeElement;
        const cw = canvas?.clientWidth || Infinity;
        const ch = canvas?.clientHeight || Infinity;

        if (this.dragState) {
            const t = this.dragState.tile;
            let x = ev.clientX - this.dragState.offsetX;
            let y = ev.clientY - this.dragState.offsetY;
            x = Math.max(0, Math.min(cw - 40, x));
            y = Math.max(0, Math.min(ch - 40, y));
            this._zone.run(() => {
                t.x = x;
                t.y = y;
                this._cdr.markForCheck();
            });
        } else if (this.resizeState) {
            const t = this.resizeState.tile;
            const dx = ev.clientX - this.resizeState.startX;
            const dy = ev.clientY - this.resizeState.startY;
            const w = Math.max(IotCamerasComponent.MIN_TILE_WIDTH, this.resizeState.startW + dx);
            const h = Math.max(IotCamerasComponent.MIN_TILE_HEIGHT, this.resizeState.startH + dy);
            this._zone.run(() => {
                t.width = w;
                t.height = h;
                this._cdr.markForCheck();
            });
        }
    }

    private onPointerUp(_: PointerEvent): void {
        const hadInteraction = this.dragState || this.resizeState;
        this.dragState = null;
        this.resizeState = null;
        document.removeEventListener('pointermove', this.boundPointerMove);
        document.removeEventListener('pointerup', this.boundPointerUp);
        if (hadInteraction) {
            this.saveMosaicLayout();
        }
    }

    private saveMosaicLayout(): void {
        const layout: Record<string, { x: number; y: number; width: number; height: number }> = {};
        for (const t of this.mosaicTiles) {
            layout[t.cameraId] = { x: t.x, y: t.y, width: t.width, height: t.height };
        }
        try {
            localStorage.setItem(IotCamerasComponent.MOSAIC_LAYOUT_KEY, JSON.stringify(layout));
        } catch {
            // ignore storage errors (quota, private mode)
        }
    }

    private loadMosaicLayout(): Record<string, { x: number; y: number; width: number; height: number }> {
        try {
            const raw = localStorage.getItem(IotCamerasComponent.MOSAIC_LAYOUT_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    }

    toggleFullscreen(): void {
        const canvas = this.mosaicCanvas?.nativeElement;
        if (!canvas) {
            return;
        }
        if (document.fullscreenElement) {
            this.exitFullscreen();
        } else {
            const req = (canvas as any).requestFullscreen
                || (canvas as any).webkitRequestFullscreen
                || (canvas as any).msRequestFullscreen;
            if (req) {
                req.call(canvas);
            }
        }
    }

    /**
     * Toggles the native browser fullscreen on a single camera's stream
     * wrapper. Uses the DOM element tagged with `id="cam-stream-{camera.id}"`
     * in the grid view. If no live preview is running yet, starts it so the
     * fullscreen view has content to display.
     */
    toggleCardFullscreen(camera: Camera): void {
        if (!camera?.id) {
            return;
        }
        if (document.fullscreenElement) {
            this.exitFullscreen();
            return;
        }
        const el = document.getElementById('cam-stream-' + camera.id);
        if (!el) {
            return;
        }
        if (camera.snapshotUrl && !this.isLive(camera)) {
            this.startLive(camera);
        }
        const req = (el as any).requestFullscreen
            || (el as any).webkitRequestFullscreen
            || (el as any).msRequestFullscreen;
        if (req) {
            req.call(el);
        }
    }

    private exitFullscreen(): void {
        const ex = (document as any).exitFullscreen
            || (document as any).webkitExitFullscreen
            || (document as any).msExitFullscreen;
        if (ex && document.fullscreenElement) {
            ex.call(document);
        }
    }

    @HostListener('document:fullscreenchange')
    @HostListener('document:webkitfullscreenchange')
    onFullscreenChange(): void {
        this.isFullscreen = !!document.fullscreenElement;
        // When entering or leaving fullscreen the canvas size changes. We
        // don't rebuild the layout (user intent wins) but we do clamp any
        // tile that would otherwise be off-screen.
        setTimeout(() => this.clampTilesToCanvas(), 50);
        this._cdr.markForCheck();
    }

    private clampTilesToCanvas(): void {
        const canvas = this.mosaicCanvas?.nativeElement;
        if (!canvas || this.mosaicTiles.length === 0) {
            return;
        }
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        for (const t of this.mosaicTiles) {
            t.x = Math.max(0, Math.min(cw - 40, t.x));
            t.y = Math.max(0, Math.min(ch - 40, t.y));
            t.width = Math.min(t.width, Math.max(IotCamerasComponent.MIN_TILE_WIDTH, cw - t.x));
            t.height = Math.min(t.height, Math.max(IotCamerasComponent.MIN_TILE_HEIGHT, ch - t.y));
        }
    }

    // ===================== Snapshot fetch =====================

    private fetchSnapshotOnce(camera: Camera): void {
        if (!camera?.id) {
            return;
        }
        const state = this.getOrCreateState(camera.id);
        if (!state.live) {
            return;
        }
        // Skip if a request is still pending (slow camera / slow network)
        if (state.inFlight && !state.inFlight.closed) {
            return;
        }
        state.inFlight = this._cameraService.getSnapshot(camera.id).subscribe({
            next: (blob) => {
                const newUrl = URL.createObjectURL(blob);
                this._zone.run(() => {
                    if (state.blobUrl) {
                        URL.revokeObjectURL(state.blobUrl);
                    }
                    state.blobUrl = newUrl;
                    state.errorCount = 0;
                    state.lastErrorMessage = undefined;
                    this._cdr.markForCheck();
                });
            },
            error: (err) => {
                this._zone.run(() => {
                    state.errorCount++;
                    state.lastErrorMessage = err?.error?.message || err?.message || 'Snapshot error';
                    if (state.errorCount >= this.maxConsecutiveErrors) {
                        console.warn('Too many snapshot errors, pausing live for camera', camera.name);
                        this.stopLive(camera);
                    }
                    this._cdr.markForCheck();
                });
            }
        });
    }
}
