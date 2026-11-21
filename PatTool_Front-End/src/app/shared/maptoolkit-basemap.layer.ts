import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { Map as MlMap, setWorkerUrl } from 'maplibre-gl';
import { L, RotatableLeafletMap } from './leaflet-rotate-setup';

/** Community styles. Vector tiles, no API key. Detail stops at zoom 15. */
const MAPTOOLKIT_HIKING_STYLE = 'https://styles.maptoolkit.org/hiking.json';
/** Alpine pistes, nordic trails and lifts. Pistes appear from about zoom 12. */
const MAPTOOLKIT_WINTER_STYLE = 'https://styles.maptoolkit.org/winter.json';
const MAPTOOLKIT_SUMMER_STYLE = 'https://styles.maptoolkit.org/summer.json';
const MAPTOOLKIT_CYCLING_STYLE = 'https://styles.maptoolkit.org/cycling.json';
const MAPTOOLKIT_STREET_STYLE = 'https://styles.maptoolkit.org/street.json';
const MAPTOOLKIT_LIGHT_STYLE = 'https://styles.maptoolkit.org/light.json';
const MAPTOOLKIT_DARK_STYLE = 'https://styles.maptoolkit.org/dark.json';

const VECTOR_STYLES: Record<string, string> = {
	'maptoolkit-hiking': MAPTOOLKIT_HIKING_STYLE,
	'maptoolkit-winter': MAPTOOLKIT_WINTER_STYLE,
	'maptoolkit-summer': MAPTOOLKIT_SUMMER_STYLE,
	'maptoolkit-cycling': MAPTOOLKIT_CYCLING_STYLE,
	'maptoolkit-street': MAPTOOLKIT_STREET_STYLE,
	'maptoolkit-light': MAPTOOLKIT_LIGHT_STYLE,
	'maptoolkit-dark': MAPTOOLKIT_DARK_STYLE
};

let workerReady = false;

export function vectorStyleForBasemap(id: string): string | null {
	return VECTOR_STYLES[id] ?? null;
}

export function maptoolkitStyleForBasemap(id: string): string | null {
	if (!id.startsWith('maptoolkit-')) {
		return null;
	}
	return VECTOR_STYLES[id] ?? null;
}

export function isVectorBasemapId(id: string): boolean {
	return vectorStyleForBasemap(id) != null;
}

export function ensureMaplibreWorker(): void {
	if (workerReady || typeof document === 'undefined') {
		return;
	}
	setWorkerUrl(new URL('assets/maplibre-gl-worker.mjs', document.baseURI).href);
	workerReady = true;
}

type GlMap = {
	resize(): void;
	getCanvas(): HTMLCanvasElement;
	on(type: string, fn: () => void): void;
	jumpTo?(options: { center: [number, number]; zoom: number; bearing: number }): void;
	getStyle?(): { layers?: { id: string; type: string }[] } | null | undefined;
	getLayoutProperty?(layerId: string, name: string): unknown;
	setLayoutProperty?(layerId: string, name: string, value: unknown): void;
};

type StyleImageMap = {
	hasImage(id: string): boolean;
	addImage(id: string, image: { width: number; height: number; data: Uint8Array }, options?: { sdf?: boolean }): void;
	setMissingStyleImageResolver(resolver: ((id: string) => void) | null): void;
};

const EMPTY_ICON = new Uint8Array([0, 0, 0, 0]);

/** Styles such as Maptoolkit reference icons absent from the sprite. A blank icon avoids the console warning. */
export function ignoreMissingStyleIcons(map: StyleImageMap): void {
	map.setMissingStyleImageResolver((id) => {
		if (map.hasImage(id)) {
			return;
		}
		try {
			map.addImage(id, { width: 1, height: 1, data: EMPTY_ICON }, { sdf: id.startsWith('sdf:') });
		} catch {
			/* already added by a parallel tile */
		}
	});
}

/** Plugin layer. The methods are replaced so the WebGL canvas is never CSS-transformed. */
type GlLayer = L.Layer & {
	_glMap?: GlMap;
	_zooming?: boolean;
	_container?: HTMLElement;
	_offset?: L.Point;
	_coverKey?: string;
	options: L.LayerOptions & { padding?: number; updateInterval?: number };
	_resizeContainer?: () => void;
	_update?: () => void;
	_throttledUpdate?: () => void;
	_transformGL?: (gl: GlMap) => void;
	_zoomEnd?: () => void;
	_resize?: () => void;
	_transitionEnd?: () => void;
	_animateZoom?: () => void;
	getEvents?: () => { [name: string]: L.LeafletEventHandlerFn };
};

