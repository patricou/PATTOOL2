package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/** OpenSky track waypoint (departure → arrival). */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record FlightTrackPointDto(
        Long time,
        Double latitude,
        Double longitude,
        Double baroAltitudeM,
        Double trueTrackDeg,
        Boolean onGround
) {}
