import { RotatableLeafletMap } from './leaflet-rotate-setup';

/**
 * Ctrl + glisser tourne la carte 2D.
 * Même geste que MapLibre (vue 3D) : le déplacement horizontal change le cap,
 * et au-dessus du centre le sens s’inverse pour que la carte suive la main.
 * leaflet-rotate tourne les tuiles à l’envers du bearing MapLibre, d’où le signe moins.
 */
const ROTATE_DEG_PER_PIXEL = 0.8;
const VERTICAL_ORBIT_PX = 100;
const CLICK_TOLERANCE_PX = 3;

export type LeafletCtrlDragRotateHandle = {
	detach(): void;
};

export type LeafletCtrlDragRotateOptions = {
	/** False en vue 3D : le canvas MapLibre gère déjà Ctrl + glisser. */
	enabled?: () => boolean;
	onRotateStart?: () => void;
	onRotate?: (bearing: number) => void;
	onRotateEnd?: () => void;
};

type Point = { x: number; y: number };

function angleDeltaDeg(last: Point, current: Point, center: Point): number {
	const cx = current.x - center.x;
	const cy = current.y - center.y;
	const lx = last.x - center.x;
	const ly = last.y - center.y;
	const cross = cx * ly - cy * lx;
	const dot = cx * lx + cy * ly;
	return Math.atan2(cross, dot) * (180 / Math.PI);
}

function bearingDeltaDeg(last: Point, current: Point, center: Point): number {
	if (Math.abs(center.y - last.y) > VERTICAL_ORBIT_PX) {
		return angleDeltaDeg({ x: last.x, y: current.y }, current, center);
	}
	let delta = (current.x - last.x) * ROTATE_DEG_PER_PIXEL;
	if (current.y < center.y) {
		delta = -delta;
	}
	return delta;
}

export function attachLeafletCtrlDragRotate(
	map: RotatableLeafletMap,
	options: LeafletCtrlDragRotateOptions = {}
): LeafletCtrlDragRotateHandle {
	const container = map.getContainer();
	let active = false;
	let rotating = false;
	let restoreDragging = false;
	let start: Point = { x: 0, y: 0 };
	let last: Point = { x: 0, y: 0 };

	const centerOfMap = (): Point => {
		const rect = container.getBoundingClientRect();
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	};

	const end = (): void => {
		if (!active) {
			return;
		}
		const wasRotating = rotating;
		active = false;
		rotating = false;
		window.removeEventListener('mousemove', onMove, true);
		window.removeEventListener('mouseup', onUp, true);
		window.removeEventListener('blur', onUp, true);
		if (restoreDragging) {
			restoreDragging = false;
			try {
				map.dragging.enable();
			} catch {
				/* map already removed */
			}
		}
		if (wasRotating) {
			options.onRotateEnd?.();
		}
	};

	const onMove = (event: MouseEvent): void => {
		if (!active) {
			return;
		}
		if ((event.buttons & 1) === 0) {
			end();
			return;
		}
		event.preventDefault();
		const current = { x: event.clientX, y: event.clientY };
		if (!rotating) {
			if (Math.hypot(current.x - start.x, current.y - start.y) < CLICK_TOLERANCE_PX) {
				return;
			}
			rotating = true;
			last = start;
			options.onRotateStart?.();
		}
		if (typeof map.getBearing !== 'function' || typeof map.setBearing !== 'function') {
			return;
		}
		const delta = bearingDeltaDeg(last, current, centerOfMap());
		last = current;
		if (Math.abs(delta) < 0.01) {
			return;
		}
		map.setBearing(map.getBearing() - delta);
		const bearing = map.getBearing();
		if (typeof bearing === 'number' && Number.isFinite(bearing)) {
			options.onRotate?.(bearing);
		}
	};

	const onUp = (): void => {
		end();
	};

	const onDown = (event: MouseEvent): void => {
		if (event.button !== 0 || !event.ctrlKey || active) {
			return;
		}
		const target = event.target as Element | null;
		if (target?.closest('.leaflet-control')) {
			return;
		}
		if (options.enabled && !options.enabled()) {
			return;
		}
		if (typeof map.getBearing !== 'function' || typeof map.setBearing !== 'function') {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		active = true;
		rotating = false;
		if (map.dragging.enabled()) {
			map.dragging.disable();
			restoreDragging = true;
		}
		start = { x: event.clientX, y: event.clientY };
		last = start;
		window.addEventListener('mousemove', onMove, true);
		window.addEventListener('mouseup', onUp, true);
		window.addEventListener('blur', onUp, true);
	};

	container.addEventListener('mousedown', onDown, true);

	return {
		detach(): void {
			end();
			try {
				container.removeEventListener('mousedown', onDown, true);
			} catch {
				/* map container may already be gone */
			}
		}
	};
}
