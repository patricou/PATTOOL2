package com.pat.service;

import com.pat.controller.dto.TemperatureLabelsRequestDto;
import org.slf4j.Logger;import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Open-Meteo forecast API (free, no key) — used for numeric temperature labels on the map grid.
 */
@Service
public class OpenMeteoService {

    private static final Logger log = LoggerFactory.getLogger(OpenMeteoService.class);
    private static final String FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
    private static final Duration DEFAULT_CACHE_TTL = Duration.ofMinutes(5);

    private final RestTemplate restTemplate;
    private final MeteoFranceTemperatureCachePreferenceService temperatureCachePreferenceService;
    private final ConcurrentHashMap<String, CacheEntry> obsCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, GridCacheEntry> gridResponseCache = new ConcurrentHashMap<>();

    public OpenMeteoService(
            RestTemplate restTemplate,
            MeteoFranceTemperatureCachePreferenceService temperatureCachePreferenceService) {
        this.restTemplate = restTemplate;
        this.temperatureCachePreferenceService = temperatureCachePreferenceService;
    }

    private static final int BATCH_SIZE = 50;

    /**
     * Sample current 2 m temperatures on a lat/lon grid (for map number labels).
     */
    public Map<String, Object> getTemperatureLabelGrid(
            double minLat, double maxLat, double minLon, double maxLon, int cols, int rows, String jwtSubject) {
        cols = clamp(cols, 2, 8);
        rows = clamp(rows, 2, 8);

        double south = Math.min(minLat, maxLat);
        double north = Math.max(minLat, maxLat);
        double west = Math.min(minLon, maxLon);
        double east = Math.max(minLon, maxLon);
        Duration cacheTtl = resolveCacheTtl(jwtSubject);
        String gridKey = gridCacheKey(south, north, west, east, cols, rows);

        GridCacheEntry cachedGrid = gridResponseCache.get(gridKey);
        if (cachedGrid != null && cachedGrid.isValid(cacheTtl)) {
            return cachedGrid.copyResult();
        }

        double latStep = rows > 1 ? (north - south) / (rows - 1) : 0;
        double lonStep = cols > 1 ? (east - west) / (cols - 1) : 0;

        List<double[]> coordinates = new ArrayList<>(cols * rows);
        for (int r = 0; r < rows; r++) {
            for (int c = 0; c < cols; c++) {
                double lat = rows > 1 ? south + r * latStep : (south + north) / 2;
                double lon = cols > 1 ? west + c * lonStep : (west + east) / 2;
                coordinates.add(new double[] { lat, lon });
            }
        }

        Map<String, Map<String, Object>> obsByKey = new LinkedHashMap<>();
        fillObservationsFromOpenMeteo(coordinates, obsByKey, cacheTtl);

        List<Map<String, Object>> points = new ArrayList<>(coordinates.size());
        for (double[] coord : coordinates) {
            Map<String, Object> obs = obsByKey.get(coordKey(coord[0], coord[1]));
            if (obs == null || obs.get("tempC") == null) {
                continue;
            }
            Map<String, Object> pt = new LinkedHashMap<>(obs);
            pt.put("lat", roundCoord(coord[0]));
            pt.put("lon", roundCoord(coord[1]));
            points.add(pt);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("points", points);
        result.put("cols", cols);
        result.put("rows", rows);
        result.put("source", "open-meteo");
        result.put("cacheTtlMinutes", cacheTtl.toMinutes());
        gridResponseCache.put(gridKey, new GridCacheEntry(result, Instant.now()));
        return result;
    }

    /**
     * Current temperature at arbitrary coordinates (screen grid, up to {@code maxPoints}).
     */
    public Map<String, Object> getTemperaturesForPoints(
            List<TemperatureLabelsRequestDto.Point> inputPoints, int maxPoints, String jwtSubject) {
        return getTemperaturesForPoints(inputPoints, maxPoints, jwtSubject, false);
    }

    public Map<String, Object> getTemperaturesForPoints(
            List<TemperatureLabelsRequestDto.Point> inputPoints,
            int maxPoints,
            String jwtSubject,
            boolean refresh) {
        int limit = Math.min(Math.max(inputPoints != null ? inputPoints.size() : 0, 0), maxPoints);
        List<Map<String, Object>> points = new ArrayList<>(limit);
        if (inputPoints == null || limit == 0) {
            return emptyPointsResult(points);
        }

        Duration cacheTtl = resolveCacheTtl(jwtSubject);

        List<double[]> coordinates = new ArrayList<>(limit);
        for (int i = 0; i < limit; i++) {
            TemperatureLabelsRequestDto.Point p = inputPoints.get(i);
            coordinates.add(new double[] { p.lat(), p.lon() });
            if (refresh) {
                obsCache.remove(coordKey(p.lat(), p.lon()));
            }
        }
        if (refresh) {
            gridResponseCache.clear();
        }

        Map<String, Map<String, Object>> obsByKey = new LinkedHashMap<>();
        fillObservationsFromOpenMeteo(coordinates, obsByKey, cacheTtl);

        for (double[] coord : coordinates) {
            Map<String, Object> obs = obsByKey.get(coordKey(coord[0], coord[1]));
            if (obs == null || obs.get("tempC") == null) {
                continue;
            }
            Map<String, Object> pt = new LinkedHashMap<>(obs);
            pt.put("lat", roundCoord(coord[0]));
            pt.put("lon", roundCoord(coord[1]));
            points.add(pt);
        }
        Map<String, Object> result = emptyPointsResult(points);
        if (refresh) {
            result.put("refreshed", true);
        }
        return result;
    }

    private static Map<String, Object> emptyPointsResult(List<Map<String, Object>> points) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("points", points);
        result.put("count", points.size());
        result.put("source", "open-meteo");
        return result;
    }

