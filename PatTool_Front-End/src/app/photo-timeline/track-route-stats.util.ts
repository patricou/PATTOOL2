/**
 * Parse GPX/KML/TCX/GeoJSON text and compute route length (haversine) and cumulative positive elevation (D+).
 * Used by the photo wall track table; logic aligned with trace-viewer point extraction (no waypoints in GPX distance).
 */

export interface ParsedTrackPoint {
    lat: number;
    lon: number;
    /** Meters above reference (GPX ele, KML altitude, etc.) */
    eleM?: number | null;
}

export interface TrackRouteStats {
    distanceKm: number | null;
    /** Cumulative positive vertical meters; null if insufficient elevation data */
    elevationGainM: number | null;
    pointCount: number;
    /** First valid timestamp found in the file (GPX time, TCX Time, KML when, …), ISO 8601. */
    fileDateIso: string | null;
}

/** Max consecutive points without raw `ele` that we bridge by linear interpolation. */
const ELEV_INTERPOLATE_MAX_GAP = 80;
/** Positive delta (m) counted on smoothed profile; small floor to trim residual noise. */
const ELEV_POSITIVE_DELTA_MIN_M = 2.5;

function normalizeFileDateIso(raw: string | null | undefined): string | null {
    const t = (raw || '').trim();
    if (!t) {
        return null;
    }
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) {
        return null;
    }
    return d.toISOString();
}

function readGpxTimeFromNode(node: Element): string | null {
    for (let i = 0; i < node.children.length; i++) {
        const ch = node.children[i];
        if (ch.localName.toLowerCase() === 'time') {
            const v = (ch.textContent || '').trim();
            return v || null;
        }
    }
    return null;
}

/** GPX: first point time, else metadata time. */
function parseGpxFileTime(xml: Document): string | null {
    const trkpts = xml.getElementsByTagName('trkpt');
    for (let i = 0; i < trkpts.length; i++) {
        const raw = readGpxTimeFromNode(trkpts.item(i)!);
        const iso = normalizeFileDateIso(raw);
        if (iso) {
            return iso;
        }
    }
    const rtepts = xml.getElementsByTagName('rtept');
    for (let i = 0; i < rtepts.length; i++) {
        const raw = readGpxTimeFromNode(rtepts.item(i)!);
        const iso = normalizeFileDateIso(raw);
        if (iso) {
            return iso;
        }
    }
    const times = xml.getElementsByTagName('time');
    for (let i = 0; i < times.length; i++) {
        const el = times.item(i)!;
        const parent = el.parentElement;
        if (parent && parent.localName.toLowerCase() === 'metadata') {
            const iso = normalizeFileDateIso(el.textContent);
            if (iso) {
                return iso;
            }
        }
    }
    return null;
}

function parseKmlFileTime(xml: Document): string | null {
    const whens = xml.getElementsByTagName('when');
    for (let i = 0; i < whens.length; i++) {
        const iso = normalizeFileDateIso(whens.item(i)!.textContent);
        if (iso) {
            return iso;
        }
    }
    const begins = xml.getElementsByTagName('begin');
    for (let i = 0; i < begins.length; i++) {
        const el = begins.item(i)!;
        const p = el.parentElement;
        if (p && p.localName.toLowerCase() === 'timespan') {
            const iso = normalizeFileDateIso(el.textContent);
            if (iso) {
                return iso;
            }
        }
    }
    return null;
}

function parseTcxFileTime(xml: Document): string | null {
    const tryTrackpoints = (col: HTMLCollectionOf<Element>) => {
        const n = Math.min(col.length, 20);
        for (let i = 0; i < n; i++) {
            const tp = col.item(i)!;
            for (let j = 0; j < tp.children.length; j++) {
                const ch = tp.children[j];
                if (ch.localName === 'Time') {
                    const iso = normalizeFileDateIso(ch.textContent);
                    if (iso) {
                        return iso;
                    }
                }
            }
        }
        return null;
    };
    let iso = tryTrackpoints(xml.getElementsByTagName('Trackpoint'));
    if (iso) {
        return iso;
    }
    iso = tryTrackpoints(xml.getElementsByTagName('trackpoint'));
    if (iso) {
        return iso;
    }
    const laps = xml.getElementsByTagName('Lap');
    for (let i = 0; i < laps.length; i++) {
        const lap = laps.item(i)!;
        for (let j = 0; j < lap.children.length; j++) {
            const ch = lap.children[j];
            if (ch.localName === 'StartTime') {
                const t = normalizeFileDateIso(ch.textContent);
                if (t) {
                    return t;
                }
            }
        }
    }
    return null;
}

