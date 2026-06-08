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
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Flight tracking proxy backed by the OpenSky Network REST API.
 *
 * <p>The browser never calls OpenSky directly (CORS + quota + optional server-side credentials).
 * Two search modes are supported:</p>
 * <ul>
 *   <li>by {@code icao24} (24-bit hex) — native OpenSky filter, lightweight;</li>
 *   <li>by {@code callsign} (callsign / flight number) — OpenSky has no dedicated filter, so we
 *       fetch the full {@code states/all} snapshot (cached for a few seconds to spare quota)
 *       and filter by callsign.</li>
 * </ul>
 *
 * <p>Works anonymously (limited quota). If {@code opensky.client-id}/{@code opensky.client-secret}
 * are configured, an OAuth2 token (client credentials) is obtained and attached to requests
 * (extended quota).</p>
 */
@Service
public class OpenSkyService {

    private static final Logger log = LoggerFactory.getLogger(OpenSkyService.class);

    private static final Pattern ICAO24_RE = Pattern.compile("^[0-9a-f]{6}$");
    private static final Pattern CALLSIGN_RE = Pattern.compile("^[A-Z0-9]{2,8}$");
    /** Field indices in an OpenSky state vector (states/all). */
    private static final int I_ICAO24 = 0;
    private static final int I_CALLSIGN = 1;
    private static final int I_ORIGIN = 2;
    private static final int I_LAST_CONTACT = 4;
    private static final int I_LON = 5;
    private static final int I_LAT = 6;
    private static final int I_BARO_ALT = 7;
    private static final int I_ON_GROUND = 8;
    private static final int I_VELOCITY = 9;
    private static final int I_TRUE_TRACK = 10;
    private static final int I_VERT_RATE = 11;
    private static final int I_GEO_ALT = 13;

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    private final String baseUrl;
    private final String tokenUrl;
    private final String clientId;
    private final String clientSecret;
    /** Cache TTL (s) for the full states/all snapshot (callsign search). */
    private final long allStatesCacheSeconds;
    /** Max age (s) of a stale states/all snapshot used when OpenSky is rate-limited. */
    private final long allStatesStaleMaxSeconds;

    // Simple cache of the full snapshot (callsign search).
    private volatile JsonNode cachedAllStates;
    private volatile long cachedAllStatesAtMs;
    private volatile long openSkyRetryAfterMs;
    private final Object allStatesLock = new Object();

    // OAuth2 token cache (when credentials are configured).
    private volatile String cachedToken;
    private volatile long cachedTokenExpiryMs;

    public OpenSkyService(
            @Qualifier(RestTemplateConfig.GLOBE_PROXY_REST_TEMPLATE) RestTemplate globeProxyRestTemplate,
            ObjectMapper objectMapper,
            @Value("${opensky.base-url:https://opensky-network.org/api}") String baseUrl,
            @Value("${opensky.token-url:https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token}") String tokenUrl,
            @Value("${opensky.client-id:}") String clientId,
            @Value("${opensky.client-secret:}") String clientSecret,
            @Value("${opensky.all-states-cache-seconds:30}") long allStatesCacheSeconds,
            @Value("${opensky.all-states-stale-max-seconds:900}") long allStatesStaleMaxSeconds) {
        this.restTemplate = globeProxyRestTemplate;
        this.objectMapper = objectMapper;
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.tokenUrl = tokenUrl;
        this.clientId = clientId == null ? "" : clientId.trim();
        this.clientSecret = clientSecret == null ? "" : clientSecret.trim();
        this.allStatesCacheSeconds = Math.max(10, allStatesCacheSeconds);
        this.allStatesStaleMaxSeconds = Math.max(this.allStatesCacheSeconds, allStatesStaleMaxSeconds);
        if (this.clientId.isEmpty() || this.clientSecret.isEmpty()) {
            log.info("OpenSky flight tracking: anonymous mode (limited quota). "
                    + "Set opensky.client-id / opensky.client-secret for reliable access.");
        }
    }

    private boolean hasOpenSkyCredentials() {
        return !clientId.isEmpty() && !clientSecret.isEmpty();
    }

    /** Valid callsign (radio callsign / flight number, 2–8 alphanumeric characters). */
    public static boolean isValidCallsign(String callsign) {
        return callsign != null && CALLSIGN_RE.matcher(callsign.trim().toUpperCase(Locale.ROOT)).matches();
    }

