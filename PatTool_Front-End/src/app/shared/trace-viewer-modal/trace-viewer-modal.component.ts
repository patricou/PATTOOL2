import { ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener, Inject, OnDestroy, Output, TemplateRef, ViewChild } from '@angular/core';
import { CommonModule, DOCUMENT } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgbModule, NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FileService } from '../../services/file.service';
import { KeycloakService } from '../../keycloak/keycloak.service';
import { ApiService } from '../../services/api.service';
import { Subject } from 'rxjs';
import { take, takeUntil } from 'rxjs/operators';
import * as L from 'leaflet';

interface TraceViewerSource {
	fileId?: string;
	blob?: Blob;
	fileName: string;
	location?: { lat: number; lng: number; label?: string };
	positions?: Array<{ lat: number; lng: number; type?: string; datetime?: Date; label?: string }>;
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

	// Event color for styling
	private eventColor: { r: number; g: number; b: number } | null = null;
	private mapMoveHandler?: () => void;
	private mapMouseMoveHandler?: (e: L.LeafletMouseEvent) => void;
	private mapMouseOutHandler?: () => void;
	private addressClickHandler?: (e: L.LeafletMouseEvent) => void;
	private mapClickHandler?: (e: L.LeafletMouseEvent) => void;

	private readonly destroy$ = new Subject<void>();
	private modalRef?: NgbModalRef;
	private map?: L.Map;
	private overlayLayer?: L.LayerGroup;
	private pendingTrackPoints: L.LatLngTuple[] | null = null;
	private pendingLocation: { lat: number; lng: number; label?: string } | null = null;
	private pendingPositions: Array<{ lat: number; lng: number; type?: string; datetime?: Date; label?: string }> | null = null;
	private lastRenderedPosition: { lat: number; lng: number } | null = null; // Store the most recent position after rendering
	private selectionMode: boolean = false;
	private simpleShareMode: boolean = false;
	private selectionMarker?: L.Marker;
	private clickMarker?: L.Marker;
	private locationSelectionClickHandler?: (e: L.LeafletMouseEvent) => void;

