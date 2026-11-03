package com.pat.controller.dto;

import java.util.List;

/** Deezer track ids whose stored YouTube link should be read. This does not search YouTube. */
public record DeezerYoutubeStoredRequest(List<Long> ids) {
}
