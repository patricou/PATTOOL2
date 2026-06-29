package com.pat.service;

import com.pat.config.RestTemplateConfig;
import com.pat.controller.dto.TemperatureLabelsRequestDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * Météo-France DPObs v2 — targeted observation API (station list + infrahoraire-6m per station).
 */
@Service
public class MeteoFranceObsService {

    private static final Logger log = LoggerFactory.getLogger(MeteoFranceObsService.class);

    private static final String DEFAULT_DPOBS_V2_BASE =
            "https://public-api.meteofrance.fr/public/DPObs/v2";

    private static final Duration CATALOG_CACHE_TTL = Duration.ofHours(1);
    private static final Duration DEFAULT_OBS_CACHE_TTL = Duration.ofMinutes(5);
    private static final int DEFAULT_MAX_STATIONS = 48;
    private static final int ABS_MAX_STATIONS = 120;
    private static final int MAX_STATIONS_FOR_IDW = 24;

    /** Ordered by importance — matched as substring in station name (uppercase). */
    private static final List<String> MAJOR_CITY_NAME_TOKENS = List.of(
            "PARIS", "MARSEILLE", "LYON", "TOULOUSE", "NICE", "NANTES", "STRASBOURG",
            "MONTPELLIER", "BORDEAUX", "LILLE", "RENNES", "REIMS", "LE HAVRE", "SAINT-ETIENNE",
            "TOULON", "GRENOBLE", "DIJON", "ANGERS", "CLERMONT", "BREST", "TOURS", "AMIENS",
            "METZ", "PERPIGNAN", "BESANCON", "ORLEANS", "MULHOUSE", "CAEN", "NANCY", "ROUEN",
            "AVIGNON", "POITIERS", "LIMOGES", "ANNECY", "LA ROCHELLE", "PAU", "BAYONNE",
            "AJACCIO", "BASTIA", "FORT-DE-FRANCE", "CAYENNE", "SAINT-DENIS"
    );
    /** Max angular distance (degrees) for IDW — ~120 km at mid-latitudes. */
    private static final double IDW_MAX_DEGREES = 1.1;

    private final RestTemplate restTemplate;
    private final String obsApiToken;
    private final String dpobsBaseUrl;
    private final MeteoFranceTemperatureCachePreferenceService temperatureCachePreferenceService;

    private volatile List<ObsStation> cachedCatalog;
    private volatile long cachedCatalogAtMs;
    private final ConcurrentHashMap<String, ObsCacheEntry> obsCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, BoundsCacheEntry> boundsResponseCache = new ConcurrentHashMap<>();

    public MeteoFranceObsService(
            @Qualifier(RestTemplateConfig.METEOFRANCE_CLIM_REST_TEMPLATE) RestTemplate restTemplate,
            @Value("${meteofrance.obs.api.token:}") String obsApiToken,
            @Value("${meteofrance.obs.base.url:" + DEFAULT_DPOBS_V2_BASE + "}") String dpobsBaseUrl,
            MeteoFranceTemperatureCachePreferenceService temperatureCachePreferenceService) {
        this.restTemplate = restTemplate;
        this.obsApiToken = normalizeToken(obsApiToken);
        this.dpobsBaseUrl = dpobsBaseUrl != null && !dpobsBaseUrl.isBlank()
                ? dpobsBaseUrl.trim().replaceAll("/+$", "")
                : DEFAULT_DPOBS_V2_BASE;
        this.temperatureCachePreferenceService = temperatureCachePreferenceService;
        if (isConfigured()) {
            log.info("Météo-France DPObs v2 credentials loaded (base={})", this.dpobsBaseUrl);
        } else {
            log.info("Météo-France DPObs not configured — set meteofrance.obs.api.token "
                    + "(API « Données Publiques Observation » v2 on portail-api.meteofrance.fr)");
        }
    }

    public Map<String, Object> getStatusFragment() {
        Map<String, Object> status = new LinkedHashMap<>();
        boolean configured = isConfigured();
        status.put("dpobsConfigured", configured);
        status.put("dpobsAuthValid", false);
        status.put("dpobsApiVersion", "v2");
        status.put("dpobsBaseUrl", dpobsBaseUrl);
        if (configured) {
            boolean valid = probeAuth();
            status.put("dpobsAuthValid", valid);
            if (!valid) {
                status.put("dpobsAuthError",
                        "Invalid credentials or missing subscription to API « Données Publiques Observation » (v2). "
                                + "Use meteofrance.obs.api.token.");
            }
        }
        status.put("obsEndpoints", List.of(
                "/api/external/meteofrance/obs/temperature-labels",
                "/api/external/weather/map/temperature-labels"
        ));
        return status;
    }

