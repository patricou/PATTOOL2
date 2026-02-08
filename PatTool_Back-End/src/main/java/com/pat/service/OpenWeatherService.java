package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.util.HashMap;
import java.util.Map;

@Service
public class OpenWeatherService {

    private static final Logger log = LoggerFactory.getLogger(OpenWeatherService.class);

    private final RestTemplate restTemplate;

    @Value("${openweathermap.api.base.url:https://api.openweathermap.org/data/2.5}")
    private String openWeatherApiBaseUrl;

    @Value("${openweathermap.api.key:}")
    private String openWeatherApiKey;

    public OpenWeatherService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
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
     * Get altitude from Nominatim only (without fallback to OpenElevation)
     * @param lat Latitude
     * @param lon Longitude
     * @return Altitude in meters, or null if not available
     */
    private Double getAltitudeFromNominatimOnly(Double lat, Double lon) {
        try {
            String url = "https://nominatim.openstreetmap.org/reverse?format=json&lat=" + lat + "&lon=" + lon + "&zoom=18&addressdetails=1";
            
            HttpHeaders headers = new HttpHeaders();
            headers.set("User-Agent", "PATTOOL Weather App");
            headers.setContentType(MediaType.APPLICATION_JSON);
            
            HttpEntity<String> requestEntity = new HttpEntity<>(headers);
            
            @SuppressWarnings("unchecked")
            ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    requestEntity,
                    (Class<Map<String, Object>>) (Class<?>) Map.class
            );
            
            if (response.getBody() != null) {
                Map<String, Object> body = response.getBody();
                log.debug("Nominatim response keys for ({}, {}): {}", lat, lon, body.keySet());
                
                // Nominatim may return elevation in the 'extratags' or directly (rare)
                if (body.containsKey("extratags")) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> extratags = (Map<String, Object>) body.get("extratags");
                    if (extratags != null) {
                        log.debug("Nominatim extratags keys: {}", extratags.keySet());
                        if (extratags.containsKey("ele")) {
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
                }
                // Try alternative: some Nominatim instances return elevation directly (very rare)
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
            }
        } catch (Exception e) {
            log.error("Error calling Nominatim for altitude at coordinates ({}, {}): {}", lat, lon, e.getMessage());
        }
        // Return null - no fallback here, caller will handle multiple sources
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

    /**
     * Get altitude from OpenElevation API (free elevation service)
     * @param lat Latitude
     * @param lon Longitude
     * @return Altitude in meters, or null if not available
     */
    private Double getAltitudeFromOpenElevation(Double lat, Double lon) {
        try {
            // OpenElevation API endpoint - reliable free elevation service
            String url = "https://api.open-elevation.com/api/v1/lookup?locations=" + lat + "," + lon;
            
            log.debug("Calling OpenElevation API for coordinates ({}, {})", lat, lon);
            
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            
            HttpEntity<String> requestEntity = new HttpEntity<>(headers);
            
            @SuppressWarnings("unchecked")
            ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    requestEntity,
                    (Class<Map<String, Object>>) (Class<?>) Map.class
            );
            
            if (response.getBody() != null) {
                Map<String, Object> body = response.getBody();
                // OpenElevation returns: {"results": [{"latitude": lat, "longitude": lon, "elevation": elevation}]}
                if (body.containsKey("results")) {
                    @SuppressWarnings("unchecked")
                    java.util.List<Map<String, Object>> results = (java.util.List<Map<String, Object>>) body.get("results");
                    if (results != null && !results.isEmpty()) {
                        Map<String, Object> result = results.get(0);
                        if (result.containsKey("elevation")) {
                            Object elevation = result.get("elevation");
                            Double altitude = null;
                            if (elevation instanceof Number) {
                                altitude = ((Number) elevation).doubleValue();
                            } else if (elevation instanceof String) {
                                altitude = Double.parseDouble((String) elevation);
                            }
                            if (altitude != null) {
                                log.debug("Altitude obtained from OpenElevation API: {}m for coordinates ({}, {})", altitude, lat, lon);
                                return altitude;
                            }
                        }
                    }
                }
                log.warn("OpenElevation API response did not contain expected elevation data for coordinates ({}, {})", lat, lon);
            }
        } catch (Exception e) {
            log.warn("Error calling OpenElevation API for coordinates ({}, {}): {}", lat, lon, e.getMessage());
        }
        log.warn("Could not obtain altitude from OpenElevation API for coordinates ({}, {})", lat, lon);
        return null;
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
        
        // Source 1: OpenElevation API (highest priority - provides accurate sea level altitude)
        // This is preferred over mobile GPS because mobile GPS often uses HAE (Height Above Ellipsoid)
        // which can differ from sea level by ~30 meters depending on location
        try {
            Double openElevationAlt = getAltitudeFromOpenElevation(lat, lon);
            if (openElevationAlt != null) {
                Map<String, Object> openElevationAltMap = new HashMap<>();
                openElevationAltMap.put("altitude", openElevationAlt);
                openElevationAltMap.put("source", "openelevation");
                openElevationAltMap.put("sourceDescription", "Altitude from OpenElevation API (sea level)");
                openElevationAltMap.put("priority", 1);
                altitudes.add(openElevationAltMap);
                log.info("Altitude from OpenElevation: {}m for coordinates ({}, {})", openElevationAlt, lat, lon);
            }
        } catch (Exception e) {
            log.debug("Could not get altitude from OpenElevation: {}", e.getMessage());
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
}
