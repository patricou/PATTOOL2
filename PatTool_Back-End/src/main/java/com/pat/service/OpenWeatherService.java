package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
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
     * Get current weather data by coordinates
     * @param lat Latitude
     * @param lon Longitude
     * @return Weather data
     */
    public Map<String, Object> getCurrentWeatherByCoordinates(Double lat, Double lon) {
        // Validate API key
        if (openWeatherApiKey == null || openWeatherApiKey.trim().isEmpty()) {
            log.error("OpenWeatherMap API key is not configured!");
            Map<String, Object> errorMap = new HashMap<>();
            errorMap.put("error", "API key is not configured. Please set openweathermap.api.key in application.properties");
            return errorMap;
        }
        
        String url = openWeatherApiBaseUrl + "/weather";
        
        try {
            log.debug("Calling OpenWeatherMap API for coordinates: lat={}, lon={}", lat, lon);
            
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
            
            return response.getBody() != null ? response.getBody() : new HashMap<>();
            
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
            
        } catch (Exception e) {
            log.error("Error fetching forecast for city {}: ", city, e);
            Map<String, Object> errorMap = new HashMap<>();
            errorMap.put("error", "Failed to fetch forecast: " + e.getMessage());
            return errorMap;
        }
    }
}
