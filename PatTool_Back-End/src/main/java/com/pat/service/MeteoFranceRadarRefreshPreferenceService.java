package com.pat.service;

import com.pat.controller.dto.MeteoFranceRadarPreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.Optional;

/**
 * Radar auto-refresh settings shared by all users: interval
 * ({@code meteofrance.radar.refresh.seconds}) and enabled switch
 * ({@code meteofrance.radar.auto-refresh.enabled}), with {@code application.properties} fallback.
 */
@Service
public class MeteoFranceRadarRefreshPreferenceService {

    static final String GLOBAL_SECONDS_KEY = "meteofrance.radar.refresh.seconds";
    static final String GLOBAL_AUTO_REFRESH_KEY = "meteofrance.radar.auto-refresh.enabled";

    private static final int MIN_SECONDS = 30;
    private static final int MAX_SECONDS = 600;
    private static final boolean DEFAULT_AUTO_REFRESH = true;

    private final AppParameterService appParameterService;
    private final int propertiesDefaultSeconds;

    public MeteoFranceRadarRefreshPreferenceService(
            AppParameterService appParameterService,
            @Value("${meteofrance.radar.refresh.seconds:60}") int propertiesDefaultSeconds) {
        this.appParameterService = appParameterService;
        this.propertiesDefaultSeconds = clamp(propertiesDefaultSeconds);
    }

    public int resolveEffectiveSeconds() {
        Optional<String> globalMongo = appParameterService.find(GLOBAL_SECONDS_KEY).map(AppParameter::getParamValue);
        if (globalMongo.isPresent() && !globalMongo.get().isBlank()) {
            return parseSeconds(globalMongo.get(), propertiesDefaultSeconds);
        }
        return propertiesDefaultSeconds;
    }

    public boolean resolveAutoRefreshEnabled() {
        return appParameterService.getBooleanSafe(GLOBAL_AUTO_REFRESH_KEY, DEFAULT_AUTO_REFRESH);
    }

    public MeteoFranceRadarPreferenceDto readGlobal() {
        int seconds = resolveEffectiveSeconds();
        boolean autoRefresh = resolveAutoRefreshEnabled();
        boolean persisted = isPersistedInMongo();
        return new MeteoFranceRadarPreferenceDto(seconds, autoRefresh, persisted);
    }

    public MeteoFranceRadarPreferenceDto saveGlobal(MeteoFranceRadarPreferenceDto patch) {
        if (patch == null) {
            throw new IllegalArgumentException("patch required");
        }
        MeteoFranceRadarPreferenceDto current = readGlobal();
        int seconds = patch.radarRefreshSeconds() != null
                ? clamp(patch.radarRefreshSeconds())
                : current.radarRefreshSeconds();
        boolean autoRefresh = patch.autoRefreshEnabled() != null
                ? patch.autoRefreshEnabled()
                : current.autoRefreshEnabled();
        appParameterService.setLong(
                GLOBAL_SECONDS_KEY,
                seconds,
                "Météo France: radar auto-refresh interval (seconds), shared by all users.");
        appParameterService.setBoolean(
                GLOBAL_AUTO_REFRESH_KEY,
                autoRefresh,
                "Météo France: radar auto-refresh enabled switch, shared by all users.");
        return new MeteoFranceRadarPreferenceDto(seconds, autoRefresh, true);
    }

    private boolean isPersistedInMongo() {
        return appParameterService.find(GLOBAL_SECONDS_KEY).isPresent()
                || appParameterService.find(GLOBAL_AUTO_REFRESH_KEY).isPresent();
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
