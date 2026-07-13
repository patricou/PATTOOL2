/** Shared weather map popup label logic (Météo-France radar tab + trace viewer). */

export function looksLikeCoordinates(text: string): boolean {
	return /^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(text.trim());
}

export function readAddressField(address: Record<string, unknown>, key: string): string {
	const raw = address[key];
	if (typeof raw !== 'string') {
		return '';
	}
	return raw.trim();
}

export function formatGpsCoordinates(lat: number, lon: number): string {
	return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

/** Reverse-geocode locality for the popup title (Nominatim / Photon / Open-Meteo). */
export function resolvePlaceNameFromGeocode(res: any, lat: number, lon: number): string {
	const displayName = String(res?.displayName || res?.display_name || '').trim();
	let displayFirst = '';
	if (displayName && !looksLikeCoordinates(displayName)) {
		displayFirst = displayName.split(',')[0]?.trim() || '';
	}

	const address = res?.address;
	if (address && typeof address === 'object') {
		const specificKeys = [
			'name',
			'hamlet',
			'village',
			'locality',
			'town',
		];
		for (const key of specificKeys) {
			const value = readAddressField(address, key);
			if (value) {
				return value;
			}
		}
		if (displayFirst) {
			return displayFirst;
		}
		const broaderKeys = [
			'city',
			'municipality',
			'suburb',
			'neighbourhood',
			'neighborhood',
			'county',
			'state',
			'region',
			'road',
			'pedestrian',
			'path',
			'park',
			'natural',
			'water',
			'peak',
			'island',
			'landuse',
		];
		for (const key of broaderKeys) {
			const value = readAddressField(address, key);
			if (value) {
				return value;
			}
		}
	}

	if (displayFirst) {
		return displayFirst;
	}

	return formatGpsCoordinates(lat, lon);
}

export function resolveWeatherPointLocationLabel(options: {
	geocodeName?: string | null;
	openWeatherPlace?: string | null;
	city?: string | null;
	lat: number;
	lon: number;
}): string {
	const name = options.geocodeName?.trim();
	const city = options.city?.trim();
	if (name && !looksLikeCoordinates(name)) {
		if (city && city !== name && !name.includes(city)) {
			return `${name}, ${city}`;
		}
		return name;
	}
	const weatherPlace = options.openWeatherPlace?.trim();
	if (weatherPlace) {
		return weatherPlace;
	}
	if (city) {
		return city;
	}
	if (name) {
		return name;
	}
	return formatGpsCoordinates(options.lat, options.lon);
}

export function extractGeocodeCityName(res: any): string {
	const address = res?.address;
	if (!address || typeof address !== 'object') {
		return '';
	}
	// Prefer actual municipality-level names, not the hamlet itself (geocodeName already covers hamlet).
	return readAddressField(address, 'village')
		|| readAddressField(address, 'town')
		|| readAddressField(address, 'municipality')
		|| readAddressField(address, 'city')
		|| readAddressField(address, 'locality');
}

export function formatDistanceKm(km: number): string {
	if (km < 10) {
		return km.toFixed(1).replace(/\.0$/, '');
	}
	return String(Math.round(km));
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface WeatherStationGridPoint {
	stationId?: string;
	lat?: number;
	lon?: number;
}

export function resolveMfStationDistanceKm(
	clickLat: number,
	clickLon: number,
	mfPoint: any,
	stationId?: string,
	gridPoints?: WeatherStationGridPoint[],
	findNearestGridPoint?: (lat: number, lon: number) => WeatherStationGridPoint | null | undefined
): number | null {
	let stationLat: number | undefined;
	let stationLon: number | undefined;

	const rawStationLat = mfPoint?.stationLat;
	const rawStationLon = mfPoint?.stationLon;
	if (Number.isFinite(Number(rawStationLat)) && Number.isFinite(Number(rawStationLon))) {
		stationLat = Number(rawStationLat);
		stationLon = Number(rawStationLon);
	} else if (gridPoints && findNearestGridPoint) {
		const resolvedStationId = stationId ?? mfPoint?.stationId;
		const gridPoint = resolvedStationId
			? gridPoints.find((p) => p.stationId === String(resolvedStationId))
			: findNearestGridPoint(clickLat, clickLon);
		if (gridPoint && Number.isFinite(gridPoint.lat) && Number.isFinite(gridPoint.lon)) {
			stationLat = gridPoint.lat;
			stationLon = gridPoint.lon;
		}
	}

	if (stationLat == null || stationLon == null) {
		return null;
	}
	return haversineKm(clickLat, clickLon, stationLat, stationLon);
}

export function formatMfStationProximityLabel(
	stationName: string,
	stationId: string,
	distKm: number | null,
	translateNearest: (station: string, km: string) => string
): string {
	const name = stationName?.trim() || stationId?.trim() || '';
	if (!name) {
		return '';
	}
	if (distKm != null && distKm >= 1.5) {
		return translateNearest(name, formatDistanceKm(distKm));
	}
	return name;
}
