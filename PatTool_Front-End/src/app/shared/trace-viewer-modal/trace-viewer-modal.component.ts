import { ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener, Inject, NgZone, OnDestroy, Output, TemplateRef, ViewChild } from '@angular/core';
import { CommonModule, DOCUMENT } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { NgbModule, NgbModal, NgbModalOptions, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Router } from '@angular/router';
import { FileService } from '../../services/file.service';
import { writeGpsHandoff } from '../../gps-track/gps-handoff';
import { isTrackFileName, nearestTrackIndex, trackHeadingAt } from '../../gps-track/gps-geo.util';
import { KeycloakService } from '../../keycloak/keycloak.service';
import { ApiService, TraceViewerPreference } from '../../services/api.service';
import { WeatherStationMapLayerService } from '../../services/weather-station-map-layer.service';
import { resolveWeatherStationProvider, resolveWeatherStationPointBrand, stationMarkerLatLng, WeatherStationGridPoint } from '../weather-station-map.util';
import { forkJoin, of, Subject, Subscription } from 'rxjs';
import { catchError, take, takeUntil } from 'rxjs/operators';
import { WeatherPointTimelineComponent } from '../weather-point-timeline/weather-point-timeline.component';
import { environment } from '../../../environments/environment';
import { L, RotatableLeafletMap } from '../leaflet-rotate-setup';
import {
	attachLeafletMapWheelZoom,
	LEAFLET_SMOOTH_WHEEL_MAP_OPTIONS,
	LeafletMapWheelZoomHandle
} from '../leaflet-map-wheel-zoom';
import { attachLeafletCtrlDragRotate, LeafletCtrlDragRotateHandle } from '../leaflet-ctrl-drag-rotate';
import { attachLeafletPanInertia, LeafletPanInertiaHandle } from '../leaflet-pan-inertia';
import { isValidGeoCoordinate } from '../geo-coordinates.util';
import { requestMotionPermissionIfNeeded } from '../device-motion-permission.util';
import { GpsOfflineMapProgress, GpsOfflineMapService } from '../../services/gps-offline-map.service';
import { GpsOfflinePackMeta, GpsOfflineTilesStore } from '../../gps-track/gps-offline-tiles.store';
import { offlineTraceIdForWall, OfflineTraceSummary, OfflineTracesStore } from '../../gps-track/offline-traces.store';
import { viewWindowFromMap } from '../../gps-track/gps-offline-tiles.util';
import { cachedBasemapTileUrl, createOfflineBasemapLayer } from '../leaflet-cached-tile.layer';
import { createVectorBasemapLayer, maptoolkitStyleForBasemap, vectorStyleForBasemap, applyGlLayerOpacity, FlatMaptoolkitBlend } from '../maptoolkit-basemap.layer';
import { MaptoolkitTerrainView, ReliefPlaceMark, ReliefTrace, ReliefTrailOverlays, leafletZoomToMaplibre, maplibreZoomToLeaflet } from '../maptoolkit-terrain-view';
import { findSkinnedPageHost, paintModalFromHost } from '../host-skin';
import { isBrowserOffline } from '../browser-offline.util';
import { mapBearingFromDeviceOrientation } from '../../direction/direction-attitude';
/** Nord = la carte suit la boussole (flèche rouge = nord réel). Marche = cap GPS en haut. Fixe = pas de rotation auto (Ctrl + glisser tourne quand même). */
type TraceMapOrientation = 'north' | 'heading' | 'fixed';
import {
	extractGeocodeCityName,
	formatMfStationProximityLabel,
	formatGpsCoordinates,
	resolveMfStationDistanceKm,
	resolvePlaceNameFromGeocode,
	resolveWeatherPointLocationLabel,
} from '../weather-point-popup.util';
import {
	analysisNeedsDemElevation,
	analyzeGpxFileContent,
	enrichAnalysisWithDemElevations,
	GpxAnalysis,
	isGpxFileName,
	sampleLatLonsForElevation
} from '../../gpx-trace/gpx-trace-analysis.util';

interface TraceViewerSource {
	fileId?: string;
	blob?: Blob;
	/** Real file name (extension used for GPX/KML/… parsing). */
	fileName: string;
	/** Optional title in the modal header (e.g. user description); falls back to fileName. */
	titleLabel?: string;
	location?: { lat: number; lng: number; label?: string; zoom?: number; hidePin?: boolean };
	positions?: Array<{ lat: number; lng: number; type?: string; datetime?: Date; label?: string }>;
	/** Precomputed track polyline (e.g. GPS routing) — drawn like a GPX/GeoJSON file. */
	trackPoints?: L.LatLngTuple[];
	/** Several traces drawn together, each in its own color. */
	traces?: { name: string; points: L.LatLngTuple[] }[];
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
	@ViewChild('gpxStatsModal') gpxStatsModal!: TemplateRef<any>;
	@ViewChild('offlineTracesModal') offlineTracesModal!: TemplateRef<any>;
	@ViewChild('placeModal') placeModal!: TemplateRef<any>;
	@ViewChild('mapContainer', { static: false }) mapContainerRef?: ElementRef<HTMLDivElement>;
	@ViewChild('compassRoseDial', { static: false }) compassRoseDialRef?: ElementRef<SVGSVGElement>;
	@Output() closed = new EventEmitter<void>();
	@Output() locationSelected = new EventEmitter<{ lat: number; lng: number; alt?: number | null }>();
	@Output() pairSelected = new EventEmitter<{
		user: { lat: number; lng: number } | null;
		mark: { lat: number; lng: number; alt?: number | null } | null;
	}>();

	// Expose Math to template
	Math = Math;

	public isLoading = false;
	public hasError = false;
	public errorMessage = '';
	public trackFileName = '';
	public trackStats: TraceStatistics | null = null;
	/** Full GPX analysis when the opened file is a GPX track (null otherwise). */
	public gpxAnalysis: GpxAnalysis | null = null;
	public isFullscreen = false;
	/** Carte : nord (boussole) / sens de marche / fixe (leaflet-rotate). */
	public mapOrientation: TraceMapOrientation = 'fixed';
	readonly mapOrientations: { id: TraceMapOrientation; labelKey: string; hintKey: string; icon: string }[] = [
		{ id: 'north', labelKey: 'GPS_ROUTING.ORIENT_NORTH', hintKey: 'GPS_ROUTING.ORIENT_NORTH_HINT', icon: 'fa-compass' },
		{ id: 'heading', labelKey: 'GPS_ROUTING.ORIENT_HEADING', hintKey: 'GPS_ROUTING.ORIENT_WALK_HINT', icon: 'fa-location-arrow' },
		{ id: 'fixed', labelKey: 'GPS_ROUTING.ORIENT_FIXED', hintKey: 'GPS_ROUTING.ORIENT_FIXED_HINT', icon: 'fa-lock' }
	];
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

	get canOpenGpsRouteToClickedAddress(): boolean {
		return isValidGeoCoordinate(this.clickedLat, this.clickedLng)
			&& !!this.clickedAddress
			&& this.clickedAddress !== 'Loading address...';
	}

	get canOpenGpsFollow(): boolean {
		return (this.gpxAnalysis?.points?.length ?? 0) >= 2
			|| this.trackOrientationCoords.length >= 2
			|| (this.pendingTrackPoints?.length ?? 0) >= 2
			|| !!this.gpsSourceFileId;
	}

	private gpsSourceFileId: string | null = null;
	private gpsSourceFileName = '';
	public clickedAlt: number | null = null;
	private finalSelectedCoordinates?: { lat: number; lng: number; alt?: number | null };
	public showAddress: boolean = false;
	public showWeather: boolean = false;
	/** Blue weather popup dismissed (data kept), same as Météo-France temperature map overlay. */
	private weatherOverlayDismissed = false;
	/** Météo-France / MeteoSwiss station temperature labels on the map (France / Switzerland). */
	public showWeatherStations: boolean = false;
	/** Reload rain radar and clouds while the weather layer is on. Default matches the server. */
	public autoRefreshRadar = true;
	/**
	 * Cached i18n key for the stations-switch tooltip.
	 * Avoids NG0100: a live getter re-reads selection/geocode mid change-detection.
	 */
	showWeatherStationsHintKey = 'EVENTELEM.SHOW_WEATHER_STATIONS_HINT_OUTSIDE';
	/** Backend status (dpclim / MeteoSwiss SMN) for station tooltip history buttons. */
	private mfStatus: { dpclimAuthValid?: boolean; meteoswissSmnEnabled?: boolean } | null = null;
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
	/** Cached label for weather popup header (avoids NG0100 when geocode resolves). */
	private weatherPointLocationLabelCached = '';
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
	/**
	 * Cached FR/CH region for the timeline inputs.
	 * Template must not call a live method here: Swiss coords sit inside the France bbox,
	 * so region flips france → switzerland when geocode returns CH (NG0100).
	 */
	weatherTimelineRegion: 'france' | 'switzerland' = 'france';
	private syncWeatherTimelineRegion(): void {
		this.weatherTimelineRegion = this.isWeatherPointInSwitzerland() ? 'switzerland' : 'france';
	}
	private weatherPointRequestId = 0;
	readonly weatherLogoMf = TraceViewerModalComponent.LOGO_MF;
	readonly weatherLogoMs = TraceViewerModalComponent.LOGO_MS;
	readonly weatherLogoOm = TraceViewerModalComponent.LOGO_OPEN_METEO;
	readonly weatherLogoOwm = TraceViewerModalComponent.LOGO_OWM;
	/** Waymarked Trails rasters above the base map. Same switches in 2D and on the relief. */
	public showHikingTrailsOverlay = false;
	public showCyclingTrailsOverlay = false;
	public showMtbTrailsOverlay = false;
	public showRailwayOverlay = false;
	public showSlopesOverlay = false;
	/** Monuments, musées, points de vue et aéroports de la zone affichée. */
	public showPlacesOverlay = false;
	private trailOverlayLayers: Partial<Record<keyof ReliefTrailOverlays, L.TileLayer>> = {};
	private placeMarks: ReliefPlaceMark[] = [];
	private placesLayer: L.LayerGroup | null = null;
	private placesTimer: ReturnType<typeof setTimeout> | null = null;
	private placesAbort: AbortController | null = null;
	private placesGen = 0;
	/** RainViewer precipitation radar when weather switch is on (same proxy as Météo-France). */
	private weatherRadarLayer?: L.TileLayer;
	private weatherCloudLayer?: L.TileLayer;
	private weatherRadarLoadRequestId = 0;
	private weatherCloudLoadRequestId = 0;
	private static readonly WEATHER_RADAR_OPACITY = 0.72;
	private static readonly CLOUD_LAYER_SOURCE_STORAGE_KEY = 'meteo-france.cloud-layer-source';
	private static readonly CLOUD_INTENSITY_MIN = 0.5;
	private static readonly CLOUD_INTENSITY_MAX = 8;
	/** Shared with Météo-France (MongoDB map-layer preferences). */
	private cloudOpacity = 0.75;
	private cloudIntensity = 3.0;
	private cloudLayerSource: 'openweathermap' | 'rainviewer' = 'openweathermap';
	private cloudDisplaySource: 'openweathermap' | 'rainviewer' | null = null;

