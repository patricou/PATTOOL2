package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/** Per-user concert: ordered YouTube clips with a display name. */
public class DeezerConcertDto {

    private List<DeezerConcertTrackDto> tracks = new ArrayList<>();

    public DeezerConcertDto() {
    }

    public DeezerConcertDto(List<DeezerConcertTrackDto> tracks) {
        setTracks(tracks);
    }

    public List<DeezerConcertTrackDto> getTracks() {
        return tracks;
    }

    public void setTracks(List<DeezerConcertTrackDto> tracks) {
        this.tracks = tracks != null ? tracks : new ArrayList<>();
    }
}
