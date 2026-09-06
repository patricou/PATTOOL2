package com.pat.controller.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public class CodeRepoSearchRequest {

    @NotBlank
    @Size(max = 400)
    private String query;

    /** github, gitlab, or all. */
    @Size(max = 16)
    private String host;

    private Integer page;

    /** When true, an AI model turns the sentence into a GitHub/GitLab search query. */
    private Boolean naturalLanguage;

    @Size(max = 32)
    private String provider;

    @Size(max = 160)
    private String model;

    public String getQuery() {
        return query;
    }

    public void setQuery(String query) {
        this.query = query;
    }

    public String getHost() {
        return host;
    }

    public void setHost(String host) {
        this.host = host;
    }

    public Integer getPage() {
        return page;
    }

    public void setPage(Integer page) {
        this.page = page;
    }

    public Boolean getNaturalLanguage() {
        return naturalLanguage;
    }

    public void setNaturalLanguage(Boolean naturalLanguage) {
        this.naturalLanguage = naturalLanguage;
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
