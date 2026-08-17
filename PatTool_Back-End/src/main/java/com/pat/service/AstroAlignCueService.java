package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AstroAlignCueDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Locale;
import java.util.Optional;
import java.util.Set;

/**
 * Signal de visée du viseur (off / beep / vibrate), par username, dans
 * {@code appParameters} sous {@code globe.astro.align-cue.<username>}.
 */
@Service
public class AstroAlignCueService {

    private static final Logger log = LoggerFactory.getLogger(AstroAlignCueService.class);

    static final String PARAM_KEY_PREFIX = "globe.astro.align-cue.";
    private static final Set<String> MODES = Set.of("off", "beep", "vibrate");

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public AstroAlignCueService(
            AppParameterService appParameterService,
            ObjectMapper objectMapper,
            UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public Optional<String> findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return Optional.empty();
        }
        String raw = row.get().getParamValue();
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        try {
            AstroAlignCueDto dto = objectMapper.readValue(raw, AstroAlignCueDto.class);
            return normalize(dto != null ? dto.mode() : null);
        } catch (JsonProcessingException e) {
            return normalize(raw.trim());
        }
    }

    public String saveForSubject(String jwtSubject, String mode) {
        String normalized = normalize(mode)
                .orElseThrow(() -> new IllegalArgumentException("invalid align-cue mode"));
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(new AstroAlignCueDto(normalized));
            appParameterService.setJson(
                    key,
                    json,
                    "Viseur d'astres : signal de visée (Rien / Bip / Vibration) choisi par l'utilisateur (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization astro align-cue", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return normalized;
    }

    private static Optional<String> normalize(String mode) {
        if (mode == null || mode.isBlank()) {
            return Optional.empty();
        }
        String v = mode.trim().toLowerCase(Locale.ROOT);
        if (!MODES.contains(v)) {
            log.debug("globe.astro.align-cue mode inconnu: {}", mode);
            return Optional.empty();
        }
        return Optional.of(v);
    }
}
