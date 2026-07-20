package com.pat.controller.dto;

/**
 * Internet radio station entry (radio-browser.info metadata).
 */
public class RadioStationDto {

    private String id;
    private String name;
    private String logo;
    private String tags;
    private String country;
    private String streamUrl;
    private String codec;
    private Integer bitrate;
    private String language;
    private String homepage;

    public RadioStationDto() {
    }

    public RadioStationDto(String id, String name, String logo, String tags,
                           String country, String streamUrl, String codec,
                           Integer bitrate, String language, String homepage) {
        this.id = id;
        this.name = name;
        this.logo = logo;
        this.tags = tags;
        this.country = country;
        this.streamUrl = streamUrl;
        this.codec = codec;
        this.bitrate = bitrate;
        this.language = language;
        this.homepage = homepage;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getLogo() {
        return logo;
    }

    public void setLogo(String logo) {
        this.logo = logo;
    }

    public String getTags() {
        return tags;
    }

    public void setTags(String tags) {
        this.tags = tags;
    }

    public String getCountry() {
        return country;
    }

    public void setCountry(String country) {
        this.country = country;
    }

    public String getStreamUrl() {
        return streamUrl;
    }

    public void setStreamUrl(String streamUrl) {
        this.streamUrl = streamUrl;
    }

    public String getCodec() {
        return codec;
    }

    public void setCodec(String codec) {
        this.codec = codec;
    }

    public Integer getBitrate() {
        return bitrate;
    }

    public void setBitrate(Integer bitrate) {
        this.bitrate = bitrate;
    }

    public String getLanguage() {
        return language;
    }

    public void setLanguage(String language) {
        this.language = language;
    }

    public String getHomepage() {
        return homepage;
    }

    public void setHomepage(String homepage) {
        this.homepage = homepage;
    }
}
