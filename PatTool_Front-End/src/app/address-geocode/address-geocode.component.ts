import { Component, ViewChild, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import { ApiService } from '../services/api.service';

export interface GeocodeResult {
	lat: number;
	lon: number;
	displayName: string;
	address?: Record<string, string>;
}

@Component({
	selector: 'app-address-geocode',
	templateUrl: './address-geocode.component.html',
	styleUrls: ['./address-geocode.component.css'],
	standalone: true,
	imports: [
		CommonModule,
		FormsModule,
		TranslateModule,
		NavigationButtonsModule,
		TraceViewerModalComponent
	]
})
export class AddressGeocodeComponent {

	@ViewChild(TraceViewerModalComponent) traceViewerModalComponent?: TraceViewerModalComponent;

	addressQuery: string = '';
	results: GeocodeResult[] = [];
	selectedResult: GeocodeResult | null = null;
	isLoading: boolean = false;
	errorMessage: string = '';

	// Reverse: GPS → Address
	coordinatesInput: string = '';
	reverseAddressResult: string = '';
	reverseLat: number | null = null;
	reverseLon: number | null = null;
	reverseAltitudes: Array<{ altitude: number; source: string; sourceDescription?: string }> = [];
	reverseAltitudeLoading: boolean = false;
	reverseAltitudeError: boolean = false;
	isLoadingReverse: boolean = false;
	errorMessageReverse: string = '';
	isLoadingMyPosition: boolean = false;

	// Altitude for selected address result (from search) – all sources
	selectedAltitudes: Array<{ altitude: number; source: string; sourceDescription?: string }> = [];
	selectedAltitudeLoading: boolean = false;
	selectedAltitudeError: boolean = false;

	copyFeedback: string = '';
	copyFeedbackReverse: string = '';

	/** Paste from clipboard into address or coordinates field. */
	async pasteAddress(): Promise<void> {
		this.errorMessage = '';
		try {
			const text = await navigator.clipboard.readText();
			if (text != null && text.trim()) {
				this.addressQuery = text.trim();
			}
		} catch {
			this.errorMessage = this.translateService.instant('ADDRESS_GEOCODE.PASTE_ERROR');
		}
	}

	async pasteCoordinates(): Promise<void> {
		this.errorMessageReverse = '';
		try {
			const text = await navigator.clipboard.readText();
			if (text != null && text.trim()) {
				this.coordinatesInput = text.trim();
			}
		} catch {
			this.errorMessageReverse = this.translateService.instant('ADDRESS_GEOCODE.PASTE_ERROR');
		}
	}

	constructor(
		private readonly translateService: TranslateService,
		private readonly apiService: ApiService,
		private readonly ngZone: NgZone
	) {}

	/**
	 * Geocode address via backend (Nominatim).
	 */
	searchAddress(): void {
		// Dismiss keyboard on mobile so results are visible
		(document.activeElement as HTMLElement)?.blur();
		const query = this.addressQuery?.trim();
		if (!query) {
			this.errorMessage = this.translateService.instant('ADDRESS_GEOCODE.ADDRESS_REQUIRED');
			this.results = [];
			this.selectedResult = null;
			this.selectedAltitudes = [];
			return;
		}
		this.errorMessage = '';
		this.selectedResult = null;
		this.selectedAltitudes = [];
		this.selectedAltitudeError = false;
		this.isLoading = true;
		this.apiService.geocodeSearch(query).subscribe({
			next: (data: any[]) => {
				this.results = (data || []).map((item: any) => ({
					lat: typeof item.lat === 'number' ? item.lat : parseFloat(item.lat) || 0,
					lon: typeof item.lon === 'number' ? item.lon : parseFloat(item.lon) || 0,
					displayName: item.displayName || item.display_name || '',
					address: item.address || {}
				}));
				if (this.results.length === 0) {
					this.errorMessage = this.translateService.instant('ADDRESS_GEOCODE.NO_RESULTS');
				} else if (this.results.length === 1) {
					// Un seul résultat : le sélectionner pour charger l'altitude
					this.selectResult(this.results[0]);
				}
			},
			error: (err) => {
				this.errorMessage = this.translateService.instant('ADDRESS_GEOCODE.ERROR') + ': ' + (err?.message || String(err));
				this.results = [];
			},
			complete: () => {
				this.isLoading = false;
			}
		});
	}

	selectResult(result: GeocodeResult): void {
		this.selectedResult = result;
		this.errorMessage = '';
		this.selectedAltitudes = [];
		this.selectedAltitudeError = false;
		this.selectedAltitudeLoading = true;
		this.apiService.getAllAltitudes(result.lat, result.lon).subscribe({
			next: (data: any) => {
				const list = data?.altitudes;
				if (list && Array.isArray(list)) {
					this.selectedAltitudes = list
						.filter((a: any) => a != null && a.altitude != null)
						.map((a: any) => ({
							altitude: typeof a.altitude === 'number' ? a.altitude : parseFloat(a.altitude),
							source: a.source || '',
							sourceDescription: a.sourceDescription
						}));
				}
				this.selectedAltitudeError = false;
			},
			error: () => {
				this.selectedAltitudes = [];
				this.selectedAltitudeError = true;
			},
			complete: () => { this.selectedAltitudeLoading = false; }
		});
	}

	getAltitudeSourceDescription(source: string): string {
		switch (source) {
			case 'mobile_device':
				return this.translateService.instant('API.ALTITUDE_FROM_MOBILE');
			case 'nominatim':
				return this.translateService.instant('API.ALTITUDE_FROM_NOMINATIM');
			case 'openelevation':
				return this.translateService.instant('API.ALTITUDE_FROM_OPENELEVATION');
			default:
				return source;
		}
	}

	showOnMap(): void {
		if (!this.selectedResult || !this.traceViewerModalComponent) {
			if (!this.selectedResult) {
				this.errorMessage = this.translateService.instant('ADDRESS_GEOCODE.SELECT_FIRST');
			}
			return;
		}
		const { lat, lon, displayName } = this.selectedResult;
		this.traceViewerModalComponent.openAtLocation(lat, lon, displayName, undefined, false);
	}

	showFirstResultOnMap(): void {
		if (this.results.length === 0) {
			this.errorMessage = this.translateService.instant('ADDRESS_GEOCODE.NO_RESULTS');
			return;
		}
		const first = this.results[0];
		this.selectedResult = first;
		this.showOnMap();
	}

	/** Mobile: trigger search on first tap (touchend) so keyboard dismiss doesn't consume the tap. */
	onSearchAddressTouch(event: TouchEvent): void {
		if (this.isLoading) return;
		event.preventDefault();
		this.searchAddress();
	}

	/** Mobile: trigger reverse geocode on first tap (touchend). */
	onGetAddressTouch(event: TouchEvent): void {
		if (this.isLoadingReverse) return;
		event.preventDefault();
		this.getAddressFromCoordinates();
	}

	/**
	 * Parse coordinates from input: "lat, lon" or "lat lon" or "lat,lon".
	 */
	private parseCoordinatesInput(input: string): { lat: number; lon: number } | null {
		const trimmed = input.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
		const parts = trimmed.split(' ').filter(p => p.length > 0);
		if (parts.length < 2) return null;
		const lat = parseFloat(parts[0]);
		const lon = parseFloat(parts[1]);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
		if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
		return { lat, lon };
	}

	/**
	 * Reverse geocode: get address from GPS coordinates via backend (Nominatim).
	 * @param deviceAlt Optional altitude from device GPS (e.g. from "Ma position") to include in altitude sources.
	 */
	getAddressFromCoordinates(deviceAlt?: number | null): void {
		// Dismiss keyboard on mobile so result is visible
		(document.activeElement as HTMLElement)?.blur();
		const parsed = this.parseCoordinatesInput(this.coordinatesInput);
		if (!parsed) {
			this.errorMessageReverse = this.translateService.instant('ADDRESS_GEOCODE.INVALID_COORDINATES');
			this.reverseAddressResult = '';
			this.reverseLat = null;
			this.reverseLon = null;
			this.reverseAltitudes = [];
			return;
		}
		this.errorMessageReverse = '';
		this.reverseAltitudes = [];
		this.reverseAltitudeError = false;
		this.isLoadingReverse = true;
		const { lat, lon } = parsed;
		this.apiService.geocodeReverse(lat, lon).subscribe({
			next: (data) => {
				this.reverseLat = data.lat ?? lat;
				this.reverseLon = data.lon ?? lon;
				this.reverseAddressResult = (data?.displayName ?? data?.display_name ?? '')?.trim() || this.translateService.instant('ADDRESS_GEOCODE.ADDRESS_NOT_FOUND');
				this.fetchReverseAltitude(lat, lon, deviceAlt);
			},
			error: (err) => {
				this.errorMessageReverse = this.translateService.instant('ADDRESS_GEOCODE.ERROR') + ': ' + (err?.message || String(err));
				this.reverseAddressResult = '';
				this.reverseLat = null;
				this.reverseLon = null;
				this.reverseAltitudes = [];
				this.reverseAltitudeError = false;
			},
			complete: () => {
				this.isLoadingReverse = false;
			}
		});
	}

	/** Fetch altitudes for reverse result (coordinates → address) and set reverseAltitudes. */
	private fetchReverseAltitude(lat: number, lon: number, altFromDevice?: number | null): void {
		this.reverseAltitudeLoading = true;
		this.reverseAltitudes = [];
		this.apiService.getAllAltitudes(lat, lon, altFromDevice ?? undefined).subscribe({
			next: (data: any) => {
				const list = data?.altitudes;
				if (list && Array.isArray(list)) {
					this.reverseAltitudes = list
						.filter((a: any) => a != null && a.altitude != null)
						.map((a: any) => ({
							altitude: typeof a.altitude === 'number' ? a.altitude : parseFloat(a.altitude),
							source: a.source || '',
							sourceDescription: a.sourceDescription
						}));
				}
				this.reverseAltitudeError = false;
			},
			error: () => {
				this.reverseAltitudes = [];
				this.reverseAltitudeError = true;
			},
			complete: () => { this.reverseAltitudeLoading = false; }
		});
	}

	showReverseOnMap(): void {
		if (this.reverseLat == null || this.reverseLon == null || !this.traceViewerModalComponent) return;
		const label = this.reverseAddressResult || `${this.reverseLat.toFixed(6)}, ${this.reverseLon.toFixed(6)}`;
		this.traceViewerModalComponent.openAtLocation(this.reverseLat, this.reverseLon, label, undefined, false);
	}

	/** Copy text to clipboard; returns true on success. */
	private async copyToClipboard(text: string): Promise<boolean> {
		if (!text?.trim()) return false;
		try {
			await navigator.clipboard.writeText(text.trim());
			return true;
		} catch {
			return false;
		}
	}

	/** Copy selected result coordinates to clipboard (lat, lon). */
	async copySelectedCoordinates(): Promise<void> {
		if (!this.selectedResult) return;
		const text = `${this.selectedResult.lat.toFixed(6)}, ${this.selectedResult.lon.toFixed(6)}`;
		const ok = await this.copyToClipboard(text);
		this.copyFeedback = ok ? this.translateService.instant('ADDRESS_GEOCODE.COPIED') : '';
		if (ok) setTimeout(() => { this.copyFeedback = ''; }, 2000);
	}

	/** Copy selected result address to clipboard. */
	async copySelectedAddress(): Promise<void> {
		if (!this.selectedResult?.displayName) return;
		const ok = await this.copyToClipboard(this.selectedResult.displayName);
		this.copyFeedback = ok ? this.translateService.instant('ADDRESS_GEOCODE.COPIED') : '';
		if (ok) setTimeout(() => { this.copyFeedback = ''; }, 2000);
	}

	/** Copy reverse result coordinates to clipboard (lat, lon). */
	async copyReverseCoordinates(): Promise<void> {
		if (this.reverseLat == null || this.reverseLon == null) return;
		const text = `${this.reverseLat.toFixed(6)}, ${this.reverseLon.toFixed(6)}`;
		const ok = await this.copyToClipboard(text);
		this.copyFeedbackReverse = ok ? this.translateService.instant('ADDRESS_GEOCODE.COPIED') : '';
		if (ok) setTimeout(() => { this.copyFeedbackReverse = ''; }, 2000);
	}

	/** Copy reverse result address to clipboard. */
	async copyReverseAddress(): Promise<void> {
		if (!this.reverseAddressResult?.trim()) return;
		const ok = await this.copyToClipboard(this.reverseAddressResult);
		this.copyFeedbackReverse = ok ? this.translateService.instant('ADDRESS_GEOCODE.COPIED') : '';
		if (ok) setTimeout(() => { this.copyFeedbackReverse = ''; }, 2000);
	}

	/**
	 * Get current GPS position via browser Geolocation API, fill coordinates and fetch address.
	 */
	getMyPosition(): void {
		if (!navigator.geolocation) {
			this.errorMessageReverse = this.translateService.instant('ADDRESS_GEOCODE.GEOLOCATION_NOT_SUPPORTED');
			return;
		}
		this.errorMessageReverse = '';
		this.isLoadingMyPosition = true;
		navigator.geolocation.getCurrentPosition(
			(position) => {
				this.ngZone.run(() => {
					const lat = position.coords.latitude;
					const lon = position.coords.longitude;
					const alt = position.coords.altitude != null && !isNaN(position.coords.altitude) ? position.coords.altitude : undefined;
					this.coordinatesInput = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
					this.isLoadingMyPosition = false;
					this.getAddressFromCoordinates(alt);
				});
			},
			(err) => {
				this.ngZone.run(() => {
					this.isLoadingMyPosition = false;
					this.errorMessageReverse = this.translateService.instant('ADDRESS_GEOCODE.ERROR_GETTING_LOCATION') + ': ' + (err.message || err.code || '');
				});
			},
			{ enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
		);
	}
}
