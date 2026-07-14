/** Observation station point for map temperature labels (MF DPObs / MeteoSwiss SMN). */
export interface WeatherStationGridPoint {
	lat: number;
	lon: number;
	tempC: number;
	stationId?: string;
	stationName?: string;
	stationLat?: number;
	stationLon?: number;
	humidityPct?: number;
	windDirectionDeg?: number;
	windSpeedMs?: number;
	windGustMs?: number;
	dewPointC?: number;
	precipitationMm?: number;
	pressureHpa?: number;
	observedAt?: string;
	source?: string;
	interpolated?: boolean;
	cached?: boolean;
	altitudeM?: number;
}

export type WeatherStationProvider = 'mf' | 'ms';
export type WeatherStationBrand = 'meteofrance' | 'meteoswiss';

export const MF_OBS_VIEWPORT_BOUNDS = {
	south: 42.0,
	north: 51.2,
	west: -5.2,
	east: 8.5,
};

export const CH_OBS_VIEWPORT_BOUNDS = {
	south: 45.82,
	north: 47.81,
	west: 5.96,
	east: 10.49,
};

const TEMP_LABEL_LOGO_EXTRA_PX = 24;
const TEMPERATURE_LABEL_MIN_PX_X = 44;
const TEMPERATURE_LABEL_MIN_PX_Y = 22;

export function isCoordinateInFranceMetropole(lat: number, lon: number): boolean {
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		return false;
	}
	const b = MF_OBS_VIEWPORT_BOUNDS;
	return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

export function isCoordinateInSwitzerland(lat: number, lon: number): boolean {
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		return false;
	}
	const b = CH_OBS_VIEWPORT_BOUNDS;
	return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

/** Same border rule as Météo-France: CH outside MF overlap, else MF when in France bbox. */
export function resolveWeatherStationProvider(lat: number, lon: number, countryCode?: string): WeatherStationProvider | null {
	const code = (countryCode || '').trim().toUpperCase();
	if (code === 'CH') {
		return 'ms';
	}
	if (code === 'FR') {
		return 'mf';
	}
	if (code) {
		return null;
	}
	if (isCoordinateInSwitzerland(lat, lon) && !isCoordinateInFranceMetropole(lat, lon)) {
		return 'ms';
	}
	if (isCoordinateInFranceMetropole(lat, lon)) {
		return 'mf';
	}
	return null;
}

export function computeWeatherStationCapacity(zoom: number): { maxStations: number; debounceMs: number } {
	if (zoom <= 7) {
		return { maxStations: 22, debounceMs: 550 };
	}
	if (zoom <= 9) {
		return { maxStations: 45, debounceMs: 420 };
	}
	return { maxStations: 72, debounceMs: 350 };
}

export function toOptionalNumber(value: unknown): number | undefined {
	const num = Number(value);
	return Number.isFinite(num) ? num : undefined;
}

export function normalizeWeatherStationGridPoint(point: any, responseCached = false): WeatherStationGridPoint {
	const stationLat = toOptionalNumber(point?.stationLat);
	const stationLon = toOptionalNumber(point?.stationLon);
	const normalized: WeatherStationGridPoint = {
		lat: Number(point?.lat),
		lon: Number(point?.lon),
		tempC: Number(point?.tempC),
		stationId: point?.stationId,
		stationName: point?.stationName,
		stationLat,
		stationLon,
		humidityPct: toOptionalNumber(point?.humidityPct),
		windDirectionDeg: toOptionalNumber(point?.windDirectionDeg),
		windSpeedMs: toOptionalNumber(point?.windSpeedMs),
		windGustMs: toOptionalNumber(point?.windGustMs),
		dewPointC: toOptionalNumber(point?.dewPointC),
		precipitationMm: toOptionalNumber(point?.precipitationMm),
		pressureHpa: toOptionalNumber(point?.pressureHpa),
		observedAt: point?.observedAt,
		source: point?.source,
		interpolated: point?.interpolated === true,
		cached: point?.cached === true || responseCached,
	};
	return applyStationMarkerCoordinates(normalized);
}

export function applyStationMarkerCoordinates(point: WeatherStationGridPoint): WeatherStationGridPoint {
	if (!point.stationId || point.interpolated) {
		return point;
	}
	const markerLat = Number.isFinite(point.stationLat) ? point.stationLat! : point.lat;
	const markerLon = Number.isFinite(point.stationLon) ? point.stationLon! : point.lon;
	if (!Number.isFinite(markerLat) || !Number.isFinite(markerLon)) {
		return point;
	}
	return {
		...point,
		lat: markerLat,
		lon: markerLon,
		stationLat: markerLat,
		stationLon: markerLon,
	};
}

