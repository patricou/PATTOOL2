import { Map as MlMap, MercatorCoordinate, NavigationControl, type GeoJSONSource } from 'maplibre-gl';
import { ensureMaplibreWorker, ignoreMissingStyleIcons } from './maptoolkit-basemap.layer';

/** DEM already declared in the Maptoolkit styles (terrarium encoding). */
const TERRAIN_SOURCE = 'rgb-tiles';
const TERRAIN_EXAGGERATION = 1.3;
const MAX_PITCH = 85;
const MAX_ZOOM = 20;
/** Meters kept between the camera and the slope in front of it. */
const RELIEF_CLEARANCE_M = 35;
const TRACE_SOURCE = 'relief-traces';
const GPS_SOURCE = 'relief-gps';

export interface ReliefViewHooks {
	onZoom?: (zoom: number) => void;
	onBearing?: (bearing: number) => void;
	onPitch?: (pitch: number) => void;
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
	private fitRequested = false;

	mount(
		host: HTMLElement,
		styleUrl: string,
		view: { lng: number; lat: number; zoom: number; pitch: number },
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
		host.appendChild(base);
		this.baseHost = base;
		const map = new MlMap({
			container: base,
			style: styleUrl,
			center: [view.lng, view.lat],
			zoom: clampZoom(view.zoom),
			pitch: clampPitch(view.pitch),
			bearing: 0,
			maxPitch: MAX_PITCH,
			maxZoom: MAX_ZOOM,
			/* Ctrl + drag: sideways rotates, upward tilts. */
			dragRotate: true,
			pitchWithRotate: true,
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
		/* maxSpeed 0 stops the coast after a drag. linearity must stay non-zero or the inertia math becomes NaN. */
		map.dragPan.enable({ linearity: 0.3, maxSpeed: 0 });
		const epoch = this.styleEpoch;
		let reliefQueued = false;
		let reliefCorrecting = false;
		const keepAboveRelief = () => {
			if (reliefQueued || reliefCorrecting || this.map !== map) {
				return;
			}
			reliefQueued = true;
			requestAnimationFrame(() => {
				reliefQueued = false;
				if (reliefCorrecting || this.map !== map) {
					return;
				}
				let zoom: number | null = null;
				try {
					zoom = zoomAboveRelief(map);
				} catch {
					return;
				}
				if (zoom == null || zoom >= map.getZoom() - 0.05) {
					return;
				}
				reliefCorrecting = true;
				map.jumpTo({ zoom });
				reliefCorrecting = false;
			});
		};
		map.on('load', () => {
			if (this.map !== map || epoch !== this.styleEpoch) {
				return;
			}
			this.applyStyleExtras(map);
		});
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
			keepAboveRelief();
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
		this.map?.setPitch(clampPitch(pitch));
	}

	setTraces(traces: ReliefTrace[]): void {
		this.traces = traces;
		this.applyTraces();
	}

	setGps(point: { lat: number; lng: number } | null): void {
		this.gps = point;
		this.applyGps();
	}

	/** Frame the traces. Kept until the style has loaded. */
	fitTraces(): void {
		this.fitRequested = true;
		this.applyFit();
	}

	jumpTo(lat: number, lng: number, zoom?: number): void {
		if (!this.map || !Number.isFinite(lat) || !Number.isFinite(lng)) {
			return;
		}
		this.map.jumpTo({
			center: [lng, lat],
			zoom: zoom == null ? this.map.getZoom() : clampZoom(zoom)
		});
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

	destroy(): void {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.hooks = null;
		this.styleEpoch++;
		this.activeStyle = null;
		this.controlsAdded = false;
		this.fitRequested = false;
		this.destroyBlend();
		if (this.map) {
			this.map.remove();
			this.map = null;
		}
		this.baseHost?.remove();
		this.baseHost = null;
		this.host = null;
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
		this.applyFit();
	}

	private enableTerrain(map: MlMap): void {
		try {
			if (!map.getSource(TERRAIN_SOURCE)) {
				map.addSource(TERRAIN_SOURCE, {
					type: 'raster-dem',
					url: 'https://tiles.maptoolkit.org/terrainrgb.json'
				});
			}
			if (map.getSource(TERRAIN_SOURCE)) {
				map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
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
		if (!map.getSource(GPS_SOURCE)) {
			map.addSource(GPS_SOURCE, { type: 'geojson', data: EMPTY });
			map.addLayer({
				id: 'relief-gps',
				type: 'circle',
				source: GPS_SOURCE,
				paint: {
					'circle-radius': 7,
					'circle-color': '#e10600',
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

	private applyGps(): void {
		const point = this.gps;
		const data: ReliefFeatureCollection = !point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)
			? EMPTY
			: {
				type: 'FeatureCollection',
				features: [{
					type: 'Feature',
					properties: { color: '#e10600' },
					geometry: { type: 'Point', coordinates: [point.lng, point.lat] }
				}]
			};
		const payload = data as Parameters<GeoJSONSource['setData']>[0];
		for (const map of [this.map, this.blendMap]) {
			const source = map?.getSource(GPS_SOURCE) as GeoJSONSource | undefined;
			source?.setData(payload);
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
		map.jumpTo({
			center: [centerLng, centerLat],
			zoom,
			pitch: map.getPitch(),
			bearing: map.getBearing()
		});
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

/** Zoom that keeps the camera above the slope. Null when the current view is already clear. */
function zoomAboveRelief(map: MlMap): number | null {
	const center = map.getCenter();
	if (!map.getTerrain() || !Number.isFinite(center.lng) || !Number.isFinite(center.lat)) {
		return null;
	}
	const height = map.getContainer()?.clientHeight || 0;
	const fov = map.getVerticalFieldOfView();
	if (!height || !Number.isFinite(fov)) {
		return null;
	}
	const distancePx = (0.5 / Math.tan((fov * Math.PI) / 360)) * height;
	const step = {
		lng: center.lng,
		lat: center.lat,
		pitch: map.getPitch(),
		bearing: map.getBearing(),
		elevation: map.getCenterElevation()
	};
	let zoom = map.getZoom();
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
