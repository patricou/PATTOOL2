package com.pat.repo.domain;

import jakarta.validation.constraints.NotBlank;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.Date;
import java.util.List;

/**
 * Sticky note owned by a {@link Member}. Visibility / sharing mirrors {@link TodoList}:
 * {@code public}, {@code private}, {@code friends}, {@code friendGroups} (with
 * {@code friendGroupIds}). Optional GPS may be stored when the note is created.
 */
@Document(collection = "notes")
public class Note {

    @Id
    private String id;

    @NotBlank
    private String ownerMemberId;

    /** Display name of the owner at creation time (first + last, or username). */
    private String ownerDisplayName;

    private String title;

    /** Plain-text body of the note. */
    private String content;

    /** Post-it colour as a CSS hex (e.g. {@code #ffe066}). */
    private String color;

    /** Latitude where the note was created, if available. */
    private Double latitude;

    /** Longitude where the note was created, if available. */
    private Double longitude;

    /** GPS accuracy in metres, if the browser reported it. */
    private Double gpsAccuracy;

    private Date createdAt;

    private Date updatedAt;

    /**
     * Same values as {@link TodoList#getVisibility()}: {@code public}, {@code private},
     * {@code friends}, {@code friendGroups}, or a legacy friend-group display name.
     */
    private String visibility;

    /** Friend group id when visibility targets a single group (legacy / one group). */
    private String friendGroupId;

    /** When visibility is {@code friendGroups}, ids of groups that may see the note. */
    private List<String> friendGroupIds;

    /**
     * Optional photos stored as {@code data:image/...;base64,...} URLs. The front-end
     * compresses images before upload (same approach as {@link TodoList#getImageDataUrl()}).
     */
    private List<String> imageDataUrls;

    /**
     * Optional link to a personal agenda row in {@code calendar_appointments}. Mutually exclusive
     * with {@link #evenementId}. Multiple notes may reference the same appointment.
     */
    private String calendarAppointmentId;

    /**
     * Optional link to an activity ({@code evenements}). Mutually exclusive with
     * {@link #calendarAppointmentId}. Multiple notes may reference the same event.
     */
    private String evenementId;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getOwnerMemberId() {
        return ownerMemberId;
    }

    public void setOwnerMemberId(String ownerMemberId) {
        this.ownerMemberId = ownerMemberId;
    }

    public String getOwnerDisplayName() {
        return ownerDisplayName;
    }

    public void setOwnerDisplayName(String ownerDisplayName) {
        this.ownerDisplayName = ownerDisplayName;
    }

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

    public Date getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(Date createdAt) {
        this.createdAt = createdAt;
    }

    public Date getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(Date updatedAt) {
        this.updatedAt = updatedAt;
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
