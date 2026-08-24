package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AstroLastTargetDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Dernier astre du viseur, par username (surnom Member), dans {@code appParameters}
 * sous {@code globe.astro.last-target.<username>}. Les anciennes clés Keycloak {@code sub}
 * restent lisibles une fois, puis sont recopiées vers le surnom.
 */
@Service
public class AstroLastTargetService {

    private static final Logger log = LoggerFactory.getLogger(AstroLastTargetService.class);

    static final String PARAM_KEY_PREFIX = "globe.astro.last-target.";
    private static final Set<String> KINDS = Set.of("planet", "star", "galaxy", "deepsky", "constellation", "custom", "iss");
    private static final Pattern CATALOG_ID = Pattern.compile("^[A-Za-z0-9._-]{1,80}$");
    private static final int NAME_MAX = 120;

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public AstroLastTargetService(
            AppParameterService appParameterService,
            ObjectMapper objectMapper,
            UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public Optional<AstroLastTargetDto> findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return Optional.empty();
        }
        String raw = row.get().getParamValue();
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        try {
            return validate(objectMapper.readValue(raw, AstroLastTargetDto.class));
        } catch (JsonProcessingException e) {
            log.debug("globe.astro.last-target JSON illisible: {}", e.getMessage());
            return Optional.empty();
        }
    }

    public AstroLastTargetDto saveForSubject(String jwtSubject, AstroLastTargetDto dto) {
        AstroLastTargetDto normalized = validate(dto)
                .orElseThrow(() -> new IllegalArgumentException("invalid astro last-target payload"));
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Viseur d'astres : dernier objet choisi par l'utilisateur (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization astro last-target", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return normalized;
    }

    Optional<AstroLastTargetDto> validate(AstroLastTargetDto dto) {
        if (dto == null || dto.kind() == null) {
            return Optional.empty();
        }
        String kind = dto.kind().trim().toLowerCase(Locale.ROOT);
        if (!KINDS.contains(kind)) {
            return Optional.empty();
        }
        if ("custom".equals(kind)) {
            Double ra = dto.customRaHours();
            Double dec = dto.customDecDeg();
            if (ra == null || dec == null || !Double.isFinite(ra) || !Double.isFinite(dec)) {
                return Optional.empty();
            }
            if (ra < 0 || ra >= 24 || dec < -90 || dec > 90) {
                return Optional.empty();
            }
            String name = dto.customName() == null ? null : dto.customName().trim();
            if (name != null && name.length() > NAME_MAX) {
                name = name.substring(0, NAME_MAX);
            }
            if (name != null && name.isBlank()) {
                name = null;
            }
            return Optional.of(new AstroLastTargetDto("custom", null, ra, dec, name));
        }
        String id = dto.id() == null ? "" : dto.id().trim();
        if (!CATALOG_ID.matcher(id).matches()) {
            return Optional.empty();
        }
        return Optional.of(new AstroLastTargetDto(kind, id, null, null, null));
    }
}