	private static leafletIconsConfigured = false;
	private fullscreenChangeHandler?: () => void;
	private baseLayers: Record<string, L.TileLayer | L.LayerGroup> = {};
	public availableBaseLayers: Array<{ id: string; label: string }> = [];
	public selectedBaseLayerId: string = '';
	private activeBaseLayer?: L.TileLayer | L.LayerGroup;
	private thunderforestApiKey: string = '';
	public isFullscreenInfoVisible = false;
	private trackBounds: L.LatLngBounds | null = null;
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
		@Inject(DOCUMENT) private readonly document: Document
	) {
		this.configureLeafletIcons();
	}

	ngOnDestroy(): void {
		this.destroy$.next();
		this.destroy$.complete();
		this.close();
		this.destroyMap();
		this.cleanupFullscreenListener();
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

	public openFromFile(fileId: string, fileName: string, eventColor?: { r: number; g: number; b: number }): void {
		// Store event color if provided
		if (eventColor) {
			this.eventColor = eventColor;
		} else {
			this.eventColor = null;
		}
		this.open({ fileId, fileName });
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

	public openAtLocation(lat: number, lng: number, label?: string, eventColor?: { r: number; g: number; b: number }, enableSelection: boolean = false, simpleShare: boolean = false): void {
		if (Number.isNaN(lat) || Number.isNaN(lng)) {
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
		const validPositions = positions.filter(p =>
			p.lat != null && p.lng != null &&
			!Number.isNaN(p.lat) && !Number.isNaN(p.lng)
		);

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

	public close(): void {
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

	public toggleFullscreen(): void {
		if (this.document.fullscreenElement) {
			this.document.exitFullscreen().catch(() => { });
			return;
		}

		const wrapper = this.getFullscreenWrapper();
		if (wrapper && wrapper.requestFullscreen) {
			wrapper.requestFullscreen().then(() => {
				this.map?.invalidateSize();
				this.tryRenderPendingTrack();
				this.tryRenderPendingLocation();
			}).catch(() => { });
		}
	}

	private open(source: TraceViewerSource): void {
		this.resetState();
		this.trackFileName = source.fileName;
		this.initializeBaseLayers();
		this.pendingLocation = source.location ?? null;
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

		this.modalRef = this.modalService.open(this.traceViewerModal, {
			size: 'xl',
			centered: true,
			backdrop: 'static',
			keyboard: true,
			windowClass: 'slideshow-modal-wide modal-smooth-animation',
			modalDialogClass: 'modal-xl'
		});
		this.hasEmittedClosed = false;

		const finalizeModal = () => {
			this.resetModalState();
		};

		this.modalRef.closed.pipe(take(1)).subscribe(() => finalizeModal());
		this.modalRef.dismissed.pipe(take(1)).subscribe(() => finalizeModal());
		this.subscribeToModalVisibility();
		this.registerFullscreenListener();
		this.registerEscapeKeydownListener();

		// Apply event color after modal is rendered
		if (this.eventColor) {
			setTimeout(() => {
				this.applyEventColorToTraceViewer();
			}, 100);
		} else {
			this.resetTraceViewerColors();
		}

		if (this.pendingPositions) {
			this.scheduleMapInitialization();
		} else if (this.pendingLocation) {
			this.scheduleMapInitialization();
		}

		if (source.blob) {
			this.readFromBlob(source.blob, source.fileName);
		} else if (source.fileId) {
			this.loadFromFileId(source.fileId, source.fileName);
		} else if (source.positions && source.positions.length > 0) {
			this.ensureMapInitialization();
			this.tryRenderPendingPositions();
		} else if (source.location) {
			this.ensureMapInitialization();
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
			this.scheduleMapInitialization();
		}

		if (hidden$?.pipe) {
			hidden$?.pipe(take(1)).subscribe(() => {
				this.isFullscreen = false;
				this.destroyMap();
			});
		}
	}

	private forceCrosshairCursor(): void {
		if (this.map && this.map.getContainer()) {
			const mapContainer = this.map.getContainer();
			// Custom red crosshair cursor (larger, red)
			const redCrosshairCursor = 'url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><line x1="16" y1="0" x2="16" y2="12" stroke="red" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="20" x2="16" y2="32" stroke="red" stroke-width="2" stroke-linecap="round"/><line x1="0" y1="16" x2="12" y2="16" stroke="red" stroke-width="2" stroke-linecap="round"/><line x1="20" y1="16" x2="32" y2="16" stroke="red" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="16" r="2" fill="red"/></svg>\') 16 16, crosshair';
			// Force crosshair cursor via inline style (highest priority)
			mapContainer.style.cursor = redCrosshairCursor;
			// Also remove leaflet-grab class if present
			mapContainer.classList.remove('leaflet-grab');

			// Force cursor on all panes
			const panes = mapContainer.querySelectorAll('.leaflet-pane, .leaflet-map-pane, .leaflet-tile-pane, .leaflet-overlay-pane');
			panes.forEach((pane: Element) => {
				(pane as HTMLElement).style.cursor = redCrosshairCursor;
			});
		}
	}

	private onModalShown(): void {
		this.cdr.detectChanges();
		this.initializeMap();
		this.ensureMapInitialization();
		this.tryRenderPendingTrack();
		this.tryRenderPendingPositions();
		this.tryRenderPendingLocation();
		// Register location selection if in selection mode - wait longer for map to be ready
		if (this.selectionMode) {
			setTimeout(() => {
				this.registerLocationSelection();
			}, 500);
		}

		// Apply event color after modal is fully shown
		if (this.eventColor) {
			setTimeout(() => {
				this.applyEventColorToTraceViewer();
			}, 150);
		}

		// Force multiple invalidateSize calls to ensure map renders correctly
		// This is necessary because Leaflet needs the container to be visible to calculate size
		setTimeout(() => {
			this.map?.invalidateSize();
			this.tryRenderPendingTrack();
			this.tryRenderPendingPositions();
			this.tryRenderPendingLocation();
		}, 50);

		setTimeout(() => {
			this.map?.invalidateSize();
			this.tryRenderPendingTrack();
			this.tryRenderPendingPositions();
			this.tryRenderPendingLocation();
		}, 150);

		setTimeout(() => {
			this.map?.invalidateSize();
			this.tryRenderPendingTrack();
			this.tryRenderPendingPositions();
			this.tryRenderPendingLocation();
		}, 300);
	}

	private scheduleMapInitialization(): void {
		const attempt = (delay: number) => {
			setTimeout(() => {
				this.cdr.detectChanges();
				this.initializeMap();
				this.ensureMapInitialization();
				this.tryRenderPendingTrack();
				this.tryRenderPendingPositions();
				this.tryRenderPendingLocation();
				// Force invalidateSize after each attempt
				if (this.map) {
					setTimeout(() => {
						this.map?.invalidateSize();
						this.tryRenderPendingTrack();
						this.tryRenderPendingPositions();
						this.tryRenderPendingLocation();
					}, 50);
				}
			}, delay);
		};

		attempt(0);
		attempt(100);
		attempt(250);
		attempt(400);
	}

	/**
	 * Patches an element's addEventListener to use passive listeners for touchstart events.
	 * Note: We do NOT make wheel events passive because Leaflet needs to call preventDefault()
	 * on wheel events to prevent page scrolling when zooming the map.
	 */
	private patchElementForPassiveListeners(element: Element): void {
		// Skip if already patched
		if ((element as any).__passivePatched) {
			return;
		}

		const elementAddEventListener = element.addEventListener.bind(element);
		element.addEventListener = function (
			type: string,
			listener: EventListenerOrEventListenerObject,
			options?: boolean | AddEventListenerOptions
		) {
			// Only make touchstart events passive (not wheel - Leaflet needs preventDefault for wheel)
			if (type === 'touchstart') {
				if (typeof options === 'object' && options !== null) {
					// If passive is not explicitly set to false, make it true
					if (options.passive === undefined) {
						options = { ...options, passive: true };
					}
				} else if (options === undefined || options === false) {
					// Convert to object with passive: true, capture: false
					options = { passive: true, capture: false };
				}
				// If options is explicitly true (capture only), keep it but add passive
				else if (options === true) {
					options = { passive: true, capture: true };
				}
			}

			return elementAddEventListener.call(this, type, listener, options);
		};

		(element as any).__passivePatched = true;
	}

	/**
	 * Patches addEventListener on the container and all its children to use passive listeners
	 * for touchstart events to avoid browser console violations.
	 * Note: Wheel events are NOT made passive because Leaflet needs preventDefault() for zooming.
	 * This should be called before creating the map.
	 */
	private patchContainerForPassiveListeners(container: HTMLElement): void {
		// Patch the container itself
		this.patchElementForPassiveListeners(container);

		// Patch all existing child elements
		const allElements = container.querySelectorAll('*');
		allElements.forEach((el) => this.patchElementForPassiveListeners(el));

		// Use MutationObserver to patch dynamically added elements (only if not already observing)
		if (!(container as any).__passiveObserver) {
			const observer = new MutationObserver((mutations) => {
				mutations.forEach((mutation) => {
					mutation.addedNodes.forEach((node) => {
						if (node.nodeType === Node.ELEMENT_NODE) {
							this.patchElementForPassiveListeners(node as Element);
							// Also patch children of added nodes
							const children = (node as Element).querySelectorAll('*');
							children.forEach((el) => this.patchElementForPassiveListeners(el));
						}
					});
				});
			});

			observer.observe(container, {
				childList: true,
				subtree: true
			});

			// Store observer for cleanup if needed
			(container as any).__passiveObserver = observer;
		}
	}

	private initializeMap(): void {
		if (this.map) {
			return;
		}

		const container = this.mapContainerRef?.nativeElement ?? this.findMapContainerElement();
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
			// Wait a bit more for the container to become visible
			setTimeout(() => this.initializeMap(), 100);
			return;
		}

		// Patch container for passive listeners BEFORE creating the map
		// This ensures Leaflet's event listeners will use passive mode
		this.patchContainerForPassiveListeners(container);

		container.innerHTML = '';

		this.map = L.map(container, {
			zoomControl: true,
			attributionControl: true,
			zoomDelta: 1.5,
			zoomSnap: 0.5,
			scrollWheelZoom: true
		});

		// Ensure all Leaflet-created elements are patched for passive listeners
		// Use a small delay to let Leaflet finish its DOM initialization
		setTimeout(() => {
			const allElements = container.querySelectorAll('*');
			allElements.forEach((el) => this.patchElementForPassiveListeners(el));
		}, 0);

		// Force crosshair cursor on map container
		this.forceCrosshairCursor();

		this.overlayLayer = L.layerGroup().addTo(this.map);
		this.map.setView([46.2, 2.2], 6);
		this.applySelectedBaseLayer();
		this.registerRightClickZoom();

		// Maintain crosshair cursor even when Leaflet changes classes
		this.map.on('moveend', () => this.forceCrosshairCursor());
		this.map.on('zoomend', () => this.forceCrosshairCursor());

		const invalidate = () => {
			this.tryRenderPendingTrack();
			this.tryRenderPendingPositions();
			this.tryRenderPendingLocation();
			// Force multiple invalidateSize calls to ensure proper rendering
			setTimeout(() => {
				this.map?.invalidateSize();
				this.tryRenderPendingTrack();
				this.tryRenderPendingPositions();
				this.tryRenderPendingLocation();
			}, 50);
			setTimeout(() => {
				this.map?.invalidateSize();
				this.tryRenderPendingTrack();
				this.tryRenderPendingPositions();
				this.tryRenderPendingLocation();
			}, 150);
		};

		this.map.whenReady(() => {
			invalidate();
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
			// Additional invalidateSize after map is ready
			setTimeout(() => {
				this.map?.invalidateSize();
			}, 100);
		});

		// Ensure base layer is loaded before invalidating
		if (this.baseLayers['osm-standard']) {
			this.baseLayers['osm-standard'].once('load', () => {
				invalidate();
			});
		}

		// Force invalidateSize after a short delay to ensure container is fully rendered
		setTimeout(() => {
			this.map?.invalidateSize();
		}, 200);
	}

	private ensureMapInitialization(): void {
		if (this.map) {
			return;
		}

		if (this.mapContainerRef || this.findMapContainerElement()) {
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

	private tryRenderPendingTrack(): void {
		if (!this.map || !this.overlayLayer || !this.pendingTrackPoints) {
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
		this.map.fitBounds(bounds, { padding: [24, 24] });

		// Force multiple invalidateSize calls to ensure map renders correctly
		this.map.invalidateSize();
		setTimeout(() => {
			this.map?.invalidateSize();
		}, 50);
		setTimeout(() => {
			this.map?.invalidateSize();
		}, 150);
		setTimeout(() => {
			this.map?.invalidateSize();
		}, 300);

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
			this.map.fitBounds(bounds, { padding: [24, 24] });
		}

		// Calculate statistics
		this.trackStats = {
			points: points.length,
			distanceKm: points.length > 1 ? this.computeDistance(points) : null
		};

		this.map.invalidateSize();
		setTimeout(() => {
			this.map?.invalidateSize();
		}, 50);
		setTimeout(() => {
			this.map?.invalidateSize();
		}, 150);
		setTimeout(() => {
			this.map?.invalidateSize();
		}, 300);

		this.cdr.detectChanges();
	}

	private tryRenderPendingLocation(): void {
		if (!this.map || !this.overlayLayer || !this.pendingLocation) {
			return;
		}

		const { lat, lng, label } = this.pendingLocation;

		// Store the location for share functionality
		this.lastRenderedPosition = { lat, lng };

		// In selection mode, don't create the standard marker (will be created by registerLocationSelection)
		// and keep pendingLocation so registerLocationSelection can use it
		if (this.selectionMode) {
			// Just set the view and keep pendingLocation for registerLocationSelection
			this.trackBounds = L.latLngBounds([lat, lng], [lat, lng]);
			this.map.setView([lat, lng], 14);
			return;
		}

		// Normal mode: create standard marker
		this.pendingLocation = null;

		this.overlayLayer.clearLayers();

		const marker = L.marker([lat, lng]);
		if (label && label.trim().length > 0) {
			// Update switches on click - no popup needed
			marker.on('click', (e: L.LeafletMouseEvent) => {
				e.originalEvent?.stopPropagation();
				L.DomEvent.stopPropagation(e);
				if (e.originalEvent) {
					L.DomEvent.preventDefault(e.originalEvent);
				}
				// Update all switches independently
				this.updateSwitchesForPoint(lat, lng);
			});
		}
		marker.addTo(this.overlayLayer);

		this.trackBounds = L.latLngBounds([lat, lng], [lat, lng]);
		this.map.setView([lat, lng], 14);

		// Show address automatically for initial location if address display is enabled
		if (this.showAddress) {
			this.showAddressInOverlay(lat, lng);
		}

		// Force multiple invalidateSize calls to ensure map renders correctly
		this.map.invalidateSize();
		setTimeout(() => {
			this.map?.invalidateSize();
		}, 50);
		setTimeout(() => {
			this.map?.invalidateSize();
		}, 150);
		setTimeout(() => {
			this.map?.invalidateSize();
		}, 300);

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

	private resetState(): void {
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
		this.cleanupMapMoveHandler();
		this.cleanupMapMouseMoveHandler();
		this.cleanupAddressClickHandler();
		this.cleanupMapClickHandler();
		this.destroyMap();
		this.cdr.detectChanges();
	}

	private destroyMap(): void {
		if (this.map) {
			this.cleanupRightClickZoom();
			this.cleanupLocationSelection();
			this.cleanupMapMoveHandler();
			this.cleanupMapMouseMoveHandler();
			this.map.remove();
			this.map = undefined;
		}
		this.overlayLayer = undefined;
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
		const results: Element[] = [];
		const exactMatches = element.getElementsByTagName(tagName);
		for (let i = 0; i < exactMatches.length; i++) {
			results.push(exactMatches.item(i)!);
		}

		const upperMatches = element.getElementsByTagName(tagName.toUpperCase());
		for (let i = 0; i < upperMatches.length; i++) {
			results.push(upperMatches.item(i)!);
		}

		const lowerMatches = element.getElementsByTagName(tagName.toLowerCase());
		for (let i = 0; i < lowerMatches.length; i++) {
			results.push(lowerMatches.item(i)!);
		}

		return results;
	}

	private extractLatLngFromAttributes(node: Element): L.LatLngTuple | null {
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
			if (!isActive) {
				this.isFullscreenInfoVisible = false;
			}
			this.cdr.detectChanges();
			setTimeout(() => {
				this.map?.invalidateSize();
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

	private findMapContainerElement(): HTMLDivElement | null {
		let element = this.document.getElementById('trace-viewer-map-container') as HTMLDivElement | null;
		if (!element) {
			const dialog = this.document.querySelector('.trace-viewer-dialog .map-container') as HTMLDivElement | null;
			element = dialog ?? null;
		}

		return element ?? null;
	}

	private getFullscreenWrapper(): HTMLElement | null {
		const container = this.mapContainerRef?.nativeElement ?? this.findMapContainerElement();
		return container?.closest('.map-wrapper') ?? container?.parentElement ?? null;
	}

	private initializeBaseLayers(): void {
		if (Object.keys(this.baseLayers).length > 0) {
			return;
		}

		// Create base layers first (without OpenCycleMap)
		this.createBaseLayers();

		// IGN open data layers don't require API key - removed API key fetching
		// Only SCAN 25/100/OACI require personal API keys

		// Fetch Thunderforest API key from backend and add OpenCycleMap when available
		this.apiService.getThunderforestApiKey().pipe(
			takeUntil(this.destroy$)
		).subscribe({
			next: (apiKey: string) => {
				if (apiKey && apiKey.trim().length > 0) {
					this.thunderforestApiKey = apiKey;
					// Add OpenCycleMap layer
					this.baseLayers['opencyclemap'] = L.tileLayer('https://{s}.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=' + this.thunderforestApiKey, {
						maxZoom: 18,
						subdomains: ['a', 'b', 'c'],
						attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://www.thunderforest.com">Thunderforest</a>'
					});
					// Add to available layers list and sort alphabetically
					const openCycleMapEntry = { id: 'opencyclemap', label: 'OpenCycleMap (Randonnée/Vélo)' };
					this.availableBaseLayers.push(openCycleMapEntry);
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
				// Create a hybrid layer: SCAN-REGIONAL for zoom 0-12, then PLANIGNV2 for zoom 13-19
				// This provides classic IGN maps at lower zooms and detailed topographic maps at higher zooms
				const scanRegional = L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=IGNF_CARTES_SCAN-REGIONAL&STYLE=SCANREG&FORMAT=image/jpeg&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
					minZoom: 0,
					maxZoom: 13,
					attribution: '&copy; IGN - GÃ©oportail',
					zIndex: 1
				});
				const planIgn = L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
					minZoom: 12,
					maxZoom: 19,
					attribution: '&copy; IGN - GÃ©oportail',
					zIndex: 2
				});
				// Return a layer group that combines both
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
			// Hiking and outdoor maps
			'osm-hot': L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
				maxZoom: 19,
				subdomains: ['a', 'b', 'c'],
				attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Tiles style by <a href="https://www.hotosm.org/" target="_blank">HOT</a>'
			})
		};

		this.availableBaseLayers = [
			{ id: 'osm-standard', label: 'OpenStreetMap' },
			{ id: 'osm-fr', label: 'OpenStreetMap France' },
			{ id: 'esri-imagery', label: 'Esri Satellite' },
			// { id: 'esri-topo', label: 'Esri Topographique' },
			// { id: 'esri-street', label: 'Esri Streets' },
			{ id: 'opentopomap', label: 'OpenTopoMap' },
			// { id: 'esri-light-gray', label: 'Esri Light Gray' },
			{ id: 'ign-classic', label: 'Carte IGN classique' },
			{ id: 'ign-plan', label: 'IGN Plan' },
			{ id: 'ign-ortho', label: 'IGN Ortho' },
			{ id: 'ign-cadastre', label: 'IGN Cadastre' },
			// { id: 'ign-cartes', label: 'IGN Cartes (Scan Express)' }, // Commented out - layer not available
			// { id: 'ign-limites', label: 'IGN Limites Administratives' },
			{ id: 'ign-topo', label: 'Carte Topographique IGN' },
			// { id: 'ign-relief', label: 'IGN Relief' },
			// { id: 'ign-routes', label: 'IGN Routes' },
			// { id: 'ign-scan-express', label: 'SCAN 25® : carte topographique détaillée à 1:25 000' }, // Commented out - layer returns 400 error, may require personal API key or correct layer name
			// { id: 'ign-bd-topo', label: 'IGN BD Topo' }, // Commented out - not available as simple WMTS tile layer
			// Hiking and outdoor maps (OpenCycleMap will be added when API key is fetched)
			{ id: 'osm-hot', label: 'OSM Humanitarian' }
		].sort((a, b) => a.label.localeCompare(b.label));

		this.selectedBaseLayerId = 'opentopomap';
	}

	public onBaseLayerChange(layerId: string): void {
		this.selectedBaseLayerId = layerId;
		this.applySelectedBaseLayer();
	}

	public toggleFullscreenInfo(): void {
		if (!this.isFullscreen) {
			return;
		}
		this.isFullscreenInfoVisible = !this.isFullscreenInfoVisible;
	}

	private applySelectedBaseLayer(): void {
		if (!this.map) {
			return;
		}

		if (this.activeBaseLayer) {
			this.map.removeLayer(this.activeBaseLayer);
		}

		const nextLayer = this.baseLayers[this.selectedBaseLayerId] ?? this.baseLayers['osm-standard'];
		if (nextLayer) {
			nextLayer.addTo(this.map);
			this.activeBaseLayer = nextLayer;

			// Force map to redraw and invalidate size
			this.map.invalidateSize();

			// Additional invalidateSize calls with delays to ensure tiles load properly
			setTimeout(() => {
				this.map?.invalidateSize();
			}, 50);
			setTimeout(() => {
				this.map?.invalidateSize();
			}, 200);

			// Force redraw of the layer to ensure all tiles are visible
			if (nextLayer instanceof L.TileLayer) {
				nextLayer.redraw();
			} else if (nextLayer instanceof L.LayerGroup) {
				// For layer groups (like OSM France hybrid), redraw all tile layers inside
				nextLayer.eachLayer((layer) => {
					if (layer instanceof L.TileLayer) {
						layer.redraw();
					}
				});
			}



			// Force tile loading by triggering a zoom event (most reliable method)
			setTimeout(() => {
				if (this.map) {
					const currentZoom = this.map.getZoom();
					// Zoom in slightly then back to trigger tile loading
					this.map.setZoom(currentZoom + 0.01, { animate: false });
					setTimeout(() => {
						this.map?.setZoom(currentZoom, { animate: false });
						// Final invalidateSize to ensure rendering
						setTimeout(() => {
							this.map?.invalidateSize();
						}, 100);
					}, 100);
				}
			}, 100);
		}
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
		this.map.fitBounds(this.trackBounds, { padding: [24, 24] });
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
		this.removeEscapeKeydownListener();
		this.isFullscreen = false;
		this.isFullscreenInfoVisible = false;
		this.destroyMap();
		this.cleanupFullscreenListener();
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
				this.clickedAlt = alt;
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
			},
			error: (error) => {
				console.error('Error fetching weather:', error);
				this.currentWeather = null;
				this.isLoadingWeather = false;
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
					if (type === 'current') {
						this.currentAlt = altitude;
					} else {
						this.clickedAlt = altitude;
						this.clickedWeatherAlt = altitude; // Also update weather altitude
					}
					this.cdr.detectChanges();
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

