package com.pat.controller.dto;

/** Artist facts returned by the public TheAudioDB catalog. */
public record AudioDbArtistDto(
        String name,
        String biography,
        String genre,
        String style,
        String mood,
        String country,
        String formedYear,
        String website,
        int members,
        String thumbUrl
) {
}