function extractGeoJsonFileTime(geo: any): string | null {
    if (!geo || typeof geo !== 'object') {
        return null;
    }
    const tryProps = (props: any): string | null => {
        if (!props || typeof props !== 'object') {
            return null;
        }
        const keys = ['time', 'Time', 'date', 'Date', 'start_time', 'started_at', 'timestamp', 'begin'];
        for (const k of keys) {
            const v = props[k];
            if (typeof v === 'string' && v.trim()) {
                const iso = normalizeFileDateIso(v.trim());
                if (iso) {
                    return iso;
                }
            }
        }
        return null;
    };
    if (geo.type === 'Feature' && geo.properties) {
        const t = tryProps(geo.properties);
        if (t) {
            return t;
        }
    }
    if (geo.type === 'FeatureCollection' && Array.isArray(geo.features)) {
        for (const f of geo.features) {
            const t = tryProps(f?.properties);
            if (t) {
                return t;
            }
        }
    }
    return null;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function readGpxEleM(node: Element): number | null {
    for (let i = 0; i < node.children.length; i++) {
        const ch = node.children[i];
        if (ch.localName.toLowerCase() === 'ele') {
            const v = parseFloat((ch.textContent || '').trim());
            return Number.isFinite(v) ? v : null;
        }
    }
    return null;
}

function gpxLatLonFromNode(node: Element): { lat: number; lon: number } | null {
    const lat = parseFloat(node.getAttribute('lat') || '');
    const lon = parseFloat(node.getAttribute('lon') || '');
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return { lat, lon };
    }
    return null;
}

function parseGpxTrackPoints(xml: Document): ParsedTrackPoint[] {
    const out: ParsedTrackPoint[] = [];
    const trkpts = xml.getElementsByTagName('trkpt');
    for (let i = 0; i < trkpts.length; i++) {
        const node = trkpts.item(i)!;
        const ll = gpxLatLonFromNode(node);
        if (!ll) continue;
        out.push({ lat: ll.lat, lon: ll.lon, eleM: readGpxEleM(node) });
    }
    if (out.length > 0) {
        return out;
    }
    const rtepts = xml.getElementsByTagName('rtept');
    for (let i = 0; i < rtepts.length; i++) {
        const node = rtepts.item(i)!;
        const ll = gpxLatLonFromNode(node);
        if (!ll) continue;
        out.push({ lat: ll.lat, lon: ll.lon, eleM: readGpxEleM(node) });
    }
    return out;
}

function parseKmlTrackPoints(xml: Document): ParsedTrackPoint[] {
    const out: ParsedTrackPoint[] = [];
    const coordNodes = xml.getElementsByTagName('coordinates');
    for (let i = 0; i < coordNodes.length; i++) {
        const text = (coordNodes.item(i)!.textContent || '').trim();
        const tuples = text.split(/\s+/);
        for (const part of tuples) {
            const bits = part.split(',').map(s => parseFloat(s.trim()));
            const lon = bits[0];
            const lat = bits[1];
            const alt = bits.length >= 3 ? bits[2] : NaN;
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                out.push({
                    lat,
                    lon,
                    eleM: Number.isFinite(alt) ? alt : null
                });
            }
        }
    }
    return out;
}

function parseTcxTrackPoints(xml: Document): ParsedTrackPoint[] {
    const out: ParsedTrackPoint[] = [];
    const tps = xml.getElementsByTagName('Trackpoint');
    const tpsLower = xml.getElementsByTagName('trackpoint');
    const collect = (col: HTMLCollectionOf<Element>) => {
        for (let i = 0; i < col.length; i++) {
            const node = col.item(i)!;
            let lat: number | undefined;
            let lon: number | undefined;
            let ele: number | null = null;
            for (let j = 0; j < node.children.length; j++) {
                const ch = node.children[j];
                const ln = ch.localName;
                if (ln === 'Position') {
                    for (let k = 0; k < ch.children.length; k++) {
                        const c2 = ch.children[k];
                        if (c2.localName === 'LatitudeDegrees') {
                            lat = parseFloat((c2.textContent || '').trim());
                        } else if (c2.localName === 'LongitudeDegrees') {
                            lon = parseFloat((c2.textContent || '').trim());
                        }
                    }
                } else if (ln === 'AltitudeMeters') {
                    const v = parseFloat((ch.textContent || '').trim());
                    ele = Number.isFinite(v) ? v : null;
                }
            }
            if (Number.isFinite(lat!) && Number.isFinite(lon!)) {
                out.push({ lat: lat!, lon: lon!, eleM: ele });
            }
        }
    };
    collect(tps);
    if (out.length === 0) {
        collect(tpsLower);
    }
    return out;
}

