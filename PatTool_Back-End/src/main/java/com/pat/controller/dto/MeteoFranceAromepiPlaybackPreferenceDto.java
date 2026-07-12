package com.pat.controller.dto;

/**
 * AROME-PI map playback prefetch window (stored in MongoDB {@code appParameters}).
 */
public record MeteoFranceAromepiPlaybackPreferenceDto(
        int prefetchAhead,
        boolean persistedInMongo
) {}
