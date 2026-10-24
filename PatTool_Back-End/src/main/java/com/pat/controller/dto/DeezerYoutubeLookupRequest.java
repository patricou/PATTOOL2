package com.pat.controller.dto;

import java.util.List;

/**
 * Tracks currently on screen. The cache is always read.
 * YouTube itself is queried only when {@code search} is true.
 */
public record DeezerYoutubeLookupRequest(List<Track> tracks, boolean search) {

    public record Track(long id, String artist, String title) {
    }
}
