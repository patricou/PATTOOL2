import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TranslateService } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';

export type SaintsByDay = Record<string, string>;
export type SaintCalendarId = 'liturgical' | 'traditional';

export interface SaintDayOption {
    /** MM-DD */
    key: string;
    name: string;
    /** Name + localized calendar date, for duplicate names. */
    label: string;
    month: number;
    day: number;
}

const SUPPORTED_LANGS = new Set(['fr', 'en', 'de', 'es', 'it', 'ar', 'cn', 'el', 'he', 'in', 'jp', 'ru']);
export const SAINT_CALENDAR_STORAGE = 'pat-tool-calendar-saint-calendar';

@Injectable({ providedIn: 'root' })
export class SaintOfDayService {

    private readonly http = inject(HttpClient);
    private readonly translate = inject(TranslateService);

    private readonly cache = new Map<string, SaintsByDay>();
    private currentMap: SaintsByDay = {};
    private saintOptions: SaintDayOption[] = [];
    private activeCalendarId: SaintCalendarId = 'traditional';

    getActiveCalendarId(): SaintCalendarId {
        return this.activeCalendarId;
    }

    /** Lookup synchronously once {@link load} has completed. */
    getName(date: Date): string {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return this.currentMap[`${month}-${day}`]?.trim() || '';
    }

    getOptions(): SaintDayOption[] {
        return this.saintOptions;
    }

    filterOptions(query: string, max = 48): SaintDayOption[] {
        const q = this.normalizeSearch(query.trim());
        if (!q) {
            return this.saintOptions.slice(0, max);
        }
        return this.saintOptions
            .filter(o => this.normalizeSearch(o.name).includes(q) || this.normalizeSearch(o.label).includes(q))
            .slice(0, max);
    }

    load(calendarId?: SaintCalendarId): Observable<SaintsByDay> {
        const calendar = calendarId ?? this.readStoredCalendarId();
        this.activeCalendarId = calendar;
        const lang = this.pickDataLang(calendar);
        const cacheKey = `${calendar}:${lang}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
            this.currentMap = cached;
            this.rebuildOptions();
            return of(cached);
        }
        const url = calendar === 'traditional'
            ? 'assets/saints/traditional/fr.json'
            : `assets/saints/liturgical/${lang}.json`;
        const fallback = calendar === 'traditional'
            ? 'assets/saints/traditional/fr.json'
            : 'assets/saints/liturgical/fr.json';
        return this.http.get<SaintsByDay>(url).pipe(
            catchError(() => this.http.get<SaintsByDay>(fallback)),
            map(data => data ?? {}),
            tap(data => {
                this.cache.set(cacheKey, data);
                this.currentMap = data;
                this.rebuildOptions();
            })
        );
    }

    /** @deprecated use {@link load} */
    loadForCurrentLang(): Observable<SaintsByDay> {
        return this.load();
    }

    readStoredCalendarId(): SaintCalendarId {
        try {
            const raw = localStorage.getItem(SAINT_CALENDAR_STORAGE)?.trim().toLowerCase();
            if (raw === 'traditional' || raw === 'liturgical') {
                return raw;
            }
        } catch {
            /* ignore */
        }
        return 'traditional';
    }

    dateFromOption(opt: SaintDayOption, year: number): Date {
        const month = opt.month;
        let day = opt.day;
        if (month === 2 && day === 29 && !this.isLeapYear(year)) {
            day = 28;
        }
        return new Date(year, month - 1, day, 12, 0, 0, 0);
    }

    private pickDataLang(calendar: SaintCalendarId): string {
        if (calendar === 'traditional') {
            return 'fr';
        }
        return this.pickSaintLang();
    }

    private rebuildOptions(): void {
        const loc = (this.translate.currentLang || 'fr').replace('_', '-');
        const entries: SaintDayOption[] = [];
        for (const [key, rawName] of Object.entries(this.currentMap)) {
            const name = rawName?.trim();
            if (!name) {
                continue;
            }
            const parts = key.split('-');
            if (parts.length !== 2) {
                continue;
            }
            const month = Number(parts[0]);
            const day = Number(parts[1]);
            if (!Number.isFinite(month) || !Number.isFinite(day)) {
                continue;
            }
            const refDate = new Date(2024, month - 1, day, 12, 0, 0, 0);
            let dateLabel = `${day}/${month}`;
            try {
                dateLabel = refDate.toLocaleDateString(loc, { day: 'numeric', month: 'short' });
            } catch {
                try {
                    dateLabel = refDate.toLocaleDateString('fr', { day: 'numeric', month: 'short' });
                } catch {
                    /* keep numeric fallback */
                }
            }
            entries.push({
                key,
                name,
                label: `${name} (${dateLabel})`,
                month,
                day
            });
        }
        entries.sort((a, b) => {
            const byName = a.name.localeCompare(b.name, loc, { sensitivity: 'base' });
            if (byName !== 0) {
                return byName;
            }
            return a.month !== b.month ? a.month - b.month : a.day - b.day;
        });
        this.saintOptions = entries;
    }

    private normalizeSearch(value: string): string {
        return value
            .normalize('NFD')
            .replace(/\p{M}/gu, '')
            .toLowerCase();
    }

    private isLeapYear(year: number): boolean {
        return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    }

    private pickSaintLang(): string {
        const raw = (this.translate.currentLang || 'fr').trim().toLowerCase().replace(/_/g, '-');
        const primary = raw.split('-')[0] || 'fr';
        if (SUPPORTED_LANGS.has(primary)) {
            return primary;
        }
        return 'en';
    }
}
