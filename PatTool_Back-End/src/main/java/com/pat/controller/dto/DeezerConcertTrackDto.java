package com.pat.controller.dto;

/**
 * One YouTube clip kept in the signed-in user's concert list.
 * {@code playId} is a stable numeric id for the Deezer player, outside the Deezer catalog range.
 */
public class DeezerConcertTrackDto {

    private String id;
    private long playId;
    private String videoId;
    private String name;
    private DeezerTrackDto track;

    public DeezerConcertTrackDto() {
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public long getPlayId() {
        return playId;
    }

    public void setPlayId(long playId) {
        this.playId = playId;
    }

    public String getVideoId() {
        return videoId;
    }

    public void setVideoId(String videoId) {
        this.videoId = videoId;
    }

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
