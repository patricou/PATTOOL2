package com.pat.repo.domain;

/**
 * One timeline item in a {@link VideoMontageProject}.
 */
public class VideoMontageClip {

    /** {@code photo} | {@code video} | {@code recording} */
    private String kind;

    /** GridFS id of the source photo or video. */
    private String fileId;

    /** Activity that owns {@link #fileId} when kind is photo/video. */
    private String evenementId;

    /** TV/YouTube recording id when kind is recording. */
    private String recordingId;

    private String fileName;

    private String fileType;

    private String title;

    /** Clip length in the montage (seconds). */
    private Double durationSec;

    /** Trim start for videos (seconds from source start). Photos ignore this. */
    private Double startSec;

    public String getKind() {
        return kind;
    }

    public void setKind(String kind) {
        this.kind = kind;
    }

    public String getFileId() {
        return fileId;
    }

    public void setFileId(String fileId) {
        this.fileId = fileId;
    }

    public String getEvenementId() {
        return evenementId;
    }

    public void setEvenementId(String evenementId) {
        this.evenementId = evenementId;
    }

    public String getRecordingId() {
        return recordingId;
    }

    public void setRecordingId(String recordingId) {
        this.recordingId = recordingId;
    }

    public String getFileName() {
        return fileName;
    }

    public void setFileName(String fileName) {
        this.fileName = fileName;
    }

    public String getFileType() {
        return fileType;
    }

    public void setFileType(String fileType) {
        this.fileType = fileType;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public Double getDurationSec() {
        return durationSec;
    }

    public void setDurationSec(Double durationSec) {
        this.durationSec = durationSec;
    }

    public Double getStartSec() {
        return startSec;
    }

    public void setStartSec(Double startSec) {
        this.startSec = startSec;
    }
}
