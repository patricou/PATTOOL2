package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Per-user Deezer favorites payload stored as JSON in {@code appParameters}.
 */
public class DeezerFavoritesDto {

    private List<DeezerFavoriteItemDto> items = new ArrayList<>();

    public DeezerFavoritesDto() {
    }

    public DeezerFavoritesDto(List<DeezerFavoriteItemDto> items) {
        this.items = items != null ? items : new ArrayList<>();
    }

    public List<DeezerFavoriteItemDto> getItems() {
        return items;
    }

    public void setItems(List<DeezerFavoriteItemDto> items) {
        this.items = items != null ? items : new ArrayList<>();
    }
}
