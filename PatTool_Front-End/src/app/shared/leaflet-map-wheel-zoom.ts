import { L, RotatableLeafletMap } from './leaflet-rotate-setup';

/**
 * Zoom molette fluide, tuiles + vecteurs (tracé) en même temps.
 * Leaflet scrollWheelZoom anime le fond d’abord ; avec leaflet-rotate le SVG suit après.
 */
export const LEAFLET_SMOOTH_WHEEL_MAP_OPTIONS: Partial<L.MapOptions> = {
	zoomDelta: 1,
	zoomSnap: 0,
	scrollWheelZoom: false
};

export type LeafletMapWheelZoomHandle = {
	detach(): void;
};

export type LeafletMapWheelZoomOptions = {
	/** Shift + molette = rotation (trace viewer). */
	shiftRotates?: boolean;
	afterZoom?: (zoom: number) => void;
};

function normalizeMapWheelDelta(event: WheelEvent): number {
	if (event.deltaMode === 0) {
		return event.deltaY / 160;
	}
	if (event.deltaMode === 1) {
		return event.deltaY / 5;
	}
	return event.deltaY / 0.9;
}

function applyMapWheelZoomFromDelta(delta: number, current: number, minZoom: number, maxZoom: number): number {
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

export function attachLeafletMapWheelZoom(
	map: L.Map,
	options: LeafletMapWheelZoomOptions = {}
): LeafletMapWheelZoomHandle {
	let accum = 0;
	let rafId: number | null = null;
	const point = { x: 0, y: 0 };

	const flush = (): void => {
		rafId = null;
		const delta = accum;
		accum = 0;
		if (Math.abs(delta) < 0.0001) {
			return;
		}

		const minZoom = map.getMinZoom();
		const maxZoom = map.getMaxZoom();
		const oldZoom = map.getZoom();
		const newZoom = applyMapWheelZoomFromDelta(delta, oldZoom, minZoom, maxZoom);
		if (Math.abs(newZoom - oldZoom) < 0.0005) {
			return;
		}

		const container = map.getContainer();
		const rect = container.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			const latlng = map.containerPointToLatLng(L.point(point.x, point.y));
			map.setZoomAround(latlng, newZoom, { animate: false });
		} else {
			map.setZoom(newZoom, { animate: false });
		}
		options.afterZoom?.(newZoom);
	};

	const onWheel = (event: WheelEvent): void => {
		event.preventDefault();

		if (options.shiftRotates && event.shiftKey) {
			const rotatable = map as RotatableLeafletMap;
			if (typeof rotatable.setBearing === 'function' && typeof rotatable.getBearing === 'function') {
				const deltaDeg = 5 * Math.sign(event.deltaY || 1);
				rotatable.setBearing(rotatable.getBearing() + deltaDeg);
			}
			return;
		}

		const container = map.getContainer();
		const rect = container.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			point.x = event.clientX - rect.left;
			point.y = event.clientY - rect.top;
		}

		accum += normalizeMapWheelDelta(event);
		if (rafId != null) {
			return;
		}
		rafId = requestAnimationFrame(flush);
	};

	map.getContainer().addEventListener('wheel', onWheel, { passive: false });

	return {
		detach(): void {
			if (rafId != null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			accum = 0;
			try {
				map.getContainer().removeEventListener('wheel', onWheel);
			} catch {
				/* map container may already be gone */
			}
		}
	};
}
