package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Per-user webcam favorites payload stored as JSON in {@code appParameters}.
 */
public class WebcamFavoritesDto {

    private List<WebcamItemDto> webcams = new ArrayList<>();

    public WebcamFavoritesDto() {
    }

    public WebcamFavoritesDto(List<WebcamItemDto> webcams) {
        this.webcams = webcams != null ? webcams : new ArrayList<>();
    }

    public List<WebcamItemDto> getWebcams() {
        return webcams;
    }

    public void setWebcams(List<WebcamItemDto> webcams) {
        this.webcams = webcams != null ? webcams : new ArrayList<>();
    }
}
