package com.pat.controller.dto;

import java.util.List;

/** Resolved YouTube ids. {@code videoId} is empty when the search found nothing. {@code cached} is true when the id was read from the stored links. {@code videoIds} is the result list, so the next clip does not search again. */
public record DeezerYoutubeLookupResponse(List<Link> links) {

    public record Link(long id, String videoId, boolean cached, List<String> videoIds) {
        public Link {
            videoIds = videoIds == null ? List.of() : List.copyOf(videoIds);
        }

        public Link(long id, String videoId, boolean cached) {
            this(id, videoId, cached, List.of());
        }
    }
}
