import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';
import { environment } from '../../environments/environment';

/** Forme JSON des jours fériés (proxy backend, même schéma que Nager.Date). */
export interface NagerPublicHoliday {
    date: string;
    localName: string;
    name: string;
    /** Traduction du nom anglais vers la langue UI (backend), si demandée. */
    translatedName?: string | null;
    countryCode: string;
    fixed: boolean;
    global: boolean;
    counties: string[] | null;
    launchYear: number | null;
    types: string[];
}

export interface NagerCountry {
    key: string;
    name: string;
}

/**
 * Jours fériés publics par pays / année : appels via le backend PatTool (proxy Nager.Date).
 */
@Injectable({ providedIn: 'root' })
export class PublicHolidayService {

    private readonly http = inject(HttpClient);
    private readonly baseUrl = `${environment.API_URL}calendar/public-holidays`;
    /** Réponses Nager déjà chargées (année + pays + langue d’UI) — évite de refaire des GET en naviguant dans l’agenda. */
    private readonly holidayDataCache = new Map<string, NagerPublicHoliday[]>();

    getAvailableCountries(): Observable<NagerCountry[]> {
        return this.http.get<NagerCountry[]>(`${this.baseUrl}/countries`).pipe(
            catchError(() => of([]))
        );
    }

    /**
     * Pays ISO déduit de l’IP côté serveur (null si inconnu / IP locale).
     * Utilisé pour le pays des jours fériés par défaut si l’utilisateur n’a pas encore choisi.
     */
    getClientCountryCode(): Observable<string | null> {
        return this.http.get<{ countryCode?: string | null }>(`${this.baseUrl}/client-country`).pipe(
            map(r => {
                const c = (r?.countryCode ?? '').trim().toUpperCase();
                return /^[A-Z]{2}$/.test(c) ? c : null;
            }),
            catchError(() => of(null))
        );
    }

    /**
     * @param uiLang Code langue PatTool (ex. fr, cn) : le backend traduit le libellé anglais Nager ; omis en mode « langue du pays ».
     */
    getPublicHolidays(year: number, countryCode: string, uiLang?: string | null): Observable<NagerPublicHoliday[]> {
        const raw = (countryCode || 'FR').trim().toUpperCase();
        const cc = /^[A-Z]{2}$/.test(raw) ? raw : 'FR';
        const ul = (uiLang || '').trim().toLowerCase();
        const cacheKey = `${year}|${cc}|${ul}`;
        const cached = this.holidayDataCache.get(cacheKey);
        if (cached) {
            return of(cached);
        }
        const opts =
            ul.length > 0 && ul !== 'en' ? { params: new HttpParams().set('uiLang', ul) } : {};
        return this.http.get<NagerPublicHoliday[]>(`${this.baseUrl}/${year}/${cc}`, opts).pipe(
            tap(rows => this.holidayDataCache.set(cacheKey, Array.isArray(rows) ? rows : [])),
            catchError(() => of([] as NagerPublicHoliday[]))
        );
    }
}