export function stationMarkerLatLng(point: WeatherStationGridPoint): [number, number] {
	return [point.lat, point.lon];
}

export function isMfStationLabelPoint(
	point: WeatherStationGridPoint,
	labelSource: 'meteofrance-dpobs' | 'meteoswiss-smn' | null
): boolean {
	if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || !Number.isFinite(point.tempC)) {
		return false;
	}
	if (point.interpolated) {
		return false;
	}
	const source = String(point.source || '').toLowerCase();
	if (source.includes('meteoswiss')) {
		return false;
	}
	if (source.includes('meteofrance')) {
		return true;
	}
	if (point.stationId) {
		return labelSource === 'meteofrance-dpobs';
	}
	return false;
}

export function isMsStationLabelPoint(
	point: WeatherStationGridPoint,
	labelSource: 'meteofrance-dpobs' | 'meteoswiss-smn' | null
): boolean {
	if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || !Number.isFinite(point.tempC)) {
		return false;
	}
	if (point.interpolated) {
		return false;
	}
	const source = String(point.source || '').toLowerCase();
	if (source.includes('meteofrance')) {
		return false;
	}
	if (source.includes('meteoswiss')) {
		return true;
	}
	if (point.stationId) {
		return labelSource === 'meteoswiss-smn';
	}
	return false;
}

export function filterStationLabelPoints(
	points: WeatherStationGridPoint[],
	provider: WeatherStationProvider,
	labelSource: 'meteofrance-dpobs' | 'meteoswiss-smn' | null
): WeatherStationGridPoint[] {
	return points.filter((point) =>
		provider === 'ms'
			? isMsStationLabelPoint(point, labelSource)
			: isMfStationLabelPoint(point, labelSource)
	);
}

export function formatWeatherStationTemperatureLabel(tempC: number): string {
	return `${Math.round(tempC)}°C`;
}

export function estimateWeatherStationLabelWidth(tempLabel: string): number {
	return Math.max(40, tempLabel.length * 7 + 12 + TEMP_LABEL_LOGO_EXTRA_PX);
}

export function escapeWeatherStationHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export function buildWeatherStationBrandLogoHtml(
	brand: WeatherStationBrand,
	logoSrc: string,
	brandAlt: string,
	size = 14
): string {
	const alt = escapeWeatherStationHtml(brandAlt);
	const mfClass = brand === 'meteofrance' ? ' mf-temp-source-logo--meteofrance' : '';
	return `<img class="mf-temp-source-logo${mfClass}" src="${logoSrc}" alt="${alt}" width="${size}" height="${size}" loading="lazy" />`;
}

export interface WeatherStationTooltipContext {
	translate: (key: string) => string;
	labelSource: 'meteofrance-dpobs' | 'meteoswiss-smn' | null;
	brandLogos: Record<WeatherStationBrand, string>;
	brandAlts: Record<WeatherStationBrand, string>;
}

export function isMeteoFranceStationPoint(
	point: WeatherStationGridPoint,
	labelSource: 'meteofrance-dpobs' | 'meteoswiss-smn' | null
): boolean {
	if (point.interpolated) {
		return false;
	}
	const source = String(point.source || '').toLowerCase();
	if (source.includes('meteofrance')) {
		return true;
	}
	if (source.includes('meteoswiss')) {
		return false;
	}
	if (labelSource === 'meteofrance-dpobs' && point.stationId) {
		return true;
	}
	return !!point.stationId && isCoordinateInFranceMetropole(point.lat, point.lon);
}

export function isMeteoSwissStationPoint(
	point: WeatherStationGridPoint,
	labelSource: 'meteofrance-dpobs' | 'meteoswiss-smn' | null
): boolean {
	if (point.interpolated) {
		return false;
	}
	const source = String(point.source || '').toLowerCase();
	if (source.includes('meteoswiss')) {
		return true;
	}
	if (source.includes('meteofrance')) {
		return false;
	}
	if (labelSource === 'meteoswiss-smn' && point.stationId) {
		return true;
	}
	return !!point.stationId && isCoordinateInSwitzerland(point.lat, point.lon);
}

export function isObsWeatherStationPoint(
	point: WeatherStationGridPoint,
	labelSource: 'meteofrance-dpobs' | 'meteoswiss-smn' | null
): boolean {
	if (point.interpolated || !point.stationId) {
		return false;
	}
	return isMeteoFranceStationPoint(point, labelSource) || isMeteoSwissStationPoint(point, labelSource);
}

