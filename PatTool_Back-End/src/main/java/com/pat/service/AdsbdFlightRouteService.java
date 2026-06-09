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
 *
 * <p>Flight numbers often serve different routes on different days; the destination is only
 * accepted when adsbdb's origin ICAO matches the live OpenSky departure airport.</p>
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

    /**
     * Destination airport when adsbdb's planned origin matches {@code departureIcao}
     * (or when no departure is known yet).
     */
    public Optional<RouteAirport> destinationMatchingDeparture(String callsign, String departureIcao) {
        if (!enabled || callsign == null || callsign.isBlank()) {
            return Optional.empty();
        }
        if (!OpenSkyService.isValidCallsign(callsign)) {
            return Optional.empty();
        }
        Optional<PlannedRoute> route = plannedRouteForCallsign(callsign.trim().toUpperCase(Locale.ROOT));
        if (route.isEmpty()) {
            return Optional.empty();
        }
        PlannedRoute planned = route.get();
        if (planned.destination() == null) {
            return Optional.empty();
        }
        String dep = normalizeIcao(departureIcao);
        if (dep == null) {
            log.debug("adsbdb: skip {} — no live departure airport to validate route", callsign);
            return Optional.empty();
        }
        if (planned.origin() == null || planned.origin().icao() == null) {
            log.debug("adsbdb: skip {} — planned route has no origin", callsign);
            return Optional.empty();
        }
        if (!dep.equals(planned.origin().icao())) {
            log.debug(
                    "adsbdb: ignore route for {} — planned origin {} != live departure {}",
                    callsign, planned.origin().icao(), dep);
            return Optional.empty();
        }
        return Optional.of(planned.destination());
    }

    private Optional<PlannedRoute> plannedRouteForCallsign(String callsignUpper) {
        long now = System.currentTimeMillis();
        CacheEntry cached = cache.get(callsignUpper);
        if (cached != null && (now - cached.atMs) < CACHE_TTL_MS) {
            return cached.route == null ? Optional.empty() : Optional.of(cached.route);
        }
        PlannedRoute resolved = fetchPlannedRoute(callsignUpper);
        cache.put(callsignUpper, new CacheEntry(now, resolved));
        return resolved == null ? Optional.empty() : Optional.of(resolved);
    }

    private PlannedRoute fetchPlannedRoute(String callsignUpper) {
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
            JsonNode routeNode = objectMapper.readTree(response.getBody()).path("response").path("flightroute");
            if (routeNode.isMissingNode() || routeNode.isNull()) {
                return null;
            }
            RouteAirport origin = airportFromJson(routeNode.path("origin"));
            RouteAirport destination = airportFromJson(routeNode.path("destination"));
            if (destination == null) {
                return null;
            }
            return new PlannedRoute(origin, destination);
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
        if (node == null || node.isMissingNode() || node.isNull()) {
            return null;
        }
        String icao = normalizeIcao(textOrNull(node, "icao_code"));
        if (icao == null) {
            return null;
        }
        return new RouteAirport(
                icao,
                textOrNull(node, "iata_code"),
                textOrNull(node, "name"),
                textOrNull(node, "municipality"),
                textOrNull(node, "country_name"));
    }

    private static String normalizeIcao(String icao) {
        if (icao == null || icao.isBlank() || icao.length() != 4) {
            return null;
        }
        return icao.trim().toUpperCase(Locale.ROOT);
    }

    private static String textOrNull(JsonNode node, String field) {
        if (node == null || !node.has(field) || node.get(field).isNull()) {
            return null;
        }
        String v = node.get(field).asText().trim();
        return v.isEmpty() ? null : v;
    }

    public record RouteAirport(String icao, String iata, String name, String city, String country) {}

    public record PlannedRoute(RouteAirport origin, RouteAirport destination) {}

    private record CacheEntry(long atMs, PlannedRoute route) {}
}
