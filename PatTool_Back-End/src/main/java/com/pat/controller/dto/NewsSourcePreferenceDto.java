package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Dernière source d'actualités choisie (NewsData.io, NewsAPI ou RSS + flux),
 * persistée par username dans {@code appParameters}
 * (clé {@code news.source.&lt;username&gt;}).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonIgnoreProperties(ignoreUnknown = true)
public record NewsSourcePreferenceDto(
        String provider,
        String rssFeedId,
        String rssFeedUrl,
        String rssFeedName
) {}
