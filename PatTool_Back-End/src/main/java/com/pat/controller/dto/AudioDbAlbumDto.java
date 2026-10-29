package com.pat.controller.dto;

/** Album facts returned by the public TheAudioDB catalog. */
public record AudioDbAlbumDto(
        String title,
        String artistName,
        String description,
        String genre,
        String style,
        String mood,
        String label,
        String year,
        String thumbUrl
) {
}
