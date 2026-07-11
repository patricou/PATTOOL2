package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.GlobeIssGlobalPrefsDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Optional;

/**
 * Shared ISS globe switch states (MongoDB {@code globe.iss.global.prefs}, JSON).
 * Recording and trace display-limit toggles use their own dedicated keys.
 */
@Service
public class GlobeIssGlobalPrefsService {

    private static final Logger log = LoggerFactory.getLogger(GlobeIssGlobalPrefsService.class);

    public static final String PARAM_GLOBAL_PREFS = "globe.iss.global.prefs";

    private static final boolean DEFAULT_OVERLAY = true;
    private static final boolean DEFAULT_HISTORICAL_TRACE = false;
    private static final boolean DEFAULT_HISTORICAL_TRACE_DATES = false;
    private static final boolean DEFAULT_TRACE_VISIBLE = true;
    private static final boolean DEFAULT_KEEP_EARTH_CENTERED = true;
    private static final boolean DEFAULT_TICKER = true;
    private static final boolean DEFAULT_LIVE_EMBED = true;
    private static final boolean DEFAULT_LIVE_HD_EMBED = true;
    private static final int DEFAULT_POLL_SEC = 2;
    private static final int POLL_MIN_SEC = 2;
    private static final int POLL_MAX_SEC = 600;

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;

    public GlobeIssGlobalPrefsService(AppParameterService appParameterService, ObjectMapper objectMapper) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
    }

    public GlobeIssGlobalPrefsDto getPrefs() {
        return mergeWithDefaults(readStored());
    }

    public GlobeIssGlobalPrefsDto updatePrefs(GlobeIssGlobalPrefsDto patch) {
        GlobeIssGlobalPrefsDto current = mergeWithDefaults(readStored());
        GlobeIssGlobalPrefsDto merged = new GlobeIssGlobalPrefsDto(
                patch.overlayEnabled() != null ? patch.overlayEnabled() : current.overlayEnabled(),
                patch.historicalTraceEnabled() != null ? patch.historicalTraceEnabled() : current.historicalTraceEnabled(),
                patch.historicalTraceDatesEnabled() != null ? patch.historicalTraceDatesEnabled()
                        : current.historicalTraceDatesEnabled(),
                patch.traceVisible() != null ? patch.traceVisible() : current.traceVisible(),
                patch.keepEarthCentered() != null ? patch.keepEarthCentered() : current.keepEarthCentered(),
                patch.tickerEnabled() != null ? patch.tickerEnabled() : current.tickerEnabled(),
                patch.liveEmbedEnabled() != null ? patch.liveEmbedEnabled() : current.liveEmbedEnabled(),
                patch.liveHdEmbedEnabled() != null ? patch.liveHdEmbedEnabled() : current.liveHdEmbedEnabled(),
                patch.pollIntervalSec() != null ? clampPollSec(patch.pollIntervalSec()) : current.pollIntervalSec());
        writeStored(merged);
        return merged;
    }

    private Optional<GlobeIssGlobalPrefsDto> readStored() {
        Optional<AppParameter> row = appParameterService.find(PARAM_GLOBAL_PREFS);
        if (row.isEmpty()) {
            return Optional.empty();
        }
        String raw = row.get().getParamValue();
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        try {
            return Optional.of(objectMapper.readValue(raw, GlobeIssGlobalPrefsDto.class));
        } catch (JsonProcessingException e) {
            log.warn("globe.iss.global.prefs unreadable JSON: {}", e.getMessage());
            return Optional.empty();
        }
    }

    private void writeStored(GlobeIssGlobalPrefsDto prefs) {
        try {
            String json = objectMapper.writeValueAsString(prefs);
            appParameterService.setJson(
                    PARAM_GLOBAL_PREFS,
                    json,
                    "Shared ISS globe UI switch states (all users).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization globe ISS global prefs", e);
        }
    }

    private GlobeIssGlobalPrefsDto mergeWithDefaults(Optional<GlobeIssGlobalPrefsDto> stored) {
        GlobeIssGlobalPrefsDto s = stored.orElse(new GlobeIssGlobalPrefsDto(
                null, null, null, null, null, null, null, null, null));
        return new GlobeIssGlobalPrefsDto(
                s.overlayEnabled() != null ? s.overlayEnabled() : DEFAULT_OVERLAY,
                s.historicalTraceEnabled() != null ? s.historicalTraceEnabled() : DEFAULT_HISTORICAL_TRACE,
                s.historicalTraceDatesEnabled() != null ? s.historicalTraceDatesEnabled() : DEFAULT_HISTORICAL_TRACE_DATES,
                s.traceVisible() != null ? s.traceVisible() : DEFAULT_TRACE_VISIBLE,
                s.keepEarthCentered() != null ? s.keepEarthCentered() : DEFAULT_KEEP_EARTH_CENTERED,
                s.tickerEnabled() != null ? s.tickerEnabled() : DEFAULT_TICKER,
                s.liveEmbedEnabled() != null ? s.liveEmbedEnabled() : DEFAULT_LIVE_EMBED,
                s.liveHdEmbedEnabled() != null ? s.liveHdEmbedEnabled() : DEFAULT_LIVE_HD_EMBED,
                s.pollIntervalSec() != null ? clampPollSec(s.pollIntervalSec()) : DEFAULT_POLL_SEC);
    }

    private static int clampPollSec(int sec) {
        return Math.max(POLL_MIN_SEC, Math.min(POLL_MAX_SEC, sec));
    }
}
