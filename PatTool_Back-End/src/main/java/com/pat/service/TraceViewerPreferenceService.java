package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.TraceViewerPreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Per-user trace viewer switches, stored in {@code appParameters} under
 * {@code trace.viewer.<JWT sub>} (JSON).
 */
@Service
public class TraceViewerPreferenceService {

    private static final Logger log = LoggerFactory.getLogger(TraceViewerPreferenceService.class);

    static final String PARAM_KEY_PREFIX = "trace.viewer.";
    private static final Pattern BASE_LAYER_ID = Pattern.compile("^[a-z0-9][a-z0-9-]{0,63}$");
    private static final Set<String> KNOWN_BASE_LAYERS = Set.of(
            "osm-standard",
            "osm-fr",
            "esri-imagery",
            "opentopomap",
            "cartes-gouv",
            "ign-classic",
            "ign-plan",
            "ign-ortho",
            "ign-cadastre",
            "ign-topo",
            "cyclosm",
            "swisstopo-pixelkarte",
            "swisstopo-swissimage",
            "opencyclemap",
            "thunderforest-outdoors"
    );

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;

    public TraceViewerPreferenceService(
            AppParameterService appParameterService,
            ObjectMapper objectMapper) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
    }

    public TraceViewerPreferenceDto readForSubject(String jwtSubject) {
        Optional<TraceViewerPreferenceDto> stored = findForSubject(jwtSubject);
        if (stored.isEmpty()) {
            return defaults(false);
        }
        TraceViewerPreferenceDto dto = stored.get();
        return new TraceViewerPreferenceDto(
                dto.showAddress(),
                dto.showWeather(),
                dto.autoRefreshRadar(),
                dto.showHikingTrailsOverlay(),
                dto.showCyclingTrailsOverlay(),
                dto.followDeviceLocation(),
                dto.keepScreenAwake(),
                dto.showGpsCoordinates(),
                dto.baseLayerId(),
                true
        );
    }

    public TraceViewerPreferenceDto saveForSubject(String jwtSubject, TraceViewerPreferenceDto body) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        if (body == null) {
            throw new IllegalArgumentException("body required");
        }
        Optional<TraceViewerPreferenceDto> existing = findForSubject(jwtSubject);
        TraceViewerPreferenceDto merged = merge(existing.orElse(defaults(false)), body);
        TraceViewerPreferenceDto normalized = validate(merged)
                .orElseThrow(() -> new IllegalArgumentException("invalid trace viewer preference payload"));
        String key = PARAM_KEY_PREFIX + jwtSubject;
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Trace viewer: UI switches and basemap for user (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization trace viewer preference", e);
        }
        return new TraceViewerPreferenceDto(
                normalized.showAddress(),
                normalized.showWeather(),
                normalized.autoRefreshRadar(),
                normalized.showHikingTrailsOverlay(),
                normalized.showCyclingTrailsOverlay(),
                normalized.followDeviceLocation(),
                normalized.keepScreenAwake(),
                normalized.showGpsCoordinates(),
                normalized.baseLayerId(),
                true
        );
    }

    private Optional<TraceViewerPreferenceDto> findForSubject(String jwtSubject) {
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
            TraceViewerPreferenceDto dto = objectMapper.readValue(raw, TraceViewerPreferenceDto.class);
            return validate(dto);
        } catch (JsonProcessingException e) {
            log.debug("trace.viewer unreadable JSON for key {}: {}", key, e.getMessage());
            return Optional.empty();
        }
    }

    private static TraceViewerPreferenceDto defaults(boolean persisted) {
        return new TraceViewerPreferenceDto(
                false,
                false,
                true,
                false,
                false,
                false,
                false,
                false,
                "opentopomap",
                persisted
        );
    }

    private static TraceViewerPreferenceDto merge(TraceViewerPreferenceDto base, TraceViewerPreferenceDto patch) {
        return new TraceViewerPreferenceDto(
                patch.showAddress() != null ? patch.showAddress() : base.showAddress(),
                patch.showWeather() != null ? patch.showWeather() : base.showWeather(),
                patch.autoRefreshRadar() != null ? patch.autoRefreshRadar() : base.autoRefreshRadar(),
                patch.showHikingTrailsOverlay() != null
                        ? patch.showHikingTrailsOverlay() : base.showHikingTrailsOverlay(),
                patch.showCyclingTrailsOverlay() != null
                        ? patch.showCyclingTrailsOverlay() : base.showCyclingTrailsOverlay(),
                patch.followDeviceLocation() != null ? patch.followDeviceLocation() : base.followDeviceLocation(),
                patch.keepScreenAwake() != null ? patch.keepScreenAwake() : base.keepScreenAwake(),
                patch.showGpsCoordinates() != null ? patch.showGpsCoordinates() : base.showGpsCoordinates(),
                patch.baseLayerId() != null ? patch.baseLayerId() : base.baseLayerId(),
                null
        );
    }

    private Optional<TraceViewerPreferenceDto> validate(TraceViewerPreferenceDto dto) {
        if (dto == null) {
            return Optional.empty();
        }
        String baseLayerId = normalizeBaseLayerId(dto.baseLayerId());
        return Optional.of(new TraceViewerPreferenceDto(
                boolOrDefault(dto.showAddress(), false),
                boolOrDefault(dto.showWeather(), false),
                boolOrDefault(dto.autoRefreshRadar(), true),
                boolOrDefault(dto.showHikingTrailsOverlay(), false),
                boolOrDefault(dto.showCyclingTrailsOverlay(), false),
                boolOrDefault(dto.followDeviceLocation(), false),
                boolOrDefault(dto.keepScreenAwake(), false),
                boolOrDefault(dto.showGpsCoordinates(), false),
                baseLayerId,
                null
        ));
    }

    private static boolean boolOrDefault(Boolean value, boolean fallback) {
        return value != null ? value : fallback;
    }

    private static String normalizeBaseLayerId(String raw) {
        if (raw == null || raw.isBlank()) {
            return "opentopomap";
        }
        String id = raw.trim().toLowerCase(Locale.ROOT);
        if (!BASE_LAYER_ID.matcher(id).matches()) {
            return "opentopomap";
        }
        if ("cartes-gouv".equals(id)) {
            return "opentopomap";
        }
        if (KNOWN_BASE_LAYERS.contains(id)) {
            return id;
        }
        return "opentopomap";
    }
}
