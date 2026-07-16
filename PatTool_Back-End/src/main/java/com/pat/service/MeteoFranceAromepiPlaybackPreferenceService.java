package com.pat.service;

import com.pat.controller.dto.MeteoFranceAromepiPlaybackPreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.Optional;

/**
 * AROME-PI WMS playback prefetch: per-user MongoDB preference
 * ({@code meteofrance.aromepi.playback.prefetch.<JWT sub>}), optional global Mongo override
 * ({@code meteofrance.aromepi.playback.prefetch}), then {@code application.properties}.
 */
@Service
public class MeteoFranceAromepiPlaybackPreferenceService {

    static final String GLOBAL_PARAM_KEY = "meteofrance.aromepi.playback.prefetch";
    static final String USER_PARAM_KEY_PREFIX = "meteofrance.aromepi.playback.prefetch.";

    private static final int MIN_PREFETCH = 1;
    private static final int MAX_PREFETCH = 6;

    private final AppParameterService appParameterService;
    private final int propertiesDefaultPrefetch;

    public MeteoFranceAromepiPlaybackPreferenceService(
            AppParameterService appParameterService,
            @Value("${meteofrance.aromepi.playback.prefetch:2}") int propertiesDefaultPrefetch) {
        this.appParameterService = appParameterService;
        this.propertiesDefaultPrefetch = clamp(propertiesDefaultPrefetch);
    }

    public int resolvePrefetchAhead(String jwtSubject) {
        if (jwtSubject != null && !jwtSubject.isBlank()) {
            Optional<Integer> userValue = readUserPrefetch(jwtSubject);
            if (userValue.isPresent()) {
                return userValue.get();
            }
        }
        Optional<String> globalMongo = appParameterService.find(GLOBAL_PARAM_KEY).map(AppParameter::getParamValue);
        if (globalMongo.isPresent() && !globalMongo.get().isBlank()) {
            return parsePrefetch(globalMongo.get(), propertiesDefaultPrefetch);
        }
        return propertiesDefaultPrefetch;
    }

    public MeteoFranceAromepiPlaybackPreferenceDto readForSubject(String jwtSubject) {
        int prefetch = resolvePrefetchAhead(jwtSubject);
        boolean persisted = jwtSubject != null
                && !jwtSubject.isBlank()
                && readUserPrefetch(jwtSubject).isPresent();
        return new MeteoFranceAromepiPlaybackPreferenceDto(prefetch, persisted);
    }

    public MeteoFranceAromepiPlaybackPreferenceDto saveForSubject(String jwtSubject, int prefetchAhead) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        int clamped = clamp(prefetchAhead);
        appParameterService.setLong(
                USER_PARAM_KEY_PREFIX + jwtSubject,
                clamped,
                "Météo France: AROME-PI playback prefetch (frames ahead) for user.");
        return new MeteoFranceAromepiPlaybackPreferenceDto(clamped, true);
    }

    private Optional<Integer> readUserPrefetch(String jwtSubject) {
        return appParameterService.find(USER_PARAM_KEY_PREFIX + jwtSubject)
                .map(AppParameter::getParamValue)
                .filter(v -> v != null && !v.isBlank())
                .map(v -> parsePrefetch(v, propertiesDefaultPrefetch));
    }

    private static int parsePrefetch(String raw, int fallback) {
        try {
            return clamp(Integer.parseInt(raw.trim()));
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    static int clamp(int prefetch) {
        if (prefetch < MIN_PREFETCH) {
            return MIN_PREFETCH;
        }
        if (prefetch > MAX_PREFETCH) {
            return MAX_PREFETCH;
        }
        return prefetch;
    }
}
