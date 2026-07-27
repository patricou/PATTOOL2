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

import { TvCountry, TvFilterPreference } from '../services/api.service';
import { groupIconEmoji, groupI18nKey } from './tv-group-icon.util';

@Component({
  selector: 'app-tv-global-filter-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './tv-global-filter-modal.component.html',
  styleUrls: ['./tv-global-filter-modal.component.css']
})
export class TvGlobalFilterModalComponent implements OnChanges {
  @Input() open = false;
  @Input() countries: TvCountry[] = [];
  @Input() groups: string[] = [];
  @Input() preference: TvFilterPreference = {};
  @Input() saving = false;
  @Input() loginHint = false;

  @Output() closed = new EventEmitter<void>();
  @Output() applied = new EventEmitter<TvFilterPreference>();
  @Output() cleared = new EventEmitter<TvFilterPreference>();
  @Output() countryChanged = new EventEmitter<string>();

  draft: TvFilterPreference = {
    applyToAllTabs: false,
    channelQuery: '',
    programQuery: '',
    country: 'all',
    group: ''
  };

  /** Narrows the country &lt;select&gt; options (name, code, aliases). */
  countryFilter = '';

  get filteredCountries(): TvCountry[] {
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
    this.draft.group = '';
    this.countryChanged.emit((this.draft.country || 'all').toLowerCase());
  }

  apply(): void {
    this.applied.emit(this.snapshot());
  }

  clear(): void {
    this.draft = {
      applyToAllTabs: !!this.draft.applyToAllTabs,
      channelQuery: '',
      programQuery: '',
      country: 'all',
      group: ''
    };
    this.countryFilter = '';
    this.cleared.emit(this.snapshot());
  }

  groupEmoji(group: string): string {
    return groupIconEmoji(group);
  }

  groupLabelKey(group: string): string {
    const raw = (group || '').trim();
    if (!raw) {
      return 'TV.GROUP_ALL';
    }
    return groupI18nKey(raw) || raw;
  }

  private countryMatchesFilter(country: TvCountry, needle: string): boolean {
    const code = (country?.code || '').toLowerCase();
    const name = this.normalizeCountryNeedle(country?.name || '');
    if (code.includes(needle) || name.includes(needle)) {
      return true;
    }
    const aliases = COUNTRY_SEARCH_ALIASES[code];
    return !!aliases?.some((a) => a.includes(needle) || needle.includes(a));
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
      channelQuery: p.channelQuery || '',
      programQuery: p.programQuery || '',
      country: (p.country || 'all').toLowerCase(),
      group: p.group || ''
    };
  }

  private snapshot(): TvFilterPreference {
    return {
      applyToAllTabs: !!this.draft.applyToAllTabs,
      channelQuery: (this.draft.channelQuery || '').trim(),
      programQuery: (this.draft.programQuery || '').trim(),
      country: ((this.draft.country || 'all').trim() || 'all').toLowerCase(),
      group: (this.draft.group || '').trim()
    };
  }
}

/** Extra needles so "usa" / "etats unis" find {@code us}, etc. */
const COUNTRY_SEARCH_ALIASES: Record<string, string[]> = {
  us: ['usa', 'etats unis', 'etats-unis', 'united states', 'america', 'u.s.', 'u.s.a'],
  gb: ['uk', 'united kingdom', 'grande bretagne', 'angleterre', 'england', 'britain'],
  ae: ['emirates', 'uae', 'emirats'],
  kr: ['south korea', 'coree du sud', 'korea'],
  kp: ['north korea', 'coree du nord'],
  cz: ['czech', 'tchequie', 'republique tcheque'],
  ci: ['ivory coast', 'cote divoire', "cote d'ivoire"],
  cd: ['congo kinshasa', 'drc'],
  cg: ['congo brazzaville'],
  ru: ['russia', 'russie', 'federation de russie']
};
