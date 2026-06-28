package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.*;

/**
 * Proxy for Météo-France DPClim v1 (climatological station archives).
 */
@Service
public class MeteoFranceClimService {

    private static final Logger log = LoggerFactory.getLogger(MeteoFranceClimService.class);

    private static final String DEFAULT_DPCLIM_BASE = "https://public-api.meteofrance.fr/public/DPClim/v1";
    private static final DateTimeFormatter ISO_UTC = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'")
            .withZone(ZoneOffset.UTC);
    private static final Set<String> ALLOWED_FREQUENCIES = Set.of(
            "quotidienne", "horaire", "infrahoraire-6m", "decadaire", "mensuelle"
    );

    private final RestTemplate restTemplate;
    private final GeocodeService geocodeService;
    private final String climApiToken;
    private final String dpclimBaseUrl;

    public MeteoFranceClimService(
            RestTemplate restTemplate,
            GeocodeService geocodeService,
            @Value("${meteofrance.clim.api.token:}") String climApiToken,
            @Value("${meteofrance.clim.base.url:" + DEFAULT_DPCLIM_BASE + "}") String dpclimBaseUrl) {
        this.restTemplate = restTemplate;
        this.geocodeService = geocodeService;
        this.climApiToken = normalizeToken(climApiToken);
        this.dpclimBaseUrl = dpclimBaseUrl != null && !dpclimBaseUrl.isBlank()
                ? dpclimBaseUrl.trim()
                : DEFAULT_DPCLIM_BASE;
        if (isConfigured()) {
            log.info("Météo-France DPClim credentials loaded (dedicated clim API key)");
        } else {
            log.info("Météo-France DPClim not configured — set meteofrance.clim.api.token "
                    + "(separate key from DPRadar on portail-api.meteofrance.fr)");
        }
    }

