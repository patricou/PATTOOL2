import { ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener, Inject, OnDestroy, Output, TemplateRef, ViewChild } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { TranslateService } from '@ngx-translate/core';
import { FileService } from '../../services/file.service';
import { environment } from '../../../environments/environment';
import { Subject } from 'rxjs';
import { take, takeUntil } from 'rxjs/operators';
import * as L from 'leaflet';

interface TraceViewerSource {
	fileId?: string;
	blob?: Blob;
	fileName: string;
	location?: { lat: number; lng: number; label?: string };
}

interface TraceStatistics {
	points: number;
	distanceKm: number | null;
}

@Component({
	selector: 'app-trace-viewer-modal',
	templateUrl: './trace-viewer-modal.component.html',
	styleUrls: ['./trace-viewer-modal.component.css']
})
export class TraceViewerModalComponent implements OnDestroy {
	@ViewChild('traceViewerModal') traceViewerModal!: TemplateRef<any>;
	@ViewChild('mapContainer', { static: false }) mapContainerRef?: ElementRef<HTMLDivElement>;
	@Output() closed = new EventEmitter<void>();

	public isLoading = false;
	public hasError = false;
	public errorMessage = '';
	public trackFileName = '';
	public trackStats: TraceStatistics | null = null;
	public isFullscreen = false;

	// Event color for styling
	private eventColor: { r: number; g: number; b: number } | null = null;

	private readonly destroy$ = new Subject<void>();
	private modalRef?: NgbModalRef;
	private map?: L.Map;
	private overlayLayer?: L.LayerGroup;
	private pendingTrackPoints: L.LatLngTuple[] | null = null;
	private pendingLocation: { lat: number; lng: number; label?: string } | null = null;

