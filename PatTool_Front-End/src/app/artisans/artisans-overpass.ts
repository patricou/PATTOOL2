import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { ArtisansNearbyItem, ArtisansNearbyResponse } from '../services/api.service';
import { OSM_ACTIVITY_LABELS, OSM_TRADE_KEYS, tradeKeyFromCode } from './artisans-trades';
import { normalizeWikidataId, osmWebsiteFromTags } from './artisans-website';

const OVERPASS_URLS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass-api.de/api/interpreter'
];

const OSM_FILTERS: Record<string, string> = {
  all: 'node["shop"];node["craft"];node["office"~"^(estate_agent|lawyer|accountant|insurance)$"];node["amenity"~"^(restaurant|cafe|fast_food|bar|pub|pharmacy|fuel|dentist|doctors|clinic|veterinary|bank|post_office)$"];node["shop"="wholesale"];node["tourism"="hotel"]',
  plumber: 'node["craft"~"^(plumber|heating_engineer)$"]',
  electrician: 'node["craft"="electrician"]',
  heating: 'node["craft"~"^(hvac|heating_engineer)$"]',
  painter: 'node["craft"="painter"]',
  carpenter: 'node["craft"~"^(carpenter|joiner)$"]',
  mason: 'node["craft"="mason"]',
  roofer: 'node["craft"="roofer"]',
  locksmith: 'node["craft"="locksmith"];node["shop"="locksmith"]',
  tiler: 'node["craft"="tiler"];node["shop"="tile"]',
  glazier: 'node["craft"="glazier"]',
  gardener: 'node["craft"="gardener"];node["shop"="garden_centre"]',
  cleaner: 'node["craft"="cleaner"];node["shop"="dry_cleaning"]',
  hairdresser: 'node["shop"="hairdresser"]',
  baker: 'node["shop"="bakery"]',
  butcher: 'node["shop"="butcher"]',
  mechanic: 'node["shop"="car_repair"]',
  appliance: 'node["shop"="appliance"];node["craft"="electronics_repair"]',
  supermarket: 'node["shop"~"^(supermarket|hypermarket)$"]',
  grocery: 'node["shop"~"^(convenience|greengrocer|grocery)$"]',
  shop: 'node["shop"~"^(general|kiosk|variety_store|department_store|mall|gift)$"]',
  hardware: 'node["shop"~"^(doityourself|hardware)$"]',
  clothing: 'node["shop"="clothes"]',
  furniture: 'node["shop"="furniture"]',
  florist: 'node["shop"="florist"]',
  pharmacy: 'node["amenity"="pharmacy"];node["shop"="chemist"]',
  optician: 'node["shop"="optician"]',
  restaurant: 'node["amenity"="restaurant"]',
  cafe: 'node["amenity"="cafe"]',
  hotel: 'node["tourism"="hotel"]',
  fuel: 'node["amenity"="fuel"]',
  beauty: 'node["shop"="beauty"]',
  dentist: 'node["amenity"="dentist"]',
  doctor: 'node["amenity"~"^(doctors|clinic)$"]',
  veterinary: 'node["amenity"="veterinary"]',
  realestate: 'node["office"="estate_agent"]',
  laundry: 'node["shop"~"^(laundry|dry_cleaning)$"]',
  bank: 'node["amenity"="bank"]',
  insurance: 'node["office"="insurance"]',
  wholesale: 'node["shop"="wholesale"]',
  post: 'node["amenity"="post_office"]',
  shoes: 'node["shop"="shoes"]',
  electronics: 'node["shop"~"^(electronics|computer)$"]',
  books: 'node["shop"~"^(books|newsagent)$"]',
  sports: 'node["shop"="sports"]',
  jewelry: 'node["shop"="jewelry"]',
  bar: 'node["amenity"~"^(bar|pub)$"]',
  fastfood: 'node["amenity"="fast_food"]'
};

interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

