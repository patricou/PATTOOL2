import { ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener, Inject, OnDestroy, Output, TemplateRef, ViewChild } from '@angular/core';
import { CommonModule, DOCUMENT } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { NgbModule, NgbModal, NgbModalOptions, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Router } from '@angular/router';
import { FileService } from '../../services/file.service';
import { KeycloakService } from '../../keycloak/keycloak.service';
import { ApiService } from '../../services/api.service';
import { Subject } from 'rxjs';
import { take, takeUntil } from 'rxjs/operators';
import * as L from 'leaflet';
import { isValidGeoCoordinate } from '../geo-coordinates.util';

interface TraceViewerSource {
	fileId?: string;
	blob?: Blob;
	/** Real file name (extension used for GPX/KML/… parsing). */
	fileName: string;
	/** Optional title in the modal header (e.g. user description); falls back to fileName. */
	titleLabel?: string;
	location?: { lat: number; lng: number; label?: string; zoom?: number };
	positions?: Array<{ lat: number; lng: number; type?: string; datetime?: Date; label?: string }>;
	/** When set (e.g. globe embed), selects this base layer id after layers are created. */
	initialBaseLayerId?: string;
}

interface TraceStatistics {
	points: number;
	distanceKm: number | null;
}

@Component({
	selector: 'app-trace-viewer-modal',
	templateUrl: './trace-viewer-modal.component.html',
	styleUrls: ['./trace-viewer-modal.component.css'],
	standalone: true,
	imports: [
		CommonModule,
		FormsModule,
		NgbModule,
		TranslateModule
	]
})
export class TraceViewerModalComponent implements OnDestroy {
	@ViewChild('traceViewerModal') traceViewerModal!: TemplateRef<any>;
	@ViewChild('cartesGouvModal') cartesGouvModal!: TemplateRef<any>;
	@ViewChild('mapContainer', { static: false }) mapContainerRef?: ElementRef<HTMLDivElement>;
	@Output() closed = new EventEmitter<void>();
	@Output() locationSelected = new EventEmitter<{ lat: number; lng: number }>();

	// Expose Math to template
	Math = Math;

	public isLoading = false;
	public hasError = false;
	public errorMessage = '';
	public trackFileName = '';
	public trackStats: TraceStatistics | null = null;
	public isFullscreen = false;
	public showGpsCoordinates = false;
	public currentLat: number = 0;
	public currentLng: number = 0;
	public currentAlt: number | null = null;

	/** Template helper: altitude overlay only when value is a finite number (not NaN). */
	public isFiniteAltitude(alt: number | null | undefined): alt is number {
		return typeof alt === 'number' && Number.isFinite(alt);
	}
	public clickedAddress: string = '';
	public clickedLat: number = 0;
	public clickedLng: number = 0;
	public clickedAlt: number | null = null;
	private finalSelectedCoordinates?: { lat: number; lng: number };
	public showAddress: boolean = false;
	public showWeather: boolean = false;
	public currentWeather: any = null;
	public isLoadingWeather: boolean = false;
	public clickedWeatherLat: number = 0;
	public clickedWeatherLng: number = 0;
	public clickedWeatherAlt: number | null = null;
	public clickedWeatherAddress: string = '';
	/** Show hiking trails overlay (Waymarked Trails) above the base map. */
	public showHikingTrailsOverlay: boolean = false;
	private hikingTrailsOverlay?: L.TileLayer;
	/** Show cycling trails overlay (Waymarked Trails) above the base map. */
	public showCyclingTrailsOverlay: boolean = false;
	private cyclingTrailsOverlay?: L.TileLayer;

	/** Follow device GPS: recenter the map every 5 s. */
	public followDeviceLocation: boolean = false;
	/** Keep the device screen on while the trace viewer is open (mobile). */
	public keepScreenAwake = false;
	private screenWakeLock: WakeLockSentinel | null = null;
	private screenWakeLockReleaseHandler?: () => void;
	private visibilityChangeHandler?: () => void;
	private static readonly DEVICE_LOCATION_FOLLOW_INTERVAL_S = 5;
	/** Visible countdown (seconds until next update); 0 while an update is in progress. */
	public deviceLocationCountdown: number = 0;
	private deviceLocationCountdownId: ReturnType<typeof setInterval> | null = null;
	/** Map marker shown for device GPS when “Follow my position” is enabled. */
	private deviceLocationMarker?: L.Marker;

	// Event color for styling
	private eventColor: { r: number; g: number; b: number } | null = null;
	private mapMoveHandler?: () => void;
	private mapMouseMoveHandler?: (e: L.LeafletMouseEvent) => void;
	private mapMouseOutHandler?: () => void;
	private addressClickHandler?: (e: L.LeafletMouseEvent) => void;
	private mapClickHandler?: (e: L.LeafletMouseEvent) => void;

	private readonly destroy$ = new Subject<void>();
	private modalRef?: NgbModalRef;
	/** When set before `open()`, overrides default `NgbModal` options (e.g. attach into the globe div). */
	private nextModalOptionsOverride: NgbModalOptions | null = null;
	private map?: L.Map;
	private overlayLayer?: L.LayerGroup;
	private pendingTrackPoints: L.LatLngTuple[] | null = null;
	private pendingLocation: { lat: number; lng: number; label?: string; zoom?: number } | null = null;
	private pendingPositions: Array<{ lat: number; lng: number; type?: string; datetime?: Date; label?: string }> | null = null;
	private lastRenderedPosition: { lat: number; lng: number } | null = null; // Store the most recent position after rendering
	private selectionMode: boolean = false;
	private simpleShareMode: boolean = false;
	private selectionMarker?: L.Marker;
	private clickMarker?: L.Marker;
	private locationSelectionClickHandler?: (e: L.LeafletMouseEvent) => void;

	private static leafletIconsConfigured = false;
	private static leafletPassiveTouchRoots = new Set<HTMLElement>();
	private static leafletControlPassiveTouchOriginal: typeof HTMLElement.prototype.addEventListener | null = null;
	/** Container registered for this patch (unregister on destroy). */
	private leafletMapPassivePatchContainer: HTMLElement | null = null;
	private fullscreenChangeHandler?: () => void;
	private orientationMediaQuery: MediaQueryList | null = null;
	private orientationChangeHandler?: () => void;
	private baseLayers: Record<string, L.TileLayer | L.LayerGroup> = {};
	public availableBaseLayers: Array<{ id: string; label: string; labelKey?: string }> = [];
	public selectedBaseLayerId: string = '';
	/** Last base map before opening “All IGN maps” from the list (not the IGN shortcut button). */
	private lastBaseLayerBeforeCartesGouv: string = 'opentopomap';
	private activeBaseLayer?: L.TileLayer | L.LayerGroup;
	/** Current map zoom level (shown in the UI corner). */
	public currentZoom: number = 6;
	/** True after the map is initialized (enables zoom overlay). */
	public isMapReady = false;
	/** cartes.gouv.fr iframe embed URL (center + zoom) for that modal. */
	public cartesGouvEmbedUrl: SafeResourceUrl | null = null;
	private cartesGouvModalRef?: NgbModalRef;
	public cartesGouvFullscreen = false;
	private cartesGouvFullscreenChangeListener?: () => void;
	private thunderforestApiKey: string = '';
	public isFullscreenInfoVisible = false;
	/** Fullscreen options panel (basemap, switches, actions) — collapsed by default. */
	public isFullscreenOptionsExpanded = false;
	private trackBounds: L.LatLngBounds | null = null;
	/** Tracks container resize (flex / modal / embed) to recover Leaflet black-map issues. */
	private mapLayoutResizeObserver?: ResizeObserver;
	private mapLayoutSyncDebouncer: number | null = null;
	private traceViewerCdrTimer: number | null = null;
	private mapResizeObservedDims = { w: -1, h: -1 };
	/** Bloque le scroll de la page derrière la modale. */
	private modalWindowWheelHandler?: (event: Event) => void;
	private modalWindowWheelListenEl?: HTMLElement;
	/** Molette carte : delta accumulé + 1 mise à jour / frame (comme slideshow). */
	private traceMapWheelHandler?: (event: WheelEvent) => void;
	private traceMapWheelAccum = 0;
	private traceMapWheelRafId: number | null = null;
	private traceMapWheelPoint = { x: 0, y: 0 };
	private mapContainerHadLayout = false;
	private mapInitVisibilityAttempts = 0;
	/** `NgbModal` `container` host for embedding (globe): resolve `.map-container` under this root (avoid global IDs). */
	private mapEmbedHostRoot?: HTMLElement;
	private embeddedModalMapKickToken = 0;
	private static readonly TRACE_VIEWER_MODAL_WINDOW_CLASS = 'slideshow-modal-wide trace-viewer-leaflet-modal';
	private static readonly SWISSTOPO_BASEMAP_IDS = new Set<string>(['swisstopo-pixelkarte', 'swisstopo-swissimage']);
	private static readonly SWISSTOPO_ATTRIBUTION =
		'&copy; <a href="https://www.swisstopo.admin.ch/" target="_blank" rel="noopener noreferrer">swisstopo</a> — <a href="https://www.geo.admin.ch/" target="_blank" rel="noopener noreferrer">geo.admin.ch</a>';
	private rightMouseZoomActive = false;
	private rightMouseStartLatLng?: L.LatLng;
	private rightMouseRectangle?: L.Rectangle;
	private rightClickDraggingDisabled = false;
	private preventContextMenu = (event: MouseEvent) => event.preventDefault();
	private handleMapContextMenu = (event: L.LeafletMouseEvent) => event.originalEvent.preventDefault();
	private handleMapMouseDown = (event: L.LeafletMouseEvent) => {
		if (!this.map || event.originalEvent.button !== 2) {
			return;
		}
		this.rightMouseZoomActive = true;
		this.rightMouseStartLatLng = event.latlng;
		this.rightMouseRectangle?.remove();
		this.rightMouseRectangle = L.rectangle(L.latLngBounds(event.latlng, event.latlng), {
			color: '#20c997',
			weight: 1,
			fillColor: '#20c997',
			fillOpacity: 0.15,
			dashArray: '4 3'
		}).addTo(this.map);
		if (this.map.dragging.enabled()) {
			this.map.dragging.disable();
			this.rightClickDraggingDisabled = true;
		}
	};
	private escapeKeydownListener?: (event: KeyboardEvent) => void;
	private hasEmittedClosed: boolean = false;
	private handleMapMouseMove = (event: L.LeafletMouseEvent) => {
		if (!this.map || !this.rightMouseZoomActive || !this.rightMouseStartLatLng || !this.rightMouseRectangle) {
			return;
		}
		this.rightMouseRectangle.setBounds(L.latLngBounds(this.rightMouseStartLatLng, event.latlng));
	};
	private handleMapMouseUp = (event: L.LeafletMouseEvent) => {
		// Restore crosshair cursor after drag
		setTimeout(() => this.forceCrosshairCursor(), 0);
		if (!this.map || !this.rightMouseZoomActive || !this.rightMouseStartLatLng || !this.rightMouseRectangle) {
			return;
		}
		const startPoint = this.map.latLngToContainerPoint(this.rightMouseStartLatLng);
		const endPoint = this.map.latLngToContainerPoint(event.latlng);
		const width = Math.abs(endPoint.x - startPoint.x);
		const height = Math.abs(endPoint.y - startPoint.y);
		const bounds = this.rightMouseRectangle.getBounds();
		this.rightMouseRectangle.remove();
		this.rightMouseRectangle = undefined;
		this.rightMouseZoomActive = false;
		if (this.rightClickDraggingDisabled && this.map && !this.map.dragging.enabled()) {
			this.map.dragging.enable();
			this.rightClickDraggingDisabled = false;
		}
		if (width > 10 && height > 10) {
			this.map.fitBounds(bounds, { padding: [24, 24] });
		}
	};
	private handleMapMouseLeave = () => {
		if (!this.map) {
			return;
		}
		if (this.rightMouseRectangle) {
			this.rightMouseRectangle.remove();
			this.rightMouseRectangle = undefined;
		}
		this.rightMouseZoomActive = false;
		if (this.rightClickDraggingDisabled && this.map.dragging && !this.map.dragging.enabled()) {
			this.map.dragging.enable();
			this.rightClickDraggingDisabled = false;
		}
	};

	constructor(
		private readonly modalService: NgbModal,
		private readonly cdr: ChangeDetectorRef,
		private readonly translateService: TranslateService,
		private readonly fileService: FileService,
		private readonly keycloakService: KeycloakService,
		private readonly apiService: ApiService,
		private readonly sanitizer: DomSanitizer,
		private readonly router: Router,
		@Inject(DOCUMENT) private readonly document: Document
	) {
		this.configureLeafletIcons();
	}

	ngOnDestroy(): void {
		if (this.traceViewerCdrTimer != null) {
			clearTimeout(this.traceViewerCdrTimer);
			this.traceViewerCdrTimer = null;
		}
		this.stopFollowDeviceLocation();
		void this.releaseScreenWakeLock();
		this.cleanupVisibilityChangeListener();
		this.destroy$.next();
		this.destroy$.complete();
		this.close();
		this.destroyMap();
		this.cleanupFullscreenListener();
		this.cleanupOrientationListener();
		this.cleanupRightClickZoom();
		this.cleanupLocationSelection();
	}

	@HostListener('window:keydown.escape', ['$event'])
	onEscape(event: Event): void {
		const keyboardEvent = event as KeyboardEvent;
		event.preventDefault();
		this.close();
	}

	@HostListener('window:keydown', ['$event'])
	onKeydown(event: KeyboardEvent): void {
		if (!this.map) {
			return;
		}

		const key = event.key.toLowerCase();
		if (key === 'r') {
			event.preventDefault();
			this.recenterOnTrack();
		}
	}

	public openFromFile(
		fileId: string,
		fileName: string,
		eventColor?: { r: number; g: number; b: number },
		displayTitle?: string | null
	): void {
		// Store event color if provided
		if (eventColor) {
			this.eventColor = eventColor;
		} else {
			this.eventColor = null;
		}
		const trimmedTitle = displayTitle != null && String(displayTitle).trim().length > 0 ? String(displayTitle).trim() : undefined;
		this.open({ fileId, fileName, titleLabel: trimmedTitle });
	}

	public openFromBlob(blob: Blob, fileName: string, eventColor?: { r: number; g: number; b: number }): void {
		// Store event color if provided
		if (eventColor) {
			this.eventColor = eventColor;
		} else {
			this.eventColor = null;
		}
		this.open({ blob, fileName });
	}

	/**
	 * Open the trace viewer inside a host element (no full-window backdrop),
	 * e.g. embed on the 3D globe or another panel.
	 */
	public openAtLocationEmbedded(
		container: HTMLElement,
		lat: number,
		lng: number,
		options?: { locationZoom?: number; label?: string; initialBaseLayerId?: string }
	): void {
		if (!container || !isValidGeoCoordinate(lat, lng)) {
			return;
		}

		const fallback = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
		const fileName =
			options?.label != null && String(options.label).trim().length > 0
				? String(options.label).trim()
				: fallback;

		this.eventColor = null;
		this.selectionMode = false;
		this.simpleShareMode = false;

		this.nextModalOptionsOverride = {
			container,
			backdrop: false,
			centered: false,
			scrollable: true,
			keyboard: true,
			windowClass: 'modal-smooth-animation world-globe-trace-embed',
			modalDialogClass: 'modal-dialog-globe-embed'
		};

		this.open({
			fileName,
			location: { lat, lng, label: options?.label, zoom: options?.locationZoom },
			initialBaseLayerId: options?.initialBaseLayerId
		});
	}

	public openAtLocation(lat: number, lng: number, label?: string, eventColor?: { r: number; g: number; b: number }, enableSelection: boolean = false, simpleShare: boolean = false): void {
		if (!isValidGeoCoordinate(lat, lng)) {
			return;
		}

		const fallback = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
		const fileName = label && label.trim().length > 0 ? label : fallback;

		// Store event color if provided
		if (eventColor) {
			this.eventColor = eventColor;
		} else {
			this.eventColor = null;
		}

		// Store selection mode and simple share mode BEFORE calling open() which resets state
		this.selectionMode = enableSelection;
		this.simpleShareMode = simpleShare;

		// Call open() which will call resetState() and reset selectionMode to false
		this.open({
			fileName,
			location: { lat, lng, label }
		});

		// Restore selectionMode and simpleShareMode AFTER open() has reset it
		this.selectionMode = enableSelection;
		this.simpleShareMode = simpleShare;
	}

	/**
	 * Open trace viewer with multiple positions (history)
	 * @param positions Array of positions to display
	 * @param fileName Label for the trace
	 * @param eventColor Optional color for styling
	 */
	public openWithPositions(positions: Array<{ lat: number; lng: number; type?: string; datetime?: Date; label?: string }>, fileName: string, eventColor?: { r: number; g: number; b: number }): void {
		if (!positions || positions.length === 0) {
			console.warn('No positions provided to openWithPositions');
			return;
		}

		// Validate positions
		const validPositions = positions.filter(p => isValidGeoCoordinate(p.lat, p.lng));

		if (validPositions.length === 0) {
			console.warn('No valid positions provided');
			return;
		}

		// Store event color if provided
		if (eventColor) {
			this.eventColor = eventColor;
		} else {
			this.eventColor = null;
		}

		// Open with positions
		this.open({
			fileName,
			positions: validPositions
		});
	}

