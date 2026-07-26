package com.pat.controller.dto;

/**
 * ARTE replay / VOD teaser exposed to the TV watcher (EMAC v4 catalog).
 */
public class ArteProgramDto {

    private String id;
    private String programId;
    private String title;
    private String subtitle;
    private String description;
    private String imageUrl;
    private String durationLabel;
    private Integer durationSec;
    private String availabilityLabel;
    private Integer remainingDays;
    private String kind;
    private String genre;
    private String webpageUrl;
    private String streamUrl;
    private boolean live;
    private boolean playable;

    public ArteProgramDto() {
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getProgramId() {
        return programId;
    }

    public void setProgramId(String programId) {
        this.programId = programId;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getSubtitle() {
        return subtitle;
    }

    public void setSubtitle(String subtitle) {
        this.subtitle = subtitle;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public String getImageUrl() {
        return imageUrl;
    }

    public void setImageUrl(String imageUrl) {
        this.imageUrl = imageUrl;
    }

    public String getDurationLabel() {
        return durationLabel;
    }

    public void setDurationLabel(String durationLabel) {
        this.durationLabel = durationLabel;
    }

    public Integer getDurationSec() {
        return durationSec;
    }

    public void setDurationSec(Integer durationSec) {
        this.durationSec = durationSec;
    }

    public String getAvailabilityLabel() {
        return availabilityLabel;
    }

    public void setAvailabilityLabel(String availabilityLabel) {
        this.availabilityLabel = availabilityLabel;
    }

    public Integer getRemainingDays() {
        return remainingDays;
    }

    public void setRemainingDays(Integer remainingDays) {
        this.remainingDays = remainingDays;
    }

    public String getKind() {
        return kind;
    }

    public void setKind(String kind) {
        this.kind = kind;
    }

    public String getGenre() {
        return genre;
    }

    public void setGenre(String genre) {
        this.genre = genre;
    }

    public String getWebpageUrl() {
        return webpageUrl;
    }

    public void setWebpageUrl(String webpageUrl) {
        this.webpageUrl = webpageUrl;
    }

    public String getStreamUrl() {
        return streamUrl;
    }

    public void setStreamUrl(String streamUrl) {
        this.streamUrl = streamUrl;
    }

    public boolean isLive() {
        return live;
    }

    public void setLive(boolean live) {
        this.live = live;
    }

    public boolean isPlayable() {
        return playable;
    }

    public void setPlayable(boolean playable) {
        this.playable = playable;
    }
}
