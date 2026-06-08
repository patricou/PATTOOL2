package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.FlightTrackingPreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Locale;
import java.util.Optional;
import java.util.Set;

/**
 * Per-user flight tracking preference (OpenSky), stored in
 * {@code appParameters} under key {@code globe.flight.tracking.<JWT sub>}.
 *
 * <p>Remembers the last tracked flight (callsign or ICAO24 address) so the user does not
 * have to re-enter it on each visit. Survives backend restarts (MongoDB).</p>
 */
@Service
public class FlightTrackingPreferenceService {

    private static final Logger log = LoggerFactory.getLogger(FlightTrackingPreferenceService.class);

    static final String PARAM_KEY_PREFIX = "globe.flight.tracking.";
    private static final Set<String> SUPPORTED_MODES = Set.of("callsign", "icao24");
    private static final int POLL_MIN_SEC = 10;
    private static final int POLL_MAX_SEC = 600;
    private static final int POLL_DEFAULT_SEC = 15;
    private static final int QUERY_MAX_LEN = 16;

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;

    public FlightTrackingPreferenceService(
            AppParameterService appParameterService,
            ObjectMapper objectMapper) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
    }

    public Optional<FlightTrackingPreferenceDto> findForSubject(String jwtSubject) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            return Optional.empty();
        }
        String key = PARAM_KEY_PREFIX + jwtSubject;
        Optional<AppParameter> row = appParameterService.find(key);
        if (row.isEmpty()) {
            return Optional.empty();
        }
        String raw = row.get().getParamValue();
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        try {
            FlightTrackingPreferenceDto dto = objectMapper.readValue(raw, FlightTrackingPreferenceDto.class);
            return validate(dto);
        } catch (JsonProcessingException e) {
            log.debug("globe.flight.tracking unreadable JSON for key {}: {}", key, e.getMessage());
            return Optional.empty();
        }
    }

    public FlightTrackingPreferenceDto saveForSubject(String jwtSubject, FlightTrackingPreferenceDto dto) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        FlightTrackingPreferenceDto normalized = validate(dto)
                .orElseThrow(() -> new IllegalArgumentException("invalid flight tracking payload"));
        String key = PARAM_KEY_PREFIX + jwtSubject;
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Globe: last flight tracked by user (OpenSky, JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization flight tracking preference", e);
        }
        return normalized;
    }

    public void deleteForSubject(String jwtSubject) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            return;
        }
        appParameterService.delete(PARAM_KEY_PREFIX + jwtSubject);
    }

    /** Validates mode + query and clamps interval; returns {@code empty} if invalid. */
    private Optional<FlightTrackingPreferenceDto> validate(FlightTrackingPreferenceDto dto) {
        if (dto == null || dto.mode() == null || dto.query() == null) {
            return Optional.empty();
        }
        String mode = dto.mode().trim().toLowerCase(Locale.ROOT);
        if (!SUPPORTED_MODES.contains(mode)) {
            return Optional.empty();
        }
        String query = dto.query().trim();
        if (query.isEmpty() || query.length() > QUERY_MAX_LEN) {
            return Optional.empty();
        }
        boolean valid = "icao24".equals(mode)
                ? OpenSkyService.isValidIcao24(query)
                : OpenSkyService.isValidCallsign(query);
        if (!valid) {
            return Optional.empty();
        }
        query = "icao24".equals(mode)
                ? query.toLowerCase(Locale.ROOT)
                : query.toUpperCase(Locale.ROOT);
        int poll = dto.pollIntervalSec() != null ? dto.pollIntervalSec() : POLL_DEFAULT_SEC;
        poll = Math.max(POLL_MIN_SEC, Math.min(POLL_MAX_SEC, poll));
        return Optional.of(new FlightTrackingPreferenceDto(mode, query, poll));
    }
}