	private static leafletIconsConfigured = false;
	private fullscreenChangeHandler?: () => void;
	private baseLayers: Record<string, L.TileLayer> = {};
	public availableBaseLayers: Array<{ id: string; label: string }> = [];
	public selectedBaseLayerId: string = '';
	private activeBaseLayer?: L.TileLayer;
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
	}

	@HostListener('window:keydown.escape', ['$event'])
	onEscape(event: KeyboardEvent): void {
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

	public openAtLocation(lat: number, lng: number, label?: string, eventColor?: { r: number; g: number; b: number }): void {
		if (Number.isNaN(lat) || Number.isNaN(lng)) {
			return;
		}

		const fallback = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
		const fileName = label && label.trim().length > 0 ? label : fallback;

		// Store event color if provided
		if (eventColor) {
			this.eventColor = eventColor;
		} else {
			this.eventColor = null;
		}

		this.open({
			fileName,
			location: { lat, lng, label }
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
			this.document.exitFullscreen().catch(() => {});
			return;
		}

		const wrapper = this.getFullscreenWrapper();
		if (wrapper && wrapper.requestFullscreen) {
			wrapper.requestFullscreen().then(() => {
				this.map?.invalidateSize();
				this.tryRenderPendingTrack();
				this.tryRenderPendingLocation();
			}).catch(() => {});
		}
	}

	private open(source: TraceViewerSource): void {
		this.resetState();
		this.trackFileName = source.fileName;
		this.initializeBaseLayers();
		this.pendingLocation = source.location ?? null;
		if (this.pendingLocation) {
			this.pendingTrackPoints = null;
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

		if (this.pendingLocation) {
			this.scheduleMapInitialization();
		}

		if (source.blob) {
			this.readFromBlob(source.blob, source.fileName);
		} else if (source.fileId) {
			this.loadFromFileId(source.fileId, source.fileName);
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

	private onModalShown(): void {
		this.cdr.detectChanges();
		this.initializeMap();
		this.ensureMapInitialization();
		this.tryRenderPendingTrack();
		this.tryRenderPendingLocation();

		// Apply event color after modal is fully shown
		if (this.eventColor) {
			setTimeout(() => {
				this.applyEventColorToTraceViewer();
			}, 150);
		}

		setTimeout(() => {
			this.map?.invalidateSize();
			this.tryRenderPendingTrack();
			this.tryRenderPendingLocation();
		}, 120);
	}

	private scheduleMapInitialization(): void {
		const attempt = (delay: number) => {
			setTimeout(() => {
				this.cdr.detectChanges();
				this.initializeMap();
				this.ensureMapInitialization();
				this.tryRenderPendingTrack();
				this.tryRenderPendingLocation();
			}, delay);
		};

		attempt(0);
		attempt(60);
		attempt(180);
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

		container.innerHTML = '';

		this.map = L.map(container, {
			zoomControl: true,
			attributionControl: true,
			zoomDelta: 1.5,
			zoomSnap: 0.5,
			scrollWheelZoom: true
		});

		this.overlayLayer = L.layerGroup().addTo(this.map);
		this.map.setView([46.2, 2.2], 6);
		this.applySelectedBaseLayer();
		this.registerRightClickZoom();

		const invalidate = () => {
			this.tryRenderPendingTrack();
			this.tryRenderPendingLocation();
			setTimeout(() => {
				this.map?.invalidateSize();
				this.tryRenderPendingTrack();
				this.tryRenderPendingLocation();
			}, 100);
		};

		this.map.whenReady(() => {
			invalidate();
		});
		this.baseLayers['osm-standard'].once('load', () => {
			invalidate();
		});
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
		this.map.invalidateSize();

		this.trackStats = {
			points: points.length,
			distanceKm: this.computeDistance(points)
		};
		this.cdr.detectChanges();
	}

	private tryRenderPendingLocation(): void {
		if (!this.map || !this.overlayLayer || !this.pendingLocation) {
			return;
		}

		const { lat, lng, label } = this.pendingLocation;
		this.pendingLocation = null;

		this.overlayLayer.clearLayers();

		const marker = L.marker([lat, lng]);
		if (label && label.trim().length > 0) {
			marker.bindPopup(label);
		}
		marker.addTo(this.overlayLayer);

		this.trackBounds = L.latLngBounds([lat, lng], [lat, lng]);
		this.map.setView([lat, lng], 14);
		this.map.invalidateSize();

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
		this.destroyMap();
		this.cdr.detectChanges();
	}

	private destroyMap(): void {
		if (this.map) {
			this.cleanupRightClickZoom();
			this.map.remove();
			this.map = undefined;
		}
		this.overlayLayer = undefined;
		this.pendingTrackPoints = null;
		this.pendingLocation = null;
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

		this.baseLayers = {
			'osm-standard': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
				maxZoom: 19,
				attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
			}),
			'osm-fr': L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
				maxZoom: 20,
				subdomains: 'abc',
				attribution: '&copy; OpenStreetMap France & OSM contributors'
			}),
			'carto-light': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
				maxZoom: 19,
				subdomains: 'abcd',
				attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OSM contributors'
			}),
			'carto-dark': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
				maxZoom: 19,
				subdomains: 'abcd',
				attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OSM contributors'
			}),
			'carto-voyager': L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', {
				maxZoom: 19,
				subdomains: 'abcd',
				attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OSM contributors'
			}),
			'esri-imagery': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
				maxZoom: 19,
				attribution: 'Tiles &copy; Esri'
			}),
			'esri-topo': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
				maxZoom: 19,
				attribution: 'Tiles &copy; Esri'
			}),
			'esri-street': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
				maxZoom: 19,
				attribution: 'Tiles &copy; Esri'
			}),
			'opentopomap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
				maxZoom: 17,
				subdomains: 'abc',
				attribution: 'Map data: &copy; OSM contributors, SRTM'
			}),
			'esri-light-gray': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
				maxZoom: 16,
				attribution: 'Tiles &copy; Esri'
			}),
			'carto-positron-lite': L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/light_nolabels/{z}/{x}/{y}.png', {
				maxZoom: 19,
				subdomains: 'abcd',
				attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors'
			}),
			'carto-dark-matter-lite': L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png', {
				maxZoom: 19,
				subdomains: 'abcd',
				attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors'
			}),
			'hydda-full': L.tileLayer('https://{s}.tile.openstreetmap.se/hydda/full/{z}/{x}/{y}.png', {
				maxZoom: 18,
				attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
			}),
			'ign-plan': L.tileLayer(`https://data.geopf.fr/xyz/planignv2/{z}/{x}/{y}.png?apikey=${environment.IGN_API_KEY}`, {
				maxZoom: 19,
				attribution: '&copy; IGN - Géoportail'
			}),
			'ign-ortho': L.tileLayer(`https://data.geopf.fr/xyz/ortho/{z}/{x}/{y}.jpg?apikey=${environment.IGN_API_KEY}`, {
				maxZoom: 19,
				attribution: '&copy; IGN - Géoportail'
			})
		};

		this.availableBaseLayers = [
			{ id: 'osm-standard', label: 'OpenStreetMap' },
			{ id: 'osm-fr', label: 'OpenStreetMap France' },
			{ id: 'carto-light', label: 'Carto Light' },
			{ id: 'carto-dark', label: 'Carto Dark' },
			{ id: 'carto-voyager', label: 'Carto Voyager' },
			{ id: 'esri-imagery', label: 'Esri Satellite' },
			{ id: 'esri-topo', label: 'Esri Topographique' },
			{ id: 'esri-street', label: 'Esri Streets' },
			{ id: 'opentopomap', label: 'OpenTopoMap' },
			{ id: 'esri-light-gray', label: 'Esri Light Gray' },
			{ id: 'carto-positron-lite', label: 'Carto Positron Lite' },
			{ id: 'carto-dark-matter-lite', label: 'Carto Dark Matter Lite' },
			{ id: 'hydda-full', label: 'Hydda Full' },
			{ id: 'ign-plan', label: 'IGN Plan' },
			{ id: 'ign-ortho', label: 'IGN Ortho' }
		];

		this.selectedBaseLayerId = 'osm-fr';
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
			this.document.exitFullscreen().catch(() => {});
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
}

