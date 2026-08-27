package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * One Telegram chat (private, group or channel) for the signed-in user's bot.
 */
public class TelegramChatDto {

    private String id;
    private String type;
    private String title;
    private String username;
    private String firstName;
    private String lastName;
    private List<TelegramMessageDto> messages = new ArrayList<>();

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    public String getFirstName() {
        return firstName;
    }

    public void setFirstName(String firstName) {
        this.firstName = firstName;
    }

    public String getLastName() {
        return lastName;
    }

    public void setLastName(String lastName) {
        this.lastName = lastName;
    }

    public List<TelegramMessageDto> getMessages() {
        return messages;
    }

    public void setMessages(List<TelegramMessageDto> messages) {
        this.messages = messages != null ? messages : new ArrayList<>();
    }
}
