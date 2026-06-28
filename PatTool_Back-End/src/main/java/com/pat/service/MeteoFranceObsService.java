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
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Météo-France DPObs v2 — targeted observation API (station list + infrahoraire-6m per station).
 */
@Service
public class MeteoFranceObsService {

    private static final Logger log = LoggerFactory.getLogger(MeteoFranceObsService.class);

    private static final String DEFAULT_DPOBS_V2_BASE =
            "https://public-api.meteofrance.fr/public/DPObs/v2";

    private static final Duration CATALOG_CACHE_TTL = Duration.ofHours(1);
    private static final Duration OBS_CACHE_TTL = Duration.ofMinutes(5);
    private static final int DEFAULT_MAX_STATIONS = 48;
    private static final int ABS_MAX_STATIONS = 120;
    private static final int MAX_STATIONS_FOR_IDW = 50;
    /** Max angular distance (degrees) for IDW — ~120 km at mid-latitudes. */
    private static final double IDW_MAX_DEGREES = 1.1;

    private final RestTemplate restTemplate;
    private final String obsApiToken;
    private final String dpobsBaseUrl;

    private volatile List<ObsStation> cachedCatalog;
    private volatile long cachedCatalogAtMs;
    private final ConcurrentHashMap<String, ObsCacheEntry> obsCache = new ConcurrentHashMap<>();

