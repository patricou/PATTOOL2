package com.pat.controller.dto;

public record DeezerArtistDto(
        long id,
        String name,
        String pictureUrl,
        int albumCount,
        long fanCount,
        String link
) {
}
