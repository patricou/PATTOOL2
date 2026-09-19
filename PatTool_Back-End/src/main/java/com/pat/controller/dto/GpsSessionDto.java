package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * GPS follow session payload (create / sync / response).
 */
public class GpsSessionDto {

    private String id;
    private String ownerMemberId;
    private String ownerUsername;
    private String clientSessionId;
    private String title;
    private String sourceType;
    private String sourceFileId;
    private String sourceFileName;
    private List<String> linkedActivityIds;
    private List<GpsLinkedActivityDto> linkedActivities;
    private String status;
    private List<double[]> plannedTrack = new ArrayList<>();
    private Double plannedDistanceM;
    private Double plannedAscentM;
    private Double plannedDescentM;
    private List<GpsRecordedPointDto> recordedPoints = new ArrayList<>();
    private Integer recordedPointCount;
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

    public List<String> getLinkedActivityIds() {
        return linkedActivityIds;
    }

    public void setLinkedActivityIds(List<String> linkedActivityIds) {
        this.linkedActivityIds = linkedActivityIds;
    }

    public List<GpsLinkedActivityDto> getLinkedActivities() {
        return linkedActivities;
    }

    public void setLinkedActivities(List<GpsLinkedActivityDto> linkedActivities) {
        this.linkedActivities = linkedActivities;
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

    public List<GpsRecordedPointDto> getRecordedPoints() {
        return recordedPoints;
    }

    public void setRecordedPoints(List<GpsRecordedPointDto> recordedPoints) {
        this.recordedPoints = recordedPoints != null ? recordedPoints : new ArrayList<>();
    }

    public Integer getRecordedPointCount() {
        return recordedPointCount;
    }

    public void setRecordedPointCount(Integer recordedPointCount) {
        this.recordedPointCount = recordedPointCount;
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
