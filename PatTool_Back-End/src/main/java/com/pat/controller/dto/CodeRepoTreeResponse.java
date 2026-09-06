package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

public class CodeRepoTreeResponse {

    private String host;
    private String owner;
    private String name;
    private String htmlUrl;
    private String defaultBranch;
    private String path;
    private List<CodeRepoTreeEntryDto> entries = new ArrayList<>();

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

    public String getHtmlUrl() {
        return htmlUrl;
    }

    public void setHtmlUrl(String htmlUrl) {
        this.htmlUrl = htmlUrl;
    }

    public String getDefaultBranch() {
        return defaultBranch;
    }

    public void setDefaultBranch(String defaultBranch) {
        this.defaultBranch = defaultBranch;
    }

    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        this.path = path;
    }

    public List<CodeRepoTreeEntryDto> getEntries() {
        return entries;
    }

    public void setEntries(List<CodeRepoTreeEntryDto> entries) {
        this.entries = entries != null ? entries : new ArrayList<>();
    }
}
