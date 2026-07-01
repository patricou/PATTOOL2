package com.pat.controller.dto;

/**
 * Multi-day forecast window for the Météo France page (stored in MongoDB {@code appParameters}).
 */
public record MeteoFranceForecastPreferenceDto(
        int forecastHorizonHours,
        int forecastStepMinutes,
        boolean persistedInMongo
) {}
