package com.pat.controller.dto;

import java.util.List;

public record DeezerSearchDto(
        String type,
        String query,
        List<DeezerTrackDto> tracks,
        List<DeezerAlbumDto> albums,
        List<DeezerArtistDto> artists,
        List<DeezerPlaylistDto> playlists,
        int index,
        int total,
        boolean hasNext
) {
}
