import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl } from 'maplibre-gl';
import type * as L from 'leaflet';

/** Community styles. Vector tiles, no API key. Detail stops at zoom 15. */
const MAPTOOLKIT_HIKING_STYLE = 'https://styles.maptoolkit.org/hiking.json';
/** Alpine pistes, nordic trails and lifts. Pistes appear from about zoom 12. */
const MAPTOOLKIT_WINTER_STYLE = 'https://styles.maptoolkit.org/winter.json';

let workerReady = false;

function ensureMaplibreWorker(): void {
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
		gl._glMap?.on('load', () => syncGlLayer(gl));
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

export function createMaptoolkitHikingLayer(): L.Layer {
	return createMaptoolkitLayer(MAPTOOLKIT_HIKING_STYLE);
}

export function createMaptoolkitWinterLayer(): L.Layer {
	return createMaptoolkitLayer(MAPTOOLKIT_WINTER_STYLE);
}
