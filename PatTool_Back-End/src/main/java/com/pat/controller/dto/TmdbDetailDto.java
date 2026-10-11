package com.pat.controller.dto;

import java.util.List;

/** TMDB movie or TV detail, including a short cast and an optional YouTube trailer key. */
public record TmdbDetailDto(
        boolean configured,
        String error,
        Long id,
        String mediaType,
        String title,
        String originalTitle,
        String tagline,
        String overview,
        String posterUrl,
        String backdropUrl,
        String date,
        Double voteAverage,
        Integer voteCount,
        Integer runtime,
        List<String> genres,
        String status,
        Integer seasons,
        Integer episodes,
        String trailerKey,
        List<TmdbVideoDto> videos,
        String tmdbUrl,
        List<TmdbCreditDto> cast
) {
    public static TmdbDetailDto missingKey() {
        return new TmdbDetailDto(
                false, "missing_api_key", null, null, null, null, null, null,
                null, null, null, null, null, null, List.of(), null, null, null, null, List.of(), null, List.of());
    }

    public static TmdbDetailDto failure(String error) {
        return new TmdbDetailDto(
                true, error, null, null, null, null, null, null,
                null, null, null, null, null, null, List.of(), null, null, null, null, List.of(), null, List.of());
    }
}
