import { LngLat, Map as MlMap, Marker, MercatorCoordinate, NavigationControl, type GeoJSONSource } from 'maplibre-gl';
import { ensureMaplibreWorker, ignoreMissingStyleIcons } from './maptoolkit-basemap.layer';

/** DEM already declared in the Maptoolkit styles, used by their hillshade. */
const TERRAIN_SOURCE = 'rgb-tiles';
/** Separate copy: MapLibre warns and renders worse when hillshade and terrain share one source. */
const TERRAIN_MESH_SOURCE = 'relief-terrain';
const TERRAIN_TILEJSON = 'https://tiles.maptoolkit.org/terrainrgb.json';
const TERRAIN_EXAGGERATION = 1.3;
const MAX_PITCH = 85;
const MAX_ZOOM = 20;
/** Meters kept between the camera and the slope in front of it. */
const RELIEF_CLEARANCE_M = 35;
const TRACE_SOURCE = 'relief-traces';

export interface ReliefViewHooks {
	onZoom?: (zoom: number) => void;
	onBearing?: (bearing: number) => void;
	onPitch?: (pitch: number) => void;
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
	private resizeObserver: ResizeObserver | null = null;
	private hooks: ReliefViewHooks | null = null;
	/** Style currently requested, so the same URL is not reloaded on every slider tick. */
	private activeStyle: string | null = null;
	/** Bumps when the style is replaced so a late load cannot restyle the previous map. */
	private styleEpoch = 0;
	private controlsAdded = false;
	private traces: ReliefTrace[] = [];
	private gps: { lat: number; lng: number } | null = null;
	private gpsMarker: Marker | null = null;
	/** Repère du lieu choisi (centrage), distinct du point GPS. */
	private pin: { lat: number; lng: number } | null = null;
	private pinMarker: Marker | null = null;
	private fitRequested = false;
	/** Center waiting for a terrain sample so the camera looks at the ground, not sea level. */
	private pendingGround: { lng: number; lat: number } | null = null;
	/** Camera requested at the 2D → 3D switch, reapplied once the style and the terrain exist. */
	private openingView: { lng: number; lat: number; zoom: number; bearing: number; pitch: number } | null = null;
	/**
	 * While a programmatic jump is running, MapLibre must not change zoom, center or bearing
	 * to climb out of the terrain. Pitch stays the one asked for.
	 */
	private holdView: { lng: number; lat: number; zoom: number; bearing: number; pitch: number } | null = null;
	/** Terrain and the ground elevation are in place. Until then the canvas stays invisible. */
	private revealed = false;
	private revealTimer: number | null = null;
	private releaseRotate: (() => void) | null = null;

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
			style: styleUrl,
			center: [view.lng, view.lat],
			zoom: openingZoom,
			pitch: openingPitch,
			bearing: openingBearing,
			maxPitch: MAX_PITCH,
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
		/* maxSpeed 0 stops the coast after a drag. linearity must stay non-zero or the inertia math becomes NaN. */
		map.dragPan.enable({ linearity: 0.3, maxSpeed: 0 });
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
					pitch: hold.pitch
				};
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
			this.applyStyleExtras(map);
		};
		if (map.isStyleLoaded()) {
			boot();
		} else {
			map.once('style.load', boot);
		}
		map.on('moveend', () => {
			if (this.map !== map) {
				return;
			}
			this.hooks?.onZoom?.(map.getZoom());
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
		});
		map.on('idle', () => {
			if (this.map !== map) {
				return;
			}
			const waitingForGround = this.pendingGround != null;
			this.flushPendingGround();
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
		this.activeStyle = styleUrl;
		const epoch = ++this.styleEpoch;
		map.setStyle(styleUrl, { diff: false });
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
		if (!styleUrl || next <= 0 || !this.map || !this.host) {
			this.destroyBlend();
			return;
		}
		if (this.blendMap && this.blendStyle === styleUrl) {
			this.setBlendOpacity(next);
			this.syncBlendCamera();
			return;
		}
		this.destroyBlend();
		this.blendStyle = styleUrl;
		this.createBlendMap(styleUrl, next);
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
			pitch: clampPitch(pitch),
			bearing: map.getBearing(),
			elevation: map.getCenterElevation()
		});
	}

	/** MapLibre bearing: the compass direction at the top of the screen. */
	setBearing(bearing: number): void {
		const map = this.map;
		if (!map || !Number.isFinite(bearing)) {
			return;
		}
		const current = map.getBearing();
		let delta = bearing - current;
		delta = ((delta + 540) % 360) - 180;
		if (Math.abs(delta) < 0.35) {
			return;
		}
		const center = map.getCenter();
		this.jumpLocked({
			lng: center.lng,
			lat: center.lat,
			zoom: map.getZoom(),
			pitch: map.getPitch(),
			bearing,
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
		this.gpsMarker?.remove();
		this.gpsMarker = null;
		this.pinMarker?.remove();
		this.pinMarker = null;
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
		this.ensureOverlayLayers(map);
		if (!this.controlsAdded) {
			map.addControl(new NavigationControl({ showCompass: false, visualizePitch: false }), 'top-left');
			this.controlsAdded = true;
		}
		this.applyTraces();
		this.applyGps();
		this.applyPin();
		this.applyFit();
		this.restoreOpeningView();
		this.holdCenterOnGround();
	}

	private enableTerrain(map: MlMap): void {
		try {
			if (!map.getSource(TERRAIN_MESH_SOURCE)) {
				const declared = map.getStyle()?.sources?.[TERRAIN_SOURCE];
				map.addSource(TERRAIN_MESH_SOURCE, declared?.type === 'raster-dem'
					? { ...declared }
					: { type: 'raster-dem', url: TERRAIN_TILEJSON });
			}
			if (map.getSource(TERRAIN_MESH_SOURCE)) {
				map.setTerrain({ source: TERRAIN_MESH_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
			}
		} catch (err) {
			console.error('[Maptoolkit] terrain failed to start', err);
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

	/** DOM dot: a circle layer is drawn inside the terrain mesh and disappears once the view is pitched. */
	private applyGps(): void {
		const map = this.map;
		const point = this.gps;
		if (!map || !point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
			this.gpsMarker?.remove();
			this.gpsMarker = null;
			return;
		}
		if (!this.gpsMarker) {
			const el = document.createElement('div');
			el.style.width = '18px';
			el.style.height = '18px';
			el.style.boxSizing = 'border-box';
			el.style.borderRadius = '50%';
			el.style.background = '#e10600';
			el.style.border = '2.5px solid #ffffff';
			el.style.boxShadow = '0 0 0 1px rgba(15, 23, 42, 0.35)';
			el.style.pointerEvents = 'none';
			el.style.zIndex = '5';
			this.gpsMarker = new Marker({
				element: el,
				anchor: 'center',
				pitchAlignment: 'viewport',
				rotationAlignment: 'viewport',
				opacityWhenCovered: 1,
				subpixelPositioning: true
			});
		}
		this.gpsMarker.setLngLat([point.lng, point.lat]);
		if (!this.gpsMarker.getElement().isConnected) {
			this.gpsMarker.addTo(map);
		}
	}

	/** Épingle au-dessus du relief : un symbole dans le mesh disparaît dès que la vue est inclinée. */
	private applyPin(): void {
		const map = this.map;
		const point = this.pin;
		if (!map || !point) {
			this.pinMarker?.remove();
			this.pinMarker = null;
			return;
		}
		if (!this.pinMarker) {
			const el = document.createElement('div');
			el.style.width = '25px';
			el.style.height = '41px';
			el.style.pointerEvents = 'none';
			el.style.zIndex = '6';
			el.innerHTML = `<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg" style="display:block">
				<path d="M12.5 0C5.596 0 0 5.596 0 12.5c0 12.5 12.5 28.5 12.5 28.5s12.5-16 12.5-28.5C25 5.596 19.404 0 12.5 0z" fill="#FF0000" stroke="#FFFFFF" stroke-width="1"/>
				<circle cx="12.5" cy="12.5" r="5" fill="#FFFFFF"/>
			</svg>`;
			this.pinMarker = new Marker({
				element: el,
				anchor: 'bottom',
				pitchAlignment: 'viewport',
				rotationAlignment: 'viewport',
				opacityWhenCovered: 1,
				subpixelPositioning: true
			});
		}
		this.pinMarker.setLngLat([point.lng, point.lat]);
		if (!this.pinMarker.getElement().isConnected) {
			this.pinMarker.addTo(map);
		}
	}

	private createBlendMap(styleUrl: string, opacity: number): void {
		const source = this.map;
		const parent = this.host;
		if (!source || !parent) {
			return;
		}
		const host = document.createElement('div');
		host.className = 'trace-relief3d-blend';
		host.style.position = 'absolute';
		host.style.inset = '0';
		host.style.zIndex = '4';
		host.style.pointerEvents = 'none';
		host.style.opacity = String(opacity);
		parent.appendChild(host);
		this.blendHost = host;
		const center = source.getCenter();
		const map = new MlMap({
			container: host,
			style: styleUrl,
			center,
			zoom: clampZoom(source.getZoom()),
			pitch: source.getPitch(),
			bearing: source.getBearing(),
			interactive: false,
			attributionControl: false,
			maxPitch: MAX_PITCH,
			maxZoom: MAX_ZOOM,
			canvasContextAttributes: {
				powerPreference: 'default',
				failIfMajorPerformanceCaveat: false
			}
		});
		ignoreMissingStyleIcons(map);
		this.blendMap = map;
		const epoch = ++this.blendEpoch;
		map.on('load', () => {
			if (this.blendMap !== map || epoch !== this.blendEpoch) {
				return;
			}
			this.enableTerrain(map);
			this.ensureOverlayLayers(map);
			this.applyTraces();
			this.applyGps();
			this.syncBlendCamera();
			map.resize();
		});
		requestAnimationFrame(() => {
			if (this.blendMap === map) {
				map.resize();
			}
		});
	}

	private setBlendOpacity(opacity: number): void {
		if (this.blendHost) {
			this.blendHost.style.opacity = String(opacity);
		}
	}

	private syncBlendCamera(): void {
		const source = this.map;
		const target = this.blendMap;
		if (!source || !target) {
			return;
		}
		target.jumpTo({
			center: source.getCenter(),
			zoom: source.getZoom(),
			pitch: source.getPitch(),
			bearing: source.getBearing()
		});
	}

	private destroyBlend(): void {
		this.blendEpoch++;
		this.blendStyle = null;
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
	}): void {
		const map = this.map;
		if (!map) {
			return;
		}
		const zoom = clampZoom(options.zoom);
		const pitch = clampPitch(options.pitch);
		const bearing = Number.isFinite(options.bearing) ? options.bearing : map.getBearing();
		this.holdView = { lng: options.lng, lat: options.lat, zoom, bearing, pitch };
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

const ROTATE_DEG_PER_PIXEL = 0.8;
const PITCH_DEG_PER_PIXEL = -0.5;
const VERTICAL_ORBIT_PX = 100;
const ROTATE_CLICK_TOLERANCE_PX = 3;

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

function clampPitch(pitch: number): number {
	if (!Number.isFinite(pitch)) {
		return 50;
	}
	return Math.max(0, Math.min(MAX_PITCH, pitch));
}

function clampZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) {
		return 13;
	}
	return Math.max(0, Math.min(MAX_ZOOM, zoom));
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
		if (deficit <= 0) {
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
