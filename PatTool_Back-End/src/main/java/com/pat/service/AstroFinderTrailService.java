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
 * Switch Trajectoire du viseur, par username, dans {@code appParameters}
 * sous {@code globe.astro.finder-trail.<username>}.
 */
@Service
public class AstroFinderTrailService {

    private static final Logger log = LoggerFactory.getLogger(AstroFinderTrailService.class);

    static final String PARAM_KEY_PREFIX = "globe.astro.finder-trail.";

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

    public Optional<Boolean> findForSubject(String jwtSubject) {
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
            return dto != null && dto.enabled() != null ? Optional.of(dto.enabled()) : Optional.empty();
        } catch (JsonProcessingException e) {
            String v = raw.trim();
            if ("true".equalsIgnoreCase(v) || "1".equals(v)) {
                return Optional.of(true);
            }
            if ("false".equalsIgnoreCase(v) || "0".equals(v)) {
                return Optional.of(false);
            }
            log.debug("globe.astro.finder-trail JSON illisible: {}", e.getMessage());
            return Optional.empty();
        }
    }

    public boolean saveForSubject(String jwtSubject, boolean enabled) {
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(new AstroFinderTrailDto(enabled));
            appParameterService.setJson(
                    key,
                    json,
                    "Viseur d'astres : switch Trajectoire choisi par l'utilisateur (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization astro finder-trail", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return enabled;
    }
}
