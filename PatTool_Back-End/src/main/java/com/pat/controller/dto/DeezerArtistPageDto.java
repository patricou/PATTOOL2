package com.pat.controller.dto;

import java.util.List;

public record DeezerArtistPageDto(
        DeezerArtistDto artist,
        List<DeezerTrackDto> tracks,
        List<DeezerAlbumDto> albums,
        List<DeezerArtistDto> related
) {
}