    public boolean isConfigured() {
        return !obsApiToken.isEmpty();
    }

    /**
     * Station temperatures in bounds via DPObs v2 {@code /station/infrahoraire-6m} (GeoJSON per station).
     */
    public Map<String, Object> getTemperatureLabelsInBounds(
            double minLat, double maxLat, double minLon, double maxLon, int maxStations, String jwtSubject) {
        if (!isConfigured()) {
            return error("DPObs API key not configured. Set meteofrance.obs.api.token "
                    + "(API « Données Publiques Observation » v2, distinct from radar/clim keys).");
        }

        double south = Math.min(minLat, maxLat);
        double north = Math.max(minLat, maxLat);
        double west = Math.min(minLon, maxLon);
        double east = Math.max(minLon, maxLon);
        int stationLimit = clampMaxStations(maxStations);
        Duration cacheTtl = resolveCacheTtl(jwtSubject);
        String boundsKey = boundsCacheKey(south, north, west, east, stationLimit);

        BoundsCacheEntry cachedBounds = boundsResponseCache.get(boundsKey);
        if (cachedBounds != null && cachedBounds.isValid(cacheTtl)) {
            return cachedBounds.copyResult();
        }

        try {
            List<ObsStation> inBounds = loadCatalog().stream()
                    .filter(s -> s.lat >= south && s.lat <= north && s.lon >= west && s.lon <= east)
                    .toList();

            StationSelection selection = selectStationsForViewport(
                    inBounds, stationLimit, south, north, west, east);
            List<Map<String, Object>> points = selection.stations().parallelStream()
                    .map(station -> fetchStationTemperaturePoint(station, cacheTtl))
                    .filter(Objects::nonNull)
                    .collect(Collectors.toCollection(ArrayList::new));

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("source", "meteofrance-dpobs");
            result.put("apiVersion", "v2");
            result.put("points", points);
            result.put("count", points.size());
            result.put("stationsQueried", selection.stations().size());
            result.put("stationsInBounds", inBounds.size());
            result.put("detailLevel", selection.detailLevel());
            result.put("cacheTtlMinutes", cacheTtl.toMinutes());
            boundsResponseCache.put(boundsKey, new BoundsCacheEntry(result, Instant.now()));
            return result;
        } catch (HttpClientErrorException e) {
            Map<String, Object> err = error("DPObs v2 API error: " + e.getStatusCode());
            err.put("details", e.getResponseBodyAsString());
            if (e.getStatusCode() == HttpStatus.UNAUTHORIZED) {
                err.put("authValid", false);
            }
            return err;
        } catch (Exception e) {
            log.warn("DPObs v2 temperature labels failed: {}", e.getMessage());
            return error("DPObs v2 temperature labels failed: " + e.getMessage());
        }
    }

    /**
     * Force-refresh one or more stations from DPObs v2 and store fresh values in the station cache.
     */
    public Map<String, Object> refreshTemperaturePoints(
            List<TemperatureLabelsRequestDto.Point> targets, String jwtSubject) {
        if (!isConfigured()) {
            return error("DPObs API key not configured.");
        }
        if (targets == null || targets.isEmpty()) {
            return error("points required");
        }
        Duration cacheTtl = resolveCacheTtl(jwtSubject);
        List<Map<String, Object>> points = new ArrayList<>();
        try {
            for (TemperatureLabelsRequestDto.Point target : targets) {
                ObsStation station = resolveStationForTarget(target);
                if (station == null) {
                    continue;
                }
                Map<String, Object> point = fetchStationTemperaturePoint(station, cacheTtl, true);
                if (point != null) {
                    point.put("cached", false);
                    points.add(point);
                }
            }
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("source", "meteofrance-dpobs");
            result.put("apiVersion", "v2");
            result.put("points", points);
            result.put("count", points.size());
            result.put("refreshed", true);
            return result;
        } catch (Exception e) {
            log.warn("DPObs v2 temperature refresh failed: {}", e.getMessage());
            return error("DPObs v2 temperature refresh failed: " + e.getMessage());
        }
    }

