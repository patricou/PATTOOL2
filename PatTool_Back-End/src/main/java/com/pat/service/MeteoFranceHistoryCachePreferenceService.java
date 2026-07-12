package com.pat.service;

import com.pat.controller.dto.MeteoFranceHistoryCachePreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.Optional;

/**
 * MF DPClim + MeteoSwiss SMN history cache retention: per-user MongoDB preference
 * ({@code meteofrance.history.cache.<JWT sub>}), optional global Mongo override
 * ({@code meteofrance.history.cache.days}), then {@code application.properties}.
 */
@Service
public class MeteoFranceHistoryCachePreferenceService {

    static final String GLOBAL_PARAM_KEY = "meteofrance.history.cache.days";
    static final String USER_PARAM_KEY_PREFIX = "meteofrance.history.cache.";

    private static final int MIN_DAYS = 1;
    private static final int MAX_DAYS = 90;

    private final AppParameterService appParameterService;
    private final int propertiesDefaultDays;

    public MeteoFranceHistoryCachePreferenceService(
            AppParameterService appParameterService,
            @Value("${meteofrance.history.cache.days:14}") int propertiesDefaultDays) {
        this.appParameterService = appParameterService;
        this.propertiesDefaultDays = clamp(propertiesDefaultDays);
    }

    public int resolveEffectiveDays(String jwtSubject) {
        if (jwtSubject != null && !jwtSubject.isBlank()) {
            Optional<Integer> userValue = readUserDays(jwtSubject);
            if (userValue.isPresent()) {
                return userValue.get();
            }
        }
        Optional<String> globalMongo = appParameterService.find(GLOBAL_PARAM_KEY).map(AppParameter::getParamValue);
        if (globalMongo.isPresent() && !globalMongo.get().isBlank()) {
            return parseDays(globalMongo.get(), propertiesDefaultDays);
        }
        return propertiesDefaultDays;
    }

    public Duration resolveEffectiveDuration(String jwtSubject) {
        return Duration.ofDays(resolveEffectiveDays(jwtSubject));
    }

    public MeteoFranceHistoryCachePreferenceDto readForSubject(String jwtSubject) {
        int days = resolveEffectiveDays(jwtSubject);
        boolean persisted = jwtSubject != null
                && !jwtSubject.isBlank()
                && readUserDays(jwtSubject).isPresent();
        return new MeteoFranceHistoryCachePreferenceDto(days, persisted);
    }

    public MeteoFranceHistoryCachePreferenceDto saveForSubject(String jwtSubject, int historyCacheDays) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        int clamped = clamp(historyCacheDays);
        appParameterService.setLong(
                USER_PARAM_KEY_PREFIX + jwtSubject,
                clamped,
                "Météo France: MF/MS station history cache retention (days) for user.");
        return new MeteoFranceHistoryCachePreferenceDto(clamped, true);
    }

    private Optional<Integer> readUserDays(String jwtSubject) {
        return appParameterService.find(USER_PARAM_KEY_PREFIX + jwtSubject)
                .map(AppParameter::getParamValue)
                .filter(v -> v != null && !v.isBlank())
                .map(v -> parseDays(v, propertiesDefaultDays));
    }

    private static int parseDays(String raw, int fallback) {
        try {
            return clamp(Integer.parseInt(raw.trim()));
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    static int clamp(int days) {
        if (days < MIN_DAYS) {
            return MIN_DAYS;
        }
        if (days > MAX_DAYS) {
            return MAX_DAYS;
        }
        return days;
    }
}
