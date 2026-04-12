package com.pat.controller.dto;

import java.util.Date;

/**
 * Unified calendar row: personal appointment or site activity (événement).
 */
public class CalendarEntryDTO {

    public static final String KIND_APPOINTMENT = "APPOINTMENT";
    public static final String KIND_ACTIVITY = "ACTIVITY";

    private String kind;
    private String id;
    private String title;
    private Date start;
    private Date end;
    /** GridFS file id for thumbnail image, when available */
    private String thumbnailFileId;
    private String notes;

    public CalendarEntryDTO() {
    }

    public String getKind() {
        return kind;
    }

    public void setKind(String kind) {
        this.kind = kind;
    }

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

    public Date getStart() {
        return start;
    }

    public void setStart(Date start) {
        this.start = start;
    }

    public Date getEnd() {
        return end;
    }

    public void setEnd(Date end) {
        this.end = end;
    }

    public String getThumbnailFileId() {
        return thumbnailFileId;
    }

    public void setThumbnailFileId(String thumbnailFileId) {
        this.thumbnailFileId = thumbnailFileId;
    }

    public String getNotes() {
        return notes;
    }

    public void setNotes(String notes) {
        this.notes = notes;
    }
}
