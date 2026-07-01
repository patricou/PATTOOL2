package com.pat.service;

import com.pat.controller.dto.MeteoFranceForecastPreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.Optional;
import java.util.Set;

/**
 * Forecast horizon and step: per-user MongoDB preference
 * ({@code meteofrance.forecast.horizon.<JWT sub>},
 * {@code meteofrance.forecast.step.<JWT sub>}), optional global Mongo overrides,
 * then {@code application.properties}.
 */
@Service
public class MeteoFranceForecastPreferenceService {

    static final String GLOBAL_HORIZON_KEY = "meteofrance.forecast.horizon.hours";
    static final String GLOBAL_STEP_KEY = "meteofrance.forecast.step.minutes";
    /** @deprecated legacy global key when step was stored in hours */
    static final String GLOBAL_STEP_KEY_LEGACY_HOURS = "meteofrance.forecast.step.hours";
    static final String USER_HORIZON_KEY_PREFIX = "meteofrance.forecast.horizon.";
    static final String USER_STEP_KEY_PREFIX = "meteofrance.forecast.step.";

    private static final int MIN_HORIZON_HOURS = 24;
    private static final int MAX_HORIZON_HOURS = 240;
    private static final int MIN_STEP_MINUTES = 6;
    private static final int MAX_STEP_MINUTES = 1440;
    private static final Set<Integer> LEGACY_STEP_HOURS = Set.of(1, 3, 6, 12, 24);

    private final AppParameterService appParameterService;
    private final int propertiesDefaultHorizonHours;
    private final int propertiesDefaultStepMinutes;

    public MeteoFranceForecastPreferenceService(
            AppParameterService appParameterService,
            @Value("${meteofrance.forecast.horizon.hours:24}") int propertiesDefaultHorizonHours,
            @Value("${meteofrance.forecast.step.minutes:60}") int propertiesDefaultStepMinutes) {
        this.appParameterService = appParameterService;
        this.propertiesDefaultHorizonHours = clampHorizon(propertiesDefaultHorizonHours);
        this.propertiesDefaultStepMinutes = clampStep(propertiesDefaultStepMinutes);
    }

    public int resolveHorizonHours(String jwtSubject) {
        if (jwtSubject != null && !jwtSubject.isBlank()) {
            Optional<Integer> userValue = readUserHorizon(jwtSubject);
            if (userValue.isPresent()) {
                return userValue.get();
            }
        }
        Optional<String> globalMongo = appParameterService.find(GLOBAL_HORIZON_KEY).map(AppParameter::getParamValue);
        if (globalMongo.isPresent() && !globalMongo.get().isBlank()) {
            return parseHorizon(globalMongo.get(), propertiesDefaultHorizonHours);
        }
        return propertiesDefaultHorizonHours;
    }

    public int resolveStepMinutes(String jwtSubject) {
        if (jwtSubject != null && !jwtSubject.isBlank()) {
            Optional<Integer> userValue = readUserStep(jwtSubject);
            if (userValue.isPresent()) {
                return userValue.get();
            }
        }
        Optional<String> globalMongo = appParameterService.find(GLOBAL_STEP_KEY).map(AppParameter::getParamValue);
        if (globalMongo.isPresent() && !globalMongo.get().isBlank()) {
            return parseStep(globalMongo.get(), propertiesDefaultStepMinutes);
        }
        Optional<String> legacyGlobal = appParameterService.find(GLOBAL_STEP_KEY_LEGACY_HOURS)
                .map(AppParameter::getParamValue);
        if (legacyGlobal.isPresent() && !legacyGlobal.get().isBlank()) {
            return parseLegacyStepHours(legacyGlobal.get(), propertiesDefaultStepMinutes);
        }
        return propertiesDefaultStepMinutes;
    }

    public MeteoFranceForecastPreferenceDto readForSubject(String jwtSubject) {
        int horizon = resolveHorizonHours(jwtSubject);
        int step = resolveStepMinutes(jwtSubject);
        boolean persisted = jwtSubject != null
                && !jwtSubject.isBlank()
                && (readUserHorizon(jwtSubject).isPresent() || readUserStep(jwtSubject).isPresent());
        return new MeteoFranceForecastPreferenceDto(horizon, step, persisted);
    }

    public MeteoFranceForecastPreferenceDto saveForSubject(
            String jwtSubject, int forecastHorizonHours, int forecastStepMinutes) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        int horizon = clampHorizon(forecastHorizonHours);
        int step = clampStep(forecastStepMinutes);
        appParameterService.setLong(
                USER_HORIZON_KEY_PREFIX + jwtSubject,
                horizon,
                "Météo France: forecast horizon (hours) for user.");
        appParameterService.setLong(
                USER_STEP_KEY_PREFIX + jwtSubject,
                step,
                "Météo France: forecast step (minutes) for user.");
        return new MeteoFranceForecastPreferenceDto(horizon, step, true);
    }

    private Optional<Integer> readUserHorizon(String jwtSubject) {
        return appParameterService.find(USER_HORIZON_KEY_PREFIX + jwtSubject)
                .map(AppParameter::getParamValue)
                .filter(v -> v != null && !v.isBlank())
                .map(v -> parseHorizon(v, propertiesDefaultHorizonHours));
    }

    private Optional<Integer> readUserStep(String jwtSubject) {
        return appParameterService.find(USER_STEP_KEY_PREFIX + jwtSubject)
                .map(AppParameter::getParamValue)
                .filter(v -> v != null && !v.isBlank())
                .map(v -> parseStep(v, propertiesDefaultStepMinutes));
    }

    private static int parseHorizon(String raw, int fallback) {
        try {
            return clampHorizon(Integer.parseInt(raw.trim()));
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static int parseStep(String raw, int fallback) {
        try {
            return clampStep(normalizeStepInput(Integer.parseInt(raw.trim())));
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static int parseLegacyStepHours(String raw, int fallback) {
        try {
            int hours = Integer.parseInt(raw.trim());
            return normalizeLegacyStepHours(hours);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    /** Values 1–24 stored before the switch to minutes were hours (when read from legacy keys). */
    static int normalizeStepInput(int value) {
        return value;
    }

    public static int clampHorizon(int hours) {
        if (hours < MIN_HORIZON_HOURS) {
            return MIN_HORIZON_HOURS;
        }
        if (hours > MAX_HORIZON_HOURS) {
            return MAX_HORIZON_HOURS;
        }
        return hours;
    }

    public static int clampStep(int minutes) {
        int normalized = normalizeStepInput(minutes);
        if (normalized < MIN_STEP_MINUTES) {
            return MIN_STEP_MINUTES;
        }
        if (normalized > MAX_STEP_MINUTES) {
            return MAX_STEP_MINUTES;
        }
        return normalized;
    }

    /** Legacy global/user values stored as hours (1, 3, 6, 12, 24). */
    static int normalizeLegacyStepHours(int hours) {
        if (LEGACY_STEP_HOURS.contains(hours)) {
            return clampStep(hours * 60);
        }
        return clampStep(hours);
    }
}

