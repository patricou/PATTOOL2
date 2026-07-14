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
	formatWeatherStationTemperatureLabel,
	isMfStationLabelPoint,
	isMsStationLabelPoint,
	isObsWeatherStationPoint,
	normalizeWeatherStationGridPoint,
	stationMarkerLatLng,
} from '../shared/weather-station-map.util';

export interface WeatherStationMapLayerOptions {
	enabled: boolean;
	resolveProvider: () => WeatherStationProvider | null;
	excludeNearPoint?: () => { lat: number; lng: number } | null;
	brandLogos?: Partial<Record<WeatherStationBrand, string>>;
	brandAlts?: Partial<Record<WeatherStationBrand, string>>;
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
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private requestId = 0;
	private readonly stationAltitudeCache = new Map<string, number | null>();
	private readonly stationAltitudeInflight = new Map<string, Subscription>();

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

	detach(): void {
		this.clearDebounce();
		this.loadSub?.unsubscribe();
		this.loadSub = undefined;
		this.requestId++;
		this.gridPoints = [];
		this.labelSource = null;
		this.stationAltitudeInflight.forEach((sub) => sub.unsubscribe());
		this.stationAltitudeInflight.clear();
		this.stationAltitudeCache.clear();
		this.map?.off('moveend', this.onMapMoveEnd);
		this.map?.off('zoomend', this.onMapZoomEnd);
		if (this.map && this.layer) {
			this.map.removeLayer(this.layer);
		}
		this.layer = undefined;
		this.map = undefined;
	}

	private setup(): void {
		if (!this.map) {
			return;
		}
		this.detachListenersAndLayer();
		if (!this.options.enabled) {
			return;
		}
		this.layer = L.layerGroup().addTo(this.map);
		this.map.on('moveend', this.onMapMoveEnd);
		this.map.on('zoomend', this.onMapZoomEnd);
		this.scheduleLoad();
	}

	private detachListenersAndLayer(): void {
		this.clearDebounce();
		this.loadSub?.unsubscribe();
		this.loadSub = undefined;
		this.requestId++;
		this.gridPoints = [];
		this.labelSource = null;
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
			},
			error: () => {
				if (requestId !== this.requestId) {
					return;
				}
				this.gridPoints = previousPoints.length ? previousPoints : [];
				this.render();
			},
		});
	}

	private render(): void {
		if (!this.layer || !this.map) {
			return;
		}
		this.layer.clearLayers();
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
		};
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

	private bindTooltip(marker: L.Marker, point: WeatherStationGridPoint): void {
		this.applyCachedStationAltitude(point);
		marker.bindTooltip(buildWeatherStationTooltipHtml(point, this.buildTooltipContext()), {
			direction: 'top',
			offset: [0, -10],
			opacity: 0.97,
			className: 'mf-temp-tooltip',
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
			}, 320);
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
