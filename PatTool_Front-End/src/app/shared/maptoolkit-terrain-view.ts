import { LngLat, Map as MlMap, MercatorCoordinate, NavigationControl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import { ensureMaplibreWorker, ignoreMissingStyleIcons } from './maptoolkit-basemap.layer';
import type { WeatherStationReliefLabel } from './weather-station-map.util';

/** DEM already declared in the Maptoolkit styles, used by their hillshade. */
const TERRAIN_SOURCE = 'rgb-tiles';
/** Separate copy: MapLibre warns and renders worse when hillshade and terrain share one source. */
const TERRAIN_MESH_SOURCE = 'relief-terrain';
const TERRAIN_TILEJSON = 'https://tiles.maptoolkit.org/terrainrgb.json';
/**
 * Mapterhorn publishes land tiles through zoom 17. The TileJSON omits maxzoom,
 * so MapLibre defaults to 22 and zoom 18+ comes back 404.
 */
const TERRAIN_DATA_MAX_ZOOM = 17;
/**
 * Maptoolkit vector tiles stop at 15. Past that, MapLibre drapes overscaled tiles
 * and cannot sample a DEM with a higher maxzoom: it warns
 * "cannot calculate elevation if elevation maxzoom > source.maxzoom"
 * and the elevation matrix is wrong. Hillshade may still use zoom 17.
 */
const TERRAIN_MESH_MAX_ZOOM = 15;
const TERRAIN_EXAGGERATION = 1.3;
/** Finger and mouse tilt. The phone can go past this, toward the sky. */
const MAX_PITCH = 85;
/** MapLibre accepts up to 180°. 90 is the horizon, above that the view looks at the sky. */
const SKY_PITCH = 180;
const MAX_ZOOM = 20;
/** Meters kept between the camera and the slope in front of it. */
const RELIEF_CLEARANCE_M = 35;
const TRACE_SOURCE = 'relief-traces';
/** Waymarked Trails rasters, bottom to top. Slopes sit under the route lines. */
const TRAIL_RASTERS: { key: keyof ReliefTrailOverlays; id: string; tiles: string }[] = [
	{ key: 'slopes', id: 'relief-slopes', tiles: 'https://tile.waymarkedtrails.org/slopes/{z}/{x}/{y}.png' },
	{ key: 'hiking', id: 'relief-hiking-trails', tiles: 'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png' },
	{ key: 'cycling', id: 'relief-cycling-trails', tiles: 'https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png' },
	{ key: 'mtb', id: 'relief-mtb-trails', tiles: 'https://tile.waymarkedtrails.org/mtb/{z}/{x}/{y}.png' },
	{ key: 'railway', id: 'relief-railway', tiles: 'https://a.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png' }
];
const ELEVATION_COLOR_LAYER = 'relief-elevation-colors';
/** Du violet (bas) au rouge (haut). */
const ELEVATION_RAINBOW = ['#5b2cff', '#245bff', '#00b4ff', '#2ecc71', '#f1c40f', '#e67e22', '#e10600'];

export interface ReliefTrailOverlays {
	hiking: boolean;
	cycling: boolean;
	mtb: boolean;
	railway: boolean;
	slopes: boolean;
}

/** Point OSM (monument, lieu, aéroport) dessiné au-dessus des deux cartes. */
export interface ReliefPlaceMark {
	lat: number;
	lng: number;
	name: string;
	kind: 'historic' | 'sight' | 'airport';
}

export interface ReliefViewHooks {
	onZoom?: (zoom: number) => void;
	onBearing?: (bearing: number) => void;
	onPitch?: (pitch: number) => void;
	/** The camera finished a pan, zoom or tilt. Used to reload overlays for the ground in view. */
	onMoveEnd?: () => void;
	/** Min/max altitude used by the rainbow tint, or null when the tint is off. */
	onElevationRange?: (range: { min: number; max: number } | null) => void;
	/** The pitched view has terrain and a stable camera. Safe to cover the flat map. */
	onReady?: () => void;
}

export interface ReliefTrace {
	color: string;
	/** [lat, lng] or [lat, lng, alt]. Leaflet tuples may mark altitude as optional. */
	points: Array<readonly (number | undefined)[]>;
	startColor: string;
	endColor: string;
}

type ReliefFeatureCollection = {
	type: 'FeatureCollection';
	features: Array<{
		type: 'Feature';
		properties: { color: string };
		geometry:
			| { type: 'LineString'; coordinates: number[][] }
			| { type: 'Point'; coordinates: number[] };
	}>;
};

const EMPTY: ReliefFeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * MapLibre map with Maptoolkit terrain, drawn over the flat Leaflet view.
 * The trace and the GPS dot are layers of this map so they sit on the relief.
 */
export class MaptoolkitTerrainView {
	private map: MlMap | null = null;
	private host: HTMLElement | null = null;
	private baseHost: HTMLDivElement | null = null;
	private blendMap: MlMap | null = null;
	private blendHost: HTMLDivElement | null = null;
	private blendStyle: string | null = null;
	private blendEpoch = 0;
	/** Opacité demandée par le curseur. Reste à 0 tant que le relief de la 2e carte n’est pas calé. */
	private blendOpacity = 0;
	private blendReady = false;
	private resizeObserver: ResizeObserver | null = null;
	private hooks: ReliefViewHooks | null = null;
	/** Style currently requested, so the same URL is not reloaded on every slider tick. */
	private activeStyle: string | null = null;
	/** Bumps when the style is replaced so a late load cannot restyle the previous map. */
	private styleEpoch = 0;
	private controlsAdded = false;
	private traces: ReliefTrace[] = [];
	private gps: { lat: number; lng: number } | null = null;
	private markerOverlay: HTMLDivElement | null = null;
	private gpsMarker: HTMLDivElement | null = null;
	/** Repère du lieu choisi (centrage), distinct du point GPS. */
	private pin: { lat: number; lng: number } | null = null;
	private pinMarker: HTMLDivElement | null = null;
	private places: ReliefPlaceMark[] = [];
	private placeNodes: HTMLDivElement[] = [];
	private stationLabels: WeatherStationReliefLabel[] = [];
	private stationNodes = new Map<string, HTMLDivElement>();
	private stationOverlay: HTMLDivElement | null = null;
	private stationClick: ((event: MouseEvent) => void) | null = null;
	private stationHover: ((key: string) => void) | null = null;
	private trailOverlays: ReliefTrailOverlays = {
		hiking: false,
		cycling: false,
		mtb: false,
		railway: false,
		slopes: false
	};
	/** Non-zero while a style.load / idle retry for that map is already waiting. */
	private overlayRetryToken = new WeakMap<MlMap, number>();
	private overlayRetrySerial = 0;
	private overlayRetryFailures = new WeakMap<MlMap, number>();
	private elevationColors = false;
	private elevationTimer: number | null = null;
	private elevationTries = 0;
	private fitRequested = false;
	/** Center waiting for a terrain sample so the camera looks at the ground, not sea level. */
	private pendingGround: { lng: number; lat: number } | null = null;
	/** Camera requested at the 2D → 3D switch, reapplied once the style and the terrain exist. */
	private openingView: { lng: number; lat: number; zoom: number; bearing: number; pitch: number } | null = null;
	/**
	 * While a programmatic jump is running, MapLibre must not change zoom, center or bearing
	 * to climb out of the terrain. Pitch stays the one asked for.
	 */
	private holdView: { lng: number; lat: number; zoom: number; bearing: number; pitch: number; elevation?: number } | null = null;
	/** Terrain and the ground elevation are in place. Until then the canvas stays invisible. */
	private revealed = false;
	private revealTimer: number | null = null;
	private releaseRotate: (() => void) | null = null;
	private releaseTouch: (() => void) | null = null;
	/** Pinch zoom must not be pulled back by the slope guard mid-gesture. */
	private freeZoom = false;
	/** A finger is down: compass and phone-tilt must not jump the camera. */
	private gesturing = false;
	private touchBearingLocked = false;
	private touchPitchLocked = false;

	mount(
		host: HTMLElement,
		styleUrl: string,
		view: { lng: number; lat: number; zoom: number; pitch: number; bearing?: number },
		hooks?: ReliefViewHooks
	): void {
		this.destroy();
		ensureMaplibreWorker();
		this.host = host;
		this.hooks = hooks ?? null;
		this.activeStyle = styleUrl;
		const base = document.createElement('div');
		base.className = 'trace-relief3d-base';
		base.style.position = 'absolute';
		base.style.inset = '0';
		base.style.zIndex = '1';
		base.style.opacity = '0';
		host.appendChild(base);
		this.baseHost = base;
		const openingZoom = clampZoom(view.zoom);
		const openingPitch = clampPitch(view.pitch);
		const openingBearing = Number.isFinite(view.bearing) ? view.bearing! : 0;
		this.openingView = {
			lng: view.lng,
			lat: view.lat,
			zoom: openingZoom,
			bearing: openingBearing,
			pitch: openingPitch
		};
		const map = new MlMap({
			container: base,
			style: { version: 8, sources: {}, layers: [] },
			center: [view.lng, view.lat],
			zoom: openingZoom,
			pitch: openingPitch,
			bearing: openingBearing,
			maxPitch: SKY_PITCH,
			maxZoom: MAX_ZOOM,
			/*
			 * MapLibre's dragRotate flips direction around the terrain-projected center.
			 * A ridge behind the camera sends that point to the other side of the screen,
			 * so the same drag spins the wrong way. The handler below uses the screen center.
			 */
			dragRotate: false,
			touchPitch: false,
			/* Recalage du centre au relâchement : à forte inclinaison il décale la carte. */
			centerClampedToGround: false,
			canvasContextAttributes: {
				powerPreference: 'default',
				failIfMajorPerformanceCaveat: false
			}
		});
		ignoreMissingStyleIcons(map);
		this.map = map;
		this.releaseRotate = attachScreenCenterDragRotate(map);
		/*
		 * Built-in pinch fights the slope guard and the page zoom on phones.
		 * The touch handler below owns pinch, twist and two-finger tilt.
		 */
		map.touchZoomRotate.disable();
		map.touchPitch.disable();
		this.releaseTouch = attachMobileTouchCamera(map, {
			bearingLocked: () => this.touchBearingLocked,
			pitchLocked: () => this.touchPitchLocked,
			setFreeZoom: (on) => { this.freeZoom = on; },
			setGesturing: (on) => { this.gesturing = on; }
		});
		/* Glide after release. linearity must stay non-zero or the inertia math becomes NaN. */
		map.dragPan.enable(RELIEF_DRAG_PAN);
		/*
		 * Refuse a closer zoom that would put the camera through the slope.
		 * Applied with the gesture, so the wheel stops on the terrain instead of jumping back afterwards.
		 */
		map.setTransformCameraUpdate((next) => {
			const hold = this.holdView;
			if (hold) {
				return {
					center: new LngLat(hold.lng, hold.lat),
					zoom: hold.zoom,
					bearing: hold.bearing,
					pitch: hold.pitch,
					...(hold.elevation != null && Number.isFinite(hold.elevation) ? { elevation: hold.elevation } : {})
				};
			}
			if (this.freeZoom) {
				return {};
			}
			const currentZoom = map.getZoom();
			if (!Number.isFinite(next.zoom) || next.zoom <= currentZoom + 1e-3) {
				return {};
			}
			let limit: number | null = null;
			try {
				limit = zoomAboveRelief(map, {
					lng: next.center.lng,
					lat: next.center.lat,
					pitch: next.pitch,
					bearing: next.bearing,
					elevation: next.elevation,
					zoom: next.zoom
				});
			} catch {
				return {};
			}
			if (limit == null || next.zoom <= limit + 0.02) {
				return {};
			}
			try {
				const height = map.getContainer()?.clientHeight || 0;
				const fov = map.getVerticalFieldOfView();
				if (height && Number.isFinite(fov)) {
					const distancePx = (0.5 / Math.tan((fov * Math.PI) / 360)) * height;
					const step = {
						lng: next.center.lng,
						lat: next.center.lat,
						pitch: next.pitch,
						bearing: next.bearing,
						elevation: next.elevation
					};
					const now = reliefDeficit(map, step, currentZoom, distancePx);
					const later = reliefDeficit(map, step, next.zoom, distancePx);
					if (later <= now + 22) {
						return {};
					}
				}
			} catch {
				/* keep the hard cap */
			}
			const capped = Math.min(next.zoom, Math.max(limit, currentZoom));
			if (capped >= next.zoom - 0.02) {
				return {};
			}
			return { zoom: capped };
		});
		const epoch = this.styleEpoch;
		const boot = (): void => {
			if (this.map !== map || epoch !== this.styleEpoch) {
				return;
			}
			if (Object.keys(map.getStyle()?.sources ?? {}).length === 0) {
				return;
			}
			this.applyStyleExtras(map);
		};
		map.setStyle(styleUrl, { diff: false, transformStyle: styleWithoutCamera });
		map.on('style.load', boot);
		map.on('moveend', () => {
			if (this.map !== map) {
				return;
			}
			this.hooks?.onZoom?.(map.getZoom());
			this.layoutWeatherStations();
			this.layoutReliefMarkers();
			this.hooks?.onMoveEnd?.();
			this.scheduleElevationColors();
		});
		map.on('rotate', () => {
			if (this.map !== map) {
				return;
			}
			this.hooks?.onBearing?.(map.getBearing());
		});
		map.on('pitch', () => {
			if (this.map !== map) {
				return;
			}
			this.hooks?.onPitch?.(map.getPitch());
		});
		map.on('move', () => {
			if (this.map !== map) {
				return;
			}
			this.syncBlendCamera();
			this.layoutWeatherStations();
			this.layoutReliefMarkers();
		});
		map.on('idle', () => {
			if (this.map !== map) {
				return;
			}
			const waitingForGround = this.pendingGround != null;
			this.flushPendingGround();
			this.layoutWeatherStations();
			this.layoutReliefMarkers();
			if (this.elevationColors && this.map && !this.map.getLayer(ELEVATION_COLOR_LAYER)) {
				this.refreshElevationColors();
			}
			if (this.trailsMissing(map) && (this.overlayRetryFailures.get(map) ?? 0) <= 8) {
				this.applyTrailOverlays(map);
			}
			if (this.revealed || !map.isStyleLoaded() || !map.getTerrain()) {
				return;
			}
			if (this.pendingGround) {
				return;
			}
			if (waitingForGround) {
				map.once('idle', () => this.revealBase());
				return;
			}
			this.revealBase();
		});
		if (typeof ResizeObserver !== 'undefined') {
			this.resizeObserver = new ResizeObserver(() => {
				if (this.map === map) {
					map.resize();
					this.blendMap?.resize();
				}
			});
			this.resizeObserver.observe(host);
		}
		requestAnimationFrame(() => {
			if (this.map === map) {
				map.resize();
			}
		});
		this.revealTimer = window.setTimeout(() => this.revealBase(), 1600);
	}

	/** Swap the Maptoolkit style without resetting center, zoom, bearing or pitch. */
	setStyle(styleUrl: string): void {
		const map = this.map;
		if (!map || this.activeStyle === styleUrl) {
			return;
		}
		const center = map.getCenter();
		this.openingView = {
			lng: center.lng,
			lat: center.lat,
			zoom: map.getZoom(),
			bearing: map.getBearing(),
			pitch: map.getPitch()
		};
		this.activeStyle = styleUrl;
		const epoch = ++this.styleEpoch;
		map.setStyle(styleUrl, { diff: false, transformStyle: styleWithoutCamera });
		map.once('style.load', () => {
			if (this.map !== map || epoch !== this.styleEpoch) {
				return;
			}
			this.applyStyleExtras(map);
		});
	}

	/**
	 * Second Maptoolkit style drawn over the first.
	 * `opacity` 0 hides it, 1 covers the first map. The camera stays locked to the first.
	 */
	setBlend(styleUrl: string | null, opacity: number): void {
		const next = Math.max(0, Math.min(1, opacity));
		if (!styleUrl || !this.map || !this.host) {
			this.destroyBlend();
			return;
		}
		this.blendOpacity = next;
		if (this.blendMap && this.blendStyle === styleUrl) {
			this.applyBlendOpacity();
			this.syncBlendCamera();
			if (this.trailsMissing(this.blendMap) && (this.overlayRetryFailures.get(this.blendMap) ?? 0) <= 8) {
				this.paintBlendOverlays(this.blendMap);
			}
			return;
		}
		this.destroyBlend();
		this.blendStyle = styleUrl;
		this.blendOpacity = next;
		this.createBlendMap(styleUrl);
	}

	setPitch(pitch: number): void {
		const map = this.map;
		if (!map) {
			return;
		}
		const center = map.getCenter();
		this.jumpLocked({
			lng: center.lng,
			lat: center.lat,
			zoom: map.getZoom(),
			pitch: clampPitch(pitch, SKY_PITCH),
			bearing: map.getBearing(),
			elevation: map.getCenterElevation()
		});
	}

	/**
	 * MapLibre bearing: the compass direction at the top of the screen.
	 * `pitch`, when set, is applied in the same camera jump (phone tilt + north).
	 */
	setBearing(bearing: number, pitch?: number): void {
		const map = this.map;
		if (!map || !Number.isFinite(bearing)) {
			return;
		}
		const current = map.getBearing();
		let delta = bearing - current;
		delta = ((delta + 540) % 360) - 180;
		const nextPitch = pitch != null && Number.isFinite(pitch) ? clampPitch(pitch, SKY_PITCH) : map.getPitch();
		const pitchDelta = Math.abs(nextPitch - map.getPitch());
		if (Math.abs(delta) < 0.35 && pitchDelta < 0.4) {
			return;
		}
		const center = map.getCenter();
		this.jumpLocked({
			lng: center.lng,
			lat: center.lat,
			zoom: map.getZoom(),
			pitch: nextPitch,
			bearing: Math.abs(delta) < 0.35 ? current : bearing,
			elevation: map.getCenterElevation()
		});
	}

	setTraces(traces: ReliefTrace[]): void {
		this.traces = traces;
		this.applyTraces();
	}

	setGps(point: { lat: number; lng: number } | null): void {
		this.gps = point;
		this.applyGps();
	}

	/** Repère rouge du lieu sur lequel la carte vient d’être centrée. */
	setPin(point: { lat: number; lng: number } | null): void {
		this.pin = point && Number.isFinite(point.lat) && Number.isFinite(point.lng) ? point : null;
		this.applyPin();
	}

	/**
	 * Temperature labels for the weather-station switch.
	 * Drawn above both relief maps so a second 3D basemap does not cover them.
	 */
	setWeatherStations(
		labels: WeatherStationReliefLabel[],
		onAction?: (event: MouseEvent) => void,
		onHover?: (key: string) => void
	): void {
		this.stationLabels = labels;
		this.stationClick = onAction ?? null;
		this.stationHover = onHover ?? null;
		this.syncWeatherStationNodes();
		this.layoutWeatherStations();
		requestAnimationFrame(() => this.layoutWeatherStations());
	}

	/**
	 * Geographic box of the ground on screen.
	 * A pitched camera’s full bounds run to the horizon, so only the nearby ground is kept.
	 */
	groundBounds(): { south: number; north: number; west: number; east: number } | null {
		const map = this.map;
		if (!map) {
			return null;
		}
		const canvas = map.getCanvas();
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		if (w < 2 || h < 2) {
			return null;
		}
		const center = map.getCenter();
		const metersPerPx = 156543.03392 * Math.cos((center.lat * Math.PI) / 180) / Math.pow(2, map.getZoom());
		const maxM = metersPerPx * Math.hypot(w, h) * 0.72;
		const pitch = map.getPitch();
		const top = pitch > 15 ? h * Math.min(0.72, 0.28 + pitch / 140) : 8;
		const samples: Array<[number, number]> = [
			[8, h - 8],
			[w - 8, h - 8],
			[8, top],
			[w - 8, top],
			[w / 2, h * 0.62],
			[w * 0.25, h * 0.8],
			[w * 0.75, h * 0.8]
		];
		const kept: Array<{ lat: number; lng: number }> = [];
		for (const [x, y] of samples) {
			const ll = map.unproject([x, y]);
			if (!Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) {
				continue;
			}
			if (metersBetween(center.lat, center.lng, ll.lat, ll.lng) > maxM) {
				continue;
			}
			kept.push({ lat: ll.lat, lng: ll.lng });
		}
		if (!kept.length) {
			const dLat = maxM / 111320;
			const cos = Math.cos((center.lat * Math.PI) / 180) || 1;
			const dLng = maxM / (111320 * cos);
			return {
				south: center.lat - dLat,
				north: center.lat + dLat,
				west: center.lng - dLng,
				east: center.lng + dLng
			};
		}
		let south = Infinity;
		let north = -Infinity;
		let west = Infinity;
		let east = -Infinity;
		for (const p of kept) {
			south = Math.min(south, p.lat);
			north = Math.max(north, p.lat);
			west = Math.min(west, p.lng);
			east = Math.max(east, p.lng);
		}
		const padLat = Math.max((north - south) * 0.15, maxM / 111320 * 0.35);
		const padLng = Math.max((east - west) * 0.15, maxM / (111320 * (Math.cos((center.lat * Math.PI) / 180) || 1)) * 0.35);
		return {
			south: Math.min(south, center.lat) - padLat,
			north: Math.max(north, center.lat) + padLat,
			west: Math.min(west, center.lng) - padLng,
			east: Math.max(east, center.lng) + padLng
		};
	}

	/** Frame the traces. Kept until the style has loaded. */
	fitTraces(): void {
		this.fitRequested = true;
		this.applyFit();
	}

	/**
	 * Move the pitched camera.
	 * `zoom`, when set, is the Leaflet zoom. MapLibre uses 512px tiles, so the same ground scale is one level lower.
	 */
	jumpTo(lat: number, lng: number, zoom?: number): void {
		const map = this.map;
		if (!map || !Number.isFinite(lat) || !Number.isFinite(lng)) {
			return;
		}
		const mlZoom = zoom == null ? map.getZoom() : leafletZoomToMaplibre(zoom);
		this.lookAt(lng, lat, mlZoom);
	}

	/**
	 * Frame a box in the pitched view.
	 * The camera looks at the terrain elevation, otherwise the target stays under the slope.
	 */
	fitLngLatBounds(west: number, south: number, east: number, north: number, maxZoom: number): boolean {
		const map = this.map;
		if (!map || ![west, south, east, north, maxZoom].every(Number.isFinite)) {
			return false;
		}
		const cam = map.cameraForBounds([[west, south], [east, north]], {
			padding: 24,
			maxZoom: clampZoom(maxZoom),
			pitch: map.getPitch(),
			bearing: map.getBearing()
		});
		if (!cam?.center || cam.zoom == null) {
			return false;
		}
		const center = LngLat.convert(cam.center);
		this.lookAt(center.lng, center.lat, cam.zoom);
		return true;
	}

	camera(): { lat: number; lng: number; zoom: number } | null {
		if (!this.map) {
			return null;
		}
		const center = this.map.getCenter();
		const zoom = this.map.getZoom();
		if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng) || !Number.isFinite(zoom)) {
			return null;
		}
		return { lat: center.lat, lng: center.lng, zoom };
	}

	/** Nord locks twist. Phone-tilt locks two-finger pitch. Pinch zoom stays available. */
	setTouchLocks(locks: { bearing?: boolean; pitch?: boolean }): void {
		if (locks.bearing != null) {
			this.touchBearingLocked = locks.bearing;
		}
		if (locks.pitch != null) {
			this.touchPitchLocked = locks.pitch;
		}
	}

	isUserGesturing(): boolean {
		return this.gesturing;
	}

	/** MapLibre bearing: the compass direction at the top of the screen. */
	bearing(): number | null {
		const map = this.map;
		if (!map) {
			return null;
		}
		const bearing = map.getBearing();
		return Number.isFinite(bearing) ? bearing : null;
	}

	destroy(): void {
		if (this.revealTimer != null) {
			window.clearTimeout(this.revealTimer);
			this.revealTimer = null;
		}
		this.revealed = false;
		this.releaseRotate?.();
		this.releaseRotate = null;
		this.releaseTouch?.();
		this.releaseTouch = null;
		this.gesturing = false;
		this.freeZoom = false;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.hooks = null;
		this.styleEpoch++;
		this.activeStyle = null;
		this.controlsAdded = false;
		this.fitRequested = false;
		this.pendingGround = null;
		this.openingView = null;
		this.holdView = null;
		this.destroyBlend();
		this.gpsMarker = null;
		this.pinMarker = null;
		this.places = [];
		this.placeNodes = [];
		this.markerOverlay?.remove();
		this.markerOverlay = null;
		this.clearWeatherStations();
		if (this.map) {
			this.map.remove();
			this.map = null;
		}
		this.baseHost?.remove();
		this.baseHost = null;
		this.host = null;
	}

	/** Show the pitched map once, after the terrain mesh and the ground altitude are in place. */
	private revealBase(): void {
		const base = this.baseHost;
		if (!base || this.revealed) {
			return;
		}
		this.revealed = true;
		this.pendingGround = null;
		if (this.revealTimer != null) {
			window.clearTimeout(this.revealTimer);
			this.revealTimer = null;
		}
		this.hooks?.onReady?.();
		requestAnimationFrame(() => {
			if (this.baseHost === base) {
				base.style.opacity = '1';
			}
		});
	}

	private applyStyleExtras(map: MlMap): void {
		this.enableTerrain(map);
		this.applyTrailOverlays(map);
		this.ensureOverlayLayers(map);
		if (!this.controlsAdded) {
			map.addControl(new NavigationControl({ showCompass: false, visualizePitch: false }), 'top-left');
			this.controlsAdded = true;
		}
		this.applyTraces();
		this.applyGps();
		this.applyPin();
		this.applyElevationColors();
		this.applyFit();
		this.restoreOpeningView();
		this.holdCenterOnGround();
	}

	private enableTerrain(map: MlMap): void {
		try {
			if (!map.getSource(TERRAIN_MESH_SOURCE)) {
				const declared = map.getStyle()?.sources?.[TERRAIN_SOURCE];
				map.addSource(TERRAIN_MESH_SOURCE, declared?.type === 'raster-dem'
					? { ...declared, maxzoom: TERRAIN_MESH_MAX_ZOOM }
					: {
						type: 'raster-dem',
						url: TERRAIN_TILEJSON,
						encoding: 'terrarium',
						tileSize: 512,
						maxzoom: TERRAIN_MESH_MAX_ZOOM
					});
			}
			if (!map.getSource(TERRAIN_MESH_SOURCE)) {
				return;
			}
			const terrain = map.getTerrain();
			if (terrain?.source === TERRAIN_MESH_SOURCE && terrain.exaggeration === TERRAIN_EXAGGERATION) {
				return;
			}
			map.setTerrain({ source: TERRAIN_MESH_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
		} catch (err) {
			console.error('[Maptoolkit] terrain failed to start', err);
		}
	}

	/**
	 * Waymarked Trails rasters, draped on the relief. Same switches as the flat map.
	 * Also drawn on the second map so they stay visible when that one covers the first.
	 */
	setTrailOverlays(overlays: ReliefTrailOverlays): void {
		this.trailOverlays = { ...overlays };
		this.applyTrailOverlays(this.map);
		this.applyTrailOverlays(this.blendMap);
	}

	/** Monuments, lieux et aéroports, au-dessus des deux cartes. */
	setPlaces(places: ReliefPlaceMark[]): void {
		this.places = places;
		this.syncPlaceNodes();
		this.layoutReliefMarkers();
	}

	bounds(): { south: number; west: number; north: number; east: number } | null {
		const box = this.map?.getBounds();
		if (!box) {
			return null;
		}
		return {
			south: box.getSouth(),
			west: box.getWest(),
			north: box.getNorth(),
			east: box.getEast()
		};
	}

	/**
	 * Colorie le relief visible : violet en bas, rouge en haut,
	 * sur l’écart d’altitude de la carte à l’écran.
	 */
	setElevationColors(on: boolean): void {
		if (!on) {
			if (!this.elevationColors) {
				return;
			}
			this.elevationColors = false;
			if (this.elevationTimer != null) {
				window.clearTimeout(this.elevationTimer);
				this.elevationTimer = null;
			}
			this.removeElevationColors();
			this.hooks?.onElevationRange?.(null);
			return;
		}
		this.elevationColors = true;
		this.elevationTries = 0;
		this.refreshElevationColors();
	}

	private scheduleElevationColors(): void {
		if (!this.elevationColors || this.elevationTimer != null) {
			return;
		}
		this.elevationTimer = window.setTimeout(() => {
			this.elevationTimer = null;
			this.refreshElevationColors();
		}, 280);
	}

	private refreshElevationColors(): void {
		if (!this.elevationColors) {
			return;
		}
		const range = this.sampleVisibleElevation();
		if (!range) {
			if (this.elevationTries < 12) {
				this.elevationTries += 1;
				this.scheduleElevationColors();
			}
			return;
		}
		this.elevationTries = 0;
		this.paintElevationColors(this.map, range);
		this.paintElevationColors(this.blendMap, range);
		this.hooks?.onElevationRange?.(range);
	}

	private applyElevationColors(): void {
		if (this.elevationColors) {
			this.refreshElevationColors();
		}
	}

	private removeElevationColors(): void {
		for (const map of [this.map, this.blendMap]) {
			if (map?.getLayer(ELEVATION_COLOR_LAYER)) {
				map.removeLayer(ELEVATION_COLOR_LAYER);
			}
		}
	}

	private sampleVisibleElevation(): { min: number; max: number } | null {
		const map = this.map;
		if (!map?.getTerrain()) {
			return null;
		}
		const canvas = map.getCanvas();
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		if (w < 2 || h < 2) {
			return null;
		}
		const center = map.getCenter();
		const metersPerPx = 156543.03392 * Math.cos((center.lat * Math.PI) / 180) / Math.pow(2, map.getZoom());
		const maxM = metersPerPx * Math.hypot(w, h) * 0.85;
		let min = Infinity;
		let max = -Infinity;
		let count = 0;
		const cols = 8;
		const rows = 6;
		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols; col++) {
				const x = ((col + 0.5) / cols) * w;
				const y = h * (0.18 + 0.78 * ((row + 0.5) / rows));
				const ll = map.unproject([x, y]);
				if (!Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) {
					continue;
				}
				if (metersBetween(center.lat, center.lng, ll.lat, ll.lng) > maxM) {
					continue;
				}
				const raw = map.queryTerrainElevation([ll.lng, ll.lat]);
				if (raw == null || !Number.isFinite(raw)) {
					continue;
				}
				const meters = raw / TERRAIN_EXAGGERATION;
				min = Math.min(min, meters);
				max = Math.max(max, meters);
				count += 1;
			}
		}
		if (count < 4 || !Number.isFinite(min) || !Number.isFinite(max)) {
			return null;
		}
		if (max - min < 1) {
			min -= 1;
			max += 1;
		}
		return { min, max };
	}

	private paintElevationColors(map: MlMap | null, range: { min: number; max: number }): void {
		if (!map?.getSource(TERRAIN_MESH_SOURCE)) {
			return;
		}
		const span = range.max - range.min;
		const ramp: unknown[] = ['interpolate', ['linear'], ['elevation']];
		ELEVATION_RAINBOW.forEach((color, index) => {
			const stop = range.min + span * (index / (ELEVATION_RAINBOW.length - 1));
			ramp.push(stop, color);
		});
		const paint = ramp as never;
		if (map.getLayer(ELEVATION_COLOR_LAYER)) {
			map.setPaintProperty(ELEVATION_COLOR_LAYER, 'color-relief-color', paint);
			return;
		}
		const before = this.elevationColorAnchor(map);
		map.addLayer({
			id: ELEVATION_COLOR_LAYER,
			type: 'color-relief',
			source: TERRAIN_MESH_SOURCE,
			paint: {
				'color-relief-opacity': 0.72,
				'color-relief-color': paint
			}
		}, before);
	}

	/** Sous les noms et sous les tracés, au-dessus du fond de carte. */
	private elevationColorAnchor(map: MlMap): string | undefined {
		for (const spec of TRAIL_RASTERS) {
			if (map.getLayer(spec.id)) {
				return spec.id;
			}
		}
		if (map.getLayer('relief-traces-line')) {
			return 'relief-traces-line';
		}
		return map.getStyle()?.layers?.find((layer) => layer.type === 'symbol')?.id;
	}

	/**
	 * `isStyleLoaded()` stays false while tiles or sprites are still arriving,
	 * and `style.load` does not fire again. Waiting on it dropped ski, trails
	 * and the other switches, above all on the second map once it covers the first.
	 */
	private styleDocumentReady(map: MlMap): boolean {
		try {
			const style = map.getStyle();
			return !!style && Object.keys(style.sources ?? {}).length > 0;
		} catch {
			return false;
		}
	}

	private trailsMissing(map: MlMap): boolean {
		if (!this.styleDocumentReady(map)) {
			return false;
		}
		try {
			for (const spec of TRAIL_RASTERS) {
				if (this.trailOverlays[spec.key] && !map.getLayer(spec.id)) {
					return true;
				}
			}
			return false;
		} catch {
			return true;
		}
	}

	private queueOverlayApply(map: MlMap, apply: () => void, failed = false): void {
		if (map !== this.map && map !== this.blendMap) {
			return;
		}
		if (failed) {
			const attempts = (this.overlayRetryFailures.get(map) ?? 0) + 1;
			this.overlayRetryFailures.set(map, attempts);
			if (attempts > 8) {
				return;
			}
		}
		if ((this.overlayRetryToken.get(map) ?? 0) !== 0) {
			return;
		}
		const token = ++this.overlayRetrySerial;
		this.overlayRetryToken.set(map, token);
		const run = (): void => {
			if (this.overlayRetryToken.get(map) !== token) {
				return;
			}
			this.overlayRetryToken.set(map, 0);
			if (map !== this.map && map !== this.blendMap) {
				return;
			}
			apply();
		};
		map.once('style.load', run);
		map.once('idle', run);
	}

	private applyTrailOverlays(map: MlMap | null): void {
		if (!map || (map !== this.map && map !== this.blendMap)) {
			return;
		}
		if (!this.styleDocumentReady(map)) {
			this.queueOverlayApply(map, () => this.applyTrailOverlays(map));
			return;
		}
		let ok = true;
		for (const spec of TRAIL_RASTERS) {
			ok = this.syncRasterTrail(map, spec.id, spec.tiles, this.trailOverlays[spec.key], this.trailAnchor(map, spec.id)) && ok;
		}
		if (!ok) {
			this.queueOverlayApply(map, () => this.applyTrailOverlays(map), true);
			return;
		}
		this.overlayRetryFailures.set(map, 0);
	}

	/** Next trail already on the map, else the trace, so a newly enabled layer keeps its order. */
	private trailAnchor(map: MlMap, id: string): string | undefined {
		const index = TRAIL_RASTERS.findIndex((spec) => spec.id === id);
		for (let i = index + 1; i < TRAIL_RASTERS.length; i++) {
			if (map.getLayer(TRAIL_RASTERS[i].id)) {
				return TRAIL_RASTERS[i].id;
			}
		}
		return map.getLayer('relief-traces-line') ? 'relief-traces-line' : undefined;
	}

	private syncRasterTrail(map: MlMap, id: string, tiles: string, visible: boolean, before: string | undefined): boolean {
		try {
			if (!visible) {
				if (map.getLayer(id)) {
					map.removeLayer(id);
				}
				if (map.getSource(id)) {
					map.removeSource(id);
				}
				return true;
			}
			if (!map.getSource(id)) {
				map.addSource(id, { type: 'raster', tiles: [tiles], tileSize: 256, maxzoom: 18 });
			}
			if (!map.getLayer(id)) {
				const layer = {
					id,
					type: 'raster' as const,
					source: id,
					paint: { 'raster-opacity': 0.95 }
				};
				if (before && map.getLayer(before)) {
					map.addLayer(layer, before);
				} else {
					map.addLayer(layer);
				}
			}
			return true;
		} catch (err) {
			console.error('[Maptoolkit] trail overlay failed', err);
			return false;
		}
	}

	private ensureOverlayLayers(map: MlMap): void {
		if (!map.getSource(TRACE_SOURCE)) {
			map.addSource(TRACE_SOURCE, { type: 'geojson', data: EMPTY });
			map.addLayer({
				id: 'relief-traces-line',
				type: 'line',
				source: TRACE_SOURCE,
				filter: ['==', ['geometry-type'], 'LineString'],
				layout: { 'line-cap': 'round', 'line-join': 'round' },
				paint: {
					'line-color': ['get', 'color'],
					'line-width': 4,
					'line-opacity': 0.95
				}
			});
			map.addLayer({
				id: 'relief-traces-ends',
				type: 'circle',
				source: TRACE_SOURCE,
				filter: ['==', ['geometry-type'], 'Point'],
				paint: {
					'circle-radius': 6,
					'circle-color': ['get', 'color'],
					'circle-stroke-width': 2,
					'circle-stroke-color': '#ffffff'
				}
			});
		}
	}

	private applyTraces(): void {
		const data = tracesToGeoJson(this.traces) as Parameters<GeoJSONSource['setData']>[0];
		for (const map of [this.map, this.blendMap]) {
			const source = map?.getSource(TRACE_SOURCE) as GeoJSONSource | undefined;
			source?.setData(data);
		}
	}

	/**
	 * Point rouge et épingle, au-dessus des deux cartes.
	 * Un marqueur posé sur la première seule disparaît quand le curseur passe sur la seconde.
	 */
	private applyGps(): void {
		const point = this.gps;
		if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
			this.gpsMarker?.remove();
			this.gpsMarker = null;
			return;
		}
		const overlay = this.ensureMarkerOverlay();
		if (!overlay) {
			return;
		}
		if (!this.gpsMarker) {
			const el = document.createElement('div');
			el.className = 'tv-relief-gps';
			overlay.appendChild(el);
			this.gpsMarker = el;
		}
		this.layoutReliefMarkers();
	}

	/** Épingle au-dessus des deux cartes : un symbole dans le mesh disparaît dès que la vue est inclinée. */
	private applyPin(): void {
		const point = this.pin;
		if (!point) {
			this.pinMarker?.remove();
			this.pinMarker = null;
			return;
		}
		const overlay = this.ensureMarkerOverlay();
		if (!overlay) {
			return;
		}
		if (!this.pinMarker) {
			const el = document.createElement('div');
			el.className = 'tv-relief-pin';
			el.innerHTML = `<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg" style="display:block">
				<path d="M12.5 0C5.596 0 0 5.596 0 12.5c0 12.5 12.5 28.5 12.5 28.5s12.5-16 12.5-28.5C25 5.596 19.404 0 12.5 0z" fill="#FF0000" stroke="#FFFFFF" stroke-width="1"/>
				<circle cx="12.5" cy="12.5" r="5" fill="#FFFFFF"/>
			</svg>`;
			overlay.appendChild(el);
			this.pinMarker = el;
		}
		this.layoutReliefMarkers();
	}

	private ensureMarkerOverlay(): HTMLDivElement | null {
		if (this.markerOverlay?.isConnected) {
			return this.markerOverlay;
		}
		const parent = this.host;
		if (!parent) {
			return null;
		}
		const overlay = document.createElement('div');
		overlay.className = 'trace-relief3d-markers';
		parent.appendChild(overlay);
		this.markerOverlay = overlay;
		return overlay;
	}

	private layoutReliefMarkers(): void {
		const map = this.map;
		if (!map) {
			return;
		}
		this.placeReliefMarker(this.gpsMarker, this.gps, 'center');
		this.placeReliefMarker(this.pinMarker, this.pin, 'bottom');
		for (let i = 0; i < this.placeNodes.length; i++) {
			this.placeReliefMarker(this.placeNodes[i], this.places[i] ?? null, 'center');
		}
	}

	private syncPlaceNodes(): void {
		if (!this.places.length) {
			for (const el of this.placeNodes) {
				el.remove();
			}
			this.placeNodes = [];
			return;
		}
		const overlay = this.ensureMarkerOverlay();
		if (!overlay) {
			return;
		}
		while (this.placeNodes.length > this.places.length) {
			this.placeNodes.pop()?.remove();
		}
		for (let i = 0; i < this.places.length; i++) {
			const place = this.places[i];
			let el = this.placeNodes[i];
			if (!el?.isConnected) {
				el = document.createElement('div');
				el.className = 'tv-relief-place';
				overlay.appendChild(el);
				this.placeNodes[i] = el;
			}
			el.dataset['kind'] = place.kind;
			el.title = place.name;
		}
	}

	private placeReliefMarker(
		el: HTMLDivElement | null,
		point: { lat: number; lng: number } | null,
		anchor: 'center' | 'bottom'
	): void {
		const map = this.map;
		if (!el || !map || !point) {
			return;
		}
		const p = map.project([point.lng, point.lat]);
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
			el.style.display = 'none';
			return;
		}
		el.style.display = '';
		const shift = anchor === 'bottom' ? 'translate(-50%, -100%)' : 'translate(-50%, -50%)';
		el.style.transform = `translate(${p.x}px, ${p.y}px) ${shift}`;
	}

	private ensureStationOverlay(): HTMLDivElement | null {
		if (this.stationOverlay?.isConnected) {
			return this.stationOverlay;
		}
		const parent = this.host;
		if (!parent) {
			return null;
		}
		const overlay = document.createElement('div');
		overlay.className = 'trace-relief3d-stations';
		overlay.addEventListener('click', (event) => {
			this.stationClick?.(event);
		});
		parent.appendChild(overlay);
		this.stationOverlay = overlay;
		return overlay;
	}

	private clearWeatherStations(): void {
		this.stationLabels = [];
		this.stationNodes.clear();
		this.stationClick = null;
		this.stationHover = null;
		this.stationOverlay?.remove();
		this.stationOverlay = null;
		if (this.elevationTimer != null) {
			window.clearTimeout(this.elevationTimer);
			this.elevationTimer = null;
		}
		this.elevationColors = false;
	}

	private syncWeatherStationNodes(): void {
		if (!this.stationLabels.length) {
			this.stationNodes.clear();
			this.stationOverlay?.remove();
			this.stationOverlay = null;
			return;
		}
		const overlay = this.ensureStationOverlay();
		if (!overlay) {
			return;
		}
		const next = new Set(this.stationLabels.map((label) => label.key));
		for (const [key, el] of this.stationNodes) {
			if (!next.has(key)) {
				el.remove();
				this.stationNodes.delete(key);
			}
		}
		for (const label of this.stationLabels) {
			let el = this.stationNodes.get(label.key);
			if (!el) {
				el = document.createElement('div');
				el.className = 'trace-relief-station';
				el.addEventListener('mouseenter', () => this.stationHover?.(label.key));
				overlay.appendChild(el);
				this.stationNodes.set(label.key, el);
			}
			if (el.dataset['stamp'] !== `${label.html}\n${label.tooltipHtml}`) {
				el.dataset['stamp'] = `${label.html}\n${label.tooltipHtml}`;
				el.innerHTML =
					`${label.html}<div class="trace-relief-station-tip mf-temp-tooltip">${label.tooltipHtml}</div>`;
			}
			el.dataset['w'] = String(label.width);
		}
	}

	private layoutWeatherStations(): void {
		const map = this.map;
		if (!map || !this.stationLabels.length) {
			return;
		}
		const canvas = map.getCanvas();
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
		for (const label of this.stationLabels) {
			const el = this.stationNodes.get(label.key);
			if (!el) {
				continue;
			}
			const p = map.project([label.lng, label.lat]);
			if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
				el.style.display = 'none';
				continue;
			}
			const width = label.width;
			const rect = { x: p.x - width / 2, y: p.y - 10, w: width, h: 20 };
			const outside = p.x < -48 || p.y < -48 || p.x > w + 48 || p.y > h + 48;
			if (outside || stationLabelOverlaps(rect, placed)) {
				el.style.display = 'none';
				continue;
			}
			placed.push(rect);
			el.style.display = '';
			el.style.transform = `translate(${p.x}px, ${p.y}px)`;
		}
	}

	private createBlendMap(styleUrl: string): void {
		const source = this.map;
		const parent = this.host;
		if (!source || !parent) {
			return;
		}
		this.blendReady = false;
		const host = document.createElement('div');
		host.className = 'trace-relief3d-blend';
		host.style.position = 'absolute';
		host.style.inset = '0';
		host.style.zIndex = '4';
		host.style.pointerEvents = 'none';
		host.style.opacity = '0';
		parent.appendChild(host);
		this.blendHost = host;
		const center = source.getCenter();
		const elevation = source.getCenterElevation();
		const map = new MlMap({
			container: host,
			style: { version: 8, sources: {}, layers: [] },
			center,
			zoom: clampZoom(source.getZoom()),
			pitch: source.getPitch(),
			bearing: source.getBearing(),
			roll: source.getRoll(),
			elevation: Number.isFinite(elevation) ? elevation : 0,
			interactive: false,
			attributionControl: false,
			maxPitch: SKY_PITCH,
			maxZoom: MAX_ZOOM,
			/*
			 * La carte du dessous a déjà désactivé ce recalage. S’il reste actif ici,
			 * MapLibre repose le centre sur le relief de CE style et les deux vues se décalent dès qu’on incline.
			 */
			centerClampedToGround: false,
			canvasContextAttributes: {
				powerPreference: 'default',
				failIfMajorPerformanceCaveat: false
			}
		});
		ignoreMissingStyleIcons(map);
		this.blendMap = map;
		map.setStyle(styleUrl, { diff: false, transformStyle: styleWithoutCamera });
		const epoch = ++this.blendEpoch;
		let terrainOn = false;
		const syncIfCurrent = (): void => {
			if (this.blendMap === map && epoch === this.blendEpoch) {
				this.syncBlendCamera();
			}
		};
		const revealIfSettled = (): void => {
			if (this.blendMap !== map || epoch !== this.blendEpoch || !terrainOn) {
				return;
			}
			const giveUp = (this.overlayRetryFailures.get(map) ?? 0) > 8;
			if (!this.blendReady || (this.trailsMissing(map) && !giveUp)) {
				syncIfCurrent();
				this.paintBlendOverlays(map);
			}
			if (this.blendReady || !map.getTerrain()) {
				return;
			}
			this.blendReady = true;
			this.applyBlendOpacity();
		};
		map.on('style.load', () => {
			if (this.blendMap !== map || epoch !== this.blendEpoch) {
				return;
			}
			this.paintBlendOverlays(map);
			syncIfCurrent();
			map.resize();
		});
		map.on('terrain', () => {
			terrainOn = true;
			syncIfCurrent();
			if (this.blendMap === map && epoch === this.blendEpoch) {
				this.paintBlendOverlays(map);
			}
		});
		map.on('idle', revealIfSettled);
		requestAnimationFrame(() => {
			if (this.blendMap === map) {
				map.resize();
				syncIfCurrent();
			}
		});
	}

	/** Trace, sentiers, pistes et couleurs : la 2e carte les redessine, sinon le curseur les cache. */
	private paintBlendOverlays(map: MlMap): void {
		if (this.blendMap !== map) {
			return;
		}
		if (!this.styleDocumentReady(map)) {
			this.queueOverlayApply(map, () => this.paintBlendOverlays(map));
			return;
		}
		try {
			this.enableTerrain(map);
			this.applyTrailOverlays(map);
			this.ensureOverlayLayers(map);
			this.applyTraces();
			this.applyElevationColors();
		} catch (err) {
			console.error('[Maptoolkit] blend overlays failed', err);
			this.queueOverlayApply(map, () => this.paintBlendOverlays(map), true);
		}
	}

	/** Le curseur à 0 garde la 2e carte, invisible, pour qu’elle soit déjà calée au retour. */
	private applyBlendOpacity(): void {
		if (this.blendHost) {
			this.blendHost.style.opacity = String(this.blendReady ? this.blendOpacity : 0);
		}
	}

	private syncBlendCamera(): void {
		const source = this.map;
		const target = this.blendMap;
		if (!source || !target) {
			return;
		}
		const center = source.getCenter();
		const zoom = source.getZoom();
		const pitch = source.getPitch();
		const bearing = source.getBearing();
		const roll = source.getRoll();
		const elevation = source.getCenterElevation();
		const current = target.getCenter();
		const sameView = Math.abs(current.lng - center.lng) < 1e-8
			&& Math.abs(current.lat - center.lat) < 1e-8
			&& Math.abs(target.getZoom() - zoom) < 1e-4
			&& Math.abs(target.getPitch() - pitch) < 0.02
			&& Math.abs(target.getBearing() - bearing) < 0.02
			&& Math.abs(target.getRoll() - roll) < 0.02
			&& Math.abs(target.getCenterElevation() - elevation) < 0.25;
		if (sameView) {
			return;
		}
		target.jumpTo({
			center,
			zoom,
			pitch,
			bearing,
			roll,
			elevation: Number.isFinite(elevation) ? elevation : 0
		});
	}

	private destroyBlend(): void {
		this.blendEpoch++;
		this.blendStyle = null;
		this.blendOpacity = 0;
		this.blendReady = false;
		if (this.blendMap) {
			this.blendMap.remove();
			this.blendMap = null;
		}
		this.blendHost?.remove();
		this.blendHost = null;
	}

	private applyFit(): void {
		const map = this.map;
		if (!this.fitRequested || !map) {
			return;
		}
		if (!map.isStyleLoaded()) {
			map.once('idle', () => this.applyFit());
			return;
		}
		let minLng = 180;
		let minLat = 90;
		let maxLng = -180;
		let maxLat = -90;
		let count = 0;
		for (const trace of this.traces) {
			for (const point of trace.points) {
				const lat = point[0];
				const lng = point[1];
				if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
					continue;
				}
				count += 1;
				minLng = Math.min(minLng, lng);
				maxLng = Math.max(maxLng, lng);
				minLat = Math.min(minLat, lat);
				maxLat = Math.max(maxLat, lat);
			}
		}
		this.fitRequested = false;
		if (count < 1) {
			return;
		}
		const centerLng = (minLng + maxLng) / 2;
		const centerLat = (minLat + maxLat) / 2;
		const latSpan = Math.max(maxLat - minLat, 0.0008);
		const lngSpan = Math.max(maxLng - minLng, 0.0008) * Math.cos((centerLat * Math.PI) / 180);
		const span = Math.max(latSpan, lngSpan);
		const zoom = clampZoom(Math.log2(360 / span) - 0.8);
		this.lookAt(centerLng, centerLat, zoom);
	}

	/** Put back the 2D camera once the terrain mesh exists, before any later move can replace it. */
	private restoreOpeningView(): void {
		const view = this.openingView;
		const map = this.map;
		if (!view || !map) {
			return;
		}
		this.openingView = null;
		const elevation = this.groundElevation(view.lng, view.lat);
		this.pendingGround = elevation == null ? { lng: view.lng, lat: view.lat } : null;
		this.jumpLocked({
			lng: view.lng,
			lat: view.lat,
			zoom: view.zoom,
			pitch: view.pitch,
			bearing: view.bearing,
			elevation: elevation ?? undefined
		});
	}

	/** Aim the camera at the terrain under (lng, lat). Sea level hides that point once the view is pitched. */
	private lookAt(lng: number, lat: number, zoom: number): void {
		const map = this.map;
		if (!map) {
			return;
		}
		const elevation = this.groundElevation(lng, lat);
		this.pendingGround = elevation == null ? { lng, lat } : null;
		this.jumpLocked({
			lng,
			lat,
			zoom: clampZoom(zoom),
			pitch: map.getPitch(),
			bearing: map.getBearing(),
			elevation: elevation ?? undefined
		});
	}

	/** Jump without letting the terrain collision change zoom, center, bearing or pitch. */
	private jumpLocked(options: {
		lng: number;
		lat: number;
		zoom: number;
		pitch: number;
		bearing: number;
		elevation?: number;
	}, maxZoom = MAX_ZOOM): void {
		const map = this.map;
		if (!map) {
			return;
		}
		const zoom = clampZoom(options.zoom, maxZoom);
		const pitch = clampPitch(options.pitch, SKY_PITCH);
		const bearing = Number.isFinite(options.bearing) ? options.bearing : map.getBearing();
		this.holdView = {
			lng: options.lng,
			lat: options.lat,
			zoom,
			bearing,
			pitch,
			...(options.elevation != null && Number.isFinite(options.elevation) ? { elevation: options.elevation } : {})
		};
		try {
			map.jumpTo({
				center: [options.lng, options.lat],
				zoom,
				pitch,
				bearing,
				...(options.elevation != null && Number.isFinite(options.elevation) ? { elevation: options.elevation } : {})
			});
		} finally {
			this.holdView = null;
		}
	}

	/** After a style reload the center drops back to sea level. Lift it once the DEM is available. */
	private holdCenterOnGround(): void {
		const map = this.map;
		if (!map) {
			return;
		}
		const center = map.getCenter();
		const elevation = this.groundElevation(center.lng, center.lat);
		if (elevation == null) {
			this.pendingGround = { lng: center.lng, lat: center.lat };
			return;
		}
		this.pendingGround = null;
		if (Math.abs(map.getCenterElevation() - elevation) < 2) {
			return;
		}
		this.jumpLocked({
			lng: center.lng,
			lat: center.lat,
			zoom: map.getZoom(),
			pitch: map.getPitch(),
			bearing: map.getBearing(),
			elevation
		});
	}

	private flushPendingGround(): void {
		const pending = this.pendingGround;
		const map = this.map;
		if (!pending || !map) {
			return;
		}
		const center = map.getCenter();
		if (Math.abs(center.lng - pending.lng) > 1e-4 || Math.abs(center.lat - pending.lat) > 1e-4) {
			this.pendingGround = null;
			return;
		}
		const elevation = this.groundElevation(pending.lng, pending.lat);
		if (elevation == null) {
			return;
		}
		this.pendingGround = null;
		if (Math.abs(map.getCenterElevation() - elevation) < 2) {
			return;
		}
		this.jumpLocked({
			lng: pending.lng,
			lat: pending.lat,
			zoom: map.getZoom(),
			pitch: map.getPitch(),
			bearing: map.getBearing(),
			elevation
		});
	}

	private groundElevation(lng: number, lat: number): number | null {
		const map = this.map;
		if (!map?.getTerrain()) {
			return null;
		}
		try {
			const elevation = map.queryTerrainElevation([lng, lat]);
			// An empty DEM reports 0 until the tiles arrive. Sea level stays at the default camera height.
			if (elevation == null || !Number.isFinite(elevation) || elevation < 1) {
				return null;
			}
			return elevation;
		} catch {
			return null;
		}
	}
}

