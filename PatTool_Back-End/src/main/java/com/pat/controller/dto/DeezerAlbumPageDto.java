package com.pat.controller.dto;

import java.util.List;

public record DeezerAlbumPageDto(
        DeezerAlbumDto album,
        List<DeezerTrackDto> tracks
) {
}
