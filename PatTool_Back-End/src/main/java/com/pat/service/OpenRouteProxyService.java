package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.OpenRouteDirectionsDto;
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

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setAccept(List.of(MediaType.APPLICATION_JSON, MediaType.parseMediaType("application/geo+json")));
        headers.set("Authorization", apiKey.trim());

        try {
            ResponseEntity<String> response = restTemplate.exchange(
                    url,
                    HttpMethod.POST,
                    new HttpEntity<>(body, headers),
                    String.class
            );
            if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                log.warn("OpenRouteService directions unexpected status {}", response.getStatusCode());
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

    private OpenRouteDirectionsDto parseGeoJson(String json, String profile) throws Exception {
        JsonNode root = objectMapper.readTree(json);
        OpenRouteDirectionsDto dto = new OpenRouteDirectionsDto();
        dto.setConfigured(true);
        dto.setProfile(profile);

        JsonNode meta = root.path("metadata");
        if (meta.hasNonNull("attribution")) {
            dto.setAttribution(meta.get("attribution").asText());
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

        List<double[]> coords = new ArrayList<>();
        JsonNode geometryCoords = feature.path("geometry").path("coordinates");
        if (geometryCoords.isArray()) {
            for (JsonNode pair : geometryCoords) {
                if (pair.isArray() && pair.size() >= 2) {
                    double lon = pair.get(0).asDouble();
                    double lat = pair.get(1).asDouble();
                    coords.add(new double[]{lat, lon});
                }
            }
        }
        dto.setCoordinates(coords);

        List<OpenRouteStepDto> steps = new ArrayList<>();
        JsonNode segments = props.path("segments");
        if (segments.isArray()) {
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
        dto.setSteps(steps);
        return dto;
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
