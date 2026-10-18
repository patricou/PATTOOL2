package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.config.RestTemplateConfig;
import com.pat.controller.dto.FlightStateDto;
import com.pat.controller.dto.FlightTrackDto;
import com.pat.controller.dto.FlightTrackPointDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Reads a live flight from the public FlightAware page ({@code /live/flight/{ident}}).
 * The HTML embeds {@code trackpollBootstrap} with current position and the flown track
 * (including oceanic estimates), which OpenSky cannot see.
 */
@Service
public class FlightAwareLiveService {

    private static final Logger log = LoggerFactory.getLogger(FlightAwareLiveService.class);
    private static final String BOOTSTRAP_MARKER = "trackpollBootstrap = ";
    private static final double FT_TO_M = 0.3048;
    private static final double KT_TO_MS = 0.514444;
    private static final int MAX_TRACK_POINTS = 1200;
    /** Common IATA airline prefixes → ICAO (FlightAware URLs require ICAO, e.g. AFR501 not AF501). */
    private static final Map<String, String> IATA_TO_ICAO = iataToIcao();

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final AirportLookupService airportLookup;
    private final boolean enabled;
    private final String baseUrl;
    private final long cacheTtlMs;

    private volatile CachedFlight cache;
    private volatile long retryAfterMs;
    private final Object fetchLock = new Object();

    public FlightAwareLiveService(
            @Qualifier(RestTemplateConfig.GLOBE_PROXY_REST_TEMPLATE) RestTemplate globeProxyRestTemplate,
            ObjectMapper objectMapper,
            AirportLookupService airportLookup,
            @Value("${flight.flightaware.enabled:true}") boolean enabled,
            @Value("${flight.flightaware.base-url:https://fr.flightaware.com}") String baseUrl,
            @Value("${flight.flightaware.cache-seconds:45}") long cacheSeconds) {
        this.restTemplate = globeProxyRestTemplate;
        this.objectMapper = objectMapper;
        this.airportLookup = airportLookup;
        this.enabled = enabled;
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.cacheTtlMs = Math.max(15, cacheSeconds) * 1000L;
    }

    public Optional<FlightStateDto> fetchByCallsign(String callsign) {
        return snapshot(callsign).map(CachedFlight::state);
    }

    public Optional<FlightTrackDto> fetchTrackByCallsign(String callsign) {
        return snapshot(callsign).map(CachedFlight::track).filter(t -> t.points() != null && !t.points().isEmpty());
    }

    private Optional<CachedFlight> snapshot(String callsign) {
        if (!enabled) {
            return Optional.empty();
        }
        String ident = toFlightAwareIdent(callsign);
        if (ident == null) {
            return Optional.empty();
        }
        long now = System.currentTimeMillis();
        CachedFlight cached = this.cache;
        if (cached != null && ident.equals(cached.ident) && (now - cached.atMs) < cacheTtlMs) {
            return Optional.of(cached);
        }
        if (now < this.retryAfterMs) {
            if (cached != null && ident.equals(cached.ident)) {
                return Optional.of(cached);
            }
            return Optional.empty();
        }
        synchronized (fetchLock) {
            now = System.currentTimeMillis();
            cached = this.cache;
            if (cached != null && ident.equals(cached.ident) && (now - cached.atMs) < cacheTtlMs) {
                return Optional.of(cached);
            }
            Optional<CachedFlight> fresh = fetchAndParse(ident, now);
            fresh.ifPresent(value -> this.cache = value);
            return fresh;
        }
    }

