package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Per-user artisan / pro favorites payload stored as JSON in {@code appParameters}.
 */
public class ArtisansFavoritesDto {

    private List<ArtisanFavoriteDto> items = new ArrayList<>();

    public ArtisansFavoritesDto() {
    }

    public ArtisansFavoritesDto(List<ArtisanFavoriteDto> items) {
        this.items = items != null ? items : new ArrayList<>();
    }

    public List<ArtisanFavoriteDto> getItems() {
        return items;
    }

    public void setItems(List<ArtisanFavoriteDto> items) {
        this.items = items != null ? items : new ArrayList<>();
    }
}
