package com.pat.controller.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Payload for {@code POST/PUT /api/pdf-converter/documents}. Owner is always derived from the
 * authenticated member id header, never from the body.
 */
public class PdfConverterDocumentRequest {

    @NotBlank
    @Size(max = 180)
    private String fileName;

    /** Quill HTML; may contain inline {@code data:image/...} sources. */
    @Size(max = 5_000_000)
    private String htmlContent;

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
}
