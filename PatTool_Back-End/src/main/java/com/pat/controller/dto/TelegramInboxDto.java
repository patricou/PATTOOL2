package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Conversations received via {@code getUpdates} for the signed-in user's bot.
 */
public class TelegramInboxDto {

    private boolean connected;
    private String error;
    private String message;
    private List<TelegramChatDto> chats = new ArrayList<>();

    public TelegramInboxDto() {
    }

    public TelegramInboxDto(boolean connected, String error, String message, List<TelegramChatDto> chats) {
        this.connected = connected;
        this.error = error;
        this.message = message;
        this.chats = chats != null ? chats : new ArrayList<>();
    }

    public static TelegramInboxDto disconnected() {
        return new TelegramInboxDto(false, "not_connected", null, List.of());
    }

    public static TelegramInboxDto failure(String error, String message) {
        return new TelegramInboxDto(true, error, message, List.of());
    }

    public boolean isConnected() {
        return connected;
    }

    public void setConnected(boolean connected) {
        this.connected = connected;
    }

    public String getError() {
        return error;
    }

    public void setError(String error) {
        this.error = error;
    }

    public String getMessage() {
        return message;
    }

    public void setMessage(String message) {
        this.message = message;
    }

    public List<TelegramChatDto> getChats() {
        return chats;
    }

    public void setChats(List<TelegramChatDto> chats) {
        this.chats = chats != null ? chats : new ArrayList<>();
    }
}
