package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Per-user YouTube favorites payload stored as JSON in {@code appParameters}.
 */
public class YoutubeFavoritesDto {

    private List<YoutubeItemDto> items = new ArrayList<>();

    public YoutubeFavoritesDto() {
    }

    public YoutubeFavoritesDto(List<YoutubeItemDto> items) {
        this.items = items != null ? items : new ArrayList<>();
    }

    public List<YoutubeItemDto> getItems() {
        return items;
    }

    public void setItems(List<YoutubeItemDto> items) {
        this.items = items != null ? items : new ArrayList<>();
    }
}
