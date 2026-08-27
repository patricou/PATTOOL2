package com.pat.controller.dto;

/**
 * Per-user Telegram Bot API connection (token never included).
 */
public record TelegramStatusDto(
        boolean connected,
        String error,
        String message,
        Long botId,
        String botUsername,
        String botFirstName,
        Boolean canJoinGroups,
        Boolean canReadAllGroupMessages,
        String tokenHint,
        Long connectedAt
) {
    public static TelegramStatusDto disconnected() {
        return new TelegramStatusDto(false, null, null, null, null, null, null, null, null, null);
    }

    public static TelegramStatusDto failure(String error, String message) {
        return new TelegramStatusDto(false, error, message, null, null, null, null, null, null, null);
    }
}
