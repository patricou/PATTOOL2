package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Normalized OpenRouteService directions response for the PatTool GPS page.
 * Coordinates are {@code [lat, lon]} for Leaflet convenience.
 */
public class OpenRouteDirectionsDto {

    private String profile;
    private Double distanceMeters;
    private Double durationSeconds;
    private List<double[]> coordinates = new ArrayList<>();
    private List<OpenRouteStepDto> steps = new ArrayList<>();
    private String attribution;
    private boolean configured;

    public String getProfile() {
        return profile;
    }

    public void setProfile(String profile) {
        this.profile = profile;
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

    public List<double[]> getCoordinates() {
        return coordinates;
    }

    public void setCoordinates(List<double[]> coordinates) {
        this.coordinates = coordinates != null ? coordinates : new ArrayList<>();
    }

    public List<OpenRouteStepDto> getSteps() {
        return steps;
    }

    public void setSteps(List<OpenRouteStepDto> steps) {
        this.steps = steps != null ? steps : new ArrayList<>();
    }

    public String getAttribution() {
        return attribution;
    }

    public void setAttribution(String attribution) {
        this.attribution = attribution;
    }

    public boolean isConfigured() {
        return configured;
    }

    public void setConfigured(boolean configured) {
        this.configured = configured;
    }
}
