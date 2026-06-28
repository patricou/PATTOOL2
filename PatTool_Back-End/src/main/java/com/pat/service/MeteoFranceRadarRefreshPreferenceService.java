package com.pat.service;

import com.pat.controller.dto.MeteoFranceRadarPreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.Optional;

/**
 * Radar auto-refresh interval: per-user MongoDB preference
 * ({@code meteofrance.radar.refresh.<JWT sub>}), optional global Mongo override
 * ({@code meteofrance.radar.refresh.seconds}), then {@code application.properties}.
 */
@Service
public class MeteoFranceRadarRefreshPreferenceService {

    static final String GLOBAL_PARAM_KEY = "meteofrance.radar.refresh.seconds";
    static final String USER_PARAM_KEY_PREFIX = "meteofrance.radar.refresh.";

    private static final int MIN_SECONDS = 30;
    private static final int MAX_SECONDS = 600;

    private final AppParameterService appParameterService;
    private final int propertiesDefaultSeconds;

    public MeteoFranceRadarRefreshPreferenceService(
            AppParameterService appParameterService,
            @Value("${meteofrance.radar.refresh.seconds:60}") int propertiesDefaultSeconds) {
        this.appParameterService = appParameterService;
        this.propertiesDefaultSeconds = clamp(propertiesDefaultSeconds);
    }

    public int resolveEffectiveSeconds(String jwtSubject) {
        if (jwtSubject != null && !jwtSubject.isBlank()) {
            Optional<Integer> userValue = readUserSeconds(jwtSubject);
            if (userValue.isPresent()) {
                return userValue.get();
            }
        }
        Optional<String> globalMongo = appParameterService.find(GLOBAL_PARAM_KEY).map(AppParameter::getParamValue);
        if (globalMongo.isPresent() && !globalMongo.get().isBlank()) {
            return parseSeconds(globalMongo.get(), propertiesDefaultSeconds);
        }
        return propertiesDefaultSeconds;
    }

    public MeteoFranceRadarPreferenceDto readForSubject(String jwtSubject) {
        int seconds = resolveEffectiveSeconds(jwtSubject);
        boolean persisted = jwtSubject != null
                && !jwtSubject.isBlank()
                && readUserSeconds(jwtSubject).isPresent();
        return new MeteoFranceRadarPreferenceDto(seconds, persisted);
    }

    public MeteoFranceRadarPreferenceDto saveForSubject(String jwtSubject, int radarRefreshSeconds) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        int clamped = clamp(radarRefreshSeconds);
        appParameterService.setLong(
                USER_PARAM_KEY_PREFIX + jwtSubject,
                clamped,
                "Météo France: radar auto-refresh interval (seconds) for user.");
        return new MeteoFranceRadarPreferenceDto(clamped, true);
    }

    private Optional<Integer> readUserSeconds(String jwtSubject) {
        return appParameterService.find(USER_PARAM_KEY_PREFIX + jwtSubject)
                .map(AppParameter::getParamValue)
                .filter(v -> v != null && !v.isBlank())
                .map(v -> parseSeconds(v, propertiesDefaultSeconds));
    }

    private static int parseSeconds(String raw, int fallback) {
        try {
            return clamp(Integer.parseInt(raw.trim()));
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    static int clamp(int seconds) {
        if (seconds < MIN_SECONDS) {
            return MIN_SECONDS;
        }
        if (seconds > MAX_SECONDS) {
            return MAX_SECONDS;
        }
        return seconds;
    }
}
