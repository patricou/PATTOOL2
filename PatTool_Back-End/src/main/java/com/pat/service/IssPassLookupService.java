package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

/**
 * Resolves a place name to coordinates (Nominatim via {@link GeocodeService}) and fetches ISS pass
 * predictions from Open Notify (via {@link GlobeProxyService}).
 */
@Service
public class IssPassLookupService {

    private final GeocodeService geocodeService;
    private final GlobeProxyService globeProxyService;
    private final ObjectMapper objectMapper;

    public IssPassLookupService(
            GeocodeService geocodeService,
            GlobeProxyService globeProxyService,
            ObjectMapper objectMapper) {
        this.geocodeService = geocodeService;
        this.globeProxyService = globeProxyService;
        this.objectMapper = objectMapper;
    }

    /**
     * @param candidateIndex when several geocode hits exist, pick this zero-based index; if null and
     *                       multiple hits, returns {@code status=ambiguous} without calling Open Notify.
     */
    public byte[] lookupByPlace(String placeQuery, int passCount, Integer candidateIndex) {
        if (placeQuery == null || placeQuery.isBlank()) {
            return statusJson("error", "empty_query", "Place query is required.");
        }
        List<Map<String, Object>> geo = geocodeService.search(placeQuery.trim());
        if (geo.isEmpty()) {
            return statusJson("error", "no_geocode_results", "No place found for this query.");
        }
        if (geo.size() > 1 && candidateIndex == null) {
            return ambiguousJson(geo);
        }
        int idx = candidateIndex != null ? candidateIndex : 0;
        if (idx < 0 || idx >= geo.size()) {
            return statusJson("error", "invalid_index", "Geocode candidate index out of range.");
        }
        Map<String, Object> pick = geo.get(idx);
        double lat = toDouble(pick.get("lat"));
        double lon = toDouble(pick.get("lon"));
        String displayName = pick.get("displayName") != null ? pick.get("displayName").toString() : "";
        return successWithPlace(lat, lon, displayName, passCount);
    }

    public byte[] lookupByCoordinates(double lat, double lon, int passCount) {
        return successWithPlace(lat, lon, null, passCount);
    }

    private byte[] successWithPlace(double lat, double lon, String displayName, int passCount) {
        try {
            byte[] openNotify = globeProxyService.fetchOpenNotifyIssPasses(lat, lon, passCount, 0.0);
            JsonNode passesRoot = objectMapper.readTree(openNotify);
            String msg = passesRoot.has("message") ? passesRoot.get("message").asText("") : "";
            if (!"success".equalsIgnoreCase(msg)) {
                return statusJson("error", "upstream_failed",
                        "ISS pass prediction upstream returned: " + (msg.isEmpty() ? "unknown" : msg));
            }
            ArrayNode responseArr = passesRoot.has("response") && passesRoot.get("response").isArray()
                    ? (ArrayNode) passesRoot.get("response")
                    : null;
            if (responseArr == null || responseArr.isEmpty()) {
                return statusJson("error", "no_passes",
                        "No upcoming ISS pass found for this location in the prediction window.");
            }
            ObjectNode out = objectMapper.createObjectNode();
            out.put("status", "success");
            ObjectNode place = objectMapper.createObjectNode();
            place.put("lat", lat);
            place.put("lon", lon);
            if (displayName != null && !displayName.isBlank()) {
                place.put("displayName", displayName);
            }
            out.set("place", place);
            out.set("passes", passesRoot);
            ObjectNode next = objectMapper.createObjectNode();
            JsonNode first = responseArr.get(0);
            if (first.has("risetime")) {
                next.put("risetime", first.get("risetime").asLong());
            }
            if (first.has("duration")) {
                next.put("duration", first.get("duration").asInt());
            }
            out.set("nextPass", next);
            return objectMapper.writeValueAsBytes(out);
        } catch (IllegalArgumentException e) {
            return statusJson("error", "invalid_coordinates", e.getMessage());
        } catch (Exception e) {
            return statusJson("error", "upstream_failed", "ISS pass lookup failed: " + e.getMessage());
        }
    }

    private byte[] ambiguousJson(List<Map<String, Object>> geo) {
        try {
            ObjectNode out = objectMapper.createObjectNode();
            out.put("status", "ambiguous");
            ArrayNode candidates = objectMapper.createArrayNode();
            for (Map<String, Object> m : geo) {
                ObjectNode c = objectMapper.createObjectNode();
                c.put("lat", toDouble(m.get("lat")));
                c.put("lon", toDouble(m.get("lon")));
                Object dn = m.get("displayName");
                if (dn != null) {
                    c.put("displayName", dn.toString());
                }
                candidates.add(c);
            }
            out.set("candidates", candidates);
            return objectMapper.writeValueAsBytes(out);
        } catch (Exception e) {
            return statusJson("error", "serialization_failed", e.getMessage());
        }
    }

    private byte[] statusJson(String status, String code, String message) {
        try {
            ObjectNode out = objectMapper.createObjectNode();
            out.put("status", status);
            out.put("code", code);
            out.put("message", message);
            return objectMapper.writeValueAsBytes(out);
        } catch (Exception e) {
            return ("{\"status\":\"error\",\"code\":\"serialization_failed\",\"message\":"
                    + quoteJson(message) + "}").getBytes(java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    private static String quoteJson(String s) {
        if (s == null) {
            return "\"\"";
        }
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private static double toDouble(Object v) {
        if (v instanceof Number n) {
            return n.doubleValue();
        }
        return Double.parseDouble(String.valueOf(v));
    }
}
