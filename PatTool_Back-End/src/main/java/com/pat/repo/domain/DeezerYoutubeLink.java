package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * YouTube video chosen for a Deezer track. Shared across sessions so the
 * Deezer page does not search YouTube again for the same song.
 */
@Document(collection = "deezer_youtube_links")
public class DeezerYoutubeLink {

    @Id
    private String id;

    @Indexed(unique = true)
    private long trackId;

    /** Empty when a search ran and no usable video was found. */
    private String videoId = "";

    /** Other clips from the same search, in result order. The chosen id stays {@link #videoId}. */
    private List<String> videoIds = new ArrayList<>();

    private String query = "";

    private Instant updatedAt;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public long getTrackId() {
        return trackId;
    }

    public void setTrackId(long trackId) {
        this.trackId = trackId;
    }

    public String getVideoId() {
        return videoId;
    }

    public void setVideoId(String videoId) {
        this.videoId = videoId;
    }

    public List<String> getVideoIds() {
        return videoIds;
    }

    public void setVideoIds(List<String> videoIds) {
        this.videoIds = videoIds == null ? new ArrayList<>() : new ArrayList<>(videoIds);
    }

    public String getQuery() {
        return query;
    }

    public void setQuery(String query) {
        this.query = query;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(Instant updatedAt) {
        this.updatedAt = updatedAt;
    }
}
