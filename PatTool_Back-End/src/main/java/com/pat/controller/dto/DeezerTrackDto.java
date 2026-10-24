package com.pat.controller.dto;

/**
 * One Deezer track. {@code previewUrl} is a 30-second MP3, not the full song.
 */
public record DeezerTrackDto(
        long id,
        String title,
        String artistName,
        long artistId,
        String albumTitle,
        long albumId,
        String coverUrl,
        String previewUrl,
        int durationSec,
        boolean explicit,
        String link
) {
}
