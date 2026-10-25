package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Per-user Deezer playlists payload stored as JSON in {@code appParameters}.
 */
public class DeezerUserPlaylistsDto {

    private List<DeezerUserPlaylistDto> playlists = new ArrayList<>();

    public DeezerUserPlaylistsDto() {
    }

    public DeezerUserPlaylistsDto(List<DeezerUserPlaylistDto> playlists) {
        this.playlists = playlists != null ? playlists : new ArrayList<>();
    }

    public List<DeezerUserPlaylistDto> getPlaylists() {
        return playlists;
    }

    public void setPlaylists(List<DeezerUserPlaylistDto> playlists) {
        this.playlists = playlists != null ? playlists : new ArrayList<>();
    }
}
