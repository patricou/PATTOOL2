package com.pat.controller.dto;

/** A YouTube video attached to a TMDB movie or series (trailer, teaser, clip). */
public record TmdbVideoDto(
        String key,
        String name,
        String type
) {
}
