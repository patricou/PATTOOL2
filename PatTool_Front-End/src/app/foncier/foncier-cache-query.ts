import { FoncierCommune } from '../services/api.service';

export interface FoncierCacheRow {
  id?: string;
  city?: string;
  zipcode?: string;
  insee?: string;
  address?: string;
  type?: string;
  typeLocal?: string;
  price?: number;
  pricePerM2?: number;
  surface?: number;
  rooms?: number;
  date?: string;
  publishedAt?: string;
  lat?: number;
  lon?: number;
}

export type FoncierSortKey =
  | 'date-desc'
  | 'date-asc'
  | 'price-asc'
  | 'price-desc'
  | 'm2-asc'
  | 'm2-desc'
  | 'surface-desc'
  | 'surface-asc';

export const FONCIER_SORT_OPTIONS: FoncierSortKey[] = [
  'date-desc',
  'date-asc',
  'price-asc',
  'price-desc',
  'm2-asc',
  'm2-desc',
  'surface-desc',
  'surface-asc'
];

export function parseFoncierSort(raw: string | null): FoncierSortKey {
  return FONCIER_SORT_OPTIONS.includes(raw as FoncierSortKey)
    ? raw as FoncierSortKey
    : 'date-desc';
}

export function sortLabelKey(sort: FoncierSortKey): string {
  switch (sort) {
    case 'date-asc':
      return 'FONCIER.SORT_DATE_ASC';
    case 'price-asc':
      return 'FONCIER.SORT_PRICE_ASC';
    case 'price-desc':
      return 'FONCIER.SORT_PRICE_DESC';
    case 'm2-asc':
      return 'FONCIER.SORT_M2_ASC';
    case 'm2-desc':
      return 'FONCIER.SORT_M2_DESC';
    case 'surface-desc':
      return 'FONCIER.SORT_SURFACE_DESC';
    case 'surface-asc':
      return 'FONCIER.SORT_SURFACE_ASC';
    default:
      return 'FONCIER.SORT_DATE_DESC';
  }
}

export function sortCacheItems<T extends FoncierCacheRow>(items: T[], sort: FoncierSortKey): T[] {
  const dir = sort.endsWith('-asc') ? 1 : -1;
  const field = sort.startsWith('date')
    ? 'date'
    : sort.startsWith('price')
      ? 'price'
      : sort.startsWith('m2')
        ? 'm2'
        : 'surface';
  return [...items].sort((a, b) => {
    const av = sortValue(a, field);
    const bv = sortValue(b, field);
    if (av == null && bv == null) {
      return 0;
    }
    if (av == null) {
      return 1;
    }
    if (bv == null) {
      return -1;
    }
    if (av === bv) {
      return 0;
    }
    return av < bv ? -dir : dir;
  });
}

export interface FoncierCacheFilter {
  q?: string;
  codeInsee?: string;
  zip?: string;
  type?: string;
  priceMin?: number;
  priceMax?: number;
  surfaceMin?: number;
  surfaceMax?: number;
  radiusKm?: number;
  lat?: number;
  lon?: number;
}

/** Turns "765 Chemin…, 01630 Sergy" into zip + commune so cache filters can match. */
export function parseFoncierPlaceQuery(raw: string): { zip: string; city: string } {
  const s = (raw || '').trim();
  if (!s) {
    return { zip: '', city: '' };
  }
  if (/^\d{5}$/.test(s)) {
    return { zip: s, city: '' };
  }
  const zipMatch = s.match(/(\d{5})/);
  if (!zipMatch || zipMatch.index == null) {
    return { zip: '', city: s };
  }
  const zip = zipMatch[1];
  const after = s.slice(zipMatch.index + 5).replace(/^[\s,;./-]+/, '').trim();
  if (after) {
    return { zip, city: after.split(/[,;]/)[0].trim() };
  }
  const before = s.slice(0, zipMatch.index).replace(/[\s,;./-]+$/, '').trim();
  const parts = before.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : '';
  const city = last && !/^\d/.test(last) && last.length <= 40 ? last : '';
  return { zip, city };
}

export interface FoncierCachePage<T> {
  items: T[];
  count: number;
  hasNext: boolean;
  page: number;
}

export function placesFromCache(items: FoncierCacheRow[], query: string, limit = 12): FoncierCommune[] {
  const needle = (query || '').trim().toLowerCase();
  const unique = new Map<string, FoncierCommune>();
  for (const item of items) {
    const city = text(item.city);
    const zip = text(item.zipcode);
    const insee = padInsee(item.insee);
    if (!city && !zip && !insee) {
      continue;
    }
    if (needle
        && !city.toLowerCase().includes(needle)
        && !zip.includes(needle)
        && !insee.includes(needle)) {
      continue;
    }
    const key = insee || `${zip}|${city.toLowerCase()}`;
    if (unique.has(key)) {
      continue;
    }
    unique.set(key, {
      code: insee || zip,
      nom: city || zip,
      codesPostaux: zip ? [zip] : [],
      lat: finite(item.lat),
      lon: finite(item.lon)
    });
    if (unique.size >= limit) {
      break;
    }
  }
  return [...unique.values()];
}

