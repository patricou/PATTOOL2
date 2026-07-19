package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Per-user TV favorites payload stored as JSON in {@code appParameters}.
 */
public class TvFavoritesDto {

    private List<TvChannelDto> channels = new ArrayList<>();

    public TvFavoritesDto() {
    }

    public TvFavoritesDto(List<TvChannelDto> channels) {
        this.channels = channels != null ? channels : new ArrayList<>();
    }

    public List<TvChannelDto> getChannels() {
        return channels;
    }

    public void setChannels(List<TvChannelDto> channels) {
        this.channels = channels != null ? channels : new ArrayList<>();
    }
}
