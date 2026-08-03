import { CommonModule } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

import {
  ApiService,
  TvCountry,
  TvEpgBrowseChannel,
  TvEpgProgramme
} from '../services/api.service';

@Component({
  selector: 'app-tv-epg-browser',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './tv-epg-browser.component.html',
  styleUrls: ['./tv-epg-browser.component.css']
})
export class TvEpgBrowserComponent implements OnChanges, OnDestroy {
  @Input() open = false;
  @Input() countries: TvCountry[] = [];
  @Input() initialCountry = 'fr';
  @Output() closed = new EventEmitter<void>();
  /** Ask parent to play this EPG row (parent resolves catalog + closes modal). */
  @Output() playRow = new EventEmitter<TvEpgBrowseChannel>();

  browseCountry = 'fr';
  tvFilter = '';
  /** When true (default), programme-title search only matches what is airing now. */
  nowOnlyPlaying = true;
  rows: TvEpgBrowseChannel[] = [];
  loading = false;
  errorKey = '';
  expandedKey = '';
  expandedProgrammes: TvEpgProgramme[] = [];
  filteredExpandedProgrammes: TvEpgProgramme[] = [];
  loadingSchedule = false;

  private filter$ = new Subject<string>();
  private filterSub?: Subscription;
  private browseSub?: Subscription;
  private scheduleSub?: Subscription;

