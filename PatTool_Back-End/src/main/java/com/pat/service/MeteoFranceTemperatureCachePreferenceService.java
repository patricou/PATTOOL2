package com.pat.service;

import com.pat.controller.dto.MeteoFranceTemperatureCachePreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.Optional;

/**
 * Temperature observation cache TTL: per-user MongoDB preference
 * ({@code meteofrance.temperature.cache.<JWT sub>}), optional global Mongo override
 * ({@code meteofrance.temperature.cache.minutes}), then {@code application.properties}.
 */
@Service
public class MeteoFranceTemperatureCachePreferenceService {

    static final String GLOBAL_PARAM_KEY = "meteofrance.temperature.cache.minutes";
    static final String USER_PARAM_KEY_PREFIX = "meteofrance.temperature.cache.";

    private static final int MIN_MINUTES = 1;
    private static final int MAX_MINUTES = 120;

    private final AppParameterService appParameterService;
    private final int propertiesDefaultMinutes;

    public MeteoFranceTemperatureCachePreferenceService(
            AppParameterService appParameterService,
            @Value("${meteofrance.temperature.cache.minutes:5}") int propertiesDefaultMinutes) {
        this.appParameterService = appParameterService;
        this.propertiesDefaultMinutes = clamp(propertiesDefaultMinutes);
    }

    public int resolveEffectiveMinutes(String jwtSubject) {
        if (jwtSubject != null && !jwtSubject.isBlank()) {
            Optional<Integer> userValue = readUserMinutes(jwtSubject);
            if (userValue.isPresent()) {
                return userValue.get();
            }
        }
        Optional<String> globalMongo = appParameterService.find(GLOBAL_PARAM_KEY).map(AppParameter::getParamValue);
        if (globalMongo.isPresent() && !globalMongo.get().isBlank()) {
            return parseMinutes(globalMongo.get(), propertiesDefaultMinutes);
        }
        return propertiesDefaultMinutes;
    }

    public Duration resolveEffectiveDuration(String jwtSubject) {
        return Duration.ofMinutes(resolveEffectiveMinutes(jwtSubject));
    }

    public MeteoFranceTemperatureCachePreferenceDto readForSubject(String jwtSubject) {
        int minutes = resolveEffectiveMinutes(jwtSubject);
        boolean persisted = jwtSubject != null
                && !jwtSubject.isBlank()
                && readUserMinutes(jwtSubject).isPresent();
        return new MeteoFranceTemperatureCachePreferenceDto(minutes, persisted);
    }

    public MeteoFranceTemperatureCachePreferenceDto saveForSubject(String jwtSubject, int temperatureCacheMinutes) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        int clamped = clamp(temperatureCacheMinutes);
        appParameterService.setLong(
                USER_PARAM_KEY_PREFIX + jwtSubject,
                clamped,
                "Météo France: temperature observation cache TTL (minutes) for user.");
        return new MeteoFranceTemperatureCachePreferenceDto(clamped, true);
    }

    private Optional<Integer> readUserMinutes(String jwtSubject) {
        return appParameterService.find(USER_PARAM_KEY_PREFIX + jwtSubject)
                .map(AppParameter::getParamValue)
                .filter(v -> v != null && !v.isBlank())
                .map(v -> parseMinutes(v, propertiesDefaultMinutes));
    }

    private static int parseMinutes(String raw, int fallback) {
        try {
            return clamp(Integer.parseInt(raw.trim()));
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    static int clamp(int minutes) {
        if (minutes < MIN_MINUTES) {
            return MIN_MINUTES;
        }
        if (minutes > MAX_MINUTES) {
            return MAX_MINUTES;
        }
        return minutes;
    }
}
