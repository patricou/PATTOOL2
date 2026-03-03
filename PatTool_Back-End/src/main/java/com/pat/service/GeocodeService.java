package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.util.*;

@Service
public class GeocodeService {

    private static final Logger log = LoggerFactory.getLogger(GeocodeService.class);
    private static final String NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
    private static final String USER_AGENT = "PATTOOL Address Geocode";

    private final RestTemplate restTemplate;

    public GeocodeService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
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
        } catch (Exception e) {
            log.error("Geocode search failed for query '{}': {}", query, e.getMessage());
            throw new RuntimeException("Geocode search failed: " + e.getMessage(), e);
        }
    }

    /**
     * Reverse geocode: (lat, lon) → full Nominatim response (display_name, address, extratags, etc.)
     * plus displayName, lat, lon for compatibility.
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

        try {
            ResponseEntity<Map> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    Map.class
            );
            Map<String, Object> body = response.getBody();
            if (body == null) {
                Map<String, Object> empty = new HashMap<>();
                empty.put("displayName", "");
                empty.put("display_name", "");
                empty.put("lat", lat);
                empty.put("lon", lon);
                return empty;
            }
            body.put("displayName", body.get("display_name") != null ? body.get("display_name").toString() : "");
            body.put("lat", lat);
            body.put("lon", lon);
            log.debug("Reverse geocode for ({}, {}) returned: {}", lat, lon, body.get("display_name"));
            return body;
        } catch (Exception e) {
            log.error("Reverse geocode failed for ({}, {}): {}", lat, lon, e.getMessage());
            throw new RuntimeException("Reverse geocode failed: " + e.getMessage(), e);
        }
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
