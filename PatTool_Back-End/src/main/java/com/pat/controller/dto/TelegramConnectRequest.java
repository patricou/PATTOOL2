package com.pat.controller.dto;

/**
 * Personal BotFather token for the signed-in PatTool user.
 */
public class TelegramConnectRequest {

    private String botToken;

    public String getBotToken() {
        return botToken;
    }

    public void setBotToken(String botToken) {
        this.botToken = botToken;
    }
}
