package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.config.RestTemplateConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;

import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Planned route lookup via the public <a href="https://www.adsbdb.com">adsbdb.com</a> API.
 * Used when OpenSky omits {@code estArrivalAirport} for an in-progress flight.
 */
@Service
public class AdsbdFlightRouteService {

    private static final Logger log = LoggerFactory.getLogger(AdsbdFlightRouteService.class);
    private static final long CACHE_TTL_MS = 6 * 3_600_000L;

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final boolean enabled;
    private final String baseUrl;

    private final ConcurrentHashMap<String, CacheEntry> cache = new ConcurrentHashMap<>();

    public AdsbdFlightRouteService(
            @Qualifier(RestTemplateConfig.GLOBE_PROXY_REST_TEMPLATE) RestTemplate globeProxyRestTemplate,
            ObjectMapper objectMapper,
            @Value("${flight.adsbdb.enabled:true}") boolean enabled,
            @Value("${flight.adsbdb.base-url:https://api.adsbdb.com/v0}") String baseUrl) {
        this.restTemplate = globeProxyRestTemplate;
        this.objectMapper = objectMapper;
        this.enabled = enabled;
        this.baseUrl = baseUrl.replaceAll("/+$", "");
    }

    /** Destination airport for a radio callsign / flight number (e.g. {@code RYR2DD}). */
    public Optional<RouteAirport> destinationForCallsign(String callsign) {
        if (!enabled || callsign == null || callsign.isBlank()) {
            return Optional.empty();
        }
        if (!OpenSkyService.isValidCallsign(callsign)) {
            return Optional.empty();
        }
        String key = callsign.trim().toUpperCase(Locale.ROOT);
        long now = System.currentTimeMillis();
        CacheEntry cached = cache.get(key);
        if (cached != null && (now - cached.atMs) < CACHE_TTL_MS) {
            return cached.airport == null ? Optional.empty() : Optional.of(cached.airport);
        }
        RouteAirport resolved = fetchDestination(key);
        cache.put(key, new CacheEntry(now, resolved));
        return resolved == null ? Optional.empty() : Optional.of(resolved);
    }

    private RouteAirport fetchDestination(String callsignUpper) {
        String url = baseUrl + "/callsign/" + callsignUpper;
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.USER_AGENT, "PATTOOL-GlobeProxy/1.0");
        headers.set(HttpHeaders.ACCEPT, "application/json");
        try {
            ResponseEntity<String> response = restTemplate.exchange(
                    url, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                return null;
            }
            JsonNode dest = objectMapper.readTree(response.getBody())
                    .path("response").path("flightroute").path("destination");
            if (dest.isMissingNode() || dest.isNull()) {
                return null;
            }
            return airportFromJson(dest);
        } catch (HttpClientErrorException e) {
            if (e.getStatusCode().value() == 404) {
                log.debug("adsbdb: no route for callsign {}", callsignUpper);
                return null;
            }
            log.debug("adsbdb route lookup failed for {}: {}", callsignUpper, e.getMessage());
            return null;
        } catch (Exception e) {
            log.debug("adsbdb route lookup failed for {}: {}", callsignUpper, e.getMessage());
            return null;
        }
    }

    private static RouteAirport airportFromJson(JsonNode node) {
        String icao = textOrNull(node, "icao_code");
        if (icao == null) {
            return null;
        }
        return new RouteAirport(
                icao,
                textOrNull(node, "iata_code"),
                textOrNull(node, "name"),
                textOrNull(node, "municipality"));
    }

    private static String textOrNull(JsonNode node, String field) {
        if (node == null || !node.has(field) || node.get(field).isNull()) {
            return null;
        }
        String v = node.get(field).asText().trim();
        return v.isEmpty() ? null : v;
    }

    public record RouteAirport(String icao, String iata, String name, String city) {}

    private record CacheEntry(long atMs, RouteAirport airport) {}
}