    @SuppressWarnings("unchecked")
    private Double fetchCurrentTemperatureC(double lat, double lon, String jwtSubject) {
        Duration cacheTtl = resolveCacheTtl(jwtSubject);
        String cacheKey = coordKey(lat, lon);
        CacheEntry cached = obsCache.get(cacheKey);
        if (cached != null && cached.isValid(cacheTtl)) {
            return cached.tempC();
        }

        Map<String, Map<String, Object>> obsByKey = new LinkedHashMap<>();
        fillObservationsFromOpenMeteo(List.of(new double[] { lat, lon }), obsByKey, cacheTtl);
        Map<String, Object> obs = obsByKey.get(cacheKey);
        if (obs == null || obs.get("tempC") == null) {
            return null;
        }
        return ((Number) obs.get("tempC")).doubleValue();
    }

    private void fillObservationsFromOpenMeteo(
            List<double[]> coordinates, Map<String, Map<String, Object>> obsByKey, Duration cacheTtl) {
        if (coordinates == null || coordinates.isEmpty()) {
            return;
        }
        List<double[]> toFetch = new ArrayList<>();
        for (double[] coord : coordinates) {
            String key = coordKey(coord[0], coord[1]);
            CacheEntry cached = obsCache.get(key);
            if (cached != null && cached.isValid(cacheTtl)) {
                Map<String, Object> fields = new LinkedHashMap<>(cached.fields());
                fields.put("cached", true);
                obsByKey.put(key, fields);
            } else {
                toFetch.add(coord);
            }
        }
        for (int i = 0; i < toFetch.size(); i += BATCH_SIZE) {
            int end = Math.min(i + BATCH_SIZE, toFetch.size());
            fetchBatchChunk(toFetch.subList(i, end), obsByKey);
        }
    }