/**
 * The plugin anchors the canvas on the screen's top-left. After a rotation that
 * point is no longer the pane's top-left, so a pan slides the canvas off the view.
 * Center it on the screen, then cancel the pane's CSS rotation: MapLibre paints the
 * bearing itself so place names can stay horizontal.
 */
function placeGlCover(layer: GlLayer): void {
	const map = layer['_map'] as (L.Map & RotatableLeafletMap) | undefined;
	const container = layer._container;
	if (!map || !container) {
		return;
	}
	const size = map.getSize();
	if (!size || size.x < 2 || size.y < 2) {
		return;
	}
	layer._resizeContainer?.();
	const canvasSize = size.multiplyBy(1 + (layer.options.padding ?? 0) * 2);
	const center = map.containerPointToLayerPoint(size.divideBy(2));
	const topLeft = center.subtract(canvasSize.divideBy(2)).round();
	L.DomUtil.setPosition(container, topLeft);
	const leafletBearing = map.getBearing?.() ?? 0;
	const upright = Number.isFinite(leafletBearing) ? -leafletBearing : 0;
	container.style.transformOrigin = '50% 50%';
	container.style.transform = `translate3d(${topLeft.x}px, ${topLeft.y}px, 0) rotate(${upright}deg)`;
	const blendOpacity = (layer as GlLayer & { _blendOpacity?: number })._blendOpacity;
	if (blendOpacity != null) {
		applyGlLayerOpacity(layer, blendOpacity);
	}
	const coverKey = `${Math.round(canvasSize.x)}x${Math.round(canvasSize.y)}`;
	if (layer._coverKey !== coverKey) {
		layer._coverKey = coverKey;
		clearGlCanvasTransform(layer);
		layer._glMap?.resize();
	}
	if (layer._glMap && layer._transformGL) {
		layer._transformGL(layer._glMap);
	}
	clearGlCanvasTransform(layer);
}

/**
 * Leaflet rotates the pane clockwise. MapLibre's bearing is the opposite direction,
 * so -leafletBearing paints the same geography. Viewport alignment keeps names level.
 */
function syncGlBearing(layer: GlLayer, glMap: GlMap): void {
	const map = layer['_map'] as (L.Map & RotatableLeafletMap) | undefined;
	if (!map || !glMap.jumpTo) {
		return;
	}
	const center = map.getCenter();
	const leafletBearing = map.getBearing?.() ?? 0;
	glMap.jumpTo({
		center: [center.lng, center.lat],
		zoom: map.getZoom() - 1,
		bearing: Number.isFinite(leafletBearing) ? -leafletBearing : 0
	});
}

function keepLabelsHorizontal(glMap: GlMap): void {
	const layers = glMap.getStyle?.()?.layers;
	if (!layers || !glMap.setLayoutProperty || !glMap.getLayoutProperty) {
		return;
	}
	for (const symbol of layers) {
		if (symbol.type !== 'symbol') {
			continue;
		}
		try {
			if (glMap.getLayoutProperty(symbol.id, 'text-rotation-alignment') !== 'viewport') {
				glMap.setLayoutProperty(symbol.id, 'text-rotation-alignment', 'viewport');
			}
		} catch {
			/* icon-only layer, or the style is still loading */
		}
	}
}

/**
 * Chrome on Windows presents a blank WebGL canvas when it carries a CSS transform
 * (Leaflet writes one on every zoom and resize) or when the context is created with
 * powerPreference "high-performance" on a dual-GPU PC. Phones have a single GPU and
 * do not hit this, so the same map draws there and stays gray here.
 */
function clearGlCanvasTransform(layer: GlLayer): void {
	const canvas = layer._glMap?.getCanvas?.();
	if (!canvas) {
		return;
	}
	canvas.classList.remove('leaflet-zoom-animated');
	canvas.style.setProperty('transform', 'none', 'important');
	canvas.style.setProperty('max-width', 'none', 'important');
	canvas.style.setProperty('max-height', 'none', 'important');
	const blendOpacity = (layer as GlLayer & { _blendOpacity?: number })._blendOpacity;
	if (blendOpacity != null) {
		paintGlCanvases(layer, blendOpacity);
	}
}

/**
 * Opacity has to be on the WebGL canvas. On phones and on Chrome the canvas is its own
 * compositor layer, so an opacity on the Leaflet div around it never changes the picture.
 */
