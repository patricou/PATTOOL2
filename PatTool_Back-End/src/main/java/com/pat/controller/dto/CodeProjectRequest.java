package com.pat.controller.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.ArrayList;
import java.util.List;

/**
 * Payload for {@code POST/PUT /api/code-workbench/projects}. Owner is always derived from the
 * authenticated member id header, never from the body.
 */
public class CodeProjectRequest {

    @NotBlank
    @Size(max = 180)
    private String name;

    @Size(max = 2000)
    private String description;

    @Size(max = 40)
    private String language;

    @Size(max = 500)
    private String repoUrl;

    @Valid
    @Size(max = 80)
    private List<CodeProjectFileDto> files = new ArrayList<>();

    @Valid
    @Size(max = 80)
    private List<CodeChatTurnDto> chatTurns = new ArrayList<>();

    @Size(max = 32)
    private String provider;

    @Size(max = 160)
    private String model;

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public String getLanguage() {
        return language;
    }

    public void setLanguage(String language) {
        this.language = language;
    }

    public String getRepoUrl() {
        return repoUrl;
    }

    public void setRepoUrl(String repoUrl) {
        this.repoUrl = repoUrl;
    }

    public List<CodeProjectFileDto> getFiles() {
        return files;
    }

    public void setFiles(List<CodeProjectFileDto> files) {
        this.files = files != null ? files : new ArrayList<>();
    }

    public List<CodeChatTurnDto> getChatTurns() {
        return chatTurns;
    }

    public void setChatTurns(List<CodeChatTurnDto> chatTurns) {
        this.chatTurns = chatTurns != null ? chatTurns : new ArrayList<>();
    }

    public String getProvider() {
        return provider;
    }

    public void setProvider(String provider) {
        this.provider = provider;
    }

    public String getModel() {
        return model;
    }

    public void setModel(String model) {
        this.model = model;
    }
}