export function resolveWeatherStationPointBrand(
	point: WeatherStationGridPoint,
	labelSource: 'meteofrance-dpobs' | 'meteoswiss-smn' | null
): WeatherStationBrand {
	const source = String(point.source || '').toLowerCase();
	if (source.includes('meteoswiss')) {
		return 'meteoswiss';
	}
	if (point.stationId || source.includes('meteofrance')) {
		return 'meteofrance';
	}
	return labelSource === 'meteoswiss-smn' ? 'meteoswiss' : 'meteofrance';
}

function weatherStationTooltipRow(label: string, value: string): string {
	return `<div class="mf-temp-tooltip-row"><span>${escapeWeatherStationHtml(label)}</span><strong>${value}</strong></div>`;
}

function weatherStationTooltipRowWithBrand(
	label: string,
	value: string,
	brand: WeatherStationBrand,
	ctx: WeatherStationTooltipContext
): string {
	const logo = buildWeatherStationBrandLogoHtml(brand, ctx.brandLogos[brand], ctx.brandAlts[brand], 16);
	return (
		`<div class="mf-temp-tooltip-row mf-temp-tooltip-row--with-brand">` +
		`<span>${escapeWeatherStationHtml(label)}</span>` +
		`<strong class="mf-temp-tooltip-value-with-logo">${logo}${escapeWeatherStationHtml(value)}</strong>` +
		`</div>`
	);
}

