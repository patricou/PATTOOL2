package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Per-user radio favorites payload stored as JSON in {@code appParameters}.
 */
public class RadioFavoritesDto {

    private List<RadioStationDto> stations = new ArrayList<>();

    public RadioFavoritesDto() {
    }

    public RadioFavoritesDto(List<RadioStationDto> stations) {
        this.stations = stations != null ? stations : new ArrayList<>();
    }

    public List<RadioStationDto> getStations() {
        return stations;
    }

    public void setStations(List<RadioStationDto> stations) {
        this.stations = stations != null ? stations : new ArrayList<>();
    }
}
