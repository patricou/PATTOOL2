package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Per-user trace viewer UI switches and basemap choice (Leaflet modal).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TraceViewerPreferenceDto(
        Boolean showAddress,
        Boolean showWeather,
        Boolean showWeatherStations,
        Boolean autoRefreshRadar,
        Boolean showHikingTrailsOverlay,
        Boolean showCyclingTrailsOverlay,
        Boolean showMtbTrailsOverlay,
        Boolean showRailwayOverlay,
        Boolean showSlopesOverlay,
        Boolean showPlacesOverlay,
        Boolean followDeviceLocation,
        Boolean keepScreenAwake,
        Boolean showGpsCoordinates,
        String baseLayerId,
        /** Empty when the viewer shows a single basemap. */
        String secondaryBaseLayerId,
        /** 0 = first basemap only, 100 = second basemap only. */
        Integer basemapBlend,
        Boolean persisted
) {}
