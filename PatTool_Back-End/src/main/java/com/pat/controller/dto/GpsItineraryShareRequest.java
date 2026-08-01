package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/** Body for POST /api/gps-itineraries/{id}/share */
public class GpsItineraryShareRequest {

    private List<String> memberIds = new ArrayList<>();

    public List<String> getMemberIds() {
        return memberIds;
    }

    public void setMemberIds(List<String> memberIds) {
        this.memberIds = memberIds != null ? memberIds : new ArrayList<>();
    }
}
