package com.pat.controller.dto;

/**
 * Rename request for a saved TV recording (display name).
 */
public class TvRecordingRenameRequest {

    private String channelName;

    public TvRecordingRenameRequest() {
    }

    public String getChannelName() {
        return channelName;
    }

    public void setChannelName(String channelName) {
        this.channelName = channelName;
    }
}
