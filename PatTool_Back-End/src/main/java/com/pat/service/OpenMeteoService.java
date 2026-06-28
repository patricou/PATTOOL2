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
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Open-Meteo forecast API (free, no key) — used for numeric temperature labels on the map grid.
 */
@Service
public class OpenMeteoService {

    private static final Logger log = LoggerFactory.getLogger(OpenMeteoService.class);
    private static final String FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
    private static final Duration CACHE_TTL = Duration.ofMinutes(10);

    private final RestTemplate restTemplate;
    private final ConcurrentHashMap<String, CacheEntry> tempCache = new ConcurrentHashMap<>();

    public OpenMeteoService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    /**
     * Sample current 2 m temperatures on a lat/lon grid (for map number labels).
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> getTemperatureLabelGrid(
            double minLat, double maxLat, double minLon, double maxLon, int cols, int rows) {
        cols = clamp(cols, 2, 8);
        rows = clamp(rows, 2, 8);

        double south = Math.min(minLat, maxLat);
        double north = Math.max(minLat, maxLat);
        double west = Math.min(minLon, maxLon);
        double east = Math.max(minLon, maxLon);

        double latStep = rows > 1 ? (north - south) / (rows - 1) : 0;
        double lonStep = cols > 1 ? (east - west) / (cols - 1) : 0;

        List<Map<String, Object>> points = new ArrayList<>(cols * rows);
        for (int r = 0; r < rows; r++) {
            for (int c = 0; c < cols; c++) {
                double lat = rows > 1 ? south + r * latStep : (south + north) / 2;
                double lon = cols > 1 ? west + c * lonStep : (west + east) / 2;
                Double tempC = fetchCurrentTemperatureC(lat, lon);
                if (tempC != null) {
                    Map<String, Object> pt = new LinkedHashMap<>();
                    pt.put("lat", roundCoord(lat));
                    pt.put("lon", roundCoord(lon));
                    pt.put("tempC", tempC);
                    points.add(pt);
                }
            }
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("points", points);
        result.put("cols", cols);
        result.put("rows", rows);
        result.put("source", "open-meteo");
        return result;
    }

    /**
     * Current temperature at arbitrary coordinates (screen grid, up to {@code maxPoints}).
     */
    public Map<String, Object> getTemperaturesForPoints(
            List<TemperatureLabelsRequestDto.Point> inputPoints, int maxPoints) {
        int limit = Math.min(Math.max(inputPoints != null ? inputPoints.size() : 0, 0), maxPoints);
        List<Map<String, Object>> points = new ArrayList<>(limit);
        if (inputPoints == null) {
            return emptyPointsResult(points);
        }
        for (int i = 0; i < inputPoints.size() && points.size() < maxPoints; i++) {
            TemperatureLabelsRequestDto.Point p = inputPoints.get(i);
            Double tempC = fetchCurrentTemperatureC(p.lat(), p.lon());
            if (tempC != null) {
                Map<String, Object> pt = new LinkedHashMap<>();
                pt.put("lat", roundCoord(p.lat()));
                pt.put("lon", roundCoord(p.lon()));
                pt.put("tempC", tempC);
                points.add(pt);
            }
        }
        return emptyPointsResult(points);
    }

    private static Map<String, Object> emptyPointsResult(List<Map<String, Object>> points) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("points", points);
        result.put("count", points.size());
        result.put("source", "open-meteo");
        return result;
    }

    @SuppressWarnings("unchecked")
    private Double fetchCurrentTemperatureC(double lat, double lon) {
        String cacheKey = roundCoord(lat) + "," + roundCoord(lon);
        CacheEntry cached = tempCache.get(cacheKey);
        if (cached != null && cached.isValid()) {
            return cached.tempC;
        }

        String url = UriComponentsBuilder.fromHttpUrl(FORECAST_URL)
                .queryParam("latitude", lat)
                .queryParam("longitude", lon)
                .queryParam("current", "temperature_2m")
                .queryParam("timezone", "auto")
                .toUriString();

        try {
            ResponseEntity<Map> response = restTemplate.getForEntity(url, Map.class);
            Map<String, Object> body = response.getBody();
            if (body == null) {
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
            double tempC = tempNum.doubleValue();
            tempCache.put(cacheKey, new CacheEntry(tempC, Instant.now()));
            return tempC;
        } catch (Exception e) {
            log.debug("Open-Meteo temperature fetch failed for {}, {}: {}", lat, lon, e.getMessage());
            return null;
        }
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private static double roundCoord(double value) {
        return Math.round(value * 100.0) / 100.0;
    }

    private record CacheEntry(double tempC, Instant fetchedAt) {
        boolean isValid() {
            return fetchedAt.plus(CACHE_TTL).isAfter(Instant.now());
        }
    }
}
