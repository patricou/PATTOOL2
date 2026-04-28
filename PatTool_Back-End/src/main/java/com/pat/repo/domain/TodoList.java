package com.pat.repo.domain;

import jakarta.validation.constraints.NotBlank;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * Shareable to-do list owned by a {@link Member}. Visibility / sharing semantics mirror
 * {@link CalendarAppointment}: {@code public}, {@code private}, {@code friends}, {@code friendGroups}
 * (with {@code friendGroupIds}), or a legacy friend-group display name.
 *
 * <p>An optional cover image is stored as a base64 data URL on the document itself
 * ({@link #imageDataUrl}) to keep the feature self-contained &mdash; the front-end compresses
 * the image before sending it.</p>
 *
 * <p>Tasks are embedded in {@link #items}. Each task has its own status, due date and assignee
 * (a member id that must belong to the visibility group).</p>
 */
@Document(collection = "todo_lists")
public class TodoList {

    public static final String STATUS_OPEN = "open";
    public static final String STATUS_IN_PROGRESS = "in_progress";
    public static final String STATUS_DONE = "done";
    public static final String STATUS_ARCHIVED = "archived";

    @Id
    private String id;

    @NotBlank
    private String ownerMemberId;

    @NotBlank
    private String name;

    private String description;

    /** Optional cover image, stored as a {@code data:image/...;base64,...} URL. */
    private String imageDataUrl;

    /** When the list overall must be completed. */
    private Date dueDate;

    /** Aggregate status of the whole list. */
    private String status;

    /** Set automatically on creation. */
    private Date createdAt;

    /** Updated on every save. */
    private Date updatedAt;

    /**
     * Same values as {@link CalendarAppointment#getVisibility()}: {@code public}, {@code private},
     * {@code friends}, {@code friendGroups}, or a legacy friend-group display name.
     */
    private String visibility;

    /** Friend group id when visibility targets a single group (legacy / one group). */
    private String friendGroupId;

    /** When visibility is {@code friendGroups}, ids of groups that may see the list. */
    private List<String> friendGroupIds;

    /** Items / tasks inside this list. */
    private List<TodoItem> items = new ArrayList<>();

    /**
     * Optional link to a personal agenda row in {@code calendar_appointments}. Mutually exclusive
     * with {@link #evenementId}; at most one list may reference a given appointment.
     */
    private String calendarAppointmentId;

    /**
     * Optional link to an activity ({@code evenements}). Mutually exclusive with
     * {@link #calendarAppointmentId}; at most one list may reference a given event.
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

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public String getImageDataUrl() {
        return imageDataUrl;
    }

    public void setImageDataUrl(String imageDataUrl) {
        this.imageDataUrl = imageDataUrl;
    }

    public Date getDueDate() {
        return dueDate;
    }

    public void setDueDate(Date dueDate) {
        this.dueDate = dueDate;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
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

    public List<TodoItem> getItems() {
        return items;
    }

    public void setItems(List<TodoItem> items) {
        this.items = items;
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
