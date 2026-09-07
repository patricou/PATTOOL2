package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.NewsSourcePreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.Optional;

/**
 * Dernière source d'actualités (NewsData.io / NewsAPI / RSS + flux choisi),
 * par username, dans {@code appParameters} sous {@code news.source.&lt;username&gt;}.
 */
@Service
public class NewsSourcePreferenceService {

    private static final Logger log = LoggerFactory.getLogger(NewsSourcePreferenceService.class);

    static final String PARAM_KEY_PREFIX = "news.source.";

    private static final int MAX_FEED_ID = 300;
    private static final int MAX_FEED_URL = 2000;
    private static final int MAX_FEED_NAME = 200;

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public NewsSourcePreferenceService(
            AppParameterService appParameterService,
            ObjectMapper objectMapper,
            UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public Optional<NewsSourcePreferenceDto> findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return Optional.empty();
        }
        String raw = row.get().getParamValue();
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        try {
            NewsSourcePreferenceDto dto = objectMapper.readValue(raw, NewsSourcePreferenceDto.class);
            NewsSourcePreferenceDto normalized = normalize(dto);
            return normalized != null ? Optional.of(normalized) : Optional.empty();
        } catch (JsonProcessingException | IllegalArgumentException e) {
            log.debug("news.source illisible: {}", e.getMessage());
            return Optional.empty();
        }
    }

    public NewsSourcePreferenceDto saveForSubject(String jwtSubject, NewsSourcePreferenceDto dto) {
        NewsSourcePreferenceDto normalized = normalize(dto);
        if (normalized == null) {
            throw new IllegalArgumentException("invalid source preference");
        }
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Actualités : dernière source (NewsData.io / NewsAPI / RSS) choisie par l'utilisateur (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization news source preference", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return normalized;
    }

    static NewsSourcePreferenceDto normalize(NewsSourcePreferenceDto dto) {
        if (dto == null || !StringUtils.hasText(dto.provider())) {
            return null;
        }
        String provider = dto.provider().trim().toLowerCase();
        if (!"newsdata".equals(provider) && !"newsapi".equals(provider) && !"rss".equals(provider)) {
            return null;
        }
        return new NewsSourcePreferenceDto(
                provider,
                clip(dto.rssFeedId(), MAX_FEED_ID),
                clip(dto.rssFeedUrl(), MAX_FEED_URL),
                clip(dto.rssFeedName(), MAX_FEED_NAME));
    }

    private static String clip(String value, int max) {
        if (value == null) {
            return "";
        }
        String v = value.trim();
        return v.length() <= max ? v : v.substring(0, max);
    }
}