/** A Maptoolkit style carries its own center. Drop it so the view stays where the user is. */
function styleWithoutCamera(_previous: StyleSpecification | undefined, next: StyleSpecification): StyleSpecification {
	const style: StyleSpecification = { ...next, sources: { ...next.sources }, layers: next.layers.slice() };
	delete style.center;
	delete style.zoom;
	delete style.bearing;
	delete style.pitch;
	capMapterhornDem(style);
	return style;
}

/** Stop hillshade from requesting Mapterhorn zooms that are not published. */
function capMapterhornDem(style: StyleSpecification): void {
	for (const [id, source] of Object.entries(style.sources)) {
		if (source.type !== 'raster-dem') {
			continue;
		}
		const ref = `${source.url ?? ''} ${(source.tiles ?? []).join(' ')}`;
		if (!ref.includes('terrainrgb.json') && !ref.includes('mapterhorn.com')) {
			continue;
		}
		if (source.maxzoom == null || source.maxzoom > TERRAIN_DATA_MAX_ZOOM) {
			style.sources[id] = { ...source, maxzoom: TERRAIN_DATA_MAX_ZOOM };
		}
	}
}

function tracesToGeoJson(traces: ReliefTrace[]): ReliefFeatureCollection {
	const features: ReliefFeatureCollection['features'] = [];
	for (const trace of traces) {
		const coordinates = trace.points
			.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
			.map((point) => [point[1] as number, point[0] as number]);
		if (coordinates.length < 2) {
			continue;
		}
		features.push({
			type: 'Feature',
			properties: { color: trace.color },
			geometry: { type: 'LineString', coordinates }
		});
		features.push({
			type: 'Feature',
			properties: { color: trace.startColor },
			geometry: { type: 'Point', coordinates: coordinates[0] }
		});
		features.push({
			type: 'Feature',
			properties: { color: trace.endColor },
			geometry: { type: 'Point', coordinates: coordinates[coordinates.length - 1] }
		});
	}
	return { type: 'FeatureCollection', features };
}

