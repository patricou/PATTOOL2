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

/**
 * Maptoolkit basemap drawn by MapLibre inside the Leaflet map.
 * `padding` is a plugin option: a larger canvas so a rotated map still covers the view.
 */
function createMaptoolkitLayer(style: string): L.Layer {
	ensureMaplibreWorker();
	return maplibreGL({
		style,
		interactive: false,
		padding: 0.3
	} as unknown as Parameters<typeof maplibreGL>[0]);
}

export function createMaptoolkitHikingLayer(): L.Layer {
	return createMaptoolkitLayer(MAPTOOLKIT_HIKING_STYLE);
}

export function createMaptoolkitWinterLayer(): L.Layer {
	return createMaptoolkitLayer(MAPTOOLKIT_WINTER_STYLE);
}