    public Map<String, Object> getStatusFragment() {
        Map<String, Object> status = new LinkedHashMap<>();
        boolean configured = isConfigured();
        status.put("dpclimConfigured", configured);
        status.put("dpclimAuthValid", false);
        if (configured) {
            boolean valid = probeAuth();
            status.put("dpclimAuthValid", valid);
            if (!valid) {
                status.put("dpclimAuthError",
                        "Invalid credentials or missing subscription to API « Données Climatologiques ». "
                                + "Use meteofrance.clim.api.token (not the DPRadar key).");
            }
        }
        status.put("climEndpoints", List.of(
                "/api/external/meteofrance/clim/stations",
                "/api/external/meteofrance/clim/station",
                "/api/external/meteofrance/clim/nearby"
        ));
        return status;
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> listStations(String department, String frequency) {
        if (!isConfigured()) {
            return error("DPClim API key not configured. Set meteofrance.clim.api.token (separate from meteofrance.api.token for radar)");
        }
        String dept = normalizeDepartment(department);
        if (dept == null) {
            return error("Invalid department code");
        }
        String freq = normalizeFrequency(frequency);
        String url = dpclimBaseUrl + "/liste-stations/" + freq + "?id-departement=" + dept;
        try {
            Object body = getJsonBody(url);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("department", dept);
            out.put("frequency", freq);
            out.put("stations", normalizeStationList(body));
            return out;
        } catch (HttpClientErrorException e) {
            return climHttpError(e);
        } catch (Exception e) {
            return error("DPClim stations fetch failed: " + e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> getStationInfo(String stationId) {
        if (!isConfigured()) {
            return error("DPClim API key not configured. Set meteofrance.clim.api.token (separate from meteofrance.api.token for radar)");
        }
        String id = normalizeStationId(stationId);
        if (id == null) {
            return error("Invalid station id");
        }
        String url = dpclimBaseUrl + "/information-station?id-station=" + id;
        try {
            Object body = getJsonBody(url);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("stationId", id);
            out.put("info", body);
            return out;
        } catch (HttpClientErrorException e) {
            return climHttpError(e);
        } catch (Exception e) {
            return error("DPClim station info fetch failed: " + e.getMessage());
        }
    }

    public Map<String, Object> getNearbyClimData(
            double lat,
            double lon,
            String department,
            int days,
            String frequency,
            String stationId) {
        if (!isConfigured()) {
            return error("DPClim API key not configured. Set meteofrance.clim.api.token (separate from meteofrance.api.token for radar)");
        }
        if (!isValidCoordinate(lat, lon)) {
            return error("Invalid coordinates");
        }

        String dept = normalizeDepartment(department);
        if (dept == null) {
            dept = resolveDepartmentFromCoordinates(lat, lon);
        }
        if (dept == null) {
            return error("Could not determine French department for this location");
        }

        String freq = normalizeFrequency(frequency);
        int resolvedDays = resolveDays(days, freq);

        Map<String, Object> stationsResponse = listStations(dept, freq);
        if (stationsResponse.get("error") != null) {
            return stationsResponse;
        }

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> stations = (List<Map<String, Object>>) stationsResponse.get("stations");
        if (stations == null || stations.isEmpty()) {
            return error("No climatological stations found for department " + dept);
        }

        Map<String, Object> selected;
        if (stationId != null && !stationId.isBlank()) {
            String normalizedId = normalizeStationId(stationId);
            selected = null;
            for (Map<String, Object> station : stations) {
                if (normalizedId != null && normalizedId.equals(String.valueOf(station.get("id")))) {
                    selected = new LinkedHashMap<>(station);
                    Double sLat = toDouble(selected.get("lat"));
                    Double sLon = toDouble(selected.get("lon"));
                    if (sLat != null && sLon != null) {
                        selected.put("distanceKm", Math.round(haversineKm(lat, lon, sLat, sLon) * 10.0) / 10.0);
                    }
                    break;
                }
            }
            if (selected == null) {
                return error("Station not found in department " + dept);
            }
        } else {
            selected = findNearestStation(stations, lat, lon);
        }
        if (selected == null) {
            return error("Could not select nearest station");
        }

        String resolvedStationId = String.valueOf(selected.get("id"));
        Instant end = Instant.now().truncatedTo(ChronoUnit.DAYS);
        Instant start = end.minus(resolvedDays - 1L, ChronoUnit.DAYS);

        Map<String, Object> orderResult = orderAndFetchCsv(resolvedStationId, freq, start, end);
        if (orderResult.get("error") != null) {
            return orderResult;
        }

        Map<String, Object> info = getStationInfo(resolvedStationId);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("department", dept);
        result.put("frequency", freq);
        result.put("periodStart", ISO_UTC.format(start));
        result.put("periodEnd", ISO_UTC.format(end.atZone(ZoneOffset.UTC).withHour(23).withMinute(59).withSecond(59).toInstant()));
        result.put("station", selected);
        if (info.get("error") == null) {
            result.put("stationInfo", info.get("info"));
        }
        result.put("columns", orderResult.get("columns"));
        result.put("rows", orderResult.get("rows"));
        result.put("source", "Météo-France DPClim");
        return result;
    }

    private Map<String, Object> orderAndFetchCsv(String stationId, String frequency, Instant start, Instant end) {
        String id = normalizeStationId(stationId);
        String startIso = ISO_UTC.format(start);
        String endIso = ISO_UTC.format(end.atZone(ZoneOffset.UTC).withHour(23).withMinute(59).withSecond(59).toInstant());

        String orderUrl = UriComponentsBuilder.fromHttpUrl(dpclimBaseUrl + "/commande-station/" + frequency)
                .queryParam("id-station", id)
                .queryParam("date-deb-periode", startIso)
                .queryParam("date-fin-periode", endIso)
                .build(true)
                .toUriString();

        try {
            HttpHeaders headers = authHeaders();
            headers.setAccept(List.of(MediaType.APPLICATION_JSON, MediaType.ALL));
            ResponseEntity<Map> orderResponse = restTemplate.exchange(
                    orderUrl,
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    Map.class
            );
            String commandId = extractCommandId(orderResponse.getBody());
            if (commandId == null || commandId.isBlank()) {
                return error("DPClim order did not return a command id");
            }

            byte[] csv = pollCommandFile(commandId);
            if (csv == null || csv.length == 0) {
                return error("DPClim data file empty or not ready");
            }
            return parseSemicolonCsv(csv);
        } catch (HttpClientErrorException e) {
            return climHttpError(e);
        } catch (Exception e) {
            log.warn("DPClim order/fetch failed for station {}: {}", id, e.getMessage());
            return error("DPClim data fetch failed: " + e.getMessage());
        }
    }

    private byte[] pollCommandFile(String commandId) throws InterruptedException {
        String fileUrl = dpclimBaseUrl + "/commande/fichier?id-cmde=" + commandId;
        HttpHeaders headers = authHeaders();
        headers.setAccept(List.of(MediaType.TEXT_PLAIN, MediaType.APPLICATION_OCTET_STREAM, MediaType.ALL));

        for (int attempt = 0; attempt < 20; attempt++) {
            if (attempt > 0) {
                Thread.sleep(2000L);
            }
            try {
                ResponseEntity<byte[]> response = restTemplate.exchange(
                        fileUrl,
                        HttpMethod.GET,
                        new HttpEntity<>(headers),
                        byte[].class
                );
                if (response.getStatusCode() == HttpStatus.NO_CONTENT) {
                    continue;
                }
                byte[] body = response.getBody();
                if (body != null && body.length > 0) {
                    return body;
                }
            } catch (HttpStatusCodeException e) {
                if (e.getStatusCode() == HttpStatus.NO_CONTENT) {
                    continue;
                }
                if (e.getStatusCode() == HttpStatus.INTERNAL_SERVER_ERROR) {
                    throw e;
                }
                throw e;
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static String extractCommandId(Map<String, Object> body) {
        if (body == null) {
            return null;
        }
        Object wrapper = body.get("elaboreProduitAvecDemandeResponse");
        if (wrapper instanceof Map<?, ?> map) {
            Object value = map.get("return");
            return value != null ? String.valueOf(value).trim() : null;
        }
        Object direct = body.get("return");
        return direct != null ? String.valueOf(direct).trim() : null;
    }

    private static Map<String, Object> parseSemicolonCsv(byte[] raw) {
        String text = new String(raw, StandardCharsets.UTF_8);
        if (text.startsWith("\uFEFF")) {
            text = text.substring(1);
        }
        String[] lines = text.split("\\r?\\n");
        if (lines.length < 2) {
            Map<String, Object> empty = new LinkedHashMap<>();
            empty.put("columns", List.of());
            empty.put("rows", List.of());
            return empty;
        }
        String[] headers = splitCsvLine(lines[0]);
        List<String> columns = Arrays.asList(headers);
        List<Map<String, String>> rows = new ArrayList<>();
        for (int i = 1; i < lines.length; i++) {
            if (lines[i].isBlank()) {
                continue;
            }
            String[] values = splitCsvLine(lines[i]);
            Map<String, String> row = new LinkedHashMap<>();
            for (int c = 0; c < headers.length && c < values.length; c++) {
                row.put(headers[c], values[c]);
            }
            rows.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("columns", columns);
        out.put("rows", rows);
        return out;
    }

    private static String[] splitCsvLine(String line) {
        return line.split(";", -1);
    }

    @SuppressWarnings("unchecked")
    private Object getJsonBody(String url) {
        HttpHeaders headers = authHeaders();
        headers.setAccept(List.of(MediaType.APPLICATION_JSON, MediaType.ALL));
        ResponseEntity<Object> response = restTemplate.exchange(
                url,
                HttpMethod.GET,
                new HttpEntity<>(headers),
                Object.class
        );
        return response.getBody();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> normalizeStationList(Object body) {
        List<?> rawList;
        if (body instanceof List<?> list) {
            rawList = list;
        } else if (body instanceof Map<?, ?> map && map.get("stations") instanceof List<?> list) {
            rawList = list;
        } else {
            return List.of();
        }
        List<Map<String, Object>> stations = new ArrayList<>();
        for (Object item : rawList) {
            if (!(item instanceof Map<?, ?> map)) {
                continue;
            }
            Map<String, Object> station = new LinkedHashMap<>();
            Object id = map.get("id");
            station.put("id", formatStationId(id));
            station.put("name", firstNonBlank(map, "nom", "name"));
            station.put("open", map.get("posteOuvert"));
            Double stationLat = toDouble(firstPresent(map, "latitude", "lat"));
            Double stationLon = toDouble(firstPresent(map, "longitude", "lon", "long"));
            station.put("lat", stationLat);
            station.put("lon", stationLon);
            stations.add(station);
        }
        return stations;
    }

    private static Map<String, Object> findNearestStation(List<Map<String, Object>> stations, double lat, double lon) {
        Map<String, Object> best = null;
        double bestDistance = Double.MAX_VALUE;
        for (Map<String, Object> station : stations) {
            Double sLat = toDouble(station.get("lat"));
            Double sLon = toDouble(station.get("lon"));
            if (sLat == null || sLon == null) {
                continue;
            }
            double distance = haversineKm(lat, lon, sLat, sLon);
            boolean open = Boolean.TRUE.equals(station.get("open"));
            if (best == null
                    || distance < bestDistance - 0.5
                    || (Math.abs(distance - bestDistance) <= 0.5 && open && !Boolean.TRUE.equals(best.get("open")))) {
                best = station;
                bestDistance = distance;
            }
        }
        if (best != null) {
            best = new LinkedHashMap<>(best);
            best.put("distanceKm", Math.round(bestDistance * 10.0) / 10.0);
        }
        return best;
    }

    private String resolveDepartmentFromCoordinates(double lat, double lon) {
        try {
            Map<String, Object> geo = geocodeService.reverse(lat, lon);
            if (geo == null) {
                return null;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> address = (Map<String, Object>) geo.get("address");
            if (address != null) {
                String postcode = firstNonBlank(address, "postcode");
                String dept = departmentFromPostcode(postcode);
                if (dept != null) {
                    return dept;
                }
            }
        } catch (Exception e) {
            log.debug("Department resolution from geocode failed: {}", e.getMessage());
        }
        return null;
    }

    static String departmentFromPostcode(String postcode) {
        if (postcode == null || postcode.isBlank()) {
            return null;
        }
        String pc = postcode.trim();
        if (pc.length() < 2) {
            return null;
        }
        if (pc.startsWith("97") || pc.startsWith("98")) {
            return pc.length() >= 3 ? pc.substring(0, 3) : null;
        }
        if (pc.startsWith("20")) {
            return "2A";
        }
        return pc.substring(0, 2);
    }

    private boolean probeAuth() {
        try {
            HttpHeaders headers = authHeaders();
            headers.setAccept(List.of(MediaType.APPLICATION_JSON));
            ResponseEntity<Void> response = restTemplate.exchange(
                    dpclimBaseUrl + "/liste-stations/quotidienne?id-departement=75",
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    Void.class
            );
            return response.getStatusCode().is2xxSuccessful();
        } catch (HttpClientErrorException e) {
            return false;
        } catch (Exception e) {
            log.debug("DPClim auth probe failed: {}", e.getMessage());
            return false;
        }
    }

    private HttpHeaders authHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(climApiToken);
        headers.set("apikey", climApiToken);
        headers.set(HttpHeaders.USER_AGENT, "PATTOOL/1.0");
        return headers;
    }

    private boolean isConfigured() {
        return !climApiToken.isEmpty();
    }

    private static Map<String, Object> climHttpError(HttpClientErrorException e) {
        Map<String, Object> err = error("DPClim API error: " + e.getStatusCode());
        err.put("details", e.getResponseBodyAsString());
        if (e.getStatusCode() == HttpStatus.UNAUTHORIZED) {
            err.put("authValid", false);
        }
        return err;
    }

    private static Map<String, Object> error(String message) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("error", message);
        return map;
    }

    private static String normalizeFrequency(String frequency) {
        if (frequency == null || frequency.isBlank()) {
            return "quotidienne";
        }
        String value = frequency.trim().toLowerCase(Locale.ROOT);
        return ALLOWED_FREQUENCIES.contains(value) ? value : "quotidienne";
    }

    private static int resolveDays(int days, String frequency) {
        int maxDays = "horaire".equals(frequency) || "infrahoraire-6m".equals(frequency) ? 31 : 365;
        if (days <= 0) {
            return "quotidienne".equals(frequency) ? 30 : 7;
        }
        return Math.min(days, maxDays);
    }

    private static String normalizeDepartment(String department) {
        if (department == null || department.isBlank()) {
            return null;
        }
        String value = department.trim().toUpperCase(Locale.ROOT);
        if (value.matches("\\d{2,3}") || value.matches("2[AB]")) {
            return value;
        }
        return null;
    }

    private static String normalizeStationId(String stationId) {
        if (stationId == null || stationId.isBlank()) {
            return null;
        }
        String digits = stationId.replaceAll("\\D", "");
        if (digits.isEmpty() || digits.length() > 8) {
            return null;
        }
        return String.format(Locale.ROOT, "%08d", Long.parseLong(digits));
    }

    private static String formatStationId(Object id) {
        if (id == null) {
            return "";
        }
        String digits = String.valueOf(id).replaceAll("\\D", "");
        if (digits.isEmpty()) {
            return String.valueOf(id);
        }
        return String.format(Locale.ROOT, "%08d", Long.parseLong(digits));
    }

    private static boolean isValidCoordinate(double lat, double lon) {
        return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    }

    private static double haversineKm(double lat1, double lon1, double lat2, double lon2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 6371.0 * 2 * Math.asin(Math.sqrt(a));
    }

    private static Object firstPresent(Map<?, ?> map, String... keys) {
        for (String key : keys) {
            if (map.containsKey(key) && map.get(key) != null) {
                return map.get(key);
            }
        }
        return null;
    }

    private static String firstNonBlank(Map<?, ?> map, String... keys) {
        for (String key : keys) {
            Object value = map.get(key);
            if (value != null && !String.valueOf(value).isBlank()) {
                return String.valueOf(value).trim();
            }
        }
        return "";
    }

    private static Double toDouble(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Number number) {
            return number.doubleValue();
        }
        try {
            return Double.parseDouble(String.valueOf(value).replace(',', '.'));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String normalizeToken(String raw) {
        if (raw == null) {
            return "";
        }
        String token = raw.trim();
        if (token.regionMatches(true, 0, "Bearer ", 0, 7)) {
            token = token.substring(7).trim();
        }
        return token;
    }
}
