package com.pat.controller.dto;

/**
 * Official public post embed ({@code t.me/channel/id?embed=1}).
 */
public record TelegramEmbedDto(
        boolean ok,
        String error,
        String channel,
        Long messageId,
        String embedUrl,
        String postUrl
) {
    public static TelegramEmbedDto invalid() {
        return new TelegramEmbedDto(false, "invalid_url", null, null, null, null);
    }
}
