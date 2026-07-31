package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Paginated Windy webcam search response.
 */
public class WebcamSearchPageDto {

    private int total;
    private int limit;
    private int offset;
    private String countries;
    private String continents;
    private String categories;
    private String nearby;
    private String sortKey;
    private List<WebcamItemDto> webcams = new ArrayList<>();
    private String error;
    private String message;

    public WebcamSearchPageDto() {
    }

    public int getTotal() {
        return total;
    }

    public void setTotal(int total) {
        this.total = total;
    }

    public int getLimit() {
        return limit;
    }

    public void setLimit(int limit) {
        this.limit = limit;
    }

    public int getOffset() {
        return offset;
    }

    public void setOffset(int offset) {
        this.offset = offset;
    }

    public String getCountries() {
        return countries;
    }

    public void setCountries(String countries) {
        this.countries = countries;
    }

    public String getContinents() {
        return continents;
    }

    public void setContinents(String continents) {
        this.continents = continents;
    }

    public String getCategories() {
        return categories;
    }

    public void setCategories(String categories) {
        this.categories = categories;
    }

    public String getNearby() {
        return nearby;
    }

    public void setNearby(String nearby) {
        this.nearby = nearby;
    }

    public String getSortKey() {
        return sortKey;
    }

    public void setSortKey(String sortKey) {
        this.sortKey = sortKey;
    }

    public List<WebcamItemDto> getWebcams() {
        return webcams;
    }

    public void setWebcams(List<WebcamItemDto> webcams) {
        this.webcams = webcams != null ? webcams : new ArrayList<>();
    }

    public String getError() {
        return error;
    }

    public void setError(String error) {
        this.error = error;
    }

    public String getMessage() {
        return message;
    }

    public void setMessage(String message) {
        this.message = message;
    }
}
