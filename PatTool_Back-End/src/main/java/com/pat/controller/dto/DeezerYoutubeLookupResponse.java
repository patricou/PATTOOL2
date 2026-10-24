package com.pat.controller.dto;

import java.util.List;

/** Resolved YouTube ids. {@code videoId} is empty when the search found nothing. {@code cached} is true when the id was read from the stored links. */
public record DeezerYoutubeLookupResponse(List<Link> links) {

    public record Link(long id, String videoId, boolean cached) {
    }
}
