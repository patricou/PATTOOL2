package com.pat.controller.dto;

/**
 * Temperature observation cache TTL for the Météo France page (minutes, stored in MongoDB {@code appParameters}).
 */
public record MeteoFranceTemperatureCachePreferenceDto(
        int temperatureCacheMinutes,
        boolean persistedInMongo
) {}