  constructor(
    private api: ApiService,
    private cdr: ChangeDetectorRef
  ) {
    this.filterSub = this.filter$
      .pipe(debounceTime(280), distinctUntilChanged())
      .subscribe(() => {
        this.applyScheduleFilter();
        this.loadBrowse();
      });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open']?.currentValue === true) {
      const c = (this.initialCountry || 'fr').toLowerCase();
      this.browseCountry = c || 'fr';
      this.tvFilter = '';
      this.nowOnlyPlaying = true;
      this.expandedKey = '';
      this.expandedProgrammes = [];
      this.filteredExpandedProgrammes = [];
      this.loadBrowse();
    }
  }

  ngOnDestroy(): void {
    this.filterSub?.unsubscribe();
    this.browseSub?.unsubscribe();
    this.scheduleSub?.unsubscribe();
  }

  close(): void {
    this.closed.emit();
  }

  get isWorldwide(): boolean {
    return (this.browseCountry || '').toLowerCase() === 'all';
  }

  rowKey(row: TvEpgBrowseChannel): string {
    const cc = (row.country || this.browseCountry || '').toLowerCase();
    return `${cc}|${(row.channelId || '').trim()}`;
  }

  onCountryChange(): void {
    this.expandedKey = '';
    this.expandedProgrammes = [];
    this.filteredExpandedProgrammes = [];
    this.loadBrowse();
  }

  onFilterInput(value: string): void {
    this.tvFilter = value || '';
    this.filter$.next(this.tvFilter.trim().toLowerCase());
  }

  clearFilter(): void {
    this.tvFilter = '';
    this.filter$.next('');
  }

  onNowOnlyChange(): void {
    this.applyScheduleFilter();
    this.loadBrowse();
  }

  toggleExpand(row: TvEpgBrowseChannel): void {
    const id = (row.channelId || '').trim();
    if (!id) {
      return;
    }
    const key = this.rowKey(row);
    if (this.expandedKey === key) {
      this.expandedKey = '';
      this.expandedProgrammes = [];
      this.filteredExpandedProgrammes = [];
      this.cdr.markForCheck();
      return;
    }
    this.expandedKey = key;
    this.loadingSchedule = true;
    this.expandedProgrammes = [];
    this.filteredExpandedProgrammes = [];
    const scheduleCountry = (row.country || this.browseCountry || 'fr').toLowerCase();
    this.scheduleSub?.unsubscribe();
    this.scheduleSub = this.api.getTvEpgSchedule(scheduleCountry, id).subscribe({
      next: (sched) => {
        this.expandedProgrammes = sched?.programmes || [];
        this.applyScheduleFilter();
        this.loadingSchedule = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.expandedProgrammes = [];
        this.filteredExpandedProgrammes = [];
        this.loadingSchedule = false;
        this.cdr.markForCheck();
      }
    });
  }

  play(row: TvEpgBrowseChannel, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    if (!row) {
      return;
    }
    this.playRow.emit(row);
  }

  canPlay(row: TvEpgBrowseChannel): boolean {
    if (row.channel?.streamUrl) {
      return true;
    }
    // Offer Watch whenever we can resolve a catalog country for this EPG id.
    return !!(row.channelId && this.catalogCountryFor(row));
  }

  private catalogCountryFor(row: TvEpgBrowseChannel): string {
    const cc = (row.country || this.browseCountry || '').trim().toLowerCase();
    return cc && cc !== 'all' ? cc : '';
  }

  isLive(p: TvEpgProgramme | null | undefined): boolean {
    if (!p?.start || !p?.stop) {
      return false;
    }
    const start = new Date(p.start).getTime();
    const stop = new Date(p.stop).getTime();
    const now = Date.now();
    return !Number.isNaN(start) && !Number.isNaN(stop) && start <= now && now < stop;
  }

  isPast(p: TvEpgProgramme | null | undefined): boolean {
    if (!p?.stop) {
      return false;
    }
    const stop = new Date(p.stop).getTime();
    return !Number.isNaN(stop) && stop <= Date.now();
  }

  /** CSS modifier classes for coloured programme rows. */
  programmeToneClass(p: TvEpgProgramme): string {
    if (this.isLive(p)) {
      return 'is-live tone-live';
    }
    if (this.isPast(p)) {
      return 'is-past tone-past';
    }
    return `is-upcoming tone-${this.programmeAccentIndex(p)}`;
  }

  programmeMatchesFilter(p: TvEpgProgramme | null | undefined): boolean {
    const q = this.tvFilter.trim().toLowerCase();
    if (!q || !p) {
      return false;
    }
    if (this.nowOnlyPlaying && !this.isLive(p)) {
      return false;
    }
    const title = (p.title || '').toLowerCase();
    const desc = (p.description || '').toLowerCase();
    return title.includes(q) || desc.includes(q);
  }

  formatClock(iso: string | null | undefined): string {
    if (!iso) {
      return '';
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return '';
    }
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  formatDay(iso: string | null | undefined): string {
    if (!iso) {
      return '';
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return '';
    }
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  private programmeAccentIndex(p: TvEpgProgramme): number {
    const key = (p.title || p.start || '').trim().toLowerCase();
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 8;
  }

  private applyScheduleFilter(): void {
    const q = this.tvFilter.trim().toLowerCase();
    if (!q) {
      this.filteredExpandedProgrammes = this.expandedProgrammes;
      return;
    }
    if (this.nowOnlyPlaying) {
      // Only currently airing programmes that match the query.
      this.filteredExpandedProgrammes = this.expandedProgrammes.filter((p) => this.programmeMatchesFilter(p));
      return;
    }
    // Keep full schedule visible but put matching programmes first when filtering.
    const matches: TvEpgProgramme[] = [];
    const rest: TvEpgProgramme[] = [];
    for (const p of this.expandedProgrammes) {
      if (this.programmeMatchesFilter(p)) {
        matches.push(p);
      } else {
        rest.push(p);
      }
    }
    this.filteredExpandedProgrammes = matches.length ? [...matches, ...rest] : this.expandedProgrammes;
  }

  private sortChannelsByName(list: TvEpgBrowseChannel[]): TvEpgBrowseChannel[] {
    return [...list].sort((a, b) => {
      const an = (a.name || a.channelId || '').trim();
      const bn = (b.name || b.channelId || '').trim();
      const byName = an.localeCompare(bn, undefined, { sensitivity: 'base' });
      if (byName !== 0) {
        return byName;
      }
      return (a.channelId || '').localeCompare(b.channelId || '', undefined, { sensitivity: 'base' });
    });
  }

  private loadBrowse(): void {
    const country = (this.browseCountry || 'fr').toLowerCase();
    if (!country) {
      this.rows = [];
      this.errorKey = 'TV.EPG_BROWSER_PICK_COUNTRY';
      this.cdr.markForCheck();
      return;
    }
    const q = this.tvFilter.trim();
    if (country === 'all' && q.length < 2) {
      this.rows = [];
      this.errorKey = 'TV.EPG_BROWSER_NEED_QUERY_WORLDWIDE';
      this.loading = false;
      this.cdr.markForCheck();
      return;
    }
    this.loading = true;
    this.errorKey = '';
    this.browseSub?.unsubscribe();
    this.browseSub = this.api
      .getTvEpgBrowse(country, q || undefined, 150, this.nowOnlyPlaying)
      .subscribe({
        next: (list) => {
          this.rows = this.sortChannelsByName(list || []);
          this.loading = false;
          if (!this.rows.length) {
            this.errorKey = 'TV.EPG_BROWSER_EMPTY';
          }
          this.cdr.markForCheck();
        },
        error: () => {
          this.rows = [];
          this.loading = false;
          this.errorKey = 'TV.EPG_BROWSER_ERROR';
          this.cdr.markForCheck();
        }
      });
  }
}