    /** Valid ICAO24 address (6 hex characters). */
    public static boolean isValidIcao24(String icao24) {
        return icao24 != null && ICAO24_RE.matcher(icao24.trim().toLowerCase(Locale.ROOT)).matches();
    }

    /** Current state vector for an ICAO24 address (hex), or {@code empty} if not found. */
    public Optional<FlightStateDto> fetchByIcao24(String icao24) {
        if (!isValidIcao24(icao24)) {
            return Optional.empty();
        }
        String hex = icao24.trim().toLowerCase(Locale.ROOT);
        String url = UriComponentsBuilder.fromHttpUrl(baseUrl + "/states/all")
                .queryParam("icao24", hex)
                .toUriString();
        JsonNode root = getJson(url);
        if (root == null) {
            throw new OpenSkyUnavailableException();
        }
        return firstStateFrom(root).map(this::enrichWithFlightAirports);
    }

    /** Current state vector for a callsign / flight number, or {@code empty} if not found. */
    public Optional<FlightStateDto> fetchByCallsign(String callsign) {
        if (!isValidCallsign(callsign)) {
            return Optional.empty();
        }
        String wanted = callsign.trim().toUpperCase(Locale.ROOT);
        JsonNode root = allStatesCached();
        if (root == null) {
            throw new OpenSkyUnavailableException();
        }
        JsonNode states = root.get("states");
        if (states == null || !states.isArray()) {
            return Optional.empty();
        }
        for (JsonNode state : states) {
            String cs = textAt(state, I_CALLSIGN);
            if (callsignMatchesQuery(cs, wanted)) {
                return Optional.of(enrichWithFlightAirports(toDto(state)));
            }
        }
        return Optional.empty();
    }

    /** Matches OpenSky callsign (8-char padded) against user query (e.g. AFR1527). */
    private static boolean callsignMatchesQuery(String openSkyCallsign, String wanted) {
        if (openSkyCallsign == null || wanted == null || wanted.isEmpty()) {
            return false;
        }
        String cs = openSkyCallsign.trim().toUpperCase(Locale.ROOT);
        if (cs.isEmpty()) {
            return false;
        }
        return cs.equals(wanted) || cs.startsWith(wanted);
    }

