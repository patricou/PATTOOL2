package com.pat.controller.dto;

import java.util.List;

/**
 * Preview visibility recipients for a new appointment (no id yet). Same fields as sharing on save.
 */
public class CalendarVisibilityPreviewRequest {

    private String visibility;
    private String friendGroupId;
    private List<String> friendGroupIds;

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
