package com.pat.repo.domain;

import jakarta.validation.constraints.NotBlank;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.Transient;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * Per-user coding workbench project (files + assistant thread + optional linked public repo).
 */
@Document(collection = "code_projects")
public class CodeProject {

    @Id
    private String id;

    @NotBlank
    private String ownerMemberId;

    @NotBlank
    private String name;

    private String description;

    /** Default language of the project (java, python, …). */
    private String language;

    /** Linked public GitHub / GitLab URL, if any. */
    private String repoUrl;

    private List<CodeProjectFile> files = new ArrayList<>();

    private List<CodeChatTurn> chatTurns = new ArrayList<>();

    private String provider;

    private String model;

    private Date createdAt;

    private Date updatedAt;

    /** Resolved for admin list views only; not stored in MongoDB. */
    @Transient
    private String ownerDisplayName;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getOwnerMemberId() {
        return ownerMemberId;
    }

    public void setOwnerMemberId(String ownerMemberId) {
        this.ownerMemberId = ownerMemberId;
    }

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

    public List<CodeProjectFile> getFiles() {
        return files;
    }

    public void setFiles(List<CodeProjectFile> files) {
        this.files = files != null ? files : new ArrayList<>();
    }

    public List<CodeChatTurn> getChatTurns() {
        return chatTurns;
    }

    public void setChatTurns(List<CodeChatTurn> chatTurns) {
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

    public Date getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(Date createdAt) {
        this.createdAt = createdAt;
    }

    public Date getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(Date updatedAt) {
        this.updatedAt = updatedAt;
    }

    public String getOwnerDisplayName() {
        return ownerDisplayName;
    }

    public void setOwnerDisplayName(String ownerDisplayName) {
        this.ownerDisplayName = ownerDisplayName;
    }
}
