import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import {
  ApiService,
  StellariumSkySource,
  WikipediaSearchPage,
  WikipediaSummary
} from '../services/api.service';
import type { AstroSatelliteOption } from './astro-compass-catalog';

export interface ObjectDossier {
  extract: string | null;
  description: string | null;
  thumbUrl: string | null;
  imageUrl: string | null;
  wikiUrl: string | null;
  wikiTitle: string | null;
  skyNames: string[];
  skyTypes: string[];
  vMag: number | null;
  bMag: number | null;
}

interface WikiLookup {
  fr: string;
  en: string;
  sky: string;
  search?: string;
}

/** Same satellite Wikipedia titles as the astro-compass object fiche. */
const SATELLITE_WIKI_LOOKUP: Record<string, WikiLookup> = {
  'iss:iss': {
    fr: 'Station_spatiale_internationale',
    en: 'International_Space_Station',
    sky: 'ISS',
    search: 'ISS station spatiale internationale'
  },
  'iss:tiangong': {
    fr: 'Station_spatiale_chinoise',
    en: 'Tiangong_space_station',
    sky: 'Tiangong',
    search: 'Tiangong station spatiale chinoise'
  },
  'iss:hubble': {
    fr: 'Hubble_(télescope_spatial)',
    en: 'Hubble_Space_Telescope',
    sky: 'HST',
    search: 'Hubble télescope spatial'
  },
  'iss:jwst': {
    fr: 'James_Webb_(télescope_spatial)',
    en: 'James_Webb_Space_Telescope',
    sky: 'JWST',
    search: 'James Webb télescope spatial JWST'
  },
  'iss:terra': { fr: 'Terra_(satellite)', en: 'Terra_(satellite)', sky: 'Terra', search: 'Terra satellite NASA EOS' },
  'iss:aqua': { fr: 'Aqua_(satellite)', en: 'Aqua_(satellite)', sky: 'Aqua', search: 'Aqua satellite NASA EOS' },
  'iss:landsat8': { fr: 'Landsat_8', en: 'Landsat_8', sky: 'Landsat8', search: 'Landsat 8 satellite' },
  'iss:landsat9': { fr: 'Landsat_9', en: 'Landsat_9', sky: 'Landsat9', search: 'Landsat 9 satellite' },
  'iss:sentinel2a': { fr: 'Sentinel-2', en: 'Sentinel-2', sky: 'Sentinel-2A', search: 'Sentinel-2 satellite' },
  'iss:sentinel2b': { fr: 'Sentinel-2', en: 'Sentinel-2', sky: 'Sentinel-2B', search: 'Sentinel-2 satellite' },
  'iss:sentinel2c': { fr: 'Sentinel-2', en: 'Sentinel-2', sky: 'Sentinel-2C', search: 'Sentinel-2 satellite' },
  'iss:noaa20': { fr: 'NOAA-20', en: 'NOAA-20', sky: 'NOAA-20', search: 'NOAA-20 satellite' },
  'iss:noaa21': { fr: 'NOAA-21', en: 'NOAA-21', sky: 'NOAA-21', search: 'NOAA-21 satellite' },
  'iss:suominpp': { fr: 'Suomi_NPP', en: 'Suomi_NPP', sky: 'Suomi NPP', search: 'Suomi NPP satellite' },
  'iss:aura': { fr: 'Aura_(satellite)', en: 'Aura_(satellite)', sky: 'Aura', search: 'Aura satellite NASA EOS' },
  'iss:sentinel1a': { fr: 'Sentinel-1', en: 'Sentinel-1', sky: 'Sentinel-1A', search: 'Sentinel-1 satellite' },
  'iss:sentinel1c': { fr: 'Sentinel-1', en: 'Sentinel-1', sky: 'Sentinel-1C', search: 'Sentinel-1 satellite' },
  'iss:sentinel3a': { fr: 'Sentinel-3', en: 'Sentinel-3', sky: 'Sentinel-3A', search: 'Sentinel-3 satellite' },
  'iss:sentinel3b': { fr: 'Sentinel-3', en: 'Sentinel-3', sky: 'Sentinel-3B', search: 'Sentinel-3 satellite' },
  'iss:sentinel5p': {
    fr: 'Sentinel-5_Precursor',
    en: 'Sentinel-5_Precursor',
    sky: 'Sentinel-5P',
    search: 'Sentinel-5P satellite'
  },
  'iss:sentinel6': {
    fr: 'Sentinel-6',
    en: 'Sentinel-6_Michael_Freilich',
    sky: 'Sentinel-6',
    search: 'Sentinel-6 Michael Freilich satellite'
  },
  'iss:metopb': { fr: 'MetOp', en: 'MetOp', sky: 'MetOp-B', search: 'MetOp satellite météorologique' },
  'iss:metopc': { fr: 'MetOp', en: 'MetOp', sky: 'MetOp-C', search: 'MetOp satellite météorologique' },
  'iss:gpm': {
    fr: 'Global_Precipitation_Measurement',
    en: 'Global_Precipitation_Measurement',
    sky: 'GPM',
    search: 'GPM Global Precipitation Measurement satellite'
  },
  'iss:swift': {
    fr: 'Swift_(télescope_spatial)',
    en: 'Neil_Gehrels_Swift_Observatory',
    sky: 'Swift',
    search: 'Swift télescope spatial NASA'
  },
  'iss:fermi': {
    fr: 'Fermi_Gamma-ray_Space_Telescope',
    en: 'Fermi_Gamma-ray_Space_Telescope',
    sky: 'Fermi',
    search: 'Fermi Gamma-ray Space Telescope'
  },
  'iss:astra192': { fr: 'Astra 19.2E', en: 'Astra 19.2E', sky: 'Astra', search: 'Astra 19.2E satellite SES' },
  'iss:starlink': { fr: 'Starlink', en: 'Starlink', sky: 'Starlink', search: 'Starlink constellation satellite SpaceX' }
};