export function searchOsmOverpass(
  http: HttpClient,
  lat: number,
  lon: number,
  radiusKm: number,
  trade: string,
  page = 1,
  perPage = 100
): Observable<ArtisansNearbyResponse> {
  const query = buildOverpassQuery(lat, lon, radiusKm, trade);
  return fetchFirst(http, query, 0).pipe(
    map((raw) => mapOverpass(raw, lat, lon, radiusKm, trade, page, perPage))
  );
}

function fetchFirst(http: HttpClient, query: string, index: number): Observable<OverpassResponse> {
  const url = OVERPASS_URLS[index];
  if (!url) {
    return of({ elements: [] });
  }
  const params = new HttpParams().set('data', query);
  return http.get<OverpassResponse>(url, { params }).pipe(
    catchError(() => fetchFirst(http, query, index + 1))
  );
}

function buildOverpassQuery(lat: number, lon: number, radiusKm: number, trade: string): string {
  const around = Math.round(Math.max(0.5, Math.min(50, radiusKm)) * 1000);
  const filters = OSM_FILTERS[trade] || OSM_FILTERS['all'];
  const union = filters.split(';').map((part) => {
    const expr = part.trim();
    return expr
      ? `  ${expr}(around:${around},${lat.toFixed(5)},${lon.toFixed(5)});`
      : '';
  }).filter(Boolean).join('\n');
  return `[out:json][timeout:20];\n(\n${union}\n);\nout tags center 100;\n`;
}

function mapOverpass(
  raw: OverpassResponse,
  lat: number,
  lon: number,
  radiusKm: number,
  trade: string,
  page: number,
  perPage: number
): ArtisansNearbyResponse {
  const items: ArtisansNearbyItem[] = [];
  for (const el of raw?.elements || []) {
    const item = mapElement(el, lat, lon);
    if (item) {
      items.push(item);
    }
    if (items.length >= 100) {
      break;
    }
  }
  items.sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));
  const from = Math.min((page - 1) * perPage, items.length);
  const to = Math.min(from + perPage, items.length);
  return {
    source: 'osm',
    lat,
    lon,
    radiusKm,
    trade,
    total: items.length,
    page,
    perPage,
    items: items.slice(from, to)
  };
}

function mapElement(el: OverpassElement, originLat: number, originLon: number): ArtisansNearbyItem | null {
  const elat = el.lat ?? el.center?.lat;
  const elon = el.lon ?? el.center?.lon;
  if (elat == null || elon == null || !Number.isFinite(elat) || !Number.isFinite(elon)) {
    return null;
  }
  const tags = el.tags || {};
  const name = [tags['name'], tags['name:fr'], tags['operator'], tags['brand']]
    .find((value) => !!(value && value.trim()));
  if (!name) {
    return null;
  }
  const osmTag = [tags['craft'], tags['shop'], tags['amenity'], tags['tourism'], tags['office']]
    .find((value) => !!(value && value.trim())) || '';
  const tradeKey = OSM_TRADE_KEYS[osmTag] || tradeKeyFromCode(osmTag) || (tags['shop'] ? 'shop' : '');
  const website = osmWebsiteFromTags(tags);
  const type = el.type || 'node';
  const id = el.id || 0;
  const brand = (tags['brand'] || '').trim();
  const wikidata = normalizeWikidataId(tags['wikidata']);
  const brandWikidata = normalizeWikidataId(tags['brand:wikidata']);
  return {
    id: `${type}/${id}`,
    name,
    activity: OSM_ACTIVITY_LABELS[osmTag] || osmTag.replace(/_/g, ' '),
    activityCode: osmTag,
    tradeKey: tradeKey || undefined,
    address: [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ').trim()
      || tags['addr:full'] || '',
    city: tags['addr:city'] || tags['addr:municipality'] || '',
    postalCode: tags['addr:postcode'] || '',
    lat: elat,
    lon: elon,
    distanceKm: Math.round(haversineKm(originLat, originLon, elat, elon) * 10) / 10,
    url: id > 0 ? `https://www.openstreetmap.org/${type}/${id}` : undefined,
    website: website || undefined,
    brand: brand || undefined,
    wikidata: wikidata || undefined,
    brandWikidata: brandWikidata || undefined,
    phone: tags['phone'] || tags['contact:phone'] || undefined
  };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
