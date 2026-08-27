package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * Create / update payload and response for GPS itineraries.
 */
public class GpsItineraryDto {

    private String id;
    private String ownerMemberId;
    private String ownerUsername;
    private String profile;
    private GpsPlacePointDto from;
    private List<GpsPlacePointDto> vias = new ArrayList<>();
    private GpsPlacePointDto to;
    private Double distanceMeters;
    private Double durationSeconds;
    private Double ascentMeters;
    private Double descentMeters;
    private List<double[]> coordinates = new ArrayList<>();
    private List<String> sharedWithMemberIds = new ArrayList<>();
    /** Resolved usernames for shared members (response only). */
    private List<String> sharedWithUsernames = new ArrayList<>();
    private Date createdAt;
    private Date updatedAt;
    /** True when the current user is a share recipient (not owner). */
    private boolean sharedWithMe;

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

    public String getProfile() {
        return profile;
    }

    public void setProfile(String profile) {
        this.profile = profile;
    }

    public GpsPlacePointDto getFrom() {
        return from;
    }

    public void setFrom(GpsPlacePointDto from) {
        this.from = from;
    }

    public List<GpsPlacePointDto> getVias() {
        return vias;
    }

    public void setVias(List<GpsPlacePointDto> vias) {
        this.vias = vias != null ? vias : new ArrayList<>();
    }

    public GpsPlacePointDto getTo() {
        return to;
    }

    public void setTo(GpsPlacePointDto to) {
        this.to = to;
    }

    public Double getDistanceMeters() {
        return distanceMeters;
    }

    public void setDistanceMeters(Double distanceMeters) {
        this.distanceMeters = distanceMeters;
    }

    public Double getDurationSeconds() {
        return durationSeconds;
    }

    public void setDurationSeconds(Double durationSeconds) {
        this.durationSeconds = durationSeconds;
    }

    public Double getAscentMeters() {
        return ascentMeters;
    }

    public void setAscentMeters(Double ascentMeters) {
        this.ascentMeters = ascentMeters;
    }

    public Double getDescentMeters() {
        return descentMeters;
    }

    public void setDescentMeters(Double descentMeters) {
        this.descentMeters = descentMeters;
    }

    public List<double[]> getCoordinates() {
        return coordinates;
    }

    public void setCoordinates(List<double[]> coordinates) {
        this.coordinates = coordinates != null ? coordinates : new ArrayList<>();
    }

    public List<String> getSharedWithMemberIds() {
        return sharedWithMemberIds;
    }

    public void setSharedWithMemberIds(List<String> sharedWithMemberIds) {
        this.sharedWithMemberIds = sharedWithMemberIds != null ? sharedWithMemberIds : new ArrayList<>();
    }

    public List<String> getSharedWithUsernames() {
        return sharedWithUsernames;
    }

    public void setSharedWithUsernames(List<String> sharedWithUsernames) {
        this.sharedWithUsernames = sharedWithUsernames != null ? sharedWithUsernames : new ArrayList<>();
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

    public boolean isSharedWithMe() {
        return sharedWithMe;
    }

    public void setSharedWithMe(boolean sharedWithMe) {
        this.sharedWithMe = sharedWithMe;
    }
}
