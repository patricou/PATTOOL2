package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.YoutubeFavoritesDto;
import com.pat.controller.dto.YoutubeItemDto;
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
import java.util.Set;

/**
 * Per-user YouTube favorites, stored in {@code appParameters}
 * under key {@code youtube.favorites.<JWT sub>}.
 */
@Service
public class YoutubeFavoritesService {

    private static final Logger log = LoggerFactory.getLogger(YoutubeFavoritesService.class);

    static final String PARAM_KEY_PREFIX = "youtube.favorites.";
    private static final int MAX_FAVORITES = 80;
    private static final int MAX_ID_LEN = 160;
    private static final int MAX_TITLE_LEN = 200;
    private static final int MAX_DESC_LEN = 500;
    private static final int MAX_URL_LEN = 2000;
    private static final Set<String> SAFE_KINDS = Set.of("video", "playlist", "channel");

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public YoutubeFavoritesService(
            AppParameterService appParameterService, ObjectMapper objectMapper, UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public YoutubeFavoritesDto findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return new YoutubeFavoritesDto();
        }
        String raw = row.get().getParamValue();
        if (!StringUtils.hasText(raw)) {
            return new YoutubeFavoritesDto();
        }
        try {
            YoutubeFavoritesDto dto = objectMapper.readValue(raw, YoutubeFavoritesDto.class);
            return normalize(dto);
        } catch (JsonProcessingException e) {
            log.debug("youtube.favorites unreadable JSON: {}", e.getMessage());
            return new YoutubeFavoritesDto();
        }
    }

    public YoutubeFavoritesDto saveForSubject(String jwtSubject, YoutubeFavoritesDto dto) {
        YoutubeFavoritesDto normalized = normalize(dto);
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "YouTube watcher: per-user favorite videos (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization YouTube favorites", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return normalized;
    }

    public YoutubeFavoritesDto addFavorite(String jwtSubject, YoutubeItemDto item) {
        YoutubeFavoritesDto current = findForSubject(jwtSubject);
        YoutubeItemDto normalizedItem = normalizeItem(item);
        if (normalizedItem == null) {
            throw new IllegalArgumentException("invalid item");
        }
        Map<String, YoutubeItemDto> byKey = new LinkedHashMap<>();
        for (YoutubeItemDto existing : current.getItems()) {
            byKey.put(favoriteKey(existing), existing);
        }
        byKey.put(favoriteKey(normalizedItem), normalizedItem);
        List<YoutubeItemDto> list = new ArrayList<>(byKey.values());
        if (list.size() > MAX_FAVORITES) {
            list = new ArrayList<>(list.subList(list.size() - MAX_FAVORITES, list.size()));
        }
        return saveForSubject(jwtSubject, new YoutubeFavoritesDto(list));
    }

    public YoutubeFavoritesDto removeFavorite(String jwtSubject, String itemId, String kind) {
        if (!StringUtils.hasText(itemId)) {
            return findForSubject(jwtSubject);
        }
        String id = itemId.trim();
        String kindKey = normalizeKind(kind);
        YoutubeFavoritesDto current = findForSubject(jwtSubject);
        List<YoutubeItemDto> kept = new ArrayList<>();
        for (YoutubeItemDto item : current.getItems()) {
            if (item.id() == null || !item.id().equals(id)) {
                kept.add(item);
                continue;
            }
            if (kindKey != null && !kindKey.equals(normalizeKind(item.kind()))) {
                kept.add(item);
            }
        }
        return saveForSubject(jwtSubject, new YoutubeFavoritesDto(kept));
    }

    private YoutubeFavoritesDto normalize(YoutubeFavoritesDto dto) {
        if (dto == null || dto.getItems() == null) {
            return new YoutubeFavoritesDto();
        }
        Map<String, YoutubeItemDto> byKey = new LinkedHashMap<>();
        for (YoutubeItemDto item : dto.getItems()) {
            YoutubeItemDto n = normalizeItem(item);
            if (n != null) {
                byKey.put(favoriteKey(n), n);
            }
            if (byKey.size() >= MAX_FAVORITES) {
                break;
            }
        }
        return new YoutubeFavoritesDto(new ArrayList<>(byKey.values()));
    }

    static YoutubeItemDto normalizeItem(YoutubeItemDto item) {
        if (item == null) {
            return null;
        }
        String id = trimTo(item.id(), MAX_ID_LEN);
        if (!isSafeId(id)) {
            return null;
        }
        String title = trimTo(item.title(), MAX_TITLE_LEN);
        if (!StringUtils.hasText(title)) {
            return null;
        }
        String kind = normalizeKind(item.kind());
        if (kind == null) {
            kind = "video";
        }
        return new YoutubeItemDto(
                id,
                kind,
                title,
                trimTo(item.description(), MAX_DESC_LEN),
                trimTo(item.channelTitle(), MAX_TITLE_LEN),
                safeIdOrNull(item.channelId()),
                trimTo(item.publishedAt(), 40),
                normalizeThumb(item.thumbnailUrl()),
                trimTo(item.duration(), 32),
                item.viewCount() != null && item.viewCount() >= 0 ? item.viewCount() : null,
                trimTo(item.liveBroadcast(), 20)
        );
    }

    static String favoriteKey(YoutubeItemDto item) {
        String kind = item.kind() != null ? item.kind() : "video";
        return kind + "|" + item.id();
    }

    private static String normalizeKind(String kind) {
        if (!StringUtils.hasText(kind)) {
            return null;
        }
        String value = kind.trim().toLowerCase(Locale.ROOT);
        return SAFE_KINDS.contains(value) ? value : null;
    }

    private static String normalizeThumb(String raw) {
        String url = trimTo(raw, MAX_URL_LEN);
        if (!StringUtils.hasText(url)) {
            return null;
        }
        if (url.startsWith("external/youtube/image?")) {
            return url;
        }
        if (YoutubeProxyService.isAllowedThumbUrl(url)) {
            return url;
        }
        return null;
    }

    private static String safeIdOrNull(String value) {
        String id = trimTo(value, MAX_ID_LEN);
        return isSafeId(id) ? id : null;
    }

    private static boolean isSafeId(String id) {
        if (!StringUtils.hasText(id)) {
            return false;
        }
        for (int i = 0; i < id.length(); i++) {
            char c = id.charAt(i);
            if (Character.isLetterOrDigit(c) || c == '_' || c == '-') {
                continue;
            }
            return false;
        }
        return true;
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
