import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, forkJoin, from, of } from 'rxjs';
import { catchError, map, mergeMap, switchMap, toArray } from 'rxjs/operators';

import { environment } from '../../environments/environment';
import { ArtisansNearbyItem } from '../services/api.service';

const OSM_WEBSITE_KEYS = [
  'website',
  'website:fr',
  'contact:website',
  'contact:url',
  'brand:website',
  'operator:website',
  'mobile:website',
  'url',
  'website:en'
];

const JUNK_HOST_MARKERS = [
  'facebook.com',
  'fb.com',
  'fb.me',
  'instagram.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'linkedin.com',
  'youtube.com',
  'youtu.be',
  'pagesjaunes.fr',
  'pagesjaunes.ch',
  'pagesdor.be',
  'local.ch',
  'search.ch',
  'tripadvisor.',
  'thefork.',
  'lafourchette.',
  'booking.com',
  'yelp.',
  'maps.google.',
  'google.com',
  'google.fr',
  'google.ch',
  'googleusercontent.com',
  'g.page',
  'business.site',
  'societe.com',
  'pappers.fr',
  'infogreffe.fr',
  'annuaire-entreprises.data.gouv.fr',
  'wikipedia.org',
  'wikidata.org',
  'openstreetmap.org',
  'foursquare.com',
  'laposte.fr',
  '118000.fr',
  '118218.fr',
  '118712.fr',
  'horaires-commerces.fr',
  'horaires.com',
  'justacote.com',
  'cylex.fr',
  'cylex.com',
  'kompass.com',
  'verif.com',
  'manageo.fr',
  'score3.fr',
  'entreprises.lefigaro.fr',
  'mappy.com',
  'viamichelin.',
  'uneboulangerie.fr',
  'petitfute.com',
  'timeout.com',
  'le-codepostal.com'
];

const GENERIC_NAME_TOKENS = new Set([
  'sarl', 'sas', 'sasu', 'eurl', 'sa', 'sci', 'snc', 'sarlu', 'gmbh', 'sprl',
  'le', 'la', 'les', 'de', 'du', 'des', 'et', 'the', 'and', 'a',
  'shop', 'store', 'magasin', 'commerce', 'cafe', 'bar', 'pub', 'hotel',
  'restaurant', 'boulangerie', 'patisserie', 'pharmacie', 'epicerie',
  'supermarche', 'garage', 'coiffure', 'coiffeur', 'fleuriste', 'tabac',
  'presse', 'pizzeria', 'brasserie'
]);

export interface NearbyOfficialSite {
  qid: string;
  label: string;
  website: string;
  lat?: number;
  lon?: number;
}

export function normalizeWebsite(raw?: string | null): string {
  const value = (raw || '').trim();
  if (!value || /^javascript:/i.test(value)) {
    return '';
  }
  let href = value;
  if (href.startsWith('//') && href.includes('.')) {
    href = `https:${href}`;
  } else if (!/^https?:\/\//i.test(href)) {
    if (!href.includes('.') || href.includes(' ')) {
      return '';
    }
    href = `https://${href}`;
  }
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '';
    }
    if (!url.hostname || isJunkWebsiteHost(url.hostname)) {
      return '';
    }
    return href;
  } catch {
    return '';
  }
}

export function isJunkWebsiteHost(hostname: string): boolean {
  const host = hostname.replace(/^www\./i, '').toLowerCase();
  return JUNK_HOST_MARKERS.some((marker) => {
    if (marker.endsWith('.')) {
      return host === marker.slice(0, -1) || host.startsWith(marker) || host.includes(`.${marker}`);
    }
    return host === marker || host.endsWith(`.${marker}`);
  });
}

export function pickOfficialWebsite(candidates: Array<string | undefined | null>): string {
  for (const candidate of candidates) {
    const href = normalizeWebsite(candidate);
    if (href) {
      return href;
    }
  }
  return '';
}

export function osmWebsiteFromTags(tags: Record<string, string>): string {
  return pickOfficialWebsite(OSM_WEBSITE_KEYS.map((key) => tags[key]));
}

export function normalizeWikidataId(raw?: string | null): string {
  const match = String(raw || '').trim().match(/Q\d+/i);
  return match ? match[0].toUpperCase() : '';
}

