package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Global radar auto-refresh settings for Météo France and trace viewer
 * (seconds + enabled switch, stored in MongoDB {@code appParameters}).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record MeteoFranceRadarPreferenceDto(
        Integer radarRefreshSeconds,
        Boolean autoRefreshEnabled,
        Boolean persistedInMongo
) {}
