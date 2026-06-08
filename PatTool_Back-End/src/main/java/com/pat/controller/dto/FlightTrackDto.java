package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * Full flight trajectory (OpenSky {@code /tracks/all}): waypoints from takeoff
 * to landing (or current position if in flight with {@code time=0}).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record FlightTrackDto(
        String icao24,
        String callsign,
        Long startTime,
        Long endTime,
        List<FlightTrackPointDto> points
) {}
