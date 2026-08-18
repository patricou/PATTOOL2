package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AstroFinderTrailDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Optional;

/**
 * Trajectoire du viseur (switch + durée), par username, dans {@code appParameters}
 * sous {@code globe.astro.finder-trail.<username>}.
 */
@Service
public class AstroFinderTrailService {

    private static final Logger log = LoggerFactory.getLogger(AstroFinderTrailService.class);

    static final String PARAM_KEY_PREFIX = "globe.astro.finder-trail.";
    static final int SAT_MIN = 5;
    static final int SAT_MAX = 60;
    static final int SAT_STEP = 5;
    static final int SKY_MIN = 15;
    static final int SKY_MAX = 360;
    static final int SKY_STEP = 15;

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public AstroFinderTrailService(
            AppParameterService appParameterService,
            ObjectMapper objectMapper,
            UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public Optional<AstroFinderTrailDto> findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return Optional.empty();
        }
        String raw = row.get().getParamValue();
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        try {
            AstroFinderTrailDto dto = objectMapper.readValue(raw, AstroFinderTrailDto.class);
            return normalize(dto);
        } catch (JsonProcessingException e) {
            String v = raw.trim();
            if ("true".equalsIgnoreCase(v) || "1".equals(v)) {
                return Optional.of(new AstroFinderTrailDto(true, null, null));
            }
            if ("false".equalsIgnoreCase(v) || "0".equals(v)) {
                return Optional.of(new AstroFinderTrailDto(false, null, null));
            }
            log.debug("globe.astro.finder-trail JSON illisible: {}", e.getMessage());
            return Optional.empty();
        }
    }

    public AstroFinderTrailDto saveForSubject(String jwtSubject, AstroFinderTrailDto incoming) {
        AstroFinderTrailDto existing = findForSubject(jwtSubject).orElse(null);
        boolean enabled = incoming != null && incoming.enabled() != null
                ? incoming.enabled()
                : existing != null && Boolean.TRUE.equals(existing.enabled());
        Integer sat = clampSat(firstNonNull(
                incoming != null ? incoming.satMinutes() : null,
                existing != null ? existing.satMinutes() : null));
        Integer sky = clampSky(firstNonNull(
                incoming != null ? incoming.skyMinutes() : null,
                existing != null ? existing.skyMinutes() : null));
        AstroFinderTrailDto saved = new AstroFinderTrailDto(enabled, sat, sky);
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(saved);
            appParameterService.setJson(
                    key,
                    json,
                    "Viseur d'astres : Trajectoire du viseur (switch et durée) choisie par l'utilisateur (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization astro finder-trail", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return saved;
    }

    private static Optional<AstroFinderTrailDto> normalize(AstroFinderTrailDto dto) {
        if (dto == null) {
            return Optional.empty();
        }
        Boolean enabled = dto.enabled();
        Integer sat = clampSat(dto.satMinutes());
        Integer sky = clampSky(dto.skyMinutes());
        if (enabled == null && sat == null && sky == null) {
            return Optional.empty();
        }
        return Optional.of(new AstroFinderTrailDto(enabled, sat, sky));
    }

    private static Integer firstNonNull(Integer a, Integer b) {
        return a != null ? a : b;
    }

    static Integer clampSat(Integer value) {
        return clamp(value, SAT_MIN, SAT_MAX, SAT_STEP);
    }

    static Integer clampSky(Integer value) {
        return clamp(value, SKY_MIN, SKY_MAX, SKY_STEP);
    }

    private static Integer clamp(Integer value, int min, int max, int step) {
        if (value == null) {
            return null;
        }
        int rounded = Math.round(value / (float) step) * step;
        return Math.max(min, Math.min(max, rounded));
    }
}