	private clearMapLayoutSyncDebouncer(): void {
		if (this.mapLayoutSyncDebouncer != null) {
			clearTimeout(this.mapLayoutSyncDebouncer);
			this.mapLayoutSyncDebouncer = null;
		}
	}

	private isSwisstopoBasemap(layerId: string): boolean {
		return TraceViewerModalComponent.SWISSTOPO_BASEMAP_IDS.has(layerId);
	}

	private createSwisstopoLayer(layerId: string): L.TileLayer {
		const isImage = layerId === 'swisstopo-swissimage';
		return L.tileLayer(
			isImage
				? 'https://wmts{s}.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg'
				: 'https://wmts{s}.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg',
			{
				subdomains: '0123456789',
				maxZoom: isImage ? 19 : 18,
				minZoom: 2,
				attribution: TraceViewerModalComponent.SWISSTOPO_ATTRIBUTION
			}
		);
	}

	/** Après resize / ouverture modale : invalidateSize ; premier layout → trace + fitBounds. */
	private syncMapLayoutCore(): void {
		if (!this.map) {
			return;
		}
		const el = this.map.getContainer();
		const ok = el.offsetWidth >= 2 && el.offsetHeight >= 2;
		this.map.invalidateSize({ animate: false });
		const hadLayout = this.mapContainerHadLayout;
		this.mapContainerHadLayout = ok;
		if (!ok) {
			return;
		}
		if (!hadLayout) {
			this.tryRenderPendingTrack();
			this.tryRenderPendingPositions();
			this.tryRenderPendingLocation();
			if (this.trackBounds?.isValid()) {
				this.map.fitBounds(this.trackBounds, { padding: [24, 24] });
			}
		}
	}

	private getModalWindowElement(): HTMLElement | null {
		const modalRefAny = this.modalRef as { _windowCmptRef?: { location?: { nativeElement?: HTMLElement } } } | undefined;
		return modalRefAny?._windowCmptRef?.location?.nativeElement ?? null;
	}

	private static isPointInClientRect(x: number, y: number, rect: DOMRect): boolean {
		return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
	}

	/** Empêche le scroll de la page ; sur la carte, laisse Leaflet gérer le zoom (sans stopPropagation). */
	private setupModalWheelTrap(): void {
		this.teardownModalWheelTrap();
		const modalWin = this.getModalWindowElement();
		if (!modalWin) {
			window.setTimeout(() => this.setupModalWheelTrap(), 50);
			return;
		}
		this.modalWindowWheelListenEl = modalWin;
		this.modalWindowWheelHandler = (event: Event) => {
			const wheelEvent = event as WheelEvent;
			const mapContainer = this.map?.getContainer();
			const mapRect = mapContainer?.getBoundingClientRect();
			const isOverMap =
				!!mapContainer &&
				(mapContainer.contains(wheelEvent.target as Node) ||
					(!!mapRect &&
						TraceViewerModalComponent.isPointInClientRect(
							wheelEvent.clientX,
							wheelEvent.clientY,
							mapRect
						)));
			wheelEvent.preventDefault();
			if (!isOverMap) {
				wheelEvent.stopPropagation();
			}
		};
		modalWin.addEventListener('wheel', this.modalWindowWheelHandler, { passive: false, capture: true });
	}

	private teardownModalWheelTrap(): void {
		if (this.modalWindowWheelHandler && this.modalWindowWheelListenEl) {
			try {
				this.modalWindowWheelListenEl.removeEventListener('wheel', this.modalWindowWheelHandler, {
					capture: true
				});
			} catch {
				/* ignore */
			}
		}
		this.modalWindowWheelHandler = undefined;
		this.modalWindowWheelListenEl = undefined;
	}

	/** Coalesces rapid repeated calls (globe overlay, ResizeObserver, legacy timeouts). */
	public refreshMapLayout(): void {
		if (!this.map) {
			return;
		}
		this.clearMapLayoutSyncDebouncer();
		this.mapLayoutSyncDebouncer = window.setTimeout(() => {
			this.mapLayoutSyncDebouncer = null;
			this.syncMapLayoutCore();
		}, 72);
	}

	private teardownMapLayoutObserver(): void {
		this.clearMapLayoutSyncDebouncer();
		this.mapLayoutResizeObserver?.disconnect();
		this.mapLayoutResizeObserver = undefined;
	}

	private setupMapLayoutObserver(observedEl: HTMLElement): void {
		this.teardownMapLayoutObserver();
		if (typeof ResizeObserver === 'undefined') {
			return;
		}
		this.mapLayoutResizeObserver = new ResizeObserver((entries) => {
			if (!this.map || !entries.length) {
				return;
			}
			const cr = entries[0].contentRect;
			const bw = Math.round(cr.width);
			const bh = Math.round(cr.height);
			if (bw < 2 || bh < 2) {
				return;
			}
			if (bw === this.mapResizeObservedDims.w && bh === this.mapResizeObservedDims.h) {
				return;
			}
			this.mapResizeObservedDims = { w: bw, h: bh };
			this.refreshMapLayout();
		});
		try {
			this.mapLayoutResizeObserver.observe(observedEl);
		} catch {
			/* ignore */
		}
	}

	private redrawActiveBaseLayerTiles(): void {
		if (!this.map || !this.activeBaseLayer) {
			return;
		}
		const walk = (ly: L.Layer): void => {
			if (ly instanceof L.TileLayer) {
				ly.redraw();
			} else if (ly instanceof L.LayerGroup) {
				ly.eachLayer((child) => walk(child));
			}
		};
		walk(this.activeBaseLayer);
	}

	public close(): void {
		this.stopFollowDeviceLocation();
		void this.releaseScreenWakeLock();
		if (this.document.fullscreenElement) {
			const exitResult = this.document.exitFullscreen();
			if (exitResult && typeof exitResult.then === 'function') {
				exitResult.finally(() => this.closeModalInstance());
			} else {
				this.closeModalInstance();
			}
			return;
		}
		this.closeModalInstance();
	}

	/** Open cartes.gouv.fr in an embed modal at the current map center and zoom. */
	public openCartesGouvEmbed(): void {
		let lng: number;
		let lat: number;
		let z: number;
		if (this.map) {
			const center = this.map.getCenter();
			lat = center.lat;
			lng = center.lng;
			z = this.map.getZoom();
		} else {
			lat = this.currentLat || 46.25;
			lng = this.currentLng || 2.2;
			z = this.currentZoom || 6;
		}
		this.updateCartesGouvEmbedUrl(lat, lng, z);
		this.cdr.detectChanges();
		const cartesOpts: NgbModalOptions = {
			size: 'xl',
			centered: true,
			backdrop: 'static',
			windowClass: 'cartes-gouv-embed-modal'
		};
		const mountEl = this.getCartesGouvModalMountElement();
		if (mountEl) {
			cartesOpts.container = mountEl;
		}
		this.cartesGouvModalRef = this.modalService.open(this.cartesGouvModal, cartesOpts);
		this.cartesGouvFullscreenChangeListener = () => this.onCartesGouvFullscreenChange();
		this.document.addEventListener('fullscreenchange', this.cartesGouvFullscreenChangeListener);
		this.cartesGouvModalRef.result.catch(() => {
			this.cartesGouvEmbedUrl = null;
			this.cleanupCartesGouvFullscreenListener();
			this.restoreBaseLayerAfterCartesGouvIfNeeded();
		});
	}

	/** Restore previous base layer only when the active layer was cartes-gouv from the picker (Ign button must not mutate the map alone). */
	private restoreBaseLayerAfterCartesGouvIfNeeded(): void {
		if (this.selectedBaseLayerId !== 'cartes-gouv') {
			return;
		}
		this.selectedBaseLayerId = this.lastBaseLayerBeforeCartesGouv;
		this.applySelectedBaseLayer();
	}

	/** Update cartes.gouv.fr iframe URL from center+zoom (open + “follow my location” recenters). */
	private updateCartesGouvEmbedUrl(lat: number, lng: number, z: number): void {
		const c = `${lng.toFixed(6)},${lat.toFixed(6)}`;
		const embedUrl = `https://cartes.gouv.fr/explorer-les-cartes/embed?c=${encodeURIComponent(c)}&z=${z}&l=GEOGRAPHICALGRIDSYSTEMS.MAPS$GEOPORTAIL:OGC:WMTS(1;1;1;0)&permalinkShare=yes`;
		this.cartesGouvEmbedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(embedUrl);
		this.cdr.markForCheck();
	}

	public closeCartesGouvEmbed(): void {
		if (this.document.fullscreenElement) {
			this.document.exitFullscreen().catch(() => {});
		}
		this.cartesGouvModalRef?.close();
		this.cartesGouvModalRef = undefined;
		this.cartesGouvEmbedUrl = null;
		this.cleanupCartesGouvFullscreenListener();
		this.restoreBaseLayerAfterCartesGouvIfNeeded();
		this.cdr.detectChanges();
	}

	private getCartesGouvModalContent(): HTMLElement | null {
		return this.document.querySelector('.cartes-gouv-embed-modal .modal-content') as HTMLElement | null;
	}

	public toggleCartesGouvFullscreen(): void {
		const el = this.getCartesGouvModalContent();
		if (!el) return;
		if (this.document.fullscreenElement) {
			this.document.exitFullscreen().then(() => this.onCartesGouvFullscreenChange()).catch(() => {});
			return;
		}
		el.classList.add('cartes-gouv-fullscreen-active');
		el.requestFullscreen().then(() => this.onCartesGouvFullscreenChange()).catch(() => {
			el.classList.remove('cartes-gouv-fullscreen-active');
		});
	}

	private onCartesGouvFullscreenChange(): void {
		this.cartesGouvFullscreen = !!this.document.fullscreenElement;
		const el = this.getCartesGouvModalContent();
		if (el) {
			if (this.cartesGouvFullscreen) {
				el.classList.add('cartes-gouv-fullscreen-active');
				el.style.setProperty('border', 'none', 'important');
				el.style.setProperty('border-radius', '0', 'important');
				el.style.setProperty('box-shadow', 'none', 'important');
				el.style.setProperty('outline', 'none', 'important');
			} else {
				el.classList.remove('cartes-gouv-fullscreen-active');
				el.style.removeProperty('border');
				el.style.removeProperty('border-radius');
				el.style.removeProperty('box-shadow');
				el.style.removeProperty('outline');
			}
		}
		this.cdr.detectChanges();
	}

	private cleanupCartesGouvFullscreenListener(): void {
		if (this.cartesGouvFullscreenChangeListener) {
			this.document.removeEventListener('fullscreenchange', this.cartesGouvFullscreenChangeListener);
			this.cartesGouvFullscreenChangeListener = undefined;
		}
		const el = this.getCartesGouvModalContent();
		if (el) el.classList.remove('cartes-gouv-fullscreen-active');
		this.cartesGouvFullscreen = false;
	}

	public toggleFullscreen(): void {
		if (this.document.fullscreenElement) {
			this.document.exitFullscreen().catch(() => { });
			return;
		}

		const wrapper = this.getFullscreenWrapper();
		if (wrapper && wrapper.requestFullscreen) {
			wrapper.requestFullscreen().then(() => {
				this.syncMapLayoutCore();
				this.tryRenderPendingTrack();
				this.tryRenderPendingPositions();
				this.tryRenderPendingLocation();
			}).catch(() => { });
		}
	}

	private open(source: TraceViewerSource): void {
		this.dismissTraceViewerModalIfOpen();
		this.resetState();
		const label = source.titleLabel != null && source.titleLabel.trim().length > 0 ? source.titleLabel.trim() : '';
		this.trackFileName = label.length > 0 ? label : source.fileName;
		this.initializeBaseLayers();
		if (source.initialBaseLayerId && this.baseLayers[source.initialBaseLayerId]) {
			this.selectedBaseLayerId = source.initialBaseLayerId;
		}
		const loc = source.location;
		this.pendingLocation =
			loc != null && isValidGeoCoordinate(loc.lat, loc.lng) ? loc : null;
		this.pendingPositions = source.positions ?? null;
		if (this.pendingLocation) {
			this.pendingTrackPoints = null;
			this.trackStats = null;
		}
		if (this.pendingPositions) {
			this.pendingTrackPoints = null;
			this.pendingLocation = null;
			this.trackStats = null;
		}

		const defaultModalOpts: NgbModalOptions = {
			size: 'xl',
			centered: true,
			backdrop: 'static',
			keyboard: true,
			// Pas de modal-smooth-animation : scale/translate sur .modal-dialog casse Leaflet (tuiles grises).
			windowClass: TraceViewerModalComponent.TRACE_VIEWER_MODAL_WINDOW_CLASS,
			modalDialogClass: 'modal-xl'
		};
		const modalOpts = this.nextModalOptionsOverride ?? defaultModalOpts;
		this.nextModalOptionsOverride = null;
		const hostOpt = modalOpts.container;
		this.mapEmbedHostRoot =
			typeof HTMLElement !== 'undefined' && hostOpt instanceof HTMLElement ? hostOpt : undefined;
		this.modalRef = this.modalService.open(this.traceViewerModal, modalOpts);
		this.hasEmittedClosed = false;

		const finalizeModal = () => {
			this.resetModalState();
		};

		this.modalRef.closed.pipe(take(1)).subscribe(() => finalizeModal());
		this.modalRef.dismissed.pipe(take(1)).subscribe(() => finalizeModal());
		this.subscribeToModalVisibility();
		this.scheduleEmbeddedModalMapKick();
		this.registerFullscreenListener();
		this.registerOrientationListener();
		this.registerVisibilityChangeListener();
		this.registerEscapeKeydownListener();

		// Apply event color after modal is rendered
		if (this.eventColor) {
			setTimeout(() => {
				this.applyEventColorToTraceViewer();
			}, 100);
		} else {
			this.resetTraceViewerColors();
		}

		if (source.blob) {
			this.readFromBlob(source.blob, source.fileName);
		} else if (source.fileId) {
			this.loadFromFileId(source.fileId, source.fileName);
		} else if (source.positions && source.positions.length > 0) {
			this.tryRenderPendingPositions();
		} else if (this.pendingLocation) {
			this.tryRenderPendingLocation();
		} else {
			this.setError(this.translate('EVENTELEM.TRACK_NO_SOURCE'));
		}
	}

	private subscribeToModalVisibility(): void {
		const modalRefAny = this.modalRef as any;

		const shown$ = modalRefAny?.shown;
		const hidden$ = modalRefAny?.hidden;

		if (shown$?.pipe) {
			shown$.pipe(take(1)).subscribe(() => {
				this.onModalShown();
			});
		} else {
			const tick = (): void => {
				this.setupModalWheelTrap();
				this.cdr.detectChanges();
				this.initMapLayersAfterModalMounted();
				if (this.map) {
					this.clearMapLayoutSyncDebouncer();
					this.syncMapLayoutCore();
				}
				this.refreshMapLayout();
			};
			queueMicrotask(() => tick());
			window.setTimeout(() => tick(), 400);
		}

		if (hidden$?.pipe) {
			hidden$?.pipe(take(1)).subscribe(() => {
				this.isFullscreen = false;
				this.destroyMap();
			});
		}
	}

	/** Create / refresh overlays once the Leaflet container exists (`shown.bs.modal`). */
	private initMapLayersAfterModalMounted(): void {
		this.initializeMap();
		this.ensureMapInitialization();
		this.tryRenderPendingTrack();
		this.tryRenderPendingPositions();
		this.tryRenderPendingLocation();
	}

	/**
	 * Globe embed can hit a race where `shown` emits before our `shown.subscribe` attaches (warm cache / faster 2nd open).
	 * Re-run the same bootstrap on microtasks / animation frames / short delays until the overlay has a sized container.
	 */
	private scheduleEmbeddedModalMapKick(): void {
		if (!this.mapEmbedHostRoot) {
			return;
		}
		const token = ++this.embeddedModalMapKickToken;
		const run = (): void => {
			if (!this.modalRef || !this.mapEmbedHostRoot || token !== this.embeddedModalMapKickToken) {
				return;
			}
			this.cdr.detectChanges();
			this.initMapLayersAfterModalMounted();
		};
		queueMicrotask(run);
		requestAnimationFrame(run);
		window.setTimeout(run, 0);
		window.setTimeout(run, 140);
		window.setTimeout(run, 420);
	}

	private forceCrosshairCursor(): void {
		if (this.map && this.map.getContainer()) {
			const mapContainer = this.map.getContainer();
			const redCrosshairCursor = 'url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><line x1="16" y1="0" x2="16" y2="12" stroke="red" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="20" x2="16" y2="32" stroke="red" stroke-width="2" stroke-linecap="round"/><line x1="0" y1="16" x2="12" y2="16" stroke="red" stroke-width="2" stroke-linecap="round"/><line x1="20" y1="16" x2="32" y2="16" stroke="red" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="16" r="2" fill="red"/></svg>\') 16 16, crosshair';
			mapContainer.style.cursor = redCrosshairCursor;
			mapContainer.classList.remove('leaflet-grab');

			const panes = mapContainer.querySelectorAll('.leaflet-pane, .leaflet-map-pane, .leaflet-tile-pane, .leaflet-overlay-pane');
			panes.forEach((pane: Element) => {
				(pane as HTMLElement).style.cursor = redCrosshairCursor;
			});
		}
	}

