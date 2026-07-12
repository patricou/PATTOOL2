package com.pat.controller.dto;

/**
 * Per-user MF/MS station history response cache retention (days).
 */
public record MeteoFranceHistoryCachePreferenceDto(
        int historyCacheDays,
        Boolean persistedInMongo) {
}