    private Optional<CachedFlight> fetchAndParse(String ident, long now) {
        String url = baseUrl + "/live/flight/" + ident;
        String html = getHtml(url);
        if (html == null || html.isBlank()) {
            return Optional.empty();
        }
        String json = extractJsObject(html, BOOTSTRAP_MARKER);
        if (json == null) {
            log.debug("FlightAware: no trackpollBootstrap for {}", ident);
            return Optional.empty();
        }
        try {
            JsonNode root = objectMapper.readTree(json);
            JsonNode flights = root.get("flights");
            if (flights == null || !flights.isObject() || flights.isEmpty()) {
                return Optional.empty();
            }
            JsonNode flight = flights.elements().next();
            if (flight == null || flight.path("unknown").asBoolean(false) || flight.path("blocked").asBoolean(false)) {
                return Optional.empty();
            }
            List<FlightTrackPointDto> points = trackPoints(flight.get("track"));
            if (points.isEmpty()) {
                return Optional.empty();
            }
            FlightTrackPointDto last = points.get(points.size() - 1);
            FlightStateDto state = toState(flight, ident, last);
            if (state.latitude() == null || state.longitude() == null) {
                return Optional.empty();
            }
            FlightTrackDto track = new FlightTrackDto(
                    state.icao24(),
                    state.callsign(),
                    points.get(0).time(),
                    last.time(),
                    points);
            return Optional.of(new CachedFlight(now, ident, state, track));
        } catch (Exception e) {
            log.warn("FlightAware parse failed for {}: {}", ident, e.getMessage());
            return Optional.empty();
        }
    }

    private FlightStateDto toState(JsonNode flight, String ident, FlightTrackPointDto last) {
        JsonNode origin = flight.get("origin");
        JsonNode dest = flight.get("destination");
        String status = text(flight, "flightStatus");
        boolean onGround = "arrived".equalsIgnoreCase(status) || "taxiing".equalsIgnoreCase(status);

        Double altM = last.baroAltitudeM();
        Double heading = last.trueTrackDeg();
        Double speedMs = null;
        JsonNode lastRaw = lastTrackNode(flight.get("track"));
        if (lastRaw != null && lastRaw.has("gs") && lastRaw.get("gs").isNumber()) {
            speedMs = knotsToMs(lastRaw.get("gs").asDouble());
        }
        if (flight.has("altitude") && flight.get("altitude").isNumber()) {
            altM = flightLevelToMeters(flight.get("altitude").asDouble());
        }
        if (flight.has("groundspeed") && flight.get("groundspeed").isNumber()) {
            speedMs = knotsToMs(flight.get("groundspeed").asDouble());
        }
        if (flight.has("heading") && flight.get("heading").isNumber()) {
            heading = flight.get("heading").asDouble();
        }

        String depIcao = text(origin, "icao");
        String arrIcao = text(dest, "icao");
        AirportLookupService.AirportInfo depInfo = airportLookup.forIcao(depIcao).orElse(null);
        AirportLookupService.AirportInfo arrInfo = airportLookup.forIcao(arrIcao).orElse(null);

        String depName = firstNonBlank(text(origin, "friendlyName"), depInfo != null ? depInfo.name() : null);
        String arrName = firstNonBlank(text(dest, "friendlyName"), arrInfo != null ? arrInfo.name() : null);
        String depIata = firstNonBlank(text(origin, "iata"), depInfo != null ? depInfo.iata() : null);
        String arrIata = firstNonBlank(text(dest, "iata"), arrInfo != null ? arrInfo.iata() : null);
        String depCity = firstNonBlank(cityFromLocation(text(origin, "friendlyLocation")), depInfo != null ? depInfo.city() : null);
        String arrCity = firstNonBlank(cityFromLocation(text(dest, "friendlyLocation")), arrInfo != null ? arrInfo.city() : null);
        String arrCountry = firstNonBlank(countryFromLocation(text(dest, "friendlyLocation")), arrInfo != null ? arrInfo.country() : null);
        String originCountry = firstNonBlank(
                countryFromLocation(text(origin, "friendlyLocation")),
                depInfo != null ? depInfo.country() : null);

        Long depEpoch = firstPositive(
                epoch(flight.path("takeoffTimes"), "actual"),
                epoch(flight.path("takeoffTimes"), "estimated"),
                epoch(flight.path("gateDepartureTimes"), "actual"),
                epoch(flight.path("gateDepartureTimes"), "estimated"),
                epoch(flight.path("gateDepartureTimes"), "scheduled"));
        Long arrEpoch = firstPositive(
                epoch(flight.path("landingTimes"), "actual"),
                epoch(flight.path("landingTimes"), "estimated"),
                epoch(flight.path("gateArrivalTimes"), "actual"),
                epoch(flight.path("gateArrivalTimes"), "estimated"),
                epoch(flight.path("gateArrivalTimes"), "scheduled"));

        String callsign = firstNonBlank(text(flight, "ident"), ident);
        return new FlightStateDto(
                null,
                callsign,
                originCountry,
                last.latitude(),
                last.longitude(),
                altM,
                altM,
                speedMs,
                heading,
                null,
                onGround,
                last.time(),
                depIcao,
                arrIcao,
                depName,
                arrName,
                depIata,
                arrIata,
                depCity,
                arrCity,
                arrCountry,
                depEpoch,
                arrEpoch,
                "flightaware");
    }