@Injectable({ providedIn: 'root' })
export class AstroObjectDossierService {
  private readonly api = inject(ApiService);
  private readonly translate = inject(TranslateService);

  loadForSatellite(sat: AstroSatelliteOption): Observable<ObjectDossier | null> {
    const lookup = this.lookupForSatellite(sat);
    const lang = (this.translate.currentLang || 'fr').toLowerCase();
    const preferFr = lang.startsWith('fr');
    const firstTitle = preferFr ? lookup.fr : lookup.en;
    const fallbackTitle = preferFr ? lookup.en : lookup.fr;
    const firstLang = preferFr ? 'fr' : 'en';
    const fallbackLang = preferFr ? 'en' : 'fr';
    return forkJoin({
      wiki: this.fetchWikiSummary(firstTitle, firstLang, fallbackTitle, fallbackLang, lookup.search || lookup.sky),
      sky: this.api.searchStellariumSkySources(lookup.sky).pipe(catchError(() => of([] as StellariumSkySource[])))
    }).pipe(
      map(({ wiki, sky }) => {
        const hits = Array.isArray(sky) ? sky : sky ? [sky] : [];
        return this.buildObjectDossier(wiki, this.pickSkySource(hits, lookup.sky, sat.noradId), sat.noradId);
      }),
      catchError(() => of(null))
    );
  }

  private lookupForSatellite(sat: AstroSatelliteOption): WikiLookup {
    const mapped = SATELLITE_WIKI_LOOKUP['iss:' + sat.id];
    if (mapped) {
      return mapped;
    }
    const label = String(this.translate.instant(sat.labelKey) || sat.id);
    return { fr: label, en: label, sky: label, search: label + ' satellite' };
  }

