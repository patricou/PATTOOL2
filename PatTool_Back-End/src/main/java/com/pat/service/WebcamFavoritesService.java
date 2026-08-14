package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.WebcamFavoritesDto;
import com.pat.controller.dto.WebcamItemDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Per-user webcam favorites, stored in {@code appParameters}
 * under key {@code webcam.favorites.<JWT sub>}.
 */
@Service
public class WebcamFavoritesService {

    private static final Logger log = LoggerFactory.getLogger(WebcamFavoritesService.class);

    static final String PARAM_KEY_PREFIX = "webcam.favorites.";
    private static final int MAX_FAVORITES = 80;

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public WebcamFavoritesService(AppParameterService appParameterService, ObjectMapper objectMapper, UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public WebcamFavoritesDto findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return new WebcamFavoritesDto();
        }
        String raw = row.get().getParamValue();
        if (!StringUtils.hasText(raw)) {
            return new WebcamFavoritesDto();
        }
        try {
            WebcamFavoritesDto dto = objectMapper.readValue(raw, WebcamFavoritesDto.class);
            return normalize(dto);
        } catch (JsonProcessingException e) {
            log.debug("webcam.favorites unreadable JSON: {}", e.getMessage());
            return new WebcamFavoritesDto();
        }
    }

    public WebcamFavoritesDto saveForSubject(String jwtSubject, WebcamFavoritesDto dto) {
        WebcamFavoritesDto normalized = normalize(dto);
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Webcam watcher: per-user favorite webcams (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization webcam favorites", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return normalized;
    }

    public WebcamFavoritesDto addFavorite(String jwtSubject, WebcamItemDto webcam) {
        WebcamFavoritesDto current = findForSubject(jwtSubject);
        WebcamItemDto normalizedWebcam = WebcamLastService.normalize(webcam);
        if (normalizedWebcam == null) {
            throw new IllegalArgumentException("invalid webcam");
        }
        Map<String, WebcamItemDto> byKey = new LinkedHashMap<>();
        for (WebcamItemDto existing : current.getWebcams()) {
            byKey.put(favoriteKey(existing), existing);
        }
        byKey.put(favoriteKey(normalizedWebcam), normalizedWebcam);
        List<WebcamItemDto> list = new ArrayList<>(byKey.values());
        if (list.size() > MAX_FAVORITES) {
            list = new ArrayList<>(list.subList(list.size() - MAX_FAVORITES, list.size()));
        }
        return saveForSubject(jwtSubject, new WebcamFavoritesDto(list));
    }

    public WebcamFavoritesDto removeFavorite(String jwtSubject, String webcamId, String provider) {
        if (!StringUtils.hasText(webcamId)) {
            return findForSubject(jwtSubject);
        }
        String id = webcamId.trim();
        String providerNorm = normalizeProvider(provider);
        WebcamFavoritesDto current = findForSubject(jwtSubject);
        List<WebcamItemDto> kept = new ArrayList<>();
        for (WebcamItemDto cam : current.getWebcams()) {
            if (cam.getId() == null || !cam.getId().equals(id)) {
                kept.add(cam);
                continue;
            }
            if (providerNorm != null && !providerNorm.equals(normalizeProvider(cam.getProvider()))) {
                kept.add(cam);
            }
        }
        return saveForSubject(jwtSubject, new WebcamFavoritesDto(kept));
    }

    private WebcamFavoritesDto normalize(WebcamFavoritesDto dto) {
        if (dto == null || dto.getWebcams() == null) {
            return new WebcamFavoritesDto();
        }
        Map<String, WebcamItemDto> byKey = new LinkedHashMap<>();
        for (WebcamItemDto cam : dto.getWebcams()) {
            WebcamItemDto n = WebcamLastService.normalize(cam);
            if (n != null) {
                byKey.put(favoriteKey(n), n);
            }
            if (byKey.size() >= MAX_FAVORITES) {
                break;
            }
        }
        return new WebcamFavoritesDto(new ArrayList<>(byKey.values()));
    }

    private static String favoriteKey(WebcamItemDto cam) {
        return normalizeProvider(cam.getProvider()) + ":" + cam.getId();
    }

    private static String normalizeProvider(String provider) {
        if (!StringUtils.hasText(provider)) {
            return "windy";
        }
        return provider.trim().toLowerCase(Locale.ROOT);
    }
}
