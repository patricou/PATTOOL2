package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Trajectoire du viseur (switch + durée), persistée par username (surnom Member) dans
 * {@code appParameters} (clé {@code globe.astro.finder-trail.<username>}).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonIgnoreProperties(ignoreUnknown = true)
public record AstroFinderTrailDto(Boolean enabled, Integer satMinutes, Integer skyMinutes) {}
