package com.pat.service;

import com.pat.controller.dto.MeteoFranceForecastCachePreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.Optional;

/**
 * AROME-PI / ARPEGE forecast cache TTL: per-user MongoDB preference
 * ({@code meteofrance.forecast.cache.<JWT sub>}), global Mongo override
 * ({@code meteofrance.forecast.cache.minutes}), then {@code application.properties}.
 * Saving as admin also updates the global key so anonymous WMS tile requests pick up the TTL.
 */
@Service
public class MeteoFranceForecastCachePreferenceService {

    static final String GLOBAL_PARAM_KEY = "meteofrance.forecast.cache.minutes";
    static final String USER_PARAM_KEY_PREFIX = "meteofrance.forecast.cache.";

    private static final int MIN_MINUTES = 1;
    private static final int MAX_MINUTES = 120;

    private final AppParameterService appParameterService;
    private final int propertiesDefaultMinutes;

    public MeteoFranceForecastCachePreferenceService(
            AppParameterService appParameterService,
            @Value("${meteofrance.forecast.cache.minutes:5}") int propertiesDefaultMinutes) {
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

    /** TTL for public WMS tiles (no JWT): global Mongo → properties default. */
    public Duration resolveServerDuration() {
        return resolveEffectiveDuration(null);
    }

    public MeteoFranceForecastCachePreferenceDto readForSubject(String jwtSubject) {
        int minutes = resolveEffectiveMinutes(jwtSubject);
        boolean persisted = jwtSubject != null
                && !jwtSubject.isBlank()
                && readUserMinutes(jwtSubject).isPresent();
        return new MeteoFranceForecastCachePreferenceDto(minutes, persisted);
    }

    public MeteoFranceForecastCachePreferenceDto saveForSubject(String jwtSubject, int forecastCacheMinutes) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        int clamped = clamp(forecastCacheMinutes);
        appParameterService.setLong(
                USER_PARAM_KEY_PREFIX + jwtSubject,
                clamped,
                "Météo France: AROME-PI/ARPEGE forecast cache TTL (minutes) for user.");
        // Keep WMS tile TTL in sync for anonymous tile requests.
        appParameterService.setLong(
                GLOBAL_PARAM_KEY,
                clamped,
                "Météo France: AROME-PI/ARPEGE forecast cache TTL (minutes), shared server default.");
        return new MeteoFranceForecastCachePreferenceDto(clamped, true);
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
