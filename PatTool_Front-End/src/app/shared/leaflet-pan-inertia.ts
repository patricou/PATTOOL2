import { L } from './leaflet-rotate-setup';

export type LeafletPanInertiaHandle = {
	detach(): void;
};

/**
 * Courte glissade après le relâchement.
 * L’inertie Leaflet ne regarde que les ~50 dernières ms : à la souris le pointeur
 * est souvent déjà arrêté, et la carte se fige. Ici on prend ~160 ms, puis on
 * limite la distance pour que ça reste un petit élan.
 */
export function attachLeafletPanInertia(map: L.Map): LeafletPanInertiaHandle {
	const samples: { x: number; y: number; t: number }[] = [];
	const windowMs = 160;
	const maxCoastPx = 34;
	const minCoastPx = 3;
	const deceleration = 5200;
	let coastFrame: number | null = null;

	const panePos = (): L.Point | null => {
		const pane = (map as L.Map & { _mapPane?: HTMLElement })._mapPane;
		if (!pane) {
			return null;
		}
		return L.DomUtil.getPosition(pane);
	};

	const onDragStart = (): void => {
		if (coastFrame != null) {
			cancelAnimationFrame(coastFrame);
			coastFrame = null;
		}
		samples.length = 0;
		const pos = panePos();
		if (pos) {
			samples.push({ x: pos.x, y: pos.y, t: performance.now() });
		}
	};

	const onDrag = (): void => {
		const pos = panePos();
		if (!pos) {
			return;
		}
		const now = performance.now();
		samples.push({ x: pos.x, y: pos.y, t: now });
		const cutoff = now - windowMs;
		while (samples.length > 2 && samples[0].t < cutoff) {
			samples.shift();
		}
	};

	const onDragEnd = (): void => {
		if (samples.length < 2) {
			return;
		}
		const first = samples[0];
		const last = samples[samples.length - 1];
		const dt = (last.t - first.t) / 1000;
		if (dt < 0.02) {
			return;
		}
		const dx = last.x - first.x;
		const dy = last.y - first.y;
		const dist = Math.hypot(dx, dy);
		if (dist < 4) {
			return;
		}
		const speed = dist / dt;
		const duration = Math.min(0.24, speed / deceleration);
		let coast = (speed * duration) / 2;
		if (coast > maxCoastPx) {
			coast = maxCoastPx;
		}
		if (coast < minCoastPx) {
			return;
		}
		const scale = coast / dist;
		const offset = L.point(-dx * scale, -dy * scale);
		coastFrame = requestAnimationFrame(() => {
			coastFrame = null;
			const container = map.getContainer();
			if (!container?.isConnected) {
				return;
			}
			map.panBy(offset, {
				animate: true,
				duration,
				easeLinearity: 0.25,
				noMoveStart: true
			});
		});
	};

	map.on('dragstart', onDragStart);
	map.on('drag', onDrag);
	map.on('dragend', onDragEnd);
	return {
		detach(): void {
			if (coastFrame != null) {
				cancelAnimationFrame(coastFrame);
				coastFrame = null;
			}
			map.off('dragstart', onDragStart);
			map.off('drag', onDrag);
			map.off('dragend', onDragEnd);
		}
	};
}
