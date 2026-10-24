package com.pat.controller.dto;

import java.util.List;

public record DeezerPlaylistPageDto(
        DeezerPlaylistDto playlist,
        List<DeezerTrackDto> tracks
) {
}
