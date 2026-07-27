package com.pat.controller.dto;

import java.util.List;

/**
 * Update request for a saved TV recording (display name and/or sharing).
 */
public class TvRecordingRenameRequest {

    private String channelName;
    private String visibility;
    private String friendGroupId;
    private List<String> friendGroupIds;

    public TvRecordingRenameRequest() {
    }

    public String getChannelName() {
        return channelName;
    }

    public void setChannelName(String channelName) {
        this.channelName = channelName;
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
