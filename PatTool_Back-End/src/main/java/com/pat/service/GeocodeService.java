package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.util.*;
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantLock;

@Service
public class GeocodeService {

    private static final Logger log = LoggerFactory.getLogger(GeocodeService.class);
    private static final String NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
    private static final String USER_AGENT = "PATTOOL Address Geocode";
    /** Nominatim allows max 1 request per second. */
    private static final long MIN_REQUEST_INTERVAL_MS = 1_100L;
    private static final int RETRY_DELAY_MS = 2_000;
    private static final int MAX_ATTEMPTS_REVERSE = 3;

    private final RestTemplate restTemplate;
    private final Lock rateLimitLock = new ReentrantLock();
    private volatile long lastRequestTimeMs = 0;

    public GeocodeService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    private void throttle() {
        rateLimitLock.lock();
        try {
            long now = System.currentTimeMillis();
            long elapsed = now - lastRequestTimeMs;
            if (elapsed < MIN_REQUEST_INTERVAL_MS) {
                try {
                    Thread.sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new RuntimeException("Geocode request interrupted", e);
                }
            }
            lastRequestTimeMs = System.currentTimeMillis();
        } finally {
            rateLimitLock.unlock();
        }
    }

    /**
     * Geocode: address query → list of (lat, lon, displayName, address).
     */
    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> search(String query) {
        if (query == null || query.trim().isEmpty()) {
            return Collections.emptyList();
        }
        String url = UriComponentsBuilder.fromHttpUrl(NOMINATIM_BASE + "/search")
                .queryParam("format", "json")
                .queryParam("q", query.trim())
                .queryParam("limit", 10)
                .queryParam("addressdetails", 1)
                .build()
                .toUriString();

        HttpHeaders headers = new HttpHeaders();
        headers.set("User-Agent", USER_AGENT);
        headers.setAccept(Collections.singletonList(MediaType.APPLICATION_JSON));

        throttle();
        try {
            ResponseEntity<List> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    List.class
            );
            List<Map<String, Object>> raw = response.getBody();
            if (raw == null) return Collections.emptyList();

            List<Map<String, Object>> results = new ArrayList<>();
            for (Object item : raw) {
                if (!(item instanceof Map)) continue;
                Map<String, Object> m = (Map<String, Object>) item;
                Map<String, Object> out = new HashMap<>();
                out.put("lat", parseDouble(m.get("lat")));
                out.put("lon", parseDouble(m.get("lon")));
                out.put("displayName", m.get("display_name") != null ? m.get("display_name").toString() : "");
                out.put("address", m.get("address") != null ? m.get("address") : Collections.emptyMap());
                results.add(out);
            }
            log.debug("Geocode search for '{}' returned {} results", query, results.size());
            return results;
        } catch (HttpClientErrorException e) {
            if (e.getStatusCode() == HttpStatus.TOO_MANY_REQUESTS) {
                log.warn("Geocode search rate limited (429) for '{}'", query);
            } else {
                log.error("Geocode search failed for query '{}': {}", query, e.getMessage());
            }
            return Collections.emptyList();
        } catch (Exception e) {
            log.error("Geocode search failed for query '{}': {}", query, e.getMessage());
            throw new RuntimeException("Geocode search failed: " + e.getMessage(), e);
        }
    }

    /**
     * Reverse geocode: (lat, lon) → full Nominatim response (display_name, address, extratags, etc.)
     * plus displayName, lat, lon for compatibility.
     * On 429 or other client errors returns a fallback map so the API does not throw.
     */
    public Map<String, Object> reverse(double lat, double lon) {
        String url = UriComponentsBuilder.fromHttpUrl(NOMINATIM_BASE + "/reverse")
                .queryParam("format", "json")
                .queryParam("lat", lat)
                .queryParam("lon", lon)
                .queryParam("zoom", 18)
                .queryParam("addressdetails", 1)
                .build()
                .toUriString();

        HttpHeaders headers = new HttpHeaders();
        headers.set("User-Agent", USER_AGENT);
        headers.setAccept(Collections.singletonList(MediaType.APPLICATION_JSON));

        Map<String, Object> fallback = fallbackReverseResult(lat, lon);

        for (int attempt = 0; attempt < MAX_ATTEMPTS_REVERSE; attempt++) {
            throttle();
            try {
                ResponseEntity<Map> response = restTemplate.exchange(
                        url,
                        HttpMethod.GET,
                        new HttpEntity<>(headers),
                        Map.class
                );
                Map<String, Object> body = response.getBody();
                if (body == null) {
                    return fallback;
                }
                Object rawDisplayName = body.get("display_name");
                String displayNameStr = rawDisplayName != null ? rawDisplayName.toString().trim() : "";
                if (displayNameStr.isEmpty()) {
                    body.put("displayName", fallback.get("displayName"));
                    body.put("display_name", fallback.get("display_name"));
                } else {
                    body.put("displayName", displayNameStr);
                }
                body.put("lat", lat);
                body.put("lon", lon);
                log.debug("Reverse geocode for ({}, {}) returned: {}", lat, lon, body.get("display_name"));
                return body;
            } catch (HttpClientErrorException e) {
                if (e.getStatusCode() == HttpStatus.TOO_MANY_REQUESTS) {
                    log.warn("Reverse geocode rate limited (429) for ({}, {}), attempt {}", lat, lon, attempt + 1);
                    if (attempt < MAX_ATTEMPTS_REVERSE - 1) {
                        try {
                            Thread.sleep(RETRY_DELAY_MS);
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            return fallback;
                        }
                    } else {
                        return fallback;
                    }
                } else {
                    log.error("Reverse geocode failed for ({}, {}): {}", lat, lon, e.getMessage());
                    return fallback;
                }
            } catch (Exception e) {
                log.error("Reverse geocode failed for ({}, {}): {}", lat, lon, e.getMessage());
                throw new RuntimeException("Reverse geocode failed: " + e.getMessage(), e);
            }
        }
        return fallback;
    }

    private static Map<String, Object> fallbackReverseResult(double lat, double lon) {
        String coordsLabel = String.format("%.6f, %.6f", lat, lon);
        Map<String, Object> empty = new HashMap<>();
        empty.put("displayName", coordsLabel);
        empty.put("display_name", coordsLabel);
        empty.put("lat", lat);
        empty.put("lon", lon);
        return empty;
    }

    private static double parseDouble(Object o) {
        if (o == null) return 0;
        if (o instanceof Number) return ((Number) o).doubleValue();
        try {
            return Double.parseDouble(o.toString());
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
