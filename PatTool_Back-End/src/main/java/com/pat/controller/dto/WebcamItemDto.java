package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Windy webcam list / detail teaser.
 */
public class WebcamItemDto {

    private String id;
    /** {@code windy} (default) or {@code road511}. */
    private String provider;
    private String title;
    private String status;
    private Long viewCount;
    private String lastUpdatedOn;
    private String city;
    private String region;
    private String country;
    private String countryCode;
    private String continent;
    private String continentCode;
    private Double latitude;
    private Double longitude;
    private String imageUrl;
    private String imagePreviewUrl;
    private String playerDayUrl;
    private String playerLiveUrl;
    private String playerMonthUrl;
    private String detailUrl;
    /** True when {@link #playerLiveUrl} is a native HLS / DOT stream (Road511). */
    private Boolean hasVideo;
    private List<String> categories = new ArrayList<>();

    public WebcamItemDto() {
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getProvider() {
        return provider;
    }

    public void setProvider(String provider) {
        this.provider = provider;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public Long getViewCount() {
        return viewCount;
    }

    public void setViewCount(Long viewCount) {
        this.viewCount = viewCount;
    }

    public String getLastUpdatedOn() {
        return lastUpdatedOn;
    }

    public void setLastUpdatedOn(String lastUpdatedOn) {
        this.lastUpdatedOn = lastUpdatedOn;
    }

    public String getCity() {
        return city;
    }

    public void setCity(String city) {
        this.city = city;
    }

    public String getRegion() {
        return region;
    }

    public void setRegion(String region) {
        this.region = region;
    }

    public String getCountry() {
        return country;
    }

    public void setCountry(String country) {
        this.country = country;
    }

    public String getCountryCode() {
        return countryCode;
    }

    public void setCountryCode(String countryCode) {
        this.countryCode = countryCode;
    }

    public String getContinent() {
        return continent;
    }

    public void setContinent(String continent) {
        this.continent = continent;
    }

    public String getContinentCode() {
        return continentCode;
    }

    public void setContinentCode(String continentCode) {
        this.continentCode = continentCode;
    }

    public Double getLatitude() {
        return latitude;
    }

    public void setLatitude(Double latitude) {
        this.latitude = latitude;
    }

    public Double getLongitude() {
        return longitude;
    }

    public void setLongitude(Double longitude) {
        this.longitude = longitude;
    }

    public String getImageUrl() {
        return imageUrl;
    }

    public void setImageUrl(String imageUrl) {
        this.imageUrl = imageUrl;
    }

    public String getImagePreviewUrl() {
        return imagePreviewUrl;
    }

    public void setImagePreviewUrl(String imagePreviewUrl) {
        this.imagePreviewUrl = imagePreviewUrl;
    }

    public String getPlayerDayUrl() {
        return playerDayUrl;
    }

    public void setPlayerDayUrl(String playerDayUrl) {
        this.playerDayUrl = playerDayUrl;
    }

    public String getPlayerLiveUrl() {
        return playerLiveUrl;
    }

    public void setPlayerLiveUrl(String playerLiveUrl) {
        this.playerLiveUrl = playerLiveUrl;
    }

    public String getPlayerMonthUrl() {
        return playerMonthUrl;
    }

    public void setPlayerMonthUrl(String playerMonthUrl) {
        this.playerMonthUrl = playerMonthUrl;
    }

    public String getDetailUrl() {
        return detailUrl;
    }

    public void setDetailUrl(String detailUrl) {
        this.detailUrl = detailUrl;
    }

    public Boolean getHasVideo() {
        return hasVideo;
    }

    public void setHasVideo(Boolean hasVideo) {
        this.hasVideo = hasVideo;
    }

    public List<String> getCategories() {
        return categories;
    }

    public void setCategories(List<String> categories) {
        this.categories = categories != null ? categories : new ArrayList<>();
    }
}
