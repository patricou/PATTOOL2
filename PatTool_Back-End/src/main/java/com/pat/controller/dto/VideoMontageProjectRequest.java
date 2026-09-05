package com.pat.controller.dto;

import com.pat.repo.domain.VideoMontageClip;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.ArrayList;
import java.util.List;

/**
 * Payload for {@code POST/PUT /api/video-montage/projects}. Owner comes from {@code user-id}.
 */
public class VideoMontageProjectRequest {

    @NotBlank
    @Size(max = 180)
    private String title;

    private String evenementId;

    private List<VideoMontageClip> clips = new ArrayList<>();

    private Integer width;

    private Integer height;

    private Double photoDefaultDurationSec;

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getEvenementId() {
        return evenementId;
    }

    public void setEvenementId(String evenementId) {
        this.evenementId = evenementId;
    }

    public List<VideoMontageClip> getClips() {
        return clips;
    }

    public void setClips(List<VideoMontageClip> clips) {
        this.clips = clips != null ? clips : new ArrayList<>();
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

    public Double getPhotoDefaultDurationSec() {
        return photoDefaultDurationSec;
    }

    public void setPhotoDefaultDurationSec(Double photoDefaultDurationSec) {
        this.photoDefaultDurationSec = photoDefaultDurationSec;
    }
}
