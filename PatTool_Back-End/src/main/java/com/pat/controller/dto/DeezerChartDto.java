package com.pat.controller.dto;

import java.util.List;

public record DeezerChartDto(
        long genreId,
        List<DeezerTrackDto> tracks,
        List<DeezerAlbumDto> albums,
        List<DeezerArtistDto> artists,
        List<DeezerPlaylistDto> playlists
) {
}
