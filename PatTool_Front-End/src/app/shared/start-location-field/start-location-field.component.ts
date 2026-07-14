import {
	ChangeDetectorRef,
	Component,
	forwardRef,
	Input,
	OnDestroy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ControlValueAccessor, FormsModule, NG_VALUE_ACCESSOR } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { take } from 'rxjs/operators';
import { ApiService } from '../../services/api.service';
import { START_LOCATION_NA, normalizeStartLocation } from '../start-location.util';

interface GeocodeResult {
	lat: number;
	lon: number;
	displayName: string;
}

@Component({
	selector: 'app-start-location-field',
	standalone: true,
	imports: [CommonModule, FormsModule, TranslateModule],
	templateUrl: './start-location-field.component.html',
	styleUrls: ['./start-location-field.component.css'],
	providers: [{
		provide: NG_VALUE_ACCESSOR,
		useExisting: forwardRef(() => StartLocationFieldComponent),
		multi: true
	}]
})
export class StartLocationFieldComponent implements ControlValueAccessor, OnDestroy {

	@Input() inputId = 'startLocation';
	@Input() disabled = false;

	readonly startLocationNa = START_LOCATION_NA;

	value = START_LOCATION_NA;
	searchQuery = '';
	results: GeocodeResult[] = [];
	showResults = false;
	isLoading = false;
	searchErrorKey = '';

	private onChange: (value: string) => void = () => {};
	private onTouched: () => void = () => {};
	private searchSub?: Subscription;
	private debounceTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly apiService: ApiService,
		private readonly cdr: ChangeDetectorRef
	) {}

	ngOnDestroy(): void {
		this.searchSub?.unsubscribe();
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
	}

	writeValue(value: string | null): void {
		this.value = normalizeStartLocation(value);
		this.searchQuery = '';
		this.results = [];
		this.showResults = false;
		this.searchErrorKey = '';
	}

	registerOnChange(fn: (value: string) => void): void {
		this.onChange = fn;
	}

	registerOnTouched(fn: () => void): void {
		this.onTouched = fn;
	}

	setDisabledState(isDisabled: boolean): void {
		this.disabled = isDisabled;
		this.cdr.markForCheck();
	}

	isNaSelected(): boolean {
		return normalizeStartLocation(this.value) === START_LOCATION_NA;
	}

	selectNa(): void {
		if (this.disabled) {
			return;
		}
		this.applyValue(START_LOCATION_NA);
		this.searchQuery = '';
		this.results = [];
		this.showResults = false;
		this.searchErrorKey = '';
	}

	selectResult(result: GeocodeResult): void {
		if (this.disabled || !result.displayName) {
			return;
		}
		this.applyValue(result.displayName.trim());
		this.searchQuery = '';
		this.results = [];
		this.showResults = false;
		this.searchErrorKey = '';
	}

	onSearchInput(): void {
		if (this.disabled) {
			return;
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		const query = this.searchQuery.trim();
		if (query.length < 2) {
			this.results = [];
			this.showResults = false;
			this.searchErrorKey = '';
			return;
		}
		this.debounceTimer = setTimeout(() => this.runSearch(query), 400);
	}

	searchNow(): void {
		const query = this.searchQuery.trim();
		if (!query || this.disabled) {
			return;
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.runSearch(query);
	}

	onSearchBlur(): void {
		setTimeout(() => {
			this.showResults = false;
			this.cdr.markForCheck();
		}, 200);
	}

	private applyValue(nextValue: string): void {
		this.value = nextValue;
		this.onChange(nextValue);
		this.onTouched();
		this.cdr.markForCheck();
	}

	private runSearch(query: string): void {
		this.isLoading = true;
		this.searchErrorKey = '';
		this.searchSub?.unsubscribe();
		this.searchSub = this.apiService.geocodeSearch(query).pipe(take(1)).subscribe({
			next: (data: any[]) => {
				this.results = (data || [])
					.map((item: any) => this.normalizeGeocodeResult(item))
					.filter((item): item is GeocodeResult => item != null);
				this.showResults = this.results.length > 0;
				if (this.results.length === 0) {
					this.searchErrorKey = 'ADDRESS_GEOCODE.NO_RESULTS';
				}
				this.isLoading = false;
				this.cdr.markForCheck();
			},
			error: () => {
				this.results = [];
				this.showResults = false;
				this.searchErrorKey = 'ADDRESS_GEOCODE.ERROR';
				this.isLoading = false;
				this.cdr.markForCheck();
			}
		});
	}

	private normalizeGeocodeResult(item: any): GeocodeResult | null {
		if (!item) {
			return null;
		}
		const lat = typeof item.lat === 'number' ? item.lat : parseFloat(item.lat);
		const lon = typeof item.lon === 'number' ? item.lon : parseFloat(item.lon ?? item.lng);
		const displayName = (item.displayName || item.display_name || '').trim();
		if (!displayName || !Number.isFinite(lat) || !Number.isFinite(lon)) {
			return null;
		}
		return { lat, lon, displayName };
	}
}