function parseGeoJsonPoints(text: string): ParsedTrackPoint[] {
    const out: ParsedTrackPoint[] = [];
    let geo: any;
    try {
        geo = JSON.parse(text);
    } catch {
        return out;
    }
    const pushCoord = (coord: number[]) => {
        if (!Array.isArray(coord) || coord.length < 2) return;
        const lon = coord[0];
        const lat = coord[1];
        const z = coord.length >= 3 ? coord[2] : NaN;
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
            out.push({
                lat,
                lon,
                eleM: Number.isFinite(z) ? z : null
            });
        }
    };
    const walkGeom = (geometry: any): void => {
        if (!geometry) return;
        switch (geometry.type) {
            case 'FeatureCollection':
                geometry.features?.forEach((f: any) => walkGeom(f?.geometry));
                break;
            case 'Feature':
                walkGeom(geometry.geometry);
                break;
            case 'LineString':
                geometry.coordinates?.forEach(pushCoord);
                break;
            case 'MultiLineString':
                geometry.coordinates?.forEach((line: number[][]) =>
                    line?.forEach(pushCoord)
                );
                break;
            case 'Polygon':
                geometry.coordinates?.forEach((ring: number[][]) => ring?.forEach(pushCoord));
                break;
            case 'MultiPolygon':
                geometry.coordinates?.forEach((poly: number[][][]) =>
                    poly?.forEach((ring: number[][]) => ring?.forEach(pushCoord))
                );
                break;
            default:
                break;
        }
    };
    walkGeom(geo);
    return out;
}

