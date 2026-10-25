package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * New track order for one user playlist. Unknown ids are ignored.
 */
public class DeezerPlaylistOrderRequest {

    private List<Long> trackIds = new ArrayList<>();

    public List<Long> getTrackIds() {
        return trackIds;
    }

    public void setTrackIds(List<Long> trackIds) {
        this.trackIds = trackIds != null ? trackIds : new ArrayList<>();
    }
}
