import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { Subject, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';

import {
  ApiService,
  TimezoneConvertResponse,
  TimezoneInstant,
  TimezoneZone
} from '../services/api.service';

interface PopularZone {
  id: string;
  labelKey: string;
}

/**
 * Time-zone converter page — conversions are performed by the PatTool backend (java.time).
 */
@Component({
  selector: 'app-timezone-converter',
  templateUrl: './timezone-converter.component.html',
  styleUrls: ['./timezone-converter.component.css'],
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule]
})
export class TimezoneConverterComponent implements OnInit, OnDestroy {

  dateTimeLocal = '';
  fromZone = 'Europe/Paris';
  toZone = 'America/New_York';

  zones: TimezoneZone[] = [];
  filteredFromZones: TimezoneZone[] = [];
  filteredToZones: TimezoneZone[] = [];
  fromFilter = '';
  toFilter = '';
  editingFrom = false;
  editingTo = false;

  readonly popularZones: PopularZone[] = [
    { id: 'Europe/Paris', labelKey: 'TIMEZONE.POPULAR.PARIS' },
    { id: 'Europe/London', labelKey: 'TIMEZONE.POPULAR.LONDON' },
    { id: 'America/New_York', labelKey: 'TIMEZONE.POPULAR.NEW_YORK' },
    { id: 'America/Los_Angeles', labelKey: 'TIMEZONE.POPULAR.LOS_ANGELES' },
    { id: 'Asia/Tokyo', labelKey: 'TIMEZONE.POPULAR.TOKYO' },
    { id: 'Asia/Kolkata', labelKey: 'TIMEZONE.POPULAR.INDIA' },
    { id: 'Australia/Sydney', labelKey: 'TIMEZONE.POPULAR.SYDNEY' },
    { id: 'UTC', labelKey: 'TIMEZONE.POPULAR.UTC' }
  ];

  result: TimezoneConvertResponse | null = null;
  errorMessage = '';
  isLoadingZones = false;
  isConverting = false;

  private readonly inputs$ = new Subject<void>();
  private subs: Subscription[] = [];

