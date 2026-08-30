package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.ArtisanFavoriteDto;
import com.pat.controller.dto.ArtisansFavoritesDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Per-user artisan / pro favorites, stored in {@code appParameters}
 * under key {@code artisans.favorites.<username>}.
 */
@Service
public class ArtisansFavoritesService {

    private static final Logger log = LoggerFactory.getLogger(ArtisansFavoritesService.class);

    static final String PARAM_KEY_PREFIX = "artisans.favorites.";
    private static final int MAX_FAVORITES = 80;
    private static final int MAX_ID_LEN = 160;
    private static final int MAX_NAME_LEN = 200;
    private static final int MAX_TEXT_LEN = 240;
    private static final int MAX_URL_LEN = 2000;

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public ArtisansFavoritesService(
            AppParameterService appParameterService,
            ObjectMapper objectMapper,
            UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public ArtisansFavoritesDto findForSubject(String jwtSubject) {
        String raw = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject)
                .map(com.pat.repo.domain.AppParameter::getParamValue)
                .orElse(null);
        if (!StringUtils.hasText(raw)) {
            return new ArtisansFavoritesDto();
        }
        try {
            ArtisansFavoritesDto dto = objectMapper.readValue(raw, ArtisansFavoritesDto.class);
            return normalize(dto);
        } catch (JsonProcessingException e) {
            log.debug("artisans.favorites unreadable JSON: {}", e.getMessage());
            return new ArtisansFavoritesDto();
        }
    }

    public ArtisansFavoritesDto saveForSubject(String jwtSubject, ArtisansFavoritesDto dto) {
        ArtisansFavoritesDto normalized = normalize(dto);
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Artisans / pros: per-user favorite listings (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization artisan favorites", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return normalized;
    }

    public ArtisansFavoritesDto addFavorite(String jwtSubject, ArtisanFavoriteDto item) {
        ArtisansFavoritesDto current = findForSubject(jwtSubject);
        ArtisanFavoriteDto normalizedItem = normalizeItem(item);
        if (normalizedItem == null) {
            throw new IllegalArgumentException("invalid artisan");
        }
        Map<String, ArtisanFavoriteDto> byKey = new LinkedHashMap<>();
        for (ArtisanFavoriteDto existing : current.getItems()) {
            byKey.put(favoriteKey(existing), existing);
        }
        byKey.put(favoriteKey(normalizedItem), normalizedItem);
        List<ArtisanFavoriteDto> list = new ArrayList<>(byKey.values());
        if (list.size() > MAX_FAVORITES) {
            list = new ArrayList<>(list.subList(list.size() - MAX_FAVORITES, list.size()));
        }
        return saveForSubject(jwtSubject, new ArtisansFavoritesDto(list));
    }

    public ArtisansFavoritesDto removeFavorite(String jwtSubject, String id, String source) {
        if (!StringUtils.hasText(id)) {
            return findForSubject(jwtSubject);
        }
        String itemId = id.trim();
        String sourceNorm = normalizeSource(source);
        ArtisansFavoritesDto current = findForSubject(jwtSubject);
        List<ArtisanFavoriteDto> kept = new ArrayList<>();
        for (ArtisanFavoriteDto item : current.getItems()) {
            if (item.getId() == null || !item.getId().equals(itemId)) {
                kept.add(item);
                continue;
            }
            if (sourceNorm != null && !sourceNorm.equals(normalizeSource(item.getSource()))) {
                kept.add(item);
            }
        }
        return saveForSubject(jwtSubject, new ArtisansFavoritesDto(kept));
    }

    private ArtisansFavoritesDto normalize(ArtisansFavoritesDto dto) {
        if (dto == null || dto.getItems() == null) {
            return new ArtisansFavoritesDto();
        }
        Map<String, ArtisanFavoriteDto> byKey = new LinkedHashMap<>();
        for (ArtisanFavoriteDto item : dto.getItems()) {
            ArtisanFavoriteDto n = normalizeItem(item);
            if (n != null) {
                byKey.put(favoriteKey(n), n);
            }
            if (byKey.size() >= MAX_FAVORITES) {
                break;
            }
        }
        return new ArtisansFavoritesDto(new ArrayList<>(byKey.values()));
    }

    static ArtisanFavoriteDto normalizeItem(ArtisanFavoriteDto item) {
        if (item == null) {
            return null;
        }
        String id = trimTo(item.getId(), MAX_ID_LEN);
        String name = trimTo(item.getName(), MAX_NAME_LEN);
        if (!StringUtils.hasText(id) || !StringUtils.hasText(name)) {
            return null;
        }
        ArtisanFavoriteDto out = new ArtisanFavoriteDto();
        String source = normalizeSource(item.getSource());
        out.setId(id);
        out.setSource(source != null ? source : "sirene");
        out.setName(name);
        out.setActivity(trimTo(item.getActivity(), MAX_TEXT_LEN));
        out.setActivityCode(trimTo(item.getActivityCode(), 32));
        out.setTradeKey(trimTo(item.getTradeKey(), 40));
        out.setAddress(trimTo(item.getAddress(), MAX_TEXT_LEN));
        out.setCity(trimTo(item.getCity(), 80));
        out.setPostalCode(trimTo(item.getPostalCode(), 16));
        out.setLat(finiteOrNull(item.getLat()));
        out.setLon(finiteOrNull(item.getLon()));
        out.setUrl(httpUrlOrNull(item.getUrl()));
        out.setWebsite(httpUrlOrNull(item.getWebsite()));
        out.setPhone(trimTo(item.getPhone(), 40));
        return out;
    }

    static String favoriteKey(ArtisanFavoriteDto item) {
        return normalizeSource(item.getSource()) + ":" + item.getId();
    }

    static String normalizeSource(String source) {
        if (!StringUtils.hasText(source)) {
            return null;
        }
        String v = source.trim().toLowerCase(Locale.ROOT);
        if ("sirene".equals(v) || "osm".equals(v)) {
            return v;
        }
        return null;
    }

    private static Double finiteOrNull(Double value) {
        if (value == null || !Double.isFinite(value)) {
            return null;
        }
        return value;
    }

    private static String httpUrlOrNull(String value) {
        String url = trimTo(value, MAX_URL_LEN);
        if (url == null) {
            return null;
        }
        if (url.startsWith("http://") || url.startsWith("https://")) {
            return url;
        }
        return null;
    }

    private static String trimTo(String value, int max) {
        if (value == null) {
            return null;
        }
        String t = value.trim();
        if (t.isEmpty()) {
            return null;
        }
        return t.length() > max ? t.substring(0, max) : t;
    }
}