/**
 * Visible glide after the pointer is released, not a long fling.
 * A fast release coasts about 150 px. maxSpeed 0 would kill the coast.
 * linearity must stay non-zero or the inertia math becomes NaN.
 */
const RELIEF_DRAG_PAN = { linearity: 0.3, maxSpeed: 380, deceleration: 1600 };
const TOUCH_COAST_WINDOW_MS = 220;
const TOUCH_COAST_MAX_PX = 150;
const TOUCH_COAST_MIN_PX = 12;
const TOUCH_COAST_DECEL = 1400;
const PINCH_ZOOM_GAIN = 2.4;
const TAP_DRAG_PX_PER_LEVEL = 78;

const ROTATE_DEG_PER_PIXEL = 0.8;
const PITCH_DEG_PER_PIXEL = -0.5;
const VERTICAL_ORBIT_PX = 100;
const ROTATE_CLICK_TOLERANCE_PX = 3;

type MobileTouchHooks = {
	bearingLocked: () => boolean;
	pitchLocked: () => boolean;
	setFreeZoom: (on: boolean) => void;
	setGesturing: (on: boolean) => void;
};

/**
 * One finger pans (MapLibre drag). Two fingers pinch to zoom around the fingers,
 * twist to rotate, and a vertical drag tilts. A double tap, or a second tap held
 * and dragged, zooms with one finger. The page must not steal the pinch.
 */
