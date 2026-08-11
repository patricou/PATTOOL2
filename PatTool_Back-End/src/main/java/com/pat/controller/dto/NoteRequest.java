package com.pat.controller.dto;

import java.util.List;

/**
 * Payload accepted by {@code POST /api/notes} and {@code PUT /api/notes/{id}}.
 * The owner is always derived from the authenticated user, never from the body.
 */
public class NoteRequest {

    private String title;

    private String content;

    private String color;

    private Double latitude;

    private Double longitude;

    private Double gpsAccuracy;

    private String ownerDisplayName;

    private String visibility;

    private String friendGroupId;

    private List<String> friendGroupIds;

    private List<String> imageDataUrls;

    /** Optional agenda appointment id; mutually exclusive with {@link #evenementId}. */
    private String calendarAppointmentId;

    /** Optional activity (evenement) id; mutually exclusive with {@link #calendarAppointmentId}. */
    private String evenementId;

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getContent() {
        return content;
    }

    public void setContent(String content) {
        this.content = content;
    }

    public String getColor() {
        return color;
    }

    public void setColor(String color) {
        this.color = color;
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

    public Double getGpsAccuracy() {
        return gpsAccuracy;
    }

    public void setGpsAccuracy(Double gpsAccuracy) {
        this.gpsAccuracy = gpsAccuracy;
    }

    public String getOwnerDisplayName() {
        return ownerDisplayName;
    }

    public void setOwnerDisplayName(String ownerDisplayName) {
        this.ownerDisplayName = ownerDisplayName;
    }

    public String getVisibility() {
        return visibility;
    }

    public void setVisibility(String visibility) {
        this.visibility = visibility;
    }

    public String getFriendGroupId() {
        return friendGroupId;
    }

    public void setFriendGroupId(String friendGroupId) {
        this.friendGroupId = friendGroupId;
    }

    public List<String> getFriendGroupIds() {
        return friendGroupIds;
    }

    public void setFriendGroupIds(List<String> friendGroupIds) {
        this.friendGroupIds = friendGroupIds;
    }

    public List<String> getImageDataUrls() {
        return imageDataUrls;
    }

    public void setImageDataUrls(List<String> imageDataUrls) {
        this.imageDataUrls = imageDataUrls;
    }

    public String getCalendarAppointmentId() {
        return calendarAppointmentId;
    }

    public void setCalendarAppointmentId(String calendarAppointmentId) {
        this.calendarAppointmentId = calendarAppointmentId;
    }

    public String getEvenementId() {
        return evenementId;
    }

    public void setEvenementId(String evenementId) {
        this.evenementId = evenementId;
    }
}
