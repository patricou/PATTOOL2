package com.pat.controller.dto;

import java.util.List;

/** TMDB list page (trending, search or discover). */
public record TmdbPageDto(
        boolean configured,
        String error,
        int page,
        int totalPages,
        int totalResults,
        List<TmdbItemDto> items,
        String actorName,
        String producerName,
        String directorName
) {
    public static TmdbPageDto missingKey() {
        return new TmdbPageDto(false, "missing_api_key", 1, 0, 0, List.of(), null, null, null);
    }

    public static TmdbPageDto failure(String error) {
        return new TmdbPageDto(true, error, 1, 0, 0, List.of(), null, null, null);
    }

    public static TmdbPageDto empty() {
        return new TmdbPageDto(true, null, 1, 0, 0, List.of(), null, null, null);
    }

    public TmdbPageDto withPeople(String actor, String producer, String director) {
        return new TmdbPageDto(configured, error, page, totalPages, totalResults, items, actor, producer, director);
    }
}
