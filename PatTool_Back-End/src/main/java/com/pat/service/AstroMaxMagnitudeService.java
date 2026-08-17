package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AstroMaxMagnitudeDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Optional;

/**
 * Magnitude max du viseur, par username, dans {@code appParameters}
 * sous {@code globe.astro.max-magnitude.<username>}. Défaut : 5.
 */
@Service
public class AstroMaxMagnitudeService {

    private static final Logger log = LoggerFactory.getLogger(AstroMaxMagnitudeService.class);

    static final String PARAM_KEY_PREFIX = "globe.astro.max-magnitude.";
    static final int DEFAULT_MAX_MAGNITUDE = 5;
    private static final int MIN = 0;
    private static final int MAX = 8;

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public AstroMaxMagnitudeService(
            AppParameterService appParameterService,
            ObjectMapper objectMapper,
            UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public Optional<Integer> findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return Optional.empty();
        }
        String raw = row.get().getParamValue();
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        try {
            AstroMaxMagnitudeDto dto = objectMapper.readValue(raw, AstroMaxMagnitudeDto.class);
            return clamp(dto != null ? dto.maxMagnitude() : null);
        } catch (JsonProcessingException e) {
            try {
                return clamp(Integer.parseInt(raw.trim()));
            } catch (NumberFormatException nfe) {
                log.debug("globe.astro.max-magnitude illisible: {}", e.getMessage());
                return Optional.empty();
            }
        }
    }

    public int saveForSubject(String jwtSubject, int maxMagnitude) {
        int value = clamp(maxMagnitude).orElse(DEFAULT_MAX_MAGNITUDE);
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(new AstroMaxMagnitudeDto(value));
            appParameterService.setJson(
                    key,
                    json,
                    "Viseur d'astres : magnitude max choisie par l'utilisateur (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization astro max-magnitude", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return value;
    }

    private static Optional<Integer> clamp(Integer value) {
        if (value == null) {
            return Optional.empty();
        }
        int v = Math.max(MIN, Math.min(MAX, value));
        return Optional.of(v);
    }
}
