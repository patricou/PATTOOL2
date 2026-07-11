package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Shared ISS globe UI preferences (same for every user), stored in MongoDB
 * under {@code globe.iss.global.prefs}.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record GlobeIssGlobalPrefsDto(
        Boolean overlayEnabled,
        Boolean historicalTraceEnabled,
        Boolean historicalTraceDatesEnabled,
        Boolean traceVisible,
        Boolean keepEarthCentered,
        Boolean tickerEnabled,
        Boolean liveEmbedEnabled,
        Boolean liveHdEmbedEnabled,
        Integer pollIntervalSec) {
}