    /** Clears in-memory DPObs station and bounds response caches (does not change TTL preferences). */
    public int clearTemperatureObservationCache() {
        int cleared = obsCache.size() + boundsResponseCache.size();
        obsCache.clear();
        boundsResponseCache.clear();
        return cleared;
    }

    /**
     * Interpolate DPObs v2 station temperatures on an arbitrary point set (screen grid ~1 cm).
     * Points without nearby stations are omitted — caller may fill with Open-Meteo.
     */
    public Map<String, Object> interpolateTemperatureLabels(
            List<TemperatureLabelsRequestDto.Point> inputPoints,
            int maxPoints,
            String jwtSubject) {
        if (!isConfigured()) {
            return error("DPObs API key not configured.");
        }
        if (inputPoints == null || inputPoints.isEmpty()) {
            Map<String, Object> empty = new LinkedHashMap<>();
            empty.put("source", "meteofrance-dpobs");
            empty.put("apiVersion", "v2");
            empty.put("points", List.of());
            empty.put("count", 0);
            return empty;
        }

        int limit = Math.min(inputPoints.size(), maxPoints);
        double[] bounds = boundsOf(inputPoints, limit);
        Duration cacheTtl = resolveCacheTtl(jwtSubject);
        try {
            List<StationObs> stationObs = loadStationObservationsInBounds(
                    bounds[0], bounds[1], bounds[2], bounds[3], MAX_STATIONS_FOR_IDW, cacheTtl);

            List<Map<String, Object>> points = new ArrayList<>();
            int idwHits = 0;
            for (int i = 0; i < limit; i++) {
                TemperatureLabelsRequestDto.Point target = inputPoints.get(i);
                Double tempC = idwInterpolate(stationObs, target.lat(), target.lon());
                if (tempC == null) {
                    continue;
                }
                idwHits++;
                Map<String, Object> point = new LinkedHashMap<>();
                point.put("lat", roundCoord(target.lat()));
                point.put("lon", roundCoord(target.lon()));
                point.put("tempC", tempC);
                point.put("interpolated", true);
                StationObs nearest = findNearestStation(stationObs, target.lat(), target.lon());
                if (nearest != null) {
                    copyObservationMeta(point, nearest.data());
                    point.put("stationLat", roundCoord(nearest.lat()));
                    point.put("stationLon", roundCoord(nearest.lon()));
                }
                points.add(point);
            }

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("source", "meteofrance-dpobs");
            result.put("apiVersion", "v2");
            result.put("interpolation", "idw");
            result.put("points", points);
            result.put("count", points.size());
            result.put("stationsUsed", stationObs.size());
            result.put("idwHits", idwHits);
            return result;
        } catch (Exception e) {
            log.warn("DPObs v2 IDW grid failed: {}", e.getMessage());
            return error("DPObs v2 IDW grid failed: " + e.getMessage());
        }
    }

    private List<StationObs> loadStationObservationsInBounds(
            double south, double north, double west, double east, int maxStations, Duration cacheTtl) {
        List<ObsStation> candidates = loadCatalog().stream()
                .filter(s -> s.lat >= south && s.lat <= north && s.lon >= west && s.lon <= east)
                .toList();
        List<ObsStation> selected =     limitStationsInBounds(candidates, maxStations);
        List<StationObs> obs = new ArrayList<>();
        for (ObsStation station : selected) {
            Map<String, Object> point = fetchStationTemperaturePoint(station, cacheTtl);
            if (point != null && point.get("tempC") instanceof Number tempNum) {
                obs.add(new StationObs(point));
            }
        }
        return obs;
    }

    private Duration resolveCacheTtl(String jwtSubject) {
        return temperatureCachePreferenceService.resolveEffectiveDuration(jwtSubject);
    }

    private static String boundsCacheKey(
            double south, double north, double west, double east, int maxStations) {
        return String.format(Locale.ROOT, "%.2f|%.2f|%.2f|%.2f|%d", south, north, west, east, maxStations);
    }

    private static Double idwInterpolate(List<StationObs> stations, double lat, double lon) {
        if (stations.isEmpty()) {
            return null;
        }
        double sumW = 0;
        double sumWt = 0;
        int used = 0;
        for (StationObs s : stations) {
            double dLat = s.lat() - lat;
            double dLon = s.lon() - lon;
            double dist = Math.sqrt(dLat * dLat + dLon * dLon);
            if (dist < 0.0001) {
                return s.tempC();
            }
            if (dist > IDW_MAX_DEGREES) {
                continue;
            }
            double w = 1.0 / (dist * dist);
            sumW += w;
            sumWt += w * s.tempC();
            used++;
        }
        if (used < 1 || sumW <= 0) {
            return null;
        }
        return Math.round(sumWt / sumW * 10.0) / 10.0;
    }

