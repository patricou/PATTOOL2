package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.WebcamItemDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.Optional;

/**
 * Per-user last opened webcam, stored in {@code appParameters}
 * under key {@code webcam.last.<JWT sub>}.
 */
@Service
public class WebcamLastService {

    private static final Logger log = LoggerFactory.getLogger(WebcamLastService.class);

    static final String PARAM_KEY_PREFIX = "webcam.last.";

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;

    public WebcamLastService(AppParameterService appParameterService, ObjectMapper objectMapper) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
    }

    public WebcamItemDto findForSubject(String jwtSubject) {
        if (!StringUtils.hasText(jwtSubject)) {
            return null;
        }
        String key = PARAM_KEY_PREFIX + jwtSubject;
        Optional<AppParameter> row = appParameterService.find(key);
        if (row.isEmpty()) {
            return null;
        }
        String raw = row.get().getParamValue();
        if (!StringUtils.hasText(raw)) {
            return null;
        }
        try {
            return normalize(objectMapper.readValue(raw, WebcamItemDto.class));
        } catch (JsonProcessingException e) {
            log.debug("webcam.last unreadable JSON for key {}: {}", key, e.getMessage());
            return null;
        }
    }

    public WebcamItemDto saveForSubject(String jwtSubject, WebcamItemDto webcam) {
        if (!StringUtils.hasText(jwtSubject)) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        WebcamItemDto normalized = normalize(webcam);
        if (normalized == null) {
            throw new IllegalArgumentException("invalid webcam");
        }
        String key = PARAM_KEY_PREFIX + jwtSubject;
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Webcam watcher: last opened webcam per user (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization webcam last", e);
        }
        return normalized;
    }

    static WebcamItemDto normalize(WebcamItemDto webcam) {
        if (webcam == null || !StringUtils.hasText(webcam.getId())) {
            return null;
        }
        WebcamItemDto out = new WebcamItemDto();
        out.setId(webcam.getId().trim());
        out.setProvider(trimToNull(webcam.getProvider()));
        out.setTitle(trimToNull(webcam.getTitle()));
        out.setDescription(trimToNull(webcam.getDescription()));
        out.setStatus(trimToNull(webcam.getStatus()));
        out.setViewCount(webcam.getViewCount());
        out.setLastUpdatedOn(trimToNull(webcam.getLastUpdatedOn()));
        out.setLastImageTime(trimToNull(webcam.getLastImageTime()));
        out.setCity(trimToNull(webcam.getCity()));
        out.setRegion(trimToNull(webcam.getRegion()));
        out.setCountry(trimToNull(webcam.getCountry()));
        out.setCountryCode(trimToNull(webcam.getCountryCode()));
        out.setContinent(trimToNull(webcam.getContinent()));
        out.setContinentCode(trimToNull(webcam.getContinentCode()));
        out.setLatitude(webcam.getLatitude());
        out.setLongitude(webcam.getLongitude());
        out.setImageUrl(trimToNull(webcam.getImageUrl()));
        out.setImagePreviewUrl(trimToNull(webcam.getImagePreviewUrl()));
        out.setPlayerDayUrl(trimToNull(webcam.getPlayerDayUrl()));
        out.setPlayerLiveUrl(trimToNull(webcam.getPlayerLiveUrl()));
        out.setPlayerMonthUrl(trimToNull(webcam.getPlayerMonthUrl()));
        out.setDetailUrl(trimToNull(webcam.getDetailUrl()));
        out.setHasVideo(webcam.getHasVideo());
        out.setRoadName(trimToNull(webcam.getRoadName()));
        out.setDirection(trimToNull(webcam.getDirection()));
        out.setSource(trimToNull(webcam.getSource()));
        out.setSourceId(trimToNull(webcam.getSourceId()));
        out.setFeatureType(trimToNull(webcam.getFeatureType()));
        if (webcam.getCategories() != null) {
            out.setCategories(webcam.getCategories());
        }
        if (webcam.getDetails() != null && !webcam.getDetails().isEmpty()) {
            out.setDetails(webcam.getDetails());
        }
        if (!StringUtils.hasText(out.getTitle())) {
            out.setTitle(out.getId());
        }
        return out;
    }

    private static String trimToNull(String value) {
        if (!StringUtils.hasText(value)) {
            return null;
        }
        String t = value.trim();
        return t.isEmpty() ? null : t;
    }
}
