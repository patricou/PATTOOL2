package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class OpenWeatherService {

    private static final Logger log = LoggerFactory.getLogger(OpenWeatherService.class);
    private static final Duration ELEVATION_HIT_CACHE_TTL = Duration.ofHours(24);
    private static final Duration ELEVATION_MISS_CACHE_TTL = Duration.ofHours(1);
    private static final Duration OPEN_ELEVATION_RATE_LIMIT_COOLDOWN = Duration.ofMinutes(30);
    private static final String OPEN_ELEVATION_LOOKUP_URL =
            "https://api.open-elevation.com/api/v1/lookup?locations=%s,%s";
    private static final String OPEN_METEO_ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";

    private final RestTemplate restTemplate;
    private final GeocodeService geocodeService;
    private final String openWeatherApiBaseUrl;
    private final String openWeatherApiKey;
    private final ConcurrentHashMap<String, ElevationCacheEntry> elevationCache = new ConcurrentHashMap<>();
    private volatile Instant openElevationBlockedUntil = Instant.EPOCH;

    private record ElevationCacheEntry(
            Double altitude,
            String sourceKey,
            String sourceDescription,
            Instant expiresAt) {
        boolean isValid() {
            return Instant.now().isBefore(expiresAt);
        }
    }

    private record SeaLevelElevation(Double altitude, String sourceKey, String sourceDescription) {}

    public OpenWeatherService(
            RestTemplate restTemplate,
            GeocodeService geocodeService,
            @Value("${openweathermap.api.base.url:https://api.openweathermap.org/data/2.5}") String openWeatherApiBaseUrl,
            @Value("${openweathermap.api.key:}") String openWeatherApiKey) {
        this.restTemplate = restTemplate;
        this.geocodeService = geocodeService;
        this.openWeatherApiBaseUrl = openWeatherApiBaseUrl;
        this.openWeatherApiKey = openWeatherApiKey;
        // Log API key status (only first 4 chars for security)
        if (openWeatherApiKey != null && !openWeatherApiKey.trim().isEmpty()) {
            log.info("OpenWeatherMap API key loaded (length: {}, starts with: {})", 
                    openWeatherApiKey.length(), 
                    openWeatherApiKey.length() > 4 ? openWeatherApiKey.substring(0, 4) + "..." : "***");
        } else {
            log.warn("OpenWeatherMap API key is empty or not configured!");
        }
    }

    /**
     * Get current weather data for a location
     * @param city City name
     * @param countryCode Optional country code (e.g., "FR", "US")
     * @return Weather data
     */
    public Map<String, Object> getCurrentWeather(String city, String countryCode) {
        // Validate API key
        if (openWeatherApiKey == null || openWeatherApiKey.trim().isEmpty()) {
            log.error("OpenWeatherMap API key is not configured!");
            Map<String, Object> errorMap = new HashMap<>();
            errorMap.put("error", "API key is not configured. Please set openweathermap.api.key in application.properties");
            return errorMap;
        }
        
        String url = openWeatherApiBaseUrl + "/weather";
        
        try {
            String queryParam = countryCode != null && !countryCode.isEmpty() 
                    ? city + "," + countryCode : city;
            
            log.debug("Calling OpenWeatherMap API for city: {}, countryCode: {}", city, countryCode);
            
            UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(url)
                    .queryParam("q", queryParam)
                    .queryParam("appid", openWeatherApiKey.trim())
                    .queryParam("units", "metric")
                    .queryParam("lang", "fr");
            
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            
            HttpEntity<String> requestEntity = new HttpEntity<>(headers);
            
            @SuppressWarnings("unchecked")
            ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                    builder.toUriString(),
                    HttpMethod.GET,
                    requestEntity,
                    (Class<Map<String, Object>>) (Class<?>) Map.class
            );
            
            return response.getBody() != null ? response.getBody() : new HashMap<>();
            
        } catch (Exception e) {
            log.error("Error fetching current weather for city {}: ", city, e);
            Map<String, Object> errorMap = new HashMap<>();
            errorMap.put("error", "Failed to fetch current weather: " + e.getMessage());
            return errorMap;
        }
    }

    /**
     * Get altitude from Nominatim response only (no fallback to OpenElevation).
     * Uses GeocodeService.reverse() to avoid duplicating Nominatim API calls.
     * @param lat Latitude
     * @param lon Longitude
     * @return Altitude in meters, or null if not available
     */
    private Double getAltitudeFromNominatimOnly(Double lat, Double lon) {
        try {
            Map<String, Object> body = geocodeService.reverse(lat, lon);
            if (body == null) return null;
            log.debug("Nominatim response keys for ({}, {}): {}", lat, lon, body.keySet());
            // Nominatim may return elevation in the 'extratags' or directly (rare)
            if (body.containsKey("extratags")) {
                @SuppressWarnings("unchecked")
                Map<String, Object> extratags = (Map<String, Object>) body.get("extratags");
                if (extratags != null && extratags.containsKey("ele")) {
                    try {
                        String eleStr = extratags.get("ele").toString();
                        Double altitude = Double.parseDouble(eleStr);
                        log.info("Altitude found in Nominatim extratags.ele: {}m for coordinates ({}, {})", altitude, lat, lon);
                        return altitude;
                    } catch (NumberFormatException e) {
                        log.debug("Could not parse elevation from Nominatim extratags.ele: {}", e.getMessage());
                    }
                }
            }
            if (body.containsKey("elevation")) {
                try {
                    Object elevation = body.get("elevation");
                    if (elevation instanceof Number) {
                        Double altitude = ((Number) elevation).doubleValue();
                        log.info("Altitude found in Nominatim elevation field: {}m for coordinates ({}, {})", altitude, lat, lon);
                        return altitude;
                    } else if (elevation instanceof String) {
                        Double altitude = Double.parseDouble((String) elevation);
                        log.info("Altitude found in Nominatim elevation field (string): {}m for coordinates ({}, {})", altitude, lat, lon);
                        return altitude;
                    }
                } catch (Exception e) {
                    log.debug("Could not parse elevation from Nominatim elevation field: {}", e.getMessage());
                }
            }
            log.debug("No altitude found in Nominatim response for coordinates ({}, {}). Nominatim typically does not provide elevation data.", lat, lon);
        } catch (Exception e) {
            log.error("Error getting altitude from Nominatim for coordinates ({}, {}): {}", lat, lon, e.getMessage());
        }
        return null;
    }

    /**
     * Get altitude from Nominatim (OpenStreetMap) reverse geocoding API
     * Note: Nominatim typically does NOT provide elevation data in standard responses
     * This method checks for it but will fallback to OpenElevation API
     * @param lat Latitude
     * @param lon Longitude
     * @return Altitude in meters, or null if not available
     */
    private Double getAltitudeFromNominatim(Double lat, Double lon) {
        Double altitude = getAltitudeFromNominatimOnly(lat, lon);
        if (altitude != null) {
            return altitude;
        }
        // If Nominatim doesn't provide elevation, try OpenElevation API as fallback
        log.debug("Falling back to OpenElevation API for coordinates ({}, {})", lat, lon);
        return getAltitudeFromOpenElevation(lat, lon);
    }

    private Double getAltitudeFromOpenElevation(Double lat, Double lon) {
        SeaLevelElevation resolved = resolveSeaLevelElevation(lat, lon);
        return resolved != null ? resolved.altitude() : null;
    }

    private SeaLevelElevation resolveSeaLevelElevation(double lat, double lon) {
        String cacheKey = elevationCacheKey(lat, lon);
        ElevationCacheEntry cached = elevationCache.get(cacheKey);
        if (cached != null && cached.isValid()) {
            if (cached.altitude() == null) {
                return null;
            }
            return new SeaLevelElevation(cached.altitude(), cached.sourceKey(), cached.sourceDescription());
        }

        SeaLevelElevation resolved = null;
        if (!isOpenElevationBlocked()) {
            resolved = fetchOpenElevationApi(lat, lon);
        }
        if (resolved == null) {
            resolved = fetchOpenMeteoElevation(lat, lon);
        }

        if (resolved != null) {
            cacheElevation(cacheKey, resolved, ELEVATION_HIT_CACHE_TTL);
            return resolved;
        }

        elevationCache.put(cacheKey, new ElevationCacheEntry(
                null, null, null, Instant.now().plus(ELEVATION_MISS_CACHE_TTL)));
        return null;
    }

    private boolean isOpenElevationBlocked() {
        return Instant.now().isBefore(openElevationBlockedUntil);
    }

    private void markOpenElevationRateLimited() {
        Instant blockedUntil = Instant.now().plus(OPEN_ELEVATION_RATE_LIMIT_COOLDOWN);
        if (Instant.now().isAfter(openElevationBlockedUntil)) {
            log.warn(
                    "OpenElevation API rate limited (429); pausing calls for {} minutes. "
                            + "Using Open-Meteo elevation as fallback.",
                    OPEN_ELEVATION_RATE_LIMIT_COOLDOWN.toMinutes());
        }
        openElevationBlockedUntil = blockedUntil;
    }

    private SeaLevelElevation fetchOpenElevationApi(double lat, double lon) {
        try {
            String url = OPEN_ELEVATION_LOOKUP_URL.formatted(
                    formatCoordinate(lat), formatCoordinate(lon));
            log.debug("Calling OpenElevation API for coordinates ({}, {})", lat, lon);

            @SuppressWarnings("unchecked")
            ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(new HttpHeaders()),
                    (Class<Map<String, Object>>) (Class<?>) Map.class);

            Double altitude = parseOpenElevationBody(response.getBody());
            if (altitude != null) {
                log.debug("Altitude obtained from OpenElevation API: {}m for coordinates ({}, {})",
                        altitude, lat, lon);
                return new SeaLevelElevation(
                        altitude,
                        "openelevation",
                        "Altitude from OpenElevation API (sea level)");
            }
            log.debug("OpenElevation API response did not contain elevation for ({}, {})", lat, lon);
        } catch (HttpClientErrorException.TooManyRequests e) {
            markOpenElevationRateLimited();
        } catch (HttpClientErrorException e) {
            if (e.getStatusCode().value() == 429) {
                markOpenElevationRateLimited();
            } else {
                log.debug("OpenElevation API error for ({}, {}): {}", lat, lon, e.getMessage());
            }
        } catch (Exception e) {
            log.debug("OpenElevation API error for ({}, {}): {}", lat, lon, e.getMessage());
        }
        return null;
    }

    private SeaLevelElevation fetchOpenMeteoElevation(double lat, double lon) {
        try {
            String url = UriComponentsBuilder.fromHttpUrl(OPEN_METEO_ELEVATION_URL)
                    .queryParam("latitude", lat)
                    .queryParam("longitude", lon)
                    .toUriString();
            log.debug("Calling Open-Meteo elevation API for coordinates ({}, {})", lat, lon);

            @SuppressWarnings("unchecked")
            ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(new HttpHeaders()),
                    (Class<Map<String, Object>>) (Class<?>) Map.class);

            Double altitude = parseOpenMeteoElevationBody(response.getBody());
            if (altitude != null) {
                log.debug("Altitude obtained from Open-Meteo elevation API: {}m for coordinates ({}, {})",
                        altitude, lat, lon);
                return new SeaLevelElevation(
                        altitude,
                        "open-meteo",
                        "Altitude from Open-Meteo elevation API (sea level)");
            }
        } catch (Exception e) {
            log.debug("Open-Meteo elevation API error for ({}, {}): {}", lat, lon, e.getMessage());
        }
        return null;
    }

    private static Double parseOpenElevationBody(Map<String, Object> body) {
        if (body == null || !body.containsKey("results")) {
            return null;
        }
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> results = (List<Map<String, Object>>) body.get("results");
        if (results == null || results.isEmpty()) {
            return null;
        }
        return parseElevationValue(results.get(0).get("elevation"));
    }

    private static Double parseOpenMeteoElevationBody(Map<String, Object> body) {
        if (body == null || !body.containsKey("elevation")) {
            return null;
        }
        Object raw = body.get("elevation");
        if (raw instanceof List<?> list && !list.isEmpty()) {
            return parseElevationValue(list.get(0));
        }
        return parseElevationValue(raw);
    }

    private static Double parseElevationValue(Object elevation) {
        if (elevation instanceof Number number) {
            return number.doubleValue();
        }
        if (elevation instanceof String text) {
            try {
                return Double.parseDouble(text);
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private static String elevationCacheKey(double lat, double lon) {
        return String.format(Locale.US, "%.4f,%.4f", lat, lon);
    }

    private static String formatCoordinate(double value) {
        return String.format(Locale.US, "%.6f", value);
    }

    private void cacheElevation(String cacheKey, SeaLevelElevation elevation, Duration ttl) {
        elevationCache.put(cacheKey, new ElevationCacheEntry(
                elevation.altitude(),
                elevation.sourceKey(),
                elevation.sourceDescription(),
                Instant.now().plus(ttl)));
    }

    /**
     * Get all available altitudes with their sources
     * Tries to get altitude from all possible sources and returns all available ones
     * Priority order: OpenElevation (sea level) > Nominatim > Mobile GPS (may be HAE)
     * Note: Mobile GPS altitude is often in HAE (Height Above Ellipsoid) which can differ
     * from sea level by ~30m. OpenElevation provides accurate sea level altitude.
     * @param lat Latitude
     * @param lon Longitude
     * @param alt Optional altitude from mobile device (in meters)
     * @return Map containing list of all available altitudes with sources
     */
    public Map<String, Object> getAllAltitudesWithSources(Double lat, Double lon, Double alt) {
        Map<String, Object> result = new HashMap<>();
        java.util.List<Map<String, Object>> altitudes = new java.util.ArrayList<>();
        
        // Source 1: sea-level elevation (OpenElevation when available, Open-Meteo fallback)
        try {
            SeaLevelElevation seaLevel = resolveSeaLevelElevation(lat, lon);
            if (seaLevel != null) {
                Map<String, Object> seaLevelAltMap = new HashMap<>();
                seaLevelAltMap.put("altitude", seaLevel.altitude());
                seaLevelAltMap.put("source", seaLevel.sourceKey());
                seaLevelAltMap.put("sourceDescription", seaLevel.sourceDescription());
                seaLevelAltMap.put("priority", 1);
                altitudes.add(seaLevelAltMap);
            }
        } catch (Exception e) {
            log.debug("Could not get sea-level elevation: {}", e.getMessage());
        }
        
        // Source 2: Nominatim (though it typically doesn't provide elevation)
        try {
            Double nominatimAlt = getAltitudeFromNominatimOnly(lat, lon);
            if (nominatimAlt != null) {
                Map<String, Object> nominatimAltMap = new HashMap<>();
                nominatimAltMap.put("altitude", nominatimAlt);
                nominatimAltMap.put("source", "nominatim");
                nominatimAltMap.put("sourceDescription", "Altitude from Nominatim (OpenStreetMap)");
                nominatimAltMap.put("priority", 2);
                altitudes.add(nominatimAltMap);
                log.info("Altitude from Nominatim: {}m for coordinates ({}, {})", nominatimAlt, lat, lon);
            }
        } catch (Exception e) {
            log.debug("Could not get altitude from Nominatim: {}", e.getMessage());
        }
        
        // Source 3: Mobile device (lowest priority - may be HAE instead of sea level)
        // Mobile GPS altitude is often in HAE (Height Above Ellipsoid) which can be
        // significantly different from sea level altitude (~30m difference possible)
        if (alt != null) {
            Map<String, Object> mobileAlt = new HashMap<>();
            mobileAlt.put("altitude", alt);
            mobileAlt.put("source", "mobile_device");
            mobileAlt.put("sourceDescription", "Altitude from mobile device GPS (may be HAE)");
            mobileAlt.put("priority", 3);
            altitudes.add(mobileAlt);
            log.info("Altitude from mobile device: {}m for coordinates ({}, {}) - Note: may be HAE instead of sea level", alt, lat, lon);
        }
        
        // Sort by priority (ascending) to ensure highest priority (lowest number) is first
        altitudes.sort((a, b) -> {
            Integer priorityA = (Integer) a.get("priority");
            Integer priorityB = (Integer) b.get("priority");
            return priorityA.compareTo(priorityB);
        });
        
        result.put("altitudes", altitudes);
        result.put("count", altitudes.size());
        result.put("coordinates", Map.of("lat", lat, "lon", lon));
        
        log.debug("Found {} altitude(s) for coordinates ({}, {})", altitudes.size(), lat, lon);
        return result;
    }

    /**
     * Get current weather data by coordinates
     * @param lat Latitude
     * @param lon Longitude
     * @param alt Optional altitude from mobile device (in meters)
     * @return Weather data
     */
    public Map<String, Object> getCurrentWeatherByCoordinates(Double lat, Double lon, Double alt) {
        // Validate API key
        if (openWeatherApiKey == null || openWeatherApiKey.trim().isEmpty()) {
            log.error("OpenWeatherMap API key is not configured!");
            Map<String, Object> errorMap = new HashMap<>();
            errorMap.put("error", "API key is not configured. Please set openweathermap.api.key in application.properties");
            return errorMap;
        }
        
        // Get altitude with fallback: mobile device → frontend (from Nominatim) → backend Nominatim → OpenElevation
        // Note: Frontend already calls Nominatim for address, so it extracts altitude from that same response
        // Backend only calls Nominatim if altitude wasn't provided by frontend (to avoid duplicate API calls)
        Double altitude = alt; // Start with altitude from mobile device or frontend (from Nominatim)
        
        if (altitude == null) {
            // Try Nominatim only if not available from mobile/frontend (avoids duplicate call if frontend already got it)
            log.debug("Altitude not provided, trying Nominatim for coordinates ({}, {})", lat, lon);
            altitude = getAltitudeFromNominatim(lat, lon);
            if (altitude != null) {
                log.debug("Altitude obtained from Nominatim: {}m", altitude);
            }
        } else {
            log.debug("Using altitude from mobile device or frontend: {}m", altitude);
        }
        
        // Note: OpenWeatherMap API does not support altitude parameter or return altitude in response
        // We'll add it to the response ourselves if we have it
        
        String url = openWeatherApiBaseUrl + "/weather";
        
        try {
            log.debug("Calling OpenWeatherMap API for coordinates: lat={}, lon={}, alt={}", lat, lon, altitude);
            
            UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(url)
                    .queryParam("lat", lat)
                    .queryParam("lon", lon)
                    .queryParam("appid", openWeatherApiKey.trim())
                    .queryParam("units", "metric")
                    .queryParam("lang", "fr");
            
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            
            HttpEntity<String> requestEntity = new HttpEntity<>(headers);
            
            @SuppressWarnings("unchecked")
            ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                    builder.toUriString(),
                    HttpMethod.GET,
                    requestEntity,
                    (Class<Map<String, Object>>) (Class<?>) Map.class
            );
            
            Map<String, Object> result = response.getBody() != null ? response.getBody() : new HashMap<>();
            
            // Get all available altitudes with sources
            Map<String, Object> allAltitudesInfo = getAllAltitudesWithSources(lat, lon, alt);
            result.put("altitudes", allAltitudesInfo.get("altitudes"));
            result.put("altitudeCount", allAltitudesInfo.get("count"));
            
            // For backward compatibility, also add the primary altitude (highest priority)
            @SuppressWarnings("unchecked")
            java.util.List<Map<String, Object>> altitudesList = (java.util.List<Map<String, Object>>) allAltitudesInfo.get("altitudes");
            if (altitudesList != null && !altitudesList.isEmpty()) {
                // Use the first one (highest priority)
                Map<String, Object> primaryAltitude = altitudesList.get(0);
                result.put("altitude", primaryAltitude.get("altitude"));
                result.put("altitudeSource", primaryAltitude.get("source"));
                result.put("altitudeSourceDescription", primaryAltitude.get("sourceDescription"));
                log.debug("Added {} altitude(s) to weather response for coordinates ({}, {}), primary: {}m from {}", 
                    altitudesList.size(), lat, lon, primaryAltitude.get("altitude"), primaryAltitude.get("source"));
            } else {
                log.debug("No altitude available to add to weather response for coordinates ({}, {})", lat, lon);
            }
            
            return result;
            
        } catch (Exception e) {
            log.error("Error fetching current weather for coordinates ({}, {}): ", lat, lon, e);
            Map<String, Object> errorMap = new HashMap<>();
            errorMap.put("error", "Failed to fetch current weather: " + e.getMessage());
            return errorMap;
        }
    }

    /**
     * Get 5-day weather forecast for a location
     * @param city City name
     * @param countryCode Optional country code
     * @return Forecast data
     */
    public Map<String, Object> getForecast(String city, String countryCode) {
        // Validate API key
        if (openWeatherApiKey == null || openWeatherApiKey.trim().isEmpty()) {
            log.error("OpenWeatherMap API key is not configured!");
            Map<String, Object> errorMap = new HashMap<>();
            errorMap.put("error", "API key is not configured. Please set openweathermap.api.key in application.properties");
            return errorMap;
        }
        
        String url = openWeatherApiBaseUrl + "/forecast";
        
        try {
            String queryParam = countryCode != null && !countryCode.isEmpty() 
                    ? city + "," + countryCode : city;
            
            log.debug("Calling OpenWeatherMap API forecast for city: {}, countryCode: {}", city, countryCode);
            
            UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(url)
                    .queryParam("q", queryParam)
                    .queryParam("appid", openWeatherApiKey.trim())
                    .queryParam("units", "metric")
                    .queryParam("lang", "fr");
            
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            
            HttpEntity<String> requestEntity = new HttpEntity<>(headers);
            
            @SuppressWarnings("unchecked")
            ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                    builder.toUriString(),
                    HttpMethod.GET,
                    requestEntity,
                    (Class<Map<String, Object>>) (Class<?>) Map.class
            );
            
            return response.getBody() != null ? response.getBody() : new HashMap<>();
            
        } catch (HttpClientErrorException.NotFound e) {
            // Handle 404 - city not found
            log.warn("City not found for forecast: {} (countryCode: {})", city, countryCode);
            Map<String, Object> errorMap = new HashMap<>();
            errorMap.put("error", "City not found: " + city + (countryCode != null && !countryCode.isEmpty() ? ", " + countryCode : ""));
            return errorMap;
        } catch (Exception e) {
            log.error("Error fetching forecast for city {}: ", city, e);
            Map<String, Object> errorMap = new HashMap<>();
            String errorMessage = e.getMessage();
            if (e instanceof HttpClientErrorException) {
                HttpClientErrorException httpEx = (HttpClientErrorException) e;
                if (httpEx.getStatusCode() == HttpStatus.NOT_FOUND) {
                    errorMessage = "City not found: " + city;
                } else {
                    errorMessage = "API error (" + httpEx.getStatusCode() + "): " + httpEx.getResponseBodyAsString();
                }
            }
            errorMap.put("error", "Failed to fetch forecast: " + errorMessage);
            return errorMap;
        }
    }

    /**
     * Get 5-day weather forecast by coordinates
     * @param lat Latitude
     * @param lon Longitude
     * @param alt Optional altitude from mobile device (in meters)
     * @return Forecast data
     */
    public Map<String, Object> getForecastByCoordinates(Double lat, Double lon, Double alt) {
        return getForecastByCoordinates(lat, lon, alt, 24, 60);
    }

    public Map<String, Object> getForecastByCoordinates(
            Double lat, Double lon, Double alt, int horizonHours, int stepMinutes) {
        // Validate API key
        if (openWeatherApiKey == null || openWeatherApiKey.trim().isEmpty()) {
            log.error("OpenWeatherMap API key is not configured!");
            Map<String, Object> errorMap = new HashMap<>();
            errorMap.put("error", "API key is not configured. Please set openweathermap.api.key in application.properties");
            return errorMap;
        }
        
        // Get altitude with fallback: mobile device → frontend (from Nominatim) → backend Nominatim → OpenElevation
        // Note: Frontend already calls Nominatim for address, so it extracts altitude from that same response
        // Backend only calls Nominatim if altitude wasn't provided by frontend (to avoid duplicate API calls)
        Double altitude = alt; // Start with altitude from mobile device or frontend (from Nominatim)
        
        if (altitude == null) {
            // Try Nominatim only if not available from mobile/frontend (avoids duplicate call if frontend already got it)
            log.debug("Altitude not provided, trying Nominatim for coordinates ({}, {})", lat, lon);
            altitude = getAltitudeFromNominatim(lat, lon);
            if (altitude != null) {
                log.debug("Altitude obtained from Nominatim: {}m", altitude);
            }
        } else {
            log.debug("Using altitude from mobile device or frontend: {}m", altitude);
        }
        
        // Note: OpenWeatherMap API does not support altitude parameter or return altitude in response
        // We'll add it to the response ourselves if we have it
        
        String url = openWeatherApiBaseUrl + "/forecast";
        
        try {
            log.debug("Calling OpenWeatherMap API forecast for coordinates: lat={}, lon={}, alt={}", lat, lon, altitude);
            
            UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(url)
                    .queryParam("lat", lat)
                    .queryParam("lon", lon)
                    .queryParam("appid", openWeatherApiKey.trim())
                    .queryParam("units", "metric")
                    .queryParam("lang", "fr");
            
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            
            HttpEntity<String> requestEntity = new HttpEntity<>(headers);
            
            @SuppressWarnings("unchecked")
            ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                    builder.toUriString(),
                    HttpMethod.GET,
                    requestEntity,
                    (Class<Map<String, Object>>) (Class<?>) Map.class
            );
            
            Map<String, Object> result = response.getBody() != null ? response.getBody() : new HashMap<>();

            @SuppressWarnings("unchecked")
            java.util.List<Map<String, Object>> rawList = (java.util.List<Map<String, Object>>) result.get("list");
            if (rawList != null) {
                java.util.List<Map<String, Object>> filtered = ForecastHorizonFilter.filterList(
                        rawList, horizonHours, stepMinutes);
                result.put("list", filtered);
                result.put("cnt", filtered.size());
            }
            result.put("forecastHorizonHours", MeteoFranceForecastPreferenceService.clampHorizon(horizonHours));
            result.put("forecastStepMinutes", MeteoFranceForecastPreferenceService.clampStep(stepMinutes));
            
            // Get all available altitudes with sources
            Map<String, Object> allAltitudesInfo = getAllAltitudesWithSources(lat, lon, alt);
            result.put("altitudes", allAltitudesInfo.get("altitudes"));
            result.put("altitudeCount", allAltitudesInfo.get("count"));
            
            // For backward compatibility, also add the primary altitude (highest priority)
            @SuppressWarnings("unchecked")
            java.util.List<Map<String, Object>> altitudesList = (java.util.List<Map<String, Object>>) allAltitudesInfo.get("altitudes");
            if (altitudesList != null && !altitudesList.isEmpty()) {
                // Use the first one (highest priority)
                Map<String, Object> primaryAltitude = altitudesList.get(0);
                Double primaryAltValue = ((Number) primaryAltitude.get("altitude")).doubleValue();
                result.put("altitude", primaryAltValue);
                result.put("altitudeSource", primaryAltitude.get("source"));
                result.put("altitudeSourceDescription", primaryAltitude.get("sourceDescription"));
                log.debug("Added {} altitude(s) to forecast response for coordinates ({}, {}), primary: {}m from {}", 
                    altitudesList.size(), lat, lon, primaryAltValue, primaryAltitude.get("source"));
                // Also add to city object if it exists
                @SuppressWarnings("unchecked")
                Map<String, Object> city = (Map<String, Object>) result.get("city");
                if (city != null) {
                    city.put("altitude", primaryAltValue);
                }
            } else {
                log.debug("No altitude available to add to forecast response for coordinates ({}, {})", lat, lon);
            }
            
            return result;
            
        } catch (HttpClientErrorException.NotFound e) {
            log.warn("Location not found for forecast coordinates: lat={}, lon={}", lat, lon);
            Map<String, Object> errorMap = new HashMap<>();
            errorMap.put("error", "Location not found for coordinates: " + lat + ", " + lon);
            return errorMap;
        } catch (Exception e) {
            log.error("Error fetching forecast for coordinates ({}, {}): ", lat, lon, e);
            Map<String, Object> errorMap = new HashMap<>();
            String errorMessage = e.getMessage();
            if (e instanceof HttpClientErrorException) {
                HttpClientErrorException httpEx = (HttpClientErrorException) e;
                if (httpEx.getStatusCode() == HttpStatus.NOT_FOUND) {
                    errorMessage = "Location not found for coordinates: " + lat + ", " + lon;
                } else {
                    errorMessage = "API error (" + httpEx.getStatusCode() + "): " + httpEx.getResponseBodyAsString();
                }
            }
            errorMap.put("error", "Failed to fetch forecast: " + errorMessage);
            return errorMap;
        }
    }

    public boolean isApiKeyConfigured() {
        return openWeatherApiKey != null && !openWeatherApiKey.trim().isEmpty();
    }

    /**
     * Proxy OpenWeatherMap weather map tile (PNG).
     */
    public ResponseEntity<byte[]> getTemperatureMapTile(int z, int x, int y) {
        return getWeatherMapTile("temp_new", z, x, y);
    }

    /**
     * Proxy OpenWeatherMap cloud cover map tile (PNG). Layer {@code clouds_new}.
     * {@code enhance} boosts cloud visibility (0.5–8); 1 = raw OWM tile.
     */
    public ResponseEntity<byte[]> getCloudMapTile(int z, int x, int y, float enhance) {
        ResponseEntity<byte[]> base = getWeatherMapTile("clouds_new", z, x, y);
        byte[] body = base.getBody();
        if (body == null || body.length == 0 || !base.getStatusCode().is2xxSuccessful()) {
            return base;
        }
        byte[] enhanced = CloudMapTileEnhancer.enhanceOpenWeatherMap(body, enhance);
        HttpHeaders out = new HttpHeaders();
        out.putAll(base.getHeaders());
        return new ResponseEntity<>(enhanced, out, base.getStatusCode());
    }

    private ResponseEntity<byte[]> getWeatherMapTile(String layer, int z, int x, int y) {
        if (!isApiKeyConfigured()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).build();
        }
        if (z < 0 || z > 19 || x < 0 || y < 0) {
            return ResponseEntity.badRequest().build();
        }
        String url = UriComponentsBuilder
                .fromHttpUrl("https://tile.openweathermap.org/map/" + layer + "/" + z + "/" + x + "/" + y + ".png")
                .queryParam("appid", openWeatherApiKey.trim())
                .toUriString();
        try {
            ResponseEntity<byte[]> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(new HttpHeaders()),
                    byte[].class
            );
            byte[] body = response.getBody();
            if (body == null || body.length == 0) {
                return ResponseEntity.noContent().build();
            }
            HttpHeaders out = new HttpHeaders();
            MediaType contentType = response.getHeaders().getContentType();
            out.setContentType(contentType != null ? contentType : MediaType.IMAGE_PNG);
            out.setCacheControl(CacheControl.maxAge(java.time.Duration.ofMinutes(10)).cachePublic());
            return new ResponseEntity<>(body, out, HttpStatus.OK);
        } catch (HttpClientErrorException e) {
            log.warn("OpenWeatherMap {} tile fetch failed ({}): z={}, x={}, y={}",
                    layer, e.getStatusCode(), z, x, y);
            return ResponseEntity.status(e.getStatusCode()).build();
        } catch (Exception e) {
            log.warn("OpenWeatherMap {} tile fetch failed: {}", layer, e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }
}
