import { Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { take } from 'rxjs/operators';
import * as L from 'leaflet';
import { ApiService } from './api.service';
import {
	WeatherStationBrand,
	WeatherStationGridPoint,
	WeatherStationProvider,
	WeatherStationTooltipContext,
	buildWeatherStationLabelHtml,
	buildWeatherStationTooltipHtml,
	computeWeatherStationCapacity,
	estimateWeatherStationLabelWidth,
	filterNonOverlappingWeatherStationLabels,
	filterStationLabelPoints,
	filterWeatherStationPointsInBounds,
	findNearestWeatherStationGridPoint,
	formatWeatherStationTemperatureLabel,
	isMfStationLabelPoint,
	isMeteoFranceStationPoint,
	isMeteoSwissStationPoint,
	isMsStationLabelPoint,
	isObsWeatherStationPoint,
	normalizeWeatherStationGridPoint,
	resolveWeatherStationRefreshProvider,
	stationMarkerLatLng,
	weatherStationPointKey,
} from '../shared/weather-station-map.util';

export interface WeatherStationMapLayerOptions {
	enabled: boolean;
	resolveProvider: () => WeatherStationProvider | null;
	excludeNearPoint?: () => { lat: number; lng: number } | null;
	brandLogos?: Partial<Record<WeatherStationBrand, string>>;
	brandAlts?: Partial<Record<WeatherStationBrand, string>>;
	onGridPointsUpdated?: () => void;
	climAvailable?: () => boolean;
	msHistAvailable?: () => boolean;
	onMfStationHistory?: (point: WeatherStationGridPoint) => void;
	onMsStationHistory?: (point: WeatherStationGridPoint) => void;
}

@Injectable({ providedIn: 'root' })
export class WeatherStationMapLayerService {
	private static readonly LOGO_MF = 'assets/images/meteofrance-logo.svg';
	private static readonly LOGO_MS = 'assets/images/meteoswiss-logo.svg';
	private static readonly NEAR_POINT_KM = 0.35;

	private map?: L.Map;
	private layer?: L.LayerGroup;
	private options: WeatherStationMapLayerOptions = { enabled: false, resolveProvider: () => null };
	private gridPoints: WeatherStationGridPoint[] = [];
	private labelSource: 'meteofrance-dpobs' | 'meteoswiss-smn' | null = null;
	private loadSub?: Subscription;
	private refreshSub?: Subscription;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private requestId = 0;
	private readonly refreshingTemperatureKeys = new Set<string>();
	private readonly stationAltitudeCache = new Map<string, number | null>();
	private readonly stationAltitudeInflight = new Map<string, Subscription>();
	private readonly markersByKey = new Map<string, L.Marker>();
	private tooltipClickListenerAttached = false;

	private readonly onTemperatureTooltipClick = (event: MouseEvent): void => {
		const target = event.target as HTMLElement | null;
		const msHistoryButton = target?.closest('.ms-temp-history-btn') as HTMLElement | null;
		if (msHistoryButton) {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			const historyKey = msHistoryButton.getAttribute('data-temp-key');
			if (historyKey) {
				this.openMsStationHistory(historyKey);
			}
			return;
		}
		const historyButton = target?.closest('.mf-temp-history-btn') as HTMLElement | null;
		if (historyButton) {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			const historyKey = historyButton.getAttribute('data-temp-key');
			if (historyKey) {
				this.openMfStationHistory(historyKey);
			}
			return;
		}
		const button = target?.closest('.mf-temp-refresh-btn, .ms-temp-refresh-btn') as HTMLElement | null;
		if (!button) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		const key = button.getAttribute('data-temp-key');
		if (key) {
			this.refreshTemperaturePointByKey(key);
		}
	};

	private readonly onMapMoveEnd = (): void => {
		this.render();
		this.scheduleLoad();
	};

	private readonly onMapZoomEnd = (): void => {
		this.render();
		this.scheduleLoad();
	};

	constructor(
		private readonly apiService: ApiService,
		private readonly translate: TranslateService
	) {}

	bind(map: L.Map, options: WeatherStationMapLayerOptions): void {
		this.detach();
		this.map = map;
		this.options = options;
		this.setup();
	}

	updateOptions(patch: Partial<WeatherStationMapLayerOptions>): void {
		this.options = { ...this.options, ...patch };
		this.setup();
	}

	getLabelSource(): 'meteofrance-dpobs' | 'meteoswiss-smn' | null {
		return this.labelSource;
	}

	getGridPoints(): WeatherStationGridPoint[] {
		return [...this.gridPoints];
	}

	findNearestGridPoint(lat: number, lon: number): WeatherStationGridPoint | null {
		const provider = this.options.resolveProvider();
		if (!provider || !this.labelSource) {
			return null;
		}
		const activePoints = filterStationLabelPoints(this.gridPoints, provider, this.labelSource);
		return findNearestWeatherStationGridPoint(activePoints, lat, lon);
	}

	detach(): void {
		this.clearDebounce();
		this.loadSub?.unsubscribe();
		this.loadSub = undefined;
		this.refreshSub?.unsubscribe();
		this.refreshSub = undefined;
		this.requestId++;
		this.refreshingTemperatureKeys.clear();
		this.markersByKey.clear();
		this.gridPoints = [];
		this.labelSource = null;
		this.stationAltitudeInflight.forEach((sub) => sub.unsubscribe());
		this.stationAltitudeInflight.clear();
		this.stationAltitudeCache.clear();
		this.detachTooltipClickListener();
		this.map?.off('moveend', this.onMapMoveEnd);
		this.map?.off('zoomend', this.onMapZoomEnd);
		if (this.map && this.layer) {
			this.map.removeLayer(this.layer);
		}
		this.layer = undefined;
		this.map = undefined;
	}

	private attachTooltipClickListener(): void {
		if (!this.map || this.tooltipClickListenerAttached) {
			return;
		}
		this.map.getContainer().addEventListener('click', this.onTemperatureTooltipClick);
		this.tooltipClickListenerAttached = true;
	}

	private detachTooltipClickListener(): void {
		if (!this.map || !this.tooltipClickListenerAttached) {
			return;
		}
		this.map.getContainer().removeEventListener('click', this.onTemperatureTooltipClick);
		this.tooltipClickListenerAttached = false;
	}

	private setup(): void {
		if (!this.map) {
			return;
		}
		this.detachListenersAndLayer();
		if (!this.options.enabled) {
			this.detachTooltipClickListener();
			return;
		}
		this.layer = L.layerGroup().addTo(this.map);
		this.map.on('moveend', this.onMapMoveEnd);
		this.map.on('zoomend', this.onMapZoomEnd);
		this.attachTooltipClickListener();
		this.scheduleLoad();
	}

	private detachListenersAndLayer(): void {
		this.clearDebounce();
		this.loadSub?.unsubscribe();
		this.loadSub = undefined;
		this.refreshSub?.unsubscribe();
		this.refreshSub = undefined;
		this.requestId++;
		this.gridPoints = [];
		this.labelSource = null;
		this.markersByKey.clear();
		this.map?.off('moveend', this.onMapMoveEnd);
		this.map?.off('zoomend', this.onMapZoomEnd);
		if (this.map && this.layer) {
			this.map.removeLayer(this.layer);
		}
		this.layer = undefined;
	}

	private clearDebounce(): void {
		if (this.debounceTimer != null) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}

	private scheduleLoad(): void {
		if (!this.map || !this.options.enabled || !this.layer) {
			return;
		}
		if (!this.options.resolveProvider()) {
			this.gridPoints = [];
			this.render();
			return;
		}
		this.clearDebounce();
		const { debounceMs } = computeWeatherStationCapacity(this.map.getZoom());
		this.debounceTimer = setTimeout(() => this.load(), debounceMs);
	}

	private load(): void {
		if (!this.map || !this.options.enabled || !this.layer) {
			return;
		}
		const provider = this.options.resolveProvider();
		if (!provider) {
			this.gridPoints = [];
			this.render();
			return;
		}
		const bounds = this.map.getBounds();
		const capacity = computeWeatherStationCapacity(this.map.getZoom());
		const expectedSourceToken = provider === 'ms' ? 'meteoswiss' : 'meteofrance';
		const labelSource: 'meteoswiss-smn' | 'meteofrance-dpobs' = provider === 'ms'
			? 'meteoswiss-smn'
			: 'meteofrance-dpobs';
		const previousPoints = filterStationLabelPoints([...this.gridPoints], provider, this.labelSource);

		this.loadSub?.unsubscribe();
		const requestId = ++this.requestId;
		const fetch$ = provider === 'ms'
			? this.apiService.getMeteoSwissObsTemperatureLabels(
				bounds.getSouth(),
				bounds.getNorth(),
				bounds.getWest(),
				bounds.getEast(),
				capacity.maxStations
			)
			: this.apiService.getMeteoFranceObsTemperatureLabels(
				bounds.getSouth(),
				bounds.getNorth(),
				bounds.getWest(),
				bounds.getEast(),
				capacity.maxStations
			);

		this.loadSub = fetch$.subscribe({
			next: (data) => {
				if (requestId !== this.requestId || !this.options.enabled) {
					return;
				}
				if (this.options.resolveProvider() !== provider) {
					this.gridPoints = [];
					this.render();
					return;
				}
				if (data?.error) {
					this.gridPoints = previousPoints.length ? previousPoints : [];
					this.render();
					this.options.onGridPointsUpdated?.();
					return;
				}
				const src = String(data?.source || '');
				if (!src.includes(expectedSourceToken)) {
					this.gridPoints = previousPoints;
					this.labelSource = null;
				} else {
					this.labelSource = labelSource;
					const points = Array.isArray(data?.points)
						? data.points
							.map((point: unknown) => normalizeWeatherStationGridPoint(point, data?.cached === true))
							.filter((point: WeatherStationGridPoint) =>
								provider === 'ms'
									? isMsStationLabelPoint(point, labelSource)
									: isMfStationLabelPoint(point, labelSource)
							)
						: [];
					this.gridPoints = points.length ? points : previousPoints;
				}
				this.render();
				this.options.onGridPointsUpdated?.();
			},
			error: () => {
				if (requestId !== this.requestId) {
					return;
				}
				this.gridPoints = previousPoints.length ? previousPoints : [];
				this.render();
				this.options.onGridPointsUpdated?.();
			},
		});
	}

	private render(): void {
		if (!this.layer || !this.map) {
			return;
		}
		this.layer.clearLayers();
		this.markersByKey.clear();
		const provider = this.options.resolveProvider();
		if (!provider || !this.options.enabled) {
			return;
		}
		const brand: WeatherStationBrand = provider === 'ms' ? 'meteoswiss' : 'meteofrance';
		const logoSrc = brand === 'meteoswiss'
			? (this.options.brandLogos?.meteoswiss || WeatherStationMapLayerService.LOGO_MS)
			: (this.options.brandLogos?.meteofrance || WeatherStationMapLayerService.LOGO_MF);
		const brandAlt = brand === 'meteoswiss'
			? (this.options.brandAlts?.meteoswiss || 'MeteoSwiss')
			: (this.options.brandAlts?.meteofrance || 'Météo-France');
		const activePoints = filterStationLabelPoints(this.gridPoints, provider, this.labelSource);
		const inBounds = filterWeatherStationPointsInBounds(this.map, activePoints);
		const visible = filterNonOverlappingWeatherStationLabels(this.map, inBounds);
		const exclude = this.options.excludeNearPoint?.() ?? null;

		for (const point of visible) {
			if (point.tempC == null || !Number.isFinite(point.tempC)) {
				continue;
			}
			const [markerLat, markerLon] = stationMarkerLatLng(point);
			if (exclude && this.isNearPoint(markerLat, markerLon, exclude.lat, exclude.lng)) {
				continue;
			}
			const label = formatWeatherStationTemperatureLabel(point.tempC);
			const w = estimateWeatherStationLabelWidth(label);
			const h = 20;
			const icon = L.divIcon({
				className: 'mf-temp-label',
				html: buildWeatherStationLabelHtml(point.tempC, brand, logoSrc, brandAlt),
				iconSize: [w, h],
				iconAnchor: [w / 2, h / 2],
			});
			const marker = L.marker([markerLat, markerLon], { icon, interactive: true });
			this.markersByKey.set(weatherStationPointKey(point), marker);
			this.bindTooltip(marker, point);
			marker.addTo(this.layer);
		}
	}

	private buildTooltipContext(): WeatherStationTooltipContext {
		return {
			translate: (key: string) => this.translate.instant(key),
			labelSource: this.labelSource,
			brandLogos: {
				meteofrance: this.options.brandLogos?.meteofrance || WeatherStationMapLayerService.LOGO_MF,
				meteoswiss: this.options.brandLogos?.meteoswiss || WeatherStationMapLayerService.LOGO_MS,
			},
			brandAlts: {
				meteofrance: this.options.brandAlts?.meteofrance || 'Météo-France',
				meteoswiss: this.options.brandAlts?.meteoswiss || 'MeteoSwiss',
			},
			showStationActions: true,
			isRefreshing: (key: string) => this.refreshingTemperatureKeys.has(key),
			canShowMfHistory: (point) =>
				isMeteoFranceStationPoint(point, this.labelSource) && this.options.climAvailable?.() === true,
			canShowMsHistory: (point) =>
				isMeteoSwissStationPoint(point, this.labelSource) && this.options.msHistAvailable?.() !== false,
		};
	}

	private findPointByKey(key: string): WeatherStationGridPoint | null {
		return this.gridPoints.find((point) => weatherStationPointKey(point) === key) ?? null;
	}

	private openMfStationHistory(key: string): void {
		const point = this.findPointByKey(key);
		if (!point?.stationId || !isMeteoFranceStationPoint(point, this.labelSource)) {
			return;
		}
		this.options.onMfStationHistory?.(point);
	}

	private openMsStationHistory(key: string): void {
		const point = this.findPointByKey(key);
		if (!point?.stationId || !isMeteoSwissStationPoint(point, this.labelSource)) {
			return;
		}
		this.options.onMsStationHistory?.(point);
	}

	private refreshTemperaturePointByKey(key: string): void {
		const point = this.findPointByKey(key);
		if (!point?.stationId || this.refreshingTemperatureKeys.has(key)) {
			return;
		}
		const provider = resolveWeatherStationRefreshProvider(point, this.labelSource);
		if (!provider) {
			return;
		}
		const [markerLat, markerLon] = stationMarkerLatLng(point);
		this.refreshingTemperatureKeys.add(key);
		this.refreshTooltipContentForKey(key);
		this.refreshSub?.unsubscribe();
		this.refreshSub = this.apiService.postWeatherTemperatureLabels(
			[{
				lat: markerLat,
				lon: markerLon,
				stationId: point.stationId,
			}],
			provider === 'ms' ? 'meteoswiss' : 'meteofrance',
			true
		).subscribe({
			next: (data) => {
				this.refreshingTemperatureKeys.delete(key);
				const updated = data?.points?.[0];
				if (!updated || data?.error) {
					this.refreshTooltipContentForKey(key);
					return;
				}
				const normalized = normalizeWeatherStationGridPoint(updated, false);
				normalized.cached = false;
				const isValid = provider === 'ms'
					? isMeteoSwissStationPoint(normalized, 'meteoswiss-smn')
					: isMeteoFranceStationPoint(normalized, 'meteofrance-dpobs');
				if (!isValid) {
					this.refreshTooltipContentForKey(key);
					return;
				}
				const updatedKey = weatherStationPointKey(normalized);
				const index = this.gridPoints.findIndex((p) => weatherStationPointKey(p) === updatedKey);
				if (index >= 0) {
					this.gridPoints[index] = normalized;
				} else {
					this.gridPoints.push(normalized);
				}
				this.labelSource = provider === 'ms' ? 'meteoswiss-smn' : 'meteofrance-dpobs';
				this.render();
				this.options.onGridPointsUpdated?.();
			},
			error: () => {
				this.refreshingTemperatureKeys.delete(key);
				this.refreshTooltipContentForKey(key);
			},
		});
	}

	private stationAltitudeCacheKey(lat: number, lon: number): string {
		return `${lat.toFixed(5)},${lon.toFixed(5)}`;
	}

	private applyCachedStationAltitude(point: WeatherStationGridPoint): void {
		if (!isObsWeatherStationPoint(point, this.labelSource) || point.altitudeM != null) {
			return;
		}
		const key = this.stationAltitudeCacheKey(point.lat, point.lon);
		if (this.stationAltitudeCache.has(key)) {
			const cached = this.stationAltitudeCache.get(key);
			if (cached != null) {
				point.altitudeM = cached;
			}
		}
	}

	private ensureStationAltitude(point: WeatherStationGridPoint, marker: L.Marker): void {
		if (!isObsWeatherStationPoint(point, this.labelSource)) {
			return;
		}
		this.applyCachedStationAltitude(point);
		if (point.altitudeM != null) {
			return;
		}
		const key = this.stationAltitudeCacheKey(point.lat, point.lon);
		if (this.stationAltitudeCache.has(key) || this.stationAltitudeInflight.has(key)) {
			return;
		}
		const sub = this.apiService.getStationElevation(point.lat, point.lon).pipe(take(1)).subscribe({
			next: (response) => {
				this.stationAltitudeInflight.delete(key);
				const raw = response?.altitudeM;
				const altitudeM = raw != null && Number.isFinite(Number(raw)) ? Math.round(Number(raw)) : null;
				this.stationAltitudeCache.set(key, altitudeM);
				if (altitudeM == null) {
					return;
				}
				point.altitudeM = altitudeM;
				if (marker.getTooltip()) {
					marker.setTooltipContent(buildWeatherStationTooltipHtml(point, this.buildTooltipContext()));
				}
			},
			error: () => {
				this.stationAltitudeInflight.delete(key);
				this.stationAltitudeCache.set(key, null);
			},
		});
		this.stationAltitudeInflight.set(key, sub);
	}

	private refreshTooltipContentForKey(key: string): void {
		const point = this.findPointByKey(key);
		const marker = this.markersByKey.get(key);
		if (!point || !marker?.getTooltip()) {
			return;
		}
		marker.setTooltipContent(buildWeatherStationTooltipHtml(point, this.buildTooltipContext()));
	}

	private bindTooltip(marker: L.Marker, point: WeatherStationGridPoint): void {
		this.applyCachedStationAltitude(point);
		marker.bindTooltip(buildWeatherStationTooltipHtml(point, this.buildTooltipContext()), {
			direction: 'top',
			offset: [0, -10],
			opacity: 0.97,
			className: 'mf-temp-tooltip',
			permanent: true,
			sticky: false,
		});
		let closeTimer: ReturnType<typeof setTimeout> | null = null;
		const cancelClose = (): void => {
			if (closeTimer !== null) {
				clearTimeout(closeTimer);
				closeTimer = null;
			}
		};
		const scheduleClose = (): void => {
			cancelClose();
			closeTimer = setTimeout(() => {
				marker.closeTooltip();
				closeTimer = null;
			}, 520);
		};
		const wireTooltipElement = (): void => {
			const el = marker.getTooltip()?.getElement() as HTMLElement | undefined;
			if (!el || el.dataset['mfTempTooltipWired'] === '1') {
				return;
			}
			el.dataset['mfTempTooltipWired'] = '1';
			el.addEventListener('mouseenter', cancelClose);
			el.addEventListener('mouseleave', scheduleClose);
		};
		marker.on('add', () => {
			marker.closeTooltip();
		});
		marker.on('mouseover', () => {
			cancelClose();
			this.ensureStationAltitude(point, marker);
			marker.openTooltip();
			wireTooltipElement();
			requestAnimationFrame(() => wireTooltipElement());
		});
		marker.on('mouseout', scheduleClose);
		marker.on('click', (e: L.LeafletMouseEvent) => {
			L.DomEvent.stopPropagation(e);
		});
		marker.on('tooltipopen', wireTooltipElement);
	}

	private isNearPoint(lat: number, lon: number, refLat: number, refLon: number): boolean {
		const dLat = (lat - refLat) * 111;
		const dLon = (lon - refLon) * 111 * Math.cos((refLat * Math.PI) / 180);
		const distKm = Math.sqrt(dLat * dLat + dLon * dLon);
		return distKm < WeatherStationMapLayerService.NEAR_POINT_KM;
	}
}
