package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record DirectionCibleDto(
        String id,
        String name,
        Double userLat,
        Double userLon,
        Double userAccM,
        Double phoneHeadingDeg,
        Double refAzimuthDeg,
        Double phoneElevationDeg,
        Double markLat,
        Double markLon,
        Double markAltM,
        String markAddress,
        Boolean clearMark,
        String photoDataUrl,
        Boolean active,
        String ownerUsername,
        String createdAt,
        String updatedAt
) {}
