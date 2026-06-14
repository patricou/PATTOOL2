package com.pat.repo.domain;

import jakarta.validation.constraints.NotBlank;
import org.springframework.data.annotation.Id;
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

    private Date createdAt;

    private Date updatedAt;

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
}
