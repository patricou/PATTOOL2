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
    private static final String PHOTON_BASE = "https://photon.komoot.io";
    private static final String OPEN_METEO_GEO_REVERSE = "https://geocoding-api.open-meteo.com/v1/reverse";
    private static final long SEARCH_CACHE_TTL_MS = 15 * 60 * 1000L;
    private static final long REVERSE_CACHE_TTL_MS = 15 * 60 * 1000L;
    private static final int SEARCH_CACHE_MAX_ENTRIES = 256;
    private static final int REVERSE_CACHE_MAX_ENTRIES = 512;

    private final RestTemplate restTemplate;
    private final Lock rateLimitLock = new ReentrantLock();
    private volatile long lastRequestTimeMs = 0;
    private final Lock searchCacheLock = new ReentrantLock();
    private final Lock reverseCacheLock = new ReentrantLock();
    /** LRU cache: normalized query → (timestamp, results). Hits skip Nominatim entirely. */
    private final Map<String, SearchCacheEntry> searchCache = new LinkedHashMap<>(64, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, SearchCacheEntry> eldest) {
            return size() > SEARCH_CACHE_MAX_ENTRIES;
        }
    };

    private static final class SearchCacheEntry {
        final long createdAtMs;
        final List<Map<String, Object>> results;

        SearchCacheEntry(long createdAtMs, List<Map<String, Object>> results) {
            this.createdAtMs = createdAtMs;
            this.results = results;
        }
    }

    private static final class ReverseCacheEntry {
        final long createdAtMs;
        final Map<String, Object> result;

        ReverseCacheEntry(long createdAtMs, Map<String, Object> result) {
            this.createdAtMs = createdAtMs;
            this.result = result;
        }
    }

    /** LRU cache: lat,lon → reverse geocode result (any provider). */
    private final Map<String, ReverseCacheEntry> reverseCache = new LinkedHashMap<>(64, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, ReverseCacheEntry> eldest) {
            return size() > REVERSE_CACHE_MAX_ENTRIES;
        }
    };

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
        String cacheKey = normalizeSearchKey(query);
        List<Map<String, Object>> cached = getCachedSearch(cacheKey);
        if (cached != null) {
            log.debug("Geocode search cache hit for '{}'", query.trim());
            return cached;
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
                if (m.get("boundingbox") != null) {
                    out.put("boundingBox", m.get("boundingbox"));
                }
                results.add(out);
            }
            log.debug("Geocode search for '{}' returned {} results", query, results.size());
            putCachedSearch(cacheKey, results);
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

    private static String normalizeSearchKey(String query) {
        return query.trim().toLowerCase(Locale.ROOT);
    }

    private List<Map<String, Object>> getCachedSearch(String cacheKey) {
        long now = System.currentTimeMillis();
        searchCacheLock.lock();
        try {
            SearchCacheEntry entry = searchCache.get(cacheKey);
            if (entry == null || now - entry.createdAtMs > SEARCH_CACHE_TTL_MS) {
                if (entry != null) {
                    searchCache.remove(cacheKey);
                }
                return null;
            }
            return copySearchResults(entry.results);
        } finally {
            searchCacheLock.unlock();
        }
    }

    private void putCachedSearch(String cacheKey, List<Map<String, Object>> results) {
        searchCacheLock.lock();
        try {
            searchCache.put(cacheKey, new SearchCacheEntry(System.currentTimeMillis(), copySearchResults(results)));
        } finally {
            searchCacheLock.unlock();
        }
    }

    private static List<Map<String, Object>> copySearchResults(List<Map<String, Object>> results) {
        if (results == null || results.isEmpty()) {
            return Collections.emptyList();
        }
        List<Map<String, Object>> copy = new ArrayList<>(results.size());
        for (Map<String, Object> item : results) {
            copy.add(item == null ? Collections.emptyMap() : new LinkedHashMap<>(item));
        }
        return copy;
    }

    /**
     * Reverse geocode: (lat, lon) → display name and address fields.
     * Tries Nominatim first, then Photon and Open-Meteo as fallbacks when rate-limited or unavailable.
     */
    public Map<String, Object> reverse(double lat, double lon) {
        Map<String, Object> cached = getCachedReverse(lat, lon);
        if (cached != null) {
            log.debug("Reverse geocode cache hit for ({}, {})", lat, lon);
            return cached;
        }

        Map<String, Object> nominatim = reverseViaNominatim(lat, lon);
        if (nominatim != null) {
            putCachedReverse(lat, lon, nominatim);
            return nominatim;
        }

        Map<String, Object> photon = reverseViaPhoton(lat, lon);
        if (photon != null) {
            log.info("Reverse geocode fallback (Photon) for ({}, {}): {}", lat, lon, photon.get("display_name"));
            putCachedReverse(lat, lon, photon);
            return photon;
        }

        Map<String, Object> openMeteo = reverseViaOpenMeteo(lat, lon);
        if (openMeteo != null) {
            log.info("Reverse geocode fallback (Open-Meteo) for ({}, {}): {}", lat, lon, openMeteo.get("display_name"));
            putCachedReverse(lat, lon, openMeteo);
            return openMeteo;
        }

        Map<String, Object> fallback = fallbackReverseResult(lat, lon);
        putCachedReverse(lat, lon, fallback);
        return fallback;
    }

    private Map<String, Object> reverseViaNominatim(double lat, double lon) {
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
                    return null;
                }
                Object rawDisplayName = body.get("display_name");
                String displayNameStr = rawDisplayName != null ? rawDisplayName.toString().trim() : "";
                if (displayNameStr.isEmpty()) {
                    return null;
                }
                body.put("displayName", displayNameStr);
                body.put("lat", lat);
                body.put("lon", lon);
                body.put("geocodeSource", "nominatim");
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
                            return null;
                        }
                    } else {
                        return null;
                    }
                } else {
                    log.error("Reverse geocode failed for ({}, {}): {}", lat, lon, e.getMessage());
                    return null;
                }
            } catch (Exception e) {
                log.error("Reverse geocode failed for ({}, {}): {}", lat, lon, e.getMessage());
                return null;
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> reverseViaPhoton(double lat, double lon) {
        String url = UriComponentsBuilder.fromHttpUrl(PHOTON_BASE + "/reverse")
                .queryParam("lat", lat)
                .queryParam("lon", lon)
                .queryParam("lang", "fr")
                .build()
                .toUriString();
        try {
            ResponseEntity<Map> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(new HttpHeaders()),
                    Map.class
            );
            Map<String, Object> body = response.getBody();
            if (body == null) {
                return null;
            }
            Object featuresObj = body.get("features");
            if (!(featuresObj instanceof List) || ((List<?>) featuresObj).isEmpty()) {
                return null;
            }
            Object featureObj = ((List<?>) featuresObj).get(0);
            if (!(featureObj instanceof Map)) {
                return null;
            }
            Object propsObj = ((Map<String, Object>) featureObj).get("properties");
            if (!(propsObj instanceof Map)) {
                return null;
            }
            Map<String, Object> props = (Map<String, Object>) propsObj;
            String displayName = buildLabelFromPhotonProperties(props);
            if (displayName.isEmpty()) {
                return null;
            }
            Map<String, Object> out = new HashMap<>();
            out.put("displayName", displayName);
            out.put("display_name", displayName);
            out.put("lat", lat);
            out.put("lon", lon);
            out.put("geocodeSource", "photon");
            out.put("address", props);
            return out;
        } catch (Exception e) {
            log.debug("Photon reverse geocode failed for ({}, {}): {}", lat, lon, e.getMessage());
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> reverseViaOpenMeteo(double lat, double lon) {
        String url = UriComponentsBuilder.fromHttpUrl(OPEN_METEO_GEO_REVERSE)
                .queryParam("latitude", lat)
                .queryParam("longitude", lon)
                .queryParam("language", "fr")
                .build()
                .toUriString();
        try {
            ResponseEntity<Map> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(new HttpHeaders()),
                    Map.class
            );
            Map<String, Object> body = response.getBody();
            if (body == null) {
                return null;
            }
            Object resultsObj = body.get("results");
            if (!(resultsObj instanceof List) || ((List<?>) resultsObj).isEmpty()) {
                return null;
            }
            Object first = ((List<?>) resultsObj).get(0);
            if (!(first instanceof Map)) {
                return null;
            }
            Map<String, Object> hit = (Map<String, Object>) first;
            String displayName = buildLabelFromOpenMeteoResult(hit);
            if (displayName.isEmpty()) {
                return null;
            }
            Map<String, Object> out = new HashMap<>();
            out.put("displayName", displayName);
            out.put("display_name", displayName);
            out.put("lat", lat);
            out.put("lon", lon);
            out.put("geocodeSource", "open-meteo");
            out.put("address", hit);
            return out;
        } catch (Exception e) {
            log.debug("Open-Meteo reverse geocode failed for ({}, {}): {}", lat, lon, e.getMessage());
            return null;
        }
    }

    private static String buildLabelFromPhotonProperties(Map<String, Object> props) {
        List<String> parts = new ArrayList<>();
        appendIfPresent(parts, props.get("name"));
        appendIfPresent(parts, props.get("street"));
        appendIfPresent(parts, props.get("city"));
        appendIfPresent(parts, props.get("county"));
        appendIfPresent(parts, props.get("country"));
        if (parts.isEmpty()) {
            return "";
        }
        return String.join(", ", parts);
    }

    private static String buildLabelFromOpenMeteoResult(Map<String, Object> hit) {
        List<String> parts = new ArrayList<>();
        appendIfPresent(parts, hit.get("name"));
        appendIfPresent(parts, hit.get("admin1"));
        appendIfPresent(parts, hit.get("country"));
        if (parts.isEmpty()) {
            return "";
        }
        return String.join(", ", parts);
    }

    private static void appendIfPresent(List<String> parts, Object value) {
        if (value == null) {
            return;
        }
        String text = value.toString().trim();
        if (text.isEmpty()) {
            return;
        }
        if (!parts.contains(text)) {
            parts.add(text);
        }
    }

    private static String reverseCacheKey(double lat, double lon) {
        return String.format(Locale.ENGLISH, "%.4f,%.4f", lat, lon);
    }

    private Map<String, Object> getCachedReverse(double lat, double lon) {
        String key = reverseCacheKey(lat, lon);
        long now = System.currentTimeMillis();
        reverseCacheLock.lock();
        try {
            ReverseCacheEntry entry = reverseCache.get(key);
            if (entry == null || now - entry.createdAtMs > REVERSE_CACHE_TTL_MS) {
                if (entry != null) {
                    reverseCache.remove(key);
                }
                return null;
            }
            return new LinkedHashMap<>(entry.result);
        } finally {
            reverseCacheLock.unlock();
        }
    }

    private void putCachedReverse(double lat, double lon, Map<String, Object> result) {
        if (result == null || result.isEmpty()) {
            return;
        }
        String key = reverseCacheKey(lat, lon);
        reverseCacheLock.lock();
        try {
            reverseCache.put(key, new ReverseCacheEntry(System.currentTimeMillis(), new LinkedHashMap<>(result)));
        } finally {
            reverseCacheLock.unlock();
        }
    }

    private static Map<String, Object> fallbackReverseResult(double lat, double lon) {
        String coordsLabel = String.format(Locale.ENGLISH, "%.6f, %.6f", lat, lon);
        Map<String, Object> empty = new HashMap<>();
        empty.put("displayName", coordsLabel);
        empty.put("display_name", coordsLabel);
        empty.put("lat", lat);
        empty.put("lon", lon);
        empty.put("geocodeSource", "fallback");
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
