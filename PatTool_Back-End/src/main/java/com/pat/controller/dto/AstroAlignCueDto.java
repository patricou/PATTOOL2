package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Signal de visée du viseur (Rien / Bip / Vibration), persisté par username
 * (clé {@code globe.astro.align-cue.<username>}).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AstroAlignCueDto(String mode) {}