	/** Follow device GPS: recenter the map every 5 s. */
	public followDeviceLocation: boolean = false;
	/** One-shot geolocation in progress (recenter-on-user button). */
	public locatingUser = false;
	/** `modalGeneration` when a live GPS recenter last won — blocks provisional weather snap-back. */
	private userGpsRecenterGen = 0;
	/** GPS fix fetched for the current open (may arrive before the Leaflet map exists). */
	private pendingUserGps: { lat: number; lng: number } | null = null;
	private userGpsFetchGen = 0;
	/** Keep the device screen on while the trace viewer is open (mobile). */
	public keepScreenAwake = false;
	private screenWakeLock: WakeLockSentinel | null = null;
	private screenWakeLockReleaseHandler?: () => void;
	private visibilityChangeHandler?: () => void;
	private static readonly DEVICE_LOCATION_FOLLOW_INTERVAL_S = 5;
	private static readonly MULTI_TRACE_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];
	/** Côté du marqueur position (px). Le centre est le point GPS. */
	private static readonly DEVICE_MARKER_PX = 260;
	/** Milieu de la tige de la flèche verte (entre la base de la pointe et le point GPS). */
	private static readonly ARROW_LABEL_Y = 97;
	/** Visible countdown (seconds until next update); 0 while an update is in progress. */
	public deviceLocationCountdown: number = 0;
	private deviceLocationCountdownId: ReturnType<typeof setInterval> | null = null;
	/** Map marker shown for device GPS when “Follow my position” is enabled. */
	private deviceLocationMarker?: L.Marker;
	/** Last device GPS fix used to aim the green direction arrow. */
	private deviceLocationLatLng: { lat: number; lng: number } | null = null;
	/** Address chosen in the direction modal; the green arrow points toward it. */
	private directionTarget: { lat: number; lng: number; label: string } | null = null;
	public directionTargetActive = false;
	/** Après un saut le long de la flèche : la cible est la position GPS (rond rouge), suivie en direct. */
	private directionTargetFollowsDevice = false;
	public directionLocating = false;
	private directionLocateGen = 0;

	/** Point choisi dans la fenêtre adresse / coordonnées, affiché au centre de la carte. */
	public gotoTargetActive = false;

	/** Fenêtre unique : une seule recherche, puis centrer la carte ou afficher la direction. */
	private placeModalRef?: NgbModalRef;
	public placeMode: 'address' | 'coords' = 'address';
	public placeQuery = '';
	public placeCoords = '';
	public placeSearching = false;
	public placeLocating = false;
	public placeError = '';
	public placeResults: Array<{ lat: number; lng: number; label: string }> = [];
	public placeSelectedIndex: number | null = null;
	private placeSearchSub?: Subscription;
	/** Position utilisée pour la distance et l’angle affichés dans la fenêtre. */
	public placeOrigin: { lat: number; lng: number } | null = null;
	public placeOriginPending = false;
	private placeOriginGen = 0;
	private placeLocateGen = 0;
	private placeCoordsCache?: { input: string; point: { lat: number; lng: number; label: string } | null };
	private readonly placeMetricsCache = new Map<string, { distance: string; bearing: number; cardinal: string }>();

	public get placeHasOrigin(): boolean {
		return !!(this.deviceLocationLatLng ?? this.placeOrigin);
	}

	public get placeTargetActive(): boolean {
		return this.gotoTargetActive || this.directionTargetActive;
	}

	// Event color for styling
	private eventColor: { r: number; g: number; b: number } | null = null;
	private mapMoveHandler?: () => void;
	private mapMouseMoveHandler?: (e: L.LeafletMouseEvent) => void;
	private mapMouseOutHandler?: () => void;
	private addressClickHandler?: (e: L.LeafletMouseEvent) => void;
	private mapClickHandler?: (e: L.LeafletMouseEvent) => void;

	private readonly destroy$ = new Subject<void>();
	private modalRef?: NgbModalRef;
	/** Bumped on each open so a dismissed modal's finalize cannot tear down the newer one. */
	private modalGeneration = 0;
	private gpxStatsModalRef?: NgbModalRef;
	private offlineTracesModalRef?: NgbModalRef;
	offlineTraceList: OfflineTraceSummary[] = [];
	offlineTraceOpeningId: string | null = null;
	selectedOfflineTraceIds: string[] = [];
	/** Légende quand plusieurs traces sont affichées ensemble. */
	displayedTraces: { name: string; color: string }[] = [];
	offlineTracesError = '';
	/** When set before `open()`, overrides default `NgbModal` options (e.g. attach into the globe div). */
	private nextModalOptionsOverride: NgbModalOptions | null = null;
	private map?: L.Map;
	private overlayLayer?: L.LayerGroup;
	private pendingTrackPoints: L.LatLngTuple[] | null = null;
	private pendingTraces: { name: string; points: L.LatLngTuple[] }[] | null = null;
	private lastRenderedTraces: { name: string; points: L.LatLngTuple[] }[] | null = null;
	/**
	 * Points already drawn. A stale modal `hidden` can destroy the map after the
	 * pending list was consumed; the next map init redraws from this copy.
	 */
	private lastRenderedTrackPoints: L.LatLngTuple[] | null = null;
	/** Coords du tracé affiché — pour orientation « Route ». */
	private trackOrientationCoords: L.LatLngTuple[] = [];
	private mapOrientationWatchId: number | null = null;
	private deviceHeadingDeg: number | null = null;
	/** Cap boussole filtré : cible du mode Nord (le rendu est interpolé à part). */
	private compassNorthDeg: number | null = null;
	/** Dernier cap brut accepté, pour ignorer les pics isolés du capteur. */
	private lastRawCompassDeg: number | null = null;
	/** Échantillons boussole très écartés, ignorés tant qu’ils ne se répètent pas. */
	private compassOutlierStreak = 0;
	/** Bearing affiché et cible — interpolation continue en mode Nord. */
	private mapBearingGlideDisplayed: number | null = null;
	private mapBearingGlideTarget: number | null = null;
	private mapBearingGlideTs = 0;
	private mapBearingGlideRaf: number | null = null;
	/** Cap GPS reçu pendant un déplacement (vitesse suffisante). Prioritaire sur la boussole. */
	private gpsCourseActive = false;
	private compassListening = false;
	private compassEventName: string | null = null;
	private applyingMapBearing = false;
	/** MapLibre bearing last written by Nord / Marche / Fixe. A later rotate event is a user drag. */
	private reliefBearingLock: number | null = null;
	private lastGpsFix: { lat: number; lon: number } | null = null;
	private routeHeadingDeg = 0;
	private readonly onCompassOrientation = (event: Event): void => {
		this.consumeCompassOrientation(event as DeviceOrientationEvent);
	};
	private pendingLocation: { lat: number; lng: number; label?: string; zoom?: number; hidePin?: boolean } | null = null;
	private pendingPositions: Array<{ lat: number; lng: number; type?: string; datetime?: Date; label?: string }> | null = null;
	private lastRenderedPosition: { lat: number; lng: number } | null = null; // Store the most recent position after rendering
	private selectionMode: boolean = false;
	private simpleShareMode: boolean = false;
	private pairEditMode = false;
	private pairUser: { lat: number; lng: number } | null = null;
	private pairMark: { lat: number; lng: number; alt?: number | null } | null = null;
	private pairUserMarker?: L.Marker;
	private pairMarkMarker?: L.Marker;
	private pairLine?: L.Polyline;
	private pairClickHandler?: (e: L.LeafletMouseEvent) => void;
	private selectionMarker?: L.Marker;
	private clickMarker?: L.Marker;
	private clickDirectionMarker?: L.Marker;
	private directionTargetMarker?: L.Marker;
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
	private baseLayers: Record<string, L.Layer> = {};
	public availableBaseLayers: Array<{ id: string; label: string; labelKey?: string; relief?: boolean }> = [];
	public selectedBaseLayerId: string = '';
	/** Second basemap drawn above the first. Empty = single basemap. */
	public secondaryBaseLayerId = '';
	/** Mobile list replacing the native select, which needs two taps once its search field is focused. */
	public basemapMenu: 'primary' | 'secondary' | null = null;
	/** 0 = first basemap only, 100 = second basemap only. */
	public basemapBlend = 50;
	/** Pitched MapLibre view for the Maptoolkit basemaps. Flat Leaflet stays underneath. */
	public relief3d = false;
	/** True while the pitched view is loading and still hidden. */
	public relief3dPending = false;
	/** Colore le relief du violet au rouge selon l’altitude visible. */
	public elevationColors = false;
	public elevationSpan: { min: number; max: number } | null = null;
	/** Camera tilt in degrees, 0 = straight down, same frame as the flat map. */
	public reliefPitch = 0;
	/**
	 * Mobile only: while Nord and the 3D view are on, the phone’s tilt drives `reliefPitch`.
	 * The choice stays if Nord is left, but the camera stops following until Nord is back.
	 */
	public reliefTiltFollow = false;
	/** Smoothed screen tilt (0° flat, 90° upright) while `reliefTiltFollow` is driving. */
	private reliefTiltSmoothed: number | null = null;
	/** Last tilt sent to the 3D camera. */
	private reliefTiltPitch: number | null = null;
	private reliefTiltListening = false;
	private readonly onReliefTilt = (event: Event): void => {
		this.applyReliefDeviceTilt(event as DeviceOrientationEvent);
	};

	/** Angle à côté de Z : 90 quand la vue est verticale, 0 à l'horizon. */
	public get reliefZAngle(): number {
		return 90 - this.reliefPitch;
	}

	/** Valeur affichée par le curseur, bornée à son max. Le modèle peut aller au-delà avec l’inclinaison du téléphone. */
	public get reliefPitchView(): number {
		return Math.max(0, Math.min(85, Math.round(this.reliefPitch)));
	}
	/**
	 * After 2D → 3D the camera stays vertical and still, matching the flat map,
	 * until Nord, Marche or Fixe is chosen.
	 */
	private reliefOrientationHeld = false;
	/** The user asked for the flat view; keep it until they pick another 3D map or reopen. */
	private relief3dDismissed = false;
	/** Bearing of the 3D view, degrees clockwise from north. */
	private reliefBearing = 0;
	private terrainView: MaptoolkitTerrainView | null = null;
	/** Last base map before opening “All IGN maps” from the list (not the IGN shortcut button). */
	private lastBaseLayerBeforeCartesGouv: string = 'opentopomap';
	private activeBaseLayer?: L.Layer;
	private activeBlendLayer?: L.Layer;
	/** Second 3D map in the flat view. Leaflet cannot fade a WebGL canvas, so this overlay does. */
	private flatGlBlend: FlatMaptoolkitBlend | null = null;
	private flatGlBlendMove?: () => void;
	private basemapBlendPersistTimer: number | null = null;
	/** Current map zoom level (shown in the UI corner). */
	private _currentZoom = 6;
	/** Valeur affichée. Mise à jour au tick suivant pour éviter NG0100. */
	public zoomFooterView = 6;
	private pendingZoomFooter: number | null = null;
	private zoomFooterTimer: number | null = null;

	get currentZoom(): number {
		return this._currentZoom;
	}

	set currentZoom(zoom: number) {
		if (!Number.isFinite(zoom) || zoom === this._currentZoom) {
			return;
		}
		this._currentZoom = zoom;
		this.deferZoomFooter(zoom);
	}
	/** True after the map is initialized (enables zoom overlay). */
	public isMapReady = false;
	/**
	 * Cached viewport flag for the template.
	 * A live read of innerWidth/innerHeight flips when the modal scrollbar appears (NG0100).
	 */
	public isMobileViewport = false;
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

	/** Plein écran replié : Nord / Marche / Fixe entre Options et Quitter. */
	get orientButtonsDocked(): boolean {
		return this.isFullscreen && !this.isFullscreenOptionsExpanded;
	}
	private trackBounds: L.LatLngBounds | null = null;
	offlineMeta: GpsOfflinePackMeta = { tileCount: 0, bytes: 0, updatedAt: null };
	offlineProgress: GpsOfflineMapProgress = { done: 0, total: 0, failed: 0 };
	offlineDownloading = false;
	offlineError = '';
	offlineMessage = '';
	private offlineUseDevice = false;
	private offlineFallback = false;
	private offlineSub: Subscription | null = null;
	private offlineLastOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
	private readonly onOffline = (): void => this.applyTraceOfflineBasemap(false);
	private readonly onOnline = (): void => this.applyTraceOfflineBasemap(true);

	get usingOfflineDeviceMap(): boolean {
		return this.offlineMeta.tileCount > 0 && (this.offlineUseDevice || this.offlineFallback);
	}
	/** Zoom to restore when recentering a single-point view (openAtLocation). */
	private locationRecenterZoom: number | null = null;
	private static readonly DEFAULT_LOCATION_ZOOM = 14;
	/** Zoom when recentering once on the device GPS (street context, not rooftop). */
	private static readonly USER_POSITION_ZOOM = 16;
	/** Tracks container resize (flex / modal / embed) to recover Leaflet black-map issues. */
	private mapLayoutResizeObserver?: ResizeObserver;
	private mapLayoutSyncDebouncer: number | null = null;
	private traceViewerCdrTimer: number | null = null;
	private pendingReliefPitch: number | null = null;
	private reliefPitchTimer: number | null = null;
	/** Séparé de traceViewerCdrTimer : un zoomend ne doit pas annuler l’activation des boutons. */
	private mapReadyTimer: number | null = null;
	private mapResizeObservedDims = new Map<HTMLElement, string>();
	/** Bloque le scroll de la page derrière la modale. */
	private modalWindowWheelHandler?: (event: Event) => void;
	private modalWindowWheelListenEl?: HTMLElement;
	/** Molette carte : même zoom fluide que GPS (tuiles + tracé ensemble). */
	private mapWheelZoom: LeafletMapWheelZoomHandle | null = null;
	private mapCtrlRotate: LeafletCtrlDragRotateHandle | null = null;
	private mapPanInertia: LeafletPanInertiaHandle | null = null;
	/** Cap choisi à la souris. Tant qu’il est défini, Nord / Marche ne le réécrivent pas. */
	private manualMapBearing: number | null = null;
	private mapCtrlRotateActive = false;
	private mapContainerHadLayout = false;
	private mapInitVisibilityAttempts = 0;
	private mapInitRetryTimer: number | null = null;
	private mapInitRetryRaf: number | null = null;
	private ensureMapInitTimer: number | null = null;
	private ensureMapInitAttempts = 0;
	private modalWheelTrapRetryTimer: number | null = null;
	private modalWheelTrapAttempts = 0;
	/** Bumped on each altitude fetch and on map destroy so a late response is dropped. */
	private altitudeFetchGeneration = 0;
	/** Local GPX is ready before the phone modal has a real height. */
	private pendingRenderTimer: number | null = null;
	private pendingRenderAttempts = 0;
	private trackAutoFitUntil = 0;
	private trackFitSize = { w: 0, h: 0 };
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
		private readonly offlineMap: GpsOfflineMapService,
		private readonly offlineTiles: GpsOfflineTilesStore,
		private readonly offlineTraces: OfflineTracesStore,
		private readonly ngZone: NgZone,
		@Inject(DOCUMENT) private readonly document: Document
	) {
		this.configureLeafletIcons();
		this.bindOfflineMapPack();
		this.offlineTraces.summaries$.pipe(takeUntil(this.destroy$)).subscribe((list) => {
			this.offlineTraceList = list;
			this.cdr.markForCheck();
		});
		this.loadTraceViewerPreferences();
		this.loadMapLayerCloudPreferences();
	}

	/** Cloud opacity / intensity shared with Météo-France (MongoDB, all users). */
	private loadMapLayerCloudPreferences(options?: { applyClouds?: boolean }): void {
		try {
			const stored = localStorage.getItem(TraceViewerModalComponent.CLOUD_LAYER_SOURCE_STORAGE_KEY);
			if (stored === 'openweathermap' || stored === 'rainviewer') {
				this.cloudLayerSource = stored;
			}
		} catch { /* private mode */ }
		const applyClouds = options?.applyClouds === true;
		this.apiService.getMeteoFranceMapLayerPreferences().pipe(takeUntil(this.destroy$)).subscribe({
			next: (pref) => {
				if (pref?.cloudOpacity != null && Number.isFinite(pref.cloudOpacity)) {
					this.cloudOpacity = this.clampCloudOpacity(pref.cloudOpacity);
				}
				if (pref?.cloudIntensity != null && Number.isFinite(pref.cloudIntensity)) {
					this.cloudIntensity = this.clampCloudIntensity(pref.cloudIntensity);
				}
				if (applyClouds && this.showWeather && this.map) {
					this.loadWeatherCloudLayer();
				}
			},
			error: () => {
				if (applyClouds && this.showWeather && this.map) {
					this.loadWeatherCloudLayer();
				}
			}
		});
	}

	private clampCloudOpacity(value: number): number {
		return Number.isFinite(value) ? Math.max(0.1, Math.min(1, value)) : 0.75;
	}

	private clampCloudIntensity(value: number): number {
		return Number.isFinite(value)
			? Math.max(
				TraceViewerModalComponent.CLOUD_INTENSITY_MIN,
				Math.min(TraceViewerModalComponent.CLOUD_INTENSITY_MAX, value)
			)
			: 3.0;
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
						this.startRelief3dFromFlat();
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
		if (pref.showMtbTrailsOverlay != null) {
			this.showMtbTrailsOverlay = pref.showMtbTrailsOverlay;
		}
		if (pref.showRailwayOverlay != null) {
			this.showRailwayOverlay = pref.showRailwayOverlay;
		}
		if (pref.showSlopesOverlay != null) {
			this.showSlopesOverlay = pref.showSlopesOverlay;
		}
		if (pref.showPlacesOverlay != null) {
			this.showPlacesOverlay = pref.showPlacesOverlay;
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
		if (pref.secondaryBaseLayerId != null && pref.secondaryBaseLayerId !== 'cartes-gouv') {
			this.secondaryBaseLayerId = pref.secondaryBaseLayerId;
		}
		if (pref.basemapBlend != null) {
			this.basemapBlend = this.clampBasemapBlend(pref.basemapBlend);
		}
		if (this.secondaryBaseLayerId === this.selectedBaseLayerId) {
			this.secondaryBaseLayerId = '';
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
			showMtbTrailsOverlay: this.showMtbTrailsOverlay,
			showRailwayOverlay: this.showRailwayOverlay,
			showSlopesOverlay: this.showSlopesOverlay,
			showPlacesOverlay: this.showPlacesOverlay,
			followDeviceLocation: this.followDeviceLocation,
			keepScreenAwake: this.keepScreenAwake,
			showGpsCoordinates: this.showGpsCoordinates,
			baseLayerId,
			secondaryBaseLayerId: this.secondaryBaseLayerId === baseLayerId ? '' : this.secondaryBaseLayerId,
			basemapBlend: this.clampBasemapBlend(this.basemapBlend)
		}).pipe(takeUntil(this.destroy$)).subscribe({ error: () => { /* keep local value */ } });
	}

	/** Re-apply overlay switches after map init (prefs loaded before open). */
	private applyPersistedSwitchEffects(): void {
		this.deferWeatherUiUpdate(() => this.applyPersistedSwitchEffectsNow());
	}

	private applyPersistedSwitchEffectsNow(): void {
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
			this.ensureMfStatusForStationTooltips();
		}
		this.applyWeatherStationsOverlay();
		this.applyTrailOverlays();
		this.schedulePlaces();
		if (this.followDeviceLocation) {
			this.startFollowDeviceLocation();
		}
		if (this.keepScreenAwake) {
			void this.acquireScreenWakeLock();
		}
	}

	ngOnDestroy(): void {
		if (this.basemapBlendPersistTimer != null) {
			clearTimeout(this.basemapBlendPersistTimer);
			this.basemapBlendPersistTimer = null;
		}
		window.removeEventListener('offline', this.onOffline);
		window.removeEventListener('online', this.onOnline);
		this.offlineSub?.unsubscribe();
		if (this.traceViewerCdrTimer != null) {
			clearTimeout(this.traceViewerCdrTimer);
			this.traceViewerCdrTimer = null;
		}
		if (this.mapReadyTimer != null) {
			clearTimeout(this.mapReadyTimer);
			this.mapReadyTimer = null;
		}
		if (this.elevationSpanTimer != null) {
			clearTimeout(this.elevationSpanTimer);
			this.elevationSpanTimer = null;
		}
		this.clearPlaces();
		this.stopMapOrientationWatch();
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
		if (this.basemapMenu) {
			this.basemapMenu = null;
			return;
		}
		if (this.placeModalRef) {
			this.closePlaceModal();
			return;
		}
		if (this.gpxStatsModalRef) {
			this.closeGpxStatsModal();
			return;
		}
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
		if (!this.map || this.traceViewerShortcutBlocked(event)) {
			return;
		}

		const key = event.key.toLowerCase();
		if (key === 'r') {
			event.preventDefault();
			this.recenterOnTrack();
		}
	}

	/** La touche R recentre la trace : ne pas l’avaler dans un champ ou une fenêtre (adresse, stats…). */
	private traceViewerShortcutBlocked(event: KeyboardEvent): boolean {
		if (event.ctrlKey || event.metaKey || event.altKey) {
			return true;
		}
		if (this.placeModalRef || this.gpxStatsModalRef || this.offlineTracesModalRef || this.cartesGouvModalRef) {
			return true;
		}
		const target = event.target as HTMLElement | null;
		if (!target) {
			return false;
		}
		const tag = target.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
			return true;
		}
		return target.isContentEditable === true;
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

	public openAtLocation(
		lat: number,
		lng: number,
		label?: string,
		eventColor?: { r: number; g: number; b: number },
		enableSelection: boolean = false,
		simpleShare: boolean = false,
		viewOptions?: { zoom?: number; initialBaseLayerId?: string; hidePin?: boolean }
	): void {
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
			location: { lat, lng, label, zoom: viewOptions?.zoom, hidePin: viewOptions?.hidePin === true },
			initialBaseLayerId: viewOptions?.initialBaseLayerId
		});

		// Restore selectionMode and simpleShareMode AFTER open() has reset it
		this.selectionMode = enableSelection;
		this.simpleShareMode = simpleShare;
	}

	/** Recentre le viewer déjà ouvert, sans le refermer (ex. GPS arrivé après l’ouverture du menu). */
	public focusLocation(lat: number, lng: number, zoom = 13): void {
		if (!isValidGeoCoordinate(lat, lng)) {
			return;
		}
		const viewZoom = Math.min(19, Math.max(2, Math.round(zoom)));
		if (!this.map) {
			if (this.pendingLocation) {
				this.pendingLocation = { ...this.pendingLocation, lat, lng, zoom: viewZoom };
			}
			return;
		}
		this.lastRenderedPosition = { lat, lng };
		this.trackBounds = L.latLngBounds([lat, lng], [lat, lng]);
		this.map.setView([lat, lng], viewZoom, { animate: false });
		this.currentZoom = viewZoom;
		this.updateDeviceLocationMarker(lat, lng);
		this.scheduleTraceViewerCdr();
	}

	public openCiblePair(
		user: { lat: number; lng: number } | null,
		mark: { lat: number; lng: number; alt?: number | null } | null,
		fileName: string
	): void {
		const center = mark && isValidGeoCoordinate(mark.lat, mark.lng)
			? mark
			: user && isValidGeoCoordinate(user.lat, user.lng)
				? user
				: { lat: 46.2, lng: 6.15 };
		this.pairEditMode = true;
		this.pairUser = user && isValidGeoCoordinate(user.lat, user.lng) ? { ...user } : null;
		this.pairMark = mark && isValidGeoCoordinate(mark.lat, mark.lng) ? { ...mark } : null;
		this.simpleShareMode = true;
		this.open({
			fileName,
			location: { lat: center.lat, lng: center.lng, label: fileName }
		});
		this.pairEditMode = true;
		this.pairUser = user && isValidGeoCoordinate(user.lat, user.lng) ? { ...user } : null;
		this.pairMark = mark && isValidGeoCoordinate(mark.lat, mark.lng) ? { ...mark } : null;
		this.simpleShareMode = true;
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

	/**
	 * Open the trace viewer with a polyline track (e.g. GPS routing A→B).
	 * Points are [lat, lng] like Leaflet LatLngTuple.
	 */
	public openWithTrackPoints(
		points: Array<{ lat: number; lng: number } | L.LatLngTuple>,
		fileName: string,
		options?: { initialBaseLayerId?: string; eventColor?: { r: number; g: number; b: number }; titleLabel?: string }
	): void {
		if (!points?.length) {
			console.warn('No points provided to openWithTrackPoints');
			return;
		}

		const trackPoints: L.LatLngTuple[] = [];
		for (const p of points) {
			const lat = Array.isArray(p) ? p[0] : p.lat;
			const lng = Array.isArray(p) ? p[1] : p.lng;
			if (isValidGeoCoordinate(lat, lng)) {
				trackPoints.push([lat, lng]);
			}
		}
		if (!trackPoints.length) {
			console.warn('No valid points provided to openWithTrackPoints');
			return;
		}

		this.eventColor = options?.eventColor ?? null;
		this.selectionMode = false;
		this.simpleShareMode = false;
		this.open({
			fileName: fileName || 'route.gpx',
			titleLabel: options?.titleLabel,
			trackPoints,
			initialBaseLayerId: options?.initialBaseLayerId
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
			if (this.hasPendingMapContent()) {
				this.schedulePendingRenderRetry();
			}
			return;
		}
		const hadPending = this.hasPendingMapContent();
		this.tryRenderPendingTrack();
		this.tryRenderPendingPositions();
		this.tryRenderPendingLocation();
		if (!this.hasPendingMapContent()) {
			this.clearPendingRenderRetry();
		}
		if ((!hadLayout || hadPending) && this.trackBounds?.isValid()) {
			this.fitMapToTrackBounds(this.trackBounds);
			this.noteTrackFitted();
		} else {
			this.refitTrackIfLayoutSettling();
		}
	}

	private hasPendingMapContent(): boolean {
		return !!(this.pendingTrackPoints?.length || this.pendingTraces?.length || this.pendingPositions?.length || this.pendingLocation);
	}

	private mapContainerIsSized(minPx = 2): boolean {
		const el = this.map?.getContainer();
		return !!el && el.offsetWidth >= minPx && el.offsetHeight >= minPx;
	}

	/** True when the draw must wait: the phone modal is still too small for a real fitBounds. */
	private deferRenderUntilMapSized(minPx = 2): boolean {
		if (this.map) {
			this.map.invalidateSize({ animate: false, pan: false });
		}
		const size = this.map?.getSize();
		if (this.mapContainerIsSized(minPx) && !!size && size.x >= minPx && size.y >= minPx) {
			return false;
		}
		this.schedulePendingRenderRetry();
		return true;
	}

	private schedulePendingRenderRetry(): void {
		if (this.pendingRenderTimer != null || this.pendingRenderAttempts >= 40) {
			return;
		}
		this.pendingRenderAttempts += 1;
		this.pendingRenderTimer = window.setTimeout(() => {
			this.pendingRenderTimer = null;
			if (!this.map) {
				return;
			}
			this.syncMapLayoutCore();
		}, 80);
	}

	private clearPendingRenderRetry(): void {
		if (this.pendingRenderTimer != null) {
			clearTimeout(this.pendingRenderTimer);
			this.pendingRenderTimer = null;
		}
		this.pendingRenderAttempts = 0;
	}

	private noteTrackFitted(): void {
		const el = this.map?.getContainer();
		this.trackFitSize = { w: el?.offsetWidth ?? 0, h: el?.offsetHeight ?? 0 };
		this.trackAutoFitUntil = Date.now() + 1600;
	}

	/** Mobile modal height changes after the first paint; keep the trace in frame. */
	private refitTrackIfLayoutSettling(): void {
		if (!this.map || !this.trackBounds?.isValid() || Date.now() > this.trackAutoFitUntil) {
			return;
		}
		const el = this.map.getContainer();
		const w = el.offsetWidth;
		const h = el.offsetHeight;
		if (w < 2 || h < 2) {
			return;
		}
		if (Math.abs(w - this.trackFitSize.w) <= 4 && Math.abs(h - this.trackFitSize.h) <= 4) {
			return;
		}
		this.fitMapToTrackBounds(this.trackBounds);
		this.trackFitSize = { w, h };
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
			this.modalWheelTrapAttempts += 1;
			if (!this.modalRef || this.modalWheelTrapAttempts >= 100) {
				return;
			}
			this.modalWheelTrapRetryTimer = window.setTimeout(() => {
				this.modalWheelTrapRetryTimer = null;
				this.setupModalWheelTrap();
			}, 50);
			return;
		}
		this.modalWheelTrapAttempts = 0;
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
		if (this.modalWheelTrapRetryTimer != null) {
			clearTimeout(this.modalWheelTrapRetryTimer);
			this.modalWheelTrapRetryTimer = null;
		}
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
			let changed = false;
			for (const entry of entries) {
				const bw = Math.round(entry.contentRect.width);
				const bh = Math.round(entry.contentRect.height);
				if (bw < 2 || bh < 2) {
					continue;
				}
				const key = `${bw}x${bh}`;
				const target = entry.target as HTMLElement;
				if (this.mapResizeObservedDims.get(target) === key) {
					continue;
				}
				this.mapResizeObservedDims.set(target, key);
				changed = true;
			}
			if (changed) {
				this.refreshMapLayout();
			}
		});
		const targets = new Set<HTMLElement>([observedEl]);
		const mapEl = this.map?.getContainer();
		if (mapEl) {
			targets.add(mapEl);
		}
		for (const target of targets) {
			try {
				this.mapLayoutResizeObserver.observe(target);
			} catch {
				/* ignore */
			}
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
		this.closePlaceModal();
		this.closeOfflineTracesModal();
		this.stopMapOrientationWatch();
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

	/** Open GPX statistics modal over the trace viewer (only when a GPX file was loaded). */
	public openGpxStatsModal(): void {
		if (!this.gpxAnalysis || !this.gpxStatsModal) {
			return;
		}
		if (this.gpxStatsModalRef) {
			return;
		}
		const opts: NgbModalOptions = {
			size: 'lg',
			centered: true,
			backdrop: 'static',
			scrollable: true,
			keyboard: true,
			windowClass: 'trace-viewer-gpx-stats-modal'
		};
		const mountEl = this.getCartesGouvModalMountElement();
		if (mountEl) {
			opts.container = mountEl;
		}
		this.gpxStatsModalRef = this.modalService.open(this.gpxStatsModal, opts);
		this.gpxStatsModalRef.result.finally(() => {
			this.gpxStatsModalRef = undefined;
			this.cdr.detectChanges();
		});
	}

	get offlineTraceCount(): number {
		return this.offlineTraceList.length;
	}

	public openOfflineTracesModal(): void {
		if (!this.offlineTracesModal || this.offlineTracesModalRef) {
			return;
		}
		this.offlineTracesError = '';
		void this.offlineTraces.refresh();
		const opts: NgbModalOptions = {
			size: 'lg',
			centered: true,
			backdrop: 'static',
			scrollable: true,
			keyboard: true,
			windowClass: 'trace-viewer-offline-traces-modal'
		};
		const mountEl = this.getCartesGouvModalMountElement();
		if (mountEl) {
			opts.container = mountEl;
		}
		this.offlineTracesModalRef = this.modalService.open(this.offlineTracesModal, opts);
		this.offlineTracesModalRef.result.finally(() => {
			this.offlineTracesModalRef = undefined;
			this.cdr.markForCheck();
		});
	}

	public closeOfflineTracesModal(): void {
		if (!this.offlineTracesModalRef) {
			return;
		}
		try {
			this.offlineTracesModalRef.close();
		} catch {
			/* ignore */
		}
		this.offlineTracesModalRef = undefined;
	}

	isOfflineTraceSelected(id: string): boolean {
		return this.selectedOfflineTraceIds.includes(id);
	}

	get allOfflineTracesSelected(): boolean {
		const ids = this.offlineTraceList.map((trace) => trace.id).filter((id): id is string => !!id);
		return ids.length > 0 && ids.every((id) => this.selectedOfflineTraceIds.includes(id));
	}

	get someOfflineTracesSelected(): boolean {
		return this.selectedOfflineTraceIds.length > 0 && !this.allOfflineTracesSelected;
	}

	toggleAllOfflineTraces(checked: boolean): void {
		this.selectedOfflineTraceIds = checked
			? this.offlineTraceList.map((trace) => trace.id).filter((id): id is string => !!id)
			: [];
		this.cdr.markForCheck();
	}

	toggleOfflineTraceSelection(id: string, checked: boolean): void {
		if (!id) {
			return;
		}
		if (checked) {
			if (!this.selectedOfflineTraceIds.includes(id)) {
				this.selectedOfflineTraceIds = [...this.selectedOfflineTraceIds, id];
			}
			return;
		}
		this.selectedOfflineTraceIds = this.selectedOfflineTraceIds.filter((item) => item !== id);
	}

	public async showSelectedOfflineTraces(): Promise<void> {
		const ids = this.selectedOfflineTraceIds.filter((id) => this.offlineTraceList.some((trace) => trace.id === id));
		if (!ids.length || this.offlineTraceOpeningId) {
			return;
		}
		if (ids.length === 1) {
			const one = this.offlineTraceList.find((trace) => trace.id === ids[0]);
			if (one) {
				await this.showOfflineTrace(one);
			}
			return;
		}
		this.offlineTraceOpeningId = ids[0];
		this.offlineTracesError = '';
		this.cdr.markForCheck();
		try {
			const traces: { name: string; points: L.LatLngTuple[] }[] = [];
			for (const id of ids) {
				const summary = this.offlineTraceList.find((trace) => trace.id === id);
				const rec = await this.offlineTraces.get(id);
				if (!rec) {
					continue;
				}
				const buffer = await this.toTrackArrayBuffer(rec.data);
				if (!buffer) {
					continue;
				}
				const text = this.decodeArrayBuffer(buffer);
				const ext = (rec.fileName || 'track.gpx').split('.').pop()?.toLowerCase() || 'gpx';
				const points = this.parseTrack(text, ext);
				if (points.length < 2) {
					continue;
				}
				const name = (rec.title || summary?.title || rec.fileName || 'trace').trim();
				traces.push({ name, points });
			}
			if (!traces.length) {
				this.offlineTracesError = this.translate('EVENTELEM.OFFLINE_TRACES_MISSING');
				return;
			}
			let opened = false;
			const reopen = (): void => {
				if (opened) {
					return;
				}
				opened = true;
				this.presentTraces(traces);
			};
			const ref = this.offlineTracesModalRef;
			this.offlineTracesModalRef = undefined;
			if (ref) {
				ref.result.finally(() => reopen());
				try {
					ref.close();
				} catch {
					reopen();
				}
			} else {
				reopen();
			}
		} finally {
			this.offlineTraceOpeningId = null;
			this.cdr.markForCheck();
		}
	}

	public async showOfflineTrace(summary: OfflineTraceSummary): Promise<void> {
		if (!summary?.id || this.offlineTraceOpeningId) {
			return;
		}
		this.offlineTraceOpeningId = summary.id;
		this.offlineTracesError = '';
		this.cdr.markForCheck();
		try {
			const rec = await this.offlineTraces.get(summary.id);
			if (!rec) {
				this.offlineTracesError = this.translate('EVENTELEM.OFFLINE_TRACES_MISSING');
				return;
			}
			const blob = new Blob([rec.data]);
			const fileName = rec.fileName || 'track.gpx';
			const title = (rec.title || fileName).trim();
			let opened = false;
			const reopen = (): void => {
				if (opened) {
					return;
				}
				opened = true;
				this.eventColor = null;
				if (this.modalRef) {
					this.replaceOpenTrack({ blob, fileName, titleLabel: title });
					return;
				}
				this.open({ blob, fileName, titleLabel: title });
			};
			const ref = this.offlineTracesModalRef;
			this.offlineTracesModalRef = undefined;
			if (ref) {
				ref.result.finally(() => reopen());
				try {
					ref.close();
				} catch {
					reopen();
				}
			} else {
				reopen();
			}
		} finally {
			this.offlineTraceOpeningId = null;
			this.cdr.markForCheck();
		}
	}

	public async deleteOfflineTrace(summary: OfflineTraceSummary, ev?: Event): Promise<void> {
		ev?.stopPropagation();
		if (!summary?.id) {
			return;
		}
		if (!window.confirm(this.translate('EVENTELEM.OFFLINE_TRACES_DELETE_CONFIRM'))) {
			return;
		}
		try {
			await this.offlineTraces.delete(summary.id);
		} catch (err) {
			console.error('Offline trace delete failed', err);
		}
	}

	offlineTraceSourceKey(source: string): string {
		return source === 'gps-routing'
			? 'EVENTELEM.OFFLINE_TRACES_SOURCE_ROUTE'
			: 'EVENTELEM.OFFLINE_TRACES_SOURCE_WALL';
	}

	formatOfflineTraceWhen(savedAt: number): string {
		if (!savedAt) {
			return '';
		}
		try {
			return new Date(savedAt).toLocaleString();
		} catch {
			return '';
		}
	}

	formatOfflineTraceSize(bytes: number): string {
		if (!bytes || bytes < 1024) {
			return `${bytes || 0} B`;
		}
		if (bytes < 1024 * 1024) {
			return `${Math.max(1, Math.round(bytes / 1024))} KB`;
		}
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	formatOfflineTraceDistance(km: number | null | undefined): string {
		if (km == null || !Number.isFinite(km) || km <= 0) {
			return '';
		}
		return `${km} km`;
	}

	public closeGpxStatsModal(): void {
		if (!this.gpxStatsModalRef) {
			return;
		}
		try {
			this.gpxStatsModalRef.close();
		} catch {
			/* ignore */
		}
		this.gpxStatsModalRef = undefined;
		this.cdr.detectChanges();
	}

	/** Ouvre la fenêtre pour centrer la carte ou afficher la direction. */
	public openPlaceModal(): void {
		if (!this.placeModal || this.placeModalRef) {
			return;
		}
		this.placeError = '';
		this.placeSearching = false;
		this.directionLocating = false;
		this.requestPlaceOrigin();
		const opts: NgbModalOptions = {
			centered: true,
			backdrop: 'static',
			scrollable: true,
			keyboard: true,
			windowClass: 'trace-viewer-direction-modal'
		};
		const mountEl = this.getCartesGouvModalMountElement();
		if (mountEl) {
			opts.container = mountEl;
		}
		this.placeModalRef = this.modalService.open(this.placeModal, opts);
		this.placeModalRef.result.finally(() => {
			this.placeModalRef = undefined;
			this.placeSearching = false;
			this.directionLocating = false;
			this.cdr.markForCheck();
		});
	}

	public closePlaceModal(): void {
		this.directionLocateGen++;
		this.placeOriginGen++;
		this.placeLocateGen++;
		this.placeLocating = false;
		this.placeOriginPending = false;
		this.directionLocating = false;
		this.placeSearchSub?.unsubscribe();
		this.placeSearchSub = undefined;
		this.placeSearching = false;
		if (!this.placeModalRef) {
			return;
		}
		try {
			this.placeModalRef.close();
		} catch {
			/* ignore */
		}
		this.placeModalRef = undefined;
	}

	/** Lit le GPS et le propose comme point : centrer ou afficher la direction. */
	public useMyPositionInPlace(): void {
		if (!navigator.geolocation) {
			this.placeError = this.translate('EVENTELEM.TRACK_DIRECTION_GPS_ERROR');
			this.cdr.markForCheck();
			return;
		}
		const gen = ++this.placeLocateGen;
		this.placeLocating = true;
		this.placeError = '';
		this.cdr.markForCheck();
		const onFix = (lat: number, lng: number): void => {
			if (gen !== this.placeLocateGen) {
				return;
			}
			this.placeLocating = false;
			const label = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
			this.placeMode = 'coords';
			this.placeCoords = label;
			this.placeCoordsCache = undefined;
			this.placeOrigin = { lat, lng };
			this.placeOriginPending = false;
			this.pendingUserGps = { lat, lng };
			this.lastGpsFix = { lat, lon: lng };
			this.updateDeviceLocationMarker(lat, lng);
			this.showGotoLocation(lat, lng, label);
			this.cdr.markForCheck();
		};
		const onFail = (): void => {
			if (gen !== this.placeLocateGen) {
				return;
			}
			this.placeLocating = false;
			this.placeError = this.translate('EVENTELEM.TRACK_DIRECTION_GPS_ERROR');
			this.cdr.markForCheck();
		};
		navigator.geolocation.getCurrentPosition(
			(pos) => onFix(pos.coords.latitude, pos.coords.longitude),
			() => {
				navigator.geolocation.getCurrentPosition(
					(pos) => onFix(pos.coords.latitude, pos.coords.longitude),
					onFail,
					{ enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 }
				);
			},
			{ enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
		);
	}

	public setPlaceMode(mode: 'address' | 'coords'): void {
		this.placeMode = mode;
		this.placeError = '';
	}

	public searchPlaceAddress(): void {
		const query = this.placeQuery?.trim();
		if (!query) {
			this.placeError = this.translate('ADDRESS_GEOCODE.ADDRESS_REQUIRED');
			this.placeResults = [];
			this.placeSelectedIndex = null;
			return;
		}
		this.placeError = '';
		this.placeSelectedIndex = null;
		this.placeSearching = true;
		this.placeSearchSub?.unsubscribe();
		this.placeSearchSub = this.apiService.geocodeSearch(query).pipe(take(1)).subscribe({
			next: (data: any[]) => {
				this.placeResults = (data || []).map((item: any) => ({
					lat: typeof item.lat === 'number' ? item.lat : parseFloat(item.lat) || 0,
					lng: typeof item.lon === 'number' ? item.lon : parseFloat(item.lon) || 0,
					label: String(item.displayName || item.display_name || '').trim()
				})).filter((item) => isValidGeoCoordinate(item.lat, item.lng) && item.label.length > 0);
				if (this.placeResults.length === 0) {
					this.placeError = this.translate('ADDRESS_GEOCODE.NO_RESULTS');
				} else if (this.placeResults.length === 1) {
					this.placeSelectedIndex = 0;
				}
				this.placeSearching = false;
				this.cdr.markForCheck();
			},
			error: () => {
				this.placeResults = [];
				this.placeSelectedIndex = null;
				this.placeError = this.translate('ADDRESS_GEOCODE.ERROR');
				this.placeSearching = false;
				this.cdr.markForCheck();
			}
		});
	}

	public selectPlaceResult(index: number): void {
		this.placeSelectedIndex = index;
		this.placeError = '';
	}

	/** Point retenu : adresse sélectionnée ou coordonnées saisies valides. */
	public get placeSelected(): { lat: number; lng: number; label: string } | null {
		if (this.placeMode === 'coords') {
			if (this.placeCoordsCache?.input !== this.placeCoords) {
				const parsed = this.parseGotoCoordinates(this.placeCoords);
				this.placeCoordsCache = {
					input: this.placeCoords,
					point: parsed ? { ...parsed, label: `${parsed.lat.toFixed(6)}, ${parsed.lng.toFixed(6)}` } : null
				};
			}
			return this.placeCoordsCache.point;
		}
		const index = this.placeSelectedIndex;
		return index != null ? this.placeResults[index] ?? null : null;
	}

	/** Distance et cap (0° = nord, sens horaire) depuis la position actuelle. */
	public placeMetrics(lat: number, lng: number): { distance: string; bearing: number; cardinal: string } | null {
		const from = this.deviceLocationLatLng ?? this.placeOrigin;
		if (!from || !isValidGeoCoordinate(lat, lng)) {
			return null;
		}
		const key = `${from.lat},${from.lng}|${lat},${lng}`;
		const cached = this.placeMetricsCache.get(key);
		if (cached) {
			return cached;
		}
		const meters = L.latLng(from.lat, from.lng).distanceTo(L.latLng(lat, lng));
		const distance = this.formatDistanceKmM(meters);
		if (!distance) {
			return null;
		}
		const bearing = Math.round(this.bearingDeg(from.lat, from.lng, lat, lng)) % 360;
		const metrics = { distance, bearing, cardinal: this.cardinalLabel(bearing) };
		if (this.placeMetricsCache.size > 200) {
			this.placeMetricsCache.clear();
		}
		this.placeMetricsCache.set(key, metrics);
		return metrics;
	}

	private cardinalLabel(bearing: number): string {
		const keys = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
		const key = keys[Math.round(bearing / 45) % 8];
		return this.translate(`EVENTELEM.TRACK_CARDINAL_${key}`);
	}

	private formatDistanceKmM(meters: number): string | null {
		if (!Number.isFinite(meters) || meters < 0) {
			return null;
		}
		const rounded = Math.round(meters);
		if (rounded < 1000) {
			return `${rounded} m`;
		}
		const km = Math.floor(rounded / 1000);
		const rest = rounded % 1000;
		return rest === 0 ? `${km} km` : `${km} km ${rest} m`;
	}

	/** Lit la position une fois pour afficher distance et angle avant toute action. */
	private requestPlaceOrigin(): void {
		if (this.deviceLocationLatLng) {
			this.placeOrigin = { lat: this.deviceLocationLatLng.lat, lng: this.deviceLocationLatLng.lng };
			this.placeOriginPending = false;
			return;
		}
		if (!navigator.geolocation) {
			this.placeOriginPending = false;
			return;
		}
		const gen = ++this.placeOriginGen;
		this.placeOriginPending = true;
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				if (gen !== this.placeOriginGen) {
					return;
				}
				this.placeOrigin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
				this.placeOriginPending = false;
				this.cdr.markForCheck();
			},
			() => {
				if (gen !== this.placeOriginGen) {
					return;
				}
				this.placeOriginPending = false;
				this.cdr.markForCheck();
			},
			{ enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 }
		);
	}

	public confirmDirectionTarget(): void {
		const picked = this.placeSelected;
		if (!picked) {
			this.placeError = this.translate(this.placeMode === 'coords'
				? 'ADDRESS_GEOCODE.INVALID_COORDINATES'
				: 'EVENTELEM.TRACK_DIRECTION_SELECT');
			return;
		}
		if (this.deviceLocationLatLng && this.deviceLocationMarker) {
			this.applyDirectionTarget(picked);
			this.closePlaceModal();
			return;
		}
		if (!this.map || !navigator.geolocation) {
			this.placeError = this.translate('EVENTELEM.TRACK_DIRECTION_GPS_ERROR');
			this.cdr.markForCheck();
			return;
		}
		const gen = ++this.directionLocateGen;
		this.directionLocating = true;
		this.placeError = '';
		this.cdr.markForCheck();
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				if (gen !== this.directionLocateGen || !this.map) {
					return;
				}
				this.directionLocating = false;
				const lat = pos.coords.latitude;
				const lng = pos.coords.longitude;
				const zoom = Math.min(
					this.map.getMaxZoom(),
					Math.max(this.visibleLeafletZoom(), TraceViewerModalComponent.USER_POSITION_ZOOM)
				);
				this.map.setView([lat, lng], zoom, { animate: false });
				if (this.relief3d) {
					this.terrainView?.jumpTo(lat, lng, zoom);
				}
				this.currentZoom = zoom;
				this.applyDirectionTarget(picked);
				this.updateDeviceLocationMarker(lat, lng);
				this.closePlaceModal();
				this.cdr.markForCheck();
			},
			() => {
				if (gen !== this.directionLocateGen) {
					return;
				}
				this.directionLocating = false;
				this.applyDirectionTarget(picked);
				this.placeError = this.translate('EVENTELEM.TRACK_DIRECTION_GPS_ERROR');
				this.cdr.markForCheck();
			},
			{ enableHighAccuracy: true, timeout: 8000, maximumAge: 5000 }
		);
	}

	public clearDirectionTarget(): void {
		this.clearDirectionTargetState();
		this.syncDeviceLocationArrows();
		this.closePlaceModal();
		this.cdr.markForCheck();
	}

	private applyDirectionTarget(picked: { lat: number; lng: number; label: string }): void {
		this.directionTarget = { lat: picked.lat, lng: picked.lng, label: picked.label };
		this.directionTargetFollowsDevice = false;
		this.directionTargetActive = true;
		void this.startCompassHeading();
		this.syncDeviceLocationArrows();
		this.cdr.markForCheck();
	}

	public confirmGotoLocation(): void {
		if (!this.map) {
			return;
		}
		const picked = this.placeSelected;
		if (!picked) {
			this.placeError = this.translate(this.placeMode === 'coords'
				? 'ADDRESS_GEOCODE.INVALID_COORDINATES'
				: 'EVENTELEM.TRACK_GOTO_SELECT');
			this.cdr.markForCheck();
			return;
		}
		this.showGotoLocation(picked.lat, picked.lng, picked.label);
		this.closePlaceModal();
	}

	public clearGotoTarget(): void {
		if (this.selectionMarker) {
			try {
				this.selectionMarker.remove();
			} catch {
				/* ignore */
			}
			this.selectionMarker = undefined;
		}
		this.gotoTargetActive = false;
		this.terrainView?.setPin(null);
		this.closePlaceModal();
		this.cdr.markForCheck();
	}

	/** Centre la carte sur le point choisi et pose le repère rouge. */
	private showGotoLocation(lat: number, lng: number, label: string): void {
		if (!this.map || !isValidGeoCoordinate(lat, lng)) {
			return;
		}
		if (this.followDeviceLocation) {
			this.followDeviceLocation = false;
			this.onFollowDeviceLocationChange();
		}
		this.createSelectionMarker(lat, lng, false);
		const tip = label.trim();
		if (tip && this.selectionMarker) {
			this.selectionMarker.bindTooltip(tip, { direction: 'top', offset: [0, -36] });
		}
		this.selectionMarker?.on('click', (e: L.LeafletMouseEvent) => {
			L.DomEvent.stopPropagation(e);
			this.clearGotoTarget();
			this.clearDirectionTarget();
		});
		const zoom = Math.min(
			this.map.getMaxZoom(),
			Math.max(this.visibleLeafletZoom(), TraceViewerModalComponent.USER_POSITION_ZOOM)
		);
		this.map.setView([lat, lng], zoom, { animate: false });
		if (this.relief3d) {
			this.terrainView?.jumpTo(lat, lng, zoom);
			this.terrainView?.setPin({ lat, lng });
		}
		this.currentZoom = zoom;
		this.finalSelectedCoordinates = { lat, lng };
		this.gotoTargetActive = true;
		this.updateSwitchesForPoint(lat, lng);
		this.cdr.markForCheck();
	}

	/** « lat, lon », « lat lon » ou « lat,lon ». */
	private parseGotoCoordinates(input: string): { lat: number; lng: number } | null {
		const trimmed = (input || '').trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
		const parts = trimmed.split(' ').filter((part) => part.length > 0);
		if (parts.length < 2) {
			return null;
		}
		const lat = parseFloat(parts[0]);
		const lng = parseFloat(parts[1]);
		if (!isValidGeoCoordinate(lat, lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
			return null;
		}
		return { lat, lng };
	}

	private clearPlaceSearchState(): void {
		this.placeSearchSub?.unsubscribe();
		this.placeSearchSub = undefined;
		this.placeMode = 'address';
		this.placeQuery = '';
		this.placeCoords = '';
		this.placeResults = [];
		this.placeSelectedIndex = null;
		this.placeError = '';
		this.placeSearching = false;
		this.placeOrigin = null;
	}

	private clearDirectionTargetState(): void {
		this.directionTarget = null;
		this.directionTargetFollowsDevice = false;
		this.directionTargetActive = false;
		this.directionLocating = false;
		if (this.mapOrientation !== 'north') {
			this.stopCompassHeading();
		}
	}

	public formatGpxDistance(meters: number | null): string {
		if (meters == null || !Number.isFinite(meters)) {
			return '—';
		}
		if (meters < 1000) {
			return `${Math.round(meters)} m`;
		}
		return `${(meters / 1000).toFixed(2)} km`;
	}

	public formatGpxDuration(sec: number | null): string {
		if (sec == null || !Number.isFinite(sec) || sec < 0) {
			return '—';
		}
		const h = Math.floor(sec / 3600);
		const m = Math.floor((sec % 3600) / 60);
		const s = Math.floor(sec % 60);
		if (h > 0) {
			return `${h} h ${m.toString().padStart(2, '0')} min`;
		}
		if (m > 0) {
			return `${m} min ${s.toString().padStart(2, '0')} s`;
		}
		return `${s} s`;
	}

	public formatGpxCoord(v: number | null): string {
		if (v == null || !Number.isFinite(v)) {
			return '—';
		}
		return v.toFixed(6);
	}

	public formatGpxElev(v: number | null): string {
		if (v == null || !Number.isFinite(v)) {
			return '—';
		}
		return `${v} m`;
	}

	public formatGpxSpeed(v: number | null): string {
		if (v == null || !Number.isFinite(v)) {
			return '—';
		}
		return `${v} km/h`;
	}

	public formatGpxFileSize(bytes: number): string {
		if (!Number.isFinite(bytes) || bytes < 0) {
			return '—';
		}
		if (bytes < 1024) {
			return `${bytes} B`;
		}
		if (bytes < 1024 * 1024) {
			return `${(bytes / 1024).toFixed(1)} KB`;
		}
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	}

	public formatGpxDateTime(iso: string | null): string {
		if (!iso) {
			return '—';
		}
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) {
			return iso;
		}
		return d.toLocaleString();
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
		// Invalidate any pending finalize from a previous modal before dismissing it.
		const generation = ++this.modalGeneration;
		this.dismissTraceViewerModalIfOpen();
		this.resetState();
		const label = source.titleLabel != null && source.titleLabel.trim().length > 0 ? source.titleLabel.trim() : '';
		this.trackFileName = label.length > 0 ? label : source.fileName;
		this.gpsSourceFileId = source.fileId || null;
		this.gpsSourceFileName = source.fileName || this.trackFileName;
		this.initializeBaseLayers();
		if (source.initialBaseLayerId && this.baseLayers[source.initialBaseLayerId]) {
			this.selectedBaseLayerId = source.initialBaseLayerId;
		}
		const loc = source.location;
		this.pendingLocation =
			loc != null && isValidGeoCoordinate(loc.lat, loc.lng) ? loc : null;
		this.pendingPositions = source.positions ?? null;
		this.pendingTrackPoints = source.trackPoints?.length ? [...source.trackPoints] : null;
		this.pendingTraces = source.traces?.length
			? source.traces.map((trace) => ({ name: trace.name, points: trace.points.slice() }))
			: null;
		if (this.pendingTraces?.length) {
			this.pendingTrackPoints = null;
			this.pendingLocation = null;
			this.pendingPositions = null;
			this.trackStats = null;
			this.gpxAnalysis = null;
		}
		if (this.pendingLocation) {
			this.pendingTrackPoints = null;
			this.trackStats = null;
		}
		if (this.pendingPositions) {
			this.pendingTrackPoints = null;
			this.pendingLocation = null;
			this.trackStats = null;
		}
		if (this.pendingTrackPoints) {
			this.pendingLocation = null;
			this.pendingPositions = null;
			this.trackStats = null;
		}

		const defaultModalOpts: NgbModalOptions = {
			size: 'xl',
			centered: true,
			backdrop: 'static',
			keyboard: true,
			// Pas de fondu : ng-bootstrap n’ajoute .show qu’après le rendu, et .fade garde la fenêtre à opacity 0.
			animation: false,
			// Pas de modal-smooth-animation : scale/translate sur .modal-dialog casse Leaflet (tuiles grises).
			windowClass: TraceViewerModalComponent.TRACE_VIEWER_MODAL_WINDOW_CLASS,
			modalDialogClass: 'modal-xl'
		};
		const modalOpts = this.nextModalOptionsOverride ?? defaultModalOpts;
		this.nextModalOptionsOverride = null;
		const hostOpt = modalOpts.container;
		this.mapEmbedHostRoot =
			typeof HTMLElement !== 'undefined' && hostOpt instanceof HTMLElement ? hostOpt : undefined;
		this.refreshTraceViewerViewportFlags();
		this.modalRef = this.modalService.open(this.traceViewerModal, modalOpts);
		const pageSkin = findSkinnedPageHost();
		if (pageSkin) {
			this.applyHostSkin(pageSkin);
		}
		this.hasEmittedClosed = false;
		this.registerMobileViewportListener();
		// Scrollbar from the opened modal can change innerWidth. Apply that on the next tick
		// so the *ngIf value stays stable for the check that open() already ran.
		window.setTimeout(() => {
			if (!this.modalRef) {
				return;
			}
			this.refreshTraceViewerViewportFlags();
			this.scheduleTraceViewerCdr();
		}, 0);

		const finalizeModal = () => {
			// Ignore stale closed/dismissed from a modal that was replaced by a newer open().
			if (generation !== this.modalGeneration) {
				return;
			}
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
		} else if (this.pendingTraces?.length) {
			this.tryRenderPendingTrack();
		} else if (this.pendingTrackPoints && this.pendingTrackPoints.length > 0) {
			this.tryRenderPendingTrack();
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
		const generation = this.modalGeneration;

		const shown$ = modalRefAny?.shown;
		const hidden$ = modalRefAny?.hidden;

		if (shown$?.pipe) {
			shown$.pipe(take(1)).subscribe(() => {
				if (generation !== this.modalGeneration) {
					return;
				}
				this.onModalShown();
			});
		} else {
			const tick = (): void => {
				if (generation !== this.modalGeneration || !this.modalRef) {
					return;
				}
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
				// The previous viewer is still animating closed when a saved trace reopens it.
				// Its hidden event must not destroy the map that already drew the new track.
				if (generation !== this.modalGeneration) {
					return;
				}
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
			const redCrosshairCursor = this.mapCtrlRotateActive
				? 'grabbing'
				: 'url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><line x1="16" y1="0" x2="16" y2="12" stroke="red" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="20" x2="16" y2="32" stroke="red" stroke-width="2" stroke-linecap="round"/><line x1="0" y1="16" x2="12" y2="16" stroke="red" stroke-width="2" stroke-linecap="round"/><line x1="20" y1="16" x2="32" y2="16" stroke="red" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="16" r="2" fill="red"/></svg>\') 16 16, crosshair';
			mapContainer.style.cursor = redCrosshairCursor;
			mapContainer.classList.remove('leaflet-grab');

			const panes = mapContainer.querySelectorAll('.leaflet-pane, .leaflet-map-pane, .leaflet-tile-pane, .leaflet-overlay-pane');
			panes.forEach((pane: Element) => {
				(pane as HTMLElement).style.cursor = redCrosshairCursor;
			});
		}
	}

	/**
	 * Le fit du tracé émet zoomend, qui passe par scheduleTraceViewerCdr.
	 * Ce timer-là ne doit pas être le même, sinon isMapReady ne passe jamais à true
	 * et les boutons d’orientation restent disabled.
	 */
	private armMapReadyFlag(): void {
		if (this.mapReadyTimer != null) {
			clearTimeout(this.mapReadyTimer);
		}
		this.mapReadyTimer = window.setTimeout(() => {
			this.mapReadyTimer = null;
			if (!this.map) {
				return;
			}
			this.isMapReady = true;
			this.cdr.markForCheck();
		}, 0);
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

	/** Le zoom Leaflet et le zoom 3D arrivent dans le même cycle : l’affichage attend le tick suivant. */
	private deferZoomFooter(zoom: number): void {
		const shown = Math.round(zoom * 100) / 100;
		this.pendingZoomFooter = shown;
		if (this.zoomFooterTimer != null) {
			return;
		}
		// Hors zone : le setTimeout ne lance pas un rendu pendant lequel un second zoom réécrirait la valeur (NG0100).
		this.ngZone.runOutsideAngular(() => {
			this.zoomFooterTimer = window.setTimeout(() => {
				this.zoomFooterTimer = null;
				const pending = this.pendingZoomFooter;
				this.pendingZoomFooter = null;
				if (pending == null || pending === this.zoomFooterView) {
					return;
				}
				this.ngZone.run(() => {
					this.zoomFooterView = pending;
				});
			}, 0);
		});
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
		return this.weatherPointLocationLabelCached;
	}

	private refreshWeatherPointWeatherLocationLabel(): void {
		this.weatherPointLocationLabelCached = resolveWeatherPointLocationLabel({
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
		this.syncWeatherTimelineRegion();
		if (this.weatherTimelineRegion === 'switzerland') {
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
		if (this.pairEditMode) {
			setTimeout(() => {
				this.renderPairMarkers();
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

	private cancelMapInitRetry(): void {
		if (this.mapInitRetryTimer != null) {
			clearTimeout(this.mapInitRetryTimer);
			this.mapInitRetryTimer = null;
		}
		if (this.mapInitRetryRaf != null) {
			cancelAnimationFrame(this.mapInitRetryRaf);
			this.mapInitRetryRaf = null;
		}
	}

	/** One pending retry. Returns false once the cap is hit so the caller can stop or fall through. */
	private scheduleMapInitRetry(): boolean {
		this.cancelMapInitRetry();
		this.mapInitVisibilityAttempts += 1;
		if (!this.modalRef || this.mapInitVisibilityAttempts >= 100) {
			return false;
		}
		if (this.mapInitVisibilityAttempts < 4) {
			this.mapInitRetryRaf = requestAnimationFrame(() => {
				this.mapInitRetryRaf = null;
				this.initializeMap();
			});
		} else {
			this.mapInitRetryTimer = window.setTimeout(() => {
				this.mapInitRetryTimer = null;
				this.initializeMap();
			}, 50);
		}
		return true;
	}

	private initializeMap(): void {
		this.cancelMapInitRetry();
		if (!this.modalRef) {
			return;
		}
		if (this.map) {
			if (this.mapIsBoundToLiveContainer()) {
				return;
			}
			this.destroyMap();
		}

		const container = this.resolveMapContainerElement();
		if (!container) {
			this.scheduleMapInitRetry();
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
			if (this.scheduleMapInitRetry()) {
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
				// Canvas renderer: a long GPX as SVG blanks the tile pane (grey map, controls still visible).
				preferCanvas: true,
				...LEAFLET_SMOOTH_WHEEL_MAP_OPTIONS,
				// Keep a consistent max zoom across basemaps; basemaps handle over-zoom via maxNativeZoom.
				maxZoom: 20,
				doubleClickZoom: false,
				// Inertie Leaflet (~50 ms) quasi invisible à la souris ; courte glissade custom.
				inertia: false,
				rotate: true,
				bearing: 0,
				touchRotate: false,
				shiftKeyRotate: false,
				// Pas le contrôle Leaflet « Rotate map » (clic = modes touch/compas, rien de visible sur desktop).
				// Orientation via boutons Nord / Marche / Route.
				rotateControl: false
			} as L.MapOptions);
		} catch (e) {
			this.releaseLeafletControlPassiveTouchPatch();
			throw e;
		}

		this.registerTraceMapWheelZoom();
		this.registerTraceMapCtrlRotate();
		this.registerTraceMapPanInertia();
		this.setupMapLayoutObserver((container.closest('.map-wrapper') ?? container) as HTMLElement);

		// Force crosshair cursor on map container
		this.forceCrosshairCursor();

		this.overlayLayer = L.layerGroup().addTo(this.map);
		this.restorePendingTrackFromLastRender();
		this.applyInitialMapViewForPendingTrackData();
		this.applySelectedBaseLayer();
		this.registerRightClickZoom();

		// Maintain crosshair cursor even when Leaflet changes classes
		this.map.on('moveend', () => {
			this.forceCrosshairCursor();
			this.refreshOrientationAfterMapMove();
			this.schedulePlaces();
		});
		this.schedulePlaces();
		this.map.on('zoomend', () => {
			this.forceCrosshairCursor();
			if (this.visibleSwisstopoBasemap() && this.map) {
				const rounded = Math.round(this.map.getZoom());
				if (Math.abs(this.map.getZoom() - rounded) > 0.01) {
					this.snapSwisstopoTiles();
					return;
				}
			}
			this.currentZoom = this.map!.getZoom();
			this.scheduleTraceViewerCdr();
		});
		this.map.on('rotate' as any, () => this.updateCompassRose());
		this.currentZoom = this.map.getZoom();
		this.scheduleTraceViewerCdr();

		this.map.whenReady(() => {
			this.armMapReadyFlag();
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

			this.syncMapOrientationWatch();
			this.updateCompassRose();
			this.applyPersistedSwitchEffects();
			this.applyWeatherStationsOverlay();
			this.startRelief3dFromFlat();
		});
	}

	private registerTraceMapWheelZoom(): void {
		if (!this.map || this.mapWheelZoom) {
			return;
		}
		this.mapWheelZoom = attachLeafletMapWheelZoom(this.map, {
			shiftRotates: true,
			afterZoom: (zoom) => {
				this.currentZoom = zoom;
				this.scheduleTraceViewerCdr();
			}
		});
	}

	private registerTraceMapPanInertia(): void {
		if (!this.map || this.mapPanInertia) {
			return;
		}
		this.mapPanInertia = attachLeafletPanInertia(this.map);
	}

	private unregisterTraceMapPanInertia(): void {
		this.mapPanInertia?.detach();
		this.mapPanInertia = null;
	}

	private unregisterTraceMapWheelZoom(): void {
		this.mapWheelZoom?.detach();
		this.mapWheelZoom = null;
	}

	private registerTraceMapCtrlRotate(): void {
		if (!this.map || this.mapCtrlRotate) {
			return;
		}
		this.mapCtrlRotate = attachLeafletCtrlDragRotate(this.map as RotatableLeafletMap, {
			enabled: () => !this.relief3d,
			onRotateStart: () => {
				this.mapCtrlRotateActive = true;
				this.manualMapBearing = this.currentMapBearingDeg();
				this.stopMapBearingGlide();
				if (this.mapOrientation !== 'fixed') {
					this.mapOrientation = 'fixed';
					this.syncMapOrientationWatch();
					this.scheduleTraceViewerCdr();
				}
				this.forceCrosshairCursor();
			},
			onRotate: (bearing) => {
				this.manualMapBearing = this.wrapDeg(bearing);
				this.syncDeviceLocationArrows();
			},
			onRotateEnd: () => {
				this.mapCtrlRotateActive = false;
				this.forceCrosshairCursor();
				this.syncDeviceLocationArrows();
			}
		});
	}

	private unregisterTraceMapCtrlRotate(): void {
		this.mapCtrlRotate?.detach();
		this.mapCtrlRotate = null;
		this.mapCtrlRotateActive = false;
	}

	/** WMTS Swisstopo : zoom entier obligatoire (zoomSnap 0 → 14,8 ne charge pas les tuiles). */
	private snapSwisstopoTiles(): void {
		if (!this.map || !this.visibleSwisstopoBasemap()) {
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

	/** Load another GPX into the viewer that is already open, without recreating the modal. */
	private replaceOpenTrack(source: { blob: Blob; fileName: string; titleLabel: string }): void {
		this.resetTraceViewerColors();
		const label = (source.titleLabel || '').trim();
		this.trackFileName = label || source.fileName;
		this.gpsSourceFileId = null;
		this.gpsSourceFileName = source.fileName || this.trackFileName;
		this.hasError = false;
		this.errorMessage = '';
		this.isLoading = false;
		this.trackStats = null;
		this.gpxAnalysis = null;
		this.pendingTrackPoints = null;
		this.pendingTraces = null;
		this.lastRenderedTrackPoints = null;
		this.lastRenderedTraces = null;
		this.displayedTraces = [];
		this.pendingLocation = null;
		this.pendingPositions = null;
		this.trackBounds = null;
		this.locationRecenterZoom = null;
		this.trackOrientationCoords = [];
		this.routeHeadingDeg = 0;
		this.overlayLayer?.clearLayers();
		this.cdr.detectChanges();
		if (!this.mapIsBoundToLiveContainer()) {
			this.destroyMap();
			this.initializeMap();
		} else {
			this.map?.invalidateSize({ animate: false });
		}
		this.readFromBlob(source.blob, source.fileName);
	}

	private mapIsBoundToLiveContainer(): boolean {
		if (!this.map) {
			return false;
		}
		const bound = this.map.getContainer();
		const live = this.resolveMapContainerElement();
		return !!bound?.isConnected && !!live && bound === live;
	}

	private cancelEnsureMapInitRetry(): void {
		if (this.ensureMapInitTimer != null) {
			clearTimeout(this.ensureMapInitTimer);
			this.ensureMapInitTimer = null;
		}
	}

	private ensureMapInitialization(): void {
		this.cancelEnsureMapInitRetry();
		if (!this.modalRef) {
			return;
		}
		if (this.map && !this.mapIsBoundToLiveContainer()) {
			this.destroyMap();
		}
		if (this.map) {
			this.ensureMapInitAttempts = 0;
			return;
		}

		if (this.resolveMapContainerElement()) {
			this.ensureMapInitAttempts = 0;
			this.initializeMap();
			return;
		}

		this.ensureMapInitAttempts += 1;
		if (this.ensureMapInitAttempts >= 100) {
			return;
		}
		this.ensureMapInitTimer = window.setTimeout(() => {
			this.ensureMapInitTimer = null;
			this.ensureMapInitialization();
		}, 50);
	}

	private loadFromFileId(fileId: string, fileName: string): void {
		this.isLoading = true;
		this.cdr.detectChanges();

		// Text first: the Android WebView often cannot read a GPX downloaded as an ArrayBuffer.
		this.fileService.getFileText(fileId).pipe(takeUntil(this.destroy$)).subscribe({
			next: (text: string) => {
				this.consumeTrackText(text, fileName);
			},
			error: (err: unknown) => {
				console.error('[TraceViewer] file download failed', fileId, err);
				void this.loadTrackFromOfflineCopy(fileId, fileName);
			}
		});
	}

	/** Device copy saved from the photo wall, when the network read failed. */
	private async loadTrackFromOfflineCopy(fileId: string, fileName: string): Promise<void> {
		try {
			const rec = await this.offlineTraces.get(offlineTraceIdForWall(fileId));
			const buffer = rec ? await this.toTrackArrayBuffer(rec.data) : null;
			if (buffer) {
				this.consumeTrackText(this.decodeArrayBuffer(buffer), rec?.fileName || fileName);
				return;
			}
		} catch (err) {
			console.error('[TraceViewer] offline track fallback failed', fileId, err);
		}
		this.isLoading = false;
		this.setError(this.translate('EVENTELEM.TRACK_LOAD_ERROR'));
	}

	private consumeTrackText(text: string, fileName: string): void {
		this.isLoading = true;
		this.gpxAnalysis = null;
		this.cdr.detectChanges();
		try {
			const source = (text || '').replace(/^\uFEFF/, '');
			if (!source.trim()) {
				this.setError(this.translate('EVENTELEM.TRACK_LOAD_ERROR'));
				return;
			}
			const extension = this.getFileExtension(fileName);
			this.tryAnalyzeGpx(fileName, source, source.length);
			this.renderTrack(source, extension);
		} catch (err) {
			console.error('[TraceViewer] track read failed', fileName, err);
			if (!this.pendingTrackPoints?.length && !this.lastRenderedTrackPoints?.length) {
				this.setError(this.translate('EVENTELEM.TRACK_LOAD_ERROR'));
			}
		} finally {
			this.isLoading = false;
			this.cdr.detectChanges();
		}
	}

	private readFromBlob(blob: Blob, fileName: string): void {
		void this.consumeTrackPayload(blob, fileName);
	}

	/**
	 * Android WebView often rejects Blob.arrayBuffer() or returns a typed array
	 * instead of an ArrayBuffer. Read the bytes with a FileReader fallback.
	 */
	private async consumeTrackPayload(payload: unknown, fileName: string): Promise<void> {
		this.isLoading = true;
		this.gpxAnalysis = null;
		this.cdr.detectChanges();
		try {
			const buffer = await this.toTrackArrayBuffer(payload);
			if (!buffer || buffer.byteLength === 0) {
				this.setError(this.translate('EVENTELEM.TRACK_LOAD_ERROR'));
				return;
			}
			const extension = this.getFileExtension(fileName);
			const text = this.decodeArrayBuffer(buffer);
			this.tryAnalyzeGpx(fileName, text, buffer.byteLength);
			this.renderTrack(text, extension);
		} catch (err) {
			console.error('[TraceViewer] track read failed', fileName, err);
			this.setError(this.translate('EVENTELEM.TRACK_LOAD_ERROR'));
		} finally {
			this.isLoading = false;
			this.cdr.detectChanges();
		}
	}

	private async toTrackArrayBuffer(payload: unknown): Promise<ArrayBuffer | null> {
		const rawBuffer = this.asArrayBuffer(payload);
		if (rawBuffer) {
			return rawBuffer;
		}
		if (ArrayBuffer.isView(payload)) {
			if (payload.byteLength <= 0) {
				return null;
			}
			const copy = new ArrayBuffer(payload.byteLength);
			new Uint8Array(copy).set(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
			return copy;
		}
		if (typeof payload === 'string' && payload.trim()) {
			return new TextEncoder().encode(payload).buffer;
		}
		if (typeof Blob !== 'undefined' && payload instanceof Blob && payload.size > 0) {
			if (typeof payload.arrayBuffer === 'function') {
				try {
					const buffer = await payload.arrayBuffer();
					if (buffer.byteLength > 0) {
						return buffer;
					}
				} catch {
					/* WebView: fall through to FileReader */
				}
			}
			return this.readBlobWithFileReader(payload);
		}
		return null;
	}

	/** `instanceof ArrayBuffer` est faux pour certains buffers du WebView Android. */
	private asArrayBuffer(payload: unknown): ArrayBuffer | null {
		if (!payload || typeof payload !== 'object') {
			return null;
		}
		const isBuffer = payload instanceof ArrayBuffer
			|| Object.prototype.toString.call(payload) === '[object ArrayBuffer]';
		if (!isBuffer) {
			return null;
		}
		const buffer = payload as ArrayBuffer;
		return buffer.byteLength > 0 ? buffer : null;
	}

	private readBlobWithFileReader(blob: Blob): Promise<ArrayBuffer> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result;
				if (result instanceof ArrayBuffer && result.byteLength > 0) {
					resolve(result);
					return;
				}
				reject(new Error('empty track file'));
			};
			reader.onerror = () => reject(reader.error || new Error('track file read failed'));
			reader.readAsArrayBuffer(blob);
		});
	}

	/** Populate `gpxAnalysis` when the loaded content is a GPX file. */
	private tryAnalyzeGpx(fileName: string, text: string, fileSizeBytes: number): void {
		this.gpxAnalysis = null;
		const looksLikeGpx =
			isGpxFileName(fileName) ||
			this.getFileExtension(fileName) === 'gpx' ||
			/<gpx[\s>]/i.test(text);
		if (!looksLikeGpx) {
			return;
		}
		try {
			const analysis = analyzeGpxFileContent(fileName || 'track.gpx', text, fileSizeBytes);
			if (
				analysis.trackPointCount > 0 ||
				analysis.routePointCount > 0 ||
				analysis.waypointCount > 0
			) {
				this.gpxAnalysis = analysis;
				this.syncTrackStatsFromGpxAnalysis(analysis);
				if (analysisNeedsDemElevation(analysis)) {
					this.enrichGpxAnalysisElevation(analysis);
				}
			}
		} catch (error) {
			console.warn('[TraceViewer] GPX analysis failed', error);
		}
	}

	/** Prefer computed GPX distance in the footer when Leaflet stats are empty. */
	private syncTrackStatsFromGpxAnalysis(analysis: GpxAnalysis): void {
		if (analysis.distanceM == null || !Number.isFinite(analysis.distanceM)) {
			return;
		}
		const km = Math.round((analysis.distanceM / 1000) * 100) / 100;
		if (!this.trackStats) {
			this.trackStats = {
				points: analysis.points.length || analysis.trackPointCount || 0,
				distanceKm: km
			};
			return;
		}
		if (this.trackStats.distanceKm == null) {
			this.trackStats = { ...this.trackStats, distanceKm: km };
		}
	}

	/** Fill elevation from DEM when the GPX has no ele tags. */
	private enrichGpxAnalysisElevation(analysis: GpxAnalysis): void {
		const samples = sampleLatLonsForElevation(analysis.points, 80);
		if (samples.length < 2) {
			return;
		}
		this.apiService
			.lookupElevationsBatch(samples.map((s) => ({ lat: s.lat, lon: s.lon })))
			.pipe(take(1), catchError(() => of(null)))
			.subscribe((res) => {
				if (!res || this.gpxAnalysis !== analysis) {
					return;
				}
				enrichAnalysisWithDemElevations(analysis, samples, res.altitudesM || []);
				this.gpxAnalysis = { ...analysis };
				this.syncTrackStatsFromGpxAnalysis(analysis);
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

	/** Max zoom supported by the visible basemaps (fitBounds beyond this shows gray tiles). */
	private resolveFitBoundsMaxZoom(): number {
		if (!this.map) {
			return TraceViewerModalComponent.DEFAULT_LOCATION_ZOOM;
		}
		const caps = [this.layerFitMaxZoom(this.activeBaseLayer)];
		if (this.basemapBlend > 0) {
			caps.push(this.layerFitMaxZoom(this.activeBlendLayer));
		}
		const limited = caps.filter((value): value is number => value != null && value > 2);
		if (limited.length) {
			return Math.min(...limited);
		}
		return Math.min(this.map.getMaxZoom(), 18);
	}

	private layerFitMaxZoom(layer: L.Layer | undefined): number | null {
		if (!layer) {
			return null;
		}
		if (layer instanceof L.TileLayer) {
			return layer.options.maxZoom ?? null;
		}
		if (layer instanceof L.LayerGroup) {
			let max = 0;
			layer.eachLayer((child) => {
				const childMax = this.layerFitMaxZoom(child);
				if (childMax != null) {
					max = Math.max(max, childMax);
				}
			});
			return max > 0 ? max : null;
		}
		return null;
	}

	/** Centrage trace : fitBounds avec plafond de zoom ; point unique → setView. */
	private fitMapToTrackBounds(bounds: L.LatLngBounds): void {
		if (!this.map || !bounds.isValid()) {
			return;
		}
		this.map.invalidateSize({ animate: false, pan: false });
		const maxZoom = this.resolveFitBoundsMaxZoom();
		const size = this.map.getSize();
		if (!size || size.x < 2 || size.y < 2) {
			const zoom = Math.min(maxZoom, Math.max(2, this.locationRecenterZoom ?? 13));
			this.map.setView(bounds.getCenter(), zoom, { animate: false });
			this.currentZoom = this.map.getZoom();
			return;
		}
		if (this.isDegenerateBounds(bounds)) {
			const zoom = Math.min(
				maxZoom,
				Math.max(2, this.locationRecenterZoom ?? TraceViewerModalComponent.DEFAULT_LOCATION_ZOOM)
			);
			this.map.setView(bounds.getCenter(), zoom, { animate: false });
			this.currentZoom = zoom;
			return;
		}
		this.map.fitBounds(bounds, { padding: [24, 24], maxZoom, animate: false });
		this.snapMapZoomForTiles();
	}

	/**
	 * zoomSnap 0 (molette fluide) laisse fitBounds sur un zoom fractionnaire.
	 * Avec leaflet-rotate, ce zoom ne demande pas les tuiles : le fond reste gris.
	 * Le menu « Map » passe par setView à un zoom entier, donc les tuiles s’affichent.
	 */
	private snapMapZoomForTiles(): void {
		if (!this.map) {
			return;
		}
		const raw = this.map.getZoom();
		const rounded = Number.isFinite(raw) ? Math.round(raw) : 13;
		const zoom = Math.min(this.map.getMaxZoom(), Math.max(this.map.getMinZoom(), rounded));
		if (!Number.isFinite(raw) || Math.abs(raw - zoom) > 0.01) {
			this.map.setView(this.map.getCenter(), zoom, { animate: false });
		}
		this.currentZoom = this.map.getZoom();
	}

	private scheduleMapInvalidateAfterFit(): void {
		if (!this.map) {
			return;
		}
		const refit = (): void => {
			if (!this.map) {
				return;
			}
			this.map.invalidateSize({ animate: false });
			this.refitTrackIfLayoutSettling();
		};
		refit();
		window.setTimeout(refit, 50);
		window.setTimeout(refit, 200);
		window.setTimeout(refit, 600);
	}

	/**
	 * Every GPS vertex is drawn. Leaflet’s default smoothFactor (1 px) drops
	 * points closer than a pixel, which is much more visible on a phone where
	 * the whole track fits in fewer pixels. Canvas (preferCanvas) already
	 * avoids the Android WebView blank-tile bug of a huge SVG path.
	 */
	private trackPolylineOptions(color: string): L.PolylineOptions {
		return {
			color,
			weight: 4,
			opacity: 0.9,
			smoothFactor: 0
		};
	}

	/** Redraw a track whose pending list was already consumed before a stale map destroy. */
	private restorePendingTrackFromLastRender(): void {
		if (this.pendingTraces?.length || this.pendingTrackPoints?.length || this.pendingPositions?.length || this.pendingLocation) {
			return;
		}
		if (this.lastRenderedTraces?.length) {
			this.pendingTraces = this.lastRenderedTraces.map((trace) => ({ name: trace.name, points: trace.points.slice() }));
			return;
		}
		if (this.lastRenderedTrackPoints?.length) {
			this.pendingTrackPoints = this.lastRenderedTrackPoints.slice();
		}
	}

	/** A map with no center/zoom cannot load tiles. Menu open always setView; a GPX must do the same before the line is drawn. */
	private applyInitialMapViewForPendingTrackData(): void {
		if (!this.map) {
			return;
		}
		const anchor = this.previewCenterForPendingTrack();
		if (anchor) {
			this.map.setView(anchor, 13, { animate: false });
			return;
		}
		if (!this.trackBounds?.isValid()) {
			this.map.setView([46.2, 2.2], 6, { animate: false });
		}
	}

	private previewCenterForPendingTrack(): L.LatLngTuple | null {
		const pts = this.pendingTrackPoints?.length
			? this.pendingTrackPoints
			: this.pendingTraces?.find((trace) => trace.points.length)?.points;
		if (!pts?.length) {
			return null;
		}
		const mid = pts[Math.floor(pts.length / 2)];
		if (!Number.isFinite(mid[0]) || !Number.isFinite(mid[1])) {
			return null;
		}
		return mid;
	}

	/** Polyline/canvas added while zoom is NaN leaves the tile pane blank even after fitBounds. */
	private ensureFiniteMapView(anchor: L.LatLngTuple): void {
		if (!this.map) {
			return;
		}
		this.map.invalidateSize({ animate: false, pan: false });
		let centerOk = false;
		try {
			const center = this.map.getCenter();
			centerOk = Number.isFinite(center.lat) && Number.isFinite(center.lng);
		} catch {
			centerOk = false;
		}
		if (!Number.isFinite(this.map.getZoom()) || !centerOk) {
			this.map.setView(anchor, 13, { animate: false });
		}
	}

	private drawMultipleTraces(traces: { name: string; points: L.LatLngTuple[] }[]): void {
		if (!this.map || !this.overlayLayer) {
			return;
		}
		const drawable = traces.filter((trace) => trace.points.length >= 2);
		if (!drawable.length) {
			this.setError(this.translate('EVENTELEM.TRACK_NO_POINTS'));
			return;
		}
		this.ensureFiniteMapView(drawable[0].points[Math.floor(drawable[0].points.length / 2)]);
		this.overlayLayer.clearLayers();
		const colors = TraceViewerModalComponent.MULTI_TRACE_COLORS;
		const legend: { name: string; color: string }[] = [];
		const stored: { name: string; points: L.LatLngTuple[] }[] = [];
		const allPoints: L.LatLngTuple[] = [];
		let distanceKm = 0;
		drawable.forEach((trace, index) => {
			const color = colors[index % colors.length];
			const line = L.polyline(trace.points, this.trackPolylineOptions(color));
			line.bindTooltip(trace.name, { sticky: true });
			line.addTo(this.overlayLayer!);
			L.circleMarker(trace.points[0], {
				radius: 5,
				color: '#ffffff',
				weight: 2,
				fillColor: color,
				fillOpacity: 1
			}).bindTooltip(trace.name).addTo(this.overlayLayer!);
			const end = trace.points[trace.points.length - 1];
			L.circleMarker(end, {
				radius: 5,
				color,
				weight: 2,
				fillColor: '#ffffff',
				fillOpacity: 1
			}).bindTooltip(trace.name).addTo(this.overlayLayer!);
			legend.push({ name: trace.name, color });
			stored.push({ name: trace.name, points: trace.points.slice() });
			allPoints.push(...trace.points);
			const km = this.computeDistance(trace.points);
			if (km != null && Number.isFinite(km)) {
				distanceKm += km;
			}
		});
		this.displayedTraces = legend;
		this.lastRenderedTraces = stored;
		this.lastRenderedTrackPoints = allPoints;
		this.locationRecenterZoom = null;
		this.trackOrientationCoords = drawable[0].points.slice();
		this.updateRouteHeadingFromTrack();
		const bounds = L.latLngBounds(allPoints);
		this.trackBounds = bounds;
		this.map.invalidateSize({ animate: false });
		this.fitMapToTrackBounds(bounds);
		this.noteTrackFitted();
		this.scheduleMapInvalidateAfterFit();
		this.clearPendingRenderRetry();
		this.hasError = false;
		this.trackStats = {
			points: allPoints.length,
			distanceKm: Math.round(distanceKm * 100) / 100
		};
		this.applyMapBearing();
		this.syncRelief3dOverlays();
		this.terrainView?.fitTraces();
		this.cdr.detectChanges();
	}

	private presentTraces(traces: { name: string; points: L.LatLngTuple[] }[]): void {
		const title = traces.length === 1
			? traces[0].name
			: this.translate('EVENTELEM.OFFLINE_TRACES_MULTI', { count: traces.length });
		this.eventColor = null;
		if (this.modalRef) {
			this.trackFileName = title;
			this.gpsSourceFileId = null;
			this.gpsSourceFileName = traces.map((trace) => trace.name).join(', ');
			this.hasError = false;
			this.errorMessage = '';
			this.isLoading = false;
			this.gpxAnalysis = null;
			this.pendingLocation = null;
			this.pendingPositions = null;
			this.pendingTraces = traces.map((trace) => ({ name: trace.name, points: trace.points.slice() }));
			this.pendingTrackPoints = null;
			this.ensureMapInitialization();
			this.tryRenderPendingTrack();
			this.cdr.detectChanges();
			return;
		}
		this.open({ fileName: title, titleLabel: title, traces });
	}

	private tryRenderPendingTrack(): void {
		if (!this.map || !this.overlayLayer || (!this.pendingTrackPoints && !this.pendingTraces?.length)) {
			return;
		}

		if (this.deferRenderUntilMapSized(160)) {
			return;
		}

		if (this.pendingTraces?.length) {
			const traces = this.pendingTraces;
			this.pendingTraces = null;
			this.pendingTrackPoints = null;
			this.drawMultipleTraces(traces);
			return;
		}

		const points = this.pendingTrackPoints;
		if (!points) {
			return;
		}
		this.pendingTrackPoints = null;
		this.pendingTraces = null;
		this.lastRenderedTraces = null;
		this.displayedTraces = [];
		this.lastRenderedTrackPoints = points.slice();
		this.locationRecenterZoom = null;
		this.trackOrientationCoords = points.slice();
		this.updateRouteHeadingFromTrack();

		this.ensureFiniteMapView(points[Math.floor(points.length / 2)]);
		this.overlayLayer.clearLayers();

		const polyline = L.polyline(points, this.trackPolylineOptions('#007bff'));

		polyline.addTo(this.overlayLayer);
		polyline.bringToFront();

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

		const bounds = L.latLngBounds(points);
		this.trackBounds = bounds;
		this.map.invalidateSize({ animate: false });
		this.fitMapToTrackBounds(bounds);
		this.noteTrackFitted();
		this.scheduleMapInvalidateAfterFit();
		this.clearPendingRenderRetry();

		this.trackStats = {
			points: points.length,
			distanceKm: this.computeDistance(points)
		};
		this.applyMapBearing();
		this.syncRelief3dOverlays();
		this.terrainView?.fitTraces();
		this.cdr.detectChanges();
	}

	private tryRenderPendingPositions(): void {
		if (!this.map || !this.overlayLayer || !this.pendingPositions || this.pendingPositions.length === 0) {
			return;
		}

		if (this.deferRenderUntilMapSized()) {
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

	/** SVG pin (same shape as friends / selection) — avoids fragile default Leaflet PNG icons. */
	private createPinDivIcon(fill: string, className: string): L.DivIcon {
		return L.divIcon({
			className,
			html: `
				<div style="width: 25px; height: 41px; position: relative;">
					<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg" style="display: block;">
						<path d="M12.5 0C5.596 0 0 5.596 0 12.5c0 12.5 12.5 28.5 12.5 28.5s12.5-16 12.5-28.5C25 5.596 19.404 0 12.5 0z" fill="${fill}" stroke="#FFFFFF" stroke-width="1"/>
						<circle cx="12.5" cy="12.5" r="5" fill="#FFFFFF"/>
					</svg>
				</div>
			`,
			iconSize: [25, 41],
			iconAnchor: [12.5, 41],
			popupAnchor: [0, -41]
		});
	}

	private snapshotPair(): {
		user: { lat: number; lng: number } | null;
		mark: { lat: number; lng: number; alt?: number | null } | null;
	} {
		if (this.pairUserMarker) {
			const pos = this.pairUserMarker.getLatLng();
			this.pairUser = { lat: pos.lat, lng: pos.lng };
		}
		if (this.pairMarkMarker) {
			const pos = this.pairMarkMarker.getLatLng();
			this.pairMark = {
				lat: pos.lat,
				lng: pos.lng,
				alt: this.pairMark?.alt ?? null
			};
		}
		return { user: this.pairUser, mark: this.pairMark };
	}

	private clearPairMarkers(): void {
		if (this.map && this.pairClickHandler) {
			this.map.off('dblclick', this.pairClickHandler);
			this.map.doubleClickZoom.enable();
		}
		this.pairClickHandler = undefined;
		if (this.pairUserMarker) {
			this.pairUserMarker.remove();
			this.pairUserMarker = undefined;
		}
		if (this.pairMarkMarker) {
			this.pairMarkMarker.remove();
			this.pairMarkMarker = undefined;
		}
		if (this.pairLine) {
			this.pairLine.remove();
			this.pairLine = undefined;
		}
	}

	private renderPairMarkers(): void {
		if (!this.map || !this.pairEditMode) {
			return;
		}
		this.clearPairMarkers();
		const map = this.map;
		const pts: L.LatLngExpression[] = [];
		if (this.pairUser && isValidGeoCoordinate(this.pairUser.lat, this.pairUser.lng)) {
			this.pairUserMarker = L.marker([this.pairUser.lat, this.pairUser.lng], {
				draggable: true,
				icon: this.createPinDivIcon('#0066FF', 'custom-blue-marker'),
				zIndexOffset: 1000,
				riseOnHover: true
			}).addTo(map);
			this.pairUserMarker.on('dragend', () => {
				const pos = this.pairUserMarker!.getLatLng();
				this.pairUser = { lat: pos.lat, lng: pos.lng };
				this.updatePairLine();
				this.updateSwitchesForPoint(pos.lat, pos.lng);
			});
			pts.push([this.pairUser.lat, this.pairUser.lng]);
		}
		if (this.pairMark && isValidGeoCoordinate(this.pairMark.lat, this.pairMark.lng)) {
			this.pairMarkMarker = L.marker([this.pairMark.lat, this.pairMark.lng], {
				draggable: true,
				icon: this.createPinDivIcon('#FF0000', 'custom-red-marker'),
				zIndexOffset: 1100,
				riseOnHover: true
			}).addTo(map);
			this.pairMarkMarker.on('dragend', () => {
				const pos = this.pairMarkMarker!.getLatLng();
				this.pairMark = { lat: pos.lat, lng: pos.lng, alt: this.pairMark?.alt ?? null };
				this.updatePairLine();
				this.updateSwitchesForPoint(pos.lat, pos.lng);
			});
			pts.push([this.pairMark.lat, this.pairMark.lng]);
		}
		this.updatePairLine();
		if (pts.length === 2) {
			this.trackBounds = L.latLngBounds(pts);
			map.fitBounds(this.trackBounds, { padding: [48, 48], maxZoom: 16, animate: false });
		} else if (pts.length === 1) {
			map.setView(pts[0] as L.LatLngExpression, 14, { animate: false });
		}
		map.doubleClickZoom.disable();
		this.pairClickHandler = (e: L.LeafletMouseEvent) => {
			L.DomEvent.stop(e);
			const lat = e.latlng.lat;
			const lng = e.latlng.lng;
			if (!this.pairMark) {
				this.pairMark = { lat, lng };
			} else if (!this.pairUser) {
				this.pairUser = { lat, lng };
			} else {
				this.pairMark = { lat, lng, alt: this.pairMark.alt ?? null };
			}
			this.renderPairMarkers();
			this.updateSwitchesForPoint(lat, lng);
		};
		map.on('dblclick', this.pairClickHandler);
		this.refreshMapLayout();
		this.cdr.detectChanges();
	}

	private updatePairLine(): void {
		if (!this.map || !this.pairUser || !this.pairMark) {
			if (this.pairLine) {
				this.pairLine.remove();
				this.pairLine = undefined;
			}
			return;
		}
		const pts: L.LatLngExpression[] = [
			[this.pairUser.lat, this.pairUser.lng],
			[this.pairMark.lat, this.pairMark.lng]
		];
		if (this.pairLine) {
			this.pairLine.setLatLngs(pts);
			return;
		}
		this.pairLine = L.polyline(pts, {
			color: '#0066FF',
			weight: 2,
			opacity: 0.9
		}).addTo(this.map);
	}

	private resolveLocationPinColor(): string {
		if (this.eventColor) {
			const { r, g, b } = this.eventColor;
			const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
			return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
		}
		return '#0066FF';
	}

	private tryRenderPendingLocation(): void {
		if (!this.map || !this.overlayLayer || !this.pendingLocation) {
			return;
		}

		if (this.deferRenderUntilMapSized()) {
			return;
		}

		const { lat, lng } = this.pendingLocation;
		if (!isValidGeoCoordinate(lat, lng)) {
			this.pendingLocation = null;
			return;
		}
		const rawZ = this.pendingLocation.zoom;
		const viewZoom =
			rawZ != null && !Number.isNaN(rawZ) ? Math.min(19, Math.max(2, Math.round(rawZ))) : 14;

		// Store the location for share functionality
		this.lastRenderedPosition = { lat, lng };

		if (this.pairEditMode) {
			this.lastRenderedPosition = { lat, lng };
			this.renderPairMarkers();
			return;
		}

		// In selection mode, don't create the standard marker (will be created by registerLocationSelection)
		// and keep pendingLocation so registerLocationSelection can use it
		if (this.selectionMode) {
			this.trackBounds = L.latLngBounds([lat, lng], [lat, lng]);
			this.locationRecenterZoom = viewZoom;
			this.map.setView([lat, lng], viewZoom);
			this.refreshMapLayout();
			return;
		}

		const hidePin = this.pendingLocation.hidePin === true;
		// Carte « ma position » : le rond rouge suffit, pas d’épingle bleue.
		this.pendingLocation = null;

		this.overlayLayer.clearLayers();
		this.locationRecenterZoom = viewZoom;

		if (hidePin) {
			// Point provisoire (météo / Genève) uniquement pour l’ouverture :
			// ne pas le marquer comme position GPS — scheduleRecenterOnUser s’en charge.
			if (this.userGpsRecenterGen === this.modalGeneration) {
				this.trackStats = null;
				this.scheduleTraceViewerCdr();
				return;
			}
			this.trackBounds = L.latLngBounds([lat, lng], [lat, lng]);
			this.map.setView([lat, lng], viewZoom, { animate: false });
			this.currentZoom = viewZoom;
			this.trackStats = null;
			this.scheduleTraceViewerCdr();
			return;
		}

		// Normal mode: SVG pin (photo / webcam / address position)

		const markerIcon = this.createPinDivIcon(this.resolveLocationPinColor(), 'custom-location-marker');
		const marker = L.marker([lat, lng], {
			icon: markerIcon,
			zIndexOffset: 1000,
			riseOnHover: true
		});
		marker.on('click', (e: L.LeafletMouseEvent) => {
			e.originalEvent?.stopPropagation();
			L.DomEvent.stopPropagation(e);
			if (e.originalEvent) {
				L.DomEvent.preventDefault(e.originalEvent);
			}
			this.updateSwitchesForPoint(lat, lng);
		});
		marker.addTo(this.overlayLayer);

		this.trackBounds = L.latLngBounds([lat, lng], [lat, lng]);
		this.map.setView([lat, lng], viewZoom, { animate: false });
		this.currentZoom = viewZoom;

		if (this.showAddress) {
			this.showAddressInOverlay(lat, lng);
		}

		this.trackStats = null;
		this.scheduleTraceViewerCdr();
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
		this.closePlaceModal();
		this.gotoTargetActive = false;
		this.clearPlaceSearchState();
		this.clearDirectionTargetState();
		this.closeOfflineTracesModal();
		this.closeGpxStatsModal();
		this.locatingUser = false;
		this.userGpsRecenterGen = 0;
		this.pendingUserGps = null;
		this.userGpsFetchGen = 0;
		this.trackBounds = null;
		this.locationRecenterZoom = null;
		this.hasError = false;
		this.errorMessage = '';
		this.isLoading = false;
		this.trackStats = null;
		this.gpxAnalysis = null;
		this.pendingTrackPoints = null;
		this.pendingTraces = null;
		this.lastRenderedTrackPoints = null;
		this.lastRenderedTraces = null;
		this.displayedTraces = [];
		this.gpsSourceFileId = null;
		this.gpsSourceFileName = '';
		this.trackOrientationCoords = [];
		this.routeHeadingDeg = 0;
		this.deviceHeadingDeg = null;
		this.compassNorthDeg = null;
		this.gpsCourseActive = false;
		this.lastGpsFix = null;
		this.mapOrientation = 'fixed';
		this.manualMapBearing = null;
		this.relief3dDismissed = false;
		this.reliefTiltFollow = false;
		this.reliefTiltSmoothed = null;
		this.reliefTiltPitch = null;
		this.stopMapOrientationWatch();
		this.pendingLocation = null;
		this.pendingPositions = null;
		this.lastRenderedPosition = null;
		this.selectionMode = false;
		this.simpleShareMode = false;
		this.pairEditMode = false;
		this.pairUser = null;
		this.pairMark = null;
		this.clearPairMarkers();
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
		this.destroyFlatGlBlend();
		this.stopRelief3d(false);
		this.teardownMapLayoutObserver();
		this.clearPendingRenderRetry();
		this.trackAutoFitUntil = 0;
		this.trackFitSize = { w: 0, h: 0 };
		this.mapInitVisibilityAttempts = 0;
		this.cancelMapInitRetry();
		this.cancelEnsureMapInitRetry();
		this.ensureMapInitAttempts = 0;
		this.altitudeFetchGeneration++;
		this.mapResizeObservedDims.clear();
		this.mapContainerHadLayout = false;
		this.isMapReady = false;
		if (this.mapReadyTimer != null) {
			clearTimeout(this.mapReadyTimer);
			this.mapReadyTimer = null;
		}
		this.trackBounds = null;
		this.teardownModalWheelTrap();
		this.modalWheelTrapAttempts = 0;
		this.unregisterTraceMapWheelZoom();
		this.unregisterTraceMapCtrlRotate();
		this.unregisterTraceMapPanInertia();
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
		this.trailOverlayLayers = {};
		this.weatherRadarLoadRequestId++;
		this.weatherCloudLoadRequestId++;
		this.weatherRadarLayer = undefined;
		this.weatherCloudLayer = undefined;
		this.weatherStationMapLayer.detach();
		this.clearStationSelection();
		this.removeDeviceLocationMarker();
		// Do not clear pendingLocation / pendingPositions / pendingTrackPoints here:
		// destroyMap can run from a stale modal finalize during reopen and would drop the pin to render.
		this.selectionMarker = undefined;
		this.clickMarker = undefined;
		this.clickDirectionMarker = undefined;
		this.directionTargetMarker = undefined;
		this.locationSelectionClickHandler = undefined;
		this.pairUserMarker = undefined;
		this.pairMarkMarker = undefined;
		this.pairLine = undefined;
		this.pairClickHandler = undefined;
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
			this.refreshTraceViewerViewportFlags();
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

	private computeMobileViewport(): boolean {
		return (
			this.document.defaultView != null &&
			(this.document.defaultView.innerHeight <= 500 || this.document.defaultView.innerWidth <= 768)
		);
	}

	private refreshTraceViewerViewportFlags(): void {
		const mobile = this.computeMobileViewport();
		if (!mobile) {
			this.basemapMenu = null;
		}
		this.isMobileViewport = mobile;
		this.showKeepScreenAwakeSwitch = mobile && this.screenWakeLockAvailable;
		if (!mobile && this.reliefTiltFollow) {
			this.setReliefTiltFollow(false);
		}
	}

	private registerMobileViewportListener(): void {
		this.cleanupMobileViewportListener();
		const win = this.document.defaultView;
		if (!win) {
			return;
		}
		this.mobileViewportResizeHandler = () => {
			const mobile = this.computeMobileViewport();
			const nextAwake = mobile && this.screenWakeLockAvailable;
			if (mobile === this.isMobileViewport && nextAwake === this.showKeepScreenAwakeSwitch) {
				return;
			}
			this.isMobileViewport = mobile;
			this.showKeepScreenAwakeSwitch = nextAwake;
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
			if (!this.modalRef) {
				return;
			}
			this.refreshTraceViewerViewportFlags();
			this.document.defaultView?.setTimeout(() => {
				if (!this.modalRef) {
					return;
				}
				this.syncMapLayoutCore();
			}, 80);
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
						if (this.map && (this.selectedBaseLayerId === 'ign-classic' || this.secondaryBaseLayerId === 'ign-classic')) {
							this.applySelectedBaseLayer();
						}
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
					this.baseLayers['thunderforest-landscape'] = L.tileLayer('https://{s}.tile.thunderforest.com/landscape/{z}/{x}/{y}.png?apikey=' + this.thunderforestApiKey, {
						maxNativeZoom: 18,
						maxZoom: 20,
						subdomains: ['a', 'b', 'c'],
						attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://www.thunderforest.com">Thunderforest</a>'
					});
					// Add to available layers list and sort alphabetically
					const openCycleMapEntry = { id: 'opencyclemap', label: 'OpenCycleMap' };
					this.availableBaseLayers.push(openCycleMapEntry);
					this.availableBaseLayers.push({ id: 'thunderforest-outdoors', label: 'TF Outdoors' });
					this.availableBaseLayers.push({ id: 'thunderforest-landscape', label: 'TF Landscape' });
					this.availableBaseLayers.sort((a, b) => a.label.localeCompare(b.label));
					if (this.map && (
						this.selectedBaseLayerId === 'opencyclemap'
						|| this.selectedBaseLayerId === 'thunderforest-outdoors'
						|| this.selectedBaseLayerId === 'thunderforest-landscape'
						|| this.secondaryBaseLayerId === 'opencyclemap'
						|| this.secondaryBaseLayerId === 'thunderforest-outdoors'
						|| this.secondaryBaseLayerId === 'thunderforest-landscape'
					)) {
						this.applySelectedBaseLayer();
					}
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
			'osm-swiss-style': L.tileLayer('https://tile.osm.ch/osm-swiss-style/{z}/{x}/{y}.png', {
				maxNativeZoom: 19,
				maxZoom: 20,
				attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Style: &copy; <a href="https://openstreetmap.ch">SOSM</a>'
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
			'esri-topo': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
				maxNativeZoom: 19,
				maxZoom: 20,
				attribution: 'Tiles &copy; Esri'
			}),
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
			'opentopomap-r': L.tileLayer('https://tile.openmaps.fr/opentopomap/{z}/{x}/{y}.png', {
				maxNativeZoom: 18,
				maxZoom: 20,
				attribution: '<a href="https://github.com/sletuffe/OpenTopoMap">© OpenTopoMap-R</a> <a href="https://openmaps.fr/donate">Donation</a> <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>'
			}),
			'openhikingmap': L.tileLayer('https://tile.openmaps.fr/openhikingmap/{z}/{x}/{y}.png', {
				maxNativeZoom: 18,
				maxZoom: 20,
				attribution: '<a href="https://wiki.openstreetmap.org/wiki/OpenHikingMap">© OpenHikingMap</a> <a href="https://openmaps.fr/donate">Donation</a> <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>'
			}),
			'maptoolkit-hiking': createVectorBasemapLayer('maptoolkit-hiking')!,
			'maptoolkit-winter': createVectorBasemapLayer('maptoolkit-winter')!,
			'maptoolkit-summer': createVectorBasemapLayer('maptoolkit-summer')!,
			'maptoolkit-cycling': createVectorBasemapLayer('maptoolkit-cycling')!,
			'maptoolkit-street': createVectorBasemapLayer('maptoolkit-street')!,
			'maptoolkit-light': createVectorBasemapLayer('maptoolkit-light')!,
			'maptoolkit-dark': createVectorBasemapLayer('maptoolkit-dark')!,
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
			{ id: 'osm-swiss-style', label: 'OSM Swiss Style' },
			{ id: 'esri-imagery', label: 'Esri Satellite' },
			{ id: 'esri-topo', label: 'Esri Topo' },
			{ id: 'opentopomap', label: 'OpenTopoMap' },
			{ id: 'opentopomap-r', label: 'OpenTopoMap-R' },
			{ id: 'openhikingmap', label: 'OpenHikingMap' },
			{ id: 'maptoolkit-hiking', label: 'Maptoolkit Rando', relief: true },
			{ id: 'maptoolkit-winter', label: 'Maptoolkit Ski', relief: true },
			{ id: 'maptoolkit-summer', label: 'Maptoolkit Été', relief: true },
			{ id: 'maptoolkit-cycling', label: 'Maptoolkit Vélo', relief: true },
			{ id: 'maptoolkit-street', label: 'Maptoolkit Rue', relief: true },
			{ id: 'maptoolkit-light', label: 'Maptoolkit Clair', relief: true },
			{ id: 'maptoolkit-dark', label: 'Maptoolkit Sombre', relief: true },
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
		const previousVisibleId = this.visibleBasemapId();
		this.offlineUseDevice = false;
		const online = typeof navigator === 'undefined' || navigator.onLine;
		this.offlineFallback = !online && this.offlineMeta.tileCount > 0;
		if (layerId === 'cartes-gouv') {
			this.lastBaseLayerBeforeCartesGouv = this.selectedBaseLayerId === 'cartes-gouv' ? this.lastBaseLayerBeforeCartesGouv : this.selectedBaseLayerId;
			this.selectedBaseLayerId = 'cartes-gouv';
			this.syncVisibleRelief(previousVisibleId);
			setTimeout(() => this.openCartesGouvEmbed(), 0);
			return;
		}
		this.selectedBaseLayerId = layerId;
		if (this.secondaryBaseLayerId === layerId) {
			this.secondaryBaseLayerId = '';
		}
		this.applySelectedBaseLayer();
		this.persistTraceViewerPreferences();
		this.syncVisibleRelief(previousVisibleId);
	}

	get relief3dAvailable(): boolean {
		return !this.usingOfflineDeviceMap && this.isMaptoolkitBasemap(this.visibleBasemapId());
	}

	public toggleRelief3d(): void {
		if (this.relief3d) {
			this.relief3dDismissed = true;
			this.stopRelief3d(true);
			return;
		}
		this.relief3dDismissed = false;
		this.startRelief3dFromFlat();
	}

	public toggleElevationColors(): void {
		this.elevationColors = !this.elevationColors;
		if (!this.elevationColors) {
			this.elevationSpan = null;
		}
		this.terrainView?.setElevationColors(this.elevationColors && this.relief3d);
		this.scheduleTraceViewerCdr();
	}

	private elevationSpanTimer: number | null = null;

	private noteElevationRange(range: { min: number; max: number } | null): void {
		const next = range
			? { min: Math.round(range.min), max: Math.round(range.max) }
			: null;
		// L’échantillon arrive hors du cycle d’affichage. On applique la valeur au tick suivant,
		// dans la zone Angular, pour que l’échelle apparaisse sans NG0100.
		this.ngZone.run(() => {
			if (this.elevationSpanTimer != null) {
				clearTimeout(this.elevationSpanTimer);
			}
			this.elevationSpanTimer = window.setTimeout(() => {
				this.elevationSpanTimer = null;
				const same = this.elevationSpan?.min === next?.min && this.elevationSpan?.max === next?.max;
				if (same) {
					return;
				}
				this.elevationSpan = next;
				this.cdr.markForCheck();
			}, 0);
		});
	}

	/** Maptoolkit basemaps open in the vertical 3D view unless the user just chose 2D. */
	private startRelief3dFromFlat(): void {
		if (this.relief3d || this.relief3dDismissed || !this.relief3dAvailable || !this.map) {
			return;
		}
		this.reliefPitch = 0;
		this.reliefOrientationHeld = true;
		this.stopMapBearingGlide();
		this.relief3d = true;
		this.relief3dPending = true;
		this.cdr.detectChanges();
		this.startRelief3d();
	}

	public onReliefPitchChange(value: number | string): void {
		if (this.reliefTiltFollow) {
			this.setReliefTiltFollow(false);
		}
		const n = typeof value === 'number' ? value : Number(value);
		const next = Number.isFinite(n) ? Math.max(0, Math.min(85, Math.round(n))) : 0;
		if (next === this.reliefPitch) {
			return;
		}
		this.reliefPitch = next;
		this.terrainView?.setPitch(next);
		this.updateAxisGizmo(this.reliefZAngle);
	}

	/** Mobile switch: pitch follows the phone only in 3D with Nord on. */
	public setReliefTiltFollow(on: boolean): void {
		this.reliefTiltFollow = !!on;
		this.reliefTiltSmoothed = null;
		this.reliefTiltPitch = null;
		this.syncReliefTouchLocks();
		if (!this.reliefTiltFollow) {
			this.syncReliefTiltListener();
			this.syncReliefTouchLocks();
			return;
		}
		void this.armReliefTiltSensor();
	}

	public get reliefTiltFollowDriving(): boolean {
		return this.reliefTiltFollow && this.relief3d && this.mapOrientation === 'north';
	}

	private async armReliefTiltSensor(): Promise<void> {
		const permission = await requestMotionPermissionIfNeeded();
		if (!this.reliefTiltFollow) {
			this.syncReliefTiltListener();
			return;
		}
		if (permission === 'denied') {
			this.reliefTiltFollow = false;
			this.syncReliefTiltListener();
			this.syncReliefTouchLocks();
			this.scheduleTraceViewerCdr();
			return;
		}
		this.syncReliefTiltListener();
	}

	private syncReliefTiltListener(): void {
		const want = this.reliefTiltFollow && typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
		if (want && !this.reliefTiltListening) {
			window.addEventListener('deviceorientation', this.onReliefTilt, true);
			this.reliefTiltListening = true;
			return;
		}
		if (!want && this.reliefTiltListening && typeof window !== 'undefined') {
			window.removeEventListener('deviceorientation', this.onReliefTilt, true);
			this.reliefTiltListening = false;
		}
	}

	private stopReliefTiltListener(): void {
		this.reliefTiltFollow = false;
		this.reliefTiltSmoothed = null;
		this.reliefTiltPitch = null;
		this.syncReliefTiltListener();
	}

	/**
	 * Angle between the screen and the horizontal plane.
	 * 0° = phone flat. 90° = upright, looking at the horizon.
	 * Past 90° the phone points toward the sky, up to 180°.
	 */
	private screenTiltDeg(betaDeg: number, gammaDeg: number): number {
		const nz = Math.cos((betaDeg * Math.PI) / 180) * Math.cos((gammaDeg * Math.PI) / 180);
		const clamped = Math.max(-1, Math.min(1, nz));
		return (Math.acos(clamped) * 180) / Math.PI;
	}

	/** Drive the 3D pitch from the phone while Nord is on. Heading stays on the compass listener. */
	private applyReliefDeviceTilt(event: DeviceOrientationEvent): void {
		if (!this.reliefTiltFollowDriving || !this.terrainView || this.terrainView.isUserGesturing()) {
			return;
		}
		const beta = event.beta;
		if (beta == null || !Number.isFinite(beta)) {
			return;
		}
		const gamma = event.gamma != null && Number.isFinite(event.gamma) ? event.gamma : 0;
		const raw = this.screenTiltDeg(beta, gamma);
		const seed = this.reliefTiltSmoothed ?? this.reliefPitch;
		const smoothed = seed * 0.62 + raw * 0.38;
		this.reliefTiltSmoothed = smoothed;
		const next = Math.max(0, Math.min(180, smoothed));
		if (this.reliefTiltPitch != null && Math.abs(this.reliefTiltPitch - next) < 0.45) {
			return;
		}
		this.reliefTiltPitch = next;
		const shown = Math.round(next);
		if (shown !== this.reliefPitch) {
			this.deferReliefPitch(shown);
		}
		this.updateAxisGizmo(90 - next);
		if (this.mapBearingGlideRaf == null) {
			this.terrainView.setPitch(next);
		}
	}

	/** Le pitch arrive parfois pendant le contrôle de vue : on reporte le modèle au tick suivant. */
	private deferReliefPitch(next: number): void {
		this.pendingReliefPitch = next;
		if (this.reliefPitchTimer != null) {
			return;
		}
		this.reliefPitchTimer = window.setTimeout(() => {
			this.reliefPitchTimer = null;
			const pending = this.pendingReliefPitch;
			this.pendingReliefPitch = null;
			if (pending == null || pending === this.reliefPitch) {
				return;
			}
			this.reliefPitch = pending;
			this.scheduleTraceViewerCdr();
		}, 0);
	}

	private isMaptoolkitBasemap(id: string): boolean {
		return maptoolkitStyleForBasemap(id) != null;
	}

	/** Keep the current 3D camera and paint the Maptoolkit map that is on screen. */
	private applyRelief3dStyle(): void {
		if (!this.reliefVisibleStyle()) {
			return;
		}
		if (!this.terrainView) {
			this.startRelief3d();
			return;
		}
		this.syncRelief3dBlend();
	}

	private startRelief3d(): void {
		const host = this.reliefHostElement();
		const style = this.reliefVisibleStyle();
		if (!this.relief3d || !this.map || !host || !style) {
			this.relief3d = false;
			this.relief3dPending = false;
			return;
		}
		const center = this.map.getCenter();
		const leafletZoom = this.map.getZoom();
		const zoom = leafletZoomToMaplibre(Number.isFinite(leafletZoom) ? leafletZoom : 13);
		this.terrainView?.destroy();
		this.terrainView = new MaptoolkitTerrainView();
		this.reliefBearing = 0;
		const initialReliefBearing = this.wrapDeg(-this.currentMapBearingDeg());
		this.reliefBearingLock = initialReliefBearing;
		this.terrainView.mount(host, style, {
			lng: center.lng,
			lat: center.lat,
			zoom,
			pitch: this.reliefPitch,
			bearing: initialReliefBearing
		}, {
			onZoom: (nextZoom) => {
				this.currentZoom = maplibreZoomToLeaflet(nextZoom);
				this.scheduleTraceViewerCdr();
			},
			onBearing: (bearing) => {
				this.reliefBearing = bearing;
				this.updateCompassRose();
				if (this.applyingMapBearing) {
					return;
				}
				if (this.reliefBearingLock != null) {
					const delta = this.shortestAngleDelta(this.wrapDeg(bearing), this.reliefBearingLock);
					if (Math.abs(delta) < 1.5) {
						return;
					}
					this.reliefBearingLock = null;
				}
				this.adoptReliefDrag(bearing);
			},
			onPitch: (pitch) => {
				if (this.reliefTiltFollowDriving) {
					return;
				}
				const next = Math.max(0, Math.min(85, Math.round(pitch)));
				this.updateAxisGizmo(90 - next);
				if (next === this.reliefPitch) {
					return;
				}
				this.deferReliefPitch(next);
			},
			onReady: () => {
				this.relief3dPending = false;
				this.cdr.detectChanges();
				this.applySelectedBaseLayer();
				// Only if the flat map is still on the GPS fix. A basemap change must keep the place on screen.
				this.catchUpReliefCameraToGps();
				this.refreshReliefWeatherStations();
			},
			onMoveEnd: () => {
				this.refreshReliefWeatherStations();
				this.schedulePlaces();
			},
			onElevationRange: (range) => this.noteElevationRange(range)
		});
		this.syncRelief3dOverlays();
		this.syncRelief3dBlend();
		this.syncReliefTouchLocks();
		this.currentZoom = Number.isFinite(leafletZoom) ? leafletZoom : this.currentZoom;
		this.updateCompassRose();
	}

	/** Zoom the user sees. In 3D the MapLibre level is one step lower for the same scale. */
	private visibleLeafletZoom(): number {
		const cam = this.relief3d ? this.terrainView?.camera() : null;
		if (cam) {
			return maplibreZoomToLeaflet(cam.zoom);
		}
		return this.map?.getZoom() ?? TraceViewerModalComponent.DEFAULT_LOCATION_ZOOM;
	}

	/** Drop the pitched view. When `syncView` is set, the flat map keeps the 3D center and zoom. */
	private stopRelief3d(syncView: boolean): void {
		if (!this.relief3d && !this.terrainView) {
			return;
		}
		this.reliefOrientationHeld = false;
		const cam = syncView ? this.terrainView?.camera() ?? null : null;
		const reliefBearing = syncView ? this.terrainView?.bearing() ?? null : null;
		this.terrainView?.destroy();
		this.terrainView = null;
		this.relief3d = false;
		this.relief3dPending = false;
		this.reliefBearingLock = null;
		if (cam && this.map) {
			const zoom = Math.max(
				this.map.getMinZoom(),
				Math.min(this.map.getMaxZoom(), maplibreZoomToLeaflet(cam.zoom))
			);
			this.map.setView([cam.lat, cam.lng], zoom, { animate: false });
			this.currentZoom = this.map.getZoom();
			if (reliefBearing != null) {
				this.applyLeafletBearing(this.wrapDeg(-reliefBearing));
			}
		}
		this.updateCompassRose();
		this.applySelectedBaseLayer();
		if (this.showWeatherStations) {
			this.weatherStationMapLayer.setIgnoreLeafletMoves(false);
		}
		if (!this.relief3d) {
			this.elevationSpan = null;
		}
		this.cdr.markForCheck();
	}

	/** Keep the flat map's rotation equal to the pitched view, without changing Nord / Marche / Fixe. */
	private applyLeafletBearing(bearing: number): void {
		const map = this.map as RotatableLeafletMap | undefined;
		if (!map || typeof map.setBearing !== 'function' || !Number.isFinite(bearing)) {
			return;
		}
		if (this.mapOrientation === 'fixed') {
			this.manualMapBearing = bearing;
		}
		if (Math.abs(this.shortestAngleDelta(this.currentMapBearingDeg(), bearing)) < 0.5) {
			return;
		}
		this.applyingMapBearing = true;
		try {
			map.setBearing(bearing);
		} catch {
			/* plugin not ready */
		} finally {
			this.applyingMapBearing = false;
		}
	}

	private reliefHostElement(): HTMLElement | null {
		const mapEl = this.resolveMapContainerElement();
		const host = mapEl?.parentElement?.querySelector('.trace-relief3d-host');
		return host instanceof HTMLElement ? host : null;
	}

	/**
	 * Map actually painted. If either chosen basemap is 3D, that one is shown
	 * and the flat one stays in the other slot.
	 */
	private visibleBasemapId(): string {
		const primary = (this.selectedBaseLayerId || '').trim() || 'opentopomap';
		const secondary = (this.secondaryBaseLayerId || '').trim();
		if (this.isMaptoolkitBasemap(primary)) {
			return primary;
		}
		if (secondary && secondary !== primary && this.isMaptoolkitBasemap(secondary)) {
			return secondary;
		}
		return primary;
	}

	/** Open or update the pitched view when the painted map is a 3D basemap. */
	private syncVisibleRelief(previousVisibleId: string): void {
		const visible = this.visibleBasemapId();
		if (!this.isMaptoolkitBasemap(visible)) {
			if (this.relief3d) {
				this.stopRelief3d(true);
			}
			return;
		}
		if (visible !== previousVisibleId) {
			this.relief3dDismissed = false;
		}
		if (this.relief3d) {
			this.applyRelief3dStyle();
			return;
		}
		this.startRelief3dFromFlat();
	}

	/** 3D shows the Maptoolkit basemap, even when it sits in the second slot. */
	private reliefVisibleStyle(): string | null {
		return maptoolkitStyleForBasemap(this.visibleBasemapId());
	}

	/** One 3D map fills the view. Two 3D maps stack, with the slider as the top map's opacity. */
	private syncRelief3dBlend(): void {
		if (!this.relief3d || !this.terrainView) {
			return;
		}
		const primaryStyle = maptoolkitStyleForBasemap(this.selectedBaseLayerId);
		const style = primaryStyle ?? this.reliefVisibleStyle();
		if (!style) {
			return;
		}
		this.terrainView.setStyle(style);
		const secondary = (this.secondaryBaseLayerId || '').trim();
		const secondaryStyle = primaryStyle && secondary !== this.selectedBaseLayerId
			? maptoolkitStyleForBasemap(secondary)
			: null;
		if (secondaryStyle) {
			this.terrainView.setBlend(secondaryStyle, this.clampBasemapBlend(this.basemapBlend) / 100);
			return;
		}
		this.terrainView.setBlend(null, 0);
	}

	private syncRelief3dOverlays(): void {
		if (!this.terrainView) {
			return;
		}
		this.terrainView.setTraces(this.reliefTraces());
		this.terrainView.setTrailOverlays(this.reliefTrailOverlays());
		this.terrainView.setElevationColors(this.elevationColors && this.relief3d);
		this.terrainView.setGps(this.deviceLocationLatLng);
		this.terrainView.setPlaces(this.placeMarks);
		this.syncReliefWeatherStations();
		if (this.gotoTargetActive && this.selectionMarker) {
			const pos = this.selectionMarker.getLatLng();
			this.terrainView.setPin({ lat: pos.lat, lng: pos.lng });
		} else {
			this.terrainView.setPin(null);
		}
	}

	/** Pastilles de stations sur le relief, au-dessus des deux cartes 3D. */
	private syncReliefWeatherStations(): void {
		const view = this.terrainView;
		if (!view) {
			return;
		}
		if (!this.relief3d || !this.showWeatherStations) {
			view.setWeatherStations([]);
			return;
		}
		view.setWeatherStations(
			this.weatherStationMapLayer.reliefLabels(),
			(event) => this.weatherStationMapLayer.handleActionClick(event),
			(key) => this.weatherStationMapLayer.warmStationAltitude(key)
		);
	}

	/** Recharge les stations pour le sol visible, pas pour le cadre Leaflet resté en dessous. */
	private reliefStationRetry: number | null = null;
	private reliefStationRetryCount = 0;

	private refreshReliefWeatherStations(): void {
		if (!this.relief3d || !this.showWeatherStations || !this.terrainView) {
			return;
		}
		this.weatherStationMapLayer.setIgnoreLeafletMoves(true);
		const box = this.terrainView.groundBounds();
		if (!box) {
			if (this.reliefStationRetry != null || this.reliefStationRetryCount >= 15) {
				return;
			}
			this.reliefStationRetryCount += 1;
			this.reliefStationRetry = window.setTimeout(() => {
				this.reliefStationRetry = null;
				this.refreshReliefWeatherStations();
			}, 200);
			return;
		}
		this.reliefStationRetryCount = 0;
		if (this.reliefStationRetry != null) {
			window.clearTimeout(this.reliefStationRetry);
			this.reliefStationRetry = null;
		}
		this.weatherStationMapLayer.loadForGeographicView(
			box.south,
			box.north,
			box.west,
			box.east,
			this.visibleLeafletZoom()
		);
	}

	private reliefTraces(): ReliefTrace[] {
		if (this.lastRenderedTraces?.length) {
			const colors = TraceViewerModalComponent.MULTI_TRACE_COLORS;
			return this.lastRenderedTraces
				.filter((trace) => trace.points.length >= 2)
				.map((trace, index) => {
					const color = colors[index % colors.length];
					return { color, points: trace.points, startColor: color, endColor: color };
				});
		}
		if ((this.lastRenderedTrackPoints?.length ?? 0) >= 2) {
			return [{
				color: '#007bff',
				points: this.lastRenderedTrackPoints!,
				startColor: '#28a745',
				endColor: '#dc3545'
			}];
		}
		return [];
	}

	/** Basemaps that can be stacked. cartes.gouv.fr is an embed, not a tile layer. */
	get blendBaseLayerChoices(): Array<{ id: string; label: string; labelKey?: string; relief?: boolean }> {
		return this.availableBaseLayers.filter((layer) => layer.id !== 'cartes-gouv');
	}

	/**
	 * Slider 1–2. In the flat view any two maps can be mixed, including a 3D basemap shown flat.
	 * In the pitched view the slider stays only when both maps are 3D; a single 3D map is shown alone.
	 */
	get showBasemapBlend(): boolean {
		const secondary = (this.secondaryBaseLayerId || '').trim();
		if (!secondary || secondary === this.selectedBaseLayerId) {
			return false;
		}
		if (!this.relief3d) {
			return true;
		}
		return this.isMaptoolkitBasemap(this.selectedBaseLayerId) && this.isMaptoolkitBasemap(secondary);
	}

	public toggleBasemapMenu(kind: 'primary' | 'secondary', event: Event): void {
		event.stopPropagation();
		this.basemapMenu = this.basemapMenu === kind ? null : kind;
	}

	public closeBasemapMenu(): void {
		this.basemapMenu = null;
	}

	/** One tap selects and closes. The native mobile picker spends the first tap dismissing its search field. */
	public pickBasemap(kind: 'primary' | 'secondary', layerId: string): void {
		this.basemapMenu = null;
		if (kind === 'primary') {
			if (layerId !== this.selectedBaseLayerId) {
				this.onBaseLayerChange(layerId);
			}
			return;
		}
		if (layerId !== this.secondaryBaseLayerId) {
			this.onSecondaryBaseLayerChange(layerId);
		}
	}

	public trackBasemapId(_index: number, layer: { id: string }): string {
		return layer.id;
	}

	public basemapTriggerLabel(kind: 'primary' | 'secondary'): string {
		if (kind === 'secondary') {
			const layer = this.availableBaseLayers.find((item) => item.id === this.secondaryBaseLayerId);
			return layer ? this.basemapOptionLabel(layer) : this.translate('EVENTELEM.TRACK_BASEMAP_NONE');
		}
		const layer = this.availableBaseLayers.find((item) => item.id === this.selectedBaseLayerId);
		return layer ? this.basemapOptionLabel(layer) : '';
	}

	/** Visible name. Relief basemaps are prefixed so the 3D ones are obvious in the list. */
	public basemapOptionLabel(layer: { label: string; labelKey?: string; relief?: boolean }): string {
		const name = layer.labelKey ? this.translate(layer.labelKey) : layer.label;
		return layer.relief ? `3D ${name}` : name;
	}

	public onSecondaryBaseLayerChange(layerId: string): void {
		const previousVisibleId = this.visibleBasemapId();
		const next = (layerId || '').trim();
		if (!next || next === 'cartes-gouv' || next === this.selectedBaseLayerId) {
			this.secondaryBaseLayerId = '';
		} else {
			this.secondaryBaseLayerId = next;
		}
		if (this.secondaryBaseLayerId && this.basemapBlend <= 0) {
			this.basemapBlend = 50;
		}
		this.applySelectedBaseLayer();
		this.persistTraceViewerPreferences();
		this.syncVisibleRelief(previousVisibleId);
	}

	public onBasemapBlendChange(raw: number | string): void {
		const next = this.clampBasemapBlend(raw);
		const prev = this.basemapBlend;
		if (next === prev) {
			return;
		}
		this.basemapBlend = next;
		if (this.wantsFlatGlBlend()) {
			this.syncFlatGlBlend();
		} else if (this.activeSecondaryBaseLayerId() && !this.activeBlendLayer) {
			this.applySelectedBaseLayer();
		} else {
			this.applyBasemapBlendOpacity();
		}
		this.syncRelief3dBlend();
		this.scheduleBasemapBlendPersist();
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

	openOfflineTiles(): void {
		this.offlineMap.openDownloadUi({
			basemapId: this.selectedBaseLayerId,
			cartesLayerId: this.selectedCartesGouvLayerId,
			view: viewWindowFromMap(this.map),
			track: this.offlineTrackPoints()
		});
	}

	private offlineTrackPoints(): { lat: number; lon: number }[] | null {
		const src = this.lastRenderedTrackPoints?.length
			? this.lastRenderedTrackPoints
			: this.pendingTrackPoints;
		if (!src || src.length < 2) {
			return null;
		}
		const points = src
			.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
			.map((p) => ({ lat: p[0], lon: p[1] }));
		return points.length >= 2 ? points : null;
	}

	setTraceOfflineSource(useDevice: boolean): void {
		if (useDevice && this.relief3d) {
			this.stopRelief3d(true);
		}
		this.offlineUseDevice = !!useDevice && this.offlineMeta.tileCount > 0;
		this.offlineFallback = false;
		this.applySelectedBaseLayer();
		this.cdr.markForCheck();
	}


	private bindOfflineMapPack(): void {
		if (isBrowserOffline()) {
			this.offlineFallback = true;
		}
		this.offlineSub = new Subscription();
		this.offlineSub.add(this.offlineMap.meta$.subscribe((m) => {
			const hadPack = this.offlineMeta.tileCount > 0;
			this.offlineMeta = m;
			if (hadPack && !m.tileCount) {
				this.offlineUseDevice = false;
			} else if (this.map && this.usingOfflineDeviceMap) {
				this.applySelectedBaseLayer();
			}
			this.cdr.markForCheck();
		}));
		this.offlineSub.add(this.offlineMap.progress$.subscribe((p) => {
			this.offlineProgress = p;
			this.cdr.markForCheck();
		}));
		this.offlineSub.add(this.offlineMap.downloading$.subscribe((d) => {
			this.offlineDownloading = d;
			this.cdr.markForCheck();
		}));
		this.offlineSub.add(this.offlineMap.lastError$.subscribe((e) => {
			this.offlineError = e || '';
			this.cdr.markForCheck();
		}));
		window.addEventListener('offline', this.onOffline);
		window.addEventListener('online', this.onOnline);
	}

	private applyTraceOfflineBasemap(online: boolean): void {
		if (online === this.offlineLastOnline) {
			return;
		}
		this.offlineLastOnline = online;
		if (!this.map) {
			return;
		}
		if (!online && this.offlineMeta.tileCount > 0) {
			this.offlineFallback = true;
			this.applySelectedBaseLayer();
			this.cdr.markForCheck();
			return;
		}
		if (online && this.offlineFallback) {
			this.offlineFallback = false;
			this.applySelectedBaseLayer();
			this.cdr.markForCheck();
		}
	}

	/**
	 * Two Maptoolkit maps in the flat view. The second one is a MapLibre overlay:
	 * the Leaflet WebGL canvas stays opaque, so the slider cannot fade it.
	 */
	private wantsFlatGlBlend(): boolean {
		if (this.relief3d || !this.map || this.usingOfflineDeviceMap) {
			return false;
		}
		const secondary = this.activeSecondaryBaseLayerId();
		return !!secondary
			&& this.isMaptoolkitBasemap(this.selectedBaseLayerId)
			&& this.isMaptoolkitBasemap(secondary);
	}

	private syncFlatGlBlend(): void {
		if (!this.wantsFlatGlBlend()) {
			this.destroyFlatGlBlend();
			return;
		}
		const style = maptoolkitStyleForBasemap(this.activeSecondaryBaseLayerId());
		const pane = this.ensureBasemapBlendPane();
		if (!style || !pane) {
			this.destroyFlatGlBlend();
			return;
		}
		this.bindFlatGlBlendCamera();
		const opacity = this.clampBasemapBlend(this.basemapBlend) / 100;
		if (!this.flatGlBlend) {
			this.flatGlBlend = new FlatMaptoolkitBlend();
			this.flatGlBlend.mount(pane, style, () => this.syncFlatGlBlendCamera());
		} else {
			this.flatGlBlend.setStyle(style, () => this.syncFlatGlBlendCamera());
		}
		this.flatGlBlend.setOpacity(opacity);
		this.syncFlatGlBlendCamera();
	}

	private bindFlatGlBlendCamera(): void {
		if (!this.map || this.flatGlBlendMove) {
			return;
		}
		this.flatGlBlendMove = () => this.syncFlatGlBlendCamera();
		this.map.on('move', this.flatGlBlendMove);
		this.map.on('zoom', this.flatGlBlendMove);
		this.map.on('rotate', this.flatGlBlendMove);
		this.map.on('resize', this.flatGlBlendMove);
	}

	private syncFlatGlBlendCamera(): void {
		const overlay = this.flatGlBlend;
		const map = this.map;
		if (!overlay || !map) {
			return;
		}
		const size = map.getSize();
		if (!size || size.x < 2 || size.y < 2) {
			return;
		}
		const centerPt = map.containerPointToLayerPoint(size.divideBy(2));
		const topLeft = centerPt.subtract(size.divideBy(2));
		const center = map.getCenter();
		const leafletBearing = this.currentMapBearingDeg();
		const upright = Number.isFinite(leafletBearing) ? -leafletBearing : 0;
		overlay.sync({
			lng: center.lng,
			lat: center.lat,
			zoom: leafletZoomToMaplibre(map.getZoom()),
			bearing: upright,
			width: size.x,
			height: size.y,
			x: topLeft.x,
			y: topLeft.y
		});
	}

	private destroyFlatGlBlend(): void {
		if (this.map && this.flatGlBlendMove) {
			this.map.off('move', this.flatGlBlendMove);
			this.map.off('zoom', this.flatGlBlendMove);
			this.map.off('rotate', this.flatGlBlendMove);
			this.map.off('resize', this.flatGlBlendMove);
		}
		this.flatGlBlendMove = undefined;
		this.flatGlBlend?.destroy();
		this.flatGlBlend = null;
	}

	private applySelectedBaseLayer(): void {
		if (!this.map) {
			return;
		}
		const usePack = this.usingOfflineDeviceMap;
		if (!usePack && this.selectedBaseLayerId === 'cartes-gouv') {
			this.removeBlendLayer();
			this.destroyFlatGlBlend();
			return;
		}

		this.removeBlendLayer();
		if (this.activeBaseLayer) {
			this.map.removeLayer(this.activeBaseLayer);
			this.activeBaseLayer = undefined;
		}

		// The 3D view already draws Maptoolkit. A second WebGL copy under it
		// can stop the transparent overlay from getting a graphics context.
		if (this.relief3d && (this.isMaptoolkitBasemap(this.selectedBaseLayerId) || this.isMaptoolkitBasemap(this.secondaryBaseLayerId))) {
			this.destroyFlatGlBlend();
			return;
		}

		const secondaryId = this.showBasemapBlend ? this.activeSecondaryBaseLayerId() : '';
		const flatGlBlend = this.wantsFlatGlBlend();
		const blend = secondaryId ? this.clampBasemapBlend(this.basemapBlend) : 0;
		const shownId = this.showBasemapBlend
			? (this.selectedBaseLayerId || 'opentopomap')
			: this.visibleBasemapId();

		const primary = this.buildBasemapLayer(shownId, false);
		if (primary) {
			primary.addTo(this.map);
			this.sendBasemapToBack(primary);
			this.activeBaseLayer = primary;
		}

		if (secondaryId && !flatGlBlend) {
			const secondary = this.buildBasemapLayer(secondaryId, true);
			if (secondary && secondary !== this.activeBaseLayer) {
				this.attachBlendLayer(secondary);
				this.setBasemapOpacity(secondary, blend / 100);
				this.activeBlendLayer = secondary;
			}
		}

		this.syncFlatGlBlend();

		this.applyTrailOverlays();
		this.applyWeatherRadarOverlay();

		const primaryRef = this.activeBaseLayer;
		const blendRef = this.activeBlendLayer;
		requestAnimationFrame(() => {
			if (!this.map) {
				return;
			}
			if (blendRef && this.activeBlendLayer === blendRef) {
				this.setBasemapOpacity(blendRef, this.clampBasemapBlend(this.basemapBlend) / 100);
			}
			if (this.flatGlBlend) {
				this.syncFlatGlBlendCamera();
			}
			if ((primaryRef && this.activeBaseLayer === primaryRef) || (blendRef && this.activeBlendLayer === blendRef)) {
				this.map.invalidateSize();
			}
		});
	}

	/** True when a Swisstopo sheet is actually on the map (fractional zoom would leave it gray). */
	private visibleSwisstopoBasemap(): boolean {
		const primary = this.basemapBlend < 100 && this.isSwisstopoBasemap(this.selectedBaseLayerId);
		const secondary = this.basemapBlend > 0 && this.isSwisstopoBasemap(this.secondaryBaseLayerId);
		return primary || secondary;
	}

	private activeSecondaryBaseLayerId(): string {
		const id = (this.secondaryBaseLayerId || '').trim();
		if (!id || id === 'cartes-gouv' || id === this.selectedBaseLayerId || !this.canBuildBasemap(id)) {
			return '';
		}
		return id;
	}

	private canBuildBasemap(id: string): boolean {
		if (this.usingOfflineDeviceMap || this.isSwisstopoBasemap(id)) {
			return true;
		}
		if (vectorStyleForBasemap(id)) {
			return true;
		}
		return !!this.baseLayers[id];
	}

	private clampBasemapBlend(raw: number | string): number {
		const n = typeof raw === 'number' ? raw : Number(raw);
		if (!Number.isFinite(n)) {
			return 50;
		}
		return Math.max(0, Math.min(100, Math.round(n)));
	}

	private scheduleBasemapBlendPersist(): void {
		if (this.basemapBlendPersistTimer != null) {
			clearTimeout(this.basemapBlendPersistTimer);
		}
		this.basemapBlendPersistTimer = window.setTimeout(() => {
			this.basemapBlendPersistTimer = null;
			this.persistTraceViewerPreferences();
		}, 350);
	}

	private removeBlendLayer(): void {
		if (!this.activeBlendLayer) {
			return;
		}
		this.activeBlendLayer.remove();
		this.activeBlendLayer = undefined;
	}

	private applyBasemapBlendOpacity(): void {
		if (!this.activeBlendLayer) {
			return;
		}
		if (this.layerUsesBlendPane(this.activeBlendLayer)) {
			this.activeBlendLayer.remove();
			this.activeBlendLayer = undefined;
			this.applySelectedBaseLayer();
			return;
		}
		this.setBasemapOpacity(this.activeBlendLayer, this.clampBasemapBlend(this.basemapBlend) / 100);
	}

	/** Layers parked in the blend pane sit above the tiles and no longer fade. */
	private layerUsesBlendPane(layer: L.Layer): boolean {
		const pane = (layer as L.Layer & { options?: { pane?: string } }).options?.pane;
		if (pane === 'basemapBlendPane') {
			return true;
		}
		if (layer instanceof L.LayerGroup) {
			let found = false;
			layer.eachLayer((child) => {
				if (!found && this.layerUsesBlendPane(child)) {
					found = true;
				}
			});
			return found;
		}
		return false;
	}

	/**
	 * `independent` builds a fresh layer so the second basemap is not the same Leaflet instance as the first.
	 */
	private buildBasemapLayer(layerId: string, independent: boolean): L.Layer | null {
		if (!layerId || layerId === 'cartes-gouv') {
			return null;
		}
		if (this.usingOfflineDeviceMap) {
			const packStyle = this.offlineMap.displayStyle(layerId, this.selectedCartesGouvLayerId);
			return createOfflineBasemapLayer(this.offlineTiles, packStyle);
		}
		if (this.isSwisstopoBasemap(layerId)) {
			return this.createSwisstopoLayer(layerId);
		}
		const vector = createVectorBasemapLayer(layerId);
		if (vector) {
			return independent ? vector : (this.baseLayers[layerId] ?? createVectorBasemapLayer(layerId));
		}
		const source = this.baseLayers[layerId] ?? this.baseLayers['osm-standard'];
		if (!source) {
			return null;
		}
		if (!independent) {
			return source;
		}
		const cloned = this.cloneLeafletLayer(source);
		if (cloned === source) {
			return null;
		}
		if (cloned instanceof L.LayerGroup && cloned.getLayers().length === 0) {
			return null;
		}
		return cloned;
	}

	private cloneLeafletLayer(source: L.Layer): L.Layer {
		if (source instanceof L.TileLayer) {
			const url = (source as L.TileLayer & { _url?: string })._url ?? '';
			if (!url) {
				return source;
			}
			return L.tileLayer(url, { ...source.options });
		}
		if (source instanceof L.LayerGroup) {
			const children: L.Layer[] = [];
			source.eachLayer((child) => {
				const cloned = this.cloneLeafletLayer(child);
				if (cloned !== child) {
					children.push(cloned);
				}
			});
			return L.layerGroup(children);
		}
		return source;
	}

	private sendBasemapToBack(layer: L.Layer): void {
		if (layer instanceof L.TileLayer) {
			layer.bringToBack();
			return;
		}
		if (layer instanceof L.LayerGroup) {
			layer.eachLayer((child) => {
				if (child instanceof L.TileLayer) {
					child.bringToBack();
				} else {
					this.sendBasemapToBack(child);
				}
			});
			return;
		}
		const container = this.basemapContainer(layer);
		if (container) {
			container.style.zIndex = '1';
		}
	}

	/**
	 * The second map sits in its own pane, above the tile pane and below markers.
	 * A WebGL canvas in the same pane as the first map stays opaque on top, so the
	 * slider never shows through.
	 */
	private ensureBasemapBlendPane(): HTMLElement | null {
		if (!this.map) {
			return null;
		}
		const existing = this.map.getPane('basemapBlendPane');
		if (existing) {
			return existing;
		}
		const pane = this.map.createPane('basemapBlendPane');
		pane.style.zIndex = '350';
		pane.style.pointerEvents = 'none';
		return pane;
	}

	private attachBlendLayer(layer: L.Layer): void {
		layer.addTo(this.map!);
		this.raiseBasemapStack(layer);
	}

	/** Keep the second basemap above the first and below weather (zIndex 4) and trails. */
	private raiseBasemapStack(layer: L.Layer): void {
		if (layer instanceof L.TileLayer) {
			layer.setZIndex(3);
			return;
		}
		if (layer instanceof L.LayerGroup) {
			layer.eachLayer((child) => {
				if (child instanceof L.TileLayer) {
					child.setZIndex(Math.max(child.options.zIndex ?? 1, 3));
				} else {
					this.raiseBasemapStack(child);
				}
			});
			return;
		}
		const container = this.basemapContainer(layer);
		if (container) {
			container.style.zIndex = '3';
		}
	}

	private setBasemapOpacity(layer: L.Layer, opacity: number): void {
		const clamped = Math.max(0, Math.min(1, opacity));
		if (layer instanceof L.TileLayer) {
			const tagged = layer as L.TileLayer & { _blendBaseOpacity?: number };
			if (tagged._blendBaseOpacity == null) {
				tagged._blendBaseOpacity = layer.options.opacity ?? 1;
			}
			layer.setOpacity(tagged._blendBaseOpacity * clamped);
			return;
		}
		if (layer instanceof L.LayerGroup) {
			layer.eachLayer((child) => this.setBasemapOpacity(child, clamped));
			return;
		}
		const gl = layer as L.Layer & { _glMap?: unknown };
		if (gl._glMap) {
			applyGlLayerOpacity(layer, clamped);
			return;
		}
		const container = this.basemapContainer(layer);
		if (container) {
			container.style.opacity = String(clamped);
		}
	}

	private basemapContainer(layer: L.Layer): HTMLElement | null {
		const anyLayer = layer as L.Layer & {
			getContainer?: () => HTMLElement | undefined;
			_container?: HTMLElement;
		};
		if (typeof anyLayer.getContainer === 'function') {
			const el = anyLayer.getContainer();
			if (el) {
				return el;
			}
		}
		return anyLayer._container ?? null;
	}

	private reliefTrailOverlays(): ReliefTrailOverlays {
		return {
			hiking: this.showHikingTrailsOverlay,
			cycling: this.showCyclingTrailsOverlay,
			mtb: this.showMtbTrailsOverlay,
			railway: this.showRailwayOverlay,
			slopes: this.showSlopesOverlay
		};
	}

	/**
	 * Au-dessus du second fond (pane 350) et sous le tracé (pane 400).
	 * Sans ça, le curseur à fond sur la carte 2 cache les pistes et les itinéraires.
	 */
	private ensureTrailOverlayPane(): void {
		if (!this.map || this.map.getPane('trailOverlayPane')) {
			return;
		}
		const pane = this.map.createPane('trailOverlayPane');
		pane.style.zIndex = '380';
		pane.style.pointerEvents = 'none';
	}

	/**
	 * Affiche ou masque les couches Waymarked Trails par-dessus les deux fonds.
	 * Les pistes de ski restent sous les itinéraires.
	 */
	private applyTrailOverlays(): void {
		if (!this.map) {
			return;
		}
		this.ensureTrailOverlayPane();
		const specs: { key: keyof ReliefTrailOverlays; style: string; zIndex: number }[] = [
			{ key: 'slopes', style: 'waymarked-slopes', zIndex: 9 },
			{ key: 'hiking', style: 'waymarked-hiking', zIndex: 10 },
			{ key: 'cycling', style: 'waymarked-cycling', zIndex: 11 },
			{ key: 'mtb', style: 'waymarked-mtb', zIndex: 12 },
			{ key: 'railway', style: 'openrailwaymap', zIndex: 13 }
		];
		const flags = this.reliefTrailOverlays();
		for (const spec of specs) {
			const current = this.trailOverlayLayers[spec.key];
			current?.remove();
			if (!flags[spec.key]) {
				continue;
			}
			const url = cachedBasemapTileUrl(spec.style);
			if (!current || current.options.pane !== 'trailOverlayPane') {
				this.trailOverlayLayers[spec.key] = L.tileLayer(url, {
					maxZoom: 18,
					opacity: 0.95,
					zIndex: spec.zIndex,
					pane: 'trailOverlayPane'
				});
			}
			this.trailOverlayLayers[spec.key]!.addTo(this.map);
		}
	}

	public onTrailOverlayChange(): void {
		this.applyTrailOverlays();
		this.terrainView?.setTrailOverlays(this.reliefTrailOverlays());
		this.cdr.detectChanges();
		this.persistTraceViewerPreferences();
	}

	public onPlacesOverlayChange(): void {
		if (this.showPlacesOverlay) {
			this.schedulePlaces();
		} else {
			this.clearPlaces();
		}
		this.persistTraceViewerPreferences();
	}

	/** Recharge les lieux quand la carte s’arrête. Une zone trop large n’est pas demandée. */
	private schedulePlaces(): void {
		if (this.placesTimer != null) {
			clearTimeout(this.placesTimer);
			this.placesTimer = null;
		}
		if (!this.showPlacesOverlay) {
			return;
		}
		this.placesTimer = setTimeout(() => {
			this.placesTimer = null;
			void this.loadPlaces();
		}, 450);
	}

	private clearPlaces(): void {
		if (this.placesTimer != null) {
			clearTimeout(this.placesTimer);
			this.placesTimer = null;
		}
		this.placesAbort?.abort();
		this.placesAbort = null;
		this.placesGen++;
		this.placeMarks = [];
		this.placesLayer?.remove();
		this.placesLayer = null;
		this.terrainView?.setPlaces([]);
	}

	private async loadPlaces(): Promise<void> {
		if (!this.showPlacesOverlay || !this.map) {
			return;
		}
		const zoom = this.visibleLeafletZoom();
		const box = this.placesBbox();
		if (!box || zoom < 11 || box.east - box.west > 0.8 || box.north - box.south > 0.6) {
			this.placesGen++;
			this.placesAbort?.abort();
			this.placesAbort = null;
			this.placeMarks = [];
			this.paintPlaces();
			return;
		}
		const gen = ++this.placesGen;
		this.placesAbort?.abort();
		const abort = new AbortController();
		this.placesAbort = abort;
		try {
			const payload = await this.fetchPlacesPayload(abort.signal);
			if (!payload || gen !== this.placesGen || !this.showPlacesOverlay) {
				return;
			}
			const marks: ReliefPlaceMark[] = [];
			for (const element of payload.elements ?? []) {
				const lat = element.lat ?? element.center?.lat;
				const lng = element.lon ?? element.center?.lon;
				if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
					continue;
				}
				const tags = element.tags ?? {};
				const kind: ReliefPlaceMark['kind'] = tags['aeroway'] ? 'airport' : tags['historic'] ? 'historic' : 'sight';
				const name = (tags['name:fr'] || tags['name'] || tags['ref'] || (kind === 'airport' ? 'Aéroport' : '')).trim();
				if (!name) {
					continue;
				}
				marks.push({ lat, lng, name, kind });
				if (marks.length >= 120) {
					break;
				}
			}
			this.placeMarks = marks;
			this.paintPlaces();
		} catch {
			/* déplacement ou réseau : la prochaine fin de mouvement réessaie */
		}
	}

	/** Le navigateur est refusé par les miroirs Overpass. La requête part du backend. */
	private async fetchPlacesPayload(
		signal: AbortSignal
	): Promise<{
		elements?: Array<{
			lat?: number;
			lon?: number;
			center?: { lat?: number; lon?: number };
			tags?: Record<string, string>;
		}>;
	} | null> {
		const box = this.placesBbox();
		if (!box) {
			return null;
		}
		const params = new URLSearchParams({
			south: box.south.toFixed(5),
			west: box.west.toFixed(5),
			north: box.north.toFixed(5),
			east: box.east.toFixed(5)
		});
		const response = await fetch(`${environment.API_URL}external/map/places?${params}`, { signal });
		if (!response.ok) {
			return null;
		}
		return await response.json();
	}

	private placesBbox(): { south: number; west: number; north: number; east: number } | null {
		if (this.relief3d) {
			const box = this.terrainView?.bounds();
			if (box) {
				return box;
			}
		}
		const bounds = this.map?.getBounds();
		if (!bounds) {
			return null;
		}
		return {
			south: bounds.getSouth(),
			west: bounds.getWest(),
			north: bounds.getNorth(),
			east: bounds.getEast()
		};
	}

	private paintPlaces(): void {
		this.placesLayer?.remove();
		this.placesLayer = null;
		if (this.map && this.placeMarks.length) {
			const colors: Record<ReliefPlaceMark['kind'], string> = {
				historic: '#7b2cbf',
				sight: '#e67e22',
				airport: '#1a5276'
			};
			const group = L.layerGroup();
			for (const mark of this.placeMarks) {
				L.circleMarker([mark.lat, mark.lng], {
					radius: 6,
					color: '#ffffff',
					weight: 2,
					fillColor: colors[mark.kind],
					fillOpacity: 1
				}).bindTooltip(mark.name, { direction: 'top', offset: [0, -8] }).addTo(group);
			}
			group.addTo(this.map);
			this.placesLayer = group;
		}
		this.terrainView?.setPlaces(this.placeMarks);
		this.cdr.markForCheck();
	}

	private computeShowWeatherStationsHintKey(): string {
		const provider = this.resolveMapWeatherStationProvider();
		if (provider === 'ms') {
			return 'METEO_FRANCE.SHOW_TEMPERATURE_MAP_HINT_MS';
		}
		if (provider === 'mf') {
			return 'METEO_FRANCE.SHOW_TEMPERATURE_MAP_HINT';
		}
		return 'EVENTELEM.SHOW_WEATHER_STATIONS_HINT_OUTSIDE';
	}

	/** Sync hint key immediately (safe inside deferWeatherUiUpdate / before first bind). */
	private syncShowWeatherStationsHintKey(): void {
		this.showWeatherStationsHintKey = this.computeShowWeatherStationsHintKey();
	}

	/** Defer hint key update — avoids NG0100 when selection/country changes mid CD cycle. */
	private refreshShowWeatherStationsHintKey(): void {
		const key = this.computeShowWeatherStationsHintKey();
		if (key === this.showWeatherStationsHintKey) {
			return;
		}
		this.deferWeatherUiUpdate(() => this.syncShowWeatherStationsHintKey());
	}

	public onShowWeatherStationsChange(): void {
		if (this.showWeatherStations) {
			this.seedStationSelectionFromExistingClick();
			this.ensureMfStatusForStationTooltips();
		} else {
			this.clearStationSelection();
		}
		this.applyWeatherStationsOverlay();
		this.cdr.detectChanges();
		this.persistTraceViewerPreferences();
	}

	private ensureMfStatusForStationTooltips(): void {
		if (this.mfStatus != null) {
			return;
		}
		this.apiService.getMeteoFranceStatus().pipe(take(1)).subscribe({
			next: (status) => {
				this.mfStatus = status;
				this.applyWeatherStationsOverlay();
				this.scheduleTraceViewerCdr();
			},
			error: () => { /* history buttons stay hidden */ }
		});
	}

	private get climAvailableForStationTooltips(): boolean {
		return this.mfStatus?.dpclimAuthValid === true;
	}

	private get msHistAvailableForStationTooltips(): boolean {
		return this.mfStatus?.meteoswissSmnEnabled !== false;
	}

	public openMfStationHistoryFromTooltip(point: WeatherStationGridPoint): void {
		if (!point.stationId || !this.climAvailableForStationTooltips) {
			return;
		}
		const [lat, lon] = stationMarkerLatLng(point);
		const z = this.map ? this.map.getZoom() : this.currentZoom;
		void this.router.navigate(['api', 'meteo-france'], {
			queryParams: {
				lat: Math.round(lat * 1e7) / 1e7,
				lon: Math.round(lon * 1e7) / 1e7,
				z: Math.round(z * 100) / 100,
				tab: 'clim',
				stationId: point.stationId,
			}
		});
		this.close();
	}

	public openGpsFollow(): void {
		if (!this.canOpenGpsFollow) {
			return;
		}
		const realFileName = isTrackFileName(this.gpsSourceFileName)
			? (this.gpsSourceFileName || '').trim()
			: isTrackFileName(this.trackFileName)
				? (this.trackFileName || '').trim()
				: '';
		if (this.gpsSourceFileId) {
			void this.router.navigate(['api', 'gps'], {
				queryParams: {
					fileId: this.gpsSourceFileId,
					fileName: realFileName || 'track.gpx'
				}
			});
			this.close();
			return;
		}
		const fromGpx = this.gpxAnalysis?.points?.length
			? this.gpxAnalysis.points.map((p) => ({ lat: p.lat, lon: p.lon, eleM: p.eleM ?? null }))
			: [];
		const fromMap = this.trackOrientationCoords.map((p) => ({
			lat: p[0],
			lon: p[1],
			eleM: null as number | null
		}));
		const points = fromGpx.length >= 2 ? fromGpx : fromMap;
		if (points.length < 2) {
			return;
		}
		writeGpsHandoff({
			title: this.trackFileName || this.gpsSourceFileName,
			fileName: realFileName || undefined,
			points
		});
		void this.router.navigate(['api', 'gps']);
		this.close();
	}

	public openGpsRouteToClickedAddress(): void {
		if (!this.canOpenGpsRouteToClickedAddress) {
			return;
		}
		const queryParams: Record<string, string | number> = {
			toLat: Math.round(this.clickedLat * 1e7) / 1e7,
			toLon: Math.round(this.clickedLng * 1e7) / 1e7,
			toLabel: this.clickedAddress
		};
		const from = this.getLastKnownUserLatLng();
		if (from) {
			queryParams['fromLat'] = Math.round(from.lat * 1e7) / 1e7;
			queryParams['fromLon'] = Math.round(from.lng * 1e7) / 1e7;
		}
		void this.router.navigate(['api', 'gps-routing'], { queryParams });
		this.close();
	}

	private getLastKnownUserLatLng(): { lat: number; lng: number } | null {
		if (!this.deviceLocationMarker) {
			return null;
		}
		const ll = this.deviceLocationMarker.getLatLng();
		if (!isValidGeoCoordinate(ll.lat, ll.lng)) {
			return null;
		}
		return { lat: ll.lat, lng: ll.lng };
	}

	public openMsStationHistoryFromTooltip(point: WeatherStationGridPoint): void {
		if (!point.stationId || !this.msHistAvailableForStationTooltips) {
			return;
		}
		const [lat, lon] = stationMarkerLatLng(point);
		const z = this.map ? this.map.getZoom() : this.currentZoom;
		void this.router.navigate(['api', 'meteo-france'], {
			queryParams: {
				lat: Math.round(lat * 1e7) / 1e7,
				lon: Math.round(lon * 1e7) / 1e7,
				z: Math.round(z * 100) / 100,
				tab: 'ms-hist',
				stationId: point.stationId,
			}
		});
		this.close();
	}

	private clearStationSelection(): void {
		this.stationSelectionLat = null;
		this.stationSelectionLng = null;
		this.stationSelectionCountryCode = '';
		this.refreshShowWeatherStationsHintKey();
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
			this.refreshShowWeatherStationsHintKey();
			return;
		}
		if (Number.isFinite(this.clickedLat) && Number.isFinite(this.clickedLng)
			&& (this.clickedLat !== 0 || this.clickedLng !== 0)) {
			this.stationSelectionLat = this.clickedLat;
			this.stationSelectionLng = this.clickedLng;
			this.refreshShowWeatherStationsHintKey();
			return;
		}
		if (this.lastRenderedPosition) {
			this.stationSelectionLat = this.lastRenderedPosition.lat;
			this.stationSelectionLng = this.lastRenderedPosition.lng;
			this.refreshShowWeatherStationsHintKey();
		}
	}

	private setStationSelectionFromClick(lat: number, lng: number): void {
		this.stationSelectionLat = lat;
		this.stationSelectionLng = lng;
		this.stationSelectionCountryCode = '';
		this.refreshShowWeatherStationsHintKey();
		this.refreshWeatherStationsForSelection();
		this.apiService.geocodeReverse(lat, lng).pipe(take(1)).subscribe({
			next: (data) => {
				if (this.stationSelectionLat !== lat || this.stationSelectionLng !== lng) {
					return;
				}
				this.stationSelectionCountryCode = this.extractGeocodeCountryCode(data);
				this.refreshWeatherStationsForSelection();
				this.refreshShowWeatherStationsHintKey();
			},
			error: () => { /* bbox-based provider until geocode succeeds */ }
		});
	}

	private refreshWeatherStationsForSelection(): void {
		if (!this.showWeatherStations) {
			return;
		}
		this.applyWeatherStationsOverlay();
		this.syncWeatherPointFromStationGrid();
	}

	private applyWeatherStationsOverlay(): void {
		if (!this.map) {
			return;
		}
		if (!this.showWeatherStations) {
			this.weatherStationMapLayer.setIgnoreLeafletMoves(false);
			this.weatherStationMapLayer.detach();
			this.syncReliefWeatherStations();
			return;
		}
		this.ensureStationSelectionForOverlay();
		if (!this.resolveMapWeatherStationProvider()) {
			this.weatherStationMapLayer.setIgnoreLeafletMoves(false);
			this.weatherStationMapLayer.detach();
			this.syncReliefWeatherStations();
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
			climAvailable: () => this.climAvailableForStationTooltips,
			msHistAvailable: () => this.msHistAvailableForStationTooltips,
			onMfStationHistory: (point) => this.openMfStationHistoryFromTooltip(point),
			onMsStationHistory: (point) => this.openMsStationHistoryFromTooltip(point),
			onGridPointsUpdated: () => {
				if (!this.isLoadingWeather) {
					this.syncWeatherPointFromStationGrid();
					this.scheduleTraceViewerCdr();
				}
				this.syncReliefWeatherStations();
			},
		});
		this.weatherStationMapLayer.setIgnoreLeafletMoves(this.relief3d);
		if (this.relief3d) {
			this.refreshReliefWeatherStations();
		}
	}

	/** Sans clic préalable, le centre de la carte sert à choisir Météo-France ou MeteoSwiss. */
	private ensureStationSelectionForOverlay(): void {
		if (this.stationSelectionLat != null && this.stationSelectionLng != null) {
			return;
		}
		this.seedStationSelectionFromExistingClick();
		if (this.stationSelectionLat != null && this.stationSelectionLng != null) {
			return;
		}
		const cam = this.relief3d ? this.terrainView?.camera() : null;
		if (cam && Number.isFinite(cam.lat) && Number.isFinite(cam.lng)) {
			this.stationSelectionLat = cam.lat;
			this.stationSelectionLng = cam.lng;
			this.refreshShowWeatherStationsHintKey();
			return;
		}
		if (!this.map) {
			return;
		}
		const center = this.map.getCenter();
		this.stationSelectionLat = center.lat;
		this.stationSelectionLng = center.lng;
		this.refreshShowWeatherStationsHintKey();
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

	/** Rain radar + satellite/OWM cloud overlays when the weather switch is on. */
	private applyWeatherRadarOverlay(): void {
		if (!this.map) {
			return;
		}
		this.removeWeatherRadarLayer();
		this.removeWeatherCloudLayer();
		if (!this.showWeather) {
			return;
		}
		this.loadWeatherRainViewerRadar();
		// Always re-fetch opacity/intensity from Mongo (shared with Météo-France) before drawing clouds.
		this.loadMapLayerCloudPreferences({ applyClouds: true });
	}

	private removeWeatherRadarLayer(): void {
		this.weatherRadarLayer?.remove();
		this.weatherRadarLayer = undefined;
	}

	private removeWeatherCloudLayer(): void {
		this.weatherCloudLoadRequestId++;
		this.weatherCloudLayer?.remove();
		this.weatherCloudLayer = undefined;
		this.cloudDisplaySource = null;
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
						// RainViewer native tiles stop at z7; keep layer visible up to map maxZoom (20).
						maxNativeZoom: 7,
						maxZoom: 20,
						attribution: 'Radar © RainViewer.com (via PatTool)'
					}
				);
				this.weatherRadarLayer.addTo(this.map);
			}
		});
	}

	private loadWeatherCloudLayer(): void {
		if (!this.map || !this.showWeather) {
			return;
		}
		if (this.cloudLayerSource === 'rainviewer') {
			this.loadWeatherRainViewerCloudLayer();
			return;
		}
		this.loadWeatherOpenWeatherCloudLayer();
	}

	private loadWeatherOpenWeatherCloudLayer(): void {
		if (!this.map || !this.showWeather) {
			return;
		}
		const requestId = ++this.weatherCloudLoadRequestId;
		const enhance = this.clampCloudIntensity(this.cloudIntensity).toFixed(1);
		const cacheBust = Date.now();
		const tileUrl =
			`${environment.API_URL}external/weather/map/clouds/{z}/{x}/{y}?enhance=${enhance}&_=${cacheBust}`;
		if (requestId !== this.weatherCloudLoadRequestId) {
			return;
		}
		this.attachWeatherCloudTileLayer(
			tileUrl,
			'Clouds © OpenWeatherMap (via PatTool)',
			true,
			false
		);
		this.cloudDisplaySource = 'openweathermap';
	}

	private loadWeatherRainViewerCloudLayer(): void {
		if (!this.map || !this.showWeather) {
			return;
		}
		const requestId = ++this.weatherCloudLoadRequestId;
		this.apiService.getRainViewerMaps().pipe(takeUntil(this.destroy$)).subscribe({
			next: (data) => {
				if (requestId !== this.weatherCloudLoadRequestId || !this.map || !this.showWeather) {
					return;
				}
				const infrared = data?.satellite?.infrared;
				if (!infrared?.length) {
					return;
				}
				const frame = infrared[infrared.length - 1];
				const path = frame?.path;
				if (!path) {
					return;
				}
				const encodedPath = encodeURIComponent(path);
				const enhance = this.clampCloudIntensity(this.cloudIntensity).toFixed(1);
				const tileBase = `${environment.API_URL}external/radar/rainviewer/tile/{z}/{x}/{y}`;
				this.attachWeatherCloudTileLayer(
					`${tileBase}?path=${encodedPath}&size=256&color=2&options=0_0&enhance=${enhance}`,
					'Satellite IR © RainViewer.com (via PatTool)',
					false,
					true
				);
				this.cloudDisplaySource = 'rainviewer';
			}
		});
	}

	private attachWeatherCloudTileLayer(
		url: string,
		attribution: string,
		openWeather: boolean,
		rainViewer: boolean
	): void {
		if (!this.map) {
			return;
		}
		this.weatherCloudLayer?.remove();
		this.weatherCloudLayer = L.tileLayer(url, {
			opacity: this.clampCloudOpacity(this.cloudOpacity),
			zIndex: 4,
			maxZoom: 20,
			attribution,
			className: openWeather
				? 'mf-cloud-tiles mf-cloud-tiles--owm'
				: rainViewer
					? 'mf-cloud-tiles mf-cloud-tiles--rv'
					: 'mf-cloud-tiles'
		});
		this.weatherCloudLayer.addTo(this.map);
		this.weatherCloudLayer.on('load', () => this.updateWeatherCloudTileEnhancement());
		this.updateWeatherCloudTileEnhancement();
	}

	private updateWeatherCloudTileEnhancement(): void {
		const layer = this.weatherCloudLayer;
		if (!layer) {
			return;
		}
		const container = layer.getContainer() as HTMLElement | undefined;
		if (!container) {
			return;
		}
		if (this.cloudDisplaySource === 'openweathermap') {
			container.style.removeProperty('--mf-cloud-contrast');
			container.style.removeProperty('--mf-cloud-brightness');
			container.style.removeProperty('--mf-cloud-saturate');
			return;
		}
		const intensity = this.clampCloudIntensity(this.cloudIntensity);
		const opacity = this.clampCloudOpacity(this.cloudOpacity);
		const intensityFactor = 0.95 + intensity * 0.28;
		const contrast = 1.85 * intensityFactor * (0.85 + opacity * 0.2);
		const brightness = 0.82 - (intensity - 1) * 0.04;
		const saturate = 1.4 * (0.9 + intensity * 0.14);
		container.style.setProperty('--mf-cloud-contrast', contrast.toFixed(2));
		container.style.setProperty('--mf-cloud-brightness', brightness.toFixed(2));
		container.style.setProperty('--mf-cloud-saturate', saturate.toFixed(2));
	}

	/** Manual reload of radar and cloud tiles. */
	public onRefreshRadar(): void {
		if (!this.map || !this.showWeather) {
			return;
		}
		this.loadWeatherRainViewerRadar();
		this.loadMapLayerCloudPreferences({ applyClouds: true });
	}

	public toggleSelectionOverlay(): void {
		if (!this.isFullscreen) {
			return;
		}
		this.isFullscreenInfoVisible = !this.isFullscreenInfoVisible;
	}

	public recenterOnTrack(): void {
		// Carte seule / point unique (menu Carte, météo…) : Recentrer = GPS utilisateur,
		// pas le point provisoire (souvent Genève) stocké dans trackBounds.
		if (!this.hasMultiPointTrack()) {
			this.recenterOnUser();
			return;
		}
		if (this.relief3d && this.terrainView) {
			this.recenterReliefView();
			return;
		}
		if (!this.map || !this.trackBounds) {
			return;
		}
		this.fitMapToTrackBounds(this.trackBounds);
	}

	/** Vrai dès qu’un tracé GPX / polyline a au moins 2 points (pas un simple openAtLocation). */
	private hasMultiPointTrack(): boolean {
		return (this.gpxAnalysis?.points?.length ?? 0) >= 2
			|| this.trackOrientationCoords.length >= 2
			|| (this.pendingTrackPoints?.length ?? 0) >= 2
			|| (this.pendingTraces?.some((t) => (t.points?.length ?? 0) >= 2) ?? false);
	}

	/**
	 * Même cible qu’en 2D (trace, ou le point unique du rond rouge).
	 * La caméra 3D vise l’altitude du terrain, sinon le saut reste sous la pente.
	 */
	private recenterReliefView(): void {
		const view = this.terrainView;
		if (!view) {
			return;
		}
		view.setGps(this.deviceLocationLatLng);
		const zoom = this.reliefSinglePointZoom();
		const bounds = this.trackBounds;
		if (bounds?.isValid()) {
			if (this.isDegenerateBounds(bounds)) {
				const center = bounds.getCenter();
				view.jumpTo(center.lat, center.lng, zoom);
				return;
			}
			const sw = bounds.getSouthWest();
			const ne = bounds.getNorthEast();
			if (view.fitLngLatBounds(sw.lng, sw.lat, ne.lng, ne.lat, this.resolveFitBoundsMaxZoom())) {
				return;
			}
		}
		const point = this.deviceLocationLatLng ?? this.lastRenderedPosition;
		if (point) {
			view.jumpTo(point.lat, point.lng, zoom);
			return;
		}
		view.fitTraces();
	}

	/** Zoom d’un recentrage sur un seul point : le même qu’en vue à plat. */
	private reliefSinglePointZoom(): number {
		const cap = this.map ? this.resolveFitBoundsMaxZoom() : TraceViewerModalComponent.DEFAULT_LOCATION_ZOOM;
		return Math.min(
			cap,
			Math.max(2, this.locationRecenterZoom ?? TraceViewerModalComponent.DEFAULT_LOCATION_ZOOM)
		);
	}

	/**
	 * After open: start GPS immediately (before the map exists), then keep applying
	 * the fix until Leaflet (and 3D if any) can show it.
	 */
	public scheduleRecenterOnUser(): void {
		const generation = this.modalGeneration;
		this.beginUserGpsFetch(generation);
		const attempt = (n: number): void => {
			if (generation !== this.modalGeneration || !this.modalRef) {
				return;
			}
			if (this.reapplyPendingUserGpsToView()) {
				// 3D may mount a moment later on the weather center — re-apply a few times.
				if (n < 40 && (this.relief3dPending || (this.relief3d && !this.terrainView))) {
					window.setTimeout(() => attempt(n + 1), 100);
				}
				return;
			}
			if (n < 100) {
				window.setTimeout(() => attempt(n + 1), 50);
			}
		};
		attempt(0);
	}

	/** One shot: center the map on the device GPS and show the position marker. */
	public recenterOnUser(): void {
		if (!this.map) {
			this.scheduleRecenterOnUser();
			return;
		}
		if (this.pendingUserGps) {
			this.applyUserRecenter(this.pendingUserGps.lat, this.pendingUserGps.lng, true);
		} else if (this.lastGpsFix) {
			this.applyUserRecenter(this.lastGpsFix.lat, this.lastGpsFix.lon, false);
		}
		this.beginUserGpsFetch(this.modalGeneration);
	}

	/** Fetch GPS for this modal generation; high accuracy first, then network/Wi‑Fi fallback. */
	private beginUserGpsFetch(generation: number): void {
		if (!navigator.geolocation) {
			return;
		}
		if (this.userGpsFetchGen === generation && this.locatingUser) {
			return;
		}
		this.userGpsFetchGen = generation;
		this.locatingUser = true;
		this.cdr.markForCheck();
		const onFix = (lat: number, lng: number): void => {
			if (this.userGpsFetchGen !== generation || generation !== this.modalGeneration) {
				return;
			}
			this.locatingUser = false;
			this.pendingUserGps = { lat, lng };
			this.lastGpsFix = { lat, lon: lng };
			this.reapplyPendingUserGpsToView();
			this.cdr.markForCheck();
		};
		const onFailFinal = (): void => {
			if (this.userGpsFetchGen !== generation) {
				return;
			}
			this.locatingUser = false;
			this.cdr.markForCheck();
		};
		navigator.geolocation.getCurrentPosition(
			(pos) => onFix(pos.coords.latitude, pos.coords.longitude),
			() => {
				navigator.geolocation.getCurrentPosition(
					(pos) => onFix(pos.coords.latitude, pos.coords.longitude),
					onFailFinal,
					{ enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 }
				);
			},
			{ enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
		);
	}

	/**
	 * 3D can mount before the GPS fix is copied onto its camera.
	 * If the flat map has since been moved, leave that place alone.
	 */
	private catchUpReliefCameraToGps(): void {
		const fix = this.pendingUserGps;
		const map = this.map;
		const view = this.terrainView;
		if (!fix || !map || !view || this.userGpsRecenterGen !== this.modalGeneration) {
			return;
		}
		const leaflet = map.getCenter();
		const leafletAtGps = Math.abs(leaflet.lat - fix.lat) < 0.0008 && Math.abs(leaflet.lng - fix.lng) < 0.0008;
		if (!leafletAtGps) {
			return;
		}
		const cam = view.camera();
		if (!cam) {
			return;
		}
		const reliefAtGps = Math.abs(cam.lat - fix.lat) < 0.0008 && Math.abs(cam.lng - fix.lng) < 0.0008;
		if (!reliefAtGps) {
			view.jumpTo(fix.lat, fix.lng, map.getZoom());
		}
	}

	/** Apply pending/live GPS to Leaflet + MapLibre when the view exists. */
	private reapplyPendingUserGpsToView(): boolean {
		const fix = this.pendingUserGps
			?? (this.lastGpsFix && this.userGpsRecenterGen === this.modalGeneration
				? { lat: this.lastGpsFix.lat, lng: this.lastGpsFix.lon }
				: null);
		if (!fix || !this.map || !this.mapContainerIsSized()) {
			return false;
		}
		this.applyUserRecenter(fix.lat, fix.lng, true);
		return true;
	}

	/**
	 * Centre Leaflet + vue 3D sur la position GPS et pose le marqueur.
	 * `fromLiveGps` : fix frais → bloque un éventuel retour sur le point provisoire.
	 */
	private applyUserRecenter(lat: number, lng: number, fromLiveGps = true): void {
		if (!this.map || !Number.isFinite(lat) || !Number.isFinite(lng)) {
			return;
		}
		if (fromLiveGps) {
			this.userGpsRecenterGen = this.modalGeneration;
			this.pendingUserGps = { lat, lng };
		}
		const zoom = Math.min(
			this.map.getMaxZoom(),
			Math.max(this.visibleLeafletZoom(), TraceViewerModalComponent.USER_POSITION_ZOOM)
		);
		this.map.setView([lat, lng], zoom, { animate: false });
		this.currentZoom = zoom;
		// Always push to MapLibre when present — even if relief3d flag races the mount.
		this.terrainView?.jumpTo(lat, lng, zoom);
		this.updateDeviceLocationMarker(lat, lng);
		// Hors tracé : le prochain Recentrer (R) doit aussi viser ce point, pas le provisoire.
		if (!this.hasMultiPointTrack()) {
			this.trackBounds = L.latLngBounds([lat, lng], [lat, lng]);
			this.locationRecenterZoom = zoom;
			this.lastRenderedPosition = { lat, lng };
			this.noteTrackFitted();
		}
	}

	public setMapOrientation(orientation: TraceMapOrientation): void {
		const held = this.reliefOrientationHeld;
		this.reliefOrientationHeld = false;
		const clearManual = this.manualMapBearing != null;
		if (held && this.mapOrientation === orientation) {
			if (orientation === 'fixed' && this.manualMapBearing == null) {
				this.manualMapBearing = this.currentMapBearingDeg();
			}
			this.syncMapOrientationWatch();
			this.applyMapBearing();
			this.scheduleTraceViewerCdr();
			return;
		}
		if (this.mapOrientation === orientation && !clearManual) {
			this.ensureDirectionCompass();
			this.applyMapBearing();
			return;
		}
		this.manualMapBearing = null;
		this.mapOrientation = orientation;
		this.syncMapOrientationWatch();
		this.applyMapBearing();
		this.scheduleTraceViewerCdr();
	}

	private syncMapOrientationWatch(): void {
		if (this.mapOrientation === 'heading') {
			this.startMapOrientationWatch();
		} else {
			this.stopGpsOrientationWatch();
		}
		this.ensureDirectionCompass();
		this.syncReliefTouchLocks();
	}

	/** Pinch stays free. Twist follows Nord, and two-finger tilt yields to the phone switch. */
	private syncReliefTouchLocks(): void {
		this.terrainView?.setTouchLocks({
			bearing: this.mapOrientation === 'north',
			pitch: this.reliefTiltFollowDriving
		});
	}

	/** Mode Nord : la boussole tourne la carte. Sinon elle ne sert qu’à la flèche verte. */
	private ensureDirectionCompass(): void {
		if (this.mapOrientation === 'north' || this.directionTarget) {
			void this.startCompassHeading();
			return;
		}
		this.stopCompassHeading();
	}

	private startMapOrientationWatch(): void {
		if (this.mapOrientationWatchId != null || !navigator.geolocation) {
			return;
		}
		this.mapOrientationWatchId = navigator.geolocation.watchPosition(
			(pos) => {
				this.lastGpsFix = { lat: pos.coords.latitude, lon: pos.coords.longitude };
				this.noteGpsCourse(pos);
				if (this.mapOrientation === 'heading') {
					this.applyMapBearing();
				}
			},
			() => { /* keep last heading */ },
			{ enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
		);
	}

	private stopMapOrientationWatch(): void {
		this.stopGpsOrientationWatch();
		this.stopCompassHeading();
		this.stopMapBearingGlide();
		this.stopReliefTiltListener();
	}

	private stopGpsOrientationWatch(): void {
		if (this.mapOrientationWatchId != null && navigator.geolocation) {
			navigator.geolocation.clearWatch(this.mapOrientationWatchId);
			this.mapOrientationWatchId = null;
		}
		this.gpsCourseActive = false;
	}

	/** Cap GPS uniquement en déplacement : à l'arrêt le heading est souvent 0 ou absent. */
	private noteGpsCourse(pos: GeolocationPosition): void {
		const speed = pos.coords.speed;
		const course = pos.coords.heading;
		const moving = speed != null && Number.isFinite(speed) && speed >= 0.5;
		if (!moving || course == null || !Number.isFinite(course)) {
			this.gpsCourseActive = false;
			return;
		}
		this.gpsCourseActive = true;
		this.deviceHeadingDeg = this.smoothHeading(this.deviceHeadingDeg, course);
	}

	/** Évite les sauts de cap GPS qui font clignoter la carte. */
	private smoothHeading(previous: number | null, next: number): number {
		if (previous == null) {
			return this.wrapDeg(next);
		}
		let diff = next - previous;
		if (diff > 180) {
			diff -= 360;
		} else if (diff < -180) {
			diff += 360;
		}
		return this.wrapDeg(previous + diff * 0.35);
	}

	private async startCompassHeading(): Promise<void> {
		if (this.compassListening || typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
			return;
		}
		if (this.mapOrientation !== 'north' && !this.directionTarget) {
			return;
		}
		const permission = await requestMotionPermissionIfNeeded();
		if (permission === 'denied' || this.compassListening) {
			return;
		}
		if (this.mapOrientation !== 'north' && !this.directionTarget) {
			return;
		}
		this.compassListening = true;
		const eventName = 'ondeviceorientationabsolute' in window
			? 'deviceorientationabsolute'
			: 'deviceorientation';
		this.compassEventName = eventName;
		window.addEventListener(eventName, this.onCompassOrientation, true);
	}

	private stopCompassHeading(): void {
		if (!this.compassListening || typeof window === 'undefined') {
			this.compassListening = false;
			return;
		}
		if (this.compassEventName) {
			window.removeEventListener(this.compassEventName, this.onCompassOrientation, true);
			this.compassEventName = null;
		}
		this.compassListening = false;
		this.compassNorthDeg = null;
		this.lastRawCompassDeg = null;
		this.compassOutlierStreak = 0;
		this.stopMapBearingGlide();
	}

	private consumeCompassOrientation(event: DeviceOrientationEvent): void {
		const heading = this.compassHeadingDeg(event);
		if (heading == null) {
			return;
		}
		const accuracy = (event as DeviceOrientationEvent & { webkitCompassAccuracy?: number }).webkitCompassAccuracy;
		if (typeof accuracy === 'number' && accuracy < 0) {
			return;
		}
		if (this.lastRawCompassDeg != null) {
			const jump = Math.abs(this.shortestAngleDelta(this.lastRawCompassDeg, heading));
			if (jump > 55) {
				this.compassOutlierStreak += 1;
				if (this.compassOutlierStreak < 3) {
					return;
				}
			} else {
				this.compassOutlierStreak = 0;
			}
		}
		this.lastRawCompassDeg = heading;
		if (this.compassNorthDeg == null) {
			this.compassNorthDeg = heading;
		} else {
			const diff = this.shortestAngleDelta(this.compassNorthDeg, heading);
			this.compassNorthDeg = this.wrapDeg(this.compassNorthDeg + diff * 0.55);
		}
		if (this.mapOrientation === 'north') {
			this.applyMapBearing();
		} else {
			this.syncDeviceLocationArrows();
		}
	}

	/**
	 * Angle à passer à setBearing. leaflet-rotate tourne les tuiles dans le sens
	 * horaire : le cap « nord en haut de l’écran » n’est pas le cap boussole brut.
	 * À plat, même résultat que CompassBearing. Téléphone vertical : même lacet
	 * que astro-compass, caméra arrière sous le téléphone, pour que lever le
	 * mobile ne retourne pas le Nord.
	 *
	 * webkitCompassHeading = déjà le cap du *haut d’écran* → pas de screen angle.
	 * α/β/γ absolus = repère appareil → on soustrait screen.orientation.angle
	 * pour que le haut de la carte suive le haut de l’écran (portrait/paysage).
	 */
	private compassHeadingDeg(event: DeviceOrientationEvent): number | null {
		const anyEvent = event as DeviceOrientationEvent & { webkitCompassHeading?: number };
		const webkit =
			typeof anyEvent.webkitCompassHeading === 'number' && Number.isFinite(anyEvent.webkitCompassHeading)
				? anyEvent.webkitCompassHeading
				: null;
		const absolute =
			event.absolute === true || this.compassEventName === 'deviceorientationabsolute';
		let alpha: number | null = null;
		if (webkit != null) {
			// Cap écran → α appareil (portrait) pour la matrice caméra −Z.
			alpha = this.wrapDeg(360 - webkit);
		} else if (event.alpha != null && Number.isFinite(event.alpha) && absolute) {
			alpha = event.alpha;
		}
		if (alpha == null) {
			return null;
		}
		const beta = event.beta != null && Number.isFinite(event.beta) ? event.beta : 0;
		const gamma = event.gamma != null && Number.isFinite(event.gamma) ? event.gamma : 0;
		// webkit est déjà calé sur le haut d’écran : ne pas re-soustraire l’orientation.
		const screen = webkit != null ? 0 : this.currentScreenAngle();
		const bearing = mapBearingFromDeviceOrientation(alpha, beta, gamma, screen);
		if (bearing != null) {
			return bearing;
		}
		// Repli : leaflet bearing = −cap écran.
		if (webkit != null) {
			return this.wrapDeg(-webkit);
		}
		return this.wrapDeg(alpha - screen);
	}

	/** Angle CSS de l’écran (0 portrait, 90/270 paysage). */
	private currentScreenAngle(): number {
		try {
			const so = screen?.orientation;
			if (so && typeof so.angle === 'number' && Number.isFinite(so.angle)) {
				return so.angle;
			}
		} catch {
			/* ignore */
		}
		const legacy = (window as Window & { orientation?: number }).orientation;
		return typeof legacy === 'number' && Number.isFinite(legacy) ? legacy : 0;
	}

	private wrapDeg(deg: number): number {
		return ((deg % 360) + 360) % 360;
	}

	/** Plus court écart signé, dans ]-180, 180]. */
	private shortestAngleDelta(from: number, to: number): number {
		let diff = to - from;
		if (diff > 180) {
			diff -= 360;
		} else if (diff < -180) {
			diff += 360;
		}
		return diff;
	}

	private updateRouteHeadingFromTrack(): void {
		const anchor = this.routeHeadingAnchor();
		if (!anchor) {
			this.routeHeadingDeg = 0;
			return;
		}
		this.updateRouteHeadingNear(anchor.lat, anchor.lon);
	}

	private routeHeadingAnchor(): { lat: number; lon: number } | null {
		if (this.followDeviceLocation && this.lastGpsFix) {
			return this.lastGpsFix;
		}
		if (this.followDeviceLocation && this.deviceLocationLatLng) {
			return { lat: this.deviceLocationLatLng.lat, lon: this.deviceLocationLatLng.lng };
		}
		if (this.map) {
			const center = this.map.getCenter();
			return { lat: center.lat, lon: center.lng };
		}
		const first = this.trackOrientationCoords[0];
		return first ? { lat: first[0], lon: first[1] } : null;
	}

	/** Direction du tracé ~20 m en avant du point le plus proche (ignore les points GPS dupliqués). */
	private updateRouteHeadingNear(lat: number, lon: number): void {
		const points = this.trackOrientationCoords;
		if (points.length < 2) {
			this.routeHeadingDeg = 0;
			return;
		}
		const track = points.map((p) => ({ lat: p[0], lon: p[1] }));
		const heading = trackHeadingAt(track, nearestTrackIndex(track, lat, lon), 20);
		if (heading != null && Number.isFinite(heading)) {
			this.routeHeadingDeg = heading;
		}
	}

	/** Le déplacement de la carte ne change pas l’orientation (ni boussole, ni tracé). */
	private refreshOrientationAfterMapMove(): void {
		return;
	}

	private applyMapBearing(): void {
		if (this.reliefOrientationHeld) {
			this.syncDeviceLocationArrows();
			return;
		}
		const map = this.map as RotatableLeafletMap | undefined;
		if (!map || typeof map.setBearing !== 'function') {
			this.syncDeviceLocationArrows();
			return;
		}
		let bearing = 0;
		if (this.mapOrientation === 'north') {
			if (this.compassNorthDeg == null) {
				this.syncDeviceLocationArrows();
				return;
			}
			this.glideMapBearing(this.wrapDeg(this.compassNorthDeg));
			return;
		}
		this.stopMapBearingGlide();
		if (this.mapOrientation === 'heading') {
			if (this.deviceHeadingDeg == null) {
				this.syncDeviceLocationArrows();
				return;
			}
			bearing = this.deviceHeadingDeg;
		} else if (this.manualMapBearing != null) {
			bearing = this.manualMapBearing;
		}
		const next = this.wrapDeg(bearing);
		const delta = Math.abs(next - this.currentMapBearingDeg());
		if (Math.min(delta, 360 - delta) < 1.5) {
			this.syncDeviceLocationArrows();
			return;
		}
		this.commitMapBearing(map, next);
	}

	/**
	 * Mode Nord : le capteur met à jour la cible, le bearing affiché la rejoint
	 * en continu (exponentielle, sans dépassement). Évite les sauts de 4° toutes les 160 ms.
	 */
	private glideMapBearing(target: number): void {
		this.mapBearingGlideTarget = target;
		if (this.mapBearingGlideDisplayed == null) {
			this.mapBearingGlideDisplayed = this.currentMapBearingDeg();
		}
		if (this.mapBearingGlideRaf != null) {
			return;
		}
		const initial = this.shortestAngleDelta(this.mapBearingGlideDisplayed, target);
		if (Math.abs(initial) < 0.12) {
			this.applyHeldReliefTilt();
			this.syncDeviceLocationArrows();
			return;
		}
		this.mapBearingGlideTs = 0;
		const tick = (ts: number): void => {
			const map = this.map as RotatableLeafletMap | undefined;
			const displayed = this.mapBearingGlideDisplayed;
			const goal = this.mapBearingGlideTarget;
			if (
				this.mapOrientation !== 'north'
				|| displayed == null
				|| goal == null
				|| !map
				|| typeof map.setBearing !== 'function'
			) {
				this.mapBearingGlideRaf = null;
				return;
			}
			const dt = this.mapBearingGlideTs
				? Math.min(0.05, (ts - this.mapBearingGlideTs) / 1000)
				: 1 / 60;
			this.mapBearingGlideTs = ts;
			const delta = this.shortestAngleDelta(displayed, goal);
			if (Math.abs(delta) < 0.08) {
				this.mapBearingGlideDisplayed = goal;
				this.commitMapBearing(map, goal);
				this.mapBearingGlideRaf = null;
				return;
			}
			const alpha = 1 - Math.exp(-dt / 0.12);
			this.mapBearingGlideDisplayed = this.wrapDeg(displayed + delta * alpha);
			this.commitMapBearing(map, this.mapBearingGlideDisplayed);
			this.mapBearingGlideRaf = requestAnimationFrame(tick);
		};
		this.mapBearingGlideRaf = requestAnimationFrame(tick);
	}

	/** Pitch still has to move when Nord is already aligned and the glide loop is idle. */
	private applyHeldReliefTilt(): void {
		if (!this.reliefTiltFollowDriving || this.reliefTiltPitch == null || this.terrainView?.isUserGesturing()) {
			return;
		}
		this.terrainView?.setPitch(this.reliefTiltPitch);
	}

	private stopMapBearingGlide(): void {
		if (this.mapBearingGlideRaf != null && typeof cancelAnimationFrame === 'function') {
			cancelAnimationFrame(this.mapBearingGlideRaf);
		}
		this.mapBearingGlideRaf = null;
		this.mapBearingGlideDisplayed = null;
		this.mapBearingGlideTarget = null;
		this.mapBearingGlideTs = 0;
	}

	private commitMapBearing(map: RotatableLeafletMap, bearing: number): void {
		if (this.reliefOrientationHeld || this.terrainView?.isUserGesturing()) {
			return;
		}
		const reliefBearing = this.wrapDeg(-bearing);
		this.reliefBearingLock = reliefBearing;
		this.applyingMapBearing = true;
		try {
			map.setBearing?.(bearing);
			const tilt = this.reliefTiltFollowDriving ? this.reliefTiltPitch : null;
			this.terrainView?.setBearing(reliefBearing, tilt != null ? tilt : undefined);
		} catch {
			/* plugin not ready */
		} finally {
			this.applyingMapBearing = false;
		}
		if (this.relief3d) {
			this.reliefBearing = reliefBearing;
			this.updateCompassRose();
		}
		this.syncDeviceLocationArrows();
	}

	/** Ctrl + glisser en 3D : garder l’angle et couper la boussole ou le cap GPS. */
	private adoptReliefDrag(bearing: number): void {
		const leafletBearing = this.wrapDeg(-bearing);
		this.manualMapBearing = leafletBearing;
		this.stopMapBearingGlide();
		if (this.mapOrientation !== 'fixed') {
			this.mapOrientation = 'fixed';
			this.syncMapOrientationWatch();
			this.scheduleTraceViewerCdr();
		}
		const map = this.map as RotatableLeafletMap | undefined;
		this.applyingMapBearing = true;
		try {
			map?.setBearing?.(leafletBearing);
		} finally {
			this.applyingMapBearing = false;
		}
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
		this.scheduleTraceViewerCdr();
	}

	/** Affiche ou met à jour le marqueur « position appareil » (point rouge, flèche nord, flèche cible). */
	private updateDeviceLocationMarker(lat: number, lng: number): void {
		if (!this.map) {
			return;
		}
		this.deviceLocationLatLng = { lat, lng };
		if (this.deviceLocationMarker) {
			this.deviceLocationMarker.setLatLng([lat, lng]);
			this.deviceLocationMarker.setZIndexOffset(3000);
			if (!this.deviceLocationMarker.getElement()?.querySelector('svg[data-arrow-style="thin-label"]')) {
				this.deviceLocationMarker.setIcon(this.deviceLocationIcon());
			}
			this.syncDeviceLocationArrows();
			this.terrainView?.setGps(this.deviceLocationLatLng);
			return;
		}
		this.deviceLocationMarker = L.marker([lat, lng], { icon: this.deviceLocationIcon(), zIndexOffset: 3000 });
		this.deviceLocationMarker.addTo(this.map);
		this.syncDeviceLocationArrows();
		this.terrainView?.setGps(this.deviceLocationLatLng);
	}

	private deviceLocationIcon(): L.DivIcon {
		const size = TraceViewerModalComponent.DEVICE_MARKER_PX;
		return L.divIcon({
			className: 'device-location-marker',
			html: this.deviceLocationMarkerHtml(),
			iconSize: [size, size],
			iconAnchor: [size / 2, size / 2]
		});
	}

	/**
	 * SVG inline : la modale est montée hors du composant, les classes CSS ne s’y appliquent pas.
	 * Le centre est la position GPS. Trait + pointe identiques pour le nord (rouge) et la cible (verte).
	 */
	private deviceLocationMarkerHtml(): string {
		const northLabel = this.translate('GPS_ROUTING.ORIENT_NORTH')
			.replace(/&/g, '&amp;')
			.replace(/"/g, '&quot;')
			.replace(/</g, '&lt;');
		const size = TraceViewerModalComponent.DEVICE_MARKER_PX;
		const c = size / 2;
		return `<div title="${northLabel}" style="width:${size}px;height:${size}px;overflow:visible;pointer-events:none;">` +
			`<svg data-arrow-style="thin-label" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible;">` +
			`<g class="device-location-target" style="display:none" opacity="0.8">${this.deviceDirectionArrowSvg('#16a34a', true)}</g>` +
			`<g class="device-location-north" style="display:none" opacity="0.8">${this.deviceDirectionArrowSvg('#e10600')}</g>` +
			`<circle cx="${c}" cy="${c}" r="8" fill="#e10600" stroke="#ffffff" stroke-width="2.5"/>` +
			`</svg></div>`;
	}

	/** Trait fin depuis la position, puis une petite pointe. Même géométrie pour les deux couleurs. */
	private deviceDirectionArrowSvg(color: string, withDistance = false): string {
		const c = TraceViewerModalComponent.DEVICE_MARKER_PX / 2;
		const tip = 58;
		const base = 78;
		const label = withDistance
			? `<text class="dir-arrow-distance" x="${c}" y="${TraceViewerModalComponent.ARROW_LABEL_Y}" text-anchor="middle" dy="-4" ` +
				`font-size="10" font-weight="700" font-family="system-ui, sans-serif" fill="${color}" ` +
				`stroke="#ffffff" stroke-width="3" stroke-linejoin="round" paint-order="stroke"></text>`
			: '';
		return `<line x1="${c}" y1="${c - 12}" x2="${c}" y2="${base - 2}" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>` +
			`<line x1="${c}" y1="${c - 12}" x2="${c}" y2="${base - 2}" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>` +
			`<polygon points="${c},${tip} ${c - 7},${base} ${c + 7},${base}" fill="${color}" stroke="#ffffff" stroke-width="1.25" stroke-linejoin="round"/>` +
			label;
	}

	/**
	 * Distance écrite le long de la tige. Le groupe est tourné de `screenAngle` :
	 * on retourne le texte de 180° quand il se lirait à l’envers.
	 */
	private updateArrowDistanceLabel(
		group: Element,
		from: { lat: number; lng: number },
		to: { lat: number; lng: number },
		screenAngle: number
	): void {
		const text = group.querySelector('.dir-arrow-distance');
		if (!text) {
			return;
		}
		const meters = L.latLng(from.lat, from.lng).distanceTo(L.latLng(to.lat, to.lng));
		text.textContent = this.formatArrowDistance(meters);
		const a = this.wrapDeg(screenAngle);
		const rotation = a < 180 ? -90 : 90;
		const c = TraceViewerModalComponent.DEVICE_MARKER_PX / 2;
		text.setAttribute('transform', `rotate(${rotation} ${c} ${TraceViewerModalComponent.ARROW_LABEL_Y})`);
	}

	private formatArrowDistance(meters: number): string {
		if (!Number.isFinite(meters) || meters < 0) {
			return '';
		}
		if (meters < 1000) {
			return `${Math.round(meters)} m`;
		}
		const km = meters / 1000;
		return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
	}

	/** Flèche rouge = nord (mode Nord seulement). Flèche verte = adresse, dans les 3 modes. */
	private syncDeviceLocationArrows(): void {
		this.syncDirectionTargetMarker();
		this.syncClickDirectionArrow();
		const marker = this.deviceLocationMarker;
		if (!marker) {
			return;
		}
		const markerEl = marker.getElement();
		if (!markerEl?.querySelector('svg[data-arrow-style="thin-label"]') || markerEl.querySelector('.device-location-target-label')) {
			marker.setIcon(this.deviceLocationIcon());
		}
		const root = marker.getElement();
		if (!root) {
			return;
		}
		root.style.background = 'transparent';
		root.style.border = 'none';
		root.style.overflow = 'visible';
		root.style.pointerEvents = 'none';
		const mapBearing = this.currentMapBearingDeg();
		const pivot = TraceViewerModalComponent.DEVICE_MARKER_PX / 2;
		const north = root.querySelector('.device-location-north') as SVGGElement | null;
		if (north) {
			if (this.mapOrientation !== 'north') {
				north.style.display = 'none';
			} else {
				north.style.display = '';
				north.setAttribute('transform', `rotate(${mapBearing} ${pivot} ${pivot})`);
			}
		}
		const targetEl = root.querySelector('.device-location-target') as SVGGElement | null;
		const from = this.deviceLocationLatLng;
		const to = this.effectiveDirectionTarget();
		if (!targetEl) {
			return;
		}
		if (!from || !to) {
			targetEl.style.display = 'none';
			targetEl.removeAttribute('transform');
			return;
		}
		if (this.isSameSpot(from, to)) {
			targetEl.style.display = 'none';
			return;
		}
		targetEl.style.display = '';
		const bearing = this.bearingDeg(from.lat, from.lng, to.lat, to.lng);
		// Le marqueur reste droit à l'écran ; on ajoute la rotation de la carte pour viser l'adresse.
		const screenAngle = bearing + mapBearing;
		targetEl.setAttribute('transform', `rotate(${screenAngle} ${pivot} ${pivot})`);
		this.updateArrowDistanceLabel(targetEl, from, to, screenAngle);
	}

	/** Flèche verte aussi sur le point double-cliqué, vers l’adresse choisie. */
	private syncClickDirectionArrow(): void {
		const from = this.clickMarker?.getLatLng();
		const to = this.effectiveDirectionTarget();
		if (!this.map || !from || !to || this.isSameSpot(from, to)) {
			this.removeClickDirectionMarker();
			return;
		}
		const size = TraceViewerModalComponent.DEVICE_MARKER_PX;
		const pivot = size / 2;
		if (!this.clickDirectionMarker) {
			this.clickDirectionMarker = L.marker(from, {
				icon: L.divIcon({
					className: 'click-direction-marker',
					html: `<div style="width:${size}px;height:${size}px;overflow:visible;pointer-events:none;">` +
						`<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible;">` +
						`<g class="click-direction-target" opacity="0.8">${this.deviceDirectionArrowSvg('#16a34a', true)}</g>` +
						`</svg></div>`,
					iconSize: [size, size],
					iconAnchor: [pivot, pivot]
				}),
				interactive: false,
				keyboard: false,
				zIndexOffset: 900
			}).addTo(this.map);
		} else {
			this.clickDirectionMarker.setLatLng(from);
		}
		const root = this.clickDirectionMarker.getElement();
		if (!root) {
			return;
		}
		root.style.background = 'transparent';
		root.style.border = 'none';
		root.style.pointerEvents = 'none';
		const arrow = root.querySelector('.click-direction-target') as SVGGElement | null;
		const screenAngle = this.bearingDeg(from.lat, from.lng, to.lat, to.lng) + this.currentMapBearingDeg();
		if (arrow) {
			arrow.setAttribute('transform', `rotate(${screenAngle} ${pivot} ${pivot})`);
			this.updateArrowDistanceLabel(arrow, from, to, screenAngle);
		}
	}

	private effectiveDirectionTarget(): { lat: number; lng: number } | null {
		if ((this.directionTargetFollowsDevice || !this.directionTarget) && this.deviceLocationLatLng) {
			return this.deviceLocationLatLng;
		}
		return this.directionTarget;
	}

	private isSameSpot(a: { lat: number; lng: number }, b: { lat: number; lng: number }): boolean {
		return L.latLng(a.lat, a.lng).distanceTo(L.latLng(b.lat, b.lng)) < 2;
	}

	/**
	 * Zone de double-clic autour de la flèche verte (pointe et fin de tige), en pixels écran.
	 * La flèche fait 72 px depuis son point de départ, le texte de distance est sur la tige.
	 */
	private directionArrowAt(point: L.Point): 'device' | 'click' | null {
		const to = this.effectiveDirectionTarget();
		if (!this.map || !to) {
			return null;
		}
		const origins: Array<{ origin: 'device' | 'click'; from: { lat: number; lng: number } | null }> = [
			{ origin: 'click', from: this.clickMarker?.getLatLng() ?? null },
			{ origin: 'device', from: this.deviceLocationLatLng }
		];
		const mapBearing = this.currentMapBearingDeg();
		for (const { origin, from } of origins) {
			if (!from || this.isSameSpot(from, to)) {
				continue;
			}
			const base = this.map.latLngToContainerPoint([from.lat, from.lng]);
			const angle = (this.bearingDeg(from.lat, from.lng, to.lat, to.lng) + mapBearing) * Math.PI / 180;
			const ux = Math.sin(angle);
			const uy = -Math.cos(angle);
			const dx = point.x - base.x;
			const dy = point.y - base.y;
			const along = dx * ux + dy * uy;
			const across = Math.abs(dx * uy - dy * ux);
			if (along >= 30 && along <= 84 && across <= 18) {
				return origin;
			}
		}
		return null;
	}

	/**
	 * Va à la cible de la flèche. La flèche pointe ensuite vers la position GPS (rond rouge),
	 * ou vers le point de départ si la position n’est pas connue.
	 */
	private jumpAlongDirection(origin: 'device' | 'click'): void {
		const to = this.effectiveDirectionTarget();
		const from = origin === 'device' ? this.deviceLocationLatLng : this.clickMarker?.getLatLng() ?? null;
		if (!this.map || !to || !from) {
			return;
		}
		const device = this.deviceLocationLatLng ? { ...this.deviceLocationLatLng } : null;
		const followingDevice = this.directionTargetFollowsDevice || !this.directionTarget;
		if (this.followDeviceLocation) {
			this.followDeviceLocation = false;
			this.onFollowDeviceLocationChange();
			if (device) {
				this.updateDeviceLocationMarker(device.lat, device.lng);
			}
		}
		const backTo = device && !followingDevice ? device : from;
		this.directionTargetFollowsDevice = !!device && !followingDevice;
		this.directionTarget = {
			lat: backTo.lat,
			lng: backTo.lng,
			label: `${backTo.lat.toFixed(6)}, ${backTo.lng.toFixed(6)}`
		};
		this.map.panTo([to.lat, to.lng]);
		this.createClickMarker(to.lat, to.lng);
		this.updateSwitchesForPoint(to.lat, to.lng);
		this.syncDeviceLocationArrows();
		this.cdr.markForCheck();
	}

	private removeClickDirectionMarker(): void {
		if (!this.clickDirectionMarker) {
			return;
		}
		try {
			this.clickDirectionMarker.remove();
		} catch {
			/* ignore */
		}
		this.clickDirectionMarker = undefined;
	}

	/** Rond bleu sur la cible de direction (pas quand la flèche vise la position GPS). */
	private syncDirectionTargetMarker(): void {
		const target = this.directionTargetFollowsDevice ? null : this.directionTarget;
		if (!this.map || !target) {
			this.removeDirectionTargetMarker();
			return;
		}
		if (this.directionTargetMarker) {
			this.directionTargetMarker.setLatLng([target.lat, target.lng]);
			return;
		}
		this.directionTargetMarker = L.marker([target.lat, target.lng], {
			icon: L.divIcon({
				className: 'direction-target-marker',
				html: '<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg" style="display:block;cursor:pointer;">' +
					'<circle cx="11" cy="11" r="8" fill="#1d4ed8" stroke="#ffffff" stroke-width="2.5"/></svg>',
				iconSize: [22, 22],
				iconAnchor: [11, 11]
			}),
			keyboard: false,
			zIndexOffset: 2900
		}).addTo(this.map);
		const el = this.directionTargetMarker.getElement();
		if (el) {
			el.style.background = 'transparent';
			el.style.border = 'none';
		}
		this.directionTargetMarker.on('click', (e: L.LeafletMouseEvent) => {
			L.DomEvent.stopPropagation(e);
			this.clearDirectionTarget();
		});
	}

	private removeDirectionTargetMarker(): void {
		if (!this.directionTargetMarker) {
			return;
		}
		try {
			this.directionTargetMarker.remove();
		} catch {
			/* ignore */
		}
		this.directionTargetMarker = undefined;
	}

	private bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
		const phi1 = lat1 * Math.PI / 180;
		const phi2 = lat2 * Math.PI / 180;
		const dLon = (lng2 - lng1) * Math.PI / 180;
		const y = Math.sin(dLon) * Math.cos(phi2);
		const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
		return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
	}

	private currentMapBearingDeg(): number {
		const map = this.map as RotatableLeafletMap | undefined;
		if (map && typeof map.getBearing === 'function') {
			const bearing = map.getBearing();
			if (typeof bearing === 'number' && Number.isFinite(bearing)) {
				return ((bearing % 360) + 360) % 360;
			}
		}
		return 0;
	}

	/**
	 * Rosace haut-centre : la pointe rouge reste sur le nord géographique.
	 * En 2D (leaflet-rotate), le pane carte est tourné de `bearing` dans le sens
	 * horaire, donc le nord apparaît à l’écran avec ce même angle.
	 * En 3D (MapLibre), `bearing` est le cap affiché en haut de l’écran : le nord
	 * se trouve donc à l’angle opposé.
	 */
	private updateCompassRose(): void {
		this.updateAxisGizmo();
		const refEl = this.mapEmbedHostRoot ? undefined : this.compassRoseDialRef?.nativeElement;
		const dial = refEl?.isConnected ? refEl : this.findCompassRoseDial();
		if (!dial) {
			return;
		}
		const northAngle = this.relief3d ? -this.reliefBearing : this.currentMapBearingDeg();
		dial.style.transform = `rotate(${northAngle.toFixed(1)}deg)`;
	}

	/**
	 * Repère bas-droite. X rouge = nord, Y vert = ouest, Z bleu = haut.
	 * Le cap MapLibre est la direction en haut de l’écran ; le pitch 0 regarde à la verticale.
	 */
	private updateAxisGizmo(zAngle = this.reliefZAngle): void {
		const gizmo = this.findAxisGizmoHost();
		if (!gizmo) {
			return;
		}
		const heading = this.mapHeadingLabel();
		const headingEl = gizmo.querySelector('.trace-viewer-axis-heading');
		if (headingEl) {
			headingEl.textContent = heading;
		}
		if (!this.relief3d) {
			gizmo.setAttribute('aria-label', `2D, ${heading}`);
			return;
		}
		gizmo.setAttribute('aria-label', `X Y Z ${zAngle}°, ${heading}`);
		const svg = gizmo.querySelector('svg');
		if (!svg) {
			return;
		}
		const bearing = this.reliefBearing * Math.PI / 180;
		const pitch = (90 - zAngle) * Math.PI / 180;
		const cosB = Math.cos(bearing);
		const sinB = Math.sin(bearing);
		const cosP = Math.cos(pitch);
		const sinP = Math.sin(pitch);
		const cx = 40;
		const cy = 40;
		const len = 20;
		const axes = [
			{ id: 'x', e: 0, n: 1, u: 0 },
			{ id: 'y', e: -1, n: 0, u: 0 },
			{ id: 'z', e: 0, n: 0, u: 1 }
		].map((axis) => {
			const right = axis.e * cosB - axis.n * sinB;
			const forward = axis.e * sinB + axis.n * cosB;
			const screenX = right;
			const screenY = cosP * forward + sinP * axis.u;
			const depth = cosP * axis.u - sinP * forward;
			return { id: axis.id, screenX, screenY, depth };
		}).sort((a, b) => a.depth - b.depth);
		for (const axis of axes) {
			const group = svg.querySelector(`[data-axis="${axis.id}"]`);
			if (!group) {
				continue;
			}
			svg.appendChild(group);
			const line = group.querySelector('line');
			const tip = group.querySelector('circle');
			const label = group.querySelector('text:not(.axis-angle)');
			const x2 = cx + axis.screenX * len;
			const y2 = cy - axis.screenY * len;
			const span = Math.hypot(axis.screenX, axis.screenY);
			line?.setAttribute('x2', x2.toFixed(2));
			line?.setAttribute('y2', y2.toFixed(2));
			if (tip) {
				tip.setAttribute('cx', x2.toFixed(2));
				tip.setAttribute('cy', y2.toFixed(2));
				tip.setAttribute('r', span < 0.22 ? '3.4' : '2.3');
			}
			if (label) {
				const labelX = span < 0.22 ? cx + 9 : cx + axis.screenX * (len + 9);
				const labelY = span < 0.22 ? cy - 8 : cy - axis.screenY * (len + 9) + 4;
				label.setAttribute('x', labelX.toFixed(2));
				label.setAttribute('y', labelY.toFixed(2));
				const angleLabel = group.querySelector('.axis-angle');
				if (angleLabel) {
					angleLabel.textContent = `${zAngle}°`;
					angleLabel.setAttribute('x', (labelX + 7).toFixed(2));
					angleLabel.setAttribute('y', labelY.toFixed(2));
				}
			}
			group.setAttribute('opacity', '1');
		}
	}

	private mapHeadingLabel(): string {
		const raw = this.relief3d ? this.reliefBearing : -this.currentMapBearingDeg();
		const deg = Number.isFinite(raw) ? Math.round(this.wrapDeg(raw)) % 360 : 0;
		return `${deg}° ${this.cardinalLabel(deg)}`;
	}

	private findAxisGizmoHost(): HTMLElement | null {
		const wrapper = this.resolveMapContainerElement()?.closest('.map-wrapper');
		return (wrapper?.querySelector('.trace-viewer-axis-gizmo') as HTMLElement | null) ?? null;
	}

	private findCompassRoseDial(): SVGSVGElement | null {
		const wrapper = this.resolveMapContainerElement()?.closest('.map-wrapper');
		return (wrapper?.querySelector('.trace-viewer-compass-rose-dial') as SVGSVGElement | null) ?? null;
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
		this.deviceLocationLatLng = null;
		this.terrainView?.setGps(null);
		this.syncClickDirectionArrow();
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
				const zoom = this.visibleLeafletZoom();
				this.map.setView([lat, lng], zoom, { animate: false });
				this.terrainView?.jumpTo(lat, lng, zoom);
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
		this.removeClickMarker();

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

		this.clickMarker = L.marker([lat, lng], {
			icon: markerIcon,
			zIndexOffset: 1000,
			riseOnHover: true,
			riseOffset: 250
		});

		// Un clic sur la cible l’enlève, ainsi que la cible de direction.
		this.clickMarker.on('click', (e: L.LeafletMouseEvent) => {
			L.DomEvent.stopPropagation(e);
			if (e.originalEvent) {
				L.DomEvent.preventDefault(e.originalEvent);
			}
			this.removeClickMarker();
			this.clearDirectionTarget();
		});

		this.clickMarker.addTo(this.map!);
		this.syncClickDirectionArrow();
	}

	private removeClickMarker(): void {
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
		this.removeClickDirectionMarker();
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
		this.removeClickDirectionMarker();
	}

	private closeModalInstance(): void {
		this.closeGpxStatsModal();
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
				if (this.gpxStatsModalRef) {
					this.closeGpxStatsModal();
					return;
				}
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
		if (this.pairEditMode) {
			this.pairSelected.emit(this.snapshotPair());
		} else if (this.finalSelectedCoordinates) {
			const alt =
				this.isFiniteAltitude(this.clickedAlt)
					? this.clickedAlt
					: this.isFiniteAltitude(this.currentAlt)
						? this.currentAlt
						: this.finalSelectedCoordinates.alt ?? null;
			this.locationSelected.emit({
				lat: this.finalSelectedCoordinates.lat,
				lng: this.finalSelectedCoordinates.lng,
				alt
			});
			this.finalSelectedCoordinates = undefined;
		}

		this.modalRef = undefined;
		if (!this.hasEmittedClosed) {
			this.hasEmittedClosed = true;
			this.closed.emit();
		}
	}

	/** Paint the open map viewer with the skin variables of a page host. */
	public applyHostSkin(source: HTMLElement): void {
		const paint = (attempt = 0): void => {
			const modal = this.findTraceViewerModalContent();
			if (!modal) {
				if (attempt < 8) {
					setTimeout(() => paint(attempt + 1), 60);
				}
				return;
			}
			paintModalFromHost(modal, source, 'trace-viewer-skin');
		};
		paint();
	}

	private findTraceViewerModalContent(): HTMLElement | null {
		return document.querySelector('.modal.show .modal-content:has(.trace-viewer-body)');
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
		this.scheduleTraceViewerCdr();
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
		this.scheduleTraceViewerCdr();
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
			const arrowOrigin = this.directionArrowAt(e.containerPoint);
			if (arrowOrigin) {
				this.jumpAlongDirection(arrowOrigin);
				return;
			}
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
				this.scheduleTraceViewerCdr();

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
			this.resetWeatherOverlayDismissed();

			let lat: number | null = null;
			let lng: number | null = null;
			let alt: number | null = null;

			// Priority 1: Use lastRenderedPosition (most recent point from trace/positions)
			if (this.lastRenderedPosition) {
				lat = this.lastRenderedPosition.lat;
				lng = this.lastRenderedPosition.lng;
				alt = this.currentAlt;
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
				this.clickedWeatherLat = lat;
				this.clickedWeatherLng = lng;
				this.syncWeatherTimelineRegion();
				if (alt != null) {
					this.clickedWeatherAlt = alt;
				}
				if (!this.clickedWeatherAddress && !this.weatherLocationName) {
					this.getAddressFromCoordinatesForWeather(lat, lng);
				}
				if (this.clickedWeatherAlt == null) {
					this.fetchAltitudeForCoordinates(lat, lng, 'clicked');
				}
				setTimeout(() => {
					this.fetchWeather(lat!, lng!, this.clickedWeatherAlt);
				}, 100);
			}
		} else {
			this.applyWeatherRadarOverlay();
			this.clearWeatherPointComparison();
			this.weatherOverlayDismissed = false;
		}
		this.persistTraceViewerPreferences();
	}

	get hasWeatherPointData(): boolean {
		return this.weatherPointMfTempC != null
			|| this.weatherPointMsTempC != null
			|| this.weatherPointOpenMeteoTempC != null
			|| this.weatherPointOpenWeatherTempC != null;
	}

	get showWeatherPointOverlay(): boolean {
		return this.showWeather
			&& !this.weatherOverlayDismissed
			&& (this.hasWeatherPointData || this.isLoadingWeather);
	}

	public clearWeatherOverlay(): void {
		this.closeWeatherTimeline();
		this.weatherOverlayDismissed = true;
		this.scheduleTraceViewerCdr();
	}

	private resetWeatherOverlayDismissed(): void {
		this.weatherOverlayDismissed = false;
	}

	private weatherPointCoordsKey(lat: number, lng: number): string {
		return `${lat.toFixed(4)},${lng.toFixed(4)}`;
	}

	private isSameStoredWeatherPoint(lat: number, lng: number): boolean {
		return Number.isFinite(this.clickedWeatherLat)
			&& Number.isFinite(this.clickedWeatherLng)
			&& this.weatherPointCoordsKey(this.clickedWeatherLat, this.clickedWeatherLng)
				=== this.weatherPointCoordsKey(lat, lng);
	}

	private applyWeatherPointMfFallbackFromGrid(lat: number, lng: number): void {
		if (!this.isWeatherLocationInFrance() || this.weatherPointMfTempC != null) {
			return;
		}
		const nearest = this.weatherStationMapLayer.findNearestGridPoint(lat, lng);
		if (!nearest?.tempC || !Number.isFinite(nearest.tempC)) {
			return;
		}
		const labelSource = this.weatherStationMapLayer.getLabelSource();
		if (resolveWeatherStationPointBrand(nearest, labelSource) !== 'meteofrance') {
			return;
		}
		this.weatherPointMfTempC = nearest.tempC;
		if (nearest.stationId || nearest.stationName) {
			this.weatherPointMfStationId = nearest.stationId != null ? String(nearest.stationId) : '';
			this.weatherPointMfStationName = nearest.stationName != null ? String(nearest.stationName).trim() : '';
		}
		if (nearest.observedAt) {
			this.weatherPointMfObservedAt = String(nearest.observedAt);
		}
		this.weatherPointMfStationDistKm = resolveMfStationDistanceKm(
			lat,
			lng,
			nearest,
			this.weatherPointMfStationId,
			this.weatherStationMapLayer.getGridPoints(),
			(clat, clon) => this.weatherStationMapLayer.findNearestGridPoint(clat, clon)
		);
	}

	private applyWeatherPointMsFallbackFromGrid(lat: number, lng: number): void {
		if (!this.isWeatherLocationInSwitzerland() || this.weatherPointMsTempC != null) {
			return;
		}
		const nearest = this.weatherStationMapLayer.findNearestGridPoint(lat, lng);
		if (!nearest?.tempC || !Number.isFinite(nearest.tempC)) {
			return;
		}
		const labelSource = this.weatherStationMapLayer.getLabelSource();
		if (resolveWeatherStationPointBrand(nearest, labelSource) !== 'meteoswiss') {
			return;
		}
		this.weatherPointMsTempC = nearest.tempC;
		if (nearest.stationId || nearest.stationName) {
			this.weatherPointMsStationId = nearest.stationId != null ? String(nearest.stationId) : '';
			this.weatherPointMsStationName = nearest.stationName != null ? String(nearest.stationName).trim() : '';
		}
		if (nearest.observedAt) {
			this.weatherPointMsObservedAt = String(nearest.observedAt);
		}
		this.weatherPointMsStationDistKm = resolveMfStationDistanceKm(
			lat,
			lng,
			nearest,
			this.weatherPointMsStationId,
			this.weatherStationMapLayer.getGridPoints(),
			(clat, clon) => this.weatherStationMapLayer.findNearestGridPoint(clat, clon)
		);
	}

	private syncWeatherPointFromStationGrid(): void {
		if (!Number.isFinite(this.clickedWeatherLat) || !Number.isFinite(this.clickedWeatherLng)) {
			return;
		}
		this.applyWeatherPointMfFallbackFromGrid(this.clickedWeatherLat, this.clickedWeatherLng);
		this.applyWeatherPointMsFallbackFromGrid(this.clickedWeatherLat, this.clickedWeatherLng);
	}

	public canShowWeatherTimelineButton(): boolean {
		return (this.isWeatherPointInFrance() || this.isWeatherPointInSwitzerland())
			&& Number.isFinite(this.clickedWeatherLat)
			&& Number.isFinite(this.clickedWeatherLng);
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
		return this.isCoordinateInFranceForMfObs(this.clickedWeatherLat, this.clickedWeatherLng);
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
		return this.isCoordinateInSwitzerland(this.clickedWeatherLat, this.clickedWeatherLng);
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
	private fetchWeather(
		lat: number,
		lng: number,
		alt: number | null = null,
		showLoading: boolean = true
	): void {
		if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
			return;
		}

		if (showLoading) {
			this.setWeatherLoadingState(true);
		}
		this.closeWeatherTimeline();
		this.resetWeatherOverlayDismissed();
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
			this.applyWeatherPointMfFallbackFromGrid(lat, lng);
			this.applyWeatherPointMsFallbackFromGrid(lat, lng);
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
					this.weatherPointMfStationDistKm = resolveMfStationDistanceKm(
						lat,
						lng,
						mfPoint,
						stationId,
						this.weatherStationMapLayer.getGridPoints(),
						(clat, clon) => this.weatherStationMapLayer.findNearestGridPoint(clat, clon)
					);
				}
				this.applyWeatherPointMfFallbackFromGrid(lat, lng);
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
					this.weatherPointMsStationDistKm = resolveMfStationDistanceKm(
						lat,
						lng,
						msPoint,
						stationId,
						this.weatherStationMapLayer.getGridPoints(),
						(clat, clon) => this.weatherStationMapLayer.findNearestGridPoint(clat, clon)
					);
				}
				this.applyWeatherPointMsFallbackFromGrid(lat, lng);
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
				this.refreshWeatherPointWeatherLocationLabel();
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

		this.apiService.postWeatherTemperatureLabels([{ lat, lon: lng }], 'open-meteo', true).pipe(take(1)).subscribe({
			next: applyOpenMeteoResponse,
			error: () => markWeatherSourceDone(() => { openMeteoDone = true; })
		});

		if (this.isWeatherLocationInFrance()) {
			const nearestGrid = this.weatherStationMapLayer.findNearestGridPoint(lat, lng);
			const mfTarget: { lat: number; lon: number; stationId?: string } = { lat, lon: lng };
			const labelSource = this.weatherStationMapLayer.getLabelSource();
			if (nearestGrid?.stationId && resolveWeatherStationPointBrand(nearestGrid, labelSource) === 'meteofrance') {
				mfTarget.stationId = nearestGrid.stationId;
			}
			this.apiService.postWeatherTemperatureLabels([mfTarget], 'meteofrance', true).pipe(take(1)).subscribe({
				next: applyMfResponse,
				error: () => markWeatherSourceDone(() => {
					this.applyWeatherPointMfFallbackFromGrid(lat, lng);
					mfDone = true;
				})
			});
		} else {
			mfDone = true;
		}

		if (this.isWeatherLocationInSwitzerland()) {
			const nearestGrid = this.weatherStationMapLayer.findNearestGridPoint(lat, lng);
			const msTarget: { lat: number; lon: number; stationId?: string } = { lat, lon: lng };
			const labelSource = this.weatherStationMapLayer.getLabelSource();
			if (nearestGrid?.stationId && resolveWeatherStationPointBrand(nearestGrid, labelSource) === 'meteoswiss') {
				msTarget.stationId = nearestGrid.stationId;
			}
			this.apiService.postWeatherTemperatureLabels([msTarget], 'meteoswiss', true).pipe(take(1)).subscribe({
				next: applyMsResponse,
				error: () => markWeatherSourceDone(() => {
					this.applyWeatherPointMsFallbackFromGrid(lat, lng);
					msDone = true;
				})
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
		this.refreshWeatherPointWeatherLocationLabel();
		this.syncWeatherTimelineRegion();
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
		this.refreshWeatherPointWeatherLocationLabel();
		this.syncWeatherTimelineRegion();
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
						this.refreshWeatherPointWeatherLocationLabel();
						this.syncWeatherTimelineRegion();
						if (this.stationSelectionLat === lat && this.stationSelectionLng === lng) {
							this.stationSelectionCountryCode = countryCode;
							this.refreshWeatherStationsForSelection();
							this.syncShowWeatherStationsHintKey();
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
						this.refreshWeatherPointWeatherLocationLabel();
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
		const weatherSamePoint = this.isSameStoredWeatherPoint(lat, lng);
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
			const samePoint = weatherSamePoint;
			this.clickedWeatherLat = lat;
			this.clickedWeatherLng = lng;
			if (!samePoint) {
				this.clickedWeatherAlt = null;
				this.clickedWeatherAddress = '';
				this.clickedWeatherCountryCode = '';
				this.weatherLocationName = '';
				this.weatherCity = '';
				this.weatherPointPlaceName = '';
			}
			this.refreshWeatherPointWeatherLocationLabel();
			this.syncWeatherTimelineRegion();
			this.resetWeatherOverlayDismissed();
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

		// Fetch weather if switch is enabled (always refresh — latest observations for every source)
		if (this.showWeather) {
			setTimeout(() => {
				this.fetchWeather(lat, lng, this.clickedWeatherAlt, true);
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
		const generation = ++this.altitudeFetchGeneration;
		this.apiService.getAllAltitudes(lat, lng, null).pipe(take(1), takeUntil(this.destroy$)).subscribe({
			next: (response) => {
				if (generation !== this.altitudeFetchGeneration) {
					return;
				}
				if (response.altitudes && Array.isArray(response.altitudes) && response.altitudes.length > 0) {
					// Use the first altitude (highest priority)
					const altitude = response.altitudes[0].altitude;
					const finiteAlt = typeof altitude === 'number' && Number.isFinite(altitude) ? altitude : null;
					// Next tick: *ngIf="isFiniteAltitude(...)" must not flip false→true in the same CD (NG0100).
					this.deferWeatherUiUpdate(() => {
						if (type === 'current') {
							this.currentAlt = finiteAlt;
						} else {
							this.clickedAlt = finiteAlt;
							this.clickedWeatherAlt = finiteAlt;
							if (this.finalSelectedCoordinates) {
								this.finalSelectedCoordinates = {
									...this.finalSelectedCoordinates,
									alt: finiteAlt
								};
							}
						}
					});
				}
			},
			error: (error) => {
				if (generation !== this.altitudeFetchGeneration) {
					return;
				}
				console.debug('Could not fetch altitude:', error);
				this.deferWeatherUiUpdate(() => {
					if (type === 'current') {
						this.currentAlt = null;
					} else {
						this.clickedAlt = null;
					}
				});
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

