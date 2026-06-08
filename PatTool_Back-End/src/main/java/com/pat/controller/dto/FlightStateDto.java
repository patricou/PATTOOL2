package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Current flight state returned by the OpenSky Network proxy (one state vector).
 * Numeric fields may be {@code null} if the aircraft does not broadcast them.
 *
 * <ul>
 *   <li>{@code icao24} : 24-bit ICAO address (hex), unique aircraft identifier;</li>
 *   <li>{@code callsign} : radio callsign / flight number (e.g. {@code AFR447});</li>
 *   <li>{@code latitude}/{@code longitude} : WGS84 position (degrees);</li>
 *   <li>{@code baroAltitudeM}/{@code geoAltitudeM} : barometric / geometric altitude (m);</li>
 *   <li>{@code velocityMs} : ground speed (m/s);</li>
 *   <li>{@code trueTrackDeg} : true track (degrees, 0 = North, clockwise);</li>
 *   <li>{@code verticalRateMs} : vertical rate (m/s, + = climb);</li>
 *   <li>{@code onGround} : aircraft on ground;</li>
 *   <li>{@code lastContact} : last contact (epoch seconds);</li>
 *   <li>{@code departureAirport}/{@code arrivalAirport} : estimated ICAO codes (OpenSky {@code /flights/aircraft});</li>
 *   <li>{@code departureTimeEpoch}/{@code arrivalTimeEpoch} : estimated departure / arrival times
 *       (OpenSky {@code firstSeen} / {@code lastSeen}, UTC epoch seconds).</li>
 * </ul>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record FlightStateDto(
        String icao24,
        String callsign,
        String originCountry,
        Double latitude,
        Double longitude,
        Double baroAltitudeM,
        Double geoAltitudeM,
        Double velocityMs,
        Double trueTrackDeg,
        Double verticalRateMs,
        Boolean onGround,
        Long lastContact,
        String departureAirport,
        String arrivalAirport,
        Long departureTimeEpoch,
        Long arrivalTimeEpoch
) {}