function attachMobileTouchCamera(map: MlMap, hooks: MobileTouchHooks): () => void {
	const el = map.getCanvasContainer();
	el.style.touchAction = 'none';
	let pinch: {
		dist: number;
		angle: number;
		midX: number;
		midY: number;
		zoom: number;
		bearing: number;
		pitch: number;
		rotating: boolean;
		pitching: boolean;
	} | null = null;
	let tapZoom: { x: number; y: number; zoom: number; moved: number } | null = null;
	let finger: { x: number; y: number; lastX: number; lastY: number; moved: number } | null = null;
	let lastTap = { t: 0, x: 0, y: 0 };
	let dragPanOff = false;
	const coastSamples: { x: number; y: number; t: number }[] = [];

	const noteCoast = (x: number, y: number): void => {
		const now = performance.now();
		coastSamples.push({ x, y, t: now });
		const cutoff = now - TOUCH_COAST_WINDOW_MS;
		while (coastSamples.length > 2 && coastSamples[0].t < cutoff) {
			coastSamples.shift();
		}
	};

	const coastAfterFinger = (): void => {
		if (coastSamples.length < 2) {
			coastSamples.length = 0;
			return;
		}
		const first = coastSamples[0];
		const last = coastSamples[coastSamples.length - 1];
		coastSamples.length = 0;
		const dt = (last.t - first.t) / 1000;
		if (dt < 0.02) {
			return;
		}
		const dx = -(last.x - first.x);
		const dy = -(last.y - first.y);
		const dist = Math.hypot(dx, dy);
		if (dist < 6) {
			return;
		}
		const speed = dist / dt;
		const duration = Math.min(0.6, speed / TOUCH_COAST_DECEL);
		let coast = (speed * duration) / 2;
		if (coast < TOUCH_COAST_MIN_PX) {
			return;
		}
		if (coast > TOUCH_COAST_MAX_PX) {
			coast = TOUCH_COAST_MAX_PX;
		}
		const scale = coast / dist;
		const offset: [number, number] = [dx * scale, dy * scale];
		requestAnimationFrame(() => {
			map.panBy(offset, {
				duration: duration * 1000,
				easing: (t) => 1 - (1 - t) * (1 - t)
			});
		});
	};

	const enableDragPan = (): void => {
		if (!dragPanOff) {
			return;
		}
		dragPanOff = false;
		map.dragPan.enable(RELIEF_DRAG_PAN);
	};

	const disableDragPan = (): void => {
		if (dragPanOff) {
			return;
		}
		dragPanOff = true;
		map.dragPan.disable();
	};

	const frame = (zoom: number, bearing: number, pitch: number, clientX: number, clientY: number): void => {
		const rect = map.getCanvas().getBoundingClientRect();
		const x = clientX - rect.left;
		const y = clientY - rect.top;
		if (!Number.isFinite(x) || !Number.isFinite(y)) {
			return;
		}
		const before = map.unproject([x, y]);
		const elevation = map.getCenterElevation();
		const center = map.getCenter();
		const nextZoom = touchZoomLimit(map, zoom);
		hooks.setFreeZoom(true);
		try {
			map.jumpTo({
				center,
				zoom: nextZoom,
				bearing,
				pitch,
				...(Number.isFinite(elevation) ? { elevation } : {})
			});
			const after = map.unproject([x, y]);
			const shifted = map.getCenter();
			const keptZoom = map.getZoom();
			const keptElev = map.getCenterElevation();
			map.jumpTo({
				center: [shifted.lng + (before.lng - after.lng), shifted.lat + (before.lat - after.lat)],
				zoom: keptZoom,
				bearing: map.getBearing(),
				pitch: map.getPitch(),
				...(Number.isFinite(keptElev) ? { elevation: keptElev } : {})
			});
		} finally {
			hooks.setFreeZoom(false);
		}
	};

	const onStart = (event: TouchEvent): void => {
		if ((event.target as Element | null)?.closest('.maplibregl-ctrl')) {
			return;
		}
		hooks.setGesturing(true);
		if (event.touches.length >= 2) {
			tapZoom = null;
			coastSamples.length = 0;
			disableDragPan();
			const a = event.touches[0];
			const b = event.touches[1];
			pinch = {
				dist: Math.max(16, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)),
				angle: Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * (180 / Math.PI),
				midX: (a.clientX + b.clientX) / 2,
				midY: (a.clientY + b.clientY) / 2,
				zoom: map.getZoom(),
				bearing: map.getBearing(),
				pitch: map.getPitch(),
				rotating: false,
				pitching: false
			};
			finger = null;
			event.preventDefault();
			return;
		}
		const touch = event.touches[0];
		if (!touch) {
			return;
		}
		const now = Date.now();
		const repeat = now - lastTap.t < 300 && Math.hypot(touch.clientX - lastTap.x, touch.clientY - lastTap.y) < 32;
		if (repeat) {
			tapZoom = { x: touch.clientX, y: touch.clientY, zoom: map.getZoom(), moved: 0 };
			disableDragPan();
			lastTap = { t: 0, x: 0, y: 0 };
			event.preventDefault();
			return;
		}
		coastSamples.length = 0;
		finger = { x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastY: touch.clientY, moved: 0 };
		noteCoast(touch.clientX, touch.clientY);
		disableDragPan();
	};

	const onMove = (event: TouchEvent): void => {
		if (pinch && event.touches.length >= 2) {
			event.preventDefault();
			event.stopPropagation();
			const a = event.touches[0];
			const b = event.touches[1];
			const dist = Math.max(16, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY));
			const midX = (a.clientX + b.clientX) / 2;
			const midY = (a.clientY + b.clientY) / 2;
			let angleDelta = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * (180 / Math.PI) - pinch.angle;
			if (angleDelta > 180) {
				angleDelta -= 360;
			} else if (angleDelta < -180) {
				angleDelta += 360;
			}
			if (!pinch.rotating && Math.abs(angleDelta) > 2.5) {
				pinch.rotating = true;
			}
			const vertical = pinch.midY - midY;
			const horizontal = midX - pinch.midX;
			if (!pinch.pitching && Math.abs(vertical) > 8 && Math.abs(vertical) > Math.abs(horizontal)) {
				pinch.pitching = true;
			}
			const zoom = clampZoom(pinch.zoom + Math.log2(dist / pinch.dist) * PINCH_ZOOM_GAIN);
			const bearing = hooks.bearingLocked() || !pinch.rotating
				? map.getBearing()
				: pinch.bearing - angleDelta;
			const pitch = hooks.pitchLocked() || !pinch.pitching
				? map.getPitch()
				: clampPitch(pinch.pitch + vertical * 0.42);
			frame(zoom, bearing, pitch, midX, midY);
			return;
		}
		if (tapZoom && event.touches.length === 1) {
			event.preventDefault();
			event.stopPropagation();
			const touch = event.touches[0];
			tapZoom.moved = Math.max(tapZoom.moved, Math.hypot(touch.clientX - tapZoom.x, touch.clientY - tapZoom.y));
			const zoom = clampZoom(tapZoom.zoom + (tapZoom.y - touch.clientY) / TAP_DRAG_PX_PER_LEVEL);
			frame(zoom, map.getBearing(), map.getPitch(), tapZoom.x, tapZoom.y);
			return;
		}
		if (finger && event.touches.length === 1) {
			const touch = event.touches[0];
			const dx = touch.clientX - finger.lastX;
			const dy = touch.clientY - finger.lastY;
			finger.lastX = touch.clientX;
			finger.lastY = touch.clientY;
			finger.moved = Math.max(finger.moved, Math.hypot(touch.clientX - finger.x, touch.clientY - finger.y));
			if (finger.moved < 3 || (Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			noteCoast(touch.clientX, touch.clientY);
			map.panBy([-dx, -dy], { animate: false, freezeElevation: true });
		}
	};

	const onEnd = (event: TouchEvent): void => {
		if (event.touches.length >= 2) {
			return;
		}
		if (event.touches.length === 1) {
			pinch = null;
			coastSamples.length = 0;
			const touch = event.touches[0];
			finger = {
				x: touch.clientX,
				y: touch.clientY,
				lastX: touch.clientX,
				lastY: touch.clientY,
				moved: 24
			};
			tapZoom = null;
			return;
		}
		const coast = !!(finger && finger.moved >= 16 && !tapZoom);
		if (tapZoom && tapZoom.moved < 16) {
			frame(clampZoom(tapZoom.zoom + 1.2), map.getBearing(), map.getPitch(), tapZoom.x, tapZoom.y);
		} else if (finger && finger.moved < 16) {
			lastTap = { t: Date.now(), x: finger.x, y: finger.y };
		}
		pinch = null;
		tapZoom = null;
		finger = null;
		enableDragPan();
		hooks.setGesturing(false);
		if (coast) {
			coastAfterFinger();
		} else {
			coastSamples.length = 0;
		}
	};

	const blockGesture = (event: Event): void => {
		event.preventDefault();
	};

	el.addEventListener('touchstart', onStart, { capture: true, passive: false });
	el.addEventListener('touchmove', onMove, { capture: true, passive: false });
	el.addEventListener('touchend', onEnd, { capture: true, passive: false });
	el.addEventListener('touchcancel', onEnd, { capture: true, passive: false });
	el.addEventListener('gesturestart', blockGesture, { passive: false } as AddEventListenerOptions);
	el.addEventListener('gesturechange', blockGesture, { passive: false } as AddEventListenerOptions);

	return () => {
		enableDragPan();
		hooks.setGesturing(false);
		hooks.setFreeZoom(false);
		el.removeEventListener('touchstart', onStart, { capture: true } as EventListenerOptions);
		el.removeEventListener('touchmove', onMove, { capture: true } as EventListenerOptions);
		el.removeEventListener('touchend', onEnd, { capture: true } as EventListenerOptions);
		el.removeEventListener('touchcancel', onEnd, { capture: true } as EventListenerOptions);
		el.removeEventListener('gesturestart', blockGesture);
		el.removeEventListener('gesturechange', blockGesture);
	};
}

