package com.pat.controller.dto;

/**
 * Free IPTV channel entry (iptv-org playlist metadata).
 */
public class TvChannelDto {

    private String id;
    private String name;
    private String logo;
    private String group;
    private String country;
    private String streamUrl;
    private String quality;

    public TvChannelDto() {
    }

    public TvChannelDto(String id, String name, String logo, String group,
                        String country, String streamUrl, String quality) {
        this.id = id;
        this.name = name;
        this.logo = logo;
        this.group = group;
        this.country = country;
        this.streamUrl = streamUrl;
        this.quality = quality;
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

    public String getGroup() {
        return group;
    }

    public void setGroup(String group) {
        this.group = group;
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

    public String getQuality() {
        return quality;
    }

    public void setQuality(String quality) {
        this.quality = quality;
    }
}