	/** markForCheck au tick suivant — évite NG0100 sur PhotoTimelineComponent (parent) en dev mode. */
	private scheduleTraceViewerCdr(): void {
		if (this.traceViewerCdrTimer != null) {
			clearTimeout(this.traceViewerCdrTimer);
		}
		this.traceViewerCdrTimer = window.setTimeout(() => {
			this.traceViewerCdrTimer = null;
			this.cdr.markForCheck();
		}, 0);
	}

	private onModalShown(): void {
		this.setupModalWheelTrap();
		this.cdr.detectChanges();
		this.initMapLayersAfterModalMounted();
		// Un seul `refreshMapLayout` au `map.whenReady` (évite 2× setView reset d’affilée).
		if (this.selectionMode) {
			setTimeout(() => {
				this.registerLocationSelection();
			}, 500);
		}

		if (this.eventColor) {
			setTimeout(() => {
				this.applyEventColorToTraceViewer();
			}, 150);
		}
	}

	/**
	 * Leaflet registers touchstart as { passive: false } on control bars via DomEvent.disableClickPropagation —
	 * only stopPropagation matters, not preventDefault, so passive: true removes the Chrome warning.
	 * We do not alter map drag/pinch ; molette = handler custom type slideshow (1 RAF / frame).
	 */
	private holdLeafletControlPassiveTouchPatch(container: HTMLElement): void {
		if (this.leafletMapPassivePatchContainer === container) {
			return;
		}
		if (this.leafletMapPassivePatchContainer) {
			this.releaseLeafletControlPassiveTouchPatch();
		}
		this.leafletMapPassivePatchContainer = container;
		TraceViewerModalComponent.registerLeafletPassiveTouchRoot(container);
	}

	private releaseLeafletControlPassiveTouchPatch(): void {
		const c = this.leafletMapPassivePatchContainer;
		if (!c) {
			return;
		}
		TraceViewerModalComponent.unregisterLeafletPassiveTouchRoot(c);
		this.leafletMapPassivePatchContainer = null;
	}

	private static registerLeafletPassiveTouchRoot(container: HTMLElement): void {
		const wasEmpty = TraceViewerModalComponent.leafletPassiveTouchRoots.size === 0;
		TraceViewerModalComponent.leafletPassiveTouchRoots.add(container);
		if (wasEmpty) {
			TraceViewerModalComponent.installLeafletControlPassiveTouchPatch();
		}
	}

	private static unregisterLeafletPassiveTouchRoot(container: HTMLElement): void {
		TraceViewerModalComponent.leafletPassiveTouchRoots.delete(container);
		if (TraceViewerModalComponent.leafletPassiveTouchRoots.size === 0) {
			TraceViewerModalComponent.uninstallLeafletControlPassiveTouchPatch();
		}
	}

	private static installLeafletControlPassiveTouchPatch(): void {
		const original = HTMLElement.prototype.addEventListener;
		TraceViewerModalComponent.leafletControlPassiveTouchOriginal = original;
		HTMLElement.prototype.addEventListener = function (
			type: string,
			listener: EventListenerOrEventListenerObject,
			options?: boolean | AddEventListenerOptions
		) {
			const el = this as HTMLElement;
			let usePassiveTouchOnControl = false;
			if (type === 'touchstart' && el.closest('.leaflet-control')) {
				for (const root of TraceViewerModalComponent.leafletPassiveTouchRoots) {
					if (root.contains(el)) {
						usePassiveTouchOnControl = true;
						break;
					}
				}
			}
			if (usePassiveTouchOnControl) {
				let opts: boolean | AddEventListenerOptions;
				if (typeof options === 'object' && options !== null) {
					opts = {
						passive: true,
						capture: !!options.capture,
						...(options.once !== undefined ? { once: options.once } : {}),
						...(options.signal !== undefined ? { signal: options.signal } : {})
					};
				} else if (options === true) {
					opts = { passive: true, capture: true };
				} else {
					opts = { passive: true, capture: false };
				}
				return original.call(this, type, listener, opts);
			}
			return original.call(this, type, listener, options as AddEventListenerOptions | boolean);
		};
	}

	private static uninstallLeafletControlPassiveTouchPatch(): void {
		if (TraceViewerModalComponent.leafletControlPassiveTouchOriginal) {
			HTMLElement.prototype.addEventListener = TraceViewerModalComponent.leafletControlPassiveTouchOriginal;
			TraceViewerModalComponent.leafletControlPassiveTouchOriginal = null;
		}
	}

	private initializeMap(): void {
		if (this.map) {
			return;
		}

		const container = this.resolveMapContainerElement();
		if (!container) {
			setTimeout(() => this.initializeMap(), 50);
			return;
		}

		// Check if container is visible before initializing
		// Leaflet needs the container to be visible to calculate size correctly
		const containerStyle = window.getComputedStyle(container);
		const isContainerVisible = containerStyle.display !== 'none' &&
			containerStyle.visibility !== 'hidden' &&
			container.offsetWidth > 0 &&
			container.offsetHeight > 0;

		if (!isContainerVisible) {
			this.mapInitVisibilityAttempts += 1;
			if (this.mapInitVisibilityAttempts < 100) {
				setTimeout(() => this.initializeMap(), 100);
				return;
			}
			/*
			 * After many retries the container may stay 0×0 (flex/embed); still create the map — ResizeObserver +
			 * invalidateSize will fix tiles once size is known.
			 */
		}
		this.mapInitVisibilityAttempts = 0;

		container.innerHTML = '';

		this.holdLeafletControlPassiveTouchPatch(container);
		try {
			// zoomSnap 0 = zoom fluide ; molette custom (slideshow), pas scrollWheelZoom Leaflet (clignote).
			this.map = L.map(container, {
				zoomControl: true,
				attributionControl: true,
				zoomDelta: 1,
				zoomSnap: 0,
				scrollWheelZoom: false
			});
		} catch (e) {
			this.releaseLeafletControlPassiveTouchPatch();
			throw e;
		}

		this.registerTraceMapWheelZoom();
		this.setupMapLayoutObserver((container.closest('.map-wrapper') ?? container) as HTMLElement);

		// Force crosshair cursor on map container
		this.forceCrosshairCursor();

		this.overlayLayer = L.layerGroup().addTo(this.map);
		this.applyInitialMapViewForPendingTrackData();
		this.applySelectedBaseLayer();
		this.registerRightClickZoom();

		// Maintain crosshair cursor even when Leaflet changes classes
		this.map.on('moveend', () => this.forceCrosshairCursor());
		this.map.on('zoomend', () => {
			this.forceCrosshairCursor();
			if (this.isSwisstopoBasemap(this.selectedBaseLayerId) && this.map) {
				const rounded = Math.round(this.map.getZoom());
				if (Math.abs(this.map.getZoom() - rounded) > 0.01) {
					this.snapSwisstopoTiles();
					return;
				}
			}
			this.currentZoom = this.map!.getZoom();
			this.scheduleTraceViewerCdr();
		});
		this.currentZoom = this.map.getZoom();
		this.scheduleTraceViewerCdr();

		this.map.whenReady(() => {
			this.isMapReady = true;
			this.scheduleTraceViewerCdr();
			/* Flex/embed layouts often omit a useful size on the first layout pass — retry pending renders below. */
			this.tryRenderPendingTrack();
			this.tryRenderPendingPositions();
			this.tryRenderPendingLocation();
			requestAnimationFrame(() => this.refreshMapLayout());
			// Register location selection if in selection mode
			if (this.selectionMode) {
				setTimeout(() => {
					this.registerLocationSelection();
				}, 300);
			}
			// Register map move handler (for when GPS coordinates are shown but mouse hasn't moved)
			this.registerMapMoveHandler();
			// Register GPS click handler (always active, but only updates if switch is enabled)
			this.registerMapMouseMoveHandler();
			// If GPS coordinates are already enabled, initialize with center
			if (this.showGpsCoordinates) {
				this.updateGpsCoordinatesFromCenter();
			}

			// Register click handler for marker creation (always active)
			this.registerMapClickHandler();

			// Register address click handler (always active, but only updates if switch is enabled)
			this.registerAddressClickHandler();

			if (this.followDeviceLocation) {
				this.startFollowDeviceLocation();
			}
		});
	}

	private normalizeTraceMapWheelDelta(event: WheelEvent): number {
		if (event.deltaMode === 0) {
			return event.deltaY / 80;
		}
		if (event.deltaMode === 1) {
			return event.deltaY / 2.5;
		}
		return event.deltaY / 0.45;
	}

	/** Pas dynamique (slideshow), appliqué sur le delta accumulé par frame. */
	private applyMapWheelZoomFromDelta(delta: number, current: number, minZoom: number, maxZoom: number): number {
		const baseStep = 1.15;
		const multiplier = 0.18;
		const dynamicStep = baseStep * (1 + current * multiplier);
		const minStep = 0.55;
		const maxStep = 5.5;
		const step = Math.max(minStep, Math.min(maxStep, dynamicStep));

		let next = current - delta * step;
		if (next < minZoom) {
			next = minZoom;
		}
		if (next > maxZoom) {
			next = maxZoom;
		}
		return parseFloat(next.toFixed(3));
	}

	private onTraceMapWheel(event: WheelEvent): void {
		if (!this.map) {
			return;
		}
		event.preventDefault();

		const container = this.map.getContainer();
		const rect = container.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			this.traceMapWheelPoint.x = event.clientX - rect.left;
			this.traceMapWheelPoint.y = event.clientY - rect.top;
		}

