package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.Map;

/**
 * Per-user globe satellite overlay switches (astro-compass satellites, except ISS).
 * Keys are satellite ids ({@code tiangong}, {@code hubble}, …); missing keys default to enabled.
 * {@code futureTraceEnabledById} is the per-satellite upcoming-orbit switch (default off).
 * {@code futureTraceEnabled} remains a master “all on” flag for older clients.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record GlobeSatelliteOverlayPrefsDto(
        Map<String, Boolean> enabled,
        Boolean futureTraceEnabled,
        Integer futureTraceMinutes,
        Map<String, Boolean> futureTraceEnabledById
) {}