/** Zoom in until the slope actually gets closer, not merely because the view is already tilted. */
function touchZoomLimit(map: MlMap, desired: number): number {
	const current = map.getZoom();
	const zoom = clampZoom(desired);
	if (!(zoom > current + 1e-3) || !map.getTerrain()) {
		return zoom;
	}
	const center = map.getCenter();
	const step = {
		lng: center.lng,
		lat: center.lat,
		pitch: map.getPitch(),
		bearing: map.getBearing(),
		elevation: map.getCenterElevation(),
		zoom
	};
	const height = map.getContainer()?.clientHeight || 0;
	const fov = map.getVerticalFieldOfView();
	if (!height || !Number.isFinite(fov)) {
		return zoom;
	}
	const distancePx = (0.5 / Math.tan((fov * Math.PI) / 360)) * height;
	let now = 0;
	let later = 0;
	try {
		now = reliefDeficit(map, step, current, distancePx);
		later = reliefDeficit(map, step, zoom, distancePx);
	} catch {
		return zoom;
	}
	if (later <= now + 28) {
		return zoom;
	}
	const limit = zoomAboveRelief(map, step);
	if (limit == null) {
		return zoom;
	}
	return clampZoom(Math.max(current, Math.min(zoom, limit + 0.15)));
}

/**
 * Ctrl + glisser, ou glisser bouton droit : le cap suit la main autour du centre de l'écran.
 * Le centre projeté sur le MNT bouge quand un relief passe derrière la caméra.
 */