export function applyGlLayerOpacity(layer: L.Layer, opacity: number): void {
	const gl = layer as GlLayer & { _blendOpacity?: number; _blendOpacityHooked?: boolean };
	const clamped = Math.max(0, Math.min(1, opacity));
	gl._blendOpacity = clamped;
	paintGlCanvases(gl, clamped);
	const map = gl._glMap;
	if (!map || gl._blendOpacityHooked) {
		return;
	}
	gl._blendOpacityHooked = true;
	const refresh = (): void => {
		if (gl._blendOpacity == null) {
			return;
		}
		paintGlCanvases(gl, gl._blendOpacity);
	};
	map.on?.('load', refresh);
	map.on?.('idle', refresh);
}

function paintGlCanvases(layer: GlLayer, opacity: number): void {
	const css = String(Math.max(0, Math.min(1, opacity)));
	const paint = (node: Element | null | undefined): void => {
		if (!(node instanceof HTMLElement)) {
			return;
		}
		node.style.setProperty('opacity', css, 'important');
	};
	if (layer._container) {
		layer._container.style.setProperty('background', 'transparent', 'important');
	}
	layer._container?.querySelectorAll('.maplibregl-canvas-container').forEach((node) => {
		if (node instanceof HTMLElement) {
			node.style.setProperty('background', 'transparent', 'important');
		}
	});
	const glMap = layer._glMap as (GlMap & { _actualCanvas?: HTMLCanvasElement }) | undefined;
	paint(glMap?.getCanvas?.());
	paint(glMap?._actualCanvas);
	layer._container?.querySelectorAll('canvas').forEach((node) => paint(node));
	(glMap as { triggerRepaint?: () => void } | undefined)?.triggerRepaint?.();
}

function syncGlLayer(layer: GlLayer): void {
	if (!layer._glMap) {
		return;
	}
	layer._zooming = false;
	layer._resizeContainer?.();
	clearGlCanvasTransform(layer);
	layer._glMap.resize();
	layer._update?.();
	clearGlCanvasTransform(layer);
}

function stabilizeMaplibreLayer(layer: L.Layer): L.Layer {
	const gl = layer as GlLayer;
	const originalOnAdd = layer.onAdd?.bind(layer);
	const originalGetEvents = gl.getEvents?.bind(gl);

	gl._update = () => {
		const map = gl['_map'] as L.Map | undefined;
		if (!map) {
			return;
		}
		gl._offset = map.containerPointToLayerPoint(L.point(0, 0));
		if (gl._zooming) {
			return;
		}
		placeGlCover(gl);
	};
	gl._throttledUpdate = L.Util.throttle(gl._update, gl.options.updateInterval ?? 32, gl);
	gl._transformGL = (glMap: GlMap) => {
		syncGlBearing(gl, glMap);
	};
	gl.getEvents = () => {
		const events = originalGetEvents ? originalGetEvents() : {};
		if (gl._throttledUpdate) {
			events['move'] = gl._throttledUpdate;
			events['rotate'] = gl._throttledUpdate;
		}
		return events;
	};

	gl._zoomEnd = () => syncGlLayer(gl);
	gl._resize = () => syncGlLayer(gl);
	gl._transitionEnd = () => syncGlLayer(gl);
	gl._animateZoom = () => {
		if (gl._glMap && gl._transformGL) {
			gl._transformGL(gl._glMap);
		}
		clearGlCanvasTransform(gl);
	};
	(layer as { onAdd(map: L.Map): L.Layer }).onAdd = (map: L.Map) => {
		try {
			originalOnAdd?.(map);
		} catch (err) {
			console.error('[Maptoolkit] WebGL map failed to start', err);
			return layer;
		}
		clearGlCanvasTransform(gl);
		if (gl._glMap) {
			ignoreMissingStyleIcons(gl._glMap as unknown as StyleImageMap);
			let aligningLabels = false;
			const alignLabels = (): void => {
				if (aligningLabels || !gl._glMap) {
					return;
				}
				aligningLabels = true;
				try {
					keepLabelsHorizontal(gl._glMap);
				} finally {
					aligningLabels = false;
				}
			};
			gl._glMap.on('load', () => {
				syncGlLayer(gl);
				alignLabels();
			});
			gl._glMap.on('styledata', alignLabels);
		}
		return layer;
	};
	return layer;
}

/**
 * Maptoolkit basemap drawn by MapLibre inside the Leaflet map.
 * The canvas is counter-rotated against the Leaflet pane and MapLibre receives the
 * bearing, so the terrain turns while place names stay horizontal.
 */