    private static StationObs findNearestStation(List<StationObs> stations, double lat, double lon) {
        StationObs nearest = null;
        double bestDist = Double.MAX_VALUE;
        for (StationObs station : stations) {
            double dist = distanceSq(station.lat(), station.lon(), lat, lon);
            if (dist < bestDist) {
                bestDist = dist;
                nearest = station;
            }
        }
        return nearest;
    }

    private static final List<String> OBSERVATION_META_KEYS = List.of(
            "stationId",
            "stationName",
            "humidityPct",
            "windDirectionDeg",
            "windSpeedMs",
            "windGustMs",
            "dewPointC",
            "precipitationMm",
            "pressureHpa",
            "observedAt",
            "source"
    );

    private static void copyObservationMeta(Map<String, Object> target, Map<String, Object> source) {
        for (String key : OBSERVATION_META_KEYS) {
            Object value = source.get(key);
            if (value != null) {
                target.put(key, value);
            }
        }
    }

    private static double[] boundsOf(List<TemperatureLabelsRequestDto.Point> points, int limit) {
        double south = Double.POSITIVE_INFINITY;
        double north = Double.NEGATIVE_INFINITY;
        double west = Double.POSITIVE_INFINITY;
        double east = Double.NEGATIVE_INFINITY;
        for (int i = 0; i < limit; i++) {
            TemperatureLabelsRequestDto.Point p = points.get(i);
            south = Math.min(south, p.lat());
            north = Math.max(north, p.lat());
            west = Math.min(west, p.lon());
            east = Math.max(east, p.lon());
        }
        double padLat = Math.max(0.05, (north - south) * 0.05);
        double padLon = Math.max(0.05, (east - west) * 0.05);
        return new double[] { south - padLat, north + padLat, west - padLon, east + padLon };
    }

    private List<ObsStation> loadCatalog() {
        long now = System.currentTimeMillis();
        if (cachedCatalog != null && now - cachedCatalogAtMs < CATALOG_CACHE_TTL.toMillis()) {
            return cachedCatalog;
        }
        String url = dpobsBaseUrl + "/liste-stations";
        ResponseEntity<byte[]> response = restTemplate.exchange(
                url,
                HttpMethod.GET,
                new HttpEntity<>(authHeaders()),
                byte[].class
        );
        byte[] body = response.getBody();
        if (body == null || body.length == 0) {
            throw new IllegalStateException("DPObs v2 liste-stations returned empty body");
        }
        List<ObsStation> catalog = parseStationCatalog(new String(body, StandardCharsets.UTF_8));
        cachedCatalog = catalog;
        cachedCatalogAtMs = now;
        log.debug("DPObs v2 station catalog loaded: {} stations", catalog.size());
        return catalog;
    }

    static List<ObsStation> parseStationCatalog(String csv) {
        String[] lines = csv.split("\\R");
        if (lines.length < 2) {
            return List.of();
        }
        int headerLineIdx = -1;
        String[] headers = null;
        for (int i = 0; i < Math.min(lines.length, 12); i++) {
            String[] candidate = splitCsvLine(lines[i]);
            if (findColumn(candidate, "id_station", "geo_id_insee", "id") >= 0
                    && findColumn(candidate, "latitude", "lat") >= 0
                    && findColumn(candidate, "longitude", "lon") >= 0) {
                headerLineIdx = i;
                headers = candidate;
                break;
            }
        }
        if (headers == null || headerLineIdx < 0) {
            throw new IllegalStateException("DPObs v2 liste-stations CSV: missing id/lat/lon columns");
        }

        int idIdx = findColumn(headers, "id_station", "geo_id_insee", "id");
        int latIdx = findColumn(headers, "latitude", "lat");
        int lonIdx = findColumn(headers, "longitude", "lon");
        int nameIdx = findColumn(headers,
                "nom_usuel", "nom", "name", "long_name", "named_place",
                "libelle", "station_name", "ville", "poste");
        int minutelyIdx = findColumn(headers, "is_minutely");
        int openIdx = findColumn(headers, "is_open");

        List<ObsStation> stations = new ArrayList<>();
        for (int i = headerLineIdx + 1; i < lines.length; i++) {
            String line = lines[i].trim();
            if (line.isEmpty()) {
                continue;
            }
            String[] cols = splitCsvLine(line);
            if (cols.length <= Math.max(idIdx, Math.max(latIdx, lonIdx))) {
                continue;
            }
            if (openIdx >= 0 && cols.length > openIdx && isFalse(cols[openIdx])) {
                continue;
            }
            if (minutelyIdx >= 0 && cols.length > minutelyIdx && isFalse(cols[minutelyIdx])) {
                continue;
            }
            String id = normalizeStationId(cols[idIdx]);
            Double lat = parseDouble(cols[latIdx]);
            Double lon = parseDouble(cols[lonIdx]);
            if (id == null || lat == null || lon == null) {
                continue;
            }
            String name = null;
            if (nameIdx >= 0 && cols.length > nameIdx) {
                name = cleanCsvCell(cols[nameIdx]);
                if (name != null && name.isBlank()) {
                    name = null;
                }
            }
            stations.add(new ObsStation(id, name, lat, lon));
        }
        return stations;
    }

