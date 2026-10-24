package com.pat.controller.dto;

public record DeezerAlbumDto(
        long id,
        String title,
        String artistName,
        long artistId,
        String coverUrl,
        String releaseDate,
        int trackCount,
        String recordType,
        String link
) {
}
