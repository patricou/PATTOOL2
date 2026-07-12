package com.pat.controller;

import com.pat.controller.dto.MeteoFranceAromepiPlaybackPreferenceDto;
import com.pat.controller.dto.MeteoFranceHistoryCachePreferenceDto;
import com.pat.controller.dto.MeteoFranceForecastPreferenceDto;
import com.pat.controller.dto.MeteoFranceRadarPreferenceDto;
import com.pat.controller.dto.MeteoFranceTemperatureCachePreferenceDto;
import com.pat.controller.dto.TemperatureLabelsRequestDto;
import com.pat.controller.dto.TraceViewerPreferenceDto;
import com.pat.service.GeocodeService;
import com.pat.service.IpGeolocationService;
import com.pat.service.MeteoFranceAromepiService;
import com.pat.service.MeteoFranceClimService;
import com.pat.service.MeteoFranceAromepiPlaybackPreferenceService;
import com.pat.service.MeteoFranceHistoryCachePreferenceService;
import com.pat.service.MeteoFranceObsService;
import com.pat.service.MeteoFranceForecastPreferenceService;
import com.pat.service.MeteoFranceRadarRefreshPreferenceService;
import com.pat.service.MeteoFranceRadarService;
import com.pat.service.MeteoFranceTemperatureCachePreferenceService;
import com.pat.service.MeteoSwissForecastService;
import com.pat.service.MeteoSwissObsService;
import com.pat.service.TraceViewerPreferenceService;
import com.pat.service.OpenMeteoService;
import com.pat.service.OpenWeatherService;
import com.pat.service.WeatherForecastAggregationService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/external")
public class ApiController {

    private static final Logger log = LoggerFactory.getLogger(ApiController.class);

    @Autowired
    private OpenWeatherService openWeatherService;

    @Autowired
    private OpenMeteoService openMeteoService;

    @Autowired
    private WeatherForecastAggregationService weatherForecastAggregationService;

    @Autowired
    private GeocodeService geocodeService;

    @Autowired
    private IpGeolocationService ipGeolocationService;

    @Autowired
    private MeteoFranceRadarService meteoFranceRadarService;

    @Autowired
    private MeteoFranceClimService meteoFranceClimService;

    @Autowired
    private MeteoFranceObsService meteoFranceObsService;

    @Autowired
    private MeteoFranceAromepiService meteoFranceAromepiService;

    @Autowired
    private MeteoSwissForecastService meteoSwissForecastService;

    @Autowired
    private MeteoSwissObsService meteoSwissObsService;

    @Autowired
    private MeteoFranceRadarRefreshPreferenceService meteoFranceRadarRefreshPreferenceService;

    @Autowired
    private MeteoFranceForecastPreferenceService meteoFranceForecastPreferenceService;

    @Autowired
    private MeteoFranceTemperatureCachePreferenceService meteoFranceTemperatureCachePreferenceService;

    @Autowired
    private MeteoFranceHistoryCachePreferenceService meteoFranceHistoryCachePreferenceService;

    @Autowired
    private MeteoFranceAromepiPlaybackPreferenceService meteoFranceAromepiPlaybackPreferenceService;

    @Autowired
    private TraceViewerPreferenceService traceViewerPreferenceService;

    @Value("${thunderforest.api.key:}")
    private String thunderforestApiKey;

    @Value("${ign.api.key:}")
    private String ignApiKey;

