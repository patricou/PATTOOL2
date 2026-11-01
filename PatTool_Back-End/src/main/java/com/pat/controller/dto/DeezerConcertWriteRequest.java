package com.pat.controller.dto;

/** Add a Deezer title to the concert, or rename an existing one. */
public class DeezerConcertWriteRequest {

    private String name;
    private String videoId;
    private DeezerTrackDto track;

    public String getVideoId() {
        return videoId;
    }

    public void setVideoId(String videoId) {
        this.videoId = videoId;
    }

    public DeezerTrackDto getTrack() {
        return track;
    }

    public void setTrack(DeezerTrackDto track) {
        this.track = track;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }
}
