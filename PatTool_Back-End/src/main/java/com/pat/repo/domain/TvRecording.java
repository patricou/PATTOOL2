package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.List;

/**
 * On-demand TV stream recording metadata. Binary is stored in GridFS ({@link #gridFsFileId}).
 * Sharing uses the same visibility contract as activities / calendar / to-do lists.
 */
@Document(collection = "tv_recordings")
public class TvRecording {

    public enum Status {
        PENDING,
        RUNNING,
        DONE,
        FAILED,
        CANCELLED
    }

    @Id
    private String id;

    /** JWT subject of the owner. */
    @Indexed
    private String ownerSub;

    /** PatTool member id of the owner (for friends / friend-group visibility). */
    @Indexed
    private String ownerMemberId;

    private String channelId;
    private String channelName;
    private String channelLogo;
    private String country;
    private String streamUrl;

    private Status status = Status.PENDING;

    private Instant startedAt;
    private Instant endedAt;

    /** Requested max duration in seconds. */
    private int durationSec;

    /** Actual recorded duration when known (seconds). */
    private Integer actualDurationSec;

    private String gridFsFileId;
    private String contentType;
    private String fileName;
    private Long byteLength;
    private String error;

    /**
     * Same values as {@link Evenement#getVisibility()}: {@code public}, {@code private}, {@code friends},
     * {@code friendGroups}, or a friend group display name (legacy).
     * Default: private (owner only).
     */
    private String visibility = "private";

    /** Friend group id when visibility targets a specific group (legacy / single group). */
    private String friendGroupId;

    /** When visibility is {@code friendGroups}, ids of groups that may see the recording. */
    private List<String> friendGroupIds;

    public TvRecording() {
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getOwnerSub() {
        return ownerSub;
    }

    public void setOwnerSub(String ownerSub) {
        this.ownerSub = ownerSub;
    }

    public String getOwnerMemberId() {
        return ownerMemberId;
    }

    public void setOwnerMemberId(String ownerMemberId) {
        this.ownerMemberId = ownerMemberId;
    }

    public String getChannelId() {
        return channelId;
    }

    public void setChannelId(String channelId) {
        this.channelId = channelId;
    }

    public String getChannelName() {
        return channelName;
    }

    public void setChannelName(String channelName) {
        this.channelName = channelName;
    }

    public String getChannelLogo() {
        return channelLogo;
    }

    public void setChannelLogo(String channelLogo) {
        this.channelLogo = channelLogo;
    }

    public String getCountry() {
        return country;
    }

    public void setCountry(String country) {
        this.country = country;
    }

    public String getStreamUrl() {
        return streamUrl;
    }

    public void setStreamUrl(String streamUrl) {
        this.streamUrl = streamUrl;
    }

    public Status getStatus() {
        return status;
    }

    public void setStatus(Status status) {
        this.status = status;
    }

    public Instant getStartedAt() {
        return startedAt;
    }

    public void setStartedAt(Instant startedAt) {
        this.startedAt = startedAt;
    }

    public Instant getEndedAt() {
        return endedAt;
    }

    public void setEndedAt(Instant endedAt) {
        this.endedAt = endedAt;
    }

    public int getDurationSec() {
        return durationSec;
    }

    public void setDurationSec(int durationSec) {
        this.durationSec = durationSec;
    }

    public Integer getActualDurationSec() {
        return actualDurationSec;
    }

    public void setActualDurationSec(Integer actualDurationSec) {
        this.actualDurationSec = actualDurationSec;
    }

    public String getGridFsFileId() {
        return gridFsFileId;
    }

    public void setGridFsFileId(String gridFsFileId) {
        this.gridFsFileId = gridFsFileId;
    }

    public String getContentType() {
        return contentType;
    }

    public void setContentType(String contentType) {
        this.contentType = contentType;
    }

    public String getFileName() {
        return fileName;
    }

    public void setFileName(String fileName) {
        this.fileName = fileName;
    }

    public Long getByteLength() {
        return byteLength;
    }

    public void setByteLength(Long byteLength) {
        this.byteLength = byteLength;
    }

    public String getError() {
        return error;
    }

    public void setError(String error) {
        this.error = error;
    }

    public String getVisibility() {
        return visibility;
    }

    public void setVisibility(String visibility) {
        this.visibility = visibility;
    }

    public String getFriendGroupId() {
        return friendGroupId;
    }

    public void setFriendGroupId(String friendGroupId) {
        this.friendGroupId = friendGroupId;
    }

    public List<String> getFriendGroupIds() {
        return friendGroupIds;
    }

    public void setFriendGroupIds(List<String> friendGroupIds) {
        this.friendGroupIds = friendGroupIds;
    }
}
