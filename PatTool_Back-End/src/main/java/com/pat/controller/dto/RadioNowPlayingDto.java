package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Track currently playing on a live radio stream, plus related photos.
 */
public class RadioNowPlayingDto {

    private String title = "";
    private String artist = "";
    private String album = "";
    private String label = "";
    private List<RadioTrackImageDto> images = new ArrayList<>();

    public static RadioNowPlayingDto empty() {
        return new RadioNowPlayingDto();
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getArtist() {
        return artist;
    }

    public void setArtist(String artist) {
        this.artist = artist;
    }

    public String getAlbum() {
        return album;
    }

    public void setAlbum(String album) {
        this.album = album;
    }

    public String getLabel() {
        return label;
    }

    public void setLabel(String label) {
        this.label = label;
    }

    public List<RadioTrackImageDto> getImages() {
        return images;
    }

    public void setImages(List<RadioTrackImageDto> images) {
        this.images = images != null ? images : new ArrayList<>();
    }
}
