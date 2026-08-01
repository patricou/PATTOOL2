package com.pat.controller.dto;

/**
 * Per-user GPS map follow preference ({@code followUser} recenters every 5s).
 */
public class GpsFollowPreferenceDto {

    /** When true, 2D/3D maps recenter on the user position every 5 seconds. Default false. */
    private boolean followUser = false;

    public GpsFollowPreferenceDto() {
    }

    public GpsFollowPreferenceDto(boolean followUser) {
        this.followUser = followUser;
    }

    public boolean isFollowUser() {
        return followUser;
    }

    public void setFollowUser(boolean followUser) {
        this.followUser = followUser;
    }
}
