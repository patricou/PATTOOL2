package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.ArchiveItemDto;
import com.pat.controller.dto.ArchiveRecentDto;
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
 * Per-user Archive.org last selections (MRU), stored in {@code appParameters}
 * under key {@code archive.recent.<JWT sub>}. Newest first, max 10.
 */
@Service
public class ArchiveRecentService {

    private static final Logger log = LoggerFactory.getLogger(ArchiveRecentService.class);

    static final String PARAM_KEY_PREFIX = "archive.recent.";
    private static final int MAX_RECENT = 10;
    private static final int MAX_ID_LEN = 200;
    private static final int MAX_TITLE_LEN = 300;
    private static final int MAX_TEXT_LEN = 400;
    private static final int MAX_URL_LEN = 2000;

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public ArchiveRecentService(AppParameterService appParameterService, ObjectMapper objectMapper, UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public ArchiveRecentDto findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return new ArchiveRecentDto();
        }
        String raw = row.get().getParamValue();
        if (!StringUtils.hasText(raw)) {
            return new ArchiveRecentDto();
        }
        try {
            ArchiveRecentDto dto = objectMapper.readValue(raw, ArchiveRecentDto.class);
            return normalize(dto);
        } catch (JsonProcessingException e) {
            log.debug("archive.recent unreadable JSON: {}", e.getMessage());
            return new ArchiveRecentDto();
        }
    }

    public ArchiveRecentDto saveForSubject(String jwtSubject, ArchiveRecentDto dto) {
        ArchiveRecentDto normalized = normalize(dto);
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Archive watcher: per-user last selected items (JSON, max 10).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization archive recent", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return normalized;
    }

    /** Move item to front (MRU); create if missing; trim to {@link #MAX_RECENT}. */
    public ArchiveRecentDto touchRecent(String jwtSubject, ArchiveItemDto item) {
        ArchiveItemDto normalizedItem = normalizeItem(item);
        if (normalizedItem == null) {
            throw new IllegalArgumentException("invalid item");
        }
        ArchiveRecentDto current = findForSubject(jwtSubject);
        Map<String, ArchiveItemDto> byId = new LinkedHashMap<>();
        byId.put(itemKey(normalizedItem), normalizedItem);
        for (ArchiveItemDto existing : current.getItems()) {
            String key = itemKey(existing);
            if (!byId.containsKey(key)) {
                byId.put(key, existing);
            }
        }
        List<ArchiveItemDto> list = new ArrayList<>(byId.values());
        if (list.size() > MAX_RECENT) {
            list = new ArrayList<>(list.subList(0, MAX_RECENT));
        }
        return saveForSubject(jwtSubject, new ArchiveRecentDto(list));
    }

    public ArchiveRecentDto removeRecent(String jwtSubject, String identifier) {
        if (!StringUtils.hasText(identifier)) {
            return findForSubject(jwtSubject);
        }
        String id = identifier.trim();
        ArchiveRecentDto current = findForSubject(jwtSubject);
        List<ArchiveItemDto> kept = new ArrayList<>();
        for (ArchiveItemDto item : current.getItems()) {
            if (item.getIdentifier() == null || !item.getIdentifier().equals(id)) {
                kept.add(item);
            }
        }
        return saveForSubject(jwtSubject, new ArchiveRecentDto(kept));
    }

    private ArchiveRecentDto normalize(ArchiveRecentDto dto) {
        if (dto == null || dto.getItems() == null) {
            return new ArchiveRecentDto();
        }
        Map<String, ArchiveItemDto> byId = new LinkedHashMap<>();
        for (ArchiveItemDto item : dto.getItems()) {
            ArchiveItemDto n = normalizeItem(item);
            if (n != null) {
                byId.putIfAbsent(itemKey(n), n);
            }
            if (byId.size() >= MAX_RECENT) {
                break;
            }
        }
        return new ArchiveRecentDto(new ArrayList<>(byId.values()));
    }

    private static ArchiveItemDto normalizeItem(ArchiveItemDto item) {
        if (item == null) {
            return null;
        }
        String identifier = trimTo(item.getIdentifier(), MAX_ID_LEN);
        if (!StringUtils.hasText(identifier)) {
            identifier = trimTo(item.getId(), MAX_ID_LEN);
        }
        if (!StringUtils.hasText(identifier)) {
            return null;
        }
        String title = trimTo(item.getTitle(), MAX_TITLE_LEN);
        if (!StringUtils.hasText(title)) {
            title = identifier;
        }
        ArchiveItemDto out = new ArchiveItemDto();
        out.setId(identifier);
        out.setIdentifier(identifier);
        out.setTitle(title);
        out.setSubtitle(trimTo(item.getSubtitle(), MAX_TEXT_LEN));
        out.setDescription(trimTo(item.getDescription(), MAX_TEXT_LEN));
        out.setCreator(trimTo(item.getCreator(), MAX_TEXT_LEN));
        out.setMediatype(trimTo(item.getMediatype(), 40));
        out.setYear(trimTo(item.getYear(), 20));
        out.setDate(trimTo(item.getDate(), 40));
        out.setLanguage(trimTo(item.getLanguage(), 80));
        out.setSubject(trimTo(item.getSubject(), MAX_TEXT_LEN));
        out.setCollection(trimTo(item.getCollection(), MAX_TEXT_LEN));
        out.setDownloads(item.getDownloads());
        out.setAvgRating(item.getAvgRating());
        out.setImageUrl(httpUrl(item.getImageUrl()));
        out.setDetailsUrl(httpUrl(item.getDetailsUrl()));
        out.setEmbedUrl(httpUrl(item.getEmbedUrl()));
        out.setPlayable(item.isPlayable());
        return out;
    }

    private static String itemKey(ArchiveItemDto item) {
        return item.getIdentifier() != null
                ? item.getIdentifier().toLowerCase(Locale.ROOT)
                : "";
    }

    private static String httpUrl(String value) {
        String url = trimTo(value, MAX_URL_LEN);
        if (url == null) {
            return null;
        }
        String lower = url.toLowerCase(Locale.ROOT);
        if (!(lower.startsWith("http://") || lower.startsWith("https://"))) {
            return null;
        }
        return url;
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