function extensionOf(fileName: string): string {
    const m = (fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
}

function parseTrackPointsAndDate(fileName: string, text: string): { points: ParsedTrackPoint[]; fileDateIso: string | null } {
    const ext = extensionOf(fileName);
    let points: ParsedTrackPoint[] = [];
    let fileDateIso: string | null = null;
    try {
        if (ext === 'geojson' || ext === 'json') {
            points = parseGeoJsonPoints(text);
            try {
                fileDateIso = extractGeoJsonFileTime(JSON.parse(text));
            } catch {
                /* ignore */
            }
            return { points, fileDateIso };
        }
        if (ext === 'gpx') {
            const parser = new DOMParser();
            const xml = parser.parseFromString(text, 'application/xml');
            if (xml.getElementsByTagName('parsererror').length) {
                return { points: [], fileDateIso: null };
            }
            points = parseGpxTrackPoints(xml);
            fileDateIso = parseGpxFileTime(xml);
            return { points, fileDateIso };
        }
        if (ext === 'kml') {
            const parser = new DOMParser();
            const xml = parser.parseFromString(text, 'application/xml');
            if (xml.getElementsByTagName('parsererror').length) {
                return { points: [], fileDateIso: null };
            }
            points = parseKmlTrackPoints(xml);
            fileDateIso = parseKmlFileTime(xml);
            return { points, fileDateIso };
        }
        if (ext === 'tcx') {
            const parser = new DOMParser();
            const xml = parser.parseFromString(text, 'application/xml');
            if (xml.getElementsByTagName('parsererror').length) {
                return { points: [], fileDateIso: null };
            }
            points = parseTcxTrackPoints(xml);
            fileDateIso = parseTcxFileTime(xml);
            return { points, fileDateIso };
        }
        const gpxTry = parseTrackPointsAndDate('x.gpx', text);
        if (gpxTry.points.length > 0) {
            return gpxTry;
        }
        points = parseGeoJsonPoints(text);
        try {
            fileDateIso = extractGeoJsonFileTime(JSON.parse(text));
        } catch {
            /* ignore */
        }
        return { points, fileDateIso };
    } catch {
        return { points: [], fileDateIso: null };
    }
}

function computeDistanceKm(points: ParsedTrackPoint[]): number | null {
    if (points.length < 2) return null;
    let m = 0;
    for (let i = 1; i < points.length; i++) {
        m += haversineMeters(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    }
    return Math.round((m / 1000) * 100) / 100;
}

function movingAverageElevations(values: number[], window: number): number[] {
    const w = Math.max(3, window % 2 === 0 ? window + 1 : window);
    if (values.length < w) {
        return values.slice();
    }
    const half = Math.floor(w / 2);
    const out: number[] = [];
    for (let i = 0; i < values.length; i++) {
        let sum = 0;
        let c = 0;
        for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
            sum += values[j];
            c++;
        }
        out.push(sum / c);
    }
    return out;
}

/**
 * Builds a full elevation profile along the track order: linear interpolation for gaps
 * of at most {@link ELEV_INTERPOLATE_MAX_GAP} points between known values; extends edge
 * plateaus with the nearest known altitude.
 */
function interpolateElevationProfile(points: ParsedTrackPoint[]): number[] | null {
    const raw: (number | null)[] = points.map(p =>
        p.eleM != null && Number.isFinite(p.eleM) ? p.eleM : null
    );
    const n = raw.length;
    if (n < 2 || !raw.some(v => v != null)) {
        return null;
    }

    const filled: (number | null)[] = raw.slice();
    let i = 0;
    while (i < n) {
        if (filled[i] != null) {
            i++;
            continue;
        }
        const start = i;
        while (i < n && filled[i] == null) {
            i++;
        }
        const gapLen = i - start;
        const leftVal = start > 0 ? filled[start - 1] : null;
        const rightVal = i < n ? filled[i] : null;

        if (leftVal != null && rightVal != null) {
            if (gapLen > ELEV_INTERPOLATE_MAX_GAP) {
                return null;
            }
            for (let k = start; k < i; k++) {
                const t = (k - (start - 1)) / (i - (start - 1));
                filled[k] = leftVal + (rightVal - leftVal) * t;
            }
        } else if (leftVal != null && i === n) {
            for (let k = start; k < i; k++) {
                filled[k] = leftVal;
            }
        } else if (rightVal != null && start === 0) {
            for (let k = start; k < i; k++) {
                filled[k] = rightVal;
            }
        } else {
            return null;
        }
    }

    if (!filled.every(v => v != null && Number.isFinite(v!))) {
        return null;
    }
    return filled as number[];
}

/** Fallback: only consecutive points that both carry raw `ele` (no interpolation). */
function elevationGainPairwiseRaw(points: ParsedTrackPoint[], minStepM: number): number | null {
    let gain = 0;
    let any = false;
    for (let j = 1; j < points.length; j++) {
        const a = points[j - 1].eleM;
        const b = points[j].eleM;
        if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) {
            continue;
        }
        any = true;
        const d = b - a;
        if (d > minStepM) {
            gain += d;
        }
    }
    return any ? Math.round(gain) : null;
}

/**
 * D+ (montée cumulée) : profil interpolé le long de la trace, lissage léger, somme des Δh positifs.
 * Si des trous d'altitude sont trop longs, repli sur la somme brute entre points consécutifs ayant un `ele`.
 */
function computeElevationGainM(points: ParsedTrackPoint[]): number | null {
    const dense = interpolateElevationProfile(points);
    if (dense != null && dense.length >= 2) {
        const win =
            dense.length >= 200 ? 21 : dense.length >= 80 ? 15 : dense.length >= 35 ? 11 : 0;
        const sm =
            win >= 5 ? movingAverageElevations(dense, win) : dense;
        let gain = 0;
        for (let j = 1; j < sm.length; j++) {
            const d = sm[j] - sm[j - 1];
            if (d > ELEV_POSITIVE_DELTA_MIN_M) {
                gain += d;
            }
        }
        return Math.round(gain);
    }
    return elevationGainPairwiseRaw(points, 3);
}

export function computeTrackStatsFromFileContent(fileName: string, text: string): TrackRouteStats {
    const { points, fileDateIso } = parseTrackPointsAndDate(fileName, text);
    return {
        pointCount: points.length,
        distanceKm: computeDistanceKm(points),
        elevationGainM: computeElevationGainM(points),
        fileDateIso
    };
}
