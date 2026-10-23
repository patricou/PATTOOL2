package com.pat.controller.dto;

/**
 * Photo related to the track currently on air (cover, artist, or album).
 */
public class RadioTrackImageDto {

    private String url;
    private String alt;

    public RadioTrackImageDto() {
    }

    public RadioTrackImageDto(String url, String alt) {
        this.url = url;
        this.alt = alt;
    }

    public String getUrl() {
        return url;
    }

    public void setUrl(String url) {
        this.url = url;
    }

    public String getAlt() {
        return alt;
    }

    public void setAlt(String alt) {
        this.alt = alt;
    }
}
