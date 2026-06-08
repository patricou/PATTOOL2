package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Configuration for the Stellarium Web sky map viewer (location + embed URLs built server-side).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record StellariumConfigDto(
        double lat,
        double lon,
        String placeLabel,
        /** Direct Stellarium Web URL with {@code lat}/{@code lng} query parameters. */
        String embedUrl,
        /** Same-origin PatTool viewer page (HTML iframe wrapper). */
        String viewerUrl
) {}