function attachScreenCenterDragRotate(map: MlMap): () => void {
	const canvas = map.getCanvasContainer();
	let active = false;
	let moved = false;
	let button = -1;
	let lastX = 0;
	let lastY = 0;
	let startX = 0;
	let startY = 0;

	const screenCenter = (): { x: number; y: number } => {
		const rect = canvas.getBoundingClientRect();
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	};

	const buttonReleased = (event: MouseEvent): boolean =>
		button === 0 ? (event.buttons & 1) === 0 : (event.buttons & 2) === 0;

	const end = (): void => {
		if (!active) {
			return;
		}
		active = false;
		moved = false;
		button = -1;
		window.removeEventListener('mousemove', onMove, true);
		window.removeEventListener('mouseup', onUp, true);
		window.removeEventListener('blur', onUp, true);
	};

	const onMove = (event: MouseEvent): void => {
		if (!active) {
			return;
		}
		if (buttonReleased(event)) {
			end();
			return;
		}
		event.preventDefault();
		const currentX = event.clientX;
		const currentY = event.clientY;
		if (!moved) {
			if (Math.hypot(currentX - startX, currentY - startY) < ROTATE_CLICK_TOLERANCE_PX) {
				return;
			}
			moved = true;
			lastX = startX;
			lastY = startY;
		}
		const center = screenCenter();
		const bearingDelta = bearingDeltaDeg(lastX, lastY, currentX, currentY, center);
		const pitchDelta = (currentY - lastY) * PITCH_DEG_PER_PIXEL;
		lastX = currentX;
		lastY = currentY;
		if (Math.abs(bearingDelta) < 0.01 && Math.abs(pitchDelta) < 0.01) {
			return;
		}
		const elevation = map.getCenterElevation();
		map.jumpTo({
			center: map.getCenter(),
			zoom: map.getZoom(),
			bearing: map.getBearing() + bearingDelta,
			pitch: clampPitch(map.getPitch() + pitchDelta),
			...(Number.isFinite(elevation) ? { elevation } : {})
		});
	};

	const onUp = (): void => {
		end();
	};

	const onDown = (event: MouseEvent): void => {
		const rotateButton = (event.button === 0 && event.ctrlKey) || (event.button === 2 && !event.ctrlKey);
		if (!rotateButton || active) {
			return;
		}
		const target = event.target as Element | null;
		if (target?.closest('.maplibregl-ctrl')) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		active = true;
		moved = false;
		button = event.button;
		startX = lastX = event.clientX;
		startY = lastY = event.clientY;
		window.addEventListener('mousemove', onMove, true);
		window.addEventListener('mouseup', onUp, true);
		window.addEventListener('blur', onUp, true);
	};

	const onContextMenu = (event: Event): void => {
		event.preventDefault();
	};

	canvas.addEventListener('mousedown', onDown, true);
	canvas.addEventListener('contextmenu', onContextMenu);

	return () => {
		end();
		canvas.removeEventListener('mousedown', onDown, true);
		canvas.removeEventListener('contextmenu', onContextMenu);
	};
}

