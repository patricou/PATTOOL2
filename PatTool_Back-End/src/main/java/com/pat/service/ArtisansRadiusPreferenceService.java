package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.ArtisansPreferencesDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * Per-user artisans search preferences, stored in {@code appParameters}
 * under key {@code artisans.preferences.&lt;username&gt;}.
 */
@Service
public class ArtisansRadiusPreferenceService {

    private static final Logger log = LoggerFactory.getLogger(ArtisansRadiusPreferenceService.class);

    static final String PARAM_KEY_PREFIX = "artisans.preferences.";
    static final double DEFAULT_RADIUS_KM = 10;
    static final double MIN_RADIUS_KM = 1;
    static final double MAX_RADIUS_KM = 50;
    static final int DEFAULT_PER_PAGE = 500;
    static final List<Integer> PER_PAGE_OPTIONS = List.of(25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 0);

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public ArtisansRadiusPreferenceService(
            AppParameterService appParameterService,
            ObjectMapper objectMapper,
            UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public ArtisansPreferencesDto findForSubject(String jwtSubject) {
        AppParameter row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject).orElse(null);
        if (row == null || row.getParamValue() == null || row.getParamValue().isBlank()) {
            return defaults();
        }
        String raw = row.getParamValue().trim();
        try {
            JsonNode node = objectMapper.readTree(raw);
            if (node != null && node.isObject()) {
                return fromNode(node);
            }
        } catch (JsonProcessingException e) {
            log.debug("artisans.preferences unreadable JSON: {}", e.getMessage());
        }
        try {
            return new ArtisansPreferencesDto(clampRadius(Double.parseDouble(raw)));
        } catch (NumberFormatException ignored) {
            return defaults();
        }
    }

    public ArtisansPreferencesDto saveForSubject(String jwtSubject, ArtisansPreferencesDto body) {
        ArtisansPreferencesDto saved = normalize(body);
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(saved);
            appParameterService.setJson(
                    key,
                    json,
                    "Artisans / pros: per-user radius, page size and map list-only flag (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization artisan preferences", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return saved;
    }

    static ArtisansPreferencesDto defaults() {
        return new ArtisansPreferencesDto(DEFAULT_RADIUS_KM, DEFAULT_PER_PAGE, false);
    }

    static ArtisansPreferencesDto normalize(ArtisansPreferencesDto body) {
        if (body == null) {
            return defaults();
        }
        return new ArtisansPreferencesDto(
                clampRadius(body.getRadiusKm()),
                clampPerPage(body.getPerPage()),
                body.isMapListOnly());
    }

    private ArtisansPreferencesDto fromNode(JsonNode node) {
        double radius = node.path("radiusKm").isNumber()
                ? node.path("radiusKm").asDouble()
                : DEFAULT_RADIUS_KM;
        int perPage = node.path("perPage").isNumber()
                ? node.path("perPage").asInt()
                : DEFAULT_PER_PAGE;
        boolean mapListOnly = node.path("mapListOnly").asBoolean(false);
        return new ArtisansPreferencesDto(clampRadius(radius), clampPerPage(perPage), mapListOnly);
    }

    static double clampRadius(double radiusKm) {
        if (!Double.isFinite(radiusKm)) {
            return DEFAULT_RADIUS_KM;
        }
        return Math.max(MIN_RADIUS_KM, Math.min(MAX_RADIUS_KM, Math.round(radiusKm)));
    }

    static int clampPerPage(int perPage) {
        if (perPage <= 0) {
            return 0;
        }
        int best = DEFAULT_PER_PAGE;
        int bestDelta = Integer.MAX_VALUE;
        for (int option : PER_PAGE_OPTIONS) {
            if (option <= 0) {
                continue;
            }
            int delta = Math.abs(option - perPage);
            if (delta < bestDelta) {
                best = option;
                bestDelta = delta;
            }
        }
        return best;
    }
}
