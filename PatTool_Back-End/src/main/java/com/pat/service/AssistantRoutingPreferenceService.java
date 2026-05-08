package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AssistantRoutingPreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Optional;

/**
 * Préférences assistant (fournisseur / modèle) par utilisateur Keycloak, stockées dans
 * {@code appParameters} sous la clé {@code assistant.routing.&lt;sub JWT&gt;}.
 */
@Service
public class AssistantRoutingPreferenceService {

    private static final Logger log = LoggerFactory.getLogger(AssistantRoutingPreferenceService.class);

    static final String PARAM_KEY_PREFIX = "assistant.routing.";

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;

    public AssistantRoutingPreferenceService(
            AppParameterService appParameterService,
            ObjectMapper objectMapper) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
    }

    public Optional<AssistantRoutingPreferenceDto> findForSubject(String jwtSubject) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            return Optional.empty();
        }
        String key = PARAM_KEY_PREFIX + jwtSubject;
        Optional<AppParameter> row = appParameterService.find(key);
        if (row.isEmpty()) {
            return Optional.empty();
        }
        String raw = row.get().getParamValue();
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        try {
            AssistantRoutingPreferenceDto dto = objectMapper.readValue(raw, AssistantRoutingPreferenceDto.class);
            if (dto == null || dto.provider() == null || dto.modelPreset() == null) {
                return Optional.empty();
            }
            if (!"openai".equals(dto.provider()) && !"anthropic".equals(dto.provider())) {
                return Optional.empty();
            }
            return Optional.of(new AssistantRoutingPreferenceDto(
                    dto.provider(),
                    dto.modelPreset(),
                    dto.modelCustom() != null ? dto.modelCustom() : ""));
        } catch (JsonProcessingException e) {
            log.warn("assistant.routing JSON illisible pour clé {}: {}", key, e.getMessage());
            return Optional.empty();
        }
    }

    public void saveForSubject(String jwtSubject, AssistantRoutingPreferenceDto dto) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        String key = PARAM_KEY_PREFIX + jwtSubject;
        String custom = dto.modelCustom() != null ? dto.modelCustom() : "";
        AssistantRoutingPreferenceDto normalized = new AssistantRoutingPreferenceDto(
                dto.provider(),
                dto.modelPreset(),
                custom);
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Assistant: fournisseur et modèle choisis par l'utilisateur (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization assistant routing preference", e);
        }
    }
}
