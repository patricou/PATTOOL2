package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * One playlist owned by the signed-in user (name + ordered tracks).
 */
public class DeezerUserPlaylistDto {

    private String id;
    private String name;
    private List<DeezerTrackDto> tracks = new ArrayList<>();

    public DeezerUserPlaylistDto() {
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public List<DeezerTrackDto> getTracks() {
        return tracks;
    }

    public void setTracks(List<DeezerTrackDto> tracks) {
        this.tracks = tracks != null ? tracks : new ArrayList<>();
    }
}
