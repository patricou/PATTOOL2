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
  surface?: number;
  lat?: number;
  lon?: number;
}

export interface FoncierCacheFilter {
  q?: string;
  codeInsee?: string;
  type?: string;
  priceMin?: number;
  priceMax?: number;
  surfaceMin?: number;
  surfaceMax?: number;
  radiusKm?: number;
  lat?: number;
  lon?: number;
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
  const q = (filter.q || '').trim();
  const zipQuery = /^\d{5}$/.test(q) ? q : '';
  const cityQuery = zipQuery ? '' : q;
  const insee = padInsee(filter.codeInsee);
  let lat = finite(filter.lat);
  let lon = finite(filter.lon);
  const radiusKm = filter.radiusKm && filter.radiusKm > 0 ? filter.radiusKm : 0;

  if (radiusKm > 0 && lat == null) {
    const center = items.find((item) =>
      finite(item.lat) != null
      && finite(item.lon) != null
      && matchesPlace(item, insee, zipQuery, cityQuery, 0, null, null));
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