  constructor(
    private api: ApiService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.setNowFromBrowser();
    this.loadZones();

    this.subs.push(
      this.inputs$.pipe(debounceTime(350)).subscribe(() => {
        this.refreshZoneLabels();
        this.convert();
      })
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  onInputChanged(): void {
    this.inputs$.next();
  }

  swap(): void {
    const tmpZone = this.fromZone;
    this.fromZone = this.toZone;
    this.toZone = tmpZone;
    this.editingFrom = false;
    this.editingTo = false;
    this.fromFilter = '';
    this.toFilter = '';
    this.applyFromFilter();
    this.applyToFilter();
    this.onInputChanged();
  }

  setNow(): void {
    this.isConverting = true;
    this.errorMessage = '';
    this.api.getTimezoneNow(this.fromZone).subscribe({
      next: (res) => {
        this.dateTimeLocal = this.toDateTimeLocalValue(res);
        this.isConverting = false;
        this.convert();
        this.cdr.markForCheck();
      },
      error: () => {
        this.setNowFromBrowser();
        this.isConverting = false;
        this.onInputChanged();
        this.cdr.markForCheck();
      }
    });
  }

  zoneById(zoneId: string): TimezoneZone | undefined {
    return this.zones.find((z) => z.id === zoneId);
  }

  zoneCityName(zoneId: string): string {
    const tail = (zoneId || '').split('/').pop() || zoneId;
    return tail.replace(/_/g, ' ');
  }

  startEditFrom(): void {
    this.editingFrom = true;
    this.editingTo = false;
    this.fromFilter = '';
    this.applyFromFilter();
  }

  startEditTo(): void {
    this.editingTo = true;
    this.editingFrom = false;
    this.toFilter = '';
    this.applyToFilter();
  }

  cancelEditFrom(): void {
    this.editingFrom = false;
    this.fromFilter = '';
    this.applyFromFilter();
  }

  cancelEditTo(): void {
    this.editingTo = false;
    this.toFilter = '';
    this.applyToFilter();
  }

  onFromSearchChange(): void {
    this.applyFromFilter();
  }

  onToSearchChange(): void {
    this.applyToFilter();
  }

  selectFromZone(zone: TimezoneZone): void {
    this.fromZone = zone.id;
    this.fromFilter = '';
    this.editingFrom = false;
    this.applyFromFilter();
    this.onInputChanged();
  }

  selectToZone(zone: TimezoneZone): void {
    this.toZone = zone.id;
    this.toFilter = '';
    this.editingTo = false;
    this.applyToFilter();
    this.onInputChanged();
  }

  pickPopular(id: string, target: 'from' | 'to'): void {
    if (target === 'from') {
      this.selectFromZone({ id, abbreviation: '', offset: '', offsetSeconds: 0, label: id });
    } else {
      this.selectToZone({ id, abbreviation: '', offset: '', offsetSeconds: 0, label: id });
    }
  }

  pickFirstFrom(event: Event): void {
    event.preventDefault();
    if (this.filteredFromZones.length) {
      this.selectFromZone(this.filteredFromZones[0]);
    }
  }

  pickFirstTo(event: Event): void {
    event.preventDefault();
    if (this.filteredToZones.length) {
      this.selectToZone(this.filteredToZones[0]);
    }
  }

  applyFromFilter(): void {
    this.filteredFromZones = this.filterZones(this.fromFilter);
  }

  applyToFilter(): void {
    this.filteredToZones = this.filterZones(this.toFilter);
  }

  dayShiftLabel(dayDifference: number | null | undefined): string {
    if (dayDifference == null || dayDifference === 0) {
      return '';
    }
    return dayDifference > 0 ? `+${dayDifference}` : `${dayDifference}`;
  }

  private loadZones(): void {
    this.isLoadingZones = true;
    this.api.getTimezoneZones(undefined, this.dateTimeLocal || undefined, this.fromZone || undefined).subscribe({
      next: (res) => {
        this.applyZoneList(res?.zones || []);
        this.isLoadingZones = false;
        this.convert();
        this.cdr.markForCheck();
      },
      error: () => {
        this.errorMessage = 'TIMEZONE.ERROR_ZONES';
        this.isLoadingZones = false;
        this.cdr.markForCheck();
      }
    });
  }

  private refreshZoneLabels(): void {
    if (!this.dateTimeLocal || !this.fromZone) {
      return;
    }
    this.api.getTimezoneZones(undefined, this.dateTimeLocal, this.fromZone).subscribe({
      next: (res) => {
        this.applyZoneList(res?.zones || []);
        this.cdr.markForCheck();
      }
    });
  }

  private applyZoneList(zones: TimezoneZone[]): void {
    this.zones = zones.slice().sort((a, b) => a.id.localeCompare(b.id));
    this.applyFromFilter();
    this.applyToFilter();
    this.ensureKnownZones();
  }

  private convert(): void {
    if (!this.dateTimeLocal || !this.fromZone || !this.toZone) {
      this.result = null;
      return;
    }
    if (this.fromZone === this.toZone) {
      this.errorMessage = 'TIMEZONE.SAME_ZONE';
      this.result = null;
      return;
    }

    this.isConverting = true;
    this.errorMessage = '';
    this.api.convertTimezone(this.dateTimeLocal, this.fromZone, this.toZone).subscribe({
      next: (res) => {
        this.result = res;
        this.isConverting = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.errorMessage = 'TIMEZONE.ERROR_CONVERT';
        this.result = null;
        this.isConverting = false;
        this.cdr.markForCheck();
      }
    });
  }

  private filterZones(query: string): TimezoneZone[] {
    const q = (query || '').trim().toLowerCase();
    if (!q) {
      return this.zones;
    }
    return this.zones
      .map((z) => ({ z, score: this.zoneMatchScore(z, q) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.z.id.localeCompare(b.z.id))
      .slice(0, 50)
      .map((entry) => entry.z);
  }

  private zoneMatchScore(z: TimezoneZone, q: string): number {
    const abbr = this.effectiveAbbreviation(z).toLowerCase();
    const id = z.id.toLowerCase();
    const label = (z.label || '').toLowerCase();

    if (abbr === q) return 100;
    if (abbr.startsWith(q)) return 90;
    if (id === q) return 85;
    const idTail = id.split('/').pop() || id;
    if (idTail === q || idTail.startsWith(q)) return 75;
    if (abbr.includes(q)) return 60;
    if (id.includes(q)) return 40;
    if (label.includes(q)) return 20;
    return 0;
  }

  /** Letter abbreviation for display/search (fallback when API returns UTC offset only). */
  effectiveAbbreviation(z: TimezoneZone | undefined): string {
    if (!z) {
      return '';
    }
    const raw = (z.abbreviation || '').trim();
    if (/^[A-Za-z]{2,5}$/.test(raw)) {
      return raw.toUpperCase();
    }
    const id = z.id;
    const off = z.offset;
    if (id === 'Asia/Kolkata' || id === 'Asia/Calcutta') return 'IST';
    if (id === 'Asia/Tokyo') return 'JST';
    if (id === 'UTC' || id.startsWith('Etc/UTC')) return 'UTC';
    if (id === 'Europe/London') return off === '+01:00' ? 'BST' : 'GMT';
    if (id.startsWith('Europe/') && off === '+02:00') return 'CEST';
    if (id.startsWith('Europe/') && off === '+01:00') return 'CET';
    if ((id.startsWith('America/New_York') || id.startsWith('America/Toronto')) && off === '-04:00') return 'EDT';
    if ((id.startsWith('America/New_York') || id.startsWith('America/Toronto')) && off === '-05:00') return 'EST';
    if ((id.startsWith('America/Los_Angeles') || id.startsWith('America/Vancouver')) && off === '-07:00') return 'PDT';
    if ((id.startsWith('America/Los_Angeles') || id.startsWith('America/Vancouver')) && off === '-08:00') return 'PST';
    return raw || off;
  }

  displayAbbreviation(zoneId: string, apiAbbr?: string | null): string {
    const fromList = this.effectiveAbbreviation(this.zoneById(zoneId));
    if (/^[A-Z]{2,5}$/.test(fromList)) {
      return fromList;
    }
    const raw = (apiAbbr || '').trim();
    if (/^[A-Za-z]{2,5}$/.test(raw)) {
      return raw.toUpperCase();
    }
    return fromList || raw || '—';
  }

  private ensureKnownZones(): void {
    const ids = new Set(this.zones.map((z) => z.id));
    if (!ids.has(this.fromZone)) {
      this.fromZone = this.zones[0]?.id || 'UTC';
    }
    if (!ids.has(this.toZone)) {
      this.toZone = this.zones.find((z) => z.id === 'UTC')?.id || this.zones[0]?.id || 'UTC';
    }
  }

  private setNowFromBrowser(): void {
    const now = new Date();
    now.setSeconds(0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    this.dateTimeLocal = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  private toDateTimeLocalValue(instant: TimezoneInstant): string {
    const raw = instant?.dateTime || '';
    if (!raw) {
      return this.dateTimeLocal;
    }
    return raw.replace(' ', 'T').slice(0, 16);
  }
}
