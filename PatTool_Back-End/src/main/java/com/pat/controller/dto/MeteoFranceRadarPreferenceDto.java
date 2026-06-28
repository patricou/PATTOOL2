package com.pat.controller.dto;

/**
 * Radar auto-refresh interval for the Météo France page (seconds, stored in MongoDB {@code appParameters}).
 */
public record MeteoFranceRadarPreferenceDto(
        int radarRefreshSeconds,
        boolean persistedInMongo
) {}
