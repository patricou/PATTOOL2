package com.pat.controller.dto;

import java.util.List;

/**
 * YouTube Data API v3 search / popular page, mapped for the Angular Media page.
 */
public record YoutubeSearchPageDto(
        boolean configured,
        String error,
        String message,
        String kind,
        String query,
        String type,
        String regionCode,
        String nextPageToken,
        String prevPageToken,
        int total,
        List<YoutubeItemDto> items
) {
    public static YoutubeSearchPageDto missingKey() {
        return new YoutubeSearchPageDto(
                false,
                "missing_api_key",
                "Configure app.youtube.api-key (YouTube Data API v3 on Google Cloud)",
                null,
                null,
                null,
                null,
                null,
                null,
                0,
                List.of()
        );
    }

    public static YoutubeSearchPageDto failure(String error, String message) {
        return new YoutubeSearchPageDto(
                true,
                error,
                message,
                null,
                null,
                null,
                null,
                null,
                null,
                0,
                List.of()
        );
    }
}
