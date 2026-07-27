package com.pat.repo.domain;

import jakarta.validation.constraints.NotBlank;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.Transient;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.Date;

/**
 * Rich-text PDF draft owned by a {@link Member}. Content is Quill HTML (formatting + inline
 * {@code data:image/...} images) stored on the document itself.
 */
@Document(collection = "pdf_converter_documents")
public class PdfConverterDocument {

    @Id
    private String id;

    @NotBlank
    private String ownerMemberId;

    /** PDF file name without extension. */
    @NotBlank
    private String fileName;

    /** Quill HTML body (bold, lists, inline images, etc.). */
    private String htmlContent;

    /**
     * Optional link to a personal calendar appointment. Mutually exclusive with
     * {@link #evenementId}.
     */
    private String calendarAppointmentId;

    /**
     * Optional link to an activity ({@link Evenement}). Mutually exclusive with
     * {@link #calendarAppointmentId}.
     */
    private String evenementId;

    private Date createdAt;

    private Date updatedAt;

    /** Resolved for admin list views only; not stored in MongoDB. */
    @Transient
    private String ownerDisplayName;

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

    public String getFileName() {
        return fileName;
    }

    public void setFileName(String fileName) {
        this.fileName = fileName;
    }

    public String getHtmlContent() {
        return htmlContent;
    }

    public void setHtmlContent(String htmlContent) {
        this.htmlContent = htmlContent;
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

    public String getOwnerDisplayName() {
        return ownerDisplayName;
    }

    public void setOwnerDisplayName(String ownerDisplayName) {
        this.ownerDisplayName = ownerDisplayName;
    }
}