function formatWeatherStationDateTime(date: Date): string {
	if (Number.isNaN(date.getTime())) {
		return '';
	}
	return date.toLocaleString(undefined, {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

export function formatWeatherStationObservedAt(value: string): string {
	const trimmed = value.trim();
	if (/^\d{10}$/.test(trimmed)) {
		const date = new Date(Number(trimmed) * 1000);
		return Number.isNaN(date.getTime()) ? trimmed : formatWeatherStationDateTime(date);
	}
	if (/^\d{13}$/.test(trimmed)) {
		const date = new Date(Number(trimmed));
		return Number.isNaN(date.getTime()) ? trimmed : formatWeatherStationDateTime(date);
	}
	const date = new Date(trimmed);
	if (Number.isNaN(date.getTime())) {
		return trimmed;
	}
	return formatWeatherStationDateTime(date);
}

function resolveWeatherStationTooltipTitle(
	point: WeatherStationGridPoint,
	ctx: WeatherStationTooltipContext
): string {
	const name = point.stationName?.trim();
	if (name) {
		return name;
	}
	if (point.stationId) {
		return `${ctx.translate('METEO_FRANCE.TOOLTIP_STATION')} ${point.stationId}`;
	}
	const isMf = point.source === 'meteofrance-dpobs';
	return ctx.translate(isMf ? 'METEO_FRANCE.TOOLTIP_STATION_MF' : 'METEO_FRANCE.TOOLTIP_OPENMETEO');
}

function formatWeatherStationAltitudeLabel(altitudeM: number | undefined): string | null {
	if (altitudeM == null || !Number.isFinite(altitudeM)) {
		return null;
	}
	return `${Math.round(altitudeM)} m`;
}

export function buildWeatherStationTooltipHtml(
	point: WeatherStationGridPoint,
	ctx: WeatherStationTooltipContext
): string {
	const lines: string[] = [];
	const stationTitle = resolveWeatherStationTooltipTitle(point, ctx);
	lines.push(`<div class="mf-temp-tooltip-title">${escapeWeatherStationHtml(stationTitle)}</div>`);
	if (point.stationName && point.stationId) {
		lines.push(`<div class="mf-temp-tooltip-meta">${escapeWeatherStationHtml(point.stationId)}</div>`);
	}

	if (isObsWeatherStationPoint(point, ctx.labelSource)) {
		const altitudeLabel = formatWeatherStationAltitudeLabel(point.altitudeM);
		if (altitudeLabel) {
			lines.push(weatherStationTooltipRow(
				ctx.translate('METEO_FRANCE.TOOLTIP_STATION_ALTITUDE'),
				escapeWeatherStationHtml(altitudeLabel)
			));
		}
	}

	if (point.interpolated) {
		lines.push(`<div class="mf-temp-tooltip-meta">${escapeWeatherStationHtml(ctx.translate('METEO_FRANCE.TOOLTIP_INTERPOLATED'))}</div>`);
	}

	lines.push(weatherStationTooltipRowWithBrand(
		ctx.translate('METEO_FRANCE.TEMPERATURE'),
		formatWeatherStationTemperatureLabel(point.tempC),
		resolveWeatherStationPointBrand(point, ctx.labelSource),
		ctx
	));

	if (point.humidityPct != null) {
		lines.push(weatherStationTooltipRow(
			ctx.translate('METEO_FRANCE.HUMIDITY'),
			`${Math.round(point.humidityPct)}%`
		));
	}
	if (point.dewPointC != null) {
		lines.push(weatherStationTooltipRow(
			ctx.translate('METEO_FRANCE.TOOLTIP_DEWPOINT'),
			formatWeatherStationTemperatureLabel(point.dewPointC)
		));
	}
	if (point.windSpeedMs != null) {
		const wind = point.windDirectionDeg != null
			? `${point.windSpeedMs} m/s (${Math.round(point.windDirectionDeg)}°)`
			: `${point.windSpeedMs} m/s`;
		lines.push(weatherStationTooltipRow(ctx.translate('METEO_FRANCE.WIND'), wind));
	}
	if (point.windGustMs != null) {
		lines.push(weatherStationTooltipRow(
			ctx.translate('METEO_FRANCE.TOOLTIP_WIND_GUST'),
			`${point.windGustMs} m/s`
		));
	}
	if (point.precipitationMm != null) {
		lines.push(weatherStationTooltipRow(
			ctx.translate('METEO_FRANCE.PRECIP'),
			`${point.precipitationMm} mm`
		));
	}
	if (point.pressureHpa != null) {
		lines.push(weatherStationTooltipRow(
			ctx.translate('METEO_FRANCE.PRESSURE'),
			`${point.pressureHpa} hPa`
		));
	}
	if (point.observedAt) {
		lines.push(weatherStationTooltipRow(
			ctx.translate('METEO_FRANCE.TOOLTIP_OBSERVED_AT'),
			escapeWeatherStationHtml(formatWeatherStationObservedAt(point.observedAt))
		));
	}
	if (point.cached) {
		lines.push(`<div class="mf-temp-tooltip-meta">${escapeWeatherStationHtml(ctx.translate('METEO_FRANCE.TEMPERATURE_TOOLTIP_CACHED'))}</div>`);
	}

	return lines.join('');
}

export function buildWeatherStationLabelHtml(
	tempC: number,
	brand: WeatherStationBrand,
	logoSrc: string,
	brandAlt: string
): string {
	const value = formatWeatherStationTemperatureLabel(tempC);
	const pillStyle =
		'display:inline-flex;align-items:center;gap:6px;padding:2px 8px 2px 6px;' +
		'border-radius:4px;background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.15);' +
		'box-shadow:0 1px 3px rgba(0,0,0,0.2);font-size:0.78rem;font-weight:700;color:#1a1a1a;' +
		'white-space:nowrap;transform:translate(-50%,-50%);';
	return (
		`<span class="mf-temp-label-inner" style="${pillStyle}">` +
		`${buildWeatherStationBrandLogoHtml(brand, logoSrc, brandAlt)}` +
		`<span class="mf-temp-label-value">${value}</span>` +
		`</span>`
	);
}

function temperatureLabelRectOverlaps(
	rect: { x: number; y: number; w: number; h: number },
	placed: Array<{ x: number; y: number; w: number; h: number }>
): boolean {
	for (const other of placed) {
		if (
			rect.x < other.x + other.w + TEMPERATURE_LABEL_MIN_PX_X
			&& rect.x + rect.w + TEMPERATURE_LABEL_MIN_PX_X > other.x
			&& rect.y < other.y + other.h + TEMPERATURE_LABEL_MIN_PX_Y
			&& rect.y + rect.h + TEMPERATURE_LABEL_MIN_PX_Y > other.y
		) {
			return true;
		}
	}
	return false;
}

export function filterNonOverlappingWeatherStationLabels(
	map: L.Map,
	points: WeatherStationGridPoint[]
): WeatherStationGridPoint[] {
	if (!points.length) {
		return [];
	}
	const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
	const result: WeatherStationGridPoint[] = [];
	for (const point of points) {
		const [markerLat, markerLon] = stationMarkerLatLng(point);
		const pt = map.latLngToContainerPoint([markerLat, markerLon]);
		const label = formatWeatherStationTemperatureLabel(point.tempC);
		const w = estimateWeatherStationLabelWidth(label);
		const h = 20;
		const rect = { x: pt.x - w / 2, y: pt.y - h / 2, w, h };
		if (temperatureLabelRectOverlaps(rect, placed)) {
			continue;
		}
		placed.push(rect);
		result.push(point);
	}
	return result;
}

export function filterWeatherStationPointsInBounds(
	map: L.Map,
	points: WeatherStationGridPoint[]
): WeatherStationGridPoint[] {
	const bounds = map.getBounds();
	return points.filter((point) => {
		const [markerLat, markerLon] = stationMarkerLatLng(point);
		return bounds.contains([markerLat, markerLon]);
	});
}
