package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Global map-layer display settings for Météo France (switches + cloud rendering),
 * stored in MongoDB {@code appParameters} and shared by all users.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record MeteoFranceMapLayerPreferenceDto(
        Boolean showRadar,
        Boolean showCloudLayer,
        Boolean showTemperatureMap,
        Double cloudOpacity,
        Double cloudIntensity,
        Boolean persistedInMongo
) {}
