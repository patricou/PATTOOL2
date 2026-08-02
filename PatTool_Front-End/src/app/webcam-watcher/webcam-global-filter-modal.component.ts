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

import { WebcamCodeLabel } from '../services/api.service';

export type WebcamFilterProviderTab = 'windy' | 'traffic' | 'europe' | 'favorites';

export interface WebcamFilterPreference {
  applyToAllTabs?: boolean;
  /** Server-side catalog search (place / road). */
  catalogQuery?: string;
  continent?: string;
  country?: string;
  category?: string;
  sortKey?: 'popularity' | 'createdOn';
  jurisdiction?: string;
  hasVideoOnly?: boolean;
  useNearby?: boolean;
  nearbyRadiusKm?: number;
}

@Component({
  selector: 'app-webcam-global-filter-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './webcam-global-filter-modal.component.html',
  styleUrls: ['./webcam-global-filter-modal.component.css']
})
export class WebcamGlobalFilterModalComponent implements OnChanges {
  @Input() open = false;
  @Input() provider: WebcamFilterProviderTab = 'windy';
  @Input() continents: WebcamCodeLabel[] = [];
  @Input() countries: WebcamCodeLabel[] = [];
  @Input() categories: WebcamCodeLabel[] = [];
  @Input() jurisdictions: WebcamCodeLabel[] = [];
  @Input() preference: WebcamFilterPreference = {};
  @Input() saving = false;

  @Output() closed = new EventEmitter<void>();
  @Output() applied = new EventEmitter<WebcamFilterPreference>();
  @Output() cleared = new EventEmitter<WebcamFilterPreference>();

  draft: WebcamFilterPreference = this.emptyDraft(false);

  get isWindy(): boolean {
    return this.provider === 'windy';
  }

  get isTraffic(): boolean {
    return this.provider === 'traffic';
  }

  get isEurope(): boolean {
    return this.provider === 'europe';
  }

  get isDotCatalog(): boolean {
    return this.isTraffic || this.isEurope;
  }

  get isFavorites(): boolean {
    return this.provider === 'favorites';
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open']?.currentValue === true || changes['preference'] || changes['provider']) {
      this.syncDraftFromPreference();
    }
  }

  close(): void {
    this.closed.emit();
  }

  onContinentChange(): void {
    this.draft.country = '';
  }

  apply(): void {
    this.applied.emit(this.snapshot());
  }

  clear(): void {
    const keepApply = !!this.draft.applyToAllTabs;
    this.draft = this.emptyDraft(keepApply);
    if (this.isEurope) {
      this.draft.jurisdiction = this.jurisdictions[0]?.code || 'FRA';
    } else if (this.isTraffic) {
      this.draft.jurisdiction = 'CA';
    } else if (this.isWindy) {
      this.draft.continent = 'EU';
    }
    this.cleared.emit(this.snapshot());
  }

  private emptyDraft(applyToAllTabs: boolean): WebcamFilterPreference {
    return {
      applyToAllTabs,
      catalogQuery: '',
      continent: '',
      country: '',
      category: '',
      sortKey: 'popularity',
      jurisdiction: '',
      hasVideoOnly: false,
      useNearby: false,
      nearbyRadiusKm: 100
    };
  }

  private syncDraftFromPreference(): void {
    const p = this.preference || {};
    this.draft = {
      applyToAllTabs: !!p.applyToAllTabs,
      catalogQuery: p.catalogQuery || '',
      continent: p.continent || '',
      country: p.country || '',
      category: p.category || '',
      sortKey: p.sortKey === 'createdOn' ? 'createdOn' : 'popularity',
      jurisdiction: p.jurisdiction || '',
      hasVideoOnly: !!p.hasVideoOnly,
      useNearby: !!p.useNearby,
      nearbyRadiusKm: Math.max(25, Math.min(300, p.nearbyRadiusKm || 100))
    };
  }

  private snapshot(): WebcamFilterPreference {
    let jurisdiction = (this.draft.jurisdiction || '').trim();
    if (this.isEurope && !jurisdiction) {
      jurisdiction = this.jurisdictions[0]?.code || 'FRA';
    }
    return {
      applyToAllTabs: !!this.draft.applyToAllTabs,
      catalogQuery: (this.draft.catalogQuery || '').trim(),
      continent: (this.draft.continent || '').trim(),
      country: (this.draft.country || '').trim(),
      category: (this.draft.category || '').trim(),
      sortKey: this.draft.sortKey === 'createdOn' ? 'createdOn' : 'popularity',
      jurisdiction,
      hasVideoOnly: !!this.draft.hasVideoOnly,
      useNearby: !!this.draft.useNearby,
      nearbyRadiusKm: Math.max(25, Math.min(300, this.draft.nearbyRadiusKm || 100))
    };
  }
}
