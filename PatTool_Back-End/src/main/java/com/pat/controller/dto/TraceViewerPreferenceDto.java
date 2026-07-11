package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Per-user trace viewer UI switches and basemap choice (Leaflet modal).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TraceViewerPreferenceDto(
        Boolean showAddress,
        Boolean showWeather,
        Boolean autoRefreshRadar,
        Boolean showHikingTrailsOverlay,
        Boolean showCyclingTrailsOverlay,
        Boolean followDeviceLocation,
        Boolean keepScreenAwake,
        Boolean showGpsCoordinates,
        String baseLayerId,
        Boolean persisted
) {}
