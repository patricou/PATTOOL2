package com.pat.controller.dto;

/**
 * {@code sendMessage} payload (Bot API).
 */
public class TelegramSendRequest {

    private String chatId;
    private String text;

    public String getChatId() {
        return chatId;
    }

    public void setChatId(String chatId) {
        this.chatId = chatId;
    }

    public String getText() {
        return text;
    }

    public void setText(String text) {
        this.text = text;
    }
}
