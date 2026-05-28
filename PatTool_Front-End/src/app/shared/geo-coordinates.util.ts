/** True when both values are usable WGS84 degrees (rejects NaN, null, ±Infinity). */
export function isValidGeoCoordinate(lat: unknown, lng: unknown): boolean {
	return (
		typeof lat === 'number' &&
		typeof lng === 'number' &&
		Number.isFinite(lat) &&
		Number.isFinite(lng)
	);
}
