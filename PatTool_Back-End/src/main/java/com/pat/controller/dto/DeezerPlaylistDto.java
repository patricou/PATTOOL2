package com.pat.controller.dto;

public record DeezerPlaylistDto(
        long id,
        String title,
        String userName,
        String pictureUrl,
        int trackCount,
        String link
) {
}
