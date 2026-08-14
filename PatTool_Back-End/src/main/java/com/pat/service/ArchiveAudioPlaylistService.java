package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.ArchiveAudioPlaylistDto;
import com.pat.controller.dto.ArchiveItemDto;
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
 * Per-user Archive.org audio playlist, stored in {@code appParameters}
 * under key {@code archive.audioPlaylist.<JWT sub>}. Playback order = list order, max 40.
 * Only audio / etree (concert) items are accepted.
 */
@Service
public class ArchiveAudioPlaylistService {

    private static final Logger log = LoggerFactory.getLogger(ArchiveAudioPlaylistService.class);

    static final String PARAM_KEY_PREFIX = "archive.audioPlaylist.";
    private static final int MAX_ITEMS = 40;
    private static final int MAX_ID_LEN = 200;
    private static final int MAX_TITLE_LEN = 300;
    private static final int MAX_TEXT_LEN = 400;
    private static final int MAX_URL_LEN = 2000;
    private static final Set<String> AUDIO_TYPES = Set.of("audio", "etree");

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public ArchiveAudioPlaylistService(AppParameterService appParameterService, ObjectMapper objectMapper, UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public ArchiveAudioPlaylistDto findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return new ArchiveAudioPlaylistDto();
        }
        String raw = row.get().getParamValue();
        if (!StringUtils.hasText(raw)) {
            return new ArchiveAudioPlaylistDto();
        }
        try {
            ArchiveAudioPlaylistDto dto = objectMapper.readValue(raw, ArchiveAudioPlaylistDto.class);
            return normalize(dto);
        } catch (JsonProcessingException e) {
            log.debug("archive.audioPlaylist unreadable JSON: {}", e.getMessage());
            return new ArchiveAudioPlaylistDto();
        }
    }

    public ArchiveAudioPlaylistDto saveForSubject(String jwtSubject, ArchiveAudioPlaylistDto dto) {
        ArchiveAudioPlaylistDto normalized = normalize(dto);
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Archive watcher: per-user audio playlist (JSON, max 40).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization archive audio playlist", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return normalized;
    }

    /** Append item at end (dedupe by identifier); trim to {@link #MAX_ITEMS}. */
    public ArchiveAudioPlaylistDto addItem(String jwtSubject, ArchiveItemDto item) {
        ArchiveItemDto normalizedItem = normalizeItem(item);
        if (normalizedItem == null) {
            throw new IllegalArgumentException("invalid_audio_item");
        }
        ArchiveAudioPlaylistDto current = findForSubject(jwtSubject);
        Map<String, ArchiveItemDto> byId = new LinkedHashMap<>();
        for (ArchiveItemDto existing : current.getItems()) {
            byId.put(itemKey(existing), existing);
        }
        byId.put(itemKey(normalizedItem), normalizedItem);
        List<ArchiveItemDto> list = new ArrayList<>(byId.values());
        if (list.size() > MAX_ITEMS) {
            list = new ArrayList<>(list.subList(list.size() - MAX_ITEMS, list.size()));
        }
        return saveForSubject(jwtSubject, new ArchiveAudioPlaylistDto(list));
    }

    public ArchiveAudioPlaylistDto removeItem(String jwtSubject, String identifier) {
        if (!StringUtils.hasText(identifier)) {
            return findForSubject(jwtSubject);
        }
        String id = identifier.trim();
        ArchiveAudioPlaylistDto current = findForSubject(jwtSubject);
        List<ArchiveItemDto> kept = new ArrayList<>();
        for (ArchiveItemDto item : current.getItems()) {
            if (item.getIdentifier() == null || !item.getIdentifier().equals(id)) {
                kept.add(item);
            }
        }
        return saveForSubject(jwtSubject, new ArchiveAudioPlaylistDto(kept));
    }

    private ArchiveAudioPlaylistDto normalize(ArchiveAudioPlaylistDto dto) {
        if (dto == null || dto.getItems() == null) {
            return new ArchiveAudioPlaylistDto();
        }
        Map<String, ArchiveItemDto> byId = new LinkedHashMap<>();
        for (ArchiveItemDto item : dto.getItems()) {
            ArchiveItemDto n = normalizeItem(item);
            if (n != null) {
                byId.putIfAbsent(itemKey(n), n);
            }
            if (byId.size() >= MAX_ITEMS) {
                break;
            }
        }
        return new ArchiveAudioPlaylistDto(new ArrayList<>(byId.values()));
    }

    private static ArchiveItemDto normalizeItem(ArchiveItemDto item) {
        if (item == null) {
            return null;
        }
        String mediatype = trimTo(item.getMediatype(), 40);
        String mt = mediatype != null ? mediatype.toLowerCase(Locale.ROOT) : "";
        if (!AUDIO_TYPES.contains(mt)) {
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
        out.setMediatype(mt);
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
