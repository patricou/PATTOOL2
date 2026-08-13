package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.CompassCalibrationDto;
import com.pat.controller.dto.CompassHeadingModeDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Locale;
import java.util.Optional;
import java.util.Set;

/**
 * Calage du Nord de la boussole ISS par utilisateur Keycloak, stocké dans
 * {@code appParameters} sous la clé {@code globe.iss.compass.calibration.<sub JWT>}.
 *
 * <p>Objectif : éviter que les utilisateurs ne recalent le Nord à chaque ouverture de
 * la boussole. La valeur survit aux redémarrages backend (MongoDB) et n'est écrasée
 * que lorsque l'utilisateur relance volontairement un calage.</p>
 */
@Service
public class CompassCalibrationService {

    private static final Logger log = LoggerFactory.getLogger(CompassCalibrationService.class);

    static final String PARAM_KEY_PREFIX = "globe.iss.compass.calibration.";
    static final String HEADING_MODE_KEY_PREFIX = "globe.iss.compass.heading-mode.";
    /** Méthodes d'identification du Nord : capteurs / manuel / marche GPS / Soleil / souris. */
    private static final Set<String> SUPPORTED_METHODS = Set.of("sensor", "manual", "gps", "sun", "mouse");
    private static final Set<String> SUPPORTED_HEADING_MODES =
            Set.of("os-yaw", "os-mag", "w3c", "tilt-mix", "tilt-top", "mag", "mag-gyro");

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;

    public CompassCalibrationService(
            AppParameterService appParameterService,
            ObjectMapper objectMapper) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
    }

    public Optional<CompassCalibrationDto> findForSubject(String jwtSubject) {
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
            CompassCalibrationDto dto = objectMapper.readValue(raw, CompassCalibrationDto.class);
            return validate(dto);
        } catch (JsonProcessingException e) {
            log.debug("globe.iss.compass.calibration JSON illisible pour clé {}: {}", key, e.getMessage());
            return Optional.empty();
        }
    }

    public CompassCalibrationDto saveForSubject(String jwtSubject, CompassCalibrationDto dto) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        CompassCalibrationDto normalized = validate(dto)
                .orElseThrow(() -> new IllegalArgumentException("invalid compass calibration payload"));
        String key = PARAM_KEY_PREFIX + jwtSubject;
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Boussole ISS : calage du Nord choisi par l'utilisateur (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization compass calibration", e);
        }
        return normalized;
    }

    public void deleteForSubject(String jwtSubject) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            return;
        }
        appParameterService.delete(PARAM_KEY_PREFIX + jwtSubject);
    }

    public Optional<String> findHeadingModeForSubject(String jwtSubject) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            return Optional.empty();
        }
        String key = HEADING_MODE_KEY_PREFIX + jwtSubject;
        Optional<AppParameter> row = appParameterService.find(key);
        if (row.isEmpty()) {
            return Optional.empty();
        }
        String raw = row.get().getParamValue();
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        try {
            CompassHeadingModeDto dto = objectMapper.readValue(raw, CompassHeadingModeDto.class);
            return normalizeHeadingMode(dto != null ? dto.headingMode() : null);
        } catch (JsonProcessingException e) {
            return normalizeHeadingMode(raw.trim());
        }
    }

    public String saveHeadingModeForSubject(String jwtSubject, String headingMode) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        String mode = normalizeHeadingMode(headingMode)
                .orElseThrow(() -> new IllegalArgumentException("invalid heading mode"));
        String key = HEADING_MODE_KEY_PREFIX + jwtSubject;
        try {
            String json = objectMapper.writeValueAsString(new CompassHeadingModeDto(mode));
            appParameterService.setJson(
                    key,
                    json,
                    "Boussole astres : méthode de cap Nord choisie par l'utilisateur (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization compass heading mode", e);
        }
        return mode;
    }

    private Optional<String> normalizeHeadingMode(String headingMode) {
        if (headingMode == null || headingMode.isBlank()) {
            return Optional.empty();
        }
        String mode = headingMode.trim().toLowerCase(Locale.ROOT);
        if (!SUPPORTED_HEADING_MODES.contains(mode)) {
            return Optional.empty();
        }
        return Optional.of(mode);
    }

    /** Valide la méthode et borne l'offset dans [0, 360[ ; renvoie {@code empty} si invalide. */
    private Optional<CompassCalibrationDto> validate(CompassCalibrationDto dto) {
        if (dto == null || dto.method() == null) {
            return Optional.empty();
        }
        String method = dto.method().trim().toLowerCase(Locale.ROOT);
        if (!SUPPORTED_METHODS.contains(method)) {
            return Optional.empty();
        }
        double offset = dto.northOffsetDeg() != null ? dto.northOffsetDeg() : 0d;
        if (!Double.isFinite(offset)) {
            offset = 0d;
        }
        offset = ((offset % 360) + 360) % 360;
        return Optional.of(new CompassCalibrationDto(method, offset, dto.calibratedAt()));
    }
}
