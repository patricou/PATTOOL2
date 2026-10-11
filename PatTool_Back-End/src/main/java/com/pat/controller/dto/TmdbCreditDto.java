package com.pat.controller.dto;

/** A cast member on a TMDB movie or TV detail. */
public record TmdbCreditDto(
        long id,
        String name,
        String character,
        String profileUrl
) {
}
