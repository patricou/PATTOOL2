package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Bandeau d'actualités défilant, persisté par username (surnom Member) dans
 * {@code appParameters} (clé {@code news.ticker.&lt;username&gt;}).
 * Défaut applicatif : désactivé.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonIgnoreProperties(ignoreUnknown = true)
public record NewsTickerDto(Boolean enabled) {}
