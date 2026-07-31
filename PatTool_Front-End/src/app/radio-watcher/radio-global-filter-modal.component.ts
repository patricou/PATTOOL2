import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';

import { RadioCountry } from '../services/api.service';

export interface RadioFilterPreference {
  applyToAllTabs?: boolean;
  stationQuery?: string;
  country?: string;
  tag?: string;
}

@Component({
  selector: 'app-radio-global-filter-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './radio-global-filter-modal.component.html',
  styleUrls: ['./radio-global-filter-modal.component.css']
})
export class RadioGlobalFilterModalComponent implements OnChanges {
  @Input() open = false;
  @Input() countries: RadioCountry[] = [];
  @Input() tags: string[] = [];
  @Input() preference: RadioFilterPreference = {};
  @Input() saving = false;

  @Output() closed = new EventEmitter<void>();
  @Output() applied = new EventEmitter<RadioFilterPreference>();
  @Output() cleared = new EventEmitter<RadioFilterPreference>();
  @Output() countryChanged = new EventEmitter<string>();

  draft: RadioFilterPreference = {
    applyToAllTabs: false,
    stationQuery: '',
    country: 'all',
    tag: ''
  };

  countryFilter = '';

  get filteredCountries(): RadioCountry[] {
    const q = this.normalizeCountryNeedle(this.countryFilter);
    const all = this.countries || [];
    const filtered = !q ? all : all.filter((c) => this.countryMatchesFilter(c, q));
    const selected = (this.draft.country || '').toLowerCase();
    if (selected && selected !== 'all' && !filtered.some((c) => (c.code || '').toLowerCase() === selected)) {
      const current = all.find((c) => (c.code || '').toLowerCase() === selected);
      if (current) {
        return [current, ...filtered];
      }
    }
    return filtered;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open']?.currentValue === true || changes['preference']) {
      this.syncDraftFromPreference();
    }
    if (changes['open']?.currentValue === true) {
      this.countryFilter = '';
    }
  }

  close(): void {
    this.closed.emit();
  }

  onCountryChange(): void {
    this.draft.tag = '';
    this.countryChanged.emit((this.draft.country || 'all').toLowerCase());
  }

  apply(): void {
    this.applied.emit(this.snapshot());
  }

  clear(): void {
    this.draft = {
      applyToAllTabs: !!this.draft.applyToAllTabs,
      stationQuery: '',
      country: 'all',
      tag: ''
    };
    this.countryFilter = '';
    this.cleared.emit(this.snapshot());
  }

  private countryMatchesFilter(country: RadioCountry, needle: string): boolean {
    const code = (country?.code || '').toLowerCase();
    const name = this.normalizeCountryNeedle(country?.name || '');
    return code.includes(needle) || name.includes(needle);
  }

  private normalizeCountryNeedle(value: string): string {
    return (value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  private syncDraftFromPreference(): void {
    const p = this.preference || {};
    this.draft = {
      applyToAllTabs: !!p.applyToAllTabs,
      stationQuery: p.stationQuery || '',
      country: (p.country || 'all').toLowerCase(),
      tag: p.tag || ''
    };
  }

  private snapshot(): RadioFilterPreference {
    return {
      applyToAllTabs: !!this.draft.applyToAllTabs,
      stationQuery: (this.draft.stationQuery || '').trim(),
      country: ((this.draft.country || 'all').trim() || 'all').toLowerCase(),
      tag: (this.draft.tag || '').trim()
    };
  }
}