    private List<FlightTrackPointDto> trackPoints(JsonNode track) {
        List<FlightTrackPointDto> points = new ArrayList<>();
        if (track == null || !track.isArray()) {
            return points;
        }
        Double lastAlt = null;
        for (JsonNode wp : track) {
            double[] coord = lngLat(wp.get("coord"));
            if (coord == null) {
                continue;
            }
            Double altM = null;
            if (wp.has("alt") && wp.get("alt").isNumber()) {
                altM = flightLevelToMeters(wp.get("alt").asDouble());
                lastAlt = altM;
            } else {
                altM = lastAlt;
            }
            points.add(new FlightTrackPointDto(
                    wp.has("timestamp") && wp.get("timestamp").isNumber() ? wp.get("timestamp").asLong() : null,
                    coord[1],
                    coord[0],
                    altM,
                    null,
                    Boolean.FALSE));
        }
        return decimate(points);
    }

    private static List<FlightTrackPointDto> decimate(List<FlightTrackPointDto> points) {
        int n = points.size();
        if (n <= MAX_TRACK_POINTS) {
            return points;
        }
        int step = (int) Math.ceil(n / (double) MAX_TRACK_POINTS);
        List<FlightTrackPointDto> out = new ArrayList<>(MAX_TRACK_POINTS);
        for (int i = 0; i < n; i += step) {
            out.add(points.get(i));
        }
        FlightTrackPointDto last = points.get(n - 1);
        if (out.isEmpty() || out.get(out.size() - 1) != last) {
            out.add(last);
        }
        return out;
    }

    private static JsonNode lastTrackNode(JsonNode track) {
        if (track == null || !track.isArray() || track.isEmpty()) {
            return null;
        }
        return track.get(track.size() - 1);
    }

    private String getHtml(String url) {
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.USER_AGENT,
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36");
        headers.set(HttpHeaders.ACCEPT, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8");
        headers.set(HttpHeaders.ACCEPT_LANGUAGE, "fr-FR,fr;q=0.9,en;q=0.8");
        try {
            ResponseEntity<String> response = restTemplate.exchange(
                    url, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                noteBackoff(response.getStatusCode().value());
                log.debug("FlightAware HTTP {} for {}", response.getStatusCode().value(), url);
                return null;
            }
            return response.getBody();
        } catch (HttpStatusCodeException e) {
            noteBackoff(e.getStatusCode().value());
            log.warn("FlightAware HTTP {} for {}", e.getStatusCode().value(), url);
            return null;
        } catch (RestClientException e) {
            log.warn("FlightAware fetch failed for {}: {}", url, e.getMessage());
            return null;
        }
    }

    private void noteBackoff(int status) {
        if (status == 402 || status == 403 || status == 429) {
            this.retryAfterMs = System.currentTimeMillis() + 120_000L;
            log.warn("FlightAware blocked or rate-limited (HTTP {}); backing off 120 s", status);
        }
    }

    static String toFlightAwareIdent(String raw) {
        if (raw == null) {
            return null;
        }
        String cs = raw.trim().toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "");
        if (cs.length() < 2 || cs.length() > 8) {
            return null;
        }
        if (cs.length() >= 3 && Character.isLetter(cs.charAt(0)) && Character.isLetter(cs.charAt(1))
                && Character.isDigit(cs.charAt(2))) {
            String icao = IATA_TO_ICAO.get(cs.substring(0, 2));
            if (icao != null) {
                String expanded = icao + cs.substring(2);
                if (expanded.length() <= 8) {
                    return expanded;
                }
            }
        }
        return cs;
    }

