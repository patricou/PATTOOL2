package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Magnitude max du viseur, persistée par username (surnom Member) dans
 * {@code appParameters} (clé {@code globe.astro.max-magnitude.<username>}).
 * Défaut applicatif : 5.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AstroMaxMagnitudeDto(Integer maxMagnitude) {}
