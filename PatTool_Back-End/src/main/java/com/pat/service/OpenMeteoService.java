package com.pat.service;

import com.pat.controller.dto.TemperatureLabelsRequestDto;
import org.slf4j.Logger;import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
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

    /**
     * Current conditions at a point, normalized to an OpenWeatherMap-like payload for the UI.
     */
    public Map<String, Object> getCurrentWeatherByCoordinates(double lat, double lon, String jwtSubject) {
        Map<String, Object> result = fetchCurrentWeatherPayload(lat, lon, jwtSubject);
        if (result == null) {
            Map<String, Object> error = new LinkedHashMap<>();
            error.put("error", "Open-Meteo current weather unavailable");
            error.put("patSource", "open-meteo");
            return error;
        }
        return result;
    }

    /**
     * Hourly forecast normalized to an OpenWeatherMap-like {@code list} payload.
     */
    public Map<String, Object> getForecastByCoordinates(
            double lat, double lon, String jwtSubject, int horizonHours, int stepMinutes) {
        Map<String, Object> result = fetchForecastPayload(lat, lon, null, "open-meteo", horizonHours, stepMinutes);
        if (result == null) {
            Map<String, Object> error = new LinkedHashMap<>();
            error.put("error", "Open-Meteo forecast unavailable");
            error.put("patSource", "open-meteo");
            return error;
        }
        applyForecastWindow(result, horizonHours, stepMinutes);
        if (isForecastListEmpty(result)) {
            Map<String, Object> error = new LinkedHashMap<>();
            error.put("error", "Open-Meteo forecast empty for selected horizon and step");
            error.put("patSource", "open-meteo");
            return error;
        }
        return result;
    }

    /**
     * Hourly forecast from the Météo-France AROME seamless model via Open-Meteo.
     */
    public Map<String, Object> getMeteoFranceForecastByCoordinates(
            double lat, double lon, String jwtSubject, int horizonHours, int stepMinutes) {
        Map<String, Object> result = fetchForecastPayload(
                lat, lon, "meteofrance_seamless", "meteofrance", horizonHours, stepMinutes);
        if (result == null) {
            Map<String, Object> error = new LinkedHashMap<>();
            error.put("error", "Météo-France (Open-Meteo) forecast unavailable");
            error.put("patSource", "meteofrance");
            return error;
        }
        applyForecastWindow(result, horizonHours, stepMinutes);
        if (isForecastListEmpty(result)) {
            Map<String, Object> error = new LinkedHashMap<>();
            error.put("error", "Météo-France (Open-Meteo) forecast empty for selected horizon and step");
            error.put("patSource", "meteofrance");
            return error;
        }
        return result;
    }

    @SuppressWarnings("unchecked")
    private static boolean isForecastListEmpty(Map<String, Object> result) {
        Object listObj = result.get("list");
        return !(listObj instanceof List<?> list) || list.isEmpty();
    }

    @SuppressWarnings("unchecked")
    private static void applyForecastWindow(Map<String, Object> result, int horizonHours, int stepMinutes) {
        Object listObj = result.get("list");
        if (!(listObj instanceof List<?> rawList)) {
            return;
        }
        List<Map<String, Object>> filtered = ForecastHorizonFilter.filterList(
                (List<Map<String, Object>>) rawList, horizonHours, stepMinutes);
        result.put("list", filtered);
        result.put("count", filtered.size());
        result.put("forecastHorizonHours", MeteoFranceForecastPreferenceService.clampHorizon(horizonHours));
        result.put("forecastStepMinutes", MeteoFranceForecastPreferenceService.clampStep(stepMinutes));
    }

    private Map<String, Object> fetchForecastPayload(
            double lat, double lon, String model, String patSource, int horizonHours, int stepMinutes) {
        int step = MeteoFranceForecastPreferenceService.clampStep(stepMinutes);
        if (step < 60) {
            return fetchMinutely15ForecastPayload(lat, lon, model, patSource, horizonHours);
        }
        return fetchHourlyForecastPayload(lat, lon, model, patSource, horizonHours);
    }

    /** Clears in-memory Open-Meteo temperature caches (does not change TTL preferences). */
    public int clearTemperatureObservationCache() {
        int cleared = obsCache.size() + gridResponseCache.size();
        obsCache.clear();
        gridResponseCache.clear();
        return cleared;
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

    @SuppressWarnings("unchecked")
    private Map<String, Object> fetchCurrentWeatherPayload(double lat, double lon, String jwtSubject) {
        String url = UriComponentsBuilder.fromHttpUrl(FORECAST_URL)
                .queryParam("latitude", lat)
                .queryParam("longitude", lon)
                .queryParam("current", "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,"
                        + "wind_speed_10m,wind_direction_10m,surface_pressure")
                .queryParam("timezone", "auto")
                .toUriString();
        try {
            ResponseEntity<Object> response = restTemplate.getForEntity(url, Object.class);
            if (!(response.getBody() instanceof Map<?, ?> body)) {
                return null;
            }
            Object currentObj = body.get("current");
            if (!(currentObj instanceof Map<?, ?> current)) {
                return null;
            }
            Object tempObj = current.get("temperature_2m");
            if (!(tempObj instanceof Number tempNum)) {
                return null;
            }
            double tempC = Math.round(tempNum.doubleValue() * 10.0) / 10.0;
            Integer weatherCode = current.get("weather_code") instanceof Number codeNum
                    ? codeNum.intValue() : null;

            Map<String, Object> main = new LinkedHashMap<>();
            main.put("temp", tempC);
            if (current.get("apparent_temperature") instanceof Number feels) {
                main.put("feels_like", Math.round(feels.doubleValue() * 10.0) / 10.0);
            }
            if (current.get("relative_humidity_2m") instanceof Number humidity) {
                main.put("humidity", Math.round(humidity.doubleValue()));
            }
            if (current.get("surface_pressure") instanceof Number pressure) {
                main.put("pressure", Math.round(pressure.doubleValue()));
            }

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("patSource", "open-meteo");
            result.put("main", main);
            result.put("weather", List.of(weatherEntry(weatherCode)));
            Map<String, Object> wind = new LinkedHashMap<>();
            if (current.get("wind_speed_10m") instanceof Number speed) {
                wind.put("speed", Math.round(speed.doubleValue() * 100.0) / 100.0);
            }
            if (current.get("wind_direction_10m") instanceof Number direction) {
                wind.put("deg", Math.round(direction.doubleValue()));
            }
            if (!wind.isEmpty()) {
                result.put("wind", wind);
            }
            long dt = parseOpenMeteoTimeEpoch(current.get("time"), openMeteoZoneId(body));
            if (dt > 0) {
                result.put("dt", dt);
            }
            Object latObj = body.get("latitude");
            Object lonObj = body.get("longitude");
            if (latObj instanceof Number latN && lonObj instanceof Number lonN) {
                result.put("coord", Map.of("lat", latN.doubleValue(), "lon", lonN.doubleValue()));
            }
            return result;
        } catch (Exception e) {
            log.debug("Open-Meteo current weather fetch failed: {}", e.getMessage());
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> fetchHourlyForecastPayload(
            double lat, double lon, String model, String patSource, int horizonHours) {
        int fetchHours = Math.min(Math.max(MeteoFranceForecastPreferenceService.clampHorizon(horizonHours) + 3, 24), 384);
        UriComponentsBuilder urlBuilder = UriComponentsBuilder.fromHttpUrl(FORECAST_URL)
                .queryParam("latitude", lat)
                .queryParam("longitude", lon)
                .queryParam("hourly", "temperature_2m,weather_code,precipitation_probability,"
                        + "relative_humidity_2m,precipitation,wind_speed_10m")
                .queryParam("forecast_hours", fetchHours)
                .queryParam("timezone", "auto");
        if (model != null && !model.isBlank()) {
            urlBuilder.queryParam("models", model);
        }
        String url = urlBuilder.toUriString();
        try {
            ResponseEntity<Object> response = restTemplate.getForEntity(url, Object.class);
            if (!(response.getBody() instanceof Map<?, ?> body)) {
                return null;
            }
            Object hourlyObj = body.get("hourly");
            if (!(hourlyObj instanceof Map<?, ?> hourly)) {
                return null;
            }
            Object timesObj = hourly.get("time");
            Object tempsObj = hourly.get("temperature_2m");
            if (!(timesObj instanceof List<?> times) || !(tempsObj instanceof List<?> temps) || times.isEmpty()) {
                return null;
            }
            List<?> codes = hourly.get("weather_code") instanceof List<?> list ? list : List.of();
            List<?> pops = hourly.get("precipitation_probability") instanceof List<?> list ? list : List.of();
            List<?> humidities = hourly.get("relative_humidity_2m") instanceof List<?> list ? list : List.of();
            List<?> precips = hourly.get("precipitation") instanceof List<?> list ? list : List.of();
            List<?> winds = hourly.get("wind_speed_10m") instanceof List<?> list ? list : List.of();

            ZoneId zone = openMeteoZoneId(body);
            List<Map<String, Object>> list = new ArrayList<>();
            long nowEpoch = Instant.now().getEpochSecond();
            for (int i = 0; i < times.size(); i++) {
                long dt = parseOpenMeteoTimeEpoch(times.get(i), zone);
                if (dt <= 0 || dt < nowEpoch - 1800) {
                    continue;
                }
                Double tempC = i < temps.size() && temps.get(i) instanceof Number tempNum
                        ? Math.round(tempNum.doubleValue() * 10.0) / 10.0
                        : null;
                if (tempC == null) {
                    continue;
                }
                Integer weatherCode = i < codes.size() && codes.get(i) instanceof Number codeNum
                        ? codeNum.intValue() : null;
                Map<String, Object> main = new LinkedHashMap<>();
                main.put("temp", tempC);
                main.put("temp_min", tempC);
                main.put("temp_max", tempC);
                if (i < humidities.size() && humidities.get(i) instanceof Number humidity) {
                    main.put("humidity", Math.round(humidity.doubleValue()));
                }
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("dt", dt);
                item.put("main", main);
                item.put("weather", List.of(weatherEntry(weatherCode)));
                if (i < pops.size() && pops.get(i) instanceof Number pop) {
                    item.put("pop", Math.min(1.0, Math.max(0.0, pop.doubleValue() / 100.0)));
                }
                if (i < precips.size() && precips.get(i) instanceof Number precip) {
                    Map<String, Object> rain = new LinkedHashMap<>();
                    rain.put("1h", Math.round(precip.doubleValue() * 100.0) / 100.0);
                    item.put("rain", rain);
                }
                if (i < winds.size() && winds.get(i) instanceof Number wind) {
                    item.put("wind", Map.of("speed", Math.round(wind.doubleValue() * 100.0) / 100.0));
                }
                list.add(item);
            }
            if (list.isEmpty()) {
                return null;
            }
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("patSource", patSource);
            result.put("list", list);
            result.put("count", list.size());
            Object latObj = body.get("latitude");
            Object lonObj = body.get("longitude");
            if (latObj instanceof Number latN && lonObj instanceof Number lonN) {
                result.put("city", Map.of("coord", Map.of("lat", latN.doubleValue(), "lon", lonN.doubleValue())));
            }
            return result;
        } catch (Exception e) {
            log.debug("Open-Meteo forecast fetch failed (model={}): {}", model, e.getMessage());
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> fetchMinutely15ForecastPayload(
            double lat, double lon, String model, String patSource, int horizonHours) {
        int horizon = MeteoFranceForecastPreferenceService.clampHorizon(horizonHours);
        int forecastDays = Math.min(Math.max((horizon + 23) / 24 + 1, 1), 16);
        UriComponentsBuilder urlBuilder = UriComponentsBuilder.fromHttpUrl(FORECAST_URL)
                .queryParam("latitude", lat)
                .queryParam("longitude", lon)
                .queryParam("minutely_15", "temperature_2m,weather_code,precipitation_probability,"
                        + "relative_humidity_2m,precipitation,wind_speed_10m")
                .queryParam("forecast_days", forecastDays)
                .queryParam("timezone", "auto");
        if (model != null && !model.isBlank()) {
            urlBuilder.queryParam("models", model);
        }
        String url = urlBuilder.toUriString();
        try {
            ResponseEntity<Object> response = restTemplate.getForEntity(url, Object.class);
            if (!(response.getBody() instanceof Map<?, ?> body)) {
                return null;
            }
            Object minutelyObj = body.get("minutely_15");
            if (!(minutelyObj instanceof Map<?, ?> minutely)) {
                return null;
            }
            Object timesObj = minutely.get("time");
            Object tempsObj = minutely.get("temperature_2m");
            if (!(timesObj instanceof List<?> times) || !(tempsObj instanceof List<?> temps) || times.isEmpty()) {
                return null;
            }
            List<?> codes = minutely.get("weather_code") instanceof List<?> list ? list : List.of();
            List<?> pops = minutely.get("precipitation_probability") instanceof List<?> list ? list : List.of();
            List<?> humidities = minutely.get("relative_humidity_2m") instanceof List<?> list ? list : List.of();
            List<?> precips = minutely.get("precipitation") instanceof List<?> list ? list : List.of();
            List<?> winds = minutely.get("wind_speed_10m") instanceof List<?> list ? list : List.of();

            ZoneId zone = openMeteoZoneId(body);
            List<Map<String, Object>> list = new ArrayList<>();
            long nowEpoch = Instant.now().getEpochSecond();
            for (int i = 0; i < times.size(); i++) {
                long dt = parseOpenMeteoTimeEpoch(times.get(i), zone);
                if (dt <= 0 || dt < nowEpoch - 900) {
                    continue;
                }
                Double tempC = i < temps.size() && temps.get(i) instanceof Number tempNum
                        ? Math.round(tempNum.doubleValue() * 10.0) / 10.0
                        : null;
                if (tempC == null) {
                    continue;
                }
                Integer weatherCode = i < codes.size() && codes.get(i) instanceof Number codeNum
                        ? codeNum.intValue() : null;
                Map<String, Object> main = new LinkedHashMap<>();
                main.put("temp", tempC);
                main.put("temp_min", tempC);
                main.put("temp_max", tempC);
                if (i < humidities.size() && humidities.get(i) instanceof Number humidity) {
                    main.put("humidity", Math.round(humidity.doubleValue()));
                }
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("dt", dt);
                item.put("main", main);
                item.put("weather", List.of(weatherEntry(weatherCode)));
                if (i < pops.size() && pops.get(i) instanceof Number pop) {
                    item.put("pop", Math.min(1.0, Math.max(0.0, pop.doubleValue() / 100.0)));
                }
                if (i < precips.size() && precips.get(i) instanceof Number precip) {
                    Map<String, Object> rain = new LinkedHashMap<>();
                    rain.put("1h", Math.round(precip.doubleValue() * 100.0) / 100.0);
                    item.put("rain", rain);
                }
                if (i < winds.size() && winds.get(i) instanceof Number wind) {
                    item.put("wind", Map.of("speed", Math.round(wind.doubleValue() * 100.0) / 100.0));
                }
                list.add(item);
            }
            if (list.isEmpty()) {
                return null;
            }
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("patSource", patSource);
            result.put("list", list);
            result.put("count", list.size());
            Object latObj = body.get("latitude");
            Object lonObj = body.get("longitude");
            if (latObj instanceof Number latN && lonObj instanceof Number lonN) {
                result.put("city", Map.of("coord", Map.of("lat", latN.doubleValue(), "lon", lonN.doubleValue())));
            }
            return result;
        } catch (Exception e) {
            log.debug("Open-Meteo minutely_15 forecast fetch failed (model={}): {}", model, e.getMessage());
            return null;
        }
    }

    private static Map<String, Object> weatherEntry(Integer weatherCode) {
        Map<String, Object> weather = new LinkedHashMap<>();
        weather.put("description", weatherCodeDescription(weatherCode));
        weather.put("icon", weatherCodeToOwmIcon(weatherCode));
        return weather;
    }

    private static ZoneId openMeteoZoneId(Map<?, ?> body) {
        if (body == null) {
            return ZoneId.of("UTC");
        }
        Object tz = body.get("timezone");
        if (tz == null || String.valueOf(tz).isBlank()) {
            return ZoneId.of("UTC");
        }
        try {
            return ZoneId.of(String.valueOf(tz).trim());
        } catch (Exception ignored) {
            return ZoneId.of("UTC");
        }
    }

    private static long parseOpenMeteoTimeEpoch(Object raw, ZoneId zone) {
        if (raw == null) {
            return 0;
        }
        String text = String.valueOf(raw).trim();
        if (text.isEmpty()) {
            return 0;
        }
        ZoneId effectiveZone = zone != null ? zone : ZoneId.of("UTC");
        try {
            return OffsetDateTime.parse(text).toInstant().getEpochSecond();
        } catch (DateTimeParseException ignored) {
            // Open-Meteo with timezone=auto returns local times without offset (e.g. 2026-07-01T20:00).
        }
        try {
            return LocalDateTime.parse(text).atZone(effectiveZone).toInstant().getEpochSecond();
        } catch (DateTimeParseException ignored) {
            return 0;
        }
    }

    private static String weatherCodeDescription(Integer code) {
        if (code == null) {
            return "Conditions actuelles";
        }
        return switch (code) {
            case 0 -> "ciel dégagé";
            case 1 -> "principalement dégagé";
            case 2 -> "partiellement nuageux";
            case 3 -> "nuageux";
            case 45, 48 -> "brouillard";
            case 51, 53, 55 -> "bruine";
            case 56, 57 -> "bruine verglaçante";
            case 61, 63, 65 -> "pluie";
            case 66, 67 -> "pluie verglaçante";
            case 71, 73, 75 -> "neige";
            case 77 -> "grains de neige";
            case 80, 81, 82 -> "averses";
            case 85, 86 -> "averses de neige";
            case 95 -> "orage";
            case 96, 99 -> "orage avec grêle";
            default -> "conditions variables";
        };
    }

    private static String weatherCodeToOwmIcon(Integer code) {
        if (code == null) {
            return "03d";
        }
        return switch (code) {
            case 0 -> "01d";
            case 1 -> "02d";
            case 2 -> "03d";
            case 3 -> "04d";
            case 45, 48 -> "50d";
            case 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82 -> "10d";
            case 71, 73, 75, 77, 85, 86 -> "13d";
            case 95, 96, 99 -> "11d";
            default -> "03d";
        };
    }
}
