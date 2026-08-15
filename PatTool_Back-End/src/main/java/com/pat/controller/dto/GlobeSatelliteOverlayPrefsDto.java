package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.Map;

/**
 * Per-user globe satellite overlay switches (astro-compass satellites, except ISS).
 * Keys are satellite ids ({@code tiangong}, {@code hubble}, …); missing keys default to enabled.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record GlobeSatelliteOverlayPrefsDto(
        Map<String, Boolean> enabled
) {}
