package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Sky-Map.org (WikiSky) object lookup plus same-origin DSS2 cutout path.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SkyMapPreviewDto(
        String query,
        String name,
        String catalogId,
        String type,
        String constellation,
        Double raHours,
        Double deDeg,
        Double magnitude,
        Double angleDeg,
        String survey,
        /** Interactive atlas page on Sky-Map.org. */
        String atlasUrl,
        /** Relative API path for the proxied JPEG cutout ({@code external/skymap/cutout?...}). */
        String cutoutUrl,
        /** Relative API path for the HTTPS-rewritten Sky Window ({@code external/skymap/skywindow?...}). */
        String embedUrl
) {}
