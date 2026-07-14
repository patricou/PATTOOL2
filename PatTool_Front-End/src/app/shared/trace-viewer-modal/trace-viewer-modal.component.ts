import { ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener, Inject, OnDestroy, Output, TemplateRef, ViewChild } from '@angular/core';
import { CommonModule, DOCUMENT } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { NgbModule, NgbModal, NgbModalOptions, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Router } from '@angular/router';
import { FileService } from '../../services/file.service';
import { KeycloakService } from '../../keycloak/keycloak.service';
import { ApiService, TraceViewerPreference } from '../../services/api.service';
import { WeatherStationMapLayerService } from '../../services/weather-station-map-layer.service';
import { resolveWeatherStationProvider } from '../weather-station-map.util';
import { forkJoin, of, Subject } from 'rxjs';
import { catchError, take, takeUntil } from 'rxjs/operators';
import { WeatherPointTimelineComponent } from '../weather-point-timeline/weather-point-timeline.component';
import { environment } from '../../../environments/environment';
import * as L from 'leaflet';
import { isValidGeoCoordinate } from '../geo-coordinates.util';
import {
	extractGeocodeCityName,
	formatMfStationProximityLabel,
	formatGpsCoordinates,
	resolveMfStationDistanceKm,
	resolvePlaceNameFromGeocode,
	resolveWeatherPointLocationLabel,
} from '../weather-point-popup.util';

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

type TraceViewerWeatherBrand = 'meteofrance' | 'open-meteo' | 'openweathermap' | 'meteoswiss';
type TraceViewerWeatherActionBrand = 'meteofrance' | 'meteoswiss' | 'world';