    @SuppressWarnings("unchecked")
    private void fetchBatchChunk(List<double[]> chunk, Map<String, Map<String, Object>> obsByKey) {
        if (chunk.isEmpty()) {
            return;
        }
        StringBuilder latBuilder = new StringBuilder();
        StringBuilder lonBuilder = new StringBuilder();
        for (int i = 0; i < chunk.size(); i++) {
            if (i > 0) {
                latBuilder.append(',');
                lonBuilder.append(',');
            }
            latBuilder.append(chunk.get(i)[0]);
            lonBuilder.append(chunk.get(i)[1]);
        }

        String url = UriComponentsBuilder.fromHttpUrl(FORECAST_URL)
                .queryParam("latitude", latBuilder.toString())
                .queryParam("longitude", lonBuilder.toString())
                .queryParam("current", "temperature_2m,relative_humidity_2m,wind_speed_10m,"
                        + "wind_direction_10m,surface_pressure")
                .queryParam("timezone", "auto")
                .toUriString();

        try {
            ResponseEntity<Object> response = restTemplate.getForEntity(url, Object.class);
            parseBatchResponse(response.getBody(), chunk, obsByKey);
        } catch (Exception e) {
            log.debug("Open-Meteo batch observation fetch failed: {}", e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    private void parseBatchResponse(
            Object body, List<double[]> requested, Map<String, Map<String, Object>> obsByKey) {
        if (body instanceof List<?> list) {
            for (int i = 0; i < list.size() && i < requested.size(); i++) {
                Object item = list.get(i);
                if (item instanceof Map<?, ?> map) {
                    double[] coord = requested.get(i);
                    extractObservation(map, coord[0], coord[1], obsByKey);
                }
            }
            return;
        }
        if (body instanceof Map<?, ?> map && !requested.isEmpty()) {
            double[] coord = requested.get(0);
            extractObservation(map, coord[0], coord[1], obsByKey);
        }
    }

    private void extractObservation(
            Map<?, ?> body, double lat, double lon, Map<String, Map<String, Object>> obsByKey) {
        Object currentObj = body.get("current");
        if (!(currentObj instanceof Map<?, ?> current)) {
            return;
        }
        Object tempObj = current.get("temperature_2m");
        if (!(tempObj instanceof Number tempNum)) {
            return;
        }

        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("tempC", Math.round(tempNum.doubleValue() * 10.0) / 10.0);
        fields.put("source", "open-meteo");
        fields.put("cached", false);
        putCurrentNumber(fields, "humidityPct", current.get("relative_humidity_2m"));
        putCurrentNumber(fields, "windSpeedMs", current.get("wind_speed_10m"));
        putCurrentNumber(fields, "windDirectionDeg", current.get("wind_direction_10m"));
        putCurrentNumber(fields, "pressureHpa", current.get("surface_pressure"));
        Object observedAt = current.get("time");
        if (observedAt != null && !String.valueOf(observedAt).isBlank()) {
            fields.put("observedAt", String.valueOf(observedAt));
        }

        String cacheKey = coordKey(lat, lon);
        Map<String, Object> stored = new LinkedHashMap<>(fields);
        stored.remove("cached");
        obsCache.put(cacheKey, new CacheEntry(stored, Instant.now()));
        obsByKey.put(cacheKey, fields);
    }

    private static void putCurrentNumber(Map<String, Object> target, String key, Object raw) {
        if (raw instanceof Number number) {
            target.put(key, Math.round(number.doubleValue() * 10.0) / 10.0);
        }
    }

    private static String coordKey(double lat, double lon) {
        return roundCoord(lat) + "," + roundCoord(lon);
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private static double roundCoord(double value) {
        return Math.round(value * 100.0) / 100.0;
    }

    private Duration resolveCacheTtl(String jwtSubject) {
        return temperatureCachePreferenceService.resolveEffectiveDuration(jwtSubject);
    }

    private static String gridCacheKey(
            double south, double north, double west, double east, int cols, int rows) {
        return String.format(Locale.ROOT, "%.2f|%.2f|%.2f|%.2f|%d|%d", south, north, west, east, cols, rows);
    }

    private record CacheEntry(Map<String, Object> fields, Instant fetchedAt) {
        boolean isValid(Duration ttl) {
            Duration effectiveTtl = ttl != null ? ttl : DEFAULT_CACHE_TTL;
            return fetchedAt.plus(effectiveTtl).isAfter(Instant.now());
        }

        Double tempC() {
            Object temp = fields.get("tempC");
            return temp instanceof Number number ? number.doubleValue() : null;
        }
    }

    private record GridCacheEntry(Map<String, Object> result, Instant fetchedAt) {
        boolean isValid(Duration ttl) {
            Duration effectiveTtl = ttl != null ? ttl : DEFAULT_CACHE_TTL;
            return fetchedAt.plus(effectiveTtl).isAfter(Instant.now());
        }

        Map<String, Object> copyResult() {
            Map<String, Object> copy = new LinkedHashMap<>(result);
            copy.put("cached", true);
            return copy;
        }
    }
}
