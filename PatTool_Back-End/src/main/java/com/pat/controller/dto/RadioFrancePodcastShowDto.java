package com.pat.controller.dto;

/**
 * Radio France podcast show (émission) discovered from the public website catalog.
 */
public class RadioFrancePodcastShowDto {

    private String id;
    private String station;
    private String stationName;
    private String slug;
    private String title;
    private String description;
    private String image;
    private String path;
    private String homepage;

    public RadioFrancePodcastShowDto() {
    }

    public RadioFrancePodcastShowDto(
            String id,
            String station,
            String stationName,
            String slug,
            String title,
            String description,
            String image,
            String path,
            String homepage) {
        this.id = id;
        this.station = station;
        this.stationName = stationName;
        this.slug = slug;
        this.title = title;
        this.description = description;
        this.image = image;
        this.path = path;
        this.homepage = homepage;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getStation() {
        return station;
    }

    public void setStation(String station) {
        this.station = station;
    }

    public String getStationName() {
        return stationName;
    }

    public void setStationName(String stationName) {
        this.stationName = stationName;
    }

    public String getSlug() {
        return slug;
    }

    public void setSlug(String slug) {
        this.slug = slug;
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

    public String getImage() {
        return image;
    }

    public void setImage(String image) {
        this.image = image;
    }

    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        this.path = path;
    }

    public String getHomepage() {
        return homepage;
    }

    public void setHomepage(String homepage) {
        this.homepage = homepage;
    }
}
