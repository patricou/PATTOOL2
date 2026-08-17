package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Switch Trajectoire du viseur, persisté par username (surnom Member) dans
 * {@code appParameters} (clé {@code globe.astro.finder-trail.<username>}).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AstroFinderTrailDto(Boolean enabled) {}
