package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.TvChannelDto;
import com.pat.controller.dto.TvFavoritesDto;
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
 * Per-user TV channel favorites, stored in {@code appParameters}
 * under key {@code tv.favorites.<JWT sub>}.
 */
@Service
public class TvFavoritesService {

    private static final Logger log = LoggerFactory.getLogger(TvFavoritesService.class);

    static final String PARAM_KEY_PREFIX = "tv.favorites.";
    private static final int MAX_FAVORITES = 80;
    private static final int MAX_ID_LEN = 160;
    private static final int MAX_NAME_LEN = 200;
    private static final int MAX_URL_LEN = 2000;

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;

    public TvFavoritesService(AppParameterService appParameterService, ObjectMapper objectMapper) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
    }

    public TvFavoritesDto findForSubject(String jwtSubject) {
        if (!StringUtils.hasText(jwtSubject)) {
            return new TvFavoritesDto();
        }
        String key = PARAM_KEY_PREFIX + jwtSubject;
        Optional<AppParameter> row = appParameterService.find(key);
        if (row.isEmpty()) {
            return new TvFavoritesDto();
        }
        String raw = row.get().getParamValue();
        if (!StringUtils.hasText(raw)) {
            return new TvFavoritesDto();
        }
        try {
            TvFavoritesDto dto = objectMapper.readValue(raw, TvFavoritesDto.class);
            return normalize(dto);
        } catch (JsonProcessingException e) {
            log.debug("tv.favorites unreadable JSON for key {}: {}", key, e.getMessage());
            return new TvFavoritesDto();
        }
    }

    public TvFavoritesDto saveForSubject(String jwtSubject, TvFavoritesDto dto) {
        if (!StringUtils.hasText(jwtSubject)) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        TvFavoritesDto normalized = normalize(dto);
        String key = PARAM_KEY_PREFIX + jwtSubject;
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "TV watcher: per-user favorite channels (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization TV favorites", e);
        }
        return normalized;
    }

    public TvFavoritesDto addFavorite(String jwtSubject, TvChannelDto channel) {
        TvFavoritesDto current = findForSubject(jwtSubject);
        TvChannelDto normalizedChannel = normalizeChannel(channel);
        if (normalizedChannel == null) {
            throw new IllegalArgumentException("invalid channel");
        }
        Map<String, TvChannelDto> byId = new LinkedHashMap<>();
        for (TvChannelDto existing : current.getChannels()) {
            byId.put(favoriteKey(existing), existing);
        }
        byId.put(favoriteKey(normalizedChannel), normalizedChannel);
        List<TvChannelDto> list = new ArrayList<>(byId.values());
        if (list.size() > MAX_FAVORITES) {
            // Keep newest at end: drop oldest
            list = new ArrayList<>(list.subList(list.size() - MAX_FAVORITES, list.size()));
        }
        return saveForSubject(jwtSubject, new TvFavoritesDto(list));
    }

    public TvFavoritesDto removeFavorite(String jwtSubject, String channelId) {
        if (!StringUtils.hasText(channelId)) {
            return findForSubject(jwtSubject);
        }
        String id = channelId.trim();
        TvFavoritesDto current = findForSubject(jwtSubject);
        List<TvChannelDto> kept = new ArrayList<>();
        for (TvChannelDto ch : current.getChannels()) {
            if (ch.getId() == null || !ch.getId().equals(id)) {
                kept.add(ch);
            }
        }
        return saveForSubject(jwtSubject, new TvFavoritesDto(kept));
    }

    private TvFavoritesDto normalize(TvFavoritesDto dto) {
        if (dto == null || dto.getChannels() == null) {
            return new TvFavoritesDto();
        }
        Map<String, TvChannelDto> byId = new LinkedHashMap<>();
        for (TvChannelDto ch : dto.getChannels()) {
            TvChannelDto n = normalizeChannel(ch);
            if (n != null) {
                byId.put(favoriteKey(n), n);
            }
            if (byId.size() >= MAX_FAVORITES) {
                break;
            }
        }
        return new TvFavoritesDto(new ArrayList<>(byId.values()));
    }

    private static TvChannelDto normalizeChannel(TvChannelDto ch) {
        if (ch == null) {
            return null;
        }
        String streamUrl = trimTo(ch.getStreamUrl(), MAX_URL_LEN);
        boolean virtualFranceTv = FranceTvLiveService.isVirtualUrl(streamUrl);
        boolean virtualTf1 = Tf1LiveService.isVirtualUrl(streamUrl);
        boolean virtualCanal = CanalGroupLiveService.isVirtualUrl(streamUrl);
        boolean virtualRadio = RadioFranceLiveService.isVirtualUrl(streamUrl);
        boolean virtualM6 = M6GroupLiveService.isVirtualUrl(streamUrl);
        if (!StringUtils.hasText(streamUrl)) {
            return null;
        }
        if (!virtualFranceTv && !virtualTf1 && !virtualCanal && !virtualRadio && !virtualM6
                && !(streamUrl.startsWith("http://") || streamUrl.startsWith("https://"))) {
            return null;
        }
        String name = trimTo(ch.getName(), MAX_NAME_LEN);
        if (!StringUtils.hasText(name)) {
            return null;
        }
        String id = trimTo(ch.getId(), MAX_ID_LEN);
        if (!StringUtils.hasText(id)) {
            id = Integer.toHexString(streamUrl.hashCode());
        }
        String country = trimTo(ch.getCountry(), 8);
        if (country != null) {
            country = country.toLowerCase(Locale.ROOT);
        }
        return new TvChannelDto(
                id,
                name,
                trimTo(ch.getLogo(), MAX_URL_LEN),
                trimTo(ch.getGroup(), 120),
                country,
                streamUrl,
                trimTo(ch.getQuality(), 20)
        );
    }

    private static String favoriteKey(TvChannelDto ch) {
        return ch.getId() != null ? ch.getId() : ch.getStreamUrl();
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
