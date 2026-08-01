package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.OpenRouteDirectionsDto;
import com.pat.controller.dto.OpenRouteExtraGroupDto;
import com.pat.controller.dto.OpenRouteExtraItemDto;
import com.pat.controller.dto.OpenRouteStepDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestTemplate;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Proxy OpenRouteService directions — API key stays server-side.
 * <p>
 * Docs: <a href="https://openrouteservice.org/dev/#/api-docs">openrouteservice.org</a>
 */
@Service
public class OpenRouteProxyService {

    private static final Logger log = LoggerFactory.getLogger(OpenRouteProxyService.class);

    private static final Set<String> ALLOWED_PROFILES = Set.of(
            "driving-car",
            "cycling-regular",
            "foot-walking"
    );

    private static final Set<String> ALLOWED_LANGUAGES = Set.of(
            "de", "en", "es", "fr", "he", "hu", "id", "it", "ja", "ne", "nl", "pl", "pt", "ru", "zh"
    );

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    @Value("${app.openroute.api-base:https://api.openrouteservice.org}")
    private String apiBase;

    /** OpenRouteService API key — never exposed to the browser. */
    @Value("${app.openroute.api-key:}")
    private String apiKey;

    public OpenRouteProxyService(RestTemplate restTemplate, ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    public boolean isConfigured() {
        return StringUtils.hasText(apiKey);
    }

    /**
     * Calculate a route from start to end for the given profile.
     *
     * @param profile ORS profile ({@code driving-car}, {@code cycling-regular}, {@code foot-walking})
     * @param startLat start latitude
     * @param startLon start longitude
     * @param endLat   end latitude
     * @param endLon   end longitude
     * @param language instruction language (ORS codes)
     * @return normalized directions, or {@code null} on upstream failure
     * @throws IllegalStateException if API key is missing
     * @throws IllegalArgumentException if profile/coords are invalid
     */
    public OpenRouteDirectionsDto directions(
            String profile,
            double startLat,
            double startLon,
            double endLat,
            double endLon,
            String language) {

        if (!isConfigured()) {
            throw new IllegalStateException("OpenRouteService API key is not configured");
        }

        String resolvedProfile = normalizeProfile(profile);
        if (resolvedProfile == null) {
            throw new IllegalArgumentException("Unsupported profile: " + profile);
        }
        if (!isValidLatLon(startLat, startLon) || !isValidLatLon(endLat, endLon)) {
            throw new IllegalArgumentException("Invalid coordinates");
        }

        String lang = normalizeLanguage(language);
        String url = normalizeBase(apiBase) + "/v2/directions/" + resolvedProfile + "/geojson";

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("coordinates", List.of(
                List.of(startLon, startLat),
                List.of(endLon, endLat)
        ));
        body.put("instructions", true);
        body.put("language", lang);
        body.put("units", "m");
        body.put("elevation", true);
        body.put("extra_info", extraInfoForProfile(resolvedProfile));
        body.put("attributes", List.of("avgspeed", "percentage"));

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setAccept(List.of(MediaType.APPLICATION_JSON, MediaType.parseMediaType("application/geo+json")));
        headers.set("Authorization", apiKey.trim());

        try {
            ResponseEntity<String> response = exchangeDirections(url, body, headers);
            if (response == null) {
                // Some ORS deployments reject certain extras — retry with a minimal set.
                body.put("extra_info", List.of("surface", "waytype", "steepness"));
                response = exchangeDirections(url, body, headers);
            }
            if (response == null || !response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                log.warn("OpenRouteService directions unexpected status {}",
                        response != null ? response.getStatusCode() : "null");
                return null;
            }
            return parseGeoJson(response.getBody(), resolvedProfile);
        } catch (HttpStatusCodeException ex) {
            log.warn("OpenRouteService directions HTTP {}: {}",
                    ex.getStatusCode().value(),
                    truncate(ex.getResponseBodyAsString(), 400));
            if (ex.getStatusCode().value() == 404) {
                OpenRouteDirectionsDto empty = new OpenRouteDirectionsDto();
                empty.setConfigured(true);
                empty.setProfile(resolvedProfile);
                return empty;
            }
            return null;
        } catch (Exception ex) {
            log.warn("OpenRouteService directions failed: {}", ex.toString());
            return null;
        }
    }

    private ResponseEntity<String> exchangeDirections(
            String url,
            Map<String, Object> body,
            HttpHeaders headers) {
        try {
            ResponseEntity<String> response = restTemplate.exchange(
                    url,
                    HttpMethod.POST,
                    new HttpEntity<>(body, headers),
                    String.class
            );
            if (response.getStatusCode().is2xxSuccessful()) {
                return response;
            }
            log.warn("OpenRouteService directions status {}", response.getStatusCode());
            return null;
        } catch (HttpStatusCodeException ex) {
            if (ex.getStatusCode().value() == 404) {
                throw ex;
            }
            log.warn("OpenRouteService directions HTTP {}: {}",
                    ex.getStatusCode().value(),
                    truncate(ex.getResponseBodyAsString(), 400));
            return null;
        }
    }

    private static List<String> extraInfoForProfile(String profile) {
        List<String> extras = new ArrayList<>();
        extras.add("surface");
        extras.add("waytype");
        extras.add("steepness");
        if ("driving-car".equals(profile)) {
            extras.add("tollways");
            extras.add("waycategory");
            extras.add("roadaccessrestrictions");
        }
        if ("foot-walking".equals(profile) || "cycling-regular".equals(profile)) {
            extras.add("traildifficulty");
            extras.add("suitability");
        }
        return extras;
    }

    private OpenRouteDirectionsDto parseGeoJson(String json, String profile) throws Exception {
        JsonNode root = objectMapper.readTree(json);
        OpenRouteDirectionsDto dto = new OpenRouteDirectionsDto();
        dto.setConfigured(true);
        dto.setProfile(profile);

        JsonNode meta = root.path("metadata");
        if (meta.hasNonNull("attribution")) {
            dto.setAttribution(meta.get("attribution").asText());
        }
        if (meta.hasNonNull("service")) {
            dto.setService(meta.get("service").asText());
        }
        if (meta.has("timestamp") && meta.get("timestamp").isNumber()) {
            dto.setTimestamp(meta.get("timestamp").asLong());
        }
        JsonNode engine = meta.path("engine");
        if (engine.hasNonNull("version")) {
            dto.setEngineVersion(engine.get("version").asText());
        }
        if (engine.hasNonNull("build_date")) {
            dto.setEngineBuildDate(engine.get("build_date").asText());
        }
        if (engine.hasNonNull("graph_date")) {
            dto.setGraphDate(engine.get("graph_date").asText());
        }

        JsonNode rootBbox = root.path("bbox");
        if (rootBbox.isArray() && rootBbox.size() >= 4) {
            List<Double> bbox = new ArrayList<>();
            for (JsonNode n : rootBbox) {
                if (n.isNumber()) {
                    bbox.add(n.asDouble());
                }
            }
            dto.setBbox(bbox);
        }

        JsonNode features = root.path("features");
        if (!features.isArray() || features.isEmpty()) {
            return dto;
        }

        JsonNode feature = features.get(0);
        JsonNode props = feature.path("properties");
        JsonNode summary = props.path("summary");
        if (summary.has("distance")) {
            dto.setDistanceMeters(summary.get("distance").asDouble());
        }
        if (summary.has("duration")) {
            dto.setDurationSeconds(summary.get("duration").asDouble());
        }

        Double ascent = firstDouble(props, "ascent", summary, "ascent");
        Double descent = firstDouble(props, "descent", summary, "descent");

        List<double[]> coords = new ArrayList<>();
        double computedAscent = 0;
        double computedDescent = 0;
        Double previousEle = null;
        Double eleMin = null;
        Double eleMax = null;
        Double eleStart = null;
        Double eleEnd = null;
        JsonNode geometryCoords = feature.path("geometry").path("coordinates");
        if (geometryCoords.isArray()) {
            for (JsonNode pair : geometryCoords) {
                if (pair.isArray() && pair.size() >= 2) {
                    double lon = pair.get(0).asDouble();
                    double lat = pair.get(1).asDouble();
                    if (pair.size() >= 3 && pair.get(2).isNumber()) {
                        double ele = pair.get(2).asDouble();
                        coords.add(new double[]{lat, lon, ele});
                        if (eleStart == null) {
                            eleStart = ele;
                        }
                        eleEnd = ele;
                        eleMin = eleMin == null ? ele : Math.min(eleMin, ele);
                        eleMax = eleMax == null ? ele : Math.max(eleMax, ele);
                        if (previousEle != null) {
                            double delta = ele - previousEle;
                            if (delta > 0) {
                                computedAscent += delta;
                            } else if (delta < 0) {
                                computedDescent += -delta;
                            }
                        }
                        previousEle = ele;
                    } else {
                        coords.add(new double[]{lat, lon});
                    }
                }
            }
        }
        dto.setCoordinates(coords);
        dto.setPointCount(coords.size());
        dto.setElevationStartMeters(eleStart);
        dto.setElevationEndMeters(eleEnd);
        dto.setElevationMinMeters(eleMin);
        dto.setElevationMaxMeters(eleMax);

        if (ascent != null) {
            dto.setAscentMeters(ascent);
        } else if (previousEle != null) {
            dto.setAscentMeters(computedAscent);
        }
        if (descent != null) {
            dto.setDescentMeters(descent);
        } else if (previousEle != null) {
            dto.setDescentMeters(computedDescent);
        }

        if (dto.getDistanceMeters() != null && dto.getDurationSeconds() != null
                && dto.getDurationSeconds() > 0) {
            dto.setAvgSpeedKmh(dto.getDistanceMeters() / dto.getDurationSeconds() * 3.6);
        }

        if (dto.getBbox().isEmpty()) {
            JsonNode featureBbox = feature.path("bbox");
            if (!featureBbox.isArray() || featureBbox.size() < 4) {
                featureBbox = props.path("bbox");
            }
            if (featureBbox.isArray() && featureBbox.size() >= 4) {
                List<Double> bbox = new ArrayList<>();
                for (JsonNode n : featureBbox) {
                    if (n.isNumber()) {
                        bbox.add(n.asDouble());
                    }
                }
                dto.setBbox(bbox);
            }
        }

        List<String> warnings = new ArrayList<>();
        JsonNode warningNodes = props.path("warnings");
        if (warningNodes.isArray()) {
            for (JsonNode w : warningNodes) {
                if (w.isTextual()) {
                    warnings.add(w.asText());
                } else if (w.hasNonNull("message")) {
                    warnings.add(w.get("message").asText());
                } else if (w.isObject()) {
                    warnings.add(w.toString());
                }
            }
        }
        dto.setWarnings(warnings);

        List<OpenRouteExtraGroupDto> extras = new ArrayList<>();
        JsonNode extrasNode = props.path("extras");
        if (extrasNode.isObject()) {
            extrasNode.fields().forEachRemaining(entry -> {
                OpenRouteExtraGroupDto group = new OpenRouteExtraGroupDto();
                group.setKey(entry.getKey());
                List<OpenRouteExtraItemDto> items = new ArrayList<>();
                JsonNode summaryArr = entry.getValue().path("summary");
                if (summaryArr.isArray()) {
                    for (JsonNode itemNode : summaryArr) {
                        OpenRouteExtraItemDto item = new OpenRouteExtraItemDto();
                        if (itemNode.has("value") && itemNode.get("value").isNumber()) {
                            item.setValue(itemNode.get("value").asInt());
                        }
                        if (itemNode.has("distance") && itemNode.get("distance").isNumber()) {
                            item.setDistanceMeters(itemNode.get("distance").asDouble());
                        }
                        if (itemNode.has("amount") && itemNode.get("amount").isNumber()) {
                            item.setAmountPercent(itemNode.get("amount").asDouble());
                        }
                        items.add(item);
                    }
                }
                items.sort((a, b) -> Double.compare(
                        b.getAmountPercent() != null ? b.getAmountPercent() : 0,
                        a.getAmountPercent() != null ? a.getAmountPercent() : 0));
                group.setItems(items);
                extras.add(group);
            });
        }
        dto.setExtras(extras);

        List<OpenRouteStepDto> steps = new ArrayList<>();
        JsonNode segments = props.path("segments");
        int segmentCount = 0;
        if (segments.isArray()) {
            segmentCount = segments.size();
            for (JsonNode segment : segments) {
                JsonNode segmentSteps = segment.path("steps");
                if (!segmentSteps.isArray()) {
                    continue;
                }
                for (JsonNode stepNode : segmentSteps) {
                    OpenRouteStepDto step = new OpenRouteStepDto();
                    if (stepNode.hasNonNull("instruction")) {
                        step.setInstruction(stepNode.get("instruction").asText());
                    }
                    if (stepNode.hasNonNull("name")) {
                        step.setName(stepNode.get("name").asText());
                    }
                    if (stepNode.has("distance")) {
                        step.setDistanceMeters(stepNode.get("distance").asDouble());
                    }
                    if (stepNode.has("duration")) {
                        step.setDurationSeconds(stepNode.get("duration").asDouble());
                    }
                    if (stepNode.has("type")) {
                        step.setType(stepNode.get("type").asInt());
                    }
                    steps.add(step);
                }
            }
        }
        dto.setSegmentCount(segmentCount);
        dto.setSteps(steps);
        dto.setStepCount(steps.size());
        return dto;
    }

    private static Double firstDouble(JsonNode primary, String primaryKey, JsonNode secondary, String secondaryKey) {
        if (primary != null && primary.has(primaryKey) && primary.get(primaryKey).isNumber()) {
            return primary.get(primaryKey).asDouble();
        }
        if (secondary != null && secondary.has(secondaryKey) && secondary.get(secondaryKey).isNumber()) {
            return secondary.get(secondaryKey).asDouble();
        }
        return null;
    }

    private static String normalizeProfile(String profile) {
        if (!StringUtils.hasText(profile)) {
            return null;
        }
        String normalized = profile.trim().toLowerCase(Locale.ROOT);
        return ALLOWED_PROFILES.contains(normalized) ? normalized : null;
    }

    private static String normalizeLanguage(String language) {
        if (!StringUtils.hasText(language)) {
            return "en";
        }
        String lang = language.trim().toLowerCase(Locale.ROOT);
        if (lang.contains("-")) {
            lang = lang.substring(0, lang.indexOf('-'));
        }
        // PatTool uses "cn" / "jp" / "in" locale codes.
        if ("cn".equals(lang)) {
            lang = "zh";
        } else if ("jp".equals(lang)) {
            lang = "ja";
        } else if ("in".equals(lang)) {
            lang = "id";
        } else if ("el".equals(lang)) {
            lang = "en";
        } else if ("ar".equals(lang)) {
            lang = "en";
        }
        return ALLOWED_LANGUAGES.contains(lang) ? lang : "en";
    }

    private static boolean isValidLatLon(double lat, double lon) {
        return Double.isFinite(lat) && Double.isFinite(lon)
                && lat >= -90 && lat <= 90
                && lon >= -180 && lon <= 180;
    }

    private static String normalizeBase(String base) {
        if (!StringUtils.hasText(base)) {
            return "https://api.openrouteservice.org";
        }
        String trimmed = base.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }

    private static String truncate(String value, int max) {
        if (value == null) {
            return "";
        }
        return value.length() <= max ? value : value.substring(0, max) + "…";
    }
}
