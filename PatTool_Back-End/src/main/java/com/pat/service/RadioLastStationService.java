package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.RadioStationDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.Optional;

/**
 * Per-user last played radio station, stored in {@code appParameters}
 * under key {@code radio.last-station.<JWT sub>}.
 */
@Service
public class RadioLastStationService {

    private static final Logger log = LoggerFactory.getLogger(RadioLastStationService.class);

    static final String PARAM_KEY_PREFIX = "radio.last-station.";

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;

    public RadioLastStationService(AppParameterService appParameterService, ObjectMapper objectMapper) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
    }

    public RadioStationDto findForSubject(String jwtSubject) {
        if (!StringUtils.hasText(jwtSubject)) {
            return null;
        }
        String key = PARAM_KEY_PREFIX + jwtSubject;
        Optional<AppParameter> row = appParameterService.find(key);
        if (row.isEmpty()) {
            return null;
        }
        String raw = row.get().getParamValue();
        if (!StringUtils.hasText(raw)) {
            return null;
        }
        try {
            return RadioFavoritesService.normalizeStation(objectMapper.readValue(raw, RadioStationDto.class));
        } catch (JsonProcessingException e) {
            log.debug("radio.last-station unreadable JSON for key {}: {}", key, e.getMessage());
            return null;
        }
    }

    public RadioStationDto saveForSubject(String jwtSubject, RadioStationDto station) {
        if (!StringUtils.hasText(jwtSubject)) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        RadioStationDto normalized = RadioFavoritesService.normalizeStation(station);
        if (normalized == null) {
            throw new IllegalArgumentException("invalid station");
        }
        String key = PARAM_KEY_PREFIX + jwtSubject;
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Radio watcher: last played station per user (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization radio last station", e);
        }
        return normalized;
    }
}
