/**
 * Leaflet + leaflet-rotate bootstrap (single L instance for the app).
 * Import this once before creating any rotatable map.
 *
 * Leaflet's UMD build sets window.L; leaflet-rotate then patches that same global.
 */
import * as L from 'leaflet';
import 'leaflet-rotate';

// Plugin defaults rotateControl: true on every map — opt in per map instead.
L.Map.mergeOptions({ rotateControl: false });

export { L };
export type RotatableLeafletMap = L.Map & {
	setBearing?: (bearing: number) => void;
	getBearing?: () => number;
};
