package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.DeezerPageSwitches;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Per-user Deezer page switches, stored in {@code appParameters}
 * under {@code deezer.page.<username>}.
 */
@Service
public class DeezerPageSwitchService {

    private static final Logger log = LoggerFactory.getLogger(DeezerPageSwitchService.class);

    static final String PARAM_KEY_PREFIX = "deezer.page.";

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public DeezerPageSwitchService(
            AppParameterService appParameterService,
            ObjectMapper objectMapper,
            UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    /** {@code null} when this user has never saved the switches. */
    public DeezerPageSwitches findForSubject(String jwtSubject) {
        AppParameter row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject).orElse(null);
        if (row == null || row.getParamValue() == null || row.getParamValue().isBlank()) {
            return null;
        }
        try {
            return objectMapper.readValue(row.getParamValue(), DeezerPageSwitches.class);
        } catch (JsonProcessingException e) {
            log.debug("deezer.page unreadable JSON: {}", e.getMessage());
            return null;
        }
    }

    public DeezerPageSwitches saveForSubject(String jwtSubject, DeezerPageSwitches body) {
        DeezerPageSwitches saved = body == null ? new DeezerPageSwitches() : body;
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            appParameterService.setJson(
                    key,
                    objectMapper.writeValueAsString(saved),
                    "Deezer page switches for this user (sound, continue, band, cover, loops).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization Deezer page switches", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return saved;
    }
}
