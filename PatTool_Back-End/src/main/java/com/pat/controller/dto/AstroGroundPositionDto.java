package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Point GPS visé depuis le viseur d’astres, persisté par username
 * (collection {@code astro_ground_positions}).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonIgnoreProperties(ignoreUnknown = true)
public record AstroGroundPositionDto(
        String id,
        String name,
        String description,
        Double lat,
        Double lon,
        Double altM,
        String address,
        String ownerUsername,
        String createdAt,
        String updatedAt
) {}
