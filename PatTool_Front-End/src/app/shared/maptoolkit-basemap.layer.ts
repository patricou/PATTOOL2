import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl } from 'maplibre-gl';
import type * as L from 'leaflet';

/** Community styles. Vector tiles, no API key. Detail stops at zoom 15. */
const MAPTOOLKIT_HIKING_STYLE = 'https://styles.maptoolkit.org/hiking.json';
/** Alpine pistes, nordic trails and lifts. Pistes appear from about zoom 12. */
const MAPTOOLKIT_WINTER_STYLE = 'https://styles.maptoolkit.org/winter.json';

const VECTOR_STYLES: Record<string, string> = {
	'maptoolkit-hiking': MAPTOOLKIT_HIKING_STYLE,
	'maptoolkit-winter': MAPTOOLKIT_WINTER_STYLE
};

let workerReady = false;

export function vectorStyleForBasemap(id: string): string | null {
	return VECTOR_STYLES[id] ?? null;
}

export function maptoolkitStyleForBasemap(id: string): string | null {
	if (id === 'maptoolkit-hiking' || id === 'maptoolkit-winter') {
		return VECTOR_STYLES[id];
	}
	return null;
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
	_resizeContainer?: () => void;
	_update?: () => void;
	_transformGL?: (gl: GlMap) => void;
	_zoomEnd?: () => void;
	_resize?: () => void;
	_transitionEnd?: () => void;
	_animateZoom?: () => void;
};

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
			gl._glMap.on('load', () => syncGlLayer(gl));
		}
		return layer;
	};
	return layer;
}

/**
 * Maptoolkit basemap drawn by MapLibre inside the Leaflet map.
 * `padding` is a plugin option: a larger canvas so a rotated map still covers the view.
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
