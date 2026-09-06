package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

public class CodeRepoSearchResponse {

    private int total;
    private List<CodeRepoSearchHitDto> items = new ArrayList<>();
    /** GitHub/GitLab query actually executed (after NL interpretation). */
    private String interpretedQuery;
    /** Short explanation of the interpretation. */
    private String summary;
    private boolean naturalLanguage;

    public int getTotal() {
        return total;
    }

    public void setTotal(int total) {
        this.total = total;
    }

    public List<CodeRepoSearchHitDto> getItems() {
        return items;
    }

    public void setItems(List<CodeRepoSearchHitDto> items) {
        this.items = items != null ? items : new ArrayList<>();
    }

    public String getInterpretedQuery() {
        return interpretedQuery;
    }

    public void setInterpretedQuery(String interpretedQuery) {
        this.interpretedQuery = interpretedQuery;
    }

    public String getSummary() {
        return summary;
    }

    public void setSummary(String summary) {
        this.summary = summary;
    }

    public boolean isNaturalLanguage() {
        return naturalLanguage;
    }

    public void setNaturalLanguage(boolean naturalLanguage) {
        this.naturalLanguage = naturalLanguage;
    }
}