    /**
     * Full flight trajectory (departure → arrival waypoints).
     * {@code time=0} : live track if a flight is in progress; otherwise {@code empty}.
     */
    public Optional<FlightTrackDto> fetchTrackByIcao24(String icao24, long time) {
        if (!isValidIcao24(icao24)) {
            return Optional.empty();
        }
        String hex = icao24.trim().toLowerCase(Locale.ROOT);
        String url = UriComponentsBuilder.fromHttpUrl(baseUrl + "/tracks/all")
                .queryParam("icao24", hex)
                .queryParam("time", time)
                .toUriString();
        JsonNode root = getJson(url);
        if (root == null || root.isNull()) {
            return Optional.empty();
        }
        JsonNode path = root.get("path");
        if (path == null || !path.isArray() || path.isEmpty()) {
            return Optional.empty();
        }
        List<FlightTrackPointDto> points = new ArrayList<>();
        for (JsonNode wp : path) {
            if (wp == null || !wp.isArray() || wp.size() < 3) {
                continue;
            }
            Double lat = doubleAt(wp, 1);
            Double lon = doubleAt(wp, 2);
            if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
                continue;
            }
            points.add(new FlightTrackPointDto(
                    longAt(wp, 0),
                    lat,
                    lon,
                    doubleAt(wp, 3),
                    doubleAt(wp, 4),
                    boolAt(wp, 5)));
        }
        if (points.isEmpty()) {
            return Optional.empty();
        }
        String callsign = null;
        if (root.has("callsign") && !root.get("callsign").isNull()) {
            callsign = root.get("callsign").asText().trim();
        } else if (root.has("calllsign") && !root.get("calllsign").isNull()) {
            callsign = root.get("calllsign").asText().trim();
        }
        if (callsign != null && callsign.isEmpty()) {
            callsign = null;
        }
        return Optional.of(new FlightTrackDto(
                root.has("icao24") ? root.get("icao24").asText() : hex,
                callsign,
                root.has("startTime") ? root.get("startTime").asLong() : null,
                root.has("endTime") ? root.get("endTime").asLong() : null,
                points));
    }

    /** Full {@code states/all} snapshot cached to respect OpenSky quota (callsign search). */
    private JsonNode allStatesCached() {
        long now = System.currentTimeMillis();
        JsonNode cached = this.cachedAllStates;
        if (cached != null && (now - this.cachedAllStatesAtMs) < allStatesCacheSeconds * 1000L) {
            return cached;
        }
        if (now < this.openSkyRetryAfterMs) {
            return staleAllStatesOrNull(now, cached);
        }
        synchronized (allStatesLock) {
            now = System.currentTimeMillis();
            cached = this.cachedAllStates;
            if (cached != null && (now - this.cachedAllStatesAtMs) < allStatesCacheSeconds * 1000L) {
                return cached;
            }
            if (now < this.openSkyRetryAfterMs) {
                return staleAllStatesOrNull(now, cached);
            }
            JsonNode fresh = getJson(baseUrl + "/states/all");
            if (fresh != null) {
                this.cachedAllStates = fresh;
                this.cachedAllStatesAtMs = now;
                return fresh;
            }
            return staleAllStatesOrNull(now, cached);
        }
    }

    private JsonNode staleAllStatesOrNull(long now, JsonNode cached) {
        if (cached != null && (now - this.cachedAllStatesAtMs) <= allStatesStaleMaxSeconds * 1000L) {
            log.warn("OpenSky states/all unavailable; using stale cache ({} s old)", (now - this.cachedAllStatesAtMs) / 1000);
            return cached;
        }
        return null;
    }

    private Optional<FlightStateDto> firstStateFrom(JsonNode root) {
        if (root == null) {
            return Optional.empty();
        }
        JsonNode states = root.get("states");
        if (states == null || !states.isArray() || states.isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(enrichWithFlightAirports(toDto(states.get(0))));
    }

    /** Enriches current state with estimated times and airports (OpenSky {@code /flights/aircraft}). */
    private FlightStateDto enrichWithFlightAirports(FlightStateDto state) {
        if (state.icao24() == null || state.icao24().isBlank() || !hasOpenSkyCredentials()) {
            return state;
        }
        return lookupFlightScheduleForAircraft(state.icao24(), state.callsign(), state.lastContact())
                .map(h -> new FlightStateDto(
                        state.icao24(), state.callsign(), state.originCountry(),
                        state.latitude(), state.longitude(), state.baroAltitudeM(), state.geoAltitudeM(),
                        state.velocityMs(), state.trueTrackDeg(), state.verticalRateMs(), state.onGround(),
                        state.lastContact(),
                        h.departureAirport(), h.arrivalAirport(),
                        h.departureTimeEpoch(), h.arrivalTimeEpoch()))
                .orElse(state);
    }

    /** OpenSky flight schedule hint for the most recent flight (24 h). */
    private record FlightScheduleHint(
            String departureAirport,
            String arrivalAirport,
            Long departureTimeEpoch,
            Long arrivalTimeEpoch) {

        boolean hasAny() {
            return departureAirport != null || arrivalAirport != null
                    || departureTimeEpoch != null || arrivalTimeEpoch != null;
        }
    }

    /**
     * Most recent flight in the last 24 h: airports + estimated times
     * ({@code firstSeen} = departure, {@code lastSeen} = estimated arrival per OpenSky).
     * When {@code lastContact} is known, picks the leg that contains that timestamp (current flight).
     */
    private Optional<FlightScheduleHint> lookupFlightScheduleForAircraft(
            String icao24,
            String callsign,
            Long lastContactEpoch) {
        if (!isValidIcao24(icao24)) {
            return Optional.empty();
        }
        String hex = icao24.trim().toLowerCase(Locale.ROOT);
        long end = Instant.now().getEpochSecond();
        long begin = end - 86_400L;
        String url = UriComponentsBuilder.fromHttpUrl(baseUrl + "/flights/aircraft")
                .queryParam("icao24", hex)
                .queryParam("begin", begin)
                .queryParam("end", end)
                .toUriString();
        JsonNode flights = getJson(url);
        if (flights == null || !flights.isArray() || flights.isEmpty()) {
            log.debug("OpenSky flights/aircraft empty for {} (rate limit or no history in 24 h)", hex);
            return Optional.empty();
        }
        String wantedCs = normalizeCallsign(callsign);
        JsonNode best = selectBestFlightRecord(flights, wantedCs, lastContactEpoch);
        if (best == null && !wantedCs.isEmpty()) {
            best = selectBestFlightRecord(flights, null, lastContactEpoch);
        }
        if (best == null) {
            return Optional.empty();
        }
        FlightScheduleHint hint = flightScheduleFromRecord(best);
        return hint.hasAny() ? Optional.of(hint) : Optional.empty();
    }

    /** Picks the flight leg best matching the live state (prefer segment containing {@code lastContact}). */
    private static JsonNode selectBestFlightRecord(JsonNode flights, String wantedCallsign, Long lastContactEpoch) {
        JsonNode best = null;
        long bestScore = Long.MIN_VALUE;
        for (JsonNode f : flights) {
            if (f == null || !f.isObject() || !callsignMatches(f, wantedCallsign)) {
                continue;
            }
            long firstSeen = f.path("firstSeen").asLong(0);
            long lastSeen = f.path("lastSeen").asLong(0);
            if (firstSeen <= 0 || lastSeen <= 0) {
                continue;
            }
            long score = lastSeen;
            if (airportCodeOrNull(f, "estDepartureAirport") != null) {
                score += 10_000L;
            }
            if (airportCodeOrNull(f, "estArrivalAirport") != null) {
                score += 5_000L;
            }
            if (lastContactEpoch != null && lastContactEpoch > 0) {
                long contact = lastContactEpoch;
                if (contact >= firstSeen - 120 && contact <= lastSeen + 900) {
                    score += 2_000_000_000L;
                    score += firstSeen;
                }
            }
            if (score > bestScore) {
                bestScore = score;
                best = f;
            }
        }
        return best;
    }

    private static FlightScheduleHint flightScheduleFromRecord(JsonNode flight) {
        return new FlightScheduleHint(
                airportCodeOrNull(flight, "estDepartureAirport"),
                airportCodeOrNull(flight, "estArrivalAirport"),
                epochFieldOrNull(flight, "firstSeen"),
                epochFieldOrNull(flight, "lastSeen"));
    }

    private static boolean callsignMatches(JsonNode flight, String wantedCallsign) {
        if (wantedCallsign == null || wantedCallsign.isEmpty()) {
            return true;
        }
        String recordCs = callsignFromFlightRecord(flight);
        if (recordCs.isEmpty()) {
            return true;
        }
        return recordCs.equals(wantedCallsign);
    }

    private static String callsignFromFlightRecord(JsonNode flight) {
        if (flight == null || !flight.has("callsign") || flight.get("callsign").isNull()) {
            return "";
        }
        return normalizeCallsign(flight.get("callsign").asText());
    }

    private static String normalizeCallsign(String callsign) {
        if (callsign == null) {
            return "";
        }
        return callsign.trim().toUpperCase(Locale.ROOT);
    }

    private static Long epochFieldOrNull(JsonNode flight, String field) {
        if (flight == null || !flight.has(field) || flight.get(field).isNull()) {
            return null;
        }
        long v = flight.get(field).asLong(0);
        return v > 0 ? v : null;
    }

    private static String airportCodeOrNull(JsonNode flight, String field) {
        if (flight == null || !flight.has(field) || flight.get(field).isNull()) {
            return null;
        }
        String code = flight.get(field).asText().trim().toUpperCase(Locale.ROOT);
        return code.isEmpty() ? null : code;
    }

    private FlightStateDto toDto(JsonNode s) {
        String callsign = textAt(s, I_CALLSIGN);
        return new FlightStateDto(
                textAt(s, I_ICAO24),
                callsign != null ? callsign.trim() : null,
                textAt(s, I_ORIGIN),
                doubleAt(s, I_LAT),
                doubleAt(s, I_LON),
                doubleAt(s, I_BARO_ALT),
                doubleAt(s, I_GEO_ALT),
                doubleAt(s, I_VELOCITY),
                doubleAt(s, I_TRUE_TRACK),
                doubleAt(s, I_VERT_RATE),
                boolAt(s, I_ON_GROUND),
                longAt(s, I_LAST_CONTACT),
                null,
                null,
                null,
                null);
    }

    private static String textAt(JsonNode arr, int idx) {
        JsonNode n = arr != null && arr.isArray() && arr.size() > idx ? arr.get(idx) : null;
        return n == null || n.isNull() || !n.isTextual() ? null : n.asText();
    }

    private static Double doubleAt(JsonNode arr, int idx) {
        JsonNode n = arr != null && arr.isArray() && arr.size() > idx ? arr.get(idx) : null;
        if (n == null || n.isNull() || !n.isNumber()) {
            return null;
        }
        double v = n.asDouble();
        return Double.isFinite(v) ? v : null;
    }

    private static Boolean boolAt(JsonNode arr, int idx) {
        JsonNode n = arr != null && arr.isArray() && arr.size() > idx ? arr.get(idx) : null;
        return n == null || n.isNull() || !n.isBoolean() ? null : n.asBoolean();
    }

    private static Long longAt(JsonNode arr, int idx) {
        JsonNode n = arr != null && arr.isArray() && arr.size() > idx ? arr.get(idx) : null;
        return n == null || n.isNull() || !n.isNumber() ? null : n.asLong();
    }

    private JsonNode getJson(String url) {
        long now = System.currentTimeMillis();
        if (now < this.openSkyRetryAfterMs) {
            log.debug("OpenSky request skipped until retry window ends: {}", url);
            return null;
        }
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.USER_AGENT, "PATTOOL-GlobeProxy/1.0");
        headers.set(HttpHeaders.ACCEPT, "application/json");
        String token = bearerTokenIfConfigured();
        if (token != null) {
            headers.setBearerAuth(token);
        }
        try {
            ResponseEntity<String> response = restTemplate.exchange(
                    url, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                noteOpenSkyRateLimit(response.getStatusCode().value(), response.getHeaders());
                log.debug("OpenSky HTTP {} for {}", response.getStatusCode(), url);
                return null;
            }
            return objectMapper.readTree(response.getBody());
        } catch (HttpClientErrorException e) {
            noteOpenSkyRateLimit(e.getStatusCode().value(), e.getResponseHeaders());
            log.warn("OpenSky HTTP {} for {}: {}", e.getStatusCode().value(), url, e.getStatusText());
            return null;
        } catch (RestClientException e) {
            log.warn("OpenSky fetch failed for {}: {}", url, e.getMessage());
            return null;
        } catch (Exception e) {
            log.warn("OpenSky JSON parse failed for {}: {}", url, e.getMessage());
            return null;
        }
    }

    private void noteOpenSkyRateLimit(int statusCode, HttpHeaders headers) {
        if (statusCode != 429 || headers == null) {
            return;
        }
        long retrySec = 60;
        String retryHeader = headers.getFirst("X-Rate-Limit-Retry-After-Seconds");
        if (retryHeader == null || retryHeader.isBlank()) {
            retryHeader = headers.getFirst("Retry-After");
        }
        if (retryHeader != null && !retryHeader.isBlank()) {
            try {
                retrySec = Math.max(10, Long.parseLong(retryHeader.trim()));
            } catch (NumberFormatException ignored) {
                // keep default
            }
        }
        this.openSkyRetryAfterMs = System.currentTimeMillis() + retrySec * 1000L;
        log.warn("OpenSky rate limit (429); backing off for {} s. Configure opensky.client-id/secret for higher quota.", retrySec);
    }

    /** OAuth2 token (client credentials) when credentials are configured, otherwise {@code null} (anonymous). */
    private String bearerTokenIfConfigured() {
        if (clientId.isEmpty() || clientSecret.isEmpty()) {
            return null;
        }
        long now = System.currentTimeMillis();
        String token = this.cachedToken;
        if (token != null && now < this.cachedTokenExpiryMs) {
            return token;
        }
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
            MultiValueMap<String, String> body = new LinkedMultiValueMap<>();
            body.add("grant_type", "client_credentials");
            body.add("client_id", clientId);
            body.add("client_secret", clientSecret);
            ResponseEntity<String> response = restTemplate.exchange(
                    tokenUrl, HttpMethod.POST, new HttpEntity<>(body, headers), String.class);
            if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                log.warn("OpenSky token HTTP {}", response.getStatusCode());
                return null;
            }
            JsonNode json = objectMapper.readTree(response.getBody());
            String access = json.path("access_token").asText(null);
            long expiresIn = json.path("expires_in").asLong(300);
            if (access == null || access.isBlank()) {
                return null;
            }
            this.cachedToken = access;
            // Renew 30 s before the advertised expiry.
            this.cachedTokenExpiryMs = now + Math.max(30, expiresIn - 30) * 1000L;
            return access;
        } catch (Exception e) {
            log.warn("OpenSky token request failed: {}", e.getMessage());
            return null;
        }
    }
}
