package com.pat.repo.domain;

import jakarta.validation.constraints.NotBlank;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.Transient;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * Saved video-montage timeline owned by a {@link Member}.
 */
@Document(collection = "video_montage_projects")
public class VideoMontageProject {

    @Id
    private String id;

    @NotBlank
    private String ownerMemberId;

    @NotBlank
    private String title;

    /** Optional activity to attach the exported MP4 to. */
    private String evenementId;

    private List<VideoMontageClip> clips = new ArrayList<>();

    private Integer width;

    private Integer height;

    private Double photoDefaultDurationSec;

    /** Last successful export in GridFS. */
    private String outputGridFsFileId;

    private String outputFileName;

    private Long outputByteLength;

    private Date createdAt;

    private Date updatedAt;

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

    public String getOutputGridFsFileId() {
        return outputGridFsFileId;
    }

    public void setOutputGridFsFileId(String outputGridFsFileId) {
        this.outputGridFsFileId = outputGridFsFileId;
    }

    public String getOutputFileName() {
        return outputFileName;
    }

    public void setOutputFileName(String outputFileName) {
        this.outputFileName = outputFileName;
    }

    public Long getOutputByteLength() {
        return outputByteLength;
    }

    public void setOutputByteLength(Long outputByteLength) {
        this.outputByteLength = outputByteLength;
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