		this.traceMapWheelAccum += this.normalizeTraceMapWheelDelta(event);
		if (this.traceMapWheelRafId != null) {
			return;
		}
		this.traceMapWheelRafId = requestAnimationFrame(() => this.flushTraceMapWheelZoom());
	}

	private flushTraceMapWheelZoom(): void {
		this.traceMapWheelRafId = null;
		const delta = this.traceMapWheelAccum;
		this.traceMapWheelAccum = 0;
		if (!this.map || Math.abs(delta) < 0.0001) {
			return;
		}

		const minZoom = this.map.getMinZoom();
		const maxZoom = this.map.getMaxZoom();
		const oldZoom = this.map.getZoom();
		const newZoom = this.applyMapWheelZoomFromDelta(delta, oldZoom, minZoom, maxZoom);
		if (Math.abs(newZoom - oldZoom) < 0.0005) {
			return;
		}

		const { x, y } = this.traceMapWheelPoint;
		const container = this.map.getContainer();
		const rect = container.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			const latlng = this.map.containerPointToLatLng(L.point(x, y));
			this.map.setZoomAround(latlng, newZoom);
		} else {
			this.map.setZoom(newZoom);
		}
		this.currentZoom = newZoom;
		this.scheduleTraceViewerCdr();
	}

	private registerTraceMapWheelZoom(): void {
		if (!this.map || this.traceMapWheelHandler) {
			return;
		}
		const container = this.map.getContainer();
		this.traceMapWheelHandler = (e: WheelEvent) => this.onTraceMapWheel(e);
		container.addEventListener('wheel', this.traceMapWheelHandler, { passive: false });
	}

	private unregisterTraceMapWheelZoom(): void {
		if (this.traceMapWheelRafId != null) {
			cancelAnimationFrame(this.traceMapWheelRafId);
			this.traceMapWheelRafId = null;
		}
		this.traceMapWheelAccum = 0;
		if (this.traceMapWheelHandler && this.map) {
			try {
				this.map.getContainer().removeEventListener('wheel', this.traceMapWheelHandler);
			} catch {
				/* map container may already be gone */
			}
		}
		this.traceMapWheelHandler = undefined;
	}

	/** WMTS Swisstopo : zoom entier obligatoire (zoomSnap 0 → 14,8 ne charge pas les tuiles). */
	private snapSwisstopoTiles(): void {
		if (!this.map || !this.isSwisstopoBasemap(this.selectedBaseLayerId)) {
			return;
		}
		const c = this.map.getCenter();
		const zInt = Math.min(
			this.map.getMaxZoom(),
			Math.max(this.map.getMinZoom(), Math.round(this.map.getZoom()))
		);
		this.map.setView(c, zInt, { animate: false });
		this.currentZoom = zInt;
		this.scheduleTraceViewerCdr();
	}

	private ensureMapInitialization(): void {
		if (this.map) {
			return;
		}

		if (this.resolveMapContainerElement()) {
			this.initializeMap();
			return;
		}

		setTimeout(() => this.ensureMapInitialization(), 50);
	}

	private loadFromFileId(fileId: string, fileName: string): void {
		this.isLoading = true;
		this.cdr.detectChanges();

		this.fileService.getFile(fileId).pipe(takeUntil(this.destroy$)).subscribe({
			next: (buffer: ArrayBuffer) => {
				this.isLoading = false;
				const blob = new Blob([buffer]);
				this.readFromBlob(blob, fileName);
			},
			error: () => {
				this.isLoading = false;
				this.setError(this.translate('EVENTELEM.TRACK_LOAD_ERROR'));
			}
		});
	}

	private readFromBlob(blob: Blob, fileName: string): void {
		this.isLoading = true;
		this.cdr.detectChanges();

		blob.arrayBuffer()
			.then(buffer => {
				const extension = this.getFileExtension(fileName);
				const text = this.decodeArrayBuffer(buffer);
				this.renderTrack(text, extension);
			})
			.catch(() => this.setError(this.translate('EVENTELEM.TRACK_LOAD_ERROR')))
			.finally(() => {
				this.isLoading = false;
				this.cdr.detectChanges();
			});
	}

	private renderTrack(content: string, extension: string): void {
		const points = this.parseTrack(content, extension);

		if (!points.length) {
			this.setError(this.translate('EVENTELEM.TRACK_NO_POINTS'));
			return;
		}

		this.hasError = false;
		this.pendingTrackPoints = points;
		this.ensureMapInitialization();
		this.tryRenderPendingTrack();
	}

	/** Centrage trace (comme mars 2026) : fitBounds simple, sans reset de grille. */
	private fitMapToTrackBounds(bounds: L.LatLngBounds): void {
		if (!this.map || !bounds.isValid()) {
			return;
		}
		this.map.fitBounds(bounds, { padding: [24, 24] });
		this.currentZoom = this.map.getZoom();
	}

	private scheduleMapInvalidateAfterFit(): void {
		if (!this.map) {
			return;
		}
		this.map.invalidateSize();
		window.setTimeout(() => this.map?.invalidateSize(), 50);
		window.setTimeout(() => this.map?.invalidateSize(), 150);
	}

	/** Default France view when no track loaded yet. */
	private applyInitialMapViewForPendingTrackData(): void {
		if (!this.map) {
			return;
		}
		if (!this.pendingTrackPoints?.length && !this.trackBounds?.isValid()) {
			this.map.setView([46.2, 2.2], 6);
		}
	}

	private tryRenderPendingTrack(): void {
		if (!this.map || !this.overlayLayer || !this.pendingTrackPoints) {
			return;
		}

		const el = this.map.getContainer();
		if (el.offsetWidth < 2 || el.offsetHeight < 2) {
			return;
		}

		const points = this.pendingTrackPoints;
		this.pendingTrackPoints = null;

		this.overlayLayer.clearLayers();

		const polyline = L.polyline(points, {
			color: '#007bff',
			weight: 4,
			opacity: 0.9
		});

		polyline.addTo(this.overlayLayer);

		const startMarker = L.circleMarker(points[0], {
			radius: 6,
			color: '#28a745',
			fillColor: '#28a745',
			fillOpacity: 1
		}).bindTooltip(this.translate('EVENTELEM.TRACK_START'));

		const endMarker = L.circleMarker(points[points.length - 1], {
			radius: 6,
			color: '#dc3545',
			fillColor: '#dc3545',
			fillOpacity: 1
		}).bindTooltip(this.translate('EVENTELEM.TRACK_END'));

		startMarker.addTo(this.overlayLayer);
		endMarker.addTo(this.overlayLayer);

		const bounds = polyline.getBounds();
		this.trackBounds = bounds;
		this.fitMapToTrackBounds(bounds);
		this.scheduleMapInvalidateAfterFit();

		this.trackStats = {
			points: points.length,
			distanceKm: this.computeDistance(points)
		};
		this.cdr.detectChanges();
	}

	private tryRenderPendingPositions(): void {
		if (!this.map || !this.overlayLayer || !this.pendingPositions || this.pendingPositions.length === 0) {
			return;
		}

		const el = this.map.getContainer();
		if (el.offsetWidth < 2 || el.offsetHeight < 2) {
			return;
		}

		const positions = this.pendingPositions;
		this.pendingPositions = null;
		const overlayLayer = this.overlayLayer; // Store in local variable for TypeScript

		overlayLayer.clearLayers();

		// Convert positions to LatLngTuple array (for bounds calculation only)
		const points: L.LatLngTuple[] = positions.map(p => [p.lat, p.lng] as L.LatLngTuple);

		// Don't draw lines between points - just show individual markers
		// Removed polyline drawing to show only individual points

		// Find the most recent position by datetime
		let mostRecentIndex = -1;
		let mostRecentDateTime: Date | null = null;
		positions.forEach((pos, index) => {
			if (pos.datetime) {
				const posDate = new Date(pos.datetime);
				if (!mostRecentDateTime || posDate > mostRecentDateTime) {
					mostRecentDateTime = posDate;
					mostRecentIndex = index;
				}
			}
		});

		// Store the most recent position for share functionality
		const positionToStore = mostRecentIndex >= 0 ? positions[mostRecentIndex] : positions[positions.length - 1];
		this.lastRenderedPosition = { lat: positionToStore.lat, lng: positionToStore.lng };

		// Add markers for each position
		positions.forEach((pos, index) => {
			const isMostRecent = index === mostRecentIndex;

			// No popup content needed - address will be shown in overlay when clicking on markers

			if (isMostRecent) {
				// Most recent position: red marker icon (pin shape)
				const redMarkerIcon = L.divIcon({
					className: 'custom-red-marker-icon',
					html: `
					<div style="width: 25px; height: 41px; position: relative;">
						<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg" style="display: block;">
							<path d="M12.5 0C5.596 0 0 5.596 0 12.5c0 12.5 12.5 28.5 12.5 28.5s12.5-16 12.5-28.5C25 5.596 19.404 0 12.5 0z" fill="#dc3545" stroke="#ffffff" stroke-width="1"/>
							<circle cx="12.5" cy="12.5" r="5" fill="#ffffff"/>
						</svg>
					</div>
				`,
					iconSize: [25, 41],
					iconAnchor: [12.5, 41],
					popupAnchor: [0, -41]
				});

				const redMarker = L.marker([pos.lat, pos.lng], {
					icon: redMarkerIcon,
					zIndexOffset: 1000,
					riseOnHover: true
				});

				// Update switches on click - no popup needed
				redMarker.on('click', (e: L.LeafletMouseEvent) => {
					e.originalEvent?.stopPropagation();
					L.DomEvent.stopPropagation(e);
					if (e.originalEvent) {
						L.DomEvent.preventDefault(e.originalEvent);
					}
					// Update all switches independently
					this.updateSwitchesForPoint(pos.lat, pos.lng);
				});

				redMarker.addTo(overlayLayer);
			} else {
				// Other positions: use position icon (pin shape) with different colors for GPS vs IP
				const isGps = pos.type === 'GPS';
				const markerColor = isGps ? '#28a745' : '#ffc107'; // Green for GPS, yellow for IP

				// Create position icon (pin shape) instead of circle
				const positionIcon = L.divIcon({
					className: 'custom-position-marker-icon',
					html: `
					<div style="width: 25px; height: 41px; position: relative;">
						<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg" style="display: block;">
							<path d="M12.5 0C5.596 0 0 5.596 0 12.5c0 12.5 12.5 28.5 12.5 28.5s12.5-16 12.5-28.5C25 5.596 19.404 0 12.5 0z" fill="${markerColor}" stroke="#ffffff" stroke-width="1"/>
							<circle cx="12.5" cy="12.5" r="5" fill="#ffffff"/>
						</svg>
					</div>
				`,
					iconSize: [25, 41],
					iconAnchor: [12.5, 41],
					popupAnchor: [0, -41]
				});

				const positionMarker = L.marker([pos.lat, pos.lng], {
					icon: positionIcon,
					zIndexOffset: 500,
					riseOnHover: true
				});

				// Update switches on click - no popup needed
				positionMarker.on('click', (e: L.LeafletMouseEvent) => {
					e.originalEvent?.stopPropagation();
					L.DomEvent.stopPropagation(e);
					if (e.originalEvent) {
						L.DomEvent.preventDefault(e.originalEvent);
					}
					// Update all switches independently
					this.updateSwitchesForPoint(pos.lat, pos.lng);
				});

				positionMarker.addTo(overlayLayer);
			}
		});

		// Fit map to show all positions
		if (points.length > 0) {
			const bounds = L.latLngBounds(points);
			this.trackBounds = bounds;
			this.fitMapToTrackBounds(bounds);
			this.scheduleMapInvalidateAfterFit();
		}

		// Calculate statistics
		this.trackStats = {
			points: positions.length,
			distanceKm: points.length > 1 ? this.computeDistance(points) : null
		};

		this.cdr.detectChanges();
	}

	private tryRenderPendingLocation(): void {
		if (!this.map || !this.overlayLayer || !this.pendingLocation) {
			return;
		}

		const el = this.map.getContainer();
		if (el.offsetWidth < 2 || el.offsetHeight < 2) {
			return;
		}

		const { lat, lng, label } = this.pendingLocation;
		if (!isValidGeoCoordinate(lat, lng)) {
			this.pendingLocation = null;
			return;
		}
		const rawZ = this.pendingLocation.zoom;
		const viewZoom =
			rawZ != null && !Number.isNaN(rawZ) ? Math.min(19, Math.max(2, Math.round(rawZ))) : 14;

		// Store the location for share functionality
		this.lastRenderedPosition = { lat, lng };

		// In selection mode, don't create the standard marker (will be created by registerLocationSelection)
		// and keep pendingLocation so registerLocationSelection can use it
		if (this.selectionMode) {
			this.trackBounds = L.latLngBounds([lat, lng], [lat, lng]);
			this.map.setView([lat, lng], viewZoom);
			this.refreshMapLayout();
			return;
		}

		// Normal mode: create standard marker
		this.pendingLocation = null;

		this.overlayLayer.clearLayers();

		const marker = L.marker([lat, lng]);
		if (label && label.trim().length > 0) {
			marker.on('click', (e: L.LeafletMouseEvent) => {
				e.originalEvent?.stopPropagation();
				L.DomEvent.stopPropagation(e);
				if (e.originalEvent) {
					L.DomEvent.preventDefault(e.originalEvent);
				}
				this.updateSwitchesForPoint(lat, lng);
			});
		}
		marker.addTo(this.overlayLayer);

		this.trackBounds = L.latLngBounds([lat, lng], [lat, lng]);
		this.map.setView([lat, lng], viewZoom, { animate: false });
		this.currentZoom = viewZoom;

		if (this.showAddress) {
			this.showAddressInOverlay(lat, lng);
		}

		if (label && label.trim().length > 0) {
			setTimeout(() => {
				try {
					marker.openPopup();
				} catch {
					// Ignore popup errors
				}
			}, 150);
		}

		this.trackStats = null;
		this.cdr.detectChanges();
	}

	private parseTrack(content: string, extension: string): L.LatLngTuple[] {
		switch (extension) {
			case 'gpx':
				return this.parseGpx(content);
			case 'kml':
				return this.parseKml(content);
			case 'tcx':
				return this.parseTcx(content);
			case 'geojson':
			case 'json':
				return this.parseGeoJson(content);
			default: {
				const gpxPoints = this.parseGpx(content);
				if (gpxPoints.length) {
					return gpxPoints;
				}
				const geoJsonPoints = this.parseGeoJson(content);
				if (geoJsonPoints.length) {
					return geoJsonPoints;
				}
				return [];
			}
		}
	}

	private parseGpx(content: string): L.LatLngTuple[] {
		try {
			const parser = new DOMParser();
			const xml = parser.parseFromString(content, 'application/xml');
			const pointNodes: Element[] = [
				...this.getElementsByTagNameFlexible(xml, 'trkpt'),
				...this.getElementsByTagNameFlexible(xml, 'rtept'),
				...this.getElementsByTagNameFlexible(xml, 'wpt')
			];

			return pointNodes
				.map(node => this.extractLatLngFromAttributes(node))
				.filter((value): value is L.LatLngTuple => !!value);
		} catch (error) {
			console.error('[TraceViewer] GPX parsing error', error);
			return [];
		}
	}

	private parseKml(content: string): L.LatLngTuple[] {
		try {
			const parser = new DOMParser();
			const xml = parser.parseFromString(content, 'application/xml');
			const coordinatesNodes = this.getElementsByTagNameFlexible(xml, 'coordinates');
			const points: L.LatLngTuple[] = [];

			coordinatesNodes.forEach(node => {
				const text = (node.textContent || '').trim();
				const parts = text.split(/\s+/);
				parts.forEach(part => {
					const [lonStr, latStr] = part.split(',');
					const lat = parseFloat(latStr);
					const lon = parseFloat(lonStr);
					if (Number.isFinite(lat) && Number.isFinite(lon)) {
						points.push([lat, lon]);
					}
				});
			});

			return points;
		} catch (error) {
			console.error('[TraceViewer] KML parsing error', error);
			return [];
		}
	}

	private parseTcx(content: string): L.LatLngTuple[] {
		try {
			const parser = new DOMParser();
			const xml = parser.parseFromString(content, 'application/xml');
			const trackpointNodes = this.getElementsByTagNameFlexible(xml, 'Trackpoint');
			const points: L.LatLngTuple[] = [];

			trackpointNodes.forEach(node => {
				const latEl = this.getElementsByTagNameFlexible(node, 'LatitudeDegrees')[0];
				const lonEl = this.getElementsByTagNameFlexible(node, 'LongitudeDegrees')[0];

				if (latEl && lonEl) {
					const lat = parseFloat((latEl.textContent || '').trim());
					const lon = parseFloat((lonEl.textContent || '').trim());
					if (Number.isFinite(lat) && Number.isFinite(lon)) {
						points.push([lat, lon]);
					}
				}
			});

			return points;
		} catch (error) {
			console.error('[TraceViewer] TCX parsing error', error);
			return [];
		}
	}

	private parseGeoJson(content: string): L.LatLngTuple[] {
		try {
			const geoJson = JSON.parse(content);
			const points: L.LatLngTuple[] = [];

			const processGeometry = (geometry: any): void => {
				if (!geometry) {
					return;
				}
				switch (geometry.type) {
					case 'FeatureCollection':
						geometry.features?.forEach((feature: any) => processGeometry(feature.geometry));
						break;
					case 'Feature':
						processGeometry(geometry.geometry);
						break;
					case 'LineString':
						geometry.coordinates?.forEach((coord: number[]) => {
							if (Array.isArray(coord) && coord.length >= 2) {
								points.push([coord[1], coord[0]]);
							}
						});
						break;
					case 'MultiLineString':
						geometry.coordinates?.forEach((line: number[][]) => processGeometry({ type: 'LineString', coordinates: line }));
						break;
					case 'Polygon':
						geometry.coordinates?.forEach((ring: number[][]) => processGeometry({ type: 'LineString', coordinates: ring }));
						break;
					case 'MultiPolygon':
						geometry.coordinates?.forEach((polygon: number[][][]) => processGeometry({ type: 'Polygon', coordinates: polygon }));
						break;
					default:
						break;
				}
			};

			processGeometry(geoJson);
			return points;
		} catch (error) {
			console.error('[TraceViewer] GeoJSON parsing error', error);
			return [];
		}
	}

	private computeDistance(points: L.LatLngTuple[]): number | null {
		if (points.length < 2) {
			return null;
		}

		let distanceMeters = 0;
		for (let i = 1; i < points.length; i++) {
			const prev = L.latLng(points[i - 1]);
			const current = L.latLng(points[i]);
			distanceMeters += prev.distanceTo(current);
		}

		return Math.round((distanceMeters / 1000) * 100) / 100;
	}

	private dismissTraceViewerModalIfOpen(): void {
		const ref = this.modalRef;
		if (!ref) {
			return;
		}
		try {
			ref.dismiss('reopen');
		} catch {
			try {
				ref.close('reopen');
			} catch {
				/* ignore */
			}
		}
		this.modalRef = undefined;
	}

	private resetState(): void {
		this.trackBounds = null;
		this.hasError = false;
		this.errorMessage = '';
		this.isLoading = false;
		this.trackStats = null;
		this.pendingTrackPoints = null;
		this.pendingLocation = null;
		this.pendingPositions = null;
		this.lastRenderedPosition = null;
		this.selectionMode = false;
		this.simpleShareMode = false;
		this.showGpsCoordinates = false;
		this.currentLat = 0;
		this.currentLng = 0;
		this.currentAlt = null;
		this.clickedAddress = '';
		this.clickedLat = 0;
		this.clickedLng = 0;
		this.clickedAlt = null;
		this.showAddress = false;
		this.showHikingTrailsOverlay = false;
		this.showCyclingTrailsOverlay = false;
		this.stopFollowDeviceLocation();
		this.followDeviceLocation = this.isMobileViewport();
		this.keepScreenAwake = false;
		void this.releaseScreenWakeLock();
		this.cleanupMapMoveHandler();
		this.cleanupMapMouseMoveHandler();
		this.cleanupAddressClickHandler();
		this.cleanupMapClickHandler();
		this.destroyMap();
		this.cdr.detectChanges();
	}

	private destroyMap(): void {
		this.teardownMapLayoutObserver();
		this.mapInitVisibilityAttempts = 0;
		this.mapResizeObservedDims = { w: -1, h: -1 };
		this.mapContainerHadLayout = false;
		this.isMapReady = false;
		this.trackBounds = null;
		this.teardownModalWheelTrap();
		this.unregisterTraceMapWheelZoom();
		if (this.map) {
			this.cleanupRightClickZoom();
			this.cleanupLocationSelection();
			this.cleanupMapMoveHandler();
			this.cleanupMapMouseMoveHandler();
			this.map.remove();
			this.map = undefined;
		}
		this.releaseLeafletControlPassiveTouchPatch();
		this.overlayLayer = undefined;
		this.hikingTrailsOverlay = undefined;
		this.cyclingTrailsOverlay = undefined;
		this.removeDeviceLocationMarker();
		this.pendingTrackPoints = null;
		this.pendingLocation = null;
		this.selectionMarker = undefined;
		this.clickMarker = undefined;
		this.locationSelectionClickHandler = undefined;
	}

	private translate(key: string, params?: Record<string, any>): string {
		return this.translateService.instant(key, params);
	}

	private setError(message: string): void {
		this.hasError = true;
		this.errorMessage = message;
		this.trackStats = null;
		this.cdr.detectChanges();
	}

	private getFileExtension(fileName: string): string {
		const parts = (fileName || '').split('.');
		return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
	}

	private decodeArrayBuffer(buffer: ArrayBuffer): string {
		const decoder = new TextDecoder('utf-8');
		return decoder.decode(buffer);
	}

	private configureLeafletIcons(): void {
		if (TraceViewerModalComponent.leafletIconsConfigured) {
			return;
		}

		delete (L.Icon.Default.prototype as any)._getIconUrl;
		L.Icon.Default.mergeOptions({
			iconRetinaUrl: 'assets/leaflet/images/marker-icon-2x.png',
			iconUrl: 'assets/leaflet/images/marker-icon.png',
			shadowUrl: 'assets/leaflet/images/marker-shadow.png'
		});

		TraceViewerModalComponent.leafletIconsConfigured = true;
	}

	private getElementsByTagNameFlexible(element: Element | Document, tagName: string): Element[] {
		const seen = new Set<Element>();
		const results: Element[] = [];
		const appendUnique = (col: HTMLCollectionOf<Element>) => {
			for (let i = 0; i < col.length; i++) {
				const el = col.item(i)!;
				if (!seen.has(el)) {
					seen.add(el);
					results.push(el);
				}
			}
		};
		// XML tags are often lowercase; exact/upper/lower lookups can return the same live list twice → dedupe by node.
		appendUnique(element.getElementsByTagName(tagName));
		appendUnique(element.getElementsByTagName(tagName.toUpperCase()));
		appendUnique(element.getElementsByTagName(tagName.toLowerCase()));
		return results;
	}

	private extractLatLngFromAttributes(node: Element): L.LatLngTuple | null {
		if (!node) return null;
		const lat = parseFloat(node.getAttribute('lat') || node.getAttribute('latitude') || '');
		const lon = parseFloat(node.getAttribute('lon') || node.getAttribute('lng') || node.getAttribute('longitude') || '');

		if (Number.isFinite(lat) && Number.isFinite(lon)) {
			return [lat, lon];
		}

		const childLat = this.getElementsByTagNameFlexible(node, 'lat')[0] || this.getElementsByTagNameFlexible(node, 'latitude')[0];
		const childLon = this.getElementsByTagNameFlexible(node, 'lon')[0] || this.getElementsByTagNameFlexible(node, 'lng')[0] || this.getElementsByTagNameFlexible(node, 'longitude')[0];

		if (childLat && childLon) {
			const latChild = parseFloat((childLat.textContent || '').trim());
			const lonChild = parseFloat((childLon.textContent || '').trim());
			if (Number.isFinite(latChild) && Number.isFinite(lonChild)) {
				return [latChild, lonChild];
			}
		}

		return null;
	}

	private registerFullscreenListener(): void {
		if (this.fullscreenChangeHandler) {
			return;
		}

		this.fullscreenChangeHandler = () => {
			const isActive = !!this.document.fullscreenElement;
			this.isFullscreen = isActive;
			if (isActive) {
				this.isFullscreenOptionsExpanded = false;
			} else {
				this.isFullscreenInfoVisible = false;
				this.isFullscreenOptionsExpanded = false;
			}
			this.cdr.detectChanges();
			setTimeout(() => {
				this.syncMapLayoutCore();
				this.tryRenderPendingTrack();
				this.tryRenderPendingPositions();
				this.tryRenderPendingLocation();
			}, 0);
		};

		this.document.addEventListener('fullscreenchange', this.fullscreenChangeHandler);
	}

	private cleanupFullscreenListener(): void {
		if (this.fullscreenChangeHandler) {
			this.document.removeEventListener('fullscreenchange', this.fullscreenChangeHandler);
			this.fullscreenChangeHandler = undefined;
		}
	}

	public isMobileViewport(): boolean {
		return this.document.defaultView != null && (
			this.document.defaultView.innerHeight <= 500 ||
			this.document.defaultView.innerWidth <= 768
		);
	}

	public get screenWakeLockAvailable(): boolean {
		return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
	}

	/** Active/désactive le verrouillage d'écran (empêche la mise en veille du smartphone). */
	public onKeepScreenAwakeChange(): void {
		if (this.keepScreenAwake) {
			void this.acquireScreenWakeLock();
		} else {
			void this.releaseScreenWakeLock();
		}
	}

	private async acquireScreenWakeLock(): Promise<void> {
		if (!this.screenWakeLockAvailable || !this.keepScreenAwake || this.document.visibilityState !== 'visible') {
			return;
		}
		if (this.screenWakeLock && !this.screenWakeLock.released) {
			return;
		}
		try {
			this.screenWakeLock = await navigator.wakeLock.request('screen');
			this.screenWakeLockReleaseHandler = () => {
				this.screenWakeLock = null;
				if (this.keepScreenAwake && this.document.visibilityState === 'visible') {
					void this.acquireScreenWakeLock();
				}
				this.cdr.markForCheck();
			};
			this.screenWakeLock.addEventListener('release', this.screenWakeLockReleaseHandler);
		} catch {
			this.keepScreenAwake = false;
			this.cdr.markForCheck();
		}
	}

	private async releaseScreenWakeLock(): Promise<void> {
		if (!this.screenWakeLock) {
			return;
		}
		if (this.screenWakeLockReleaseHandler) {
			this.screenWakeLock.removeEventListener('release', this.screenWakeLockReleaseHandler);
			this.screenWakeLockReleaseHandler = undefined;
		}
		if (!this.screenWakeLock.released) {
			try {
				await this.screenWakeLock.release();
			} catch {
				// ignore
			}
		}
		this.screenWakeLock = null;
	}

	private registerVisibilityChangeListener(): void {
		this.cleanupVisibilityChangeListener();
		this.visibilityChangeHandler = () => {
			if (this.document.visibilityState === 'visible' && this.keepScreenAwake) {
				void this.acquireScreenWakeLock();
			}
		};
		this.document.addEventListener('visibilitychange', this.visibilityChangeHandler);
	}

	private cleanupVisibilityChangeListener(): void {
		if (this.visibilityChangeHandler) {
			this.document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
			this.visibilityChangeHandler = undefined;
		}
	}

	private registerOrientationListener(): void {
		if (!this.document.defaultView) {
			return;
		}
		this.cleanupOrientationListener();
		const landscape = this.document.defaultView.matchMedia('(orientation: landscape)');
		this.orientationMediaQuery = landscape;
		this.orientationChangeHandler = () => {
			if (!landscape.matches || !this.modalRef || this.document.fullscreenElement) {
				return;
			}
			if (this.isMobileViewport()) {
				this.toggleFullscreen();
			}
		};
		landscape.addEventListener('change', this.orientationChangeHandler);
	}

	private cleanupOrientationListener(): void {
		if (this.orientationMediaQuery && this.orientationChangeHandler) {
			this.orientationMediaQuery.removeEventListener('change', this.orientationChangeHandler);
			this.orientationMediaQuery = null;
			this.orientationChangeHandler = undefined;
		}
	}

	/**
	 * Resolves the live `.map-container` element. Globe embed clears `#globeTraceMount` with `innerHTML` on close;
	 * `ViewChild` can keep a stale detached node — always query the embed subtree when mounted in the globe shell.
	 */
	private resolveMapContainerElement(): HTMLDivElement | null {
		if (this.mapEmbedHostRoot) {
			return this.findMapContainerElement();
		}
		const refEl = this.mapContainerRef?.nativeElement;
		if (refEl?.isConnected) {
			return refEl;
		}
		return this.findMapContainerElement();
	}

	private findMapContainerElement(): HTMLDivElement | null {
		const root = this.mapEmbedHostRoot;
		if (root) {
			const scoped =
				(root.querySelector('.modal-body.slideshow-body .trace-viewer-body .map-wrapper .map-container') as
					HTMLDivElement | null) ??
				(root.querySelector('.modal-body .trace-viewer-body .map-container') as HTMLDivElement | null) ??
				(root.querySelector('.trace-viewer-body .map-container') as HTMLDivElement | null) ??
				(root.querySelector('.map-wrapper .map-container') as HTMLDivElement | null) ??
				(root.querySelector('.map-container') as HTMLDivElement | null);
			if (scoped) {
				return scoped;
			}
			// Fenêtre peut ne pas être encore sous le mont : éviter getElementById global (multiplié sur plusieurs routes).
			return null;
		}

		let element = this.document.getElementById('trace-viewer-map-container') as HTMLDivElement | null;
		if (!element) {
			const dialog = this.document.querySelector('.trace-viewer-dialog .map-container') as HTMLDivElement | null;
			element = dialog ?? null;
		}

		return element ?? null;
	}

	private getFullscreenWrapper(): HTMLElement | null {
		const container = this.resolveMapContainerElement();
		return container?.closest('.map-wrapper') ?? container?.parentElement ?? null;
	}

	/**
	 * En plein écran navigateur sur la carte, seul le sous-arbre de l’élément fullscreen est visible :
	 * une modale ouverte sur `body` reste derrière. On attache alors l’embed IGN au conteneur fullscreen.
	 */
	private getCartesGouvModalMountElement(): HTMLElement | undefined {
		const fs = this.document.fullscreenElement as HTMLElement | null;
		if (!fs) {
			return undefined;
		}
		const mapEl = this.resolveMapContainerElement();
		if (mapEl && fs.contains(mapEl)) {
			return fs;
		}
		return undefined;
	}

	private initializeBaseLayers(): void {
		if (Object.keys(this.baseLayers).length > 0) {
			return;
		}

		// Create base layers first (without OpenCycleMap)
		this.createBaseLayers();

		// Fetch IGN API key: si configurée, on ajoute SCAN 25® (vraie carte IGN topo avec GR) par-dessus Plan IGN pour zoom 13+
				this.apiService.getIgnApiKey().pipe(
					takeUntil(this.destroy$)
				).subscribe({
					next: (apiKey: string) => {
						if (!apiKey || apiKey.trim().length === 0) {
							return;
						}
						const ignClassicGroup = this.baseLayers['ign-classic'];
						if (!ignClassicGroup || !(ignClassicGroup instanceof L.LayerGroup)) {
							return;
						}
						// SCAN 25® Touristique = vraie carte IGN topographique avec GR (magenta), contours, relief.
						// apikey en premier, SERVICE/VERSION une seule fois (exigence Géoportail).
						const scan25Tour = L.tileLayer(
							'https://data.geopf.fr/private/wmts?apikey=' + encodeURIComponent(apiKey) +
							'&REQUEST=GetTile&SERVICE=WMTS&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.MAPS.SCAN25TOUR&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
							{
								minZoom: 13,
								maxZoom: 19,
								attribution: '&copy; IGN - Géoportail',
								zIndex: 3
							}
						);
						ignClassicGroup.addLayer(scan25Tour);
					},
					error: (err) => {
						console.warn('Could not fetch IGN API key:', err);
					}
				});

		// Fetch Thunderforest API key from backend and add OpenCycleMap when available
		this.apiService.getThunderforestApiKey().pipe(
			takeUntil(this.destroy$)
		).subscribe({
			next: (apiKey: string) => {
				if (apiKey && apiKey.trim().length > 0) {
					this.thunderforestApiKey = apiKey;
					// Add OpenCycleMap layer (vélo / rando)
					this.baseLayers['opencyclemap'] = L.tileLayer('https://{s}.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=' + this.thunderforestApiKey, {
						maxZoom: 18,
						subdomains: ['a', 'b', 'c'],
						attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://www.thunderforest.com">Thunderforest</a>'
					});
					// Add Thunderforest Outdoors (carte rando : sentiers, relief, SAC)
					this.baseLayers['thunderforest-outdoors'] = L.tileLayer('https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=' + this.thunderforestApiKey, {
						maxZoom: 18,
						subdomains: ['a', 'b', 'c'],
						attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://www.thunderforest.com">Thunderforest</a>'
					});
					// Add to available layers list and sort alphabetically
					const openCycleMapEntry = { id: 'opencyclemap', label: 'OpenCycleMap' };
					this.availableBaseLayers.push(openCycleMapEntry);
					this.availableBaseLayers.push({ id: 'thunderforest-outdoors', label: 'TF Outdoors' });
					this.availableBaseLayers.sort((a, b) => a.label.localeCompare(b.label));
				}
			},
			error: (error) => {
				console.warn('Could not fetch Thunderforest API key:', error);
			}
		});
	}

	// Removed updateIgnLayersWithApiKey() - IGN open data layers don't require API key

	private createBaseLayers(): void {
		this.baseLayers = {
			'osm-standard': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
				maxZoom: 19,
				attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
			}),
			'osm-fr': (() => {
				// Create a layer group with OSM standard as base and OSM France on top
				// This ensures no missing tiles - if OSM France fails, OSM standard shows
				const osmStandardBase = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
					maxZoom: 20,
					attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
					opacity: 0.7, // Slightly transparent so OSM France shows through
					zIndex: 1
				});
				const osmFrance = L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
					maxZoom: 20,
					minZoom: 0,
					subdomains: ['a', 'b', 'c'],
					attribution: '&copy; OpenStreetMap France & OSM contributors',
					tileSize: 256,
					zIndex: 2
				});
				// Return a layer group that combines both
				return L.layerGroup([osmStandardBase, osmFrance]) as any;
			})(),
			'esri-imagery': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
				maxZoom: 19,
				attribution: 'Tiles &copy; Esri'
			}),
			// 'esri-topo': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
			// 	maxZoom: 19,
			// 	attribution: 'Tiles &copy; Esri'
			// }),
			// 'esri-street': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
			// 	maxZoom: 19,
			// 	attribution: 'Tiles &copy; Esri'
			// }),
			'opentopomap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
				maxZoom: 17,
				subdomains: 'abc',
				attribution: 'Map data: &copy; OSM contributors, SRTM'
			}),
			// 'esri-light-gray': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
			// 	maxZoom: 16,
			// 	attribution: 'Tiles &copy; Esri'
			// }),
			'ign-plan': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
				maxZoom: 19,
				attribution: '&copy; IGN - Géoportail'
			}),
			'ign-classic': (() => {
				// Zoom 0 à 12 : SCAN-REGIONAL (IGN ne sert pas le zoom 13 → 404). Zoom 12+ : Plan IGN, zoom 13+ : SCAN 25® si clé API.
				const scanRegional = L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=IGNF_CARTES_SCAN-REGIONAL&STYLE=SCANREG&FORMAT=image/jpeg&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
					minZoom: 0,
					maxZoom: 12,
					attribution: '&copy; IGN - Géoportail',
					zIndex: 1
				});
				const planIgn = L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
					minZoom: 12,
					maxZoom: 19,
					attribution: '&copy; IGN - Géoportail',
					zIndex: 2
				});
				return L.layerGroup([scanRegional, planIgn]) as any;
			})(),
			'ign-ortho': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
				maxZoom: 19,
				attribution: '&copy; IGN - Géoportail'
			}),
			'ign-cadastre': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=CADASTRALPARCELS.PARCELLAIRE_EXPRESS&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
				maxZoom: 19,
				attribution: '&copy; IGN - Géoportail'
			}),
			'ign-limites': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=LIMITES_ADMINISTRATIVES_EXPRESS.LATEST&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
				maxZoom: 19,
				attribution: '&copy; IGN - Géoportail'
			}),
			// IGN Cartes (Scan Express) commented out - layer name may be incorrect or deprecated
			// The layer GEOGRAPHICALGRIDSYSTEMS.MAPS.SCAN-EXPRESS.STANDARD doesn't seem to be available
			// 'ign-cartes': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=GEOGRAPHICALGRIDSYSTEMS.MAPS.BDUNI.J1.SCAN-EXPRESS.STANDARD&STYLE=normal&FORMAT=image/jpeg&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
			// 	maxZoom: 19,
			// 	attribution: '&copy; IGN - Géoportail'
			// }),
			// SCAN 25® commented out - layer name may be incorrect or requires personal API key
			// SCAN 25/100/OACI data requires a personal key obtained through registration on IGN website
			// The layer name GEOGRAPHICALGRIDSYSTEMS.MAPS.SCAN25TOUR returns 400 Bad Request
			// 'ign-scan-express': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=GEOGRAPHICALGRIDSYSTEMS.MAPS.BDUNI.J1.SCAN25TOUR&STYLE=normal&FORMAT=image/jpeg&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
			// 	maxZoom: 19,
			// 	attribution: '&copy; IGN - Géoportail'
			// }),
			'ign-relief': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
				maxZoom: 19,
				attribution: '&copy; IGN - Géoportail'
			}),
			'ign-routes': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=TRANSPORTNETWORKS.ROADS&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
				maxZoom: 19,
				attribution: '&copy; IGN - Géoportail'
			}),
			'ign-topo': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
				maxZoom: 19,
				attribution: '&copy; IGN - Géoportail'
			}),
			// IGN BD Topo commented out - not available as simple WMTS tile layer
			// 'ign-bd-topo': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=GEOGRAPHICALGRIDSYSTEMS.MAPS.BDUNI.J1&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
			// 	maxZoom: 19,
			// 	attribution: '&copy; IGN - Géoportail'
			// }),
			// CyclOSM : carte vélo / rando (hébergée par OSM France)
			'cyclosm': L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
				maxZoom: 18,
				subdomains: 'abc',
				attribution: '&copy; <a href="https://www.cyclosm.org">CyclOSM</a> | &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
			}),
			// Suisse — WMTS Web Mercator (EPSG:3857), voir https://wmts.geo.admin.ch/
			'swisstopo-pixelkarte': L.layerGroup(),
			'swisstopo-swissimage': L.layerGroup()
		};

		this.availableBaseLayers = [
			{ id: 'osm-standard', label: 'OpenStreetMap' },
			{ id: 'osm-fr', label: 'OSM France' },
			{ id: 'esri-imagery', label: 'Esri Satellite' },
			{ id: 'opentopomap', label: 'OpenTopoMap' },
			{ id: 'cartes-gouv', label: 'cartes.gouv.fr', labelKey: 'EVENTELEM.CARTES_GOUV_FR' },
			{ id: 'ign-classic', label: 'IGN Classique' },
			{ id: 'ign-plan', label: 'IGN Plan' },
			{ id: 'ign-ortho', label: 'IGN Ortho' },
			{ id: 'ign-cadastre', label: 'IGN Cadastre' },
			{ id: 'ign-topo', label: 'IGN Topo' },
			{ id: 'cyclosm', label: 'CyclOSM' },
			{ id: 'swisstopo-pixelkarte', label: 'Swiss Topo', labelKey: 'EVENTELEM.SWISSSTOPO_PIXELKARTE' },
			{ id: 'swisstopo-swissimage', label: 'SWISSIMAGE', labelKey: 'EVENTELEM.SWISSSTOPO_SWISSIMAGE' }
		].sort((a, b) => a.label.localeCompare(b.label));

		this.selectedBaseLayerId = 'opentopomap';
	}

	public onBaseLayerChange(layerId: string): void {
		if (layerId === 'cartes-gouv') {
			this.lastBaseLayerBeforeCartesGouv = this.selectedBaseLayerId === 'cartes-gouv' ? this.lastBaseLayerBeforeCartesGouv : this.selectedBaseLayerId;
			this.selectedBaseLayerId = 'cartes-gouv';
			setTimeout(() => this.openCartesGouvEmbed(), 0);
			return;
		}
		this.selectedBaseLayerId = layerId;
		this.applySelectedBaseLayer();
	}

	public toggleFullscreenInfo(): void {
		if (!this.isFullscreen) {
			return;
		}
		this.isFullscreenInfoVisible = !this.isFullscreenInfoVisible;
	}

	public toggleFullscreenOptions(): void {
		if (!this.isFullscreen) {
			return;
		}
		this.isFullscreenOptionsExpanded = !this.isFullscreenOptionsExpanded;
	}

	private applySelectedBaseLayer(): void {
		if (!this.map) {
			return;
		}
		if (this.selectedBaseLayerId === 'cartes-gouv') {
			return;
		}

		if (this.activeBaseLayer) {
			this.map.removeLayer(this.activeBaseLayer);
		}

		const isSwiss = this.isSwisstopoBasemap(this.selectedBaseLayerId);
		const nextLayer: L.TileLayer | L.LayerGroup = isSwiss
			? this.createSwisstopoLayer(this.selectedBaseLayerId)
			: (this.baseLayers[this.selectedBaseLayerId] ?? this.baseLayers['osm-standard']);

		if (!nextLayer) {
			return;
		}

		nextLayer.addTo(this.map);
		if (nextLayer instanceof L.TileLayer) {
			nextLayer.bringToBack();
		}
		this.activeBaseLayer = nextLayer;

		this.applyHikingTrailsOverlay();
		this.applyCyclingTrailsOverlay();

		requestAnimationFrame(() => {
			if (this.map && this.activeBaseLayer === nextLayer) {
				this.map.invalidateSize();
			}
		});
	}

	/**
	 * Affiche ou masque la couche sentiers randonnée (Waymarked Trails) par-dessus le fond de carte.
	 */
	private applyHikingTrailsOverlay(): void {
		if (!this.map) {
			return;
		}
		this.hikingTrailsOverlay?.remove();
		if (this.showHikingTrailsOverlay) {
			if (!this.hikingTrailsOverlay) {
				this.hikingTrailsOverlay = L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', {
					maxZoom: 18,
					opacity: 0.95,
					zIndex: 10
				});
			}
			this.hikingTrailsOverlay.addTo(this.map);
		}
	}

	public onHikingTrailsOverlayChange(): void {
		this.applyHikingTrailsOverlay();
		this.cdr.detectChanges();
	}

	/**
	 * Affiche ou masque la couche pistes cyclables (Waymarked Trails) par-dessus le fond de carte.
	 */
	private applyCyclingTrailsOverlay(): void {
		if (!this.map) {
			return;
		}
		this.cyclingTrailsOverlay?.remove();
		if (this.showCyclingTrailsOverlay) {
			if (!this.cyclingTrailsOverlay) {
				this.cyclingTrailsOverlay = L.tileLayer('https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png', {
					maxZoom: 18,
					opacity: 0.95,
					zIndex: 11
				});
			}
			this.cyclingTrailsOverlay.addTo(this.map);
		}
	}

	public onCyclingTrailsOverlayChange(): void {
		this.applyCyclingTrailsOverlay();
		this.cdr.detectChanges();
	}

	public toggleSelectionOverlay(): void {
		if (!this.isFullscreen) {
			return;
		}
		this.isFullscreenInfoVisible = !this.isFullscreenInfoVisible;
	}

	public recenterOnTrack(): void {
		if (!this.map || !this.trackBounds) {
			return;
		}
		this.fitMapToTrackBounds(this.trackBounds);
	}

	/** Centre du viewport carte Leaflet → page Globe 3D (zoom corrélé au niveau de zoom carte). */
	public openWorldGlobeAtMapCenter(): void {
		if (!this.map) {
			return;
		}
		const c = this.map.getCenter();
		const z = this.map.getZoom();
		void this.router.navigate(['tools', 'world-globe'], {
			queryParams: {
				lat: Math.round(c.lat * 1e7) / 1e7,
				lon: Math.round(c.lng * 1e7) / 1e7,
				z: Math.round(z * 100) / 100,
				/** Évite la rotation automatique au centre du parcours (lecture plus stable). */
				autoRotate: '0'
			}
		});
		this.close();
	}

	/** Active/désactive le suivi de la position GPS de l'appareil (recentrage carte toutes les 5 s). */
	public onFollowDeviceLocationChange(): void {
		if (this.followDeviceLocation) {
			this.startFollowDeviceLocation();
		} else {
			this.stopFollowDeviceLocation();
		}
	}

	private startFollowDeviceLocation(): void {
		this.stopFollowDeviceLocation();
		if (!this.map || !navigator.geolocation) {
			this.followDeviceLocation = false;
			this.cdr.markForCheck();
			return;
		}
		this.deviceLocationCountdown = TraceViewerModalComponent.DEVICE_LOCATION_FOLLOW_INTERVAL_S;
		this.fetchDevicePositionAndRecenter();
		this.deviceLocationCountdownId = setInterval(() => {
			this.deviceLocationCountdown = Math.max(0, this.deviceLocationCountdown - 1);
			this.cdr.markForCheck();
			if (this.deviceLocationCountdown === 0) {
				this.fetchDevicePositionAndRecenter();
				this.deviceLocationCountdown = TraceViewerModalComponent.DEVICE_LOCATION_FOLLOW_INTERVAL_S;
			}
		}, 1000);
		this.cdr.markForCheck();
	}

	private stopFollowDeviceLocation(): void {
		if (this.deviceLocationCountdownId) {
			clearInterval(this.deviceLocationCountdownId);
			this.deviceLocationCountdownId = null;
		}
		this.removeDeviceLocationMarker();
		this.deviceLocationCountdown = 0;
		this.cdr.markForCheck();
	}

	/** Affiche ou met à jour le marqueur « position appareil » sur la carte. */
	private updateDeviceLocationMarker(lat: number, lng: number): void {
		if (!this.map) {
			return;
		}
		if (this.deviceLocationMarker) {
			this.deviceLocationMarker.setLatLng([lat, lng]);
			return;
		}
		const icon = L.divIcon({
			className: 'device-location-marker',
			html: '<span style="display:block;width:14px;height:14px;border-radius:50%;background:red;border:2px solid white;box-shadow:0 0 4px rgba(0,0,0,0.6);"></span>',
			iconSize: [14, 14],
			iconAnchor: [7, 7]
		});
		this.deviceLocationMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 });
		this.deviceLocationMarker.addTo(this.map);
	}

	/** Supprime le marqueur « position appareil » de la carte. */
	private removeDeviceLocationMarker(): void {
		if (this.deviceLocationMarker) {
			if (this.map && this.map.hasLayer(this.deviceLocationMarker)) {
				this.map.removeLayer(this.deviceLocationMarker);
			}
			this.deviceLocationMarker.remove();
			this.deviceLocationMarker = undefined;
		}
	}

	private fetchDevicePositionAndRecenter(): void {
		if (!this.map || !this.followDeviceLocation || !navigator.geolocation) {
			return;
		}
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				if (!this.map || !this.followDeviceLocation) {
					return;
				}
				const lat = pos.coords.latitude;
				const lng = pos.coords.longitude;
				const zoom = this.map.getZoom();
				this.map.setView([lat, lng], zoom);
				this.updateDeviceLocationMarker(lat, lng);
				this.cdr.markForCheck();
			},
			() => {
				// Erreur géolocalisation : on laisse le compteur continuer, réessai au prochain cycle
				this.cdr.markForCheck();
			},
			{ enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
		);
	}

	public async sharePosition(): Promise<void> {
		if (!this.map) {
			return;
		}

		let lat: number;
		let lng: number;

		// Priority: selectionMarker > clickMarker > pendingLocation > lastRenderedPosition > pendingPositions > map center
		if (this.selectionMarker) {
			const pos = this.selectionMarker.getLatLng();
			lat = pos.lat;
			lng = pos.lng;
		} else if (this.clickMarker) {
			const pos = this.clickMarker.getLatLng();
			lat = pos.lat;
			lng = pos.lng;
		} else if (this.pendingLocation) {
			lat = this.pendingLocation.lat;
			lng = this.pendingLocation.lng;
		} else if (this.lastRenderedPosition) {
			// Use the last rendered position (photo position or most recent position from history)
			lat = this.lastRenderedPosition.lat;
			lng = this.lastRenderedPosition.lng;
		} else if (this.pendingPositions && this.pendingPositions.length > 0) {
			// Find the most recent position by datetime (if not yet rendered)
			let mostRecentIndex = -1;
			let mostRecentDateTime: Date | null = null;
			this.pendingPositions.forEach((pos, index) => {
				if (pos.datetime) {
					const posDate = new Date(pos.datetime);
					if (!mostRecentDateTime || posDate > mostRecentDateTime) {
						mostRecentDateTime = posDate;
						mostRecentIndex = index;
					}
				}
			});
			// Use most recent position if found, otherwise use the last one
			const positionToUse = mostRecentIndex >= 0 ? this.pendingPositions[mostRecentIndex] : this.pendingPositions[this.pendingPositions.length - 1];
			lat = positionToUse.lat;
			lng = positionToUse.lng;
		} else {
			// Fallback to map center only as last resort
			const center = this.map.getCenter();
			lat = center.lat;
			lng = center.lng;
		}

		// Format: lat, lng (use toFixed(15) for maximum GPS precision: 15 decimals = maximum JavaScript floating-point precision)
		const latStr = lat.toFixed(15);
		const lngStr = lng.toFixed(15);
		const positionText = `${latStr}, ${lngStr}`;
		// Google Maps URL
		const googleMapsUrl = `https://www.google.com/maps?q=${latStr},${lngStr}`;
		// OpenStreetMap URL
		const osmUrl = `https://www.openstreetmap.org/?mlat=${latStr}&mlon=${lngStr}&zoom=15`;

		// Get current date and time in local timezone
		const now = new Date();
		let dateTimeStr: string;
		try {
			const lang = this.translateService.currentLang || 'fr-FR';
			dateTimeStr = now.toLocaleString(lang, {
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit',
				hour12: false
			});
		} catch (error) {
			// Fallback to simple format if locale formatting fails
			const day = String(now.getDate()).padStart(2, '0');
			const month = String(now.getMonth() + 1).padStart(2, '0');
			const year = now.getFullYear();
			const hours = String(now.getHours()).padStart(2, '0');
			const minutes = String(now.getMinutes()).padStart(2, '0');
			const seconds = String(now.getSeconds()).padStart(2, '0');
			dateTimeStr = `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
		}

		// Check if opened from slideshow (has photo name in label or trackFileName)
		// A photo name typically has a file extension (.jpg, .png, etc.)
		const photoName = this.pendingLocation?.label || this.trackFileName;
		const seeLocationText = this.translate('EVENTELEM.SEE_LOCATION');
		const userLocationText = this.translate('API.USER_LOCATION');

		// Check if it's a generic location label (not a photo name)
		const isGenericLabel = !photoName ||
			photoName === seeLocationText ||
			photoName === userLocationText ||
			photoName === 'Ma position' ||
			photoName === 'My position' ||
			photoName === 'User location' ||
			photoName.toLowerCase().includes('position') && !photoName.match(/\.(jpg|jpeg|png|gif|bmp|webp|heic|heif|tiff|tif|mov|mp4|avi)$/i);

		// Consider it from slideshow only if it has a file extension and is not a generic label
		const hasFileExtension = photoName && /\.(jpg|jpeg|png|gif|bmp|webp|heic|heif|tiff|tif|mov|mp4|avi)$/i.test(photoName);

		const isFromSlideshow = photoName && photoName.trim().length > 0 &&
			!isGenericLabel && hasFileExtension;

		// Create share text based on context
		let shareText: string;

		// If simple share mode (from yellow "Carte" button), use simple format
		if (this.simpleShareMode) {
			shareText = `${this.translate('API.POSITION')}: ${positionText}`;
		} else if (isFromSlideshow) {
			// Opened from slideshow: use photo name
			shareText = `${this.translate('API.PHOTO_POSITION')} : ${photoName} (${dateTimeStr})`;
		} else {
			// Opened directly: use user name
			let userFullName = '';
			try {
				const user = this.keycloakService.getUserAsMember();
				if (user.firstName && user.lastName) {
					userFullName = `${user.firstName} ${user.lastName}`.trim();
				} else if (user.firstName) {
					userFullName = user.firstName;
				} else if (user.lastName) {
					userFullName = user.lastName;
				} else if (user.userName) {
					userFullName = user.userName;
				}
			} catch (error) {
				console.warn('Could not get user info for share:', error);
			}

			const currentLang = this.translateService.currentLang || this.translateService.defaultLang || 'fr';
			// For Japanese, Arabic, and Hindi, the name comes before "position"
			const isRTLOrSpecialOrder = ['jp', 'ar', 'in'].includes(currentLang);
			if (userFullName) {
				if (isRTLOrSpecialOrder) {
					// For Japanese: "Patrick Deschamps の位置"
					// For Arabic/Hindi: similar structure
					shareText = currentLang === 'jp'
						? `${userFullName} の${this.translate('API.POSITION')} (${dateTimeStr}): ${positionText}`
						: `${userFullName} ${this.translate('API.POSITION_OF')} (${dateTimeStr}): ${positionText}`;
				} else {
					shareText = `${this.translate('API.POSITION_OF')} ${userFullName} (${dateTimeStr}): ${positionText}`;
				}
			} else {
				shareText = `${this.translate('API.POSITION')} (${dateTimeStr}): ${positionText}`;
			}
		}

		// Try to use Web Share API if available
		if (navigator.share) {
			try {
				const shareData: ShareData = {
					title: shareText,
					text: shareText,
					url: googleMapsUrl
				};

				await navigator.share(shareData);
				// Share successful
				return;
			} catch (error: any) {
				// User cancelled or error occurred
				if (error.name !== 'AbortError') {
					console.error('Error sharing position:', error);
					// Fallback to clipboard if share fails
					const clipboardText = `${shareText}\n${this.translate('EVENTELEM.VIEW_ON_MAPS')}: ${googleMapsUrl}`;
					this.copyToClipboard(clipboardText);
				}
				return;
			}
		}

		// Fallback: copy to clipboard if Web Share API is not available
		const clipboardText = `${shareText}\n${this.translate('EVENTELEM.VIEW_ON_MAPS')}: ${googleMapsUrl}`;
		this.copyToClipboard(clipboardText);
	}

	private copyToClipboardFallback(text: string): void {
		// Create a temporary textarea element
		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.style.position = 'fixed';
		textarea.style.opacity = '0';
		textarea.style.left = '-999999px';
		document.body.appendChild(textarea);

		// Select and copy the text
		textarea.select();
		textarea.setSelectionRange(0, 99999); // For mobile devices

		try {
			const successful = document.execCommand('copy');
			if (successful) {
				const message = this.translate('API.POSITION_COPIED');
				// Optional: show a toast notification here if you have a toast service
			}
		} catch (err) {
			console.error('Failed to copy position:', err);
		}

		// Clean up
		document.body.removeChild(textarea);
	}

	private copyToClipboard(text: string): void {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).then(() => {
				// Position copied successfully
			}).catch(() => {
				this.copyToClipboardFallback(text);
			});
		} else {
			this.copyToClipboardFallback(text);
		}
	}

	private registerRightClickZoom(): void {
		if (!this.map) {
			return;
		}
		this.map.on('mousedown', this.handleMapMouseDown);
		this.map.on('mousemove', this.handleMapMouseMove);
		this.map.on('mouseup', this.handleMapMouseUp);
		this.map.on('mouseout', this.handleMapMouseLeave);
		this.map.on('contextmenu', this.handleMapContextMenu);
		const container = this.map.getContainer();
		container.addEventListener('contextmenu', this.preventContextMenu);
	}

	private cleanupRightClickZoom(): void {
		if (!this.map) {
			return;
		}
		this.map.off('mousedown', this.handleMapMouseDown);
		this.map.off('mousemove', this.handleMapMouseMove);
		this.map.off('mouseup', this.handleMapMouseUp);
		this.map.off('mouseout', this.handleMapMouseLeave);
		this.map.off('contextmenu', this.handleMapContextMenu);
		const container = this.map.getContainer();
		container.removeEventListener('contextmenu', this.preventContextMenu);
	}

	private registerLocationSelection(): void {
		if (!this.map || !this.selectionMode) {
			return;
		}

		// Clean up any existing handler first
		if (this.locationSelectionClickHandler) {
			this.map.off('click', this.locationSelectionClickHandler);
		}

		// Create initial marker at current location if pendingLocation exists (blue marker for initial position)
		if (this.pendingLocation && !this.selectionMarker) {
			this.createSelectionMarker(this.pendingLocation.lat, this.pendingLocation.lng, true);
			// Show address automatically for initial location if address display is enabled
			if (this.showAddress) {
				this.showAddressInOverlay(this.pendingLocation.lat, this.pendingLocation.lng);
			}
		}

		// Register click handler for location selection
		this.locationSelectionClickHandler = (e: L.LeafletMouseEvent) => {
			const lat = e.latlng.lat;
			const lng = e.latlng.lng;

			// Stop event propagation to prevent mapClickHandler from also firing
			e.originalEvent?.stopPropagation();
			L.DomEvent.stopPropagation(e);

			// Create selection marker (will remove previous one if exists)
			this.createSelectionMarker(lat, lng);

			// Store coordinates for when modal closes (don't emit immediately)
			// This allows coordinates to be sent to openweathermap when closing, even if address display is off
			this.finalSelectedCoordinates = { lat, lng };

			// Show address in overlay if enabled
			if (this.showAddress) {
				this.showAddressInOverlay(lat, lng);
			}
		};

		this.map.on('click', this.locationSelectionClickHandler);
	}

	/**
	 * Create a selection marker at the specified coordinates
	 * @param lat Latitude
	 * @param lng Longitude
	 * @param isInitial If true, creates a blue marker (initial position), otherwise red (selected position)
	 */
	private createSelectionMarker(lat: number, lng: number, isInitial: boolean = false): void {
		// Remove previous selection marker if exists
		if (this.selectionMarker) {
			try {
				// Try removing from overlayLayer first
				if (this.overlayLayer && this.overlayLayer.hasLayer(this.selectionMarker)) {
					this.overlayLayer.removeLayer(this.selectionMarker);
				}
				// Also try removing directly from map (in case it was added there)
				if (this.map && this.map.hasLayer(this.selectionMarker)) {
					this.map.removeLayer(this.selectionMarker);
				}
				// Unbind popup and remove marker completely
				this.selectionMarker.remove();
			} catch (e) {
				console.warn('Error removing previous marker:', e);
			}
			this.selectionMarker = undefined;
		}

		// Choose color: blue for initial position, red for selected position
		const markerColor = isInitial ? '#0066FF' : '#FF0000';
		const markerClassName = isInitial ? 'custom-blue-marker' : 'custom-red-marker';

		// Create marker icon using SVG divIcon
		const markerIcon = L.divIcon({
			className: markerClassName,
			html: `
				<div style="width: 25px; height: 41px; position: relative;">
					<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg" style="display: block;">
						<path d="M12.5 0C5.596 0 0 5.596 0 12.5c0 12.5 12.5 28.5 12.5 28.5s12.5-16 12.5-28.5C25 5.596 19.404 0 12.5 0z" fill="${markerColor}" stroke="#FFFFFF" stroke-width="1"/>
						<circle cx="12.5" cy="12.5" r="5" fill="#FFFFFF"/>
					</svg>
				</div>
			`,
			iconSize: [25, 41],
			iconAnchor: [12.5, 41],
			popupAnchor: [0, -41]
		});

		// Add new marker at location - add directly to map with high z-index
		// Create marker without popup - address will be shown in overlay
		this.selectionMarker = L.marker([lat, lng], {
			draggable: true,
			icon: markerIcon,
			zIndexOffset: 1000,
			riseOnHover: true,
			riseOffset: 250
		});

		// Update switches when marker is clicked
		this.selectionMarker.on('click', (e: L.LeafletMouseEvent) => {
			e.originalEvent?.stopPropagation();
			L.DomEvent.stopPropagation(e);
			if (e.originalEvent) {
				L.DomEvent.preventDefault(e.originalEvent);
			}
			if (this.selectionMarker) {
				const pos = this.selectionMarker.getLatLng();
				this.updateSwitchesForPoint(pos.lat, pos.lng);
			}
		});

		// Add directly to map to ensure it's on top
		this.selectionMarker.addTo(this.map!);

		// Handle marker drag end to update coordinates
		this.selectionMarker.on('dragend', () => {
			const pos = this.selectionMarker!.getLatLng();
			// When dragged, it becomes a selected position (red)
			this.createSelectionMarker(pos.lat, pos.lng, false);

			// Store coordinates for when modal closes (don't emit immediately)
			this.finalSelectedCoordinates = { lat: pos.lat, lng: pos.lng };

			// Update all switches independently
			this.updateSwitchesForPoint(pos.lat, pos.lng);
		});
	}

	/**
	 * Create a marker at clicked position (for general map clicks)
	 */
	private createClickMarker(lat: number, lng: number): void {
		// Remove previous click marker if exists
		if (this.clickMarker) {
			try {
				if (this.overlayLayer && this.overlayLayer.hasLayer(this.clickMarker)) {
					this.overlayLayer.removeLayer(this.clickMarker);
				}
				if (this.map && this.map.hasLayer(this.clickMarker)) {
					this.map.removeLayer(this.clickMarker);
				}
				this.clickMarker.remove();
			} catch (e) {
				console.warn('Error removing previous click marker:', e);
			}
			this.clickMarker = undefined;
		}

		// Create red marker icon
		const markerIcon = L.divIcon({
			className: 'custom-red-marker',
			html: `
				<div style="width: 25px; height: 41px; position: relative;">
					<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg" style="display: block;">
						<path d="M12.5 0C5.596 0 0 5.596 0 12.5c0 12.5 12.5 28.5 12.5 28.5s12.5-16 12.5-28.5C25 5.596 19.404 0 12.5 0z" fill="#FF0000" stroke="#FFFFFF" stroke-width="1"/>
						<circle cx="12.5" cy="12.5" r="5" fill="#FFFFFF"/>
					</svg>
				</div>
			`,
			iconSize: [25, 41],
			iconAnchor: [12.5, 41],
			popupAnchor: [0, -41]
		});

		// Create marker
		this.clickMarker = L.marker([lat, lng], {
			icon: markerIcon,
			zIndexOffset: 1000,
			riseOnHover: true,
			riseOffset: 250
		});

		// Update switches when marker is clicked
		this.clickMarker.on('click', (e: L.LeafletMouseEvent) => {
			e.originalEvent?.stopPropagation();
			L.DomEvent.stopPropagation(e);
			if (e.originalEvent) {
				L.DomEvent.preventDefault(e.originalEvent);
			}
			if (this.clickMarker) {
				const pos = this.clickMarker.getLatLng();
				this.updateSwitchesForPoint(pos.lat, pos.lng);
			}
		});

		// Add to map
		this.clickMarker.addTo(this.map!);
	}

	private cleanupLocationSelection(): void {
		if (!this.map) {
			return;
		}
		// Remove specific click handler if it exists
		if (this.locationSelectionClickHandler) {
			this.map.off('click', this.locationSelectionClickHandler);
			this.locationSelectionClickHandler = undefined;
		}
		if (this.selectionMarker) {
			// Remove from overlayLayer if it exists there
			if (this.overlayLayer) {
				this.overlayLayer.removeLayer(this.selectionMarker);
			}
			// Also remove directly from map (in case it was added there)
			this.map.removeLayer(this.selectionMarker);
			this.selectionMarker = undefined;
		}
		// Remove click marker if exists
		if (this.clickMarker) {
			try {
				if (this.overlayLayer && this.overlayLayer.hasLayer(this.clickMarker)) {
					this.overlayLayer.removeLayer(this.clickMarker);
				}
				if (this.map && this.map.hasLayer(this.clickMarker)) {
					this.map.removeLayer(this.clickMarker);
				}
				this.clickMarker.remove();
			} catch (e) {
				console.warn('Error removing click marker:', e);
			}
			this.clickMarker = undefined;
		}
	}

	private closeModalInstance(): void {
		if (this.cartesGouvModalRef) {
			if (this.document.fullscreenElement) {
				this.document.exitFullscreen().catch(() => {});
			}
			try { this.cartesGouvModalRef.close(); } catch { }
			this.cartesGouvModalRef = undefined;
			this.cartesGouvEmbedUrl = null;
			this.cleanupCartesGouvFullscreenListener();
		}
		const ref = this.modalRef;
		if (ref) {
			try {
				ref.dismiss('manual-close');
			} catch {
				try {
					ref.close('manual-close');
				} catch {
					this.modalService.dismissAll('manual-close');
				}
			}
		} else {
			this.modalService.dismissAll('manual-close');
		}

		this.resetModalState();
	}

	private registerEscapeKeydownListener(): void {
		if (this.escapeKeydownListener) {
			return;
		}

		this.escapeKeydownListener = (event: KeyboardEvent) => {
			if (!this.modalRef) {
				return;
			}
			const key = event.key?.toLowerCase?.() ?? '';
			if (key === 'escape' || key === 'esc') {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation?.();
				this.close();
			}
		};

		this.document.addEventListener('keydown', this.escapeKeydownListener, true);
	}

	private removeEscapeKeydownListener(): void {
		if (this.escapeKeydownListener) {
			this.document.removeEventListener('keydown', this.escapeKeydownListener, true);
			this.escapeKeydownListener = undefined;
		}
	}

	private resetModalState(): void {
		this.teardownModalWheelTrap();
		this.mapEmbedHostRoot = undefined;
		this.removeEscapeKeydownListener();
		this.isFullscreen = false;
		this.isFullscreenInfoVisible = false;
		this.isFullscreenOptionsExpanded = false;
		this.destroyMap();
		this.cleanupFullscreenListener();
		this.cleanupOrientationListener();
		this.cleanupVisibilityChangeListener();
		void this.releaseScreenWakeLock();
		this.resetTraceViewerColors();
		if (this.document.fullscreenElement) {
			this.document.exitFullscreen().catch(() => { });
		}
		// Emit coordinates to parent component when closing (if coordinates were selected)
		if (this.finalSelectedCoordinates) {
			this.locationSelected.emit(this.finalSelectedCoordinates);
			this.finalSelectedCoordinates = undefined;
		}

		this.modalRef = undefined;
		if (!this.hasEmittedClosed) {
			this.hasEmittedClosed = true;
			this.closed.emit();
		}
	}

	// Apply event color to trace viewer styling (similar to slideshow)
	private applyEventColorToTraceViewer(): void {
		if (!this.eventColor) {
			return;
		}

		const color = this.eventColor;
		// Calculate brightness to determine if we need lighter or darker variants
		const brightness = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b);
		const isBright = brightness > 128;

		// Header background - use gradient based on event color
		const headerBgR = Math.min(255, color.r + 20);
		const headerBgG = Math.min(255, color.g + 20);
		const headerBgB = Math.min(255, color.b + 20);
		const headerBg2R = Math.max(0, color.r - 10);
		const headerBg2G = Math.max(0, color.g - 10);
		const headerBg2B = Math.max(0, color.b - 10);

		// Header text color - inverse based on brightness
		const headerTextColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';

		// Button colors - use event color with adjustments
		const buttonBorderR = Math.min(255, color.r + 30);
		const buttonBorderG = Math.min(255, color.g + 30);
		const buttonBorderB = Math.min(255, color.b + 30);
		const buttonTextColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';
		const buttonHoverBgR = Math.min(255, color.r + 40);
		const buttonHoverBgG = Math.min(255, color.g + 40);
		const buttonHoverBgB = Math.min(255, color.b + 40);

		// Border color - use event color
		const borderColor = `rgb(${color.r}, ${color.g}, ${color.b})`;

		// Footer background - use darker variant of event color
		const footerBgR = Math.max(0, color.r - 30);
		const footerBgG = Math.max(0, color.g - 30);
		const footerBgB = Math.max(0, color.b - 30);
		const footerBorderR = Math.max(0, color.r - 20);
		const footerBorderG = Math.max(0, color.g - 20);
		const footerBorderB = Math.max(0, color.b - 20);

		// Footer button colors - use event color with adjustments
		const footerButtonBgR = Math.min(255, color.r + 10);
		const footerButtonBgG = Math.min(255, color.g + 10);
		const footerButtonBgB = Math.min(255, color.b + 10);
		const footerButtonBorderR = Math.min(255, color.r + 20);
		const footerButtonBorderG = Math.min(255, color.g + 20);
		const footerButtonBorderB = Math.min(255, color.b + 20);
		const footerButtonTextColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';
		const footerButtonHoverBgR = Math.min(255, color.r + 30);
		const footerButtonHoverBgG = Math.min(255, color.g + 30);
		const footerButtonHoverBgB = Math.min(255, color.b + 30);

		// Apply CSS variables to the modal element - try multiple selectors for compatibility
		const applyColors = (attempt: number = 0) => {
			let modalElement: HTMLElement | null = null;

			// Try multiple ways to find the modal element
			modalElement = document.querySelector('.modal.show .modal-content.slideshow-modal-wide') as HTMLElement;
			if (!modalElement) {
				modalElement = document.querySelector('.modal.show .modal-content:has(.trace-viewer-body)') as HTMLElement;
			}
			if (!modalElement) {
				modalElement = document.querySelector('.modal.show .modal-content') as HTMLElement;
			}
			if (!modalElement) {
				modalElement = document.querySelector('.slideshow-modal-wide .modal-content') as HTMLElement;
			}
			if (!modalElement && this.modalRef) {
				// Try to get element from modalRef
				const modalRefAny = this.modalRef as any;
				if (modalRefAny._windowCmptRef?.location?.nativeElement) {
					modalElement = modalRefAny._windowCmptRef.location.nativeElement.querySelector('.modal-content');
				}
				if (!modalElement && modalRefAny._backdropCmptRef?.location?.nativeElement) {
					const backdrop = modalRefAny._backdropCmptRef.location.nativeElement;
					modalElement = backdrop.nextElementSibling?.querySelector('.modal-content') || backdrop.closest('.modal')?.querySelector('.modal-content');
				}
			}

			if (modalElement) {
				modalElement.style.setProperty('--slideshow-header-bg', `linear-gradient(135deg, rgb(${headerBgR}, ${headerBgG}, ${headerBgB}) 0%, rgb(${headerBg2R}, ${headerBg2G}, ${headerBg2B}) 100%)`);
				modalElement.style.setProperty('--slideshow-header-text', headerTextColor);
				modalElement.style.setProperty('--slideshow-button-border', `rgb(${buttonBorderR}, ${buttonBorderG}, ${buttonBorderB})`);
				modalElement.style.setProperty('--slideshow-button-text', buttonTextColor);
				modalElement.style.setProperty('--slideshow-button-hover-bg', `rgba(${buttonHoverBgR}, ${buttonHoverBgG}, ${buttonHoverBgB}, 0.2)`);
				modalElement.style.setProperty('--slideshow-border', borderColor);

				// Footer colors
				modalElement.style.setProperty('--slideshow-footer-bg', `rgb(${footerBgR}, ${footerBgG}, ${footerBgB})`);
				modalElement.style.setProperty('--slideshow-footer-border', `rgb(${footerBorderR}, ${footerBorderG}, ${footerBorderB})`);
				modalElement.style.setProperty('--slideshow-footer-button-bg', `rgba(${footerButtonBgR}, ${footerButtonBgG}, ${footerButtonBgB}, 0.3)`);
				modalElement.style.setProperty('--slideshow-footer-button-border', `rgba(${footerButtonBorderR}, ${footerButtonBorderG}, ${footerButtonBorderB}, 0.5)`);
				modalElement.style.setProperty('--slideshow-footer-button-text', footerButtonTextColor);
				modalElement.style.setProperty('--slideshow-footer-button-hover-bg', `rgba(${footerButtonHoverBgR}, ${footerButtonHoverBgG}, ${footerButtonHoverBgB}, 0.2)`);
			} else if (attempt < 10) {
				// Retry if modal not found yet (increased attempts)
				setTimeout(() => applyColors(attempt + 1), 100 * (attempt + 1));
			} else {
				console.warn('[TraceViewer] Could not find modal element to apply colors after', attempt, 'attempts');
			}
		};

		applyColors();
	}

	// Reset trace viewer colors to default (only from trace viewer modal, not slideshow)
	private resetTraceViewerColors(): void {
		// Only target the trace viewer modal (one that contains .trace-viewer-body)
		let modalElement = document.querySelector('.modal.show .modal-content:has(.trace-viewer-body)') as HTMLElement;
		if (!modalElement && this.modalRef) {
			// Try to get element from modalRef
			const modalRefAny = this.modalRef as any;
			if (modalRefAny._windowCmptRef?.location?.nativeElement) {
				const element = modalRefAny._windowCmptRef.location.nativeElement.querySelector('.modal-content');
				if (element && element.querySelector('.trace-viewer-body')) {
					modalElement = element;
				}
			}
		}

		// Only reset colors from the trace viewer modal, not the slideshow
		if (modalElement && modalElement.querySelector('.trace-viewer-body')) {
			modalElement.style.removeProperty('--slideshow-header-bg');
			modalElement.style.removeProperty('--slideshow-header-text');
			modalElement.style.removeProperty('--slideshow-button-border');
			modalElement.style.removeProperty('--slideshow-button-text');
			modalElement.style.removeProperty('--slideshow-button-hover-bg');
			modalElement.style.removeProperty('--slideshow-border');
			modalElement.style.removeProperty('--slideshow-footer-bg');
			modalElement.style.removeProperty('--slideshow-footer-border');
			modalElement.style.removeProperty('--slideshow-footer-button-bg');
			modalElement.style.removeProperty('--slideshow-footer-button-border');
			modalElement.style.removeProperty('--slideshow-footer-button-text');
			modalElement.style.removeProperty('--slideshow-footer-button-hover-bg');
		}

		// Reapply slideshow colors if slideshow is still open
		this.reapplySlideshowColors();
	}

	// Reapply slideshow colors after trace viewer closes
	// Note: The actual reapplication is handled by the slideshow component via setTraceViewerOpen(false)
	// This method is kept for potential future use but the slideshow component handles the color reapplication
	private reapplySlideshowColors(): void {
		// The slideshow component will handle reapplying colors when setTraceViewerOpen(false) is called
		// This happens in the parent component's onTraceViewerClosed() method
	}

	public toggleGpsCoordinates(): void {
		// showGpsCoordinates is already toggled by ngModel binding
		if (this.showGpsCoordinates) {
			// Ensure map is initialized before updating coordinates
			if (!this.map) {
				setTimeout(() => this.toggleGpsCoordinates(), 100);
				return;
			}
			// Ensure handler is registered (it should always be, but check just in case)
			if (!this.mapMouseMoveHandler) {
				this.registerMapMouseMoveHandler();
			}
			// Initialize with center if mouse hasn't moved yet
			this.updateGpsCoordinatesFromCenter();
		}
		this.cdr.detectChanges();
	}

	private registerMapMoveHandler(): void {
		if (!this.map || this.mapMoveHandler) {
			return;
		}

		this.mapMoveHandler = () => {
			// Only update if GPS coordinates are shown and mouse hasn't moved
			if (this.showGpsCoordinates && !this.mapMouseMoveHandler) {
				this.updateGpsCoordinatesFromCenter();
			}
		};

		this.map.on('move', this.mapMoveHandler);
		this.map.on('moveend', this.mapMoveHandler);
	}

	private cleanupMapMoveHandler(): void {
		if (!this.map || !this.mapMoveHandler) {
			return;
		}

		this.map.off('move', this.mapMoveHandler);
		this.map.off('moveend', this.mapMoveHandler);
		this.mapMoveHandler = undefined;
	}

	private registerMapMouseMoveHandler(): void {
		if (!this.map) {
			return;
		}

		// Clean up existing handlers first to avoid duplicates
		this.cleanupMapMouseMoveHandler();

		// Update coordinates when user clicks on the map (for GPS coordinates display)
		// Only update if GPS switch is enabled
		this.mapMouseMoveHandler = (e: L.LeafletMouseEvent) => {
			if (this.showGpsCoordinates) {
				this.currentLat = e.latlng.lat;
				this.currentLng = e.latlng.lng;
				this.fetchAltitudeForCoordinates(e.latlng.lat, e.latlng.lng, 'current');
				this.cdr.detectChanges();
			}
		};

		this.map.on('click', this.mapMouseMoveHandler);

		// Initialize with center coordinates
		this.updateGpsCoordinatesFromCenter();
	}

	private cleanupMapMouseMoveHandler(): void {
		if (!this.map) {
			return;
		}

		if (this.mapMouseMoveHandler) {
			this.map.off('click', this.mapMouseMoveHandler);
			this.mapMouseMoveHandler = undefined;
		}

		if (this.mapMouseOutHandler) {
			this.map.off('mouseout', this.mapMouseOutHandler);
			this.mapMouseOutHandler = undefined;
		}
	}

	/**
	 * Register click handler for address display (independent of GPS coordinates)
	 */
	private registerAddressClickHandler(): void {
		if (!this.map) {
			return;
		}

		// Clean up existing handler first to avoid duplicates
		this.cleanupAddressClickHandler();

		// Register click handler for address and weather display
		// This handler works independently - each switch updates only if enabled
		// Note: marker creation is handled by registerMapClickHandler() which is always active
		this.addressClickHandler = (e: L.LeafletMouseEvent) => {
			const lat = e.latlng.lat;
			const lng = e.latlng.lng;

			// Update all switches independently
			this.updateSwitchesForPoint(lat, lng);
		};

		this.map.on('click', this.addressClickHandler);
	}

	/**
	 * Clean up address click handler
	 */
	private cleanupAddressClickHandler(): void {
		if (!this.map) {
			return;
		}

		if (this.addressClickHandler) {
			this.map.off('click', this.addressClickHandler);
			this.addressClickHandler = undefined;
		}
	}

	private updateGpsCoordinatesFromCenter(): void {
		if (!this.map) {
			return;
		}

		const center = this.map.getCenter();
		this.currentLat = center.lat;
		this.currentLng = center.lng;
		this.fetchAltitudeForCoordinates(center.lat, center.lng, 'current');
		// Don't fetch weather here - weather should only be fetched on click or when weather switch is toggled
		this.cdr.detectChanges();
	}

	public copyGpsCoordinates(): void {
		const coordinates = `${this.currentLat.toFixed(15)}, ${this.currentLng.toFixed(15)}`;
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(coordinates).then(() => {
				// Coordinates copied successfully
			}).catch((err) => {
				console.error('Failed to copy coordinates:', err);
				this.copyToClipboardFallback(coordinates);
			});
		} else {
			this.copyToClipboardFallback(coordinates);
		}
	}

	/**
	 * Register click handler for marker creation (always active, independent of showAddress)
	 */
	private registerMapClickHandler(): void {
		if (!this.map) {
			return;
		}

		// Clean up existing handler first to avoid duplicates
		this.cleanupMapClickHandler();

		// Register click handler for marker creation
		// This handler works independently of showAddress and selectionMode
		this.mapClickHandler = (e: L.LeafletMouseEvent) => {
			const lat = e.latlng.lat;
			const lng = e.latlng.lng;

			// Create click marker at clicked position (only if not in selection mode, as selectionMarker handles that)
			if (!this.selectionMode) {
				this.createClickMarker(lat, lng);
			}
		};

		this.map.on('click', this.mapClickHandler);
	}

	/**
	 * Clean up map click handler
	 */
	private cleanupMapClickHandler(): void {
		if (!this.map) {
			return;
		}

		if (this.mapClickHandler) {
			this.map.off('click', this.mapClickHandler);
			this.mapClickHandler = undefined;
		}
	}

	/**
	 * Handle showAddress switch change - address click handler is always registered
	 */
	public onShowAddressChange(): void {
		// Handler is always registered, but only updates if switch is enabled
		// If address was already fetched for a clicked point, just display it
		if (this.showAddress) {

			// If address was already fetched for a clicked point, just display it
			if (this.clickedAddress && this.clickedLat && this.clickedLng) {
				// Address already available, just ensure it's displayed
				this.cdr.detectChanges();
				return;
			}

			let lat: number | null = null;
			let lng: number | null = null;
			let alt: number | null = null;

			// Priority 1: Use lastRenderedPosition (most recent point from trace/positions)
			if (this.lastRenderedPosition) {
				lat = this.lastRenderedPosition.lat;
				lng = this.lastRenderedPosition.lng;
				alt = this.currentAlt; // Use current altitude if available
			}
			// Priority 2: Use clicked position
			else if (this.clickedLat && this.clickedLng) {
				lat = this.clickedLat;
				lng = this.clickedLng;
				alt = this.clickedAlt;
			}
			// Priority 3: Use current position (center of map or mouse position)
			else if (this.currentLat && this.currentLng) {
				lat = this.currentLat;
				lng = this.currentLng;
				alt = this.currentAlt;
			}
			// Priority 4: Use map center if available
			else if (this.map) {
				const center = this.map.getCenter();
				lat = center.lat;
				lng = center.lng;
				alt = null;
			}

			if (lat !== null && lng !== null) {
				// Update clicked coordinates for display
				this.clickedLat = lat;
				this.clickedLng = lng;
				this.clickedAlt = this.isFiniteAltitude(alt) ? alt : null;
				this.clickedAddress = 'Loading address...';
				this.cdr.detectChanges();

				// Get address and altitude
				this.getAddressFromCoordinates(lat, lng);
				this.fetchAltitudeForCoordinates(lat, lng, 'clicked');
			}
		}
		// Handler is always registered, no need to clean up
	}

	/**
	 * Handle showWeather switch change - fetch weather for most recent point or current position
	 */
	public onShowWeatherChange(): void {
		if (this.showWeather) {
			// If weather was already fetched for a clicked point, just display it
			if (this.currentWeather && this.clickedWeatherLat && this.clickedWeatherLng) {
				// Weather already available, just ensure address is loaded
				if (!this.clickedWeatherAddress) {
					this.getAddressFromCoordinatesForWeather(this.clickedWeatherLat, this.clickedWeatherLng);
				}
				this.cdr.detectChanges();
				return;
			}

			let lat: number | null = null;
			let lng: number | null = null;
			let alt: number | null = null;

			// Priority 1: Use lastRenderedPosition (most recent point from trace/positions)
			if (this.lastRenderedPosition) {
				lat = this.lastRenderedPosition.lat;
				lng = this.lastRenderedPosition.lng;
				alt = this.currentAlt; // Use current altitude if available
			}
			// Priority 2: Use clicked weather position
			else if (this.clickedWeatherLat && this.clickedWeatherLng) {
				lat = this.clickedWeatherLat;
				lng = this.clickedWeatherLng;
				alt = this.clickedWeatherAlt;
			}
			// Priority 3: Use current position (center of map or mouse position)
			else if (this.currentLat && this.currentLng) {
				lat = this.currentLat;
				lng = this.currentLng;
				alt = this.currentAlt;
			}
			// Priority 4: Use map center if available
			else if (this.map) {
				const center = this.map.getCenter();
				lat = center.lat;
				lng = center.lng;
				alt = null;
			}

			if (lat !== null && lng !== null) {
				// Update clicked weather coordinates for display
				this.clickedWeatherLat = lat;
				this.clickedWeatherLng = lng;
				this.clickedWeatherAlt = alt;
				this.clickedWeatherAddress = '';
				this.isLoadingWeather = true;
				this.cdr.detectChanges();

				// Get address and altitude, then fetch weather
				this.getAddressFromCoordinatesForWeather(lat, lng);
				this.fetchAltitudeForCoordinates(lat, lng, 'clicked');
				setTimeout(() => {
					this.fetchWeather(lat!, lng!, this.clickedWeatherAlt);
				}, 100);
			}
		} else {
			this.currentWeather = null;
		}
	}

	/**
	 * Fetch weather data for given coordinates
	 * @param showLoading If true, set isLoadingWeather flag (default: true)
	 */
	private fetchWeather(lat: number, lng: number, alt: number | null = null, showLoading: boolean = true): void {
		if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
			return;
		}

		if (showLoading) {
			this.isLoadingWeather = true;
		}
		this.apiService.getCurrentWeatherByCoordinates(lat, lng, alt).subscribe({
			next: (response) => {
				if (response.error) {
					this.currentWeather = null;
				} else {
					this.currentWeather = response;
				}
				this.isLoadingWeather = false;
				// Use setTimeout to defer change detection to next tick, preventing ExpressionChangedAfterItHasBeenCheckedError
				setTimeout(() => {
					this.cdr.markForCheck();
				}, 0);
			},
			error: (error) => {
				console.error('Error fetching weather:', error);
				this.currentWeather = null;
				this.isLoadingWeather = false;
				// Use setTimeout to defer change detection to next tick, preventing ExpressionChangedAfterItHasBeenCheckedError
				setTimeout(() => {
					this.cdr.markForCheck();
				}, 0);
			}
		});
	}

	/**
	 * Get weather icon URL from OpenWeatherMap
	 */
	public getWeatherIconUrl(icon: string): string {
		if (!icon) return '';
		return `https://openweathermap.org/img/wn/${icon}@2x.png`;
	}

	/**
	 * Show both address and weather in overlay when clicking on the map
	 * Optimized to fetch address only once
	 */
	private showAddressAndWeatherInOverlay(lat: number, lng: number): void {
		// Only show overlays if both switches are enabled
		if (!this.showAddress || !this.showWeather) {
			return;
		}

		// Initialize both overlays
		this.clickedLat = lat;
		this.clickedLng = lng;
		this.clickedAlt = null;
		this.clickedAddress = 'Loading address...';

		this.clickedWeatherLat = lat;
		this.clickedWeatherLng = lng;
		this.clickedWeatherAlt = null;
		this.clickedWeatherAddress = '';
		this.currentWeather = null;
		this.isLoadingWeather = true;
		this.cdr.detectChanges();

		// Get address from coordinates (will be shared for both overlays)
		this.getAddressFromCoordinates(lat, lng, true); // Pass true to also update weather address
		// Get altitude for clicked coordinates
		this.fetchAltitudeForCoordinates(lat, lng, 'clicked');
		// Fetch weather (will use clickedWeatherAlt if available)
		setTimeout(() => {
			this.fetchWeather(lat, lng, this.clickedWeatherAlt);
		}, 100);
	}

	/**
	 * Fetch weather for clicked point (always, even if switch not enabled)
	 * This ensures weather is available when switch is enabled later
	 */
	private fetchWeatherForClickedPoint(lat: number, lng: number): void {
		// Get address from coordinates
		this.getAddressFromCoordinatesForWeather(lat, lng);
		// Get altitude for clicked coordinates first, then fetch weather
		this.fetchAltitudeForCoordinates(lat, lng, 'clicked');
		// Fetch weather (will use clickedWeatherAlt if available)
		// Only show loading if switch is enabled
		setTimeout(() => {
			this.fetchWeather(lat, lng, this.clickedWeatherAlt, this.showWeather);
		}, 100);
	}

	/**
	 * Show weather in overlay when clicking on the map
	 * Works independently of other switches
	 */
	private showWeatherInOverlay(lat: number, lng: number): void {
		this.clickedWeatherLat = lat;
		this.clickedWeatherLng = lng;
		this.clickedWeatherAlt = null;
		this.clickedWeatherAddress = '';
		this.currentWeather = null;
		this.isLoadingWeather = true;
		this.cdr.detectChanges();

		// Use the shared method to fetch weather
		this.fetchWeatherForClickedPoint(lat, lng);
	}

	/**
	 * Get address from coordinates for weather overlay
	 */
	private getAddressFromCoordinatesForWeather(lat: number, lng: number): void {
		const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;

		fetch(url, {
			headers: {
				'User-Agent': 'PATTOOL Weather App', // Required by Nominatim
			}
		})
			.then(response => response.json())
			.then(data => {
				if (data && data.display_name) {
					this.clickedWeatherAddress = data.display_name;
				} else {
					this.clickedWeatherAddress = `${lat.toFixed(7)}, ${lng.toFixed(7)}`;
				}
				this.cdr.detectChanges();
			})
			.catch(error => {
				console.debug('Could not fetch address for weather:', error);
				this.clickedWeatherAddress = `${lat.toFixed(7)}, ${lng.toFixed(7)}`;
				this.cdr.detectChanges();
			});
	}

	/**
	 * Update all switches independently based on clicked coordinates
	 * Each switch updates only if it is enabled
	 */
	private updateSwitchesForPoint(lat: number, lng: number): void {
		// Update GPS coordinates if switch is enabled
		if (this.showGpsCoordinates) {
			this.currentLat = lat;
			this.currentLng = lng;
			this.fetchAltitudeForCoordinates(lat, lng, 'current');
		}

		// Update address if switch is enabled
		if (this.showAddress) {
			this.clickedLat = lat;
			this.clickedLng = lng;
			this.clickedAlt = null;
			this.clickedAddress = 'Loading address...';
		}

		// Update weather if switch is enabled
		if (this.showWeather) {
			this.clickedWeatherLat = lat;
			this.clickedWeatherLng = lng;
			this.clickedWeatherAlt = null;
			this.clickedWeatherAddress = '';
			this.isLoadingWeather = true;
		}

		this.cdr.detectChanges();

		// Fetch address (optimized: if both switches are enabled, fetch once and share)
		if (this.showAddress && this.showWeather) {
			// Both enabled: fetch address once and share it
			this.getAddressFromCoordinates(lat, lng, true);
		} else if (this.showAddress) {
			// Only address enabled
			this.getAddressFromCoordinates(lat, lng);
		} else if (this.showWeather) {
			// Only weather enabled
			this.getAddressFromCoordinatesForWeather(lat, lng);
		}

		// Fetch altitude (always fetch if at least one switch is enabled)
		if (this.showAddress || this.showWeather || this.showGpsCoordinates) {
			this.fetchAltitudeForCoordinates(lat, lng, 'clicked');
		}

		// Fetch weather if switch is enabled
		if (this.showWeather) {
			setTimeout(() => {
				this.fetchWeather(lat, lng, this.clickedWeatherAlt);
			}, 100);
		}
	}

	/**
	 * Show address in overlay when clicking on a marker
	 * Works independently of showGpsCoordinates switch
	 * Note: This method should only be called when showAddress is true
	 */
	private showAddressInOverlay(lat: number, lng: number): void {
		// Use the unified method to update all switches
		this.updateSwitchesForPoint(lat, lng);
	}

	/**
	 * Fetch altitude for coordinates
	 */
	private fetchAltitudeForCoordinates(lat: number, lng: number, type: 'current' | 'clicked'): void {
		this.apiService.getAllAltitudes(lat, lng, null).subscribe({
			next: (response) => {
				if (response.altitudes && Array.isArray(response.altitudes) && response.altitudes.length > 0) {
					// Use the first altitude (highest priority)
					const altitude = response.altitudes[0].altitude;
					const finiteAlt = typeof altitude === 'number' && Number.isFinite(altitude) ? altitude : null;
					if (type === 'current') {
						this.currentAlt = finiteAlt;
					} else {
						this.clickedAlt = finiteAlt;
						this.clickedWeatherAlt = finiteAlt; // Also update weather altitude
					}
					this.scheduleTraceViewerCdr();
				}
			},
			error: (error) => {
				console.debug('Could not fetch altitude:', error);
				if (type === 'current') {
					this.currentAlt = null;
				} else {
					this.clickedAlt = null;
				}
			}
		});
	}

	/**
	 * Get full address from coordinates using reverse geocoding (Nominatim)
	 * @param alsoUpdateWeatherAddress If true, also update clickedWeatherAddress to avoid duplicate API calls
	 */
	private getAddressFromCoordinates(lat: number, lng: number, alsoUpdateWeatherAddress: boolean = false): void {
		// Use Nominatim (OpenStreetMap) for reverse geocoding - free and no API key required
		const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;

		fetch(url, {
			headers: {
				'User-Agent': 'PATTOOL Weather App', // Required by Nominatim
				'Accept': 'application/json'
			}
		})
			.then(response => {
				if (!response.ok) {
					throw new Error(`HTTP error! status: ${response.status}`);
				}
				return response.json();
			})
			.then(data => {
				let address = '';
				if (data && data.display_name) {
					address = data.display_name;
				} else {
					address = 'Address not found';
				}

				// Update overlay with address
				this.clickedAddress = address;

				// Also update weather address if requested (to avoid duplicate API calls)
				if (alsoUpdateWeatherAddress) {
					this.clickedWeatherAddress = address;
				}

				this.cdr.detectChanges();
			})
			.catch(error => {
				console.error('Could not get address from coordinates:', error);
				const errorAddress = 'Address not available';
				this.clickedAddress = errorAddress;

				// Also update weather address if requested
				if (alsoUpdateWeatherAddress) {
					this.clickedWeatherAddress = errorAddress;
				}

				this.cdr.detectChanges();
			});
	}

}

