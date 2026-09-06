package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

public class CodeRepoAnalyzeResponse {

    private String host;
    private String owner;
    private String name;
    private String defaultBranch;
    private String description;
    private String htmlUrl;
    private boolean truncated;
    private String message;
    private List<CodeRepoFileDto> files = new ArrayList<>();

    public String getHost() {
        return host;
    }

    public void setHost(String host) {
        this.host = host;
    }

    public String getOwner() {
        return owner;
    }

    public void setOwner(String owner) {
        this.owner = owner;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getDefaultBranch() {
        return defaultBranch;
    }

    public void setDefaultBranch(String defaultBranch) {
        this.defaultBranch = defaultBranch;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public String getHtmlUrl() {
        return htmlUrl;
    }

    public void setHtmlUrl(String htmlUrl) {
        this.htmlUrl = htmlUrl;
    }

    public boolean isTruncated() {
        return truncated;
    }

    public void setTruncated(boolean truncated) {
        this.truncated = truncated;
    }

    public String getMessage() {
        return message;
    }

    public void setMessage(String message) {
        this.message = message;
    }

    public List<CodeRepoFileDto> getFiles() {
        return files;
    }

    public void setFiles(List<CodeRepoFileDto> files) {
        this.files = files != null ? files : new ArrayList<>();
    }
}
