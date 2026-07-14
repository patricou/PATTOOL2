export const START_LOCATION_NA = 'N/A';
export const START_LOCATION_DISPLAY_MAX_LENGTH = 30;
export const START_LOCATION_DISPLAY_MAX_LENGTH_MOBILE = 20;
export function normalizeStartLocation(value?: string | null): string {
	const trimmed = (value ?? '').trim();
	if (!trimmed) {
		return START_LOCATION_NA;
	}
	const upper = trimmed.toUpperCase();
	if (upper === 'NA' || upper === 'N/A') {
		return START_LOCATION_NA;
	}
	const token = trimmed.replace(/[\s./_-]+/g, '').toUpperCase();
	if (token === 'NA') {
		return START_LOCATION_NA;
	}
	return trimmed;
}

/** Short label for event cards (max 30 chars by default). */
export function formatStartLocationDisplay(
	value?: string | null,
	maxLength = START_LOCATION_DISPLAY_MAX_LENGTH
): string {
	const normalized = normalizeStartLocation(value);
	if (normalized === START_LOCATION_NA || normalized.length <= maxLength) {
		return normalized;
	}
	return normalized.slice(0, maxLength) + '…';
}

/** Full location for tooltip when display text is truncated. */
export function getStartLocationTooltip(
	value?: string | null,
	maxLength = START_LOCATION_DISPLAY_MAX_LENGTH
): string | null {
	const normalized = normalizeStartLocation(value);
	if (normalized === START_LOCATION_NA || normalized.length <= maxLength) {
		return null;
	}
	return normalized;
}

/** Whether a departure/start location should show map actions (excludes NA, N/A, etc.). */
export function hasValidDepartureLocation(location?: string | null): boolean {
	return normalizeStartLocation(location) !== START_LOCATION_NA;
}
