package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.TvChannelDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.Locale;
import java.util.Optional;

/**
 * Per-user last watched TV channel, stored in {@code appParameters}
 * under key {@code tv.last-channel.<JWT sub>}.
 */
@Service
public class TvLastChannelService {

    private static final Logger log = LoggerFactory.getLogger(TvLastChannelService.class);

    static final String PARAM_KEY_PREFIX = "tv.last-channel.";
    private static final int MAX_ID_LEN = 160;
    private static final int MAX_NAME_LEN = 200;
    private static final int MAX_URL_LEN = 2000;

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;

    public TvLastChannelService(AppParameterService appParameterService, ObjectMapper objectMapper) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
    }

    public TvChannelDto findForSubject(String jwtSubject) {
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
            return normalizeChannel(objectMapper.readValue(raw, TvChannelDto.class));
        } catch (JsonProcessingException e) {
            log.debug("tv.last-channel unreadable JSON for key {}: {}", key, e.getMessage());
            return null;
        }
    }

    public TvChannelDto saveForSubject(String jwtSubject, TvChannelDto channel) {
        if (!StringUtils.hasText(jwtSubject)) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        TvChannelDto normalized = normalizeChannel(channel);
        if (normalized == null) {
            throw new IllegalArgumentException("invalid channel");
        }
        String key = PARAM_KEY_PREFIX + jwtSubject;
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "TV watcher: last watched channel per user (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization TV last channel", e);
        }
        return normalized;
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
        if (!StringUtils.hasText(streamUrl)) {
            return null;
        }
        if (!virtualFranceTv && !virtualTf1 && !virtualCanal && !virtualRadio
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
