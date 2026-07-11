package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/** One user's ISS visible-pass alert (admin overview). */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record IssAlertAdminEntryDto(
        String userId,
        String owner,
        boolean enabled,
        String email,
        String place,
        String placeLabel,
        Double lat,
        Double lon,
        String minQuality) {
}
