package com.pat.repo.domain;

import jakarta.validation.constraints.NotBlank;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.Transient;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.Date;

/**
 * OpenDocument Spreadsheet (.ods) owned by a {@link Member}. Content is stored as Base64-encoded
 * ODS bytes so formatting is preserved on save and reload.
 */
@Document(collection = "ods_editor_documents")
public class OdsEditorDocument {

    @Id
    private String id;

    @NotBlank
    private String ownerMemberId;

    /** File name without extension. */
    @NotBlank
    private String fileName;

    /** Base64-encoded .ods file bytes. */
    private String odsContentBase64;

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

    public String getOdsContentBase64() {
        return odsContentBase64;
    }

    public void setOdsContentBase64(String odsContentBase64) {
        this.odsContentBase64 = odsContentBase64;
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
