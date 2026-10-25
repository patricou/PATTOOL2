package com.pat.controller.dto;

/**
 * Create or rename a user playlist. {@code track} is optional and only used on create.
 */
public class DeezerPlaylistWriteRequest {

    private String name;
    private DeezerTrackDto track;

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public DeezerTrackDto getTrack() {
        return track;
    }

    public void setTrack(DeezerTrackDto track) {
        this.track = track;
    }
}
