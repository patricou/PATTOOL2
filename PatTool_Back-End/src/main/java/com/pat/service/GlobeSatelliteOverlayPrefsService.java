package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.GlobeSatelliteOverlayPrefsDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Per-user satellite overlay switches on the world globe, stored in
 * {@code appParameters} under key {@code globe.satellite.overlays.<JWT sub>}.
 */
@Service
public class GlobeSatelliteOverlayPrefsService {

    private static final Logger log = LoggerFactory.getLogger(GlobeSatelliteOverlayPrefsService.class);

    static final String PARAM_KEY_PREFIX = "globe.satellite.overlays.";

    /** Same ids as astro-compass / world-globe (ISS is not an overlay switch). */
    static final Set<String> KNOWN_SATELLITE_IDS = Set.of(
            "tiangong",
            "hubble",
            "jwst",
            "terra",
            "aqua",
            "landsat8",
            "landsat9",
            "sentinel2a",
            "sentinel2b",
            "noaa20",
            "noaa21",
            "suominpp",
            "aura",
            "sentinel1a",
            "sentinel1c",
            "sentinel2c",
            "sentinel3a",
            "sentinel3b",
            "sentinel5p",
            "sentinel6",
            "metopb",
            "metopc",
            "gpm",
            "swift",
            "fermi",
            "astra192",
            "starlink",
            "tess",
            "chandra",
            "xmm",
            "xrism",
            "euclid",
            "gaia",
            "noaa19",
            "goes16",
            "meteosat11",
            "mtgi1",
            "himawari9",
            "pleiades1a",
            "spot6",
            "swot",
            "smap",
            "icesat2",
            "oco2",
            "bluewalker3",
            "eutelsat5w",
            "hotbird13"
    );

    /** Starlink train is opt-in (heavy group TLE). */
    private static final Set<String> DEFAULT_OFF_SATELLITE_IDS = Set.of("starlink");

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public GlobeSatelliteOverlayPrefsService(
            AppParameterService appParameterService,
            ObjectMapper objectMapper,
            UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public Optional<GlobeSatelliteOverlayPrefsDto> findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return Optional.empty();
        }
        String raw = row.get().getParamValue();
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        try {
            GlobeSatelliteOverlayPrefsDto dto = objectMapper.readValue(raw, GlobeSatelliteOverlayPrefsDto.class);
            return Optional.of(normalize(dto));
        } catch (JsonProcessingException e) {
            log.debug("globe.satellite.overlays unreadable JSON: {}", e.getMessage());
            return Optional.empty();
        }
    }

    public GlobeSatelliteOverlayPrefsDto saveForSubject(String jwtSubject, GlobeSatelliteOverlayPrefsDto dto) {
        GlobeSatelliteOverlayPrefsDto normalized = normalize(dto);
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Globe: satellite overlay switches by user (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization satellite overlay prefs", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return normalized;
    }

    GlobeSatelliteOverlayPrefsDto normalize(GlobeSatelliteOverlayPrefsDto dto) {
        Map<String, Boolean> incoming = dto != null && dto.enabled() != null
                ? dto.enabled()
                : Map.of();
        Map<String, Boolean> out = new LinkedHashMap<>();
        for (String id : KNOWN_SATELLITE_IDS) {
            out.put(id, !DEFAULT_OFF_SATELLITE_IDS.contains(id));
        }
        for (Map.Entry<String, Boolean> e : incoming.entrySet()) {
            if (e.getKey() == null || e.getValue() == null) {
                continue;
            }
            String id = e.getKey().trim().toLowerCase(Locale.ROOT);
            if (KNOWN_SATELLITE_IDS.contains(id)) {
                out.put(id, e.getValue());
            }
        }
        Map<String, Boolean> incomingTraces = dto != null && dto.futureTraceEnabledById() != null
                ? dto.futureTraceEnabledById()
                : Map.of();
        boolean hasPerSatTraces = !incomingTraces.isEmpty();
        boolean legacyAllOn = !hasPerSatTraces
                && dto != null
                && Boolean.TRUE.equals(dto.futureTraceEnabled());
        Map<String, Boolean> traces = new LinkedHashMap<>();
        for (String id : KNOWN_SATELLITE_IDS) {
            traces.put(id, legacyAllOn);
        }
        for (Map.Entry<String, Boolean> e : incomingTraces.entrySet()) {
            if (e.getKey() == null || e.getValue() == null) {
                continue;
            }
            String id = e.getKey().trim().toLowerCase(Locale.ROOT);
            if (KNOWN_SATELLITE_IDS.contains(id)) {
                traces.put(id, e.getValue());
            }
        }
        boolean anyTrace = traces.values().stream().anyMatch(Boolean.TRUE::equals);
        int minutes = 90;
        if (dto != null && dto.futureTraceMinutes() != null) {
            minutes = Math.min(180, Math.max(15, dto.futureTraceMinutes()));
        }
        return new GlobeSatelliteOverlayPrefsDto(out, anyTrace, minutes, traces);
    }
}