export function filterCacheItems<T extends FoncierCacheRow>(items: T[], filter: FoncierCacheFilter): T[] {
  const parsed = parseFoncierPlaceQuery(filter.q || '');
  const zipQuery = (filter.zip || parsed.zip || '').trim();
  const cityQuery = parsed.city;
  const insee = padInsee(filter.codeInsee);
  let lat = finite(filter.lat);
  let lon = finite(filter.lon);
  const radiusKm = filter.radiusKm && filter.radiusKm > 0 ? filter.radiusKm : 0;

  if (radiusKm > 0 && lat == null) {
    const center = items.find((item) =>
      finite(item.lat) != null
      && finite(item.lon) != null
      && matchesPlace(item, insee, zipQuery, cityQuery, 0, undefined, undefined));
    if (center) {
      lat = center.lat;
      lon = center.lon;
    }
  }

  return items.filter((item) =>
    matchesPlace(item, insee, zipQuery, cityQuery, radiusKm, lat, lon)
    && matchesFilters(item, filter));
}

export function paginateCache<T>(items: T[], page: number, pageSize: number): FoncierCachePage<T> {
  const p = Math.max(1, page);
  const size = Math.max(1, pageSize);
  const from = (p - 1) * size;
  const to = Math.min(from + size, items.length);
  return {
    items: items.slice(from, to),
    count: items.length,
    hasNext: to < items.length,
    page: p
  };
}

function matchesPlace(
  item: FoncierCacheRow,
  insee: string,
  zip: string,
  city: string,
  radiusKm: number,
  lat: number | undefined,
  lon: number | undefined
): boolean {
  const itemInsee = padInsee(item.insee);
  const itemZip = text(item.zipcode);
  const itemCity = text(item.city);
  const itemLat = finite(item.lat);
  const itemLon = finite(item.lon);

  if (radiusKm > 0 && itemLat != null && itemLon != null && lat != null && lon != null) {
    return distanceKm(lat, lon, itemLat, itemLon) <= radiusKm + 0.3;
  }

  if (insee && itemInsee === insee) {
    return true;
  }
  if (zip && (itemZip === zip || itemZip.includes(zip) || itemInsee === zip)) {
    return true;
  }
  if (!city) {
    return !insee && !zip;
  }
  const needle = city.toLowerCase();
  return itemCity.toLowerCase().includes(needle)
    || text(item.address).toLowerCase().includes(needle);
}

function matchesFilters(item: FoncierCacheRow, filter: FoncierCacheFilter): boolean {
  if (filter.type) {
    const type = filter.type.trim().toLowerCase();
    const itemType = `${text(item.type)} ${text(item.typeLocal)}`.toLowerCase();
    if (!itemType.includes(type)
        && !(type === 'appartement' && itemType.includes('apartment'))
        && !(type === 'maison' && itemType.includes('house'))
        && !(type === 'terrain' && itemType.includes('land'))) {
      return false;
    }
  }
  if (filter.priceMin != null && item.price != null && item.price < filter.priceMin) {
    return false;
  }
  if (filter.priceMax != null && item.price != null && item.price > filter.priceMax) {
    return false;
  }
  if (filter.surfaceMin != null && item.surface != null && item.surface < filter.surfaceMin) {
    return false;
  }
  if (filter.surfaceMax != null && item.surface != null && item.surface > filter.surfaceMax) {
    return false;
  }
  return true;
}

function sortValue(item: FoncierCacheRow, field: 'date' | 'price' | 'm2' | 'surface'): number | null {
  if (field === 'date') {
    const raw = item.publishedAt || item.date;
    if (!raw) {
      return null;
    }
    const time = Date.parse(raw);
    return Number.isFinite(time) ? time : null;
  }
  if (field === 'price') {
    return Number.isFinite(item.price) ? item.price as number : null;
  }
  if (field === 'm2') {
    if (Number.isFinite(item.pricePerM2)) {
      return item.pricePerM2 as number;
    }
    if (Number.isFinite(item.price) && Number.isFinite(item.surface) && (item.surface as number) > 0) {
      return (item.price as number) / (item.surface as number);
    }
    return null;
  }
  return Number.isFinite(item.surface) ? item.surface as number : null;
}

function text(value: string | undefined): string {
  return (value || '').trim();
}

function padInsee(raw: string | undefined): string {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) {
    return (raw || '').trim();
  }
  return digits.length >= 5 ? digits.slice(0, 5) : digits.padStart(5, '0');
}

function finite(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
