package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * Saved GPS itinerary (OpenRoute) owned by a member and optionally shared with friends.
 */
@Document(collection = "gps_itineraries")
public class GpsItinerary {

    @Id
    private String id;

    @Indexed
    private String ownerMemberId;

    private String ownerUsername;

    /** OpenRoute profile: driving-car, cycling-regular, foot-walking. */
    private String profile;

    private GpsPlacePoint from;
    private GpsPlacePoint to;

    private Double distanceMeters;
    private Double durationSeconds;
    private Double ascentMeters;
    private Double descentMeters;

    /** Route geometry as [lat, lon] or [lat, lon, ele]. */
    private List<double[]> coordinates = new ArrayList<>();

    @Indexed
    private List<String> sharedWithMemberIds = new ArrayList<>();

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

    public String getProfile() {
        return profile;
    }

    public void setProfile(String profile) {
        this.profile = profile;
    }

    public GpsPlacePoint getFrom() {
        return from;
    }

    public void setFrom(GpsPlacePoint from) {
        this.from = from;
    }

    public GpsPlacePoint getTo() {
        return to;
    }

    public void setTo(GpsPlacePoint to) {
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
