package com.pat.controller.dto;

import java.util.List;

/**
 * Tracks currently on screen. The cache is always read.
 * YouTube itself is queried only when {@code search} is true.
 */
public record DeezerYoutubeLookupRequest(List<Track> tracks, boolean search) {

    /**
     * {@code skipVideoId} asks for the next result without writing it.
     * {@code saveVideoId} stores that one id and replaces the previous link.
     * {@code more} loads the next page of ten clips and appends them to the stored list.
     */
    public record Track(long id, String artist, String title, String skipVideoId, String saveVideoId, boolean more) {
        public Track(long id, String artist, String title) {
            this(id, artist, title, null, null, false);
        }

        public Track(long id, String artist, String title, String skipVideoId) {
            this(id, artist, title, skipVideoId, null, false);
        }

        public Track(long id, String artist, String title, String skipVideoId, String saveVideoId) {
            this(id, artist, title, skipVideoId, saveVideoId, false);
        }
    }
}
