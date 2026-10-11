package com.pat.controller.dto;

import java.util.List;

/** TMDB genre list for the discover filters. */
public record TmdbGenresDto(
        boolean configured,
        String error,
        List<TmdbGenreDto> genres
) {
    public static TmdbGenresDto missingKey() {
        return new TmdbGenresDto(false, "missing_api_key", List.of());
    }

    public static TmdbGenresDto failure(String error) {
        return new TmdbGenresDto(true, error, List.of());
    }
}
