package com.pat.repo.domain;

import org.hibernate.validator.constraints.NotEmpty;

import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Column;


@Entity
public class ChatRequest {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @NotEmpty(message = "User input cannot be empty")
    private String userInput;

    @Column(columnDefinition = "TEXT")
    private String chatResponse;

    public ChatRequest() {
    }

    public ChatRequest(String userInput, String chatResponse) {
        this.userInput = userInput;
        this.chatResponse = chatResponse;
    }

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getUserInput() {
        return userInput;
    }

    public void setUserInput(String userInput) {
        this.userInput = userInput;
    }

    public String getChatResponse() {
        return chatResponse;
    }

    public void setChatResponse(String chatResponse) {
        this.chatResponse = chatResponse;
    }

    @Override
    public String toString() {
        return "ChatRequest{" +
                "id=" + id +
                ", userInput='" + userInput + '\'' +
                ", chatResponse='" + chatResponse + '\'' +
                '}';
    }
}

