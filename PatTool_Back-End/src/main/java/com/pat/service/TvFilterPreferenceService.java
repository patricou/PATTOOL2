package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.TvFilterPreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.Locale;
import java.util.Optional;

/**
 * Per-user TV Watcher global filter preferences, stored in {@code appParameters}
 * under key {@code tv.filter-preferences.<JWT sub>}.
 */
@Service
public class TvFilterPreferenceService {

    private static final Logger log = LoggerFactory.getLogger(TvFilterPreferenceService.class);

    static final String PARAM_KEY_PREFIX = "tv.filter-preferences.";
    private static final int MAX_QUERY_LEN = 200;
    private static final int MAX_COUNTRY_LEN = 8;
    private static final int MAX_GROUP_LEN = 120;

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public TvFilterPreferenceService(AppParameterService appParameterService, ObjectMapper objectMapper, UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public TvFilterPreferenceDto findForSubject(String jwtSubject) {
        Optional<TvFilterPreferenceDto> stored = readStored(jwtSubject);
        if (stored.isEmpty()) {
            return defaults(false);
        }
        TvFilterPreferenceDto dto = normalize(stored.get());
        dto.setPersisted(true);
        return dto;
    }

    public TvFilterPreferenceDto saveForSubject(String jwtSubject, TvFilterPreferenceDto dto) {
        TvFilterPreferenceDto normalized = normalize(dto != null ? dto : defaults(false));
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            TvFilterPreferenceDto toStore = new TvFilterPreferenceDto(
                    normalized.getApplyToAllTabs(),
                    normalized.getChannelQuery(),
                    normalized.getProgramQuery(),
                    normalized.getCountry(),
                    normalized.getGroup(),
                    null
            );
            String json = objectMapper.writeValueAsString(toStore);
            appParameterService.setJson(
                    key,
                    json,
                    "TV watcher: per-user global filter preferences (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization TV filter preferences", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        normalized.setPersisted(true);
        return normalized;
    }

    private Optional<TvFilterPreferenceDto> readStored(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return Optional.empty();
        }
        String raw = row.get().getParamValue();
        if (!StringUtils.hasText(raw)) {
            return Optional.empty();
        }
        try {
            return Optional.ofNullable(objectMapper.readValue(raw, TvFilterPreferenceDto.class));
        } catch (JsonProcessingException e) {
            log.debug("tv.filter-preferences unreadable JSON: {}", e.getMessage());
            return Optional.empty();
        }
    }

    private static TvFilterPreferenceDto defaults(boolean persisted) {
        return new TvFilterPreferenceDto(false, "", "", "all", "", persisted);
    }

    private static TvFilterPreferenceDto normalize(TvFilterPreferenceDto dto) {
        if (dto == null) {
            return defaults(false);
        }
        return new TvFilterPreferenceDto(
                Boolean.TRUE.equals(dto.getApplyToAllTabs()),
                trimTo(dto.getChannelQuery(), MAX_QUERY_LEN),
                trimTo(dto.getProgramQuery(), MAX_QUERY_LEN),
                normalizeCountry(dto.getCountry()),
                trimTo(dto.getGroup(), MAX_GROUP_LEN),
                dto.getPersisted()
        );
    }

    private static String normalizeCountry(String country) {
        String c = trimTo(country, MAX_COUNTRY_LEN);
        if (c == null) {
            return "all";
        }
        c = c.toLowerCase(Locale.ROOT);
        if ("*".equals(c)) {
            return "all";
        }
        return c;
    }

    private static String trimTo(String value, int max) {
        if (value == null) {
            return "";
        }
        String t = value.trim();
        if (t.isEmpty()) {
            return "";
        }
        return t.length() > max ? t.substring(0, max) : t;
    }
}
