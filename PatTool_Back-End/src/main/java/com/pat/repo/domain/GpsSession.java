package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * Live GPS follow session: planned track + recorded samples.
 * Synced from the frontend even after offline / background recording.
 */
@Document(collection = "gps_sessions")
@CompoundIndex(name = "owner_clientSession", def = "{'ownerMemberId': 1, 'clientSessionId': 1}", unique = true)
public class GpsSession {

    @Id
    private String id;

    @Indexed
    private String ownerMemberId;

    private String ownerUsername;

    /** Stable id generated on the device (IndexedDB) so retries stay idempotent. */
    @Indexed
    private String clientSessionId;

    private String title;

    /** import | file | session */
    private String sourceType;

    private String sourceFileId;
    private String sourceFileName;

    /** idle | recording | paused | finished */
    private String status;

    /** Planned route as [lat, lon] or [lat, lon, ele]. */
    private List<double[]> plannedTrack = new ArrayList<>();

    private Double plannedDistanceM;
    private Double plannedAscentM;
    private Double plannedDescentM;

    private List<GpsRecordedPoint> recordedPoints = new ArrayList<>();

    private Double doneM;
    private Double remainingM;
    private Double ascentDoneM;
    private Double descentDoneM;
    private Double durationSec;

    private Date startedAt;
    private Date finishedAt;
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

    public String getOwnerUsername() {
        return ownerUsername;
    }

    public void setOwnerUsername(String ownerUsername) {
        this.ownerUsername = ownerUsername;
    }

    public String getClientSessionId() {
        return clientSessionId;
    }

    public void setClientSessionId(String clientSessionId) {
        this.clientSessionId = clientSessionId;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getSourceType() {
        return sourceType;
    }

    public void setSourceType(String sourceType) {
        this.sourceType = sourceType;
    }

    public String getSourceFileId() {
        return sourceFileId;
    }

    public void setSourceFileId(String sourceFileId) {
        this.sourceFileId = sourceFileId;
    }

    public String getSourceFileName() {
        return sourceFileName;
    }

    public void setSourceFileName(String sourceFileName) {
        this.sourceFileName = sourceFileName;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public List<double[]> getPlannedTrack() {
        return plannedTrack;
    }

    public void setPlannedTrack(List<double[]> plannedTrack) {
        this.plannedTrack = plannedTrack != null ? plannedTrack : new ArrayList<>();
    }

    public Double getPlannedDistanceM() {
        return plannedDistanceM;
    }

    public void setPlannedDistanceM(Double plannedDistanceM) {
        this.plannedDistanceM = plannedDistanceM;
    }

    public Double getPlannedAscentM() {
        return plannedAscentM;
    }

    public void setPlannedAscentM(Double plannedAscentM) {
        this.plannedAscentM = plannedAscentM;
    }

    public Double getPlannedDescentM() {
        return plannedDescentM;
    }

    public void setPlannedDescentM(Double plannedDescentM) {
        this.plannedDescentM = plannedDescentM;
    }

    public List<GpsRecordedPoint> getRecordedPoints() {
        return recordedPoints;
    }

    public void setRecordedPoints(List<GpsRecordedPoint> recordedPoints) {
        this.recordedPoints = recordedPoints != null ? recordedPoints : new ArrayList<>();
    }

    public Double getDoneM() {
        return doneM;
    }

    public void setDoneM(Double doneM) {
        this.doneM = doneM;
    }

    public Double getRemainingM() {
        return remainingM;
    }

    public void setRemainingM(Double remainingM) {
        this.remainingM = remainingM;
    }

    public Double getAscentDoneM() {
        return ascentDoneM;
    }

    public void setAscentDoneM(Double ascentDoneM) {
        this.ascentDoneM = ascentDoneM;
    }

    public Double getDescentDoneM() {
        return descentDoneM;
    }

    public void setDescentDoneM(Double descentDoneM) {
        this.descentDoneM = descentDoneM;
    }

    public Double getDurationSec() {
        return durationSec;
    }

    public void setDurationSec(Double durationSec) {
        this.durationSec = durationSec;
    }

    public Date getStartedAt() {
        return startedAt;
    }

    public void setStartedAt(Date startedAt) {
        this.startedAt = startedAt;
    }

    public Date getFinishedAt() {
        return finishedAt;
    }

    public void setFinishedAt(Date finishedAt) {
        this.finishedAt = finishedAt;
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
