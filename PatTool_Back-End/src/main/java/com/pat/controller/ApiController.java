package com.pat.controller;

import com.pat.controller.dto.MeteoFranceRadarPreferenceDto;
import com.pat.service.GeocodeService;
import com.pat.service.IpGeolocationService;
import com.pat.service.MeteoFranceClimService;
import com.pat.service.MeteoFranceRadarRefreshPreferenceService;
import com.pat.service.MeteoFranceRadarService;
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
    private GeocodeService geocodeService;

    @Autowired
    private IpGeolocationService ipGeolocationService;

    @Autowired
    private MeteoFranceRadarService meteoFranceRadarService;

    @Autowired
    private MeteoFranceClimService meteoFranceClimService;

    @Autowired
    private MeteoFranceRadarRefreshPreferenceService meteoFranceRadarRefreshPreferenceService;

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
            @RequestParam(value = "alt", required = false) Double alt) {
        log.debug("Fetching current weather for coordinates: lat={}, lon={}, alt={}", lat, lon, alt);
        return openWeatherService.getCurrentWeatherByCoordinates(lat, lon, alt);
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
            @RequestParam(value = "alt", required = false) Double alt) {
        log.debug("Fetching forecast for coordinates: lat={}, lon={}, alt={}", lat, lon, alt);
        return openWeatherService.getForecastByCoordinates(lat, lon, alt);
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
        status.put("endpoints", new String[]{
            "/api/external/weather/current",
            "/api/external/weather/current/coordinates",
            "/api/external/weather/forecast",
            "/api/external/weather/forecast/coordinates",
            "/api/external/weather/altitudes"
        });
        return status;
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
        return status;
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
     * Latest radar mosaic PNG via DPRadar API (requires meteofrance.api.token).
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
            @RequestParam(value = "options", defaultValue = "1_1") String options) {
        return meteoFranceRadarService.getRainViewerTile(framePath, z, x, y, size, color, options);
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
}