export function applyNearbyOfficialSites(
  items: ArtisansNearbyItem[],
  nearby: NearbyOfficialSite[]
): void {
  if (!items.length || !nearby.length) {
    return;
  }
  for (const item of items) {
    if (normalizeWebsite(item.website)) {
      continue;
    }
    let best: NearbyOfficialSite | null = null;
    let bestScore = 0;
    for (const row of nearby) {
      const score = nameScore(item.name || '', row.label);
      if (score < 0.58) {
        continue;
      }
      if (item.lat != null && item.lon != null && row.lat != null && row.lon != null) {
        if (haversineKm(item.lat, item.lon, row.lat, row.lon) > 2.5) {
          continue;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
    if (best) {
      item.website = best.website;
      if (!item.wikidata) {
        item.wikidata = best.qid;
      }
    }
  }
}

export function fetchNearbyOfficialSites(
  http: HttpClient,
  lat: number,
  lon: number,
  radiusKm: number
): Observable<NearbyOfficialSite[]> {
  const radius = Math.max(1, Math.min(20, radiusKm));
  const query = `
SELECT ?item ?website ?itemLabel ?lat ?lon WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?loc .
    bd:serviceParam wikibase:center "Point(${lon.toFixed(5)} ${lat.toFixed(5)})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radius}" .
  }
  ?item wdt:P856 ?website .
  OPTIONAL {
    ?item p:P625/psv:P625 ?coord .
    ?coord wikibase:geoLatitude ?lat .
    ?coord wikibase:geoLongitude ?lon .
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en,de,it". }
}
LIMIT 160`.trim();
  const params = new HttpParams().set('query', query).set('format', 'json');
  return http.get<SparqlResponse>('https://query.wikidata.org/sparql', { params }).pipe(
    map((raw) => {
      const rows: NearbyOfficialSite[] = [];
      for (const binding of raw?.results?.bindings || []) {
        const qid = normalizeWikidataId(String(binding['item']?.['value'] || ''));
        const website = normalizeWebsite(String(binding['website']?.['value'] || ''));
        const label = String(binding['itemLabel']?.['value'] || '').trim();
        if (!qid || !website || !label) {
          continue;
        }
        const rowLat = Number(binding['lat']?.['value']);
        const rowLon = Number(binding['lon']?.['value']);
        rows.push({
          qid,
          label,
          website,
          lat: Number.isFinite(rowLat) ? rowLat : undefined,
          lon: Number.isFinite(rowLon) ? rowLon : undefined
        });
      }
      return rows;
    }),
    catchError(() => of([]))
  );
}

export function resolveOfficialWebsite(
  http: HttpClient,
  item: ArtisansNearbyItem,
  allowWebSearch = true
): Observable<string> {
  const known = normalizeWebsite(item.website);
  if (known) {
    return of(known);
  }
  const ids = [item.wikidata, item.brandWikidata]
    .map((value) => normalizeWikidataId(value))
    .filter(Boolean);
  if (ids.length) {
    return websitesForEntities(http, ids).pipe(
      map((found) => found[0] || ''),
      switchIfEmpty(() => searchThenResolve(http, item, allowWebSearch))
    );
  }
  return searchThenResolve(http, item, allowWebSearch);
}

export function resolveOfficialWebsites(
  http: HttpClient,
  items: ArtisansNearbyItem[],
  webSearchLimit = 24
): Observable<ArtisansNearbyItem[]> {
  const missing = items.filter((item) => !normalizeWebsite(item.website));
  if (!missing.length) {
    return of(items);
  }
  return from(missing).pipe(
    mergeMap((item, index) => resolveOfficialWebsite(http, item, index < webSearchLimit).pipe(
      map((url) => {
        if (url) {
          item.website = url;
        }
        return item;
      })
    ), 3),
    toArray(),
    map(() => items)
  );
}

function searchThenResolve(
  http: HttpClient,
  item: ArtisansNearbyItem,
  allowWebSearch: boolean
): Observable<string> {
  const queries = uniqueNonEmpty([
    [item.name, item.city].filter(Boolean).join(' '),
    item.brand && item.brand !== item.name ? item.brand : '',
    distinctiveQuery(item.name || '')
  ]);
  const afterKnowledge = (source: Observable<string>) => source.pipe(
    switchIfEmpty(() => allowWebSearch ? lookupViaWebSearch(http, item) : of(''))
  );
  if (!queries.length) {
    return afterKnowledge(suggestCompanyDomain(http, item));
  }
  return searchWikidataIds(http, queries).pipe(
    switchMap((ids) => {
      if (!ids.length) {
        return afterKnowledge(suggestCompanyDomain(http, item));
      }
      return websitesForEntities(http, ids).pipe(
        map((urls) => pickBestWebsite(item, urls)),
        switchIfEmpty(() => afterKnowledge(suggestCompanyDomain(http, item)))
      );
    })
  );
}

function lookupViaWebSearch(http: HttpClient, item: ArtisansNearbyItem): Observable<string> {
  const name = (item.name || '').trim();
  if (!name) {
    return of('');
  }
  let params = new HttpParams().set('name', name);
  if (item.city) {
    params = params.set('city', item.city);
  }
  if (item.postalCode) {
    params = params.set('postalCode', item.postalCode);
  }
  if (item.activity) {
    params = params.set('activity', item.activity);
  }
  return http.get<{ website?: string }>(environment.API_URL + 'external/artisans/website', { params }).pipe(
    map((raw) => normalizeWebsite(raw?.website)),
    catchError(() => of(''))
  );
}

function websitesForEntities(http: HttpClient, ids: string[]): Observable<string[]> {
  const unique = [...new Set(ids.map((id) => normalizeWikidataId(id)).filter(Boolean))].slice(0, 8);
  if (!unique.length) {
    return of([]);
  }
  const params = new HttpParams()
    .set('action', 'wbgetentities')
    .set('ids', unique.join('|'))
    .set('props', 'claims|labels|descriptions')
    .set('languages', 'fr|en')
    .set('format', 'json')
    .set('origin', '*');
  return http.get<WdEntities>('https://www.wikidata.org/w/api.php', { params }).pipe(
    map((raw) => {
      const urls: string[] = [];
      for (const id of unique) {
        const entity = raw?.entities?.[id];
        if (!entity || isRejectedEntity(entity)) {
          continue;
        }
        const href = normalizeWebsite(claimString(entity, 'P856'));
        if (href) {
          urls.push(href);
        }
      }
      return urls;
    }),
    catchError(() => of([]))
  );
}

function searchWikidataIds(http: HttpClient, queries: string[]): Observable<string[]> {
  return forkJoin(queries.slice(0, 3).map((query) => {
    const params = new HttpParams()
      .set('action', 'wbsearchentities')
      .set('search', query)
      .set('language', 'fr')
      .set('uselang', 'fr')
      .set('type', 'item')
      .set('limit', '5')
      .set('format', 'json')
      .set('origin', '*');
    return http.get<WdSearch>('https://www.wikidata.org/w/api.php', { params }).pipe(
      map((raw) => (raw?.search || [])
        .map((hit) => normalizeWikidataId(hit['id']))
        .filter(Boolean)),
      catchError(() => of([] as string[]))
    );
  })).pipe(map((groups) => [...new Set(groups.flat())].slice(0, 8)));
}

function suggestCompanyDomain(http: HttpClient, item: ArtisansNearbyItem): Observable<string> {
  const query = distinctiveQuery(item.brand || item.name || '');
  if (!query) {
    return of('');
  }
  const params = new HttpParams().set('query', query);
  return http.get<ClearbitHit[]>('https://autocomplete.clearbit.com/v1/companies/suggest', { params }).pipe(
    map((hits) => {
      for (const hit of hits || []) {
        const name = String(hit['name'] || '');
        const domain = String(hit['domain'] || '');
        if (!domain || isJunkWebsiteHost(domain)) {
          continue;
        }
        if (nameScore(item.brand || item.name || '', name) < 0.62
          && !domainLooksLikeName(domain, item.brand || item.name || '')) {
          continue;
        }
        return normalizeWebsite(domain);
      }
      return '';
    }),
    catchError(() => of(''))
  );
}

function pickBestWebsite(item: ArtisansNearbyItem, urls: string[]): string {
  return urls.find((url) => !!normalizeWebsite(url)) || '';
}

function isRejectedEntity(entity: WdEntity): boolean {
  const description = [
    entity['descriptions']?.['fr']?.['value'],
    entity['descriptions']?.['en']?.['value']
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(human|personne|commune de|city of|village|river|film|album|single|taxon)\b/i.test(description);
}

function claimString(entity: WdEntity, prop: string): string {
  const claims = entity['claims']?.[prop];
  if (!Array.isArray(claims)) {
    return '';
  }
  for (const claim of claims) {
    const value = claim?.['mainsnak']?.['datavalue']?.['value'];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function distinctiveQuery(name: string): string {
  const tokens = nameTokens(name).filter((token) => !GENERIC_NAME_TOKENS.has(token) && token.length >= 4);
  return tokens.join(' ').trim();
}

function nameScore(left: string, right: string): number {
  const a = fold(left);
  const b = fold(right);
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  if (a.includes(b) || b.includes(a)) {
    return 0.86;
  }
  const ta = new Set(nameTokens(left));
  const tb = new Set(nameTokens(right));
  if (!ta.size || !tb.size) {
    return 0;
  }
  let inter = 0;
  for (const token of ta) {
    if (tb.has(token)) {
      inter += 1;
    }
  }
  return inter / new Set([...ta, ...tb]).size;
}

function nameTokens(value: string): string[] {
  return fold(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, ' ')
    .trim();
}

function domainLooksLikeName(domain: string, name: string): boolean {
  const host = domain.replace(/^www\./i, '').split('.')[0] || '';
  const compactHost = fold(host).replace(/[^a-z0-9]/g, '');
  const tokens = nameTokens(name).filter((token) => !GENERIC_NAME_TOKENS.has(token) && token.length >= 4);
  return tokens.some((token) => compactHost.includes(token) || token.includes(compactHost));
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) {
      continue;
    }
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  return out;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function switchIfEmpty<T>(fallback: () => Observable<T>) {
  return (source: Observable<T>) => source.pipe(
    switchMap((value) => {
      if (Array.isArray(value) ? value.length === 0 : !value) {
        return fallback();
      }
      return of(value);
    })
  );
}

interface SparqlResponse {
  results?: {
    bindings?: Array<Record<string, { value?: string }>>;
  };
}

interface WdSearch {
  search?: Array<Record<string, string>>;
}

interface WdEntity {
  claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>;
  descriptions?: Record<string, { value?: string }>;
}

interface WdEntities {
  entities?: Record<string, WdEntity>;
}

interface ClearbitHit {
  name?: string;
  domain?: string;
}