  private fetchWikiSummary(
    firstTitle: string,
    firstLang: string,
    fallbackTitle: string,
    fallbackLang: string,
    searchQuery?: string
  ): Observable<WikipediaSummary | null> {
    const query = (searchQuery || firstTitle || fallbackTitle || '').trim();
    return this.api.getWikipediaSummary(firstTitle, firstLang).pipe(
      switchMap((wiki) => {
        if (this.wikiSummaryUsable(wiki)) {
          return of(wiki);
        }
        const sameRequest = firstTitle === fallbackTitle && firstLang === fallbackLang;
        if (sameRequest) {
          return this.searchWikiThenSummary(query, firstLang, fallbackLang);
        }
        return this.api.getWikipediaSummary(fallbackTitle, fallbackLang).pipe(
          switchMap((fallback) =>
            this.wikiSummaryUsable(fallback)
              ? of(fallback)
              : this.searchWikiThenSummary(query, firstLang, fallbackLang)
          ),
          catchError(() => this.searchWikiThenSummary(query, firstLang, fallbackLang))
        );
      }),
      catchError(() => {
        const sameRequest = firstTitle === fallbackTitle && firstLang === fallbackLang;
        if (sameRequest) {
          return this.searchWikiThenSummary(query, firstLang, fallbackLang);
        }
        return this.api.getWikipediaSummary(fallbackTitle, fallbackLang).pipe(
          switchMap((fallback) =>
            this.wikiSummaryUsable(fallback)
              ? of(fallback)
              : this.searchWikiThenSummary(query, firstLang, fallbackLang)
          ),
          catchError(() => this.searchWikiThenSummary(query, firstLang, fallbackLang))
        );
      })
    );
  }

  private searchWikiThenSummary(
    query: string,
    firstLang: string,
    fallbackLang: string
  ): Observable<WikipediaSummary | null> {
    if (!query) {
      return of(null);
    }
    return this.wikiSummaryFromSearch(query, firstLang).pipe(
      switchMap((wiki) => {
        if (this.wikiSummaryUsable(wiki) || firstLang === fallbackLang) {
          return of(this.wikiSummaryUsable(wiki) ? wiki : null);
        }
        return this.wikiSummaryFromSearch(query, fallbackLang);
      }),
      catchError(() =>
        firstLang === fallbackLang ? of(null) : this.wikiSummaryFromSearch(query, fallbackLang)
      )
    );
  }

  private wikiSummaryFromSearch(query: string, lang: string): Observable<WikipediaSummary | null> {
    return this.api.searchWikipedia(query, lang, 8).pipe(
      switchMap((res) => {
        const title = this.pickWikiSearchTitle(res?.pages, query);
        if (!title) {
          return of(null);
        }
        return this.api.getWikipediaSummary(title, lang).pipe(
          map((wiki) => (this.wikiSummaryUsable(wiki) ? wiki : null)),
          catchError(() => of(null))
        );
      }),
      catchError(() => of(null))
    );
  }

  private pickWikiSearchTitle(pages: WikipediaSearchPage[] | undefined, query: string): string | null {
    if (!pages?.length) {
      return null;
    }
    const astroHint =
      /galax|n[eé]buleuse|nebula|messier|cluster|amas|étoile|star\b|planète|planet|constellation|satellite|station spatiale|space station|télescope spatial|space telescope|observatoire|observatory|dwarf|naine|quasar|spirale|spiral/i;
    const disambig = /disambiguation|homonymie|topics referred/i;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const queryRe = escaped ? new RegExp(escaped, 'i') : null;
    let bestTitle: string | null = null;
    let bestScore = -1;
    for (const page of pages) {
      const title = (page.title || page.key || '').replace(/_/g, ' ').trim();
      if (!title) {
        continue;
      }
      const blob = `${title} ${page.description || ''} ${page.excerpt || ''}`;
      if (disambig.test(blob)) {
        continue;
      }
      let score = 1;
      if (astroHint.test(blob)) {
        score += 6;
      }
      if (queryRe && queryRe.test(title)) {
        score += 3;
      }
      if (score > bestScore) {
        bestScore = score;
        bestTitle = title;
      }
    }
    return bestTitle || pages[0]?.title || null;
  }