function bearingDeltaDeg(
	lastX: number,
	lastY: number,
	currentX: number,
	currentY: number,
	center: { x: number; y: number }
): number {
	if (Math.abs(center.y - lastY) > VERTICAL_ORBIT_PX) {
		const cx = currentX - center.x;
		const cy = currentY - center.y;
		const lx = lastX - center.x;
		const ly = currentY - center.y;
		return Math.atan2(cx * ly - cy * lx, cx * lx + cy * ly) * (180 / Math.PI);
	}
	let delta = (currentX - lastX) * ROTATE_DEG_PER_PIXEL;
	if (currentY < center.y) {
		delta = -delta;
	}
	return delta;
}

function clampPitch(pitch: number, max = MAX_PITCH): number {
	if (!Number.isFinite(pitch)) {
		return 50;
	}
	return Math.max(0, Math.min(max, pitch));
}

function clampZoom(zoom: number, maxZoom = MAX_ZOOM): number {
	if (!Number.isFinite(zoom)) {
		return 13;
	}
	return Math.max(0, Math.min(maxZoom, zoom));
}

/**
 * Leaflet zoom 0 is a 256px world. MapLibre zoom 0 is a 512px world.
 * The same ground scale is therefore one MapLibre level lower.
 */
export function leafletZoomToMaplibre(zoom: number): number {
	return clampZoom(zoom - 1);
}

