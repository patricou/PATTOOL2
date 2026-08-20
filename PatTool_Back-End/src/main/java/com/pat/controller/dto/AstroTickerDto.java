package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Bandeau défilant du viseur, persisté par username (surnom Member) dans
 * {@code appParameters} (clé {@code globe.astro.ticker.<username>}).
 * Défaut applicatif : activé.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonIgnoreProperties(ignoreUnknown = true)
public record AstroTickerDto(Boolean enabled) {}
