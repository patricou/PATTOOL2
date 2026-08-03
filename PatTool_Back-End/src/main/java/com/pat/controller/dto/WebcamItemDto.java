package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Webcam list / detail teaser (Windy, Road511, NAPSPAN).
 */
public class WebcamItemDto {

    private String id;
    /** {@code windy} (default), {@code road511}, or {@code napspan}. */
    private String provider;
    private String title;
    /** Full description when the provider supplies one (often richer than {@link #title}). */
    private String description;
    private String status;
    private Long viewCount;
    private String lastUpdatedOn;
    /** Capture time of the still / clip when distinct from {@link #lastUpdatedOn}. */
    private String lastImageTime;
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
    /** True when {@link #playerLiveUrl} is a native HLS / DOT / NAPSPAN stream. */
    private Boolean hasVideo;
    private String roadName;
    private String direction;
    private String source;
    private String sourceId;
    private String featureType;
    private List<String> categories = new ArrayList<>();
    /**
     * Extra scalar fields from the upstream payload (km, angle, views, …),
     * preserved for display. Insertion order is kept.
     */
    private Map<String, String> details = new LinkedHashMap<>();

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

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
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

    public String getLastImageTime() {
        return lastImageTime;
    }

    public void setLastImageTime(String lastImageTime) {
        this.lastImageTime = lastImageTime;
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

    public String getRoadName() {
        return roadName;
    }

    public void setRoadName(String roadName) {
        this.roadName = roadName;
    }

    public String getDirection() {
        return direction;
    }

    public void setDirection(String direction) {
        this.direction = direction;
    }

    public String getSource() {
        return source;
    }

    public void setSource(String source) {
        this.source = source;
    }

    public String getSourceId() {
        return sourceId;
    }

    public void setSourceId(String sourceId) {
        this.sourceId = sourceId;
    }

    public String getFeatureType() {
        return featureType;
    }

    public void setFeatureType(String featureType) {
        this.featureType = featureType;
    }

    public List<String> getCategories() {
        return categories;
    }

    public void setCategories(List<String> categories) {
        this.categories = categories != null ? categories : new ArrayList<>();
    }

    public Map<String, String> getDetails() {
        return details;
    }

    public void setDetails(Map<String, String> details) {
        this.details = details != null ? new LinkedHashMap<>(details) : new LinkedHashMap<>();
    }
}