export function maplibreZoomToLeaflet(zoom: number): number {
	if (!Number.isFinite(zoom)) {
		return 13;
	}
	return zoom + 1;
}

/** Closest zoom that keeps this camera above the slope. Null when the view cannot be checked. */
function zoomAboveRelief(
	map: MlMap,
	step: { lng: number; lat: number; pitch: number; bearing: number; elevation: number; zoom: number }
): number | null {
	if (!map.getTerrain() || !Number.isFinite(step.lng) || !Number.isFinite(step.lat) || !Number.isFinite(step.zoom)) {
		return null;
	}
	const height = map.getContainer()?.clientHeight || 0;
	const fov = map.getVerticalFieldOfView();
	if (!height || !Number.isFinite(fov)) {
		return null;
	}
	const distancePx = (0.5 / Math.tan((fov * Math.PI) / 360)) * height;
	let zoom = step.zoom;
	for (let pass = 0; pass < 4; pass++) {
		const deficit = reliefDeficit(map, step, zoom, distancePx);
		if (deficit <= 18) {
			break;
		}
		const heightM = cameraHeightMeters(step, zoom, distancePx);
		if (heightM < 1) {
			zoom = Math.max(0, zoom - 0.25);
			continue;
		}
		zoom -= Math.log2((heightM + deficit) / heightM);
	}
	return Number.isFinite(zoom) ? Math.max(0, zoom) : null;
}

function cameraHeightMeters(
	step: { lat: number; pitch: number; elevation: number },
	zoom: number,
	distancePx: number
): number {
	const pitch = (step.pitch * Math.PI) / 180;
	return Math.cos(pitch) * distancePx * metersPerPixel(step.lat, step.elevation, zoom);
}

function reliefDeficit(
	map: MlMap,
	step: { lng: number; lat: number; pitch: number; bearing: number; elevation: number },
	zoom: number,
	distancePx: number
): number {
	const pitch = (step.pitch * Math.PI) / 180;
	const mpp = metersPerPixel(step.lat, step.elevation, zoom);
	const heightM = Math.cos(pitch) * distancePx * mpp;
	const backM = Math.sin(pitch) * distancePx * mpp;
	const centerElev = map.queryTerrainElevation([step.lng, step.lat]) ?? step.elevation ?? 0;
	const cameraAlt = centerElev + heightM;
	const cameraGround = moveMeters(step.lng, step.lat, backM, step.bearing + 180);
	let worst = 0;
	const steps = 4;
	for (let i = 0; i < steps; i++) {
		const t = i / steps;
		const lng = cameraGround.lng + (step.lng - cameraGround.lng) * t;
		const lat = cameraGround.lat + (step.lat - cameraGround.lat) * t;
		const ground = map.queryTerrainElevation([lng, lat]);
		if (ground == null || !Number.isFinite(ground)) {
			continue;
		}
		const rayAlt = cameraAlt + (centerElev - cameraAlt) * t;
		const clearance = RELIEF_CLEARANCE_M * (1 - t);
		worst = Math.max(worst, ground + clearance - rayAlt);
	}
	return worst;
}

function metersPerPixel(lat: number, elevation: number, zoom: number): number {
	const units = MercatorCoordinate.fromLngLat({ lng: 0, lat }, elevation).meterInMercatorCoordinateUnits();
	if (!units) {
		return 0;
	}
	return 1 / (512 * Math.pow(2, zoom) * units);
}

function metersBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLng = ((lng2 - lng1) * Math.PI) / 180;
	const a = Math.sin(dLat / 2) ** 2
		+ Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
	return 6378137 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function stationLabelOverlaps(
	rect: { x: number; y: number; w: number; h: number },
	placed: Array<{ x: number; y: number; w: number; h: number }>
): boolean {
	const gapX = 6;
	const gapY = 4;
	for (const other of placed) {
		if (
			rect.x < other.x + other.w + gapX
			&& rect.x + rect.w + gapX > other.x
			&& rect.y < other.y + other.h + gapY
			&& rect.y + rect.h + gapY > other.y
		) {
			return true;
		}
	}
	return false;
}

function moveMeters(lng: number, lat: number, distanceM: number, bearingDeg: number): { lng: number; lat: number } {
	if (!Number.isFinite(distanceM) || distanceM < 0.5) {
		return { lng, lat };
	}
	const bearing = (bearingDeg * Math.PI) / 180;
	const angular = distanceM / 6378137;
	const lat1 = (lat * Math.PI) / 180;
	const lng1 = (lng * Math.PI) / 180;
	const lat2 = Math.asin(
		Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing)
	);
	const lng2 = lng1 + Math.atan2(
		Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
		Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2)
	);
	return {
		lng: (((lng2 * 180) / Math.PI + 540) % 360) - 180,
		lat: (lat2 * 180) / Math.PI
	};
}
