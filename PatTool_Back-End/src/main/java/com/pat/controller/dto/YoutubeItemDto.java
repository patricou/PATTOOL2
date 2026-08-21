package com.pat.controller.dto;

/**
 * One YouTube search / popular result (video, playlist or channel).
 */
public record YoutubeItemDto(
        String id,
        String kind,
        String title,
        String description,
        String channelTitle,
        String channelId,
        String publishedAt,
        String thumbnailUrl,
        String duration,
        Long viewCount,
        String liveBroadcast
) {
}
