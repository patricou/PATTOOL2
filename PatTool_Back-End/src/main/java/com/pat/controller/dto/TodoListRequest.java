package com.pat.controller.dto;

import jakarta.validation.constraints.NotBlank;

import java.util.Date;
import java.util.List;

/**
 * Payload accepted by {@code POST /api/todolists} and {@code PUT /api/todolists/{id}}. Fields
 * mirror {@link com.pat.repo.domain.TodoList}; the owner is always derived from the authenticated
 * user, never from the body.
 */
public class TodoListRequest {

    @NotBlank
    private String name;

    private String description;

    private String imageDataUrl;

    private Date dueDate;

    private String status;

    private String visibility;

    private String friendGroupId;

    private List<String> friendGroupIds;

    private List<TodoItemPayload> items;

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

    public List<TodoItemPayload> getItems() {
        return items;
    }

    public void setItems(List<TodoItemPayload> items) {
        this.items = items;
    }

    public static class TodoItemPayload {
        private String id;
        private String title;
        private String description;
        private String status;
        private Date dueDate;
        private String assigneeMemberId;
        private String priority;
        private Date completedAt;

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
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

        public Date getDueDate() {
            return dueDate;
        }

        public void setDueDate(Date dueDate) {
            this.dueDate = dueDate;
        }

        public String getAssigneeMemberId() {
            return assigneeMemberId;
        }

        public void setAssigneeMemberId(String assigneeMemberId) {
            this.assigneeMemberId = assigneeMemberId;
        }

        public String getPriority() {
            return priority;
        }

        public void setPriority(String priority) {
            this.priority = priority;
        }

        public Date getCompletedAt() {
            return completedAt;
        }

        public void setCompletedAt(Date completedAt) {
            this.completedAt = completedAt;
        }
    }
}