    static String extractJsObject(String html, String marker) {
        if (html == null || marker == null) {
            return null;
        }
        int start = html.indexOf(marker);
        if (start < 0) {
            return null;
        }
        start += marker.length();
        while (start < html.length() && html.charAt(start) != '{') {
            start++;
        }
        if (start >= html.length()) {
            return null;
        }
        int depth = 0;
        boolean inStr = false;
        boolean esc = false;
        for (int i = start; i < html.length(); i++) {
            char c = html.charAt(i);
            if (inStr) {
                if (esc) {
                    esc = false;
                } else if (c == '\\') {
                    esc = true;
                } else if (c == '"') {
                    inStr = false;
                }
                continue;
            }
            if (c == '"') {
                inStr = true;
                continue;
            }
            if (c == '{') {
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0) {
                    return html.substring(start, i + 1);
                }
            }
        }
        return null;
    }

    private static double[] lngLat(JsonNode coord) {
        if (coord == null || !coord.isArray() || coord.size() < 2) {
            return null;
        }
        if (!coord.get(0).isNumber() || !coord.get(1).isNumber()) {
            return null;
        }
        double lon = coord.get(0).asDouble();
        double lat = coord.get(1).asDouble();
        if (!Double.isFinite(lat) || !Double.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            return null;
        }
        return new double[] {lon, lat};
    }

    private static Double flightLevelToMeters(double fl) {
        if (!Double.isFinite(fl) || fl < 0 || fl > 600) {
            return null;
        }
        return fl * 100.0 * FT_TO_M;
    }

    private static Double knotsToMs(double kt) {
        if (!Double.isFinite(kt) || kt < 0 || kt > 800) {
            return null;
        }
        return kt * KT_TO_MS;
    }

    private static String text(JsonNode node, String field) {
        if (node == null || !node.has(field) || node.get(field).isNull()) {
            return null;
        }
        String v = node.get(field).asText("").trim();
        return v.isEmpty() ? null : v;
    }

    private static Long epoch(JsonNode times, String field) {
        if (times == null || !times.has(field) || times.get(field).isNull() || !times.get(field).isNumber()) {
            return null;
        }
        long v = times.get(field).asLong(0);
        return v > 0 ? v : null;
    }

    private static Long firstPositive(Long... values) {
        if (values == null) {
            return null;
        }
        for (Long v : values) {
            if (v != null && v > 0) {
                return v;
            }
        }
        return null;
    }

    private static String firstNonBlank(String... values) {
        if (values == null) {
            return null;
        }
        for (String v : values) {
            if (v != null && !v.isBlank()) {
                return v.trim();
            }
        }
        return null;
    }

    private static String cityFromLocation(String location) {
        if (location == null || location.isBlank()) {
            return null;
        }
        int comma = location.lastIndexOf(',');
        if (comma <= 0) {
            return location.trim();
        }
        return location.substring(0, comma).trim();
    }

    private static String countryFromLocation(String location) {
        if (location == null || location.isBlank()) {
            return null;
        }
        int comma = location.lastIndexOf(',');
        if (comma < 0 || comma >= location.length() - 1) {
            return null;
        }
        return location.substring(comma + 1).trim();
    }

    private static Map<String, String> iataToIcao() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("AF", "AFR");
        m.put("AA", "AAL");
        m.put("UA", "UAL");
        m.put("DL", "DAL");
        m.put("BA", "BAW");
        m.put("LH", "DLH");
        m.put("KL", "KLM");
        m.put("IB", "IBE");
        m.put("AZ", "ITY");
        m.put("LX", "SWR");
        m.put("OS", "AUA");
        m.put("SN", "BEL");
        m.put("TP", "TAP");
        m.put("SK", "SAS");
        m.put("AY", "FIN");
        m.put("DY", "NAX");
        m.put("U2", "EZY");
        m.put("FR", "RYR");
        m.put("W6", "WZZ");
        m.put("VS", "VIR");
        m.put("EK", "UAE");
        m.put("QR", "QTR");
        m.put("QF", "QFA");
        m.put("SQ", "SIA");
        m.put("CX", "CPA");
        m.put("NH", "ANA");
        m.put("JL", "JAL");
        m.put("AC", "ACA");
        m.put("WN", "SWA");
        m.put("B6", "JBU");
        m.put("AS", "ASA");
        return Map.copyOf(m);
    }

    private record CachedFlight(long atMs, String ident, FlightStateDto state, FlightTrackDto track) {}
}