interface CartesGouvEmbedLayerOption {
	id: string;
	label: string;
	labelKey?: string;
	/** WMTS layer id for cartes.gouv.fr embed `l=` parameter (before `$GEOPORTAIL:…`). */
	embedLayer: string;
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
		TranslateModule,
		WeatherPointTimelineComponent
	]
})
export class TraceViewerModalComponent implements OnDestroy {
	private static readonly LOGO_MF = 'assets/images/meteofrance-logo.svg';
	private static readonly LOGO_OPEN_METEO = 'assets/images/open-meteo-logo.svg';
	private static readonly LOGO_OWM = 'assets/images/openweathermap-logo.svg';
	private static readonly LOGO_MS = 'assets/images/meteoswiss-logo.svg';
	private static readonly MF_OBS_VIEWPORT_BOUNDS = {
		south: 42.0,
		north: 51.2,
		west: -5.2,
		east: 8.5,
	};
	private static readonly CH_OBS_VIEWPORT_BOUNDS = {
		south: 45.82,
		north: 47.81,
		west: 5.96,
		east: 10.49,
	};
	private static readonly CARTES_GOUV_EMBED_LAYER_SUFFIX = '$GEOPORTAIL:OGC:WMTS(1;1;1;0)';
	private static readonly CARTES_GOUV_LAYER_STORAGE_KEY = 'pat.traceViewer.cartesGouvLayerId';
	private static readonly CARTES_GOUV_EMBED_LAYERS: CartesGouvEmbedLayerOption[] = [
		{ id: 'ign-maps', label: 'Cartes IGN', labelKey: 'EVENTELEM.CARTES_GOUV_LAYER_MAPS', embedLayer: 'GEOGRAPHICALGRIDSYSTEMS.MAPS' },
		{ id: 'ign-plan', label: 'Plan IGN', labelKey: 'EVENTELEM.CARTES_GOUV_LAYER_PLAN', embedLayer: 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2' },
		{ id: 'ign-scan-regional', label: 'Scan régional', labelKey: 'EVENTELEM.CARTES_GOUV_LAYER_SCAN', embedLayer: 'IGNF_CARTES_SCAN-REGIONAL' },
		{ id: 'ign-ortho', label: 'Orthophotos', labelKey: 'EVENTELEM.CARTES_GOUV_LAYER_ORTHO', embedLayer: 'ORTHOIMAGERY.ORTHOPHOTOS' },
		{ id: 'ign-cadastre', label: 'Cadastre', labelKey: 'EVENTELEM.CARTES_GOUV_LAYER_CADASTRRE', embedLayer: 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS' },
		{ id: 'ign-limites', label: 'Limites administratives', labelKey: 'EVENTELEM.CARTES_GOUV_LAYER_LIMITES', embedLayer: 'LIMITES_ADMINISTRATIVES_EXPRESS.LATEST' },
		{ id: 'ign-relief', label: 'Relief', labelKey: 'EVENTELEM.CARTES_GOUV_LAYER_RELIEF', embedLayer: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES' }
	];

	@ViewChild('traceViewerModal') traceViewerModal!: TemplateRef<any>;
	@ViewChild(WeatherPointTimelineComponent) weatherPointTimeline?: WeatherPointTimelineComponent;
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
	/** Météo-France / MeteoSwiss station temperature labels on the map (France / Switzerland). */
	public showWeatherStations: boolean = false;
	/** Last double-clicked point used to choose MF vs MeteoSwiss station layer. */
	private stationSelectionLat: number | null = null;
	private stationSelectionLng: number | null = null;
	private stationSelectionCountryCode = '';
	public isLoadingWeather: boolean = false;
	public clickedWeatherLat: number = 0;
	public clickedWeatherLng: number = 0;
	public clickedWeatherAlt: number | null = null;
	public clickedWeatherAddress: string = '';
	public clickedWeatherCountryCode = '';
	public weatherPointMfTempC: number | null = null;
	public weatherPointMsTempC: number | null = null;
	public weatherPointOpenMeteoTempC: number | null = null;
	public weatherPointOpenWeatherTempC: number | null = null;
	weatherTimelineVisible = false;
	public weatherPointMfObservedAt: string | null = null;
	public weatherPointMsObservedAt: string | null = null;
	public weatherPointOpenMeteoObservedAt: string | null = null;
	public weatherPointOpenWeatherObservedAt: string | null = null;
	public weatherPointMfStationName = '';
	public weatherPointMfStationId = '';
	public weatherPointMsStationName = '';
	public weatherPointMsStationId = '';
	public weatherPointPlaceName = '';
	/** Locality from reverse geocode (hamlet/village/town), preferred over OWM place name for popup title. */
	public weatherLocationName = '';
	public weatherCity = '';
	private weatherPointMfStationDistKm: number | null = null;
	private weatherPointMsStationDistKm: number | null = null;
	weatherTimelineLat = 0;
	weatherTimelineLon = 0;
	weatherTimelineTitleSnapshot = '';
	weatherTimelineMfTempC: number | null = null;
	weatherTimelineMsTempC: number | null = null;
	weatherTimelineOpenMeteoTempC: number | null = null;
	weatherTimelineOpenWeatherTempC: number | null = null;
	weatherTimelineMfObservedAt: string | null = null;
	weatherTimelineMsObservedAt: string | null = null;
	weatherTimelineOpenMeteoObservedAt: string | null = null;
	weatherTimelineOpenWeatherObservedAt: string | null = null;
	weatherTimelineStationId = '';
	weatherTimelineStationName = '';
	private weatherPointRequestId = 0;
	readonly weatherLogoMf = TraceViewerModalComponent.LOGO_MF;
	readonly weatherLogoMs = TraceViewerModalComponent.LOGO_MS;
	readonly weatherLogoOm = TraceViewerModalComponent.LOGO_OPEN_METEO;
	readonly weatherLogoOwm = TraceViewerModalComponent.LOGO_OWM;
	/** Show hiking trails overlay (Waymarked Trails) above the base map. */
	public showHikingTrailsOverlay: boolean = false;
	private hikingTrailsOverlay?: L.TileLayer;
	/** Show cycling trails overlay (Waymarked Trails) above the base map. */
	public showCyclingTrailsOverlay: boolean = false;
	private cyclingTrailsOverlay?: L.TileLayer;
	/** RainViewer precipitation radar when weather switch is on (same proxy as Météo-France). */
	private weatherRadarLayer?: L.TileLayer;
	private weatherRadarRefreshTimer: ReturnType<typeof setInterval> | null = null;
	private weatherRadarLoadRequestId = 0;
	private static readonly WEATHER_RADAR_OPACITY = 0.72;
	/** Global radar auto-refresh (MongoDB, shared with Météo-France). */
	public autoRefreshRadar = true;
	public radarRefreshCountdown = 0;
	private radarRefreshSeconds = 60;

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
	private mobileViewportResizeHandler?: () => void;
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
	/** Affiche l’interrupteur « garder l’écran actif » (mobile + Wake Lock API). */
	public showKeepScreenAwakeSwitch = false;
	readonly screenWakeLockAvailable =
		typeof navigator !== 'undefined' && 'wakeLock' in navigator;
	/** cartes.gouv.fr iframe embed URL (center + zoom) for that modal. */
	public cartesGouvEmbedUrl: SafeResourceUrl | null = null;
	public readonly cartesGouvEmbedLayers = TraceViewerModalComponent.CARTES_GOUV_EMBED_LAYERS;
	public selectedCartesGouvLayerId = 'ign-maps';
	private cartesGouvModalRef?: NgbModalRef;
	public cartesGouvFullscreen = false;
	private cartesGouvFullscreenChangeListener?: () => void;
	private thunderforestApiKey: string = '';
	public isFullscreenInfoVisible = false;
	/** Fullscreen options panel (basemap, switches, actions) — collapsed by default. */
	public isFullscreenOptionsExpanded = false;
	private trackBounds: L.LatLngBounds | null = null;
	/** Zoom to restore when recentering a single-point view (openAtLocation). */
	private locationRecenterZoom: number | null = null;
	private static readonly DEFAULT_LOCATION_ZOOM = 14;
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
	/** Avoid persisting while applying server-loaded preferences. */
	private applyingTraceViewerPrefs = false;
	private traceViewerPrefsReady = false;
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
		private readonly weatherStationMapLayer: WeatherStationMapLayerService,
		private readonly sanitizer: DomSanitizer,
		private readonly router: Router,
		@Inject(DOCUMENT) private readonly document: Document
	) {
		this.configureLeafletIcons();
		this.loadTraceViewerPreferences();
		this.loadRadarRefreshPreferences();
	}

	private loadTraceViewerPreferences(): void {
		this.apiService.getTraceViewerPreferences().pipe(takeUntil(this.destroy$)).subscribe({
			next: (pref) => {
				this.applyingTraceViewerPrefs = true;
				try {
					this.applyTraceViewerPreferences(pref);
					if (this.map) {
						this.applySelectedBaseLayer();
						this.applyPersistedSwitchEffects();
					}
				} finally {
					this.applyingTraceViewerPrefs = false;
					this.traceViewerPrefsReady = true;
				}
			},
			error: () => {
				this.traceViewerPrefsReady = true;
			}
		});
	}

	private applyTraceViewerPreferences(pref: TraceViewerPreference | null | undefined): void {
		if (!pref) {
			return;
		}
		if (pref.showAddress != null) {
			this.showAddress = pref.showAddress;
		}
		if (pref.showWeather != null) {
			this.showWeather = pref.showWeather;
		}
		if (pref.showWeatherStations != null) {
			this.showWeatherStations = pref.showWeatherStations;
		}
		if (pref.autoRefreshRadar != null) {
			this.autoRefreshRadar = pref.autoRefreshRadar;
		}
		if (pref.showHikingTrailsOverlay != null) {
			this.showHikingTrailsOverlay = pref.showHikingTrailsOverlay;
		}
		if (pref.showCyclingTrailsOverlay != null) {
			this.showCyclingTrailsOverlay = pref.showCyclingTrailsOverlay;
		}
		if (pref.followDeviceLocation != null) {
			this.followDeviceLocation = pref.followDeviceLocation;
		}
		if (pref.keepScreenAwake != null) {
			this.keepScreenAwake = pref.keepScreenAwake;
		}
		if (pref.showGpsCoordinates != null) {
			this.showGpsCoordinates = pref.showGpsCoordinates;
		}
		if (pref.baseLayerId && pref.baseLayerId !== 'cartes-gouv') {
			this.selectedBaseLayerId = pref.baseLayerId;
		}
	}

	private persistTraceViewerPreferences(): void {
		if (!this.traceViewerPrefsReady || this.applyingTraceViewerPrefs) {
			return;
		}
		const baseLayerId =
			this.selectedBaseLayerId === 'cartes-gouv'
				? (this.lastBaseLayerBeforeCartesGouv || 'opentopomap')
				: this.selectedBaseLayerId;
		this.apiService.saveTraceViewerPreferences({
			showAddress: this.showAddress,
			showWeather: this.showWeather,
			showWeatherStations: this.showWeatherStations,
			autoRefreshRadar: this.autoRefreshRadar,
			showHikingTrailsOverlay: this.showHikingTrailsOverlay,
			showCyclingTrailsOverlay: this.showCyclingTrailsOverlay,
			followDeviceLocation: this.followDeviceLocation,
			keepScreenAwake: this.keepScreenAwake,
			showGpsCoordinates: this.showGpsCoordinates,
			baseLayerId
		}).pipe(takeUntil(this.destroy$)).subscribe({ error: () => { /* keep local value */ } });
	}

	/** Re-apply overlay switches after map init (prefs loaded before open). */
	private applyPersistedSwitchEffects(): void {
		if (this.showGpsCoordinates) {
			this.toggleGpsCoordinates();
		}
		if (this.showAddress) {
			this.onShowAddressChange();
		}
		if (this.showWeather) {
			this.onShowWeatherChange();
		} else {
			this.applyWeatherRadarOverlay();
		}
		if (this.showWeatherStations) {
			this.seedStationSelectionFromExistingClick();
		}
		this.applyWeatherStationsOverlay();
		this.applyHikingTrailsOverlay();
		this.applyCyclingTrailsOverlay();
		if (this.followDeviceLocation) {
			this.startFollowDeviceLocation();
		}
		if (this.keepScreenAwake) {
			void this.acquireScreenWakeLock();
		}
	}

	private loadRadarRefreshPreferences(): void {
		this.apiService.getMeteoFranceRadarPreferences().pipe(takeUntil(this.destroy$)).subscribe({
			next: (pref) => {
				if (pref?.radarRefreshSeconds != null) {
					this.radarRefreshSeconds = pref.radarRefreshSeconds;
				}
				if (this.showWeather) {
					this.startWeatherRadarRefreshTimer();
				}
			},
			error: () => { /* keep defaults */ }
		});
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
		event.preventDefault();
		if (this.weatherPointTimeline?.isFullscreen()) {
			this.weatherPointTimeline.exitFullscreen();
			return;
		}
		if (this.weatherTimelineVisible) {
			this.closeWeatherTimeline();
			return;
		}
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
				// Allow over-zoom while keeping tiles (Leaflet will upscale above native).
				maxNativeZoom: isImage ? 19 : 18,
				maxZoom: 20,
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
				this.fitMapToTrackBounds(this.trackBounds);
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
		this.loadCartesGouvLayerPreference();
		this.selectedCartesGouvLayerId = this.resolveCartesGouvLayerIdForOpen();
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

	public onCartesGouvEmbedLayerChange(layerId: string): void {
		if (!layerId || !this.cartesGouvEmbedLayers.some((layer) => layer.id === layerId)) {
			return;
		}
		this.selectedCartesGouvLayerId = layerId;
		this.persistCartesGouvLayerPreference();
		if (!this.cartesGouvModalRef) {
			return;
		}
		let lat: number;
		let lng: number;
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
	}

	/** Update cartes.gouv.fr iframe URL from center+zoom (open + “follow my location” recenters). */
	private updateCartesGouvEmbedUrl(lat: number, lng: number, z: number): void {
		const c = `${lng.toFixed(6)},${lat.toFixed(6)}`;
		const layerParam = this.buildCartesGouvEmbedLayerParam(this.selectedCartesGouvLayerId);
		const embedUrl = `https://cartes.gouv.fr/explorer-les-cartes/embed?c=${encodeURIComponent(c)}&z=${z}&l=${encodeURIComponent(layerParam)}&permalinkShare=yes`;
		this.cartesGouvEmbedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(embedUrl);
		this.cdr.markForCheck();
	}

	private buildCartesGouvEmbedLayerParam(layerId: string): string {
		const layer = this.cartesGouvEmbedLayers.find((item) => item.id === layerId)
			?? this.cartesGouvEmbedLayers[0];
		return `${layer.embedLayer}${TraceViewerModalComponent.CARTES_GOUV_EMBED_LAYER_SUFFIX}`;
	}

	private resolveCartesGouvLayerIdForOpen(): string {
		const fromBaseLayer: Record<string, string> = {
			'ign-classic': 'ign-scan-regional',
			'ign-plan': 'ign-plan',
			'ign-ortho': 'ign-ortho',
			'ign-cadastre': 'ign-cadastre',
			'ign-topo': 'ign-plan'
		};
		const baseHint = fromBaseLayer[this.selectedBaseLayerId] ?? fromBaseLayer[this.lastBaseLayerBeforeCartesGouv];
		if (baseHint && this.cartesGouvEmbedLayers.some((layer) => layer.id === baseHint)) {
			return baseHint;
		}
		if (this.cartesGouvEmbedLayers.some((layer) => layer.id === this.selectedCartesGouvLayerId)) {
			return this.selectedCartesGouvLayerId;
		}
		return 'ign-maps';
	}

	private loadCartesGouvLayerPreference(): void {
		try {
			const stored = localStorage.getItem(TraceViewerModalComponent.CARTES_GOUV_LAYER_STORAGE_KEY);
			if (stored && this.cartesGouvEmbedLayers.some((layer) => layer.id === stored)) {
				this.selectedCartesGouvLayerId = stored;
			}
		} catch {
			/* ignore storage errors */
		}
	}

	private persistCartesGouvLayerPreference(): void {
		try {
			localStorage.setItem(TraceViewerModalComponent.CARTES_GOUV_LAYER_STORAGE_KEY, this.selectedCartesGouvLayerId);
		} catch {
			/* ignore storage errors */
		}
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
		this.refreshTraceViewerViewportFlags();
		this.registerMobileViewportListener();

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

	/** Reporte une mise à jour météo au tick suivant — évite NG0100 (ex. mfTempC null → 23.6). */
	private deferWeatherUiUpdate(update: () => void): void {
		setTimeout(() => {
			update();
			this.scheduleTraceViewerCdr();
		}, 0);
	}

	/** Évite NG0100 sur *ngIf="!isLoadingWeather" quand le switch météo change. */
	private setWeatherLoadingState(loading: boolean): void {
		this.deferWeatherUiUpdate(() => {
			this.isLoadingWeather = loading;
		});
	}

	get traceViewerTitleFull(): string {
		return this.translate('EVENTELEM.TRACK_VIEWER_TITLE', { fileName: this.trackFileName });
	}

	get weatherPointWeatherLocationLabel(): string {
		return resolveWeatherPointLocationLabel({
			geocodeName: this.weatherLocationName,
			openWeatherPlace: this.weatherPointPlaceName,
			city: this.weatherCity,
			lat: this.clickedWeatherLat,
			lon: this.clickedWeatherLng,
		});
	}

	get weatherPointMfStationLine(): string {
		return formatMfStationProximityLabel(
			this.weatherPointMfStationName,
			this.weatherPointMfStationId,
			this.weatherPointMfStationDistKm,
			(station, km) => this.translateService.instant('METEO_FRANCE.POINT_SOURCE_MF_NEAREST', { station, km })
		);
	}

	get weatherPointMsStationLine(): string {
		return formatMfStationProximityLabel(
			this.weatherPointMsStationName,
			this.weatherPointMsStationId,
			this.weatherPointMsStationDistKm,
			(station, km) => this.translateService.instant('METEO_FRANCE.POINT_SOURCE_MS_NEAREST', { station, km })
		);
	}

	private syncWeatherTimelineSnapshot(): void {
		this.weatherTimelineLat = this.clickedWeatherLat;
		this.weatherTimelineLon = this.clickedWeatherLng;
		this.weatherTimelineTitleSnapshot = this.weatherPointWeatherLocationLabel;
		this.weatherTimelineMfTempC = this.weatherPointMfTempC;
		this.weatherTimelineMsTempC = this.weatherPointMsTempC;
		this.weatherTimelineOpenMeteoTempC = this.weatherPointOpenMeteoTempC;
		this.weatherTimelineOpenWeatherTempC = this.weatherPointOpenWeatherTempC;
		this.weatherTimelineMfObservedAt = this.weatherPointMfObservedAt;
		this.weatherTimelineMsObservedAt = this.weatherPointMsObservedAt;
		this.weatherTimelineOpenMeteoObservedAt = this.weatherPointOpenMeteoObservedAt;
		this.weatherTimelineOpenWeatherObservedAt = this.weatherPointOpenWeatherObservedAt;
		if (this.isWeatherPointInSwitzerland()) {
			this.weatherTimelineStationId = this.weatherPointMsStationId;
			this.weatherTimelineStationName = this.weatherPointMsStationName;
		} else {
			this.weatherTimelineStationId = this.weatherPointMfStationId;
			this.weatherTimelineStationName = this.weatherPointMfStationName;
		}
	}

	private onModalShown(): void {
		this.setupModalWheelTrap();
		this.refreshTraceViewerViewportFlags();
		this.scheduleTraceViewerCdr();
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
				// Keep a consistent max zoom across basemaps; basemaps handle over-zoom via maxNativeZoom.
				maxZoom: 20,
				scrollWheelZoom: false,
				doubleClickZoom: false
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
			if (this.traceViewerCdrTimer != null) {
				clearTimeout(this.traceViewerCdrTimer);
				this.traceViewerCdrTimer = null;
			}
			this.traceViewerCdrTimer = window.setTimeout(() => {
				this.traceViewerCdrTimer = null;
				this.isMapReady = true;
				this.cdr.markForCheck();
			}, 0);
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
			// Register click handler for marker creation (always active)
			this.registerMapClickHandler();

			// Register address click handler (always active, but only updates if switch is enabled)
			this.registerAddressClickHandler();

			this.applyPersistedSwitchEffects();
			this.applyWeatherStationsOverlay();
		});
	}

	private normalizeTraceMapWheelDelta(event: WheelEvent): number {
		if (event.deltaMode === 0) {
			return event.deltaY / 160;
		}
		if (event.deltaMode === 1) {
			return event.deltaY / 5;
		}
		return event.deltaY / 0.9;
	}

	/** Pas dynamique (slideshow), appliqué sur le delta accumulé par frame. */
	private applyMapWheelZoomFromDelta(delta: number, current: number, minZoom: number, maxZoom: number): number {
		const baseStep = 0.55;
		const multiplier = 0.1;
		const dynamicStep = baseStep * (1 + current * multiplier);
		const minStep = 0.28;
		const maxStep = 2.6;
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

	/** True when bounds collapse to a single point (openAtLocation without GPX track). */
	private isDegenerateBounds(bounds: L.LatLngBounds): boolean {
		if (!bounds.isValid()) {
			return true;
		}
		const sw = bounds.getSouthWest();
		const ne = bounds.getNorthEast();
		return Math.abs(sw.lat - ne.lat) < 1e-7 && Math.abs(sw.lng - ne.lng) < 1e-7;
	}

	/** Max zoom supported by the active basemap (fitBounds beyond this shows gray tiles). */
	private resolveFitBoundsMaxZoom(): number {
		if (!this.map) {
			return TraceViewerModalComponent.DEFAULT_LOCATION_ZOOM;
		}
		const layer = this.activeBaseLayer;
		if (layer instanceof L.TileLayer) {
			return layer.options.maxZoom ?? this.map.getMaxZoom();
		}
		if (layer && 'getLayers' in layer) {
			let max = 2;
			for (const child of (layer as L.LayerGroup).getLayers()) {
				if (child instanceof L.TileLayer && child.options.maxZoom != null) {
					max = Math.max(max, child.options.maxZoom);
				}
			}
			if (max > 2) {
				return max;
			}
		}
		return Math.min(this.map.getMaxZoom(), 18);
	}

	/** Centrage trace : fitBounds avec plafond de zoom ; point unique → setView. */
	private fitMapToTrackBounds(bounds: L.LatLngBounds): void {
		if (!this.map || !bounds.isValid()) {
			return;
		}
		const maxZoom = this.resolveFitBoundsMaxZoom();
		if (this.isDegenerateBounds(bounds)) {
			const zoom = Math.min(
				maxZoom,
				Math.max(2, this.locationRecenterZoom ?? TraceViewerModalComponent.DEFAULT_LOCATION_ZOOM)
			);
			this.map.setView(bounds.getCenter(), zoom, { animate: false });
			this.currentZoom = zoom;
			return;
		}
		this.map.fitBounds(bounds, { padding: [24, 24], maxZoom });
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
		this.locationRecenterZoom = null;

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
		this.locationRecenterZoom = null;
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
			this.locationRecenterZoom = viewZoom;
			this.map.setView([lat, lng], viewZoom);
			this.refreshMapLayout();
			return;
		}

		// Normal mode: create standard marker
		this.pendingLocation = null;

		this.overlayLayer.clearLayers();
		this.locationRecenterZoom = viewZoom;

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
		this.locationRecenterZoom = null;
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
		this.currentLat = 0;
		this.currentLng = 0;
		this.currentAlt = null;
		this.clickedAddress = '';
		this.clickedLat = 0;
		this.clickedLng = 0;
		this.clickedAlt = null;
		this.stopFollowDeviceLocation();
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
		this.weatherRadarLoadRequestId++;
		this.clearWeatherRadarRefreshTimer();
		this.weatherRadarLayer = undefined;
		this.weatherStationMapLayer.detach();
		this.clearStationSelection();
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
		return this.computeMobileViewport();
	}

	private computeMobileViewport(): boolean {
		return (
			this.document.defaultView != null &&
			(this.document.defaultView.innerHeight <= 500 || this.document.defaultView.innerWidth <= 768)
		);
	}

	private refreshTraceViewerViewportFlags(): void {
		this.showKeepScreenAwakeSwitch = this.computeMobileViewport() && this.screenWakeLockAvailable;
	}

	private registerMobileViewportListener(): void {
		this.cleanupMobileViewportListener();
		const win = this.document.defaultView;
		if (!win) {
			return;
		}
		this.mobileViewportResizeHandler = () => {
			const next = this.computeMobileViewport() && this.screenWakeLockAvailable;
			if (next === this.showKeepScreenAwakeSwitch) {
				return;
			}
			this.showKeepScreenAwakeSwitch = next;
			this.scheduleTraceViewerCdr();
		};
		win.addEventListener('resize', this.mobileViewportResizeHandler, { passive: true });
	}

	private cleanupMobileViewportListener(): void {
		const win = this.document.defaultView;
		if (win && this.mobileViewportResizeHandler) {
			win.removeEventListener('resize', this.mobileViewportResizeHandler);
		}
		this.mobileViewportResizeHandler = undefined;
	}

	/** Active/désactive le verrouillage d'écran (empêche la mise en veille du smartphone). */
	public onKeepScreenAwakeChange(): void {
		if (this.keepScreenAwake) {
			void this.acquireScreenWakeLock();
		} else {
			void this.releaseScreenWakeLock();
		}
		this.persistTraceViewerPreferences();
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
								maxNativeZoom: 19,
								maxZoom: 20,
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
						maxNativeZoom: 18,
						maxZoom: 20,
						subdomains: ['a', 'b', 'c'],
						attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://www.thunderforest.com">Thunderforest</a>'
					});
					// Add Thunderforest Outdoors (carte rando : sentiers, relief, SAC)
					this.baseLayers['thunderforest-outdoors'] = L.tileLayer('https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=' + this.thunderforestApiKey, {
						maxNativeZoom: 18,
						maxZoom: 20,
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
				maxNativeZoom: 19,
				maxZoom: 20,
				attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
			}),
			'osm-fr': (() => {
				// Create a layer group with OSM standard as base and OSM France on top
				// This ensures no missing tiles - if OSM France fails, OSM standard shows
				const osmStandardBase = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
					maxNativeZoom: 19,
					maxZoom: 20,
					attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
					opacity: 0.7, // Slightly transparent so OSM France shows through
					zIndex: 1
				});
				const osmFrance = L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
					// osmfr commonly stops earlier than map max; allow over-zoom by upscaling.
					maxNativeZoom: 19,
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
				maxNativeZoom: 19,
				maxZoom: 20,
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
				maxNativeZoom: 17,
				maxZoom: 20,
				subdomains: 'abc',
				attribution: 'Map data: &copy; OSM contributors, SRTM'
			}),
			// 'esri-light-gray': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
			// 	maxZoom: 16,
			// 	attribution: 'Tiles &copy; Esri'
			// }),
			'ign-plan': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
				maxNativeZoom: 19,
				maxZoom: 20,
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
					maxNativeZoom: 19,
					maxZoom: 20,
					attribution: '&copy; IGN - Géoportail',
					zIndex: 2
				});
				return L.layerGroup([scanRegional, planIgn]) as any;
			})(),
			'ign-ortho': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
				maxNativeZoom: 19,
				maxZoom: 20,
				attribution: '&copy; IGN - Géoportail'
			}),
			'ign-cadastre': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=CADASTRALPARCELS.PARCELLAIRE_EXPRESS&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
				maxNativeZoom: 19,
				maxZoom: 20,
				attribution: '&copy; IGN - Géoportail'
			}),
			'ign-limites': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=LIMITES_ADMINISTRATIVES_EXPRESS.LATEST&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
				maxNativeZoom: 19,
				maxZoom: 20,
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
				maxNativeZoom: 19,
				maxZoom: 20,
				attribution: '&copy; IGN - Géoportail'
			}),
			'ign-routes': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=TRANSPORTNETWORKS.ROADS&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
				maxNativeZoom: 19,
				maxZoom: 20,
				attribution: '&copy; IGN - Géoportail'
			}),
			'ign-topo': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
				maxNativeZoom: 19,
				maxZoom: 20,
				attribution: '&copy; IGN - Géoportail'
			}),
			// IGN BD Topo commented out - not available as simple WMTS tile layer
			// 'ign-bd-topo': L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM&LAYER=GEOGRAPHICALGRIDSYSTEMS.MAPS.BDUNI.J1&STYLE=normal&FORMAT=image/png&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}', {
			// 	maxZoom: 19,
			// 	attribution: '&copy; IGN - Géoportail'
			// }),
			// CyclOSM : carte vélo / rando (hébergée par OSM France)
			'cyclosm': L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
				maxNativeZoom: 18,
				maxZoom: 20,
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

		if (!this.selectedBaseLayerId || !this.availableBaseLayers.some((layer) => layer.id === this.selectedBaseLayerId)) {
			this.selectedBaseLayerId = 'opentopomap';
		}
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
		this.persistTraceViewerPreferences();
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
		this.applyWeatherRadarOverlay();

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
		this.persistTraceViewerPreferences();
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
		this.persistTraceViewerPreferences();
	}

	get showWeatherStationsHintKey(): string {
		const provider = this.resolveMapWeatherStationProvider();
		if (provider === 'ms') {
			return 'METEO_FRANCE.SHOW_TEMPERATURE_MAP_HINT_MS';
		}
		if (provider === 'mf') {
			return 'METEO_FRANCE.SHOW_TEMPERATURE_MAP_HINT';
		}
		return 'EVENTELEM.SHOW_WEATHER_STATIONS_HINT_OUTSIDE';
	}

	public onShowWeatherStationsChange(): void {
		if (this.showWeatherStations) {
			this.seedStationSelectionFromExistingClick();
		} else {
			this.clearStationSelection();
		}
		this.applyWeatherStationsOverlay();
		this.cdr.detectChanges();
		this.persistTraceViewerPreferences();
	}

	private clearStationSelection(): void {
		this.stationSelectionLat = null;
		this.stationSelectionLng = null;
		this.stationSelectionCountryCode = '';
	}

	/** Reuse last clicked / weather / track point when enabling the stations switch. */
	private seedStationSelectionFromExistingClick(): void {
		if (this.stationSelectionLat != null && this.stationSelectionLng != null) {
			return;
		}
		if (Number.isFinite(this.clickedWeatherLat) && Number.isFinite(this.clickedWeatherLng)
			&& (this.clickedWeatherLat !== 0 || this.clickedWeatherLng !== 0)) {
			this.stationSelectionLat = this.clickedWeatherLat;
			this.stationSelectionLng = this.clickedWeatherLng;
			this.stationSelectionCountryCode = this.clickedWeatherCountryCode;
			return;
		}
		if (Number.isFinite(this.clickedLat) && Number.isFinite(this.clickedLng)
			&& (this.clickedLat !== 0 || this.clickedLng !== 0)) {
			this.stationSelectionLat = this.clickedLat;
			this.stationSelectionLng = this.clickedLng;
			return;
		}
		if (this.lastRenderedPosition) {
			this.stationSelectionLat = this.lastRenderedPosition.lat;
			this.stationSelectionLng = this.lastRenderedPosition.lng;
		}
	}

	private setStationSelectionFromClick(lat: number, lng: number): void {
		this.stationSelectionLat = lat;
		this.stationSelectionLng = lng;
		this.stationSelectionCountryCode = '';
		this.refreshWeatherStationsForSelection();
		this.apiService.geocodeReverse(lat, lng).pipe(take(1)).subscribe({
			next: (data) => {
				if (this.stationSelectionLat !== lat || this.stationSelectionLng !== lng) {
					return;
				}
				this.stationSelectionCountryCode = this.extractGeocodeCountryCode(data);
				this.refreshWeatherStationsForSelection();
				this.scheduleTraceViewerCdr();
			},
			error: () => { /* bbox-based provider until geocode succeeds */ }
		});
	}

	private refreshWeatherStationsForSelection(): void {
		if (!this.showWeatherStations) {
			return;
		}
		this.applyWeatherStationsOverlay();
	}

	private applyWeatherStationsOverlay(): void {
		if (!this.map) {
			return;
		}
		if (!this.showWeatherStations) {
			this.weatherStationMapLayer.detach();
			return;
		}
		if (!this.resolveMapWeatherStationProvider()) {
			this.weatherStationMapLayer.detach();
			return;
		}
		this.weatherStationMapLayer.bind(this.map, {
			enabled: true,
			resolveProvider: () => this.resolveMapWeatherStationProvider(),
			excludeNearPoint: () => {
				if (this.stationSelectionLat == null || this.stationSelectionLng == null) {
					return null;
				}
				return { lat: this.stationSelectionLat, lng: this.stationSelectionLng };
			},
			brandLogos: {
				meteofrance: TraceViewerModalComponent.LOGO_MF,
				meteoswiss: TraceViewerModalComponent.LOGO_MS,
			},
			brandAlts: {
				meteofrance: 'Météo-France',
				meteoswiss: 'MeteoSwiss',
			},
		});
	}

	private resolveMapWeatherStationProvider(): 'mf' | 'ms' | null {
		if (this.stationSelectionLat == null || this.stationSelectionLng == null) {
			return null;
		}
		return resolveWeatherStationProvider(
			this.stationSelectionLat,
			this.stationSelectionLng,
			this.stationSelectionCountryCode
		);
	}

	/** Rain radar overlay (RainViewer via PatTool), shown when the weather switch is on. */
	private applyWeatherRadarOverlay(): void {
		if (!this.map) {
			return;
		}
		this.removeWeatherRadarLayer();
		this.clearWeatherRadarRefreshTimer();
		if (!this.showWeather) {
			return;
		}
		this.loadWeatherRainViewerRadar();
		this.startWeatherRadarRefreshTimer();
	}

	private removeWeatherRadarLayer(): void {
		this.weatherRadarLayer?.remove();
		this.weatherRadarLayer = undefined;
	}

	private clearWeatherRadarRefreshTimer(): void {
		if (this.weatherRadarRefreshTimer != null) {
			clearInterval(this.weatherRadarRefreshTimer);
			this.weatherRadarRefreshTimer = null;
		}
		this.radarRefreshCountdown = 0;
	}

	private loadWeatherRainViewerRadar(): void {
		if (!this.map || !this.showWeather) {
			return;
		}
		const requestId = ++this.weatherRadarLoadRequestId;
		this.apiService.getRainViewerMaps().pipe(takeUntil(this.destroy$)).subscribe({
			next: (data) => {
				if (requestId !== this.weatherRadarLoadRequestId || !this.map || !this.showWeather) {
					return;
				}
				const past = data?.radar?.past;
				if (!past?.length) {
					return;
				}
				const frame = past[past.length - 1];
				const path = frame?.path;
				if (!path) {
					return;
				}
				this.weatherRadarLayer?.remove();
				const encodedPath = encodeURIComponent(path);
				const tileBase = `${environment.API_URL}external/radar/rainviewer/tile/{z}/{x}/{y}`;
				this.weatherRadarLayer = L.tileLayer(
					`${tileBase}?path=${encodedPath}&size=256&color=2&options=1_1`,
					{
						opacity: TraceViewerModalComponent.WEATHER_RADAR_OPACITY,
						zIndex: 5,
						maxNativeZoom: 7,
						maxZoom: 18,
						attribution: 'Radar © RainViewer.com (via PatTool)'
					}
				);
				this.weatherRadarLayer.addTo(this.map);
			}
		});
	}

	private startWeatherRadarRefreshTimer(): void {
		this.clearWeatherRadarRefreshTimer();
		if (!this.showWeather || !this.autoRefreshRadar) {
			this.radarRefreshCountdown = 0;
			return;
		}
		this.radarRefreshCountdown = this.effectiveRadarRefreshSeconds;
		this.weatherRadarRefreshTimer = setInterval(() => {
			this.radarRefreshCountdown = Math.max(0, this.radarRefreshCountdown - 1);
			if (this.radarRefreshCountdown === 0) {
				if (this.showWeather && this.autoRefreshRadar && this.map) {
					this.loadWeatherRainViewerRadar();
				}
				this.radarRefreshCountdown = this.effectiveRadarRefreshSeconds;
			}
			this.scheduleTraceViewerCdr();
		}, 1000);
	}

	private get effectiveRadarRefreshSeconds(): number {
		const sec = Number(this.radarRefreshSeconds);
		return Number.isFinite(sec) ? Math.max(30, Math.min(600, sec)) : 60;
	}

	public onAutoRefreshRadarChange(): void {
		this.startWeatherRadarRefreshTimer();
		this.persistTraceViewerPreferences();
		this.apiService.saveMeteoFranceRadarPreferences({ autoRefreshEnabled: this.autoRefreshRadar })
			.pipe(takeUntil(this.destroy$))
			.subscribe({ error: () => { /* keep local value */ } });
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
		this.persistTraceViewerPreferences();
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
			this.map.off('dblclick', this.locationSelectionClickHandler);
		}

		// Create initial marker at current location if pendingLocation exists (blue marker for initial position)
		if (this.pendingLocation && !this.selectionMarker) {
			this.createSelectionMarker(this.pendingLocation.lat, this.pendingLocation.lng, true);
			// Show address automatically for initial location if address display is enabled
			if (this.showAddress) {
				this.showAddressInOverlay(this.pendingLocation.lat, this.pendingLocation.lng);
			}
		}

		// Double-clic pour placer la position (simple clic = déplacement carte uniquement)
		this.locationSelectionClickHandler = (e: L.LeafletMouseEvent) => {
			const lat = e.latlng.lat;
			const lng = e.latlng.lng;

			L.DomEvent.stop(e);

			// Create selection marker (will remove previous one if exists)
			this.createSelectionMarker(lat, lng);

			// Store coordinates for when modal closes (don't emit immediately)
			// This allows coordinates to be sent to openweathermap when closing, even if address display is off
			this.finalSelectedCoordinates = { lat, lng };

			this.updateSwitchesForPoint(lat, lng);
		};

		this.map.on('dblclick', this.locationSelectionClickHandler);
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
			this.map.off('dblclick', this.locationSelectionClickHandler);
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
		this.cleanupMobileViewportListener();
		this.showKeepScreenAwakeSwitch = false;
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
		this.persistTraceViewerPreferences();
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

		// Aperçu GPS sous le curseur (pas de « placement » au simple clic)
		this.mapMouseMoveHandler = (e: L.LeafletMouseEvent) => {
			if (this.showGpsCoordinates) {
				this.currentLat = e.latlng.lat;
				this.currentLng = e.latlng.lng;
				this.fetchAltitudeForCoordinates(e.latlng.lat, e.latlng.lng, 'current');
				this.cdr.detectChanges();
			}
		};

		this.map.on('mousemove', this.mapMouseMoveHandler);

		// Initialize with center coordinates
		this.updateGpsCoordinatesFromCenter();
	}

	private cleanupMapMouseMoveHandler(): void {
		if (!this.map) {
			return;
		}

		if (this.mapMouseMoveHandler) {
			this.map.off('mousemove', this.mapMouseMoveHandler);
			this.mapMouseMoveHandler = undefined;
		}

		if (this.mapMouseOutHandler) {
			this.map.off('mouseout', this.mapMouseOutHandler);
			this.mapMouseOutHandler = undefined;
		}
	}

	/**
	 * Adresse / météo au double-clic : via registerMapClickHandler ou registerLocationSelection.
	 */
	private registerAddressClickHandler(): void {
		this.cleanupAddressClickHandler();
	}

	/**
	 * Clean up address click handler
	 */
	private cleanupAddressClickHandler(): void {
		if (!this.map) {
			return;
		}

		if (this.addressClickHandler) {
			this.map.off('dblclick', this.addressClickHandler);
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

		// Double-clic : marqueur + infos (simple clic ne place rien)
		this.mapClickHandler = (e: L.LeafletMouseEvent) => {
			if (this.selectionMode) {
				return;
			}
			L.DomEvent.stop(e);
			const lat = e.latlng.lat;
			const lng = e.latlng.lng;
			this.createClickMarker(lat, lng);
			this.updateSwitchesForPoint(lat, lng);
		};

		this.map.on('dblclick', this.mapClickHandler);
	}

	/**
	 * Clean up map click handler
	 */
	private cleanupMapClickHandler(): void {
		if (!this.map) {
			return;
		}

		if (this.mapClickHandler) {
			this.map.off('dblclick', this.mapClickHandler);
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
				this.persistTraceViewerPreferences();
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
		this.persistTraceViewerPreferences();
	}

	/**
	 * Handle showWeather switch change - fetch weather for most recent point or current position
	 */
	public onShowWeatherChange(): void {
		if (this.showWeather) {
			this.applyWeatherRadarOverlay();
			// If weather was already fetched for a clicked point, just display it
			if (this.hasWeatherPointData && this.clickedWeatherLat && this.clickedWeatherLng) {
				// Weather already available, just ensure address is loaded
				if (!this.clickedWeatherAddress && !this.weatherLocationName) {
					this.getAddressFromCoordinatesForWeather(this.clickedWeatherLat, this.clickedWeatherLng);
				}
				this.setWeatherLoadingState(false);
				this.scheduleTraceViewerCdr();
				this.persistTraceViewerPreferences();
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
				this.weatherLocationName = '';
				this.weatherCity = '';
				this.weatherPointPlaceName = '';
				this.clickedWeatherCountryCode = '';
				this.setWeatherLoadingState(true);
				this.scheduleTraceViewerCdr();

				// Get address and altitude, then fetch weather
				this.getAddressFromCoordinatesForWeather(lat, lng);
				this.fetchAltitudeForCoordinates(lat, lng, 'clicked');
				setTimeout(() => {
					this.fetchWeather(lat!, lng!, this.clickedWeatherAlt);
				}, 100);
			}
		} else {
			this.applyWeatherRadarOverlay();
			this.clearWeatherPointComparison();
		}
		this.persistTraceViewerPreferences();
	}

	get hasWeatherPointData(): boolean {
		return this.weatherPointMfTempC != null
			|| this.weatherPointMsTempC != null
			|| this.weatherPointOpenMeteoTempC != null
			|| this.weatherPointOpenWeatherTempC != null;
	}

	public clearWeatherOverlay(): void {
		this.closeWeatherTimeline();
		this.clearWeatherPointComparison();
		this.scheduleTraceViewerCdr();
	}

	public canShowWeatherTimelineButton(): boolean {
		return (this.isWeatherPointInFrance() || this.isWeatherPointInSwitzerland())
			&& Number.isFinite(this.clickedWeatherLat)
			&& Number.isFinite(this.clickedWeatherLng);
	}

	public weatherTimelineRegion(): 'france' | 'switzerland' {
		return this.isWeatherPointInSwitzerland() ? 'switzerland' : 'france';
	}

	public openWeatherTimeline(): void {
		if (!this.canShowWeatherTimelineButton()) {
			return;
		}
		this.syncWeatherTimelineSnapshot();
		this.deferWeatherUiUpdate(() => {
			this.weatherTimelineVisible = true;
		});
	}

	/** Ouvre Météo-France (onglet radar + températures) centré sur le point météo actuel. */
	public openMeteoFranceAtWeatherPoint(): void {
		this.openRegionalMeteoAtWeatherPoint();
	}

	/**
	 * Ouvre l'écran météo centré sur le point courant.
	 * - France: radar + températures
	 * - Suisse: onglet précipitations MeteoSwiss (sinon le bouton affiche une icône incohérente)
	 */
	public openRegionalMeteoAtWeatherPoint(): void {
		if (!Number.isFinite(this.clickedWeatherLat) || !Number.isFinite(this.clickedWeatherLng)) {
			return;
		}
		const lat = Math.round(this.clickedWeatherLat * 1e7) / 1e7;
		const lon = Math.round(this.clickedWeatherLng * 1e7) / 1e7;
		const z = this.map ? this.map.getZoom() : this.currentZoom;
		const tab = this.isWeatherPointInSwitzerland() ? 'ms-precip' : 'radar';
		void this.router.navigate(['api', 'meteo-france'], {
			queryParams: {
				lat,
				lon,
				z: Math.round(z * 100) / 100,
				tab,
				temp: tab === 'radar' ? '1' : '0',
				radar: tab === 'radar' ? '1' : '0'
			}
		});
		this.close();
	}

	public closeWeatherTimeline(): void {
		this.weatherTimelineVisible = false;
	}

	public formatWeatherTemp(tempC: number): string {
		return `${Math.round(tempC * 10) / 10}°C`;
	}

	public formatWeatherObservedTime(value: string | null | undefined): string | null {
		if (!value) {
			return null;
		}
		const trimmed = value.trim();
		if (/^\d{10}$/.test(trimmed)) {
			const date = new Date(Number(trimmed) * 1000);
			return Number.isNaN(date.getTime()) ? null : this.formatWeatherDateTime(date);
		}
		if (/^\d{13}$/.test(trimmed)) {
			const date = new Date(Number(trimmed));
			return Number.isNaN(date.getTime()) ? null : this.formatWeatherDateTime(date);
		}
		const date = new Date(trimmed);
		if (Number.isNaN(date.getTime())) {
			return null;
		}
		return this.formatWeatherDateTime(date);
	}

	public isWeatherPointInFrance(): boolean {
		return this.isWeatherLocationInFrance();
	}

	public isWeatherPointInSwitzerland(): boolean {
		return this.isWeatherLocationInSwitzerland();
	}

	public weatherPointActionBrand(): TraceViewerWeatherActionBrand {
		if (this.isWeatherPointInFrance()) {
			return 'meteofrance';
		}
		if (this.isWeatherPointInSwitzerland()) {
			return 'meteoswiss';
		}
		return 'world';
	}

	private isWeatherLocationInFrance(): boolean {
		const code = (this.clickedWeatherCountryCode || '').trim().toUpperCase();
		if (code === 'FR') {
			return true;
		}
		if (code === 'CH') {
			return false;
		}
		if (code) {
			return false;
		}
		return this.isCoordinateInFranceMetropole(this.clickedWeatherLat, this.clickedWeatherLng);
	}

	private isWeatherLocationInSwitzerland(): boolean {
		const code = (this.clickedWeatherCountryCode || '').trim().toUpperCase();
		if (code === 'CH') {
			return true;
		}
		if (code === 'FR') {
			return false;
		}
		if (code) {
			return false;
		}
		return this.isCoordinateInSwitzerland(this.clickedWeatherLat, this.clickedWeatherLng)
			&& !this.isCoordinateInFranceMetropole(this.clickedWeatherLat, this.clickedWeatherLng);
	}

	public getWeatherBrandAlt(brand: TraceViewerWeatherBrand): string {
		switch (brand) {
			case 'meteofrance':
				return 'Météo-France';
			case 'meteoswiss':
				return 'MeteoSwiss';
			case 'openweathermap':
				return 'OpenWeatherMap';
			default:
				return 'Open-Meteo';
		}
	}

	/**
	 * Fetch MF / Open-Meteo / OWM temperatures for the clicked point (same sources as Météo-France map popup).
	 */
	private fetchWeather(lat: number, lng: number, alt: number | null = null, showLoading: boolean = true): void {
		if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
			return;
		}

		if (showLoading) {
			this.setWeatherLoadingState(true);
		}
		this.closeWeatherTimeline();
		this.clearWeatherPointComparison(false);
		const requestId = ++this.weatherPointRequestId;
		const requestKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;

		let mfDone = false;
		let msDone = false;
		let openMeteoDone = false;
		let owmDone = false;

		const finishFetch = (): void => {
			if (requestId !== this.weatherPointRequestId) {
				return;
			}
			if (!mfDone || !msDone || !openMeteoDone || !owmDone) {
				return;
			}
			this.setWeatherLoadingState(false);
		};

		const applyMfResponse = (mf: any): void => {
			if (requestId !== this.weatherPointRequestId || this.currentWeatherRequestKey() !== requestKey) {
				return;
			}
			const mfPoint = mf?.points?.[0];
			const mfTemp = this.extractWeatherPointTempC(mf);
			const mfSource = String(mf?.source || '');
			const shouldApply = this.isMfTemperaturePoint(mfPoint, mfSource)
				&& mfTemp != null
				&& this.isWeatherLocationInFrance();
			const observedAt = this.extractWeatherPointObservedAt(mfPoint);
			const stationName = mfPoint?.stationName != null ? String(mfPoint.stationName).trim() : '';
			const stationId = mfPoint?.stationId != null ? String(mfPoint.stationId).trim() : '';
			this.deferWeatherUiUpdate(() => {
				if (requestId !== this.weatherPointRequestId || this.currentWeatherRequestKey() !== requestKey) {
					return;
				}
				if (shouldApply) {
					this.weatherPointMfTempC = mfTemp;
					this.weatherPointMfObservedAt = observedAt;
					this.weatherPointMfStationName = stationName || stationId;
					this.weatherPointMfStationId = stationId;
					this.weatherPointMfStationDistKm = resolveMfStationDistanceKm(lat, lng, mfPoint);
				}
				mfDone = true;
				finishFetch();
				this.scheduleTraceViewerCdr();
			});
		};

		const applyMsResponse = (ms: any): void => {
			if (requestId !== this.weatherPointRequestId || this.currentWeatherRequestKey() !== requestKey) {
				return;
			}
			const msPoint = ms?.points?.[0];
			const msTemp = this.extractWeatherPointTempC(ms);
			const msSource = String(ms?.source || '');
			const shouldApply = this.isMsTemperaturePoint(msPoint, msSource)
				&& msTemp != null
				&& this.isWeatherLocationInSwitzerland();
			const observedAt = this.extractWeatherPointObservedAt(msPoint);
			const stationName = msPoint?.stationName != null ? String(msPoint.stationName).trim() : '';
			const stationId = msPoint?.stationId != null ? String(msPoint.stationId).trim() : '';
			this.deferWeatherUiUpdate(() => {
				if (requestId !== this.weatherPointRequestId || this.currentWeatherRequestKey() !== requestKey) {
					return;
				}
				if (shouldApply) {
					this.weatherPointMsTempC = msTemp;
					this.weatherPointMsObservedAt = observedAt;
					this.weatherPointMsStationName = stationName || stationId;
					this.weatherPointMsStationId = stationId;
					this.weatherPointMsStationDistKm = resolveMfStationDistanceKm(lat, lng, msPoint);
				}
				msDone = true;
				finishFetch();
				this.scheduleTraceViewerCdr();
			});
		};

		const applyOpenMeteoResponse = (openMeteo: any): void => {
			if (requestId !== this.weatherPointRequestId || this.currentWeatherRequestKey() !== requestKey) {
				return;
			}
			const openMeteoTemp = this.extractWeatherPointTempC(openMeteo);
			const openMeteoPoint = openMeteo?.points?.[0];
			const observedAt = this.extractWeatherPointObservedAt(openMeteoPoint);
			this.deferWeatherUiUpdate(() => {
				if (requestId !== this.weatherPointRequestId || this.currentWeatherRequestKey() !== requestKey) {
					return;
				}
				if (openMeteoTemp != null) {
					this.weatherPointOpenMeteoTempC = openMeteoTemp;
					this.weatherPointOpenMeteoObservedAt = observedAt;
				}
				openMeteoDone = true;
				finishFetch();
			});
		};

		const applyOwmResponse = (owm: any): void => {
			if (requestId !== this.weatherPointRequestId || this.currentWeatherRequestKey() !== requestKey) {
				return;
			}
			const owmTemp = owm?.main?.temp;
			const observedAt = owm?.dt != null ? String(owm.dt) : null;
			const place = owm?.name != null ? String(owm.name).trim() : '';
			this.deferWeatherUiUpdate(() => {
				if (requestId !== this.weatherPointRequestId || this.currentWeatherRequestKey() !== requestKey) {
					return;
				}
				if (owmTemp != null && Number.isFinite(owmTemp)) {
					this.weatherPointOpenWeatherTempC = owmTemp;
				}
				if (observedAt != null) {
					this.weatherPointOpenWeatherObservedAt = observedAt;
				}
				if (place) {
					this.weatherPointPlaceName = place;
				}
				owmDone = true;
				finishFetch();
				this.scheduleTraceViewerCdr();
			});
		};

		const markWeatherSourceDone = (markDone: () => void): void => {
			this.deferWeatherUiUpdate(() => {
				if (requestId !== this.weatherPointRequestId) {
					return;
				}
				markDone();
				finishFetch();
			});
		};

		this.apiService.postWeatherTemperatureLabels([{ lat, lon: lng }], 'open-meteo').pipe(take(1)).subscribe({
			next: applyOpenMeteoResponse,
			error: () => markWeatherSourceDone(() => { openMeteoDone = true; })
		});

		if (this.isWeatherLocationInFrance()) {
			this.apiService.postWeatherTemperatureLabels([{ lat, lon: lng }], 'meteofrance', true).pipe(take(1)).subscribe({
				next: applyMfResponse,
				error: () => markWeatherSourceDone(() => { mfDone = true; })
			});
		} else {
			mfDone = true;
		}

		if (this.isWeatherLocationInSwitzerland()) {
			this.apiService.postWeatherTemperatureLabels([{ lat, lon: lng }], 'meteoswiss', true).pipe(take(1)).subscribe({
				next: applyMsResponse,
				error: () => markWeatherSourceDone(() => { msDone = true; })
			});
		} else {
			msDone = true;
		}

		this.apiService.getCurrentWeatherByCoordinates(lat, lng, alt).pipe(
			catchError(() => of(null)),
			take(1)
		).subscribe({
			next: (owm) => {
				if (owm?.error) {
					markWeatherSourceDone(() => { owmDone = true; });
					return;
				}
				applyOwmResponse(owm);
			},
			error: () => markWeatherSourceDone(() => { owmDone = true; })
		});
	}

	private currentWeatherRequestKey(): string {
		return `${this.clickedWeatherLat.toFixed(4)},${this.clickedWeatherLng.toFixed(4)}`;
	}

	private clearWeatherPointComparison(resetLoading = true): void {
		this.weatherPointMfTempC = null;
		this.weatherPointMsTempC = null;
		this.weatherPointOpenMeteoTempC = null;
		this.weatherPointOpenWeatherTempC = null;
		this.weatherPointMfObservedAt = null;
		this.weatherPointMsObservedAt = null;
		this.weatherPointOpenMeteoObservedAt = null;
		this.weatherPointOpenWeatherObservedAt = null;
		this.weatherPointMfStationName = '';
		this.weatherPointMfStationId = '';
		this.weatherPointMsStationName = '';
		this.weatherPointMsStationId = '';
		this.weatherPointMfStationDistKm = null;
		this.weatherPointMsStationDistKm = null;
		this.scheduleTraceViewerCdr();
		if (resetLoading) {
			this.setWeatherLoadingState(false);
		}
	}

	private extractWeatherPointTempC(data: any): number | null {
		const raw = data?.points?.[0]?.tempC;
		const tempC = raw != null ? Number(raw) : NaN;
		return Number.isFinite(tempC) ? tempC : null;
	}

	private extractWeatherPointObservedAt(point: any): string | null {
		const raw = point?.observedAt;
		if (raw == null) {
			return null;
		}
		const text = String(raw).trim();
		return text || null;
	}

	private isMfTemperaturePoint(point: any, mfSource: string): boolean {
		if (!point || point.tempC == null) {
			return false;
		}
		if (point.stationId || point.stationName) {
			return true;
		}
		if (point.interpolated === true) {
			return true;
		}
		const normalized = mfSource.toLowerCase();
		return normalized === 'meteofrance-dpobs' || normalized === 'meteofrance-dpobs-v2';
	}

	private isMsTemperaturePoint(point: any, msSource: string): boolean {
		if (!point || point.tempC == null) {
			return false;
		}
		if (point.stationId || point.stationName) {
			return true;
		}
		const normalized = msSource.toLowerCase();
		return normalized.includes('meteoswiss');
	}

	private isCoordinateInFranceMetropole(lat: number, lon: number): boolean {
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return false;
		}
		const b = TraceViewerModalComponent.MF_OBS_VIEWPORT_BOUNDS;
		return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
	}

	private isCoordinateInFranceForMfObs(lat: number, lon: number): boolean {
		return this.isCoordinateInFranceMetropole(lat, lon)
			&& !this.isCoordinateInSwitzerland(lat, lon);
	}

	private isCoordinateInSwitzerland(lat: number, lon: number): boolean {
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return false;
		}
		const b = TraceViewerModalComponent.CH_OBS_VIEWPORT_BOUNDS;
		return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
	}

	private looksLikeCoordinates(text: string): boolean {
		return /^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(text.trim());
	}

	private formatWeatherDateTime(date: Date): string {
		if (Number.isNaN(date.getTime())) {
			return '';
		}
		return date.toLocaleString(undefined, {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
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
		this.weatherLocationName = '';
		this.weatherCity = '';
		this.weatherPointPlaceName = '';
		this.clickedWeatherCountryCode = '';
		this.setWeatherLoadingState(true);
		this.scheduleTraceViewerCdr();

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
		this.clickedWeatherCountryCode = '';
		this.clearWeatherPointComparison(false);
		this.setWeatherLoadingState(true);
		this.scheduleTraceViewerCdr();

		// Use the shared method to fetch weather
		this.fetchWeatherForClickedPoint(lat, lng);
	}

	/**
	 * Resolve a human-readable label for coordinates (backend geocode with fallbacks).
	 */
	private resolveAddressLabel(lat: number, lng: number): string {
		return formatGpsCoordinates(lat, lng);
	}

	private extractGeocodeDisplayName(data: any): string {
		const raw = data?.display_name ?? data?.displayName;
		if (raw == null) {
			return '';
		}
		const text = String(raw).trim();
		return text;
	}

	private extractGeocodeCountryCode(data: any): string {
		const address = data?.address;
		const raw = address?.country_code ?? address?.countryCode ?? data?.country_code ?? data?.countryCode;
		return raw != null ? String(raw).trim().toUpperCase() : '';
	}

	/**
	 * Reverse geocode via backend (Nominatim → Photon → Open-Meteo → coords / OWM place name).
	 */
	private fetchAddressFromCoordinates(
		lat: number,
		lng: number,
		options: { updateClickedAddress?: boolean; updateWeatherAddress?: boolean } = {}
	): void {
		const { updateClickedAddress = false, updateWeatherAddress = false } = options;
		this.apiService.geocodeReverse(lat, lng).pipe(take(1)).subscribe({
			next: (data) => {
				const address = this.extractGeocodeDisplayName(data) || this.resolveAddressLabel(lat, lng);
				const locationName = resolvePlaceNameFromGeocode(data, lat, lng);
				const cityName = extractGeocodeCityName(data);
				const countryCode = this.extractGeocodeCountryCode(data);
				this.deferWeatherUiUpdate(() => {
					if (updateClickedAddress) {
						this.clickedAddress = address;
					}
					if (updateWeatherAddress) {
						const previousCode = this.clickedWeatherCountryCode;
						this.clickedWeatherAddress = address;
						this.weatherLocationName = locationName;
						if (cityName) {
							this.weatherCity = cityName;
						}
						this.clickedWeatherCountryCode = countryCode;
						this.scheduleTraceViewerCdr();
						if (this.stationSelectionLat === lat && this.stationSelectionLng === lng) {
							this.stationSelectionCountryCode = countryCode;
							this.refreshWeatherStationsForSelection();
						}
						if (countryCode && countryCode !== previousCode && this.showWeather) {
							this.fetchWeather(lat, lng, this.clickedWeatherAlt, false);
						}
					}
				});
			},
			error: (error) => {
				console.debug('Could not fetch address from backend geocode:', error);
				const fallback = this.resolveAddressLabel(lat, lng);
				this.deferWeatherUiUpdate(() => {
					if (updateClickedAddress) {
						this.clickedAddress = fallback;
					}
					if (updateWeatherAddress) {
						this.clickedWeatherAddress = fallback;
						this.weatherLocationName = resolvePlaceNameFromGeocode(
							{ display_name: fallback },
							lat,
							lng
						);
						this.scheduleTraceViewerCdr();
					}
				});
			}
		});
	}

	/**
	 * Get address from coordinates for weather overlay
	 */
	private getAddressFromCoordinatesForWeather(lat: number, lng: number): void {
		this.fetchAddressFromCoordinates(lat, lng, { updateWeatherAddress: true });
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
			this.weatherLocationName = '';
			this.weatherCity = '';
			this.weatherPointPlaceName = '';
			this.setWeatherLoadingState(true);
			this.scheduleTraceViewerCdr();
		}

		this.scheduleTraceViewerCdr();

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

		if (this.showWeatherStations) {
			this.setStationSelectionFromClick(lat, lng);
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
	 * Get full address from coordinates using backend reverse geocode (shared throttle + fallbacks).
	 * @param alsoUpdateWeatherAddress If true, also update clickedWeatherAddress to avoid duplicate API calls
	 */
	private getAddressFromCoordinates(lat: number, lng: number, alsoUpdateWeatherAddress: boolean = false): void {
		this.fetchAddressFromCoordinates(lat, lng, {
			updateClickedAddress: true,
			updateWeatherAddress: alsoUpdateWeatherAddress
		});
	}

}

