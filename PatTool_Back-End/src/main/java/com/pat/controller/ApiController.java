package com.pat.controller;

import com.pat.controller.dto.MeteoFranceRadarPreferenceDto;
import com.pat.controller.dto.MeteoFranceTemperatureCachePreferenceDto;
import com.pat.controller.dto.TemperatureLabelsRequestDto;
import com.pat.service.GeocodeService;
import com.pat.service.IpGeolocationService;
import com.pat.service.MeteoFranceAromepiService;
import com.pat.service.MeteoFranceClimService;
import com.pat.service.MeteoFranceObsService;
import com.pat.service.MeteoFranceRadarRefreshPreferenceService;
import com.pat.service.MeteoFranceRadarService;
import com.pat.service.MeteoFranceTemperatureCachePreferenceService;
import com.pat.service.OpenMeteoService;
import com.pat.service.OpenWeatherService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

import jakarta.servlet.http.HttpServletRequest;
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
    private MeteoFranceRadarRefreshPreferenceService meteoFranceRadarRefreshPreferenceService;

    @Autowired
    private MeteoFranceTemperatureCachePreferenceService meteoFranceTemperatureCachePreferenceService;

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
            @RequestParam(value = "source", defaultValue = "openweathermap") String source) {
        log.debug("Fetching forecast for coordinates: lat={}, lon={}, alt={}, source={}", lat, lon, alt, source);
        return resolveForecastByCoordinates(lat, lon, source, currentJwtSubject());
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
            Double lat, Double lon, String source, String jwtSubject) {
        return switch (normalizeWeatherSource(source)) {
            case "open-meteo" -> openMeteoService.getForecastByCoordinates(lat, lon, jwtSubject);
            case "meteofrance" -> meteoFranceObsService.getForecastByCoordinates(lat, lon, jwtSubject);
            default -> tagOpenWeatherSource(openWeatherService.getForecastByCoordinates(lat, lon, null));
        };
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
    public ResponseEntity<MeteoFranceTemperatureCachePreferenceDto> setMeteoFranceTemperatureCachePreferences(
            @RequestBody MeteoFranceTemperatureCachePreferenceDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
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

    /** Per-user radar auto-refresh interval (MongoDB appParameters). */
    @GetMapping(value = "/meteofrance/radar/preferences", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<MeteoFranceRadarPreferenceDto> getMeteoFranceRadarPreferences() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(meteoFranceRadarRefreshPreferenceService.readForSubject(sub));
    }

    @PutMapping(value = "/meteofrance/radar/preferences", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<MeteoFranceRadarPreferenceDto> setMeteoFranceRadarPreferences(
            @RequestBody MeteoFranceRadarPreferenceDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (body == null) {
            return ResponseEntity.badRequest().build();
        }
        try {
            MeteoFranceRadarPreferenceDto saved =
                    meteoFranceRadarRefreshPreferenceService.saveForSubject(sub, body.radarRefreshSeconds());
            return ResponseEntity.ok(saved);
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
            @RequestParam(value = "stationId", required = false) String stationId) {
        return meteoFranceClimService.getNearbyClimData(lat, lon, department, days, frequency, stationId);
    }

    /**
     * AROME-PI WMS capabilities (layers, time steps, reference runs).
     */
    @GetMapping(value = "/meteofrance/aromepi/capabilities", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getMeteoFranceAromepiCapabilities() {
        return meteoFranceAromepiService.getCapabilities();
    }

    /**
     * AROME-PI WMS tile proxy (EPSG:3857, TIME + DIM_REFERENCE_TIME).
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