    /**
     * Get current weather data for a city
     * @param city City name (required)
     * @param countryCode Optional country code (e.g., "FR", "US")
     * @return Current weather data
     */
    @GetMapping(value = "/weather/current", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getCurrentWeather(
            @RequestParam("city") String city,
            @RequestParam(value = "countryCode", required = false) String countryCode) {
        log.debug("Fetching current weather for city: {}, countryCode: {}", city, countryCode);
        return openWeatherService.getCurrentWeather(city, countryCode);
    }

    /**
     * Get current weather data by coordinates
     * @param lat Latitude (required)
     * @param lon Longitude (required)
     * @param alt Optional altitude in meters
     * @return Current weather data
     */
    @GetMapping(value = "/weather/current/coordinates", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getCurrentWeatherByCoordinates(
            @RequestParam("lat") Double lat,
            @RequestParam("lon") Double lon,
            @RequestParam(value = "alt", required = false) Double alt,
            @RequestParam(value = "source", defaultValue = "openweathermap") String source) {
        log.debug("Fetching current weather for coordinates: lat={}, lon={}, alt={}, source={}", lat, lon, alt, source);
        return resolveCurrentWeatherByCoordinates(lat, lon, alt, source, currentJwtSubject());
    }

    /**
     * Get 5-day weather forecast for a city
     * @param city City name (required)
     * @param countryCode Optional country code
     * @return Forecast data
     */
    @GetMapping(value = "/weather/forecast", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getForecast(
            @RequestParam("city") String city,
            @RequestParam(value = "countryCode", required = false) String countryCode) {
        log.debug("Fetching forecast for city: {}, countryCode: {}", city, countryCode);
        Map<String, Object> result = openWeatherService.getForecast(city, countryCode);
        
        // If city not found, return a more user-friendly error message
        if (result.containsKey("error")) {
            String error = (String) result.get("error");
            if (error != null && error.contains("City not found")) {
                log.warn("Forecast not found for city: {} (countryCode: {}). Consider using coordinates instead.", city, countryCode);
            }
        }
        
        return result;
    }

    /**
     * Get 5-day weather forecast by coordinates
     * @param lat Latitude (required)
     * @param lon Longitude (required)
     * @param alt Optional altitude in meters
     * @return Forecast data
     */
    @GetMapping(value = "/weather/forecast/coordinates", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getForecastByCoordinates(
            @RequestParam("lat") Double lat,
            @RequestParam("lon") Double lon,
            @RequestParam(value = "alt", required = false) Double alt,
            @RequestParam(value = "source", defaultValue = "openweathermap") String source,
            @RequestParam(value = "horizonHours", required = false) Integer horizonHours,
            @RequestParam(value = "stepMinutes", required = false) Integer stepMinutes,
            @RequestParam(value = "stepHours", required = false) Integer stepHours) {
        log.debug("Fetching forecast for coordinates: lat={}, lon={}, alt={}, source={}", lat, lon, alt, source);
        String jwtSubject = currentJwtSubject();
        int horizon = horizonHours != null
                ? MeteoFranceForecastPreferenceService.clampHorizon(horizonHours)
                : meteoFranceForecastPreferenceService.resolveHorizonHours(jwtSubject);
        int step = resolveStepMinutesParam(stepMinutes, stepHours, jwtSubject);
        return resolveForecastByCoordinates(lat, lon, source, jwtSubject, horizon, step);
    }

    /**
     * Aggregated forecast comparing OpenWeatherMap, Open-Meteo and Météo-France (seamless via Open-Meteo).
     */
    @GetMapping(value = "/weather/forecast/aggregated", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getAggregatedForecast(
            @RequestParam("lat") Double lat,
            @RequestParam("lon") Double lon,
            @RequestParam(value = "horizonHours", required = false) Integer horizonHours,
            @RequestParam(value = "stepMinutes", required = false) Integer stepMinutes,
            @RequestParam(value = "stepHours", required = false) Integer stepHours) {
        log.debug("Fetching aggregated forecast for lat={}, lon={}", lat, lon);
        String jwtSubject = currentJwtSubject();
        int horizon = horizonHours != null
                ? MeteoFranceForecastPreferenceService.clampHorizon(horizonHours)
                : meteoFranceForecastPreferenceService.resolveHorizonHours(jwtSubject);
        int step = resolveStepMinutesParam(stepMinutes, stepHours, jwtSubject);
        return weatherForecastAggregationService.getAggregatedForecast(lat, lon, jwtSubject, horizon, step);
    }

    /**
     * SSE stream: emits each forecast source (OWM, Open-Meteo, MF) as soon as it is fetched.
     */
    @GetMapping(value = "/weather/forecast/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamForecastSources(
            @RequestParam("lat") Double lat,
            @RequestParam("lon") Double lon,
            @RequestParam(value = "horizonHours", required = false) Integer horizonHours,
            @RequestParam(value = "stepMinutes", required = false) Integer stepMinutes,
            @RequestParam(value = "stepHours", required = false) Integer stepHours) {
        SseEmitter emitter = new SseEmitter(300_000L);
        String jwtSubject = currentJwtSubject();
        int horizon = horizonHours != null
                ? MeteoFranceForecastPreferenceService.clampHorizon(horizonHours)
                : meteoFranceForecastPreferenceService.resolveHorizonHours(jwtSubject);
        int step = resolveStepMinutesParam(stepMinutes, stepHours, jwtSubject);
        java.util.concurrent.atomic.AtomicBoolean alive = new java.util.concurrent.atomic.AtomicBoolean(true);

        emitter.onCompletion(() -> alive.set(false));
        emitter.onTimeout(() -> alive.set(false));
        emitter.onError((ex) -> alive.set(false));

        weatherForecastAggregationService.streamForecastSources(
                lat,
                lon,
                jwtSubject,
                horizon,
                step,
                event -> {
                    if (!alive.get()) {
                        return;
                    }
                    try {
                        String source = String.valueOf(event.getOrDefault("source", "source"));
                        emitter.send(SseEmitter.event().name(source).data(event));
                    } catch (IOException ex) {
                        alive.set(false);
                        log.debug("Forecast SSE client disconnected: {}", ex.getMessage());
                    }
                },
                () -> {
                    if (!alive.get()) {
                        return;
                    }
                    try {
                        emitter.send(SseEmitter.event().name("complete").data(""));
                        emitter.complete();
                    } catch (IOException ex) {
                        log.debug("Forecast SSE complete failed: {}", ex.getMessage());
                        emitter.complete();
                    }
                });
        return emitter;
    }

    /** MeteoSwiss Open Data cache status (forecast + precip map readiness). */
    @GetMapping(value = "/meteoswiss/status", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoSwissStatus() {
        return meteoSwissForecastService.getStatus();
    }

    /** MeteoSwiss hourly precipitation map animation — frame list and bounds. */
    @GetMapping(value = "/meteoswiss/precip/capabilities", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoSwissPrecipMapCapabilities(
            @RequestParam(value = "horizonHours", required = false) Integer horizonHours) {
        String jwtSubject = currentJwtSubject();
        int horizon = horizonHours != null
                ? MeteoFranceForecastPreferenceService.clampHorizon(horizonHours)
                : meteoFranceForecastPreferenceService.resolveHorizonHours(jwtSubject);
        return meteoSwissForecastService.getPrecipMapCapabilities(horizon);
    }

    /** MeteoSwiss precipitation raster PNG for one forecast hour (epoch seconds UTC). */
    @GetMapping(value = "/meteoswiss/precip/frame.png", produces = MediaType.IMAGE_PNG_VALUE)
    public ResponseEntity<byte[]> getMeteoSwissPrecipMapFrame(@RequestParam("dt") Long dt) {
        if (dt == null || dt <= 0) {
            return ResponseEntity.badRequest().build();
        }
        byte[] png = meteoSwissForecastService.getPrecipMapFramePng(dt);
        if (png == null || png.length == 0) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok()
                .cacheControl(org.springframework.http.CacheControl.maxAge(300, java.util.concurrent.TimeUnit.SECONDS))
                .body(png);
    }

    /** Per-user multi-day forecast horizon and step (MongoDB appParameters). */
    @GetMapping(value = "/meteofrance/forecast/preferences", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<MeteoFranceForecastPreferenceDto> getMeteoFranceForecastPreferences() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(meteoFranceForecastPreferenceService.readForSubject(sub));
    }

    @PutMapping(value = "/meteofrance/forecast/preferences", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> setMeteoFranceForecastPreferences(
            @RequestBody MeteoFranceForecastPreferenceDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (!hasAdminRole()) {
            return adminForbidden();
        }
        if (body == null) {
            return ResponseEntity.badRequest().build();
        }
        try {
            MeteoFranceForecastPreferenceDto saved = meteoFranceForecastPreferenceService.saveForSubject(
                    sub, body.forecastHorizonHours(), body.forecastStepMinutes());
            return ResponseEntity.ok(saved);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        }
    }

    private Map<String, Object> resolveCurrentWeatherByCoordinates(
            Double lat, Double lon, Double alt, String source, String jwtSubject) {
        return switch (normalizeWeatherSource(source)) {
            case "open-meteo" -> openMeteoService.getCurrentWeatherByCoordinates(lat, lon, jwtSubject);
            case "meteofrance" -> meteoFranceObsService.getCurrentWeatherByCoordinates(lat, lon, jwtSubject);
            default -> tagOpenWeatherSource(openWeatherService.getCurrentWeatherByCoordinates(lat, lon, alt));
        };
    }

    private Map<String, Object> resolveForecastByCoordinates(
            Double lat, Double lon, String source, String jwtSubject, int horizonHours, int stepMinutes) {
        return switch (normalizeWeatherSource(source)) {
            case "open-meteo" -> openMeteoService.getForecastByCoordinates(
                    lat, lon, jwtSubject, horizonHours, stepMinutes);
            case "meteofrance" -> meteoFranceObsService.getForecastByCoordinates(lat, lon, jwtSubject);
            case "meteoswiss" -> meteoSwissForecastService.getForecastByCoordinates(
                    lat, lon, horizonHours, stepMinutes);
            default -> tagOpenWeatherSource(openWeatherService.getForecastByCoordinates(
                    lat, lon, null, horizonHours, stepMinutes));
        };
    }

    private int resolveStepMinutesParam(Integer stepMinutes, Integer stepHours, String jwtSubject) {
        if (stepMinutes != null) {
            return MeteoFranceForecastPreferenceService.clampStep(stepMinutes);
        }
        if (stepHours != null) {
            return MeteoFranceForecastPreferenceService.clampStep(stepHours * 60);
        }
        return meteoFranceForecastPreferenceService.resolveStepMinutes(jwtSubject);
    }

    private static String normalizeWeatherSource(String source) {
        if (source == null || source.isBlank()) {
            return "openweathermap";
        }
        String normalized = source.trim().toLowerCase();
        if ("open-meteo".equals(normalized) || "openmeteo".equals(normalized)) {
            return "open-meteo";
        }
        if ("meteofrance".equals(normalized) || "mf".equals(normalized) || normalized.contains("meteofrance")) {
            return "meteofrance";
        }
        if ("meteoswiss".equals(normalized) || "meteo-swiss".equals(normalized) || "meteoschweiz".equals(normalized)) {
            return "meteoswiss";
        }
        return "openweathermap";
    }

    private static Map<String, Object> tagOpenWeatherSource(Map<String, Object> payload) {
        if (payload != null && !payload.containsKey("error")) {
            payload.put("patSource", "openweathermap");
        }
        return payload;
    }


    /**
     * Get all available altitudes for coordinates with their sources
     * Returns all altitudes that can be obtained (mobile, Nominatim, OpenElevation)
     * @param lat Latitude (required)
     * @param lon Longitude (required)
     * @param alt Optional altitude from mobile device (in meters)
     * @return List of all available altitudes with their sources
     */
    @GetMapping(value = "/weather/altitudes", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getAllAltitudes(
            @RequestParam("lat") Double lat,
            @RequestParam("lon") Double lon,
            @RequestParam(value = "alt", required = false) Double alt) {
        log.debug("Fetching all altitudes for coordinates: lat={}, lon={}, alt={}", lat, lon, alt);
        return openWeatherService.getAllAltitudesWithSources(lat, lon, alt);
    }

    /**
     * Cached sea-level elevation (m) for a coordinate — used for weather-station tooltips.
     */
    @GetMapping(value = "/weather/elevation", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getElevation(
            @RequestParam("lat") Double lat,
            @RequestParam("lon") Double lon) {
        log.debug("Fetching elevation for coordinates: lat={}, lon={}", lat, lon);
        return openWeatherService.getSeaLevelElevationForCoordinates(lat, lon);
    }

    /**
     * Test endpoint to check API configuration
     * @return Status information
     */
    @GetMapping(value = "/weather/status", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getApiStatus() {
        Map<String, Object> status = new HashMap<>();
        status.put("service", "OpenWeatherMap API");
        status.put("status", "available");
        status.put("configured", openWeatherService.isApiKeyConfigured());
        status.put("endpoints", new String[]{
            "/api/external/weather/current",
            "/api/external/weather/current/coordinates",
            "/api/external/weather/forecast",
            "/api/external/weather/forecast/coordinates",
            "/api/external/weather/altitudes",
            "/api/external/weather/elevation",
            "/api/external/weather/map/temperature/{z}/{x}/{y}",
            "/api/external/weather/map/clouds/{z}/{x}/{y}"
        });
        return status;
    }

    /**
     * OpenWeatherMap cloud cover map tile proxy (PNG). Avoids exposing the API key to the browser.
     */
    @GetMapping(value = "/weather/map/clouds/{z}/{x}/{y}", produces = MediaType.IMAGE_PNG_VALUE)
    public ResponseEntity<byte[]> getOpenWeatherCloudMapTile(
            @PathVariable("z") int z,
            @PathVariable("x") int x,
            @PathVariable("y") int y,
            @RequestParam(value = "enhance", defaultValue = "1.5") float enhance) {
        return openWeatherService.getCloudMapTile(z, x, y, enhance);
    }

    /**
     * OpenWeatherMap temperature map tile proxy (PNG). Avoids exposing the API key to the browser.
     */
    @GetMapping(value = "/weather/map/temperature/{z}/{x}/{y}", produces = MediaType.IMAGE_PNG_VALUE)
    public ResponseEntity<byte[]> getOpenWeatherTemperatureMapTile(
            @PathVariable("z") int z,
            @PathVariable("x") int x,
            @PathVariable("y") int y) {
        return openWeatherService.getTemperatureMapTile(z, x, y);
    }

    /**
     * Current temperatures on a lat/lon grid (numeric labels for the map).
     * Prefers Météo-France DPObs station observations; falls back to Open-Meteo when DPObs is not configured.
     */
    @GetMapping(value = "/weather/map/temperature-labels", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getTemperatureLabelGrid(
            @RequestParam("minLat") double minLat,
            @RequestParam("maxLat") double maxLat,
            @RequestParam("minLon") double minLon,
            @RequestParam("maxLon") double maxLon,
            @RequestParam(value = "cols", defaultValue = "5") int cols,
            @RequestParam(value = "rows", defaultValue = "5") int rows,
            @RequestParam(value = "maxStations", defaultValue = "0") int maxStationsParam,
            @RequestParam(value = "source", defaultValue = "meteofrance") String sourceParam) {
        String jwtSubject = currentJwtSubject();
        if ("open-meteo".equalsIgnoreCase(sourceParam)) {
            Map<String, Object> openMeteo = openMeteoService.getTemperatureLabelGrid(
                    minLat, maxLat, minLon, maxLon, cols, rows, jwtSubject);
            openMeteo.put("source", "open-meteo");
            return openMeteo;
        }
        if ("openweathermap".equalsIgnoreCase(sourceParam)) {
            Map<String, Object> empty = new LinkedHashMap<>();
            empty.put("source", "openweathermap");
            empty.put("points", List.of());
            empty.put("count", 0);
            return empty;
        }
        int maxStations = maxStationsParam > 0
                ? maxStationsParam
                : Math.max(4, cols * rows);
        Map<String, Object> mf = meteoFranceObsService.getTemperatureLabelsInBounds(
                minLat, maxLat, minLon, maxLon, maxStations, jwtSubject);
        if (mf != null && !mf.containsKey("error") && hasTemperaturePoints(mf)) {
            return mf;
        }
        if (mf != null && mf.containsKey("error")) {
            return mf;
        }
        Map<String, Object> empty = new LinkedHashMap<>();
        empty.put("source", "meteofrance-dpobs");
        empty.put("points", List.of());
        empty.put("count", 0);
        return empty;
    }

    private static boolean hasTemperaturePoints(Map<String, Object> payload) {
        if (payload == null) {
            return false;
        }
        Object points = payload.get("points");
        return points instanceof List<?> list && !list.isEmpty();
    }

    private static final int MAX_TEMPERATURE_GRID_POINTS = 450;

    /**
     * Dense screen grid (~1 cm spacing): list of lat/lon points → temperatures (MF IDW + Open-Meteo fill).
     */
    @PostMapping(value = "/weather/map/temperature-labels", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> postTemperatureLabelGrid(@RequestBody TemperatureLabelsRequestDto body) {
        if (body == null || body.points() == null || body.points().isEmpty()) {
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("error", "points required");
            return err;
        }
        List<TemperatureLabelsRequestDto.Point> points = body.points().size() > MAX_TEMPERATURE_GRID_POINTS
                ? body.points().subList(0, MAX_TEMPERATURE_GRID_POINTS)
                : body.points();
        return resolveTemperatureLabelsForPoints(points, body.source(), body.refreshRequested(), currentJwtSubject());
    }

    private Map<String, Object> resolveTemperatureLabelsForPoints(
            List<TemperatureLabelsRequestDto.Point> points,
            String sourceParam,
            boolean refresh,
            String jwtSubject) {
        if ("open-meteo".equalsIgnoreCase(sourceParam)) {
            Map<String, Object> om = openMeteoService.getTemperaturesForPoints(
                    points, MAX_TEMPERATURE_GRID_POINTS, jwtSubject, refresh);
            om.put("source", "open-meteo");
            return om;
        }

        if ("meteoswiss".equalsIgnoreCase(sourceParam)) {
            if (refresh) {
                return meteoSwissObsService.refreshTemperaturePoints(points);
            }
            return meteoSwissObsService.getTemperatureLabelsForPoints(points);
        }

        boolean mfSource = sourceParam == null
                || sourceParam.isBlank()
                || "meteofrance".equalsIgnoreCase(sourceParam);
        if (refresh && mfSource && meteoFranceObsService.isConfigured()) {
            return meteoFranceObsService.refreshTemperaturePoints(points, jwtSubject);
        }

        Map<String, Map<String, Object>> pointByKey = new LinkedHashMap<>();
        String source = "open-meteo";

        if (meteoFranceObsService.isConfigured()) {
            Map<String, Object> mf = meteoFranceObsService.interpolateTemperatureLabels(
                    points, MAX_TEMPERATURE_GRID_POINTS, jwtSubject);
            if (mf != null && !mf.containsKey("error")) {
                source = String.valueOf(mf.getOrDefault("source", "meteofrance-dpobs"));
                mergeFullPointsInto(pointByKey, mf);
            }
        }

        List<TemperatureLabelsRequestDto.Point> missing = new ArrayList<>();
        for (TemperatureLabelsRequestDto.Point p : points) {
            if (!pointByKey.containsKey(coordKey(p.lat(), p.lon()))) {
                missing.add(p);
            }
        }

        if (!missing.isEmpty()) {
            Map<String, Object> om = openMeteoService.getTemperaturesForPoints(
                    missing, MAX_TEMPERATURE_GRID_POINTS, jwtSubject, refresh);
            mergeFullPointsInto(pointByKey, om);
            if ("open-meteo".equals(source) && pointByKey.isEmpty()) {
                source = "open-meteo";
            } else if (!missing.isEmpty() && !pointByKey.isEmpty()) {
                source = meteoFranceObsService.isConfigured() ? "meteofrance-dpobs+open-meteo" : "open-meteo";
            }
        }

        List<Map<String, Object>> outPoints = new ArrayList<>();
        for (TemperatureLabelsRequestDto.Point p : points) {
            Map<String, Object> point = pointByKey.get(coordKey(p.lat(), p.lon()));
            if (point == null || point.get("tempC") == null) {
                continue;
            }
            outPoints.add(point);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("source", source);
        result.put("points", outPoints);
        result.put("count", outPoints.size());
        result.put("requested", points.size());
        return result;
    }

    @SuppressWarnings("unchecked")
    private static void mergeFullPointsInto(Map<String, Map<String, Object>> pointByKey, Map<String, Object> payload) {
        if (payload == null) {
            return;
        }
        Object raw = payload.get("points");
        if (!(raw instanceof List<?> list)) {
            return;
        }
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> map)) {
                continue;
            }
            Object lat = map.get("lat");
            Object lon = map.get("lon");
            Object temp = map.get("tempC");
            if (!(lat instanceof Number latN) || !(lon instanceof Number lonN) || !(temp instanceof Number)) {
                continue;
            }
            String key = coordKey(latN.doubleValue(), lonN.doubleValue());
            if (pointByKey.containsKey(key)) {
                continue;
            }
            Map<String, Object> copy = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (entry.getKey() != null && entry.getValue() != null) {
                    copy.put(String.valueOf(entry.getKey()), entry.getValue());
                }
            }
            pointByKey.put(key, copy);
        }
    }

    private static String coordKey(double lat, double lon) {
        return Math.round(lat * 10000.0) / 10000.0 + "," + Math.round(lon * 10000.0) / 10000.0;
    }

    private static boolean isUsableTemperatureLabelResponse(Map<String, Object> body) {
        if (body == null || body.containsKey("error")) {
            return false;
        }
        Object raw = body.get("points");
        if (raw instanceof List<?> list) {
            return !list.isEmpty();
        }
        return false;
    }

    /**
     * Météo-France DPObs station temperatures visible on the map (same data as temperature-labels when configured).
     */
    @GetMapping(value = "/meteofrance/obs/temperature-labels", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoFranceObsTemperatureLabels(
            @RequestParam("minLat") double minLat,
            @RequestParam("maxLat") double maxLat,
            @RequestParam("minLon") double minLon,
            @RequestParam("maxLon") double maxLon,
            @RequestParam(value = "maxStations", defaultValue = "24") int maxStations) {
        return meteoFranceObsService.getTemperatureLabelsInBounds(
                minLat, maxLat, minLon, maxLon, maxStations, currentJwtSubject());
    }

    /**
     * MeteoSwiss SwissMetNet station temperatures visible on the map (ogd-smn, open data).
     */
    @GetMapping(value = "/meteoswiss/obs/temperature-labels", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoSwissObsTemperatureLabels(
            @RequestParam("minLat") double minLat,
            @RequestParam("maxLat") double maxLat,
            @RequestParam("minLon") double minLon,
            @RequestParam("maxLon") double maxLon,
            @RequestParam(value = "maxStations", defaultValue = "24") int maxStations) {
        return meteoSwissObsService.getTemperatureLabelsInBounds(
                minLat, maxLat, minLon, maxLon, maxStations);
    }

    /**
     * Nearest MeteoSwiss SMN station + hourly archived observations for a map point (timeline modal).
     */
    @GetMapping(value = "/meteoswiss/obs/history/nearby", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoSwissHistoryNearby(
            @RequestParam("lat") double lat,
            @RequestParam("lon") double lon,
            @RequestParam(value = "days", defaultValue = "7") int days,
            @RequestParam(value = "stationId", required = false) String stationId,
            @RequestParam(value = "refresh", defaultValue = "false") boolean refresh) {
        return meteoSwissObsService.getNearbyHourlyHistory(
                lat, lon, days, stationId, refresh, currentJwtSubject());
    }

    /** Clears server-side MeteoSwiss SMN hourly history cache. */
    @PostMapping(value = "/meteoswiss/obs/history/cache/clear", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> clearMeteoSwissHistoryCache() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("cleared", true);
        result.put("cacheEntries", meteoSwissObsService.clearHistoryCache());
        return result;
    }

    /**
     * Nearest Météo-France DPObs v2 observation station for a map point.
     */
    @GetMapping(value = "/meteofrance/obs/nearest-station", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoFranceNearestObsStation(
            @RequestParam("lat") double lat,
            @RequestParam("lon") double lon) {
        return meteoFranceObsService.getNearestStationInfo(lat, lon);
    }

    /**
     * Get Thunderforest API key for map tiles
     * @return API key
     */
    @GetMapping(value = "/thunderforest/apikey", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getThunderforestApiKey() {
        Map<String, Object> result = new HashMap<>();
        result.put("apiKey", thunderforestApiKey != null && !thunderforestApiKey.isEmpty() ? thunderforestApiKey : "");
        return result;
    }

    /**
     * Get IGN API key for map tiles
     * @return API key
     */
    @GetMapping(value = "/ign/apikey", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getIgnApiKey() {
        Map<String, Object> result = new HashMap<>();
        result.put("apiKey", ignApiKey != null && !ignApiKey.isEmpty() ? ignApiKey : "");
        return result;
    }

    /**
     * Geocode: address query → list of results (lat, lon, displayName, address).
     * Proxies to Nominatim (OpenStreetMap).
     */
    @GetMapping(value = "/geocode/search", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<Map<String, Object>> geocodeSearch(@RequestParam("q") String query) {
        log.debug("Geocode search: q={}", query);
        return geocodeService.search(query);
    }

    /**
     * Reverse geocode: (lat, lon) → display name.
     * Proxies to Nominatim (OpenStreetMap).
     */
    @GetMapping(value = "/geocode/reverse", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> geocodeReverse(
            @RequestParam("lat") Double lat,
            @RequestParam("lon") Double lon) {
        log.debug("Geocode reverse: lat={}, lon={}", lat, lon);
        return geocodeService.reverse(lat, lon);
    }

    /**
     * Get approximate location (lat, lon) from client IP.
     * Proxies to ip-api.com via IpGeolocationService.
     */
    @GetMapping(value = "/geocode/location-by-ip", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getLocationByIp(HttpServletRequest request) {
        String ipAddress = request.getHeader("X-Forwarded-For");
        if (ipAddress == null || ipAddress.trim().isEmpty()) {
            ipAddress = request.getRemoteAddr();
        } else {
            int comma = ipAddress.indexOf(',');
            if (comma > 0) {
                ipAddress = ipAddress.substring(0, comma).trim();
            }
        }
        log.debug("Location by IP: client ip={}", ipAddress);
        IpGeolocationService.CoordinatesInfo coords = ipGeolocationService.getCoordinates(ipAddress);
        Map<String, Object> result = new HashMap<>();
        if (coords != null && coords.getLatitude() != null && coords.getLongitude() != null) {
            result.put("status", "success");
            result.put("lat", coords.getLatitude());
            result.put("lon", coords.getLongitude());
        } else {
            result.put("status", "fail");
        }
        return result;
    }

    /**
     * Météo-France radar / DPRadar configuration status.
     */
    @GetMapping(value = "/meteofrance/status", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoFranceStatus() {
        Map<String, Object> status = new LinkedHashMap<>(meteoFranceRadarService.getStatus(currentJwtSubject()));
        status.putAll(meteoFranceClimService.getStatusFragment());
        status.putAll(meteoFranceObsService.getStatusFragment());
        status.putAll(meteoFranceAromepiService.getStatusFragment());
        status.putAll(meteoSwissObsService.getStatusFragment());
        status.put("openWeatherConfigured", openWeatherService.isApiKeyConfigured());
        return status;
    }

    /** Per-user temperature observation cache TTL (MongoDB appParameters). */
    @GetMapping(value = "/meteofrance/temperature/cache/preferences", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<MeteoFranceTemperatureCachePreferenceDto> getMeteoFranceTemperatureCachePreferences() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(meteoFranceTemperatureCachePreferenceService.readForSubject(sub));
    }

    @PutMapping(value = "/meteofrance/temperature/cache/preferences", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> setMeteoFranceTemperatureCachePreferences(
            @RequestBody MeteoFranceTemperatureCachePreferenceDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (!hasAdminRole()) {
            return adminForbidden();
        }
        if (body == null) {
            return ResponseEntity.badRequest().build();
        }
        try {
            MeteoFranceTemperatureCachePreferenceDto saved = meteoFranceTemperatureCachePreferenceService.saveForSubject(
                    sub, body.temperatureCacheMinutes());
            return ResponseEntity.ok(saved);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        }
    }

    /** Per-user MF/MS station history cache retention (MongoDB appParameters). */
    @GetMapping(value = "/meteofrance/history/cache/preferences", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<MeteoFranceHistoryCachePreferenceDto> getMeteoFranceHistoryCachePreferences() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(meteoFranceHistoryCachePreferenceService.readForSubject(sub));
    }

    @PutMapping(value = "/meteofrance/history/cache/preferences", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> setMeteoFranceHistoryCachePreferences(
            @RequestBody MeteoFranceHistoryCachePreferenceDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (!hasAdminRole()) {
            return adminForbidden();
        }
        if (body == null) {
            return ResponseEntity.badRequest().build();
        }
        try {
            MeteoFranceHistoryCachePreferenceDto saved = meteoFranceHistoryCachePreferenceService.saveForSubject(
                    sub, body.historyCacheDays());
            return ResponseEntity.ok(saved);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        }
    }

    @GetMapping(value = "/meteofrance/aromepi/playback/preferences", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<MeteoFranceAromepiPlaybackPreferenceDto> getMeteoFranceAromepiPlaybackPreferences() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(meteoFranceAromepiPlaybackPreferenceService.readForSubject(sub));
    }

    @PutMapping(value = "/meteofrance/aromepi/playback/preferences", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> setMeteoFranceAromepiPlaybackPreferences(
            @RequestBody MeteoFranceAromepiPlaybackPreferenceDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (!hasAdminRole()) {
            return adminForbidden();
        }
        if (body == null) {
            return ResponseEntity.badRequest().build();
        }
        try {
            MeteoFranceAromepiPlaybackPreferenceDto saved = meteoFranceAromepiPlaybackPreferenceService.saveForSubject(
                    sub, body.prefetchAhead());
            return ResponseEntity.ok(saved);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        }
    }

    /** Clears server-side MF + Open-Meteo temperature observation caches. */
    @PostMapping(value = "/meteofrance/temperature/cache/clear", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> clearMeteoFranceTemperatureObservationCache() {
        Map<String, Object> result = new LinkedHashMap<>();
        int mfEntries = meteoFranceObsService.clearTemperatureObservationCache();
        int openMeteoEntries = openMeteoService.clearTemperatureObservationCache();
        result.put("cleared", true);
        result.put("mfCacheEntries", mfEntries);
        result.put("openMeteoCacheEntries", openMeteoEntries);
        return result;
    }

    /** Global radar auto-refresh settings (MongoDB appParameters, all users). */
    @GetMapping(value = "/meteofrance/radar/preferences", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<MeteoFranceRadarPreferenceDto> getMeteoFranceRadarPreferences() {
        return ResponseEntity.ok(meteoFranceRadarRefreshPreferenceService.readGlobal());
    }

    @PutMapping(value = "/meteofrance/radar/preferences", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> setMeteoFranceRadarPreferences(
            @RequestBody MeteoFranceRadarPreferenceDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (!hasAdminRole()) {
            return adminForbidden();
        }
        if (body == null) {
            return ResponseEntity.badRequest().build();
        }
        try {
            return ResponseEntity.ok(meteoFranceRadarRefreshPreferenceService.saveGlobal(body));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        }
    }

    /** Per-user trace viewer switches and basemap (MongoDB appParameters). */
    @GetMapping(value = "/trace-viewer/preferences", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<TraceViewerPreferenceDto> getTraceViewerPreferences() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(traceViewerPreferenceService.readForSubject(sub));
    }

    @PutMapping(value = "/trace-viewer/preferences", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<TraceViewerPreferenceDto> setTraceViewerPreferences(
            @RequestBody TraceViewerPreferenceDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (body == null) {
            return ResponseEntity.badRequest().build();
        }
        try {
            return ResponseEntity.ok(traceViewerPreferenceService.saveForSubject(sub, body));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        }
    }

    private static String currentJwtSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        return jwt.getSubject();
    }

    private static boolean hasAdminRole() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null) {
            return false;
        }
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(authority -> authority.equalsIgnoreCase("ROLE_Admin")
                        || authority.equalsIgnoreCase("ROLE_admin"));
    }

    private static ResponseEntity<Map<String, Object>> adminForbidden() {
        Map<String, Object> errorResponse = new LinkedHashMap<>();
        errorResponse.put("error", "Unauthorized");
        errorResponse.put("message", "Admin role required");
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
    }

    /**
     * Proxy WMS radar tile (geoservices.meteofrance.fr).
     * BBOX in EPSG:4326 WMS 1.3.0 order: minLat,minLon,maxLat,maxLon.
     */
    @GetMapping(value = "/meteofrance/radar/wms", produces = {MediaType.IMAGE_PNG_VALUE, MediaType.APPLICATION_OCTET_STREAM_VALUE})
    public org.springframework.http.ResponseEntity<byte[]> getMeteoFranceRadarWms(
            @RequestParam("minLat") Double minLat,
            @RequestParam("minLon") Double minLon,
            @RequestParam("maxLat") Double maxLat,
            @RequestParam("maxLon") Double maxLon,
            @RequestParam(value = "width", defaultValue = "256") int width,
            @RequestParam(value = "height", defaultValue = "256") int height) {
        return meteoFranceRadarService.getWmsTile(minLat, minLon, maxLat, maxLon, width, height);
    }

    /**
     * WMS radar tiles for Leaflet ({z}/{x}/{y}), proxied from geoservices.meteofrance.fr.
     */
    @GetMapping(value = "/meteofrance/radar/wms/{z}/{x}/{y}", produces = {MediaType.IMAGE_PNG_VALUE, MediaType.APPLICATION_OCTET_STREAM_VALUE})
    public org.springframework.http.ResponseEntity<byte[]> getMeteoFranceRadarWmsTile(
            @PathVariable int z,
            @PathVariable int x,
            @PathVariable int y,
            @RequestParam(value = "width", defaultValue = "256") int width,
            @RequestParam(value = "height", defaultValue = "256") int height) {
        return meteoFranceRadarService.getWmsTileFromSlippyMap(z, x, y, width, height);
    }

    /**
     * Latest radar mosaic via DPRadar API (HDF5/BUFR grid — not used for map PNG overlay).
     */
    @GetMapping(value = "/meteofrance/radar/mosaic", produces = {MediaType.IMAGE_PNG_VALUE, MediaType.APPLICATION_OCTET_STREAM_VALUE})
    public org.springframework.http.ResponseEntity<byte[]> getMeteoFranceRadarMosaic(
            @RequestParam(value = "zone", defaultValue = "METROPOLE") String zone,
            @RequestParam(value = "observation", defaultValue = "REFLECTIVITE") String observation,
            @RequestParam(value = "maille", defaultValue = "1000") Integer maille) {
        return meteoFranceRadarService.getLatestMosaicImage(zone, observation, maille);
    }

    /**
     * List observation types for a radar mosaic zone (DPRadar API).
     */
    @GetMapping(value = "/meteofrance/radar/observations", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoFranceRadarObservations(
            @RequestParam(value = "zone", defaultValue = "METROPOLE") String zone) {
        return meteoFranceRadarService.listObservations(zone);
    }

    /**
     * Metadata for a radar mosaic observation (validity_time, etc.).
     */
    @GetMapping(value = "/meteofrance/radar/observation", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoFranceRadarObservationMeta(
            @RequestParam(value = "zone", defaultValue = "METROPOLE") String zone,
            @RequestParam(value = "observation", defaultValue = "REFLECTIVITE") String observation,
            @RequestParam(value = "maille", defaultValue = "1000") Integer maille) {
        return meteoFranceRadarService.getObservationMeta(zone, observation, maille);
    }

    /**
     * RainViewer radar metadata (tile host + frame paths). Proxied to avoid browser CORS.
     */
    @GetMapping(value = "/radar/rainviewer/maps", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getRainViewerMaps() {
        return meteoFranceRadarService.getRainViewerMaps();
    }

    /**
     * RainViewer radar tile proxy (PNG). {@code path} is the frame path from maps metadata, e.g. {@code /v2/radar/abc123}.
     */
    @GetMapping(value = "/radar/rainviewer/tile/{z}/{x}/{y}", produces = MediaType.IMAGE_PNG_VALUE)
    public org.springframework.http.ResponseEntity<byte[]> getRainViewerTile(
            @PathVariable("z") int z,
            @PathVariable("x") int x,
            @PathVariable("y") int y,
            @RequestParam("path") String framePath,
            @RequestParam(value = "size", defaultValue = "256") int size,
            @RequestParam(value = "color", defaultValue = "2") int color,
            @RequestParam(value = "options", defaultValue = "1_1") String options,
            @RequestParam(value = "enhance", defaultValue = "0") float enhance) {
        return meteoFranceRadarService.getRainViewerTile(framePath, z, x, y, size, color, options, enhance);
    }

    /**
     * List climatological stations for a French department (DPClim API).
     */
    @GetMapping(value = "/meteofrance/clim/stations", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoFranceClimStations(
            @RequestParam("department") String department,
            @RequestParam(value = "frequency", defaultValue = "quotidienne") String frequency) {
        return meteoFranceClimService.listStations(department, frequency);
    }

    /**
     * Climatological station metadata (DPClim API).
     */
    @GetMapping(value = "/meteofrance/clim/station", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoFranceClimStation(
            @RequestParam("stationId") String stationId) {
        return meteoFranceClimService.getStationInfo(stationId);
    }

    /**
     * Nearest climatological station + archived observations for a location (async order proxied server-side).
     */
    @GetMapping(value = "/meteofrance/clim/nearby", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoFranceClimNearby(
            @RequestParam("lat") double lat,
            @RequestParam("lon") double lon,
            @RequestParam(value = "department", required = false) String department,
            @RequestParam(value = "days", defaultValue = "30") int days,
            @RequestParam(value = "frequency", defaultValue = "quotidienne") String frequency,
            @RequestParam(value = "stationId", required = false) String stationId,
            @RequestParam(value = "refresh", defaultValue = "false") boolean refresh) {
        return meteoFranceClimService.getNearbyClimData(
                lat, lon, department, days, frequency, stationId, refresh, currentJwtSubject());
    }

    /** Clears server-side MF DPClim nearby response cache. */
    @PostMapping(value = "/meteofrance/clim/cache/clear", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> clearMeteoFranceClimCache() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("cleared", true);
        result.put("cacheEntries", meteoFranceClimService.clearClimCache());
        return result;
    }

    /**
     * AROME-PI WMS capabilities (layers, time steps, reference runs).
     */
    @GetMapping(value = "/meteofrance/aromepi/capabilities", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoFranceAromepiCapabilities() {
        return meteoFranceAromepiService.getCapabilities();
    }

    /**
     * AROME-PI WMS tile proxy (EPSG:4326 slippy tile, TIME + DIM_REFERENCE_TIME).
     */
    @GetMapping(value = "/meteofrance/aromepi/wms/{z}/{x}/{y}", produces = {MediaType.IMAGE_PNG_VALUE, MediaType.APPLICATION_OCTET_STREAM_VALUE})
    public ResponseEntity<byte[]> getMeteoFranceAromepiWmsTile(
            @PathVariable("z") int z,
            @PathVariable("x") int x,
            @PathVariable("y") int y,
            @RequestParam("layer") String layer,
            @RequestParam("time") String time,
            @RequestParam("referenceTime") String referenceTime,
            @RequestParam(value = "style", required = false) String style,
            @RequestParam(value = "width", defaultValue = "256") int width,
            @RequestParam(value = "height", defaultValue = "256") int height) {
        return meteoFranceAromepiService.getWmsTile(z, x, y, layer, style, time, referenceTime, width, height);
    }

    /**
     * AROME-PI WMS GetFeatureInfo at a point (current forecast step).
     */
    @GetMapping(value = "/meteofrance/aromepi/featureinfo", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoFranceAromepiFeatureInfo(
            @RequestParam("lat") double lat,
            @RequestParam("lon") double lon,
            @RequestParam("layer") String layer,
            @RequestParam("time") String time,
            @RequestParam("referenceTime") String referenceTime,
            @RequestParam(value = "style", required = false) String style) {
        return meteoFranceAromepiService.getFeatureInfo(lat, lon, layer, style, time, referenceTime, 256, 256);
    }

    /**
     * AROME-PI point forecast timeline (GetFeatureInfo on each 15 min step).
     */
    @GetMapping(value = "/meteofrance/aromepi/point-forecast", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoFranceAromepiPointForecast(
            @RequestParam("lat") double lat,
            @RequestParam("lon") double lon,
            @RequestParam(value = "referenceTime", required = false) String referenceTime,
            @RequestParam(value = "layers", required = false) List<String> layers) {
        return meteoFranceAromepiService.getPointForecast(lat, lon, layers, referenceTime);
    }
}
