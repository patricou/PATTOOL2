package com.pat.repo.domain;

import java.util.Date;

/**
 * Lightweight view of a {@link PdfConverterDocument} linked to an activity (no HTML body).
 * Used as a transient enrichment on {@link Evenement} / photo-wall groups.
 */
public class PdfConverterDocumentLink {

    private String id;
    private String fileName;
    private String ownerMemberId;
    private String ownerDisplayName;
    private Date updatedAt;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getFileName() {
        return fileName;
    }

    public void setFileName(String fileName) {
        this.fileName = fileName;
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

    public Date getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(Date updatedAt) {
        this.updatedAt = updatedAt;
    }
}