    public MeteoFranceObsService(
            @Qualifier(RestTemplateConfig.METEOFRANCE_CLIM_REST_TEMPLATE) RestTemplate restTemplate,
            @Value("${meteofrance.obs.api.token:}") String obsApiToken,
            @Value("${meteofrance.obs.base.url:" + DEFAULT_DPOBS_V2_BASE + "}") String dpobsBaseUrl) {
        this.restTemplate = restTemplate;
        this.obsApiToken = normalizeToken(obsApiToken);
        this.dpobsBaseUrl = dpobsBaseUrl != null && !dpobsBaseUrl.isBlank()
                ? dpobsBaseUrl.trim().replaceAll("/+$", "")
                : DEFAULT_DPOBS_V2_BASE;
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
            double minLat, double maxLat, double minLon, double maxLon, int maxStations) {
        if (!isConfigured()) {
            return error("DPObs API key not configured. Set meteofrance.obs.api.token "
                    + "(API « Données Publiques Observation » v2, distinct from radar/clim keys).");
        }

        double south = Math.min(minLat, maxLat);
        double north = Math.max(minLat, maxLat);
        double west = Math.min(minLon, maxLon);
        double east = Math.max(minLon, maxLon);
        int stationLimit = clampMaxStations(maxStations);

        try {
            List<ObsStation> inBounds = loadCatalog().stream()
                    .filter(s -> s.lat >= south && s.lat <= north && s.lon >= west && s.lon <= east)
                    .toList();

            List<ObsStation> selected = selectStations(inBounds, stationLimit, south, north, west, east);
            List<Map<String, Object>> points = new ArrayList<>();
            for (ObsStation station : selected) {
                Map<String, Object> point = fetchStationTemperaturePoint(station);
                if (point != null) {
                    points.add(point);
                }
            }

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("source", "meteofrance-dpobs");
            result.put("apiVersion", "v2");
            result.put("points", points);
            result.put("count", points.size());
            result.put("stationsQueried", selected.size());
            result.put("stationsInBounds", inBounds.size());
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
     * Interpolate DPObs v2 station temperatures on an arbitrary point set (screen grid ~1 cm).
     * Points without nearby stations are omitted — caller may fill with Open-Meteo.
     */
    public Map<String, Object> interpolateTemperatureLabels(
            List<TemperatureLabelsRequestDto.Point> inputPoints,
            int maxPoints) {
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
        try {
            List<StationObs> stationObs = loadStationObservationsInBounds(
                    bounds[0], bounds[1], bounds[2], bounds[3], MAX_STATIONS_FOR_IDW);

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
            double south, double north, double west, double east, int maxStations) {
        List<ObsStation> candidates = loadCatalog().stream()
                .filter(s -> s.lat >= south && s.lat <= north && s.lon >= west && s.lon <= east)
                .toList();
        List<StationObs> obs = new ArrayList<>();
        for (ObsStation station : candidates) {
            if (obs.size() >= maxStations) {
                break;
            }
            Map<String, Object> point = fetchStationTemperaturePoint(station);
            if (point != null && point.get("tempC") instanceof Number tempNum) {
                obs.add(new StationObs(station.id, station.lat, station.lon, tempNum.doubleValue()));
            }
        }
        return obs;
    }

    private static Double idwInterpolate(List<StationObs> stations, double lat, double lon) {
        if (stations.isEmpty()) {
            return null;
        }
        double sumW = 0;
        double sumWt = 0;
        int used = 0;
        for (StationObs s : stations) {
            double dLat = s.lat - lat;
            double dLon = s.lon - lon;
            double dist = Math.sqrt(dLat * dLat + dLon * dLon);
            if (dist < 0.0001) {
                return s.tempC;
            }
            if (dist > IDW_MAX_DEGREES) {
                continue;
            }
            double w = 1.0 / (dist * dist);
            sumW += w;
            sumWt += w * s.tempC;
            used++;
        }
        if (used < 1 || sumW <= 0) {
            return null;
        }
        return Math.round(sumWt / sumW * 10.0) / 10.0;
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
        String[] headers = splitCsvLine(lines[0]);
        int idIdx = findColumn(headers, "id", "id_station", "geo_id_insee");
        int latIdx = findColumn(headers, "lat", "latitude");
        int lonIdx = findColumn(headers, "lon", "longitude");
        int minutelyIdx = findColumn(headers, "is_minutely");
        int openIdx = findColumn(headers, "is_open");

        if (idIdx < 0 || latIdx < 0 || lonIdx < 0) {
            throw new IllegalStateException("DPObs v2 liste-stations CSV: missing id/lat/lon columns");
        }

        List<ObsStation> stations = new ArrayList<>();
        for (int i = 1; i < lines.length; i++) {
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
            stations.add(new ObsStation(id, lat, lon));
        }
        return stations;
    }

    /** Pick stations spread across the visible bbox (one per grid cell when possible). */
    private static List<ObsStation> selectStations(
            List<ObsStation> inBounds,
            int limit,
            double south,
            double north,
            double west,
            double east) {
        if (inBounds.size() <= limit) {
            return inBounds;
        }
        int gridCols = Math.max(1, (int) Math.ceil(Math.sqrt(limit * 1.2)));
        int gridRows = Math.max(1, (int) Math.ceil((double) limit / gridCols));
        double latStep = (north - south) / gridRows;
        double lonStep = (east - west) / gridCols;

        List<ObsStation> selected = new ArrayList<>();
        java.util.Set<String> usedIds = new java.util.HashSet<>();

        for (int r = 0; r < gridRows && selected.size() < limit; r++) {
            double cellSouth = south + r * latStep;
            double cellNorth = south + (r + 1) * latStep;
            for (int c = 0; c < gridCols && selected.size() < limit; c++) {
                double cellWest = west + c * lonStep;
                double cellEast = west + (c + 1) * lonStep;
                double centerLat = (cellSouth + cellNorth) / 2;
                double centerLon = (cellWest + cellEast) / 2;

                ObsStation best = null;
                double bestDist = Double.MAX_VALUE;
                for (ObsStation s : inBounds) {
                    if (usedIds.contains(s.id)) {
                        continue;
                    }
                    if (s.lat < cellSouth || s.lat > cellNorth || s.lon < cellWest || s.lon > cellEast) {
                        continue;
                    }
                    double d = distanceSq(s.lat, s.lon, centerLat, centerLon);
                    if (d < bestDist) {
                        bestDist = d;
                        best = s;
                    }
                }
                if (best != null) {
                    selected.add(best);
                    usedIds.add(best.id);
                }
            }
        }

        if (selected.size() < limit) {
            inBounds.stream()
                    .filter(s -> !usedIds.contains(s.id))
                    .sorted(Comparator.comparingDouble(s -> minDistanceToSelectedSq(s, selected)))
                    .limit(limit - selected.size())
                    .forEach(s -> {
                        selected.add(s);
                        usedIds.add(s.id);
                    });
        }
        return selected;
    }

    private static double minDistanceToSelectedSq(ObsStation candidate, List<ObsStation> selected) {
        if (selected.isEmpty()) {
            return 0;
        }
        double min = Double.MAX_VALUE;
        for (ObsStation s : selected) {
            min = Math.min(min, distanceSq(candidate.lat, candidate.lon, s.lat, s.lon));
        }
        return min;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> fetchStationTemperaturePoint(ObsStation station) {
        ObsCacheEntry cached = obsCache.get(station.id());
        if (cached != null && cached.isValid()) {
            return cached.point();
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
            obsCache.put(station.id(), new ObsCacheEntry(point, Instant.now()));
        }
        return point;
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
        return point;
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

    private static int findColumn(String[] headers, String... names) {
        for (int i = 0; i < headers.length; i++) {
            String h = headers[i].trim().toLowerCase(Locale.ROOT);
            for (String name : names) {
                if (h.equals(name.toLowerCase(Locale.ROOT))) {
                    return i;
                }
            }
        }
        return -1;
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

    private record ObsStation(String id, double lat, double lon) {}

    private record StationObs(String id, double lat, double lon, double tempC) {}

    private record ObsCacheEntry(Map<String, Object> point, Instant fetchedAt) {
        boolean isValid() {
            return fetchedAt.plus(OBS_CACHE_TTL).isAfter(Instant.now());
        }
    }
}
