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
  TvChannel,
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
  @Output() playChannel = new EventEmitter<TvChannel>();

  browseCountry = 'fr';
  tvFilter = '';
  rows: TvEpgBrowseChannel[] = [];
  loading = false;
  errorKey = '';
  expandedId = '';
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
      this.browseCountry = c === 'all' ? 'fr' : c;
      this.tvFilter = '';
      this.expandedId = '';
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

  onCountryChange(): void {
    this.expandedId = '';
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

  toggleExpand(row: TvEpgBrowseChannel): void {
    const id = (row.channelId || '').trim();
    if (!id) {
      return;
    }
    if (this.expandedId === id) {
      this.expandedId = '';
      this.expandedProgrammes = [];
      this.filteredExpandedProgrammes = [];
      this.cdr.markForCheck();
      return;
    }
    this.expandedId = id;
    this.loadingSchedule = true;
    this.expandedProgrammes = [];
    this.filteredExpandedProgrammes = [];
    this.scheduleSub?.unsubscribe();
    this.scheduleSub = this.api.getTvEpgSchedule(this.browseCountry, id).subscribe({
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
    if (row.channel?.streamUrl || row.channel?.id) {
      this.playChannel.emit(row.channel!);
      return;
    }
  }

  canPlay(row: TvEpgBrowseChannel): boolean {
    return !!(row.channel?.streamUrl || row.channel?.id);
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

  private loadBrowse(): void {
    const country = (this.browseCountry || 'fr').toLowerCase();
    if (!country || country === 'all') {
      this.rows = [];
      this.errorKey = 'TV.EPG_BROWSER_PICK_COUNTRY';
      this.cdr.markForCheck();
      return;
    }
    this.loading = true;
    this.errorKey = '';
    this.browseSub?.unsubscribe();
    this.browseSub = this.api.getTvEpgBrowse(country, this.tvFilter.trim() || undefined, 150).subscribe({
      next: (list) => {
        this.rows = list || [];
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