    /** Cap station API calls; keep real station positions (no spatial resampling). */
    private static List<ObsStation> limitStationsInBounds(List<ObsStation> inBounds, int limit) {
        if (inBounds.size() <= limit) {
            return inBounds;
        }
        return inBounds.stream()
                .sorted(Comparator.comparing(ObsStation::id))
                .limit(limit)
                .toList();
    }

    private record StationSelection(List<ObsStation> stations, String detailLevel) {}

    /**
     * Large viewport → major cities only; medium → major first then fill; zoomed in → all stations in bounds.
     */
    private static StationSelection selectStationsForViewport(
            List<ObsStation> inBounds, int maxStations,
            double south, double north, double west, double east) {
        if (inBounds.isEmpty()) {
            return new StationSelection(inBounds, "none");
        }

        double latSpan = north - south;
        double lonSpan = east - west;
        double area = latSpan * lonSpan;
        int limit = Math.min(maxStations, inBounds.size());

        boolean largeView = latSpan > 5.5 || lonSpan > 5.5 || area > 20;
        boolean mediumView = !largeView && (latSpan > 2.2 || lonSpan > 2.2 || area > 4);

        if (largeView) {
            int majorLimit = Math.min(24, limit);
            List<ObsStation> major = pickMajorCityStations(inBounds, majorLimit);
            if (!major.isEmpty()) {
                return new StationSelection(major, "major-cities");
            }
            return new StationSelection(limitStationsInBounds(inBounds, Math.min(20, limit)), "sparse");
        }

        if (mediumView) {
            List<ObsStation> major = pickMajorCityStations(inBounds, limit);
            if (major.size() >= limit) {
                return new StationSelection(major, "major-cities");
            }
            Set<String> usedIds = major.stream().map(ObsStation::id).collect(Collectors.toCollection(LinkedHashSet::new));
            List<ObsStation> mixed = new ArrayList<>(major);
            inBounds.stream()
                    .filter(s -> !usedIds.contains(s.id()))
                    .sorted(Comparator.comparing(ObsStation::id))
                    .limit(limit - mixed.size())
                    .forEach(mixed::add);
            return new StationSelection(mixed, "mixed");
        }

        return new StationSelection(limitStationsInBounds(inBounds, limit), "all");
    }

    private static List<ObsStation> pickMajorCityStations(List<ObsStation> inBounds, int limit) {
        return inBounds.stream()
                .filter(MeteoFranceObsService::isMajorCityStation)
                .sorted(Comparator.comparingInt(MeteoFranceObsService::majorCityRank)
                        .thenComparing(ObsStation::id))
                .limit(limit)
                .toList();
    }

    private static boolean isMajorCityStation(ObsStation station) {
        if (station.name() == null || station.name().isBlank()) {
            return false;
        }
        String upper = station.name().toUpperCase(Locale.ROOT);
        for (String token : MAJOR_CITY_NAME_TOKENS) {
            if (upper.contains(token)) {
                return true;
            }
        }
        return false;
    }

    private static int majorCityRank(ObsStation station) {
        String upper = station.name() != null ? station.name().toUpperCase(Locale.ROOT) : "";
        for (int i = 0; i < MAJOR_CITY_NAME_TOKENS.size(); i++) {
            if (upper.contains(MAJOR_CITY_NAME_TOKENS.get(i))) {
                return i;
            }
        }
        return MAJOR_CITY_NAME_TOKENS.size();
    }