function createMaptoolkitLayer(style: string): L.Layer {
	ensureMaplibreWorker();
	const layer = maplibreGL({
		style,
		interactive: false,
		padding: 0.3,
		canvasContextAttributes: {
			powerPreference: 'default',
			preserveDrawingBuffer: true,
			failIfMajorPerformanceCaveat: false
		}
	} as unknown as Parameters<typeof maplibreGL>[0]);
	return stabilizeMaplibreLayer(layer);
}

export function createVectorBasemapLayer(id: string): L.Layer | null {
	const style = vectorStyleForBasemap(id);
	return style ? createMaptoolkitLayer(style) : null;
}

export function createMaptoolkitHikingLayer(): L.Layer {
	return createMaptoolkitLayer(MAPTOOLKIT_HIKING_STYLE);
}

export function createMaptoolkitWinterLayer(): L.Layer {
	return createMaptoolkitLayer(MAPTOOLKIT_WINTER_STYLE);
}

/**
 * Second Maptoolkit map drawn over the flat view.
 * Opacity sits on a plain div, the same way the pitched view fades its overlay.
 * A Leaflet WebGL layer ignores that opacity, so the 1–2 slider did nothing.
 */
export class FlatMaptoolkitBlend {
	private map: MlMap | null = null;
	private host: HTMLDivElement | null = null;
	private frame: HTMLDivElement | null = null;
	private styleUrl = '';

	mount(pane: HTMLElement, styleUrl: string, onReady?: () => void): void {
		this.destroy();
		ensureMaplibreWorker();
		const host = document.createElement('div');
		host.className = 'trace-flat-gl-blend';
		const frame = document.createElement('div');
		frame.className = 'trace-flat-gl-blend-frame';
		host.appendChild(frame);
		pane.appendChild(host);
		this.host = host;
		this.frame = frame;
		this.styleUrl = styleUrl;
		const map = new MlMap({
			container: frame,
			style: styleUrl,
			center: [0, 0],
			zoom: 1,
			pitch: 0,
			bearing: 0,
			interactive: false,
			attributionControl: false,
			fadeDuration: 0,
			canvasContextAttributes: {
				alpha: true,
				powerPreference: 'default',
				failIfMajorPerformanceCaveat: false
			}
		});
		ignoreMissingStyleIcons(map as unknown as StyleImageMap);
		this.map = map;
		map.once('load', () => {
			if (this.map !== map) {
				return;
			}
			map.resize();
			onReady?.();
		});
	}

	setStyle(styleUrl: string, onReady?: () => void): void {
		const map = this.map;
		if (!map || this.styleUrl === styleUrl) {
			return;
		}
		this.styleUrl = styleUrl;
		map.setStyle(styleUrl, { diff: false });
		map.once('style.load', () => {
			if (this.map !== map) {
				return;
			}
			ignoreMissingStyleIcons(map as unknown as StyleImageMap);
			onReady?.();
		});
	}

	setOpacity(opacity: number): void {
		if (!this.host) {
			return;
		}
		const clamped = Math.max(0, Math.min(1, opacity));
		this.host.style.setProperty('opacity', String(clamped), 'important');
	}

	sync(view: {
		lng: number;
		lat: number;
		zoom: number;
		bearing: number;
		width: number;
		height: number;
		x: number;
		y: number;
	}): void {
		const host = this.host;
		const frame = this.frame;
		const map = this.map;
		if (!host || !frame || !map || view.width < 2 || view.height < 2) {
			return;
		}
		const width = `${Math.round(view.width)}px`;
		const height = `${Math.round(view.height)}px`;
		if (host.style.width !== width || host.style.height !== height) {
			host.style.width = width;
			host.style.height = height;
			map.resize();
		}
		host.style.left = `${Math.round(view.x)}px`;
		host.style.top = `${Math.round(view.y)}px`;
		const turn = Math.abs(view.bearing) > 0.05 ? `rotate(${view.bearing}deg)` : 'none';
		if (frame.style.transform !== turn) {
			frame.style.transform = turn;
		}
		const center = map.getCenter();
		const same = Math.abs(center.lng - view.lng) < 1e-7
			&& Math.abs(center.lat - view.lat) < 1e-7
			&& Math.abs(map.getZoom() - view.zoom) < 1e-3
			&& Math.abs(map.getBearing() - view.bearing) < 0.05
			&& Math.abs(map.getPitch()) < 0.05;
		if (!same) {
			map.jumpTo({
				center: [view.lng, view.lat],
				zoom: view.zoom,
				bearing: view.bearing,
				pitch: 0
			});
		}
	}

	destroy(): void {
		this.map?.remove();
		this.map = null;
		this.host?.remove();
		this.host = null;
		this.frame = null;
		this.styleUrl = '';
	}
}
