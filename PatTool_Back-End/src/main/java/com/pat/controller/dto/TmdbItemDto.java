package com.pat.controller.dto;

/**
 * One TMDB movie or TV result (trending, search or discover).
 */
public record TmdbItemDto(
        long id,
        String mediaType,
        String title,
        String originalTitle,
        String overview,
        String posterUrl,
        String backdropUrl,
        String date,
        Double voteAverage,
        Integer voteCount,
        String originalLanguage
) {
}
