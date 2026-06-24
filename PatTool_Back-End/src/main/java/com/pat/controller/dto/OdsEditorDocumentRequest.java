package com.pat.controller.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Payload for {@code POST/PUT /api/ods-editor/documents}. Owner is always derived from the
 * authenticated member id header, never from the body.
 */
public class OdsEditorDocumentRequest {

    @NotBlank
    @Size(max = 180)
    private String fileName;

    /** Base64-encoded .ods file bytes. */
    @NotBlank
    @Size(max = 15_000_000)
    private String odsContentBase64;

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
}