    private Map<String, Object> fetchStationTemperaturePoint(ObsStation station, Duration cacheTtl) {
        return fetchStationTemperaturePoint(station, cacheTtl, false);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> fetchStationTemperaturePoint(
            ObsStation station, Duration cacheTtl, boolean bypassCache) {
        ObsCacheEntry cached = obsCache.get(station.id());
        if (!bypassCache && cached != null && cached.isValid(cacheTtl)) {
            Map<String, Object> point = new LinkedHashMap<>(cached.point());
            enrichStationName(point, station);
            point.put("cached", true);
            return point;
        }

        if (bypassCache) {
            obsCache.remove(station.id());
        }

        String url = UriComponentsBuilder
                .fromHttpUrl(dpobsBaseUrl + "/station/infrahoraire-6m")
                .queryParam("id_station", station.id())
                .queryParam("format", "geojson")
                .toUriString();

        ResponseEntity<Object> response = restTemplate.exchange(
                url,
                HttpMethod.GET,
                new HttpEntity<>(authHeaders()),
                Object.class
        );

        Map<String, Object> point = extractPointFromObsBody(response.getBody(), station);
        if (point != null) {
            point.put("cached", false);
            obsCache.put(station.id(), new ObsCacheEntry(stripCachedFlag(point), Instant.now()));
            if (bypassCache) {
                patchStationInBoundsCaches(station.id(), point);
            }
        }
        return point;
    }

    /**
     * After a forced station refresh, update every cached bounds response that already contains
     * that station so pan/zoom keeps serving the fresh observation instead of stale values.
     */
    @SuppressWarnings("unchecked")
    private void patchStationInBoundsCaches(String stationId, Map<String, Object> freshPoint) {
        if (stationId == null || stationId.isBlank() || freshPoint == null) {
            return;
        }
        Map<String, Object> stored = stripCachedFlag(new LinkedHashMap<>(freshPoint));
        for (Map.Entry<String, BoundsCacheEntry> entry : boundsResponseCache.entrySet()) {
            BoundsCacheEntry boundsEntry = entry.getValue();
            Map<String, Object> result = boundsEntry.result();
            Object rawPoints = result.get("points");
            if (!(rawPoints instanceof List<?> list)) {
                continue;
            }
            List<Map<String, Object>> points = (List<Map<String, Object>>) rawPoints;
            boolean updated = false;
            for (int i = 0; i < points.size(); i++) {
                Map<String, Object> point = points.get(i);
                Object id = point.get("stationId");
                if (id != null && stationId.equals(String.valueOf(id))) {
                    points.set(i, new LinkedHashMap<>(stored));
                    updated = true;
                }
            }
            if (updated) {
                boundsResponseCache.put(entry.getKey(), new BoundsCacheEntry(result, Instant.now()));
            }
        }
    }

    private static Map<String, Object> stripCachedFlag(Map<String, Object> point) {
        Map<String, Object> stored = new LinkedHashMap<>(point);
        stored.remove("cached");
        return stored;
    }

    private ObsStation resolveStationForTarget(TemperatureLabelsRequestDto.Point target) {
        List<ObsStation> catalog = loadCatalog();
        if (target.stationId() != null && !target.stationId().isBlank()) {
            for (ObsStation station : catalog) {
                if (target.stationId().equals(station.id())) {
                    return station;
                }
            }
        }
        ObsStation nearest = null;
        double bestDistance = Double.MAX_VALUE;
        for (ObsStation station : catalog) {
            double dLat = station.lat - target.lat();
            double dLon = station.lon - target.lon();
            double distance = dLat * dLat + dLon * dLon;
            if (distance < bestDistance) {
                bestDistance = distance;
                nearest = station;
            }
        }
        return bestDistance <= 0.02 ? nearest : null;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> extractPointFromObsBody(Object body, ObsStation station) {
        List<Map<String, Object>> features = parseGeoJsonFeatures(body);
        for (Map<String, Object> feature : features) {
            Map<String, Object> point = featureToPoint(feature, station);
            if (point != null) {
                return point;
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> parseGeoJsonFeatures(Object body) {
        List<Map<String, Object>> features = new ArrayList<>();
        if (body instanceof Map<?, ?> map) {
            Object rawFeatures = map.get("features");
            if (rawFeatures instanceof List<?> list) {
                for (Object item : list) {
                    if (item instanceof Map<?, ?> featureMap) {
                        features.add((Map<String, Object>) featureMap);
                    }
                }
            } else if (map.get("geometry") != null) {
                features.add((Map<String, Object>) map);
            }
        } else if (body instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof Map<?, ?> featureMap) {
                    features.add((Map<String, Object>) featureMap);
                }
            }
        }
        return features;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> featureToPoint(Map<String, Object> feature, ObsStation station) {
        Object propsObj = feature.get("properties");
        if (!(propsObj instanceof Map<?, ?> props)) {
            return null;
        }
        Double tempK = toDouble(props.get("t"));
        if (tempK == null) {
            return null;
        }

        double lat = station.lat;
        double lon = station.lon;
        Object geometryObj = feature.get("geometry");
        if (geometryObj instanceof Map<?, ?> geometry) {
            Object coordsObj = geometry.get("coordinates");
            if (coordsObj instanceof List<?> coords && coords.size() >= 2) {
                Double geoLon = toDouble(coords.get(0));
                Double geoLat = toDouble(coords.get(1));
                if (geoLat != null && geoLon != null) {
                    lat = geoLat;
                    lon = geoLon;
                }
            }
        }

        Map<String, Object> point = new LinkedHashMap<>();
        point.put("lat", roundCoord(lat));
        point.put("lon", roundCoord(lon));
        point.put("tempC", kelvinToCelsius(tempK));
        point.put("stationId", station.id);
        String stationName = resolveStationName(station, props);
        if (stationName != null && !stationName.isBlank()) {
            point.put("stationName", stationName);
        }
        point.put("source", "meteofrance-dpobs");

        putNumber(point, "humidityPct", props.get("u"));
        putNumber(point, "windDirectionDeg", props.get("dd"));
        putNumber(point, "windSpeedMs", props.get("ff"));
        putNumber(point, "windGustMs", props.get("fxi10"));
        Double dewPointK = toDouble(props.get("td"));
        if (dewPointK != null) {
            point.put("dewPointC", kelvinToCelsius(dewPointK));
        }
        putNumber(point, "precipitationMm", props.get("rr_per"));
        Double pressure = toDouble(props.get("pres"));
        if (pressure == null) {
            pressure = toDouble(props.get("pmer"));
        }
        if (pressure != null) {
            point.put("pressureHpa", normalizePressureHpa(pressure));
        }
        Object observedAt = props.get("validity_time");
        if (observedAt != null && !String.valueOf(observedAt).isBlank()) {
            point.put("observedAt", String.valueOf(observedAt));
        }
        return point;
    }

    private static void putNumber(Map<String, Object> target, String key, Object raw) {
        Double value = toDouble(raw);
        if (value != null) {
            target.put(key, value);
        }
    }

    private static double normalizePressureHpa(double pressure) {
        if (pressure > 2000) {
            return Math.round(pressure / 100.0 * 10.0) / 10.0;
        }
        return Math.round(pressure * 10.0) / 10.0;
    }

    private boolean probeAuth() {
        try {
            ResponseEntity<byte[]> response = restTemplate.exchange(
                    dpobsBaseUrl + "/liste-stations",
                    HttpMethod.GET,
                    new HttpEntity<>(authHeaders()),
                    byte[].class
            );
            return response.getStatusCode().is2xxSuccessful();
        } catch (HttpClientErrorException e) {
            return false;
        } catch (Exception e) {
            log.debug("DPObs v2 auth probe failed: {}", e.getMessage());
            return false;
        }
    }

    private HttpHeaders authHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(obsApiToken);
        headers.set("apikey", obsApiToken);
        headers.set(HttpHeaders.USER_AGENT, "PATTOOL/1.0");
        return headers;
    }

    private static int clampMaxStations(int maxStations) {
        if (maxStations <= 0) {
            return DEFAULT_MAX_STATIONS;
        }
        return Math.min(Math.max(maxStations, 4), ABS_MAX_STATIONS);
    }

    private static void enrichStationName(Map<String, Object> point, ObsStation station) {
        if (station.name != null && !station.name.isBlank()) {
            point.put("stationName", station.name.trim());
        }
    }

    private static String resolveStationName(ObsStation station, Map<?, ?> props) {
        if (station.name != null && !station.name.isBlank()) {
            return station.name.trim();
        }
        for (String key : List.of("nom", "name", "libelle", "station_name", "nom_usuel", "long_name")) {
            Object raw = props.get(key);
            if (raw != null) {
                String value = String.valueOf(raw).trim();
                if (!value.isBlank()) {
                    return value;
                }
            }
        }
        return null;
    }

    private static String cleanCsvCell(String raw) {
        if (raw == null) {
            return null;
        }
        return raw.trim().replace("\"", "");
    }

    private static int findColumn(String[] headers, String... names) {
        for (String name : names) {
            String target = normalizeHeader(name);
            for (int i = 0; i < headers.length; i++) {
                if (normalizeHeader(headers[i]).equals(target)) {
                    return i;
                }
            }
        }
        return -1;
    }

    private static String normalizeHeader(String raw) {
        if (raw == null) {
            return "";
        }
        return raw.trim()
                .replace("\"", "")
                .toLowerCase(Locale.ROOT)
                .replace(' ', '_')
                .replace("'", "");
    }

    private static String[] splitCsvLine(String line) {
        if (line.indexOf(';') >= 0 && line.indexOf(',') < 0) {
            return line.split(";", -1);
        }
        return line.split(",", -1);
    }

    private static boolean isFalse(String value) {
        if (value == null || value.isBlank()) {
            return false;
        }
        String v = value.trim().toLowerCase(Locale.ROOT);
        return "0".equals(v) || "false".equals(v) || "f".equals(v) || "non".equals(v);
    }

    private static String normalizeStationId(String raw) {
        if (raw == null) {
            return null;
        }
        String id = raw.trim().replace("\"", "");
        if (!id.matches("\\d+")) {
            return null;
        }
        while (id.length() < 8) {
            id = "0" + id;
        }
        return id.length() == 8 ? id : null;
    }

    private static Double parseDouble(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return Double.parseDouble(raw.trim().replace("\"", "").replace(',', '.'));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static double distanceSq(double lat1, double lon1, double lat2, double lon2) {
        double dLat = lat1 - lat2;
        double dLon = lon1 - lon2;
        return dLat * dLat + dLon * dLon;
    }

    private static double kelvinToCelsius(double kelvin) {
        return Math.round((kelvin - 273.15) * 10.0) / 10.0;
    }

    private static Double toDouble(Object value) {
        if (value instanceof Number number) {
            return number.doubleValue();
        }
        if (value == null) {
            return null;
        }
        return parseDouble(String.valueOf(value));
    }

    private static double roundCoord(double value) {
        return Math.round(value * 10000.0) / 10000.0;
    }

    private static Map<String, Object> error(String message) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("error", message);
        return map;
    }

    private static String normalizeToken(String token) {
        if (token == null) {
            return "";
        }
        String trimmed = token.trim();
        if (trimmed.regionMatches(true, 0, "Bearer ", 0, 7)) {
            return trimmed.substring(7).trim();
        }
        return trimmed;
    }

    private record ObsStation(String id, String name, double lat, double lon) {}

    private record StationObs(Map<String, Object> data) {
        double lat() {
            return ((Number) data.get("lat")).doubleValue();
        }

        double lon() {
            return ((Number) data.get("lon")).doubleValue();
        }

        double tempC() {
            return ((Number) data.get("tempC")).doubleValue();
        }
    }

    private record ObsCacheEntry(Map<String, Object> point, Instant fetchedAt) {
        boolean isValid(Duration ttl) {
            Duration effectiveTtl = ttl != null ? ttl : DEFAULT_OBS_CACHE_TTL;
            return fetchedAt.plus(effectiveTtl).isAfter(Instant.now());
        }
    }

    private record BoundsCacheEntry(Map<String, Object> result, Instant fetchedAt) {
        boolean isValid(Duration ttl) {
            Duration effectiveTtl = ttl != null ? ttl : DEFAULT_OBS_CACHE_TTL;
            return fetchedAt.plus(effectiveTtl).isAfter(Instant.now());
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> copyResult() {
            Map<String, Object> copy = new LinkedHashMap<>(result);
            copy.put("cached", true);
            Object rawPoints = copy.get("points");
            if (rawPoints instanceof List<?> list) {
                List<Map<String, Object>> marked = new ArrayList<>(list.size());
                for (Object item : list) {
                    if (item instanceof Map<?, ?> map) {
                        Map<String, Object> point = new LinkedHashMap<>((Map<String, Object>) map);
                        point.put("cached", true);
                        marked.add(point);
                    }
                }
                copy.put("points", marked);
            }
            return copy;
        }
    }
}
