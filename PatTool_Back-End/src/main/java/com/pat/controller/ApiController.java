package com.pat.controller;

import com.pat.service.OpenWeatherService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/external")
public class ApiController {

    private static final Logger log = LoggerFactory.getLogger(ApiController.class);

    @Autowired
    private OpenWeatherService openWeatherService;

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
     * @return Current weather data
     */
    @GetMapping(value = "/weather/current/coordinates", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getCurrentWeatherByCoordinates(
            @RequestParam("lat") Double lat,
            @RequestParam("lon") Double lon) {
        log.debug("Fetching current weather for coordinates: lat={}, lon={}", lat, lon);
        return openWeatherService.getCurrentWeatherByCoordinates(lat, lon);
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
     * @return Forecast data
     */
    @GetMapping(value = "/weather/forecast/coordinates", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getForecastByCoordinates(
            @RequestParam("lat") Double lat,
            @RequestParam("lon") Double lon) {
        log.debug("Fetching forecast for coordinates: lat={}, lon={}", lat, lon);
        return openWeatherService.getForecastByCoordinates(lat, lon);
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
            "/api/external/weather/forecast/coordinates"
        });
        return status;
    }
}
