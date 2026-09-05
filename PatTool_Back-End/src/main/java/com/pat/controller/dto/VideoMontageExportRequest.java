package com.pat.controller.dto;

import com.pat.repo.domain.VideoMontageClip;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;

import java.util.ArrayList;
import java.util.List;

/**
 * Render a montage with FFmpeg from accessible activity media and TV recordings.
 */
public class VideoMontageExportRequest {

    @Size(max = 180)
    private String title;

    /** Optional existing project to update with the output file id. */
    private String projectId;

    /** If set and {@link #attachToEvent} is true, the MP4 is added to this activity. */
    private String evenementId;

    private boolean attachToEvent;

    private Integer width;

    private Integer height;

    @Valid
    @NotEmpty
    private List<VideoMontageClip> clips = new ArrayList<>();

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getProjectId() {
        return projectId;
    }

    public void setProjectId(String projectId) {
        this.projectId = projectId;
    }

    public String getEvenementId() {
        return evenementId;
    }

    public void setEvenementId(String evenementId) {
        this.evenementId = evenementId;
    }

    public boolean isAttachToEvent() {
        return attachToEvent;
    }

    public void setAttachToEvent(boolean attachToEvent) {
        this.attachToEvent = attachToEvent;
    }

    public Integer getWidth() {
        return width;
    }

    public void setWidth(Integer width) {
        this.width = width;
    }

    public Integer getHeight() {
        return height;
    }

    public void setHeight(Integer height) {
        this.height = height;
    }

    public List<VideoMontageClip> getClips() {
        return clips;
    }

    public void setClips(List<VideoMontageClip> clips) {
        this.clips = clips != null ? clips : new ArrayList<>();
    }
}
