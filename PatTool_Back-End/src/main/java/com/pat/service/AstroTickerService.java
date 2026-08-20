package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AstroTickerDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Optional;

/**
 * Bandeau défilant du viseur, par username, dans {@code appParameters}
 * sous {@code globe.astro.ticker.<username>}. Défaut applicatif : activé.
 */
@Service
public class AstroTickerService {

    private static final Logger log = LoggerFactory.getLogger(AstroTickerService.class);

    static final String PARAM_KEY_PREFIX = "globe.astro.ticker.";

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public AstroTickerService(
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
            AstroTickerDto dto = objectMapper.readValue(raw, AstroTickerDto.class);
            return dto != null && dto.enabled() != null ? Optional.of(dto.enabled()) : Optional.empty();
        } catch (JsonProcessingException e) {
            String v = raw.trim();
            if ("true".equalsIgnoreCase(v) || "1".equals(v)) {
                return Optional.of(true);
            }
            if ("false".equalsIgnoreCase(v) || "0".equals(v)) {
                return Optional.of(false);
            }
            log.debug("globe.astro.ticker illisible: {}", e.getMessage());
            return Optional.empty();
        }
    }

    public boolean saveForSubject(String jwtSubject, boolean enabled) {
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(new AstroTickerDto(enabled));
            appParameterService.setJson(
                    key,
                    json,
                    "Viseur d'astres : bandeau défilant (infos de l'objet) choisi par l'utilisateur (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization astro ticker", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return enabled;
    }
}
