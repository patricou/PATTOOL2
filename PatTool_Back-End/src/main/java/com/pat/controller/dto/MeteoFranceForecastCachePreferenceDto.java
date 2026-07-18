package com.pat.controller.dto;

/**
 * AROME-PI / ARPEGE forecast cache TTL (minutes, MongoDB {@code appParameters}).
 */
public record MeteoFranceForecastCachePreferenceDto(
        int forecastCacheMinutes,
        boolean persistedInMongo
) {}
