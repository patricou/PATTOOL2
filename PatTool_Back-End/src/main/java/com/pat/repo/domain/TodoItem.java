package com.pat.repo.domain;

import java.util.Date;

/**
 * Single task embedded in a {@link TodoList}. Each item has its own due date, status and
 * optional assignee (a {@link Member} id that must belong to the parent list visibility group).
 */
public class TodoItem {

    /** Client-generated identifier (UUID); kept stable across edits. */
    private String id;

    private String title;

    private String description;

    /** One of {@link TodoList#STATUS_OPEN}, {@link TodoList#STATUS_IN_PROGRESS}, {@link TodoList#STATUS_DONE}. */
    private String status;

    /** When this single task should be completed. */
    private Date dueDate;

    /** Member id of the assignee (must belong to visibility group). */
    private String assigneeMemberId;

    /** Set when status flips to {@code done}. */
    private Date completedAt;

    /** Visual priority hint: {@code low}, {@code normal}, {@code high}. */
    private String priority;

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

    public Date getCompletedAt() {
        return completedAt;
    }

    public void setCompletedAt(Date completedAt) {
        this.completedAt = completedAt;
    }

    public String getPriority() {
        return priority;
    }

    public void setPriority(String priority) {
        this.priority = priority;
    }
}
