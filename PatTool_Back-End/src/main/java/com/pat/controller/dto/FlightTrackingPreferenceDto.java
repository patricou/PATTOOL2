package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Per-user flight tracking preference (globe options « Flight » section).
 *
 * <ul>
 *   <li>{@code mode} : {@code callsign} (callsign / flight number) or {@code icao24} (hex address);</li>
 *   <li>{@code query} : user input (callsign or hex);</li>
 *   <li>{@code pollIntervalSec} : refresh interval (s).</li>
 * </ul>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record FlightTrackingPreferenceDto(
        String mode,
        String query,
        Integer pollIntervalSec
) {}