  private wikiSummaryUsable(wiki: WikipediaSummary | null | undefined): boolean {
    return !!(wiki && wiki.type !== 'disambiguation' && (wiki.extract || wiki.description || wiki.title));
  }

  private pickSkySource(
    results: StellariumSkySource[],
    query: string,
    noradId: number
  ): StellariumSkySource | undefined {
    if (!results.length) {
      return undefined;
    }
    const compact = query.replace(/\s+/g, '').toUpperCase();
    const namesOf = (source: StellariumSkySource): string[] => [
      ...(source.names || []),
      source.short_name || '',
      source.match || ''
    ];
    const matchesQuery = (source: StellariumSkySource): boolean =>
      namesOf(source).some(
        (n) =>
          n.replace(/\s+/g, '').toUpperCase() === compact ||
          n.replace(/^(NAME|NORAD|COSPAR)\s+/i, '').replace(/\s+/g, '').toUpperCase() === compact
      );
    const isSatellite = (source: StellariumSkySource): boolean =>
      source.model === 'tle_satellite' || (source.types || []).includes('Asa');
    const byNorad = results.find(
      (s) => isSatellite(s) && this.asFiniteNumber(s.model_data?.['norad_number']) === noradId
    );
    if (byNorad) {
      return byNorad;
    }
    const exactSat = results.find((s) => isSatellite(s) && matchesQuery(s));
    if (exactSat) {
      return exactSat;
    }
    return results.find(isSatellite) || results.find(matchesQuery) || results[0];
  }

  private buildObjectDossier(
    wiki: WikipediaSummary | null,
    sky: StellariumSkySource | undefined,
    noradId: number
  ): ObjectDossier | null {
    const wikiOk = wiki && wiki.type !== 'disambiguation';
    const extract = wikiOk ? wiki.extract?.trim() || null : null;
    const description = wikiOk ? wiki.description?.trim() || null : null;
    const thumbUrl = wiki?.thumbnail?.source || wiki?.originalimage?.source || null;
    const imageUrl = wiki?.originalimage?.source || wiki?.thumbnail?.source || null;
    const wikiUrl = wiki?.content_urls?.desktop?.page || wiki?.content_urls?.mobile?.page || null;
    const wikiTitle = wiki?.title || wiki?.displaytitle || null;
    const skyNames = this.dossierSkyNames(sky, noradId);
    const skyTypes = this.dossierSkyTypes(sky);
    const vMag = this.asFiniteNumber(sky?.model_data?.Vmag) ?? this.asFiniteNumber(sky?.model_data?.['mag']);
    const bMag = this.asFiniteNumber(sky?.model_data?.Bmag);
    if (!extract && !description && !thumbUrl && !skyNames.length && !skyTypes.length && vMag == null && bMag == null) {
      return null;
    }
    return { extract, description, thumbUrl, imageUrl, wikiUrl, wikiTitle, skyNames, skyTypes, vMag, bMag };
  }

  private dossierSkyNames(sky: StellariumSkySource | undefined, noradId: number): string[] {
    const names = (sky?.names || [])
      .map((n) => (n || '').replace(/^NAME\s+/i, '').trim())
      .filter((n) => !!n);
    if (noradId) {
      const label = 'NORAD ' + noradId;
      if (!names.some((n) => n.replace(/\s+/g, '').toUpperCase() === label.replace(/\s+/g, '').toUpperCase())) {
        names.unshift(label);
      }
    }
    return names.slice(0, 6);
  }

  private dossierSkyTypes(sky: StellariumSkySource | undefined): string[] {
    const types = (sky?.types || []).filter((n) => !!n && n !== 'Asa');
    const satLabel = this.translate.instant('ASTRO_COMPASS.KIND_SATELLITE');
    if (satLabel && !types.includes(satLabel)) {
      types.unshift(satLabel);
    }
    return types.slice(0, 4);
  }

  private asFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
}
