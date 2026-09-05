package com.pat.controller.dto;

public class VideoMontageExportResponse {

    private String fileId;
    private String fileName;
    private String mediaUrl;
    private long byteLength;
    private String evenementId;
    private boolean attachedToEvent;
    private String projectId;

    public String getFileId() {
        return fileId;
    }

    public void setFileId(String fileId) {
        this.fileId = fileId;
    }

    public String getFileName() {
        return fileName;
    }

    public void setFileName(String fileName) {
        this.fileName = fileName;
    }

    public String getMediaUrl() {
        return mediaUrl;
    }

    public void setMediaUrl(String mediaUrl) {
        this.mediaUrl = mediaUrl;
    }

    public long getByteLength() {
        return byteLength;
    }

    public void setByteLength(long byteLength) {
        this.byteLength = byteLength;
    }

    public String getEvenementId() {
        return evenementId;
    }

    public void setEvenementId(String evenementId) {
        this.evenementId = evenementId;
    }

    public boolean isAttachedToEvent() {
        return attachedToEvent;
    }

    public void setAttachedToEvent(boolean attachedToEvent) {
        this.attachedToEvent = attachedToEvent;
    }

    public String getProjectId() {
        return projectId;
    }

    public void setProjectId(String projectId) {
        this.projectId = projectId;
    }
}
