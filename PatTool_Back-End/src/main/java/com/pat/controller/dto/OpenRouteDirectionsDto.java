package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Normalized OpenRouteService directions response for the PatTool GPS page.
 * Coordinates are {@code [lat, lon]} or {@code [lat, lon, elevation]} for Leaflet convenience.
 */
public class OpenRouteDirectionsDto {

    private String profile;
    private Double distanceMeters;
    private Double durationSeconds;
    private Double ascentMeters;
    private Double descentMeters;
    private Double avgSpeedKmh;
    private Double elevationStartMeters;
    private Double elevationEndMeters;
    private Double elevationMinMeters;
    private Double elevationMaxMeters;
    private Integer pointCount;
    private Integer segmentCount;
    private Integer stepCount;
    private List<Double> bbox = new ArrayList<>();
    private List<String> warnings = new ArrayList<>();
    private List<OpenRouteExtraGroupDto> extras = new ArrayList<>();
    private List<double[]> coordinates = new ArrayList<>();
    private List<OpenRouteStepDto> steps = new ArrayList<>();
    private String attribution;
    private String service;
    private String engineVersion;
    private String engineBuildDate;
    private String graphDate;
    private Long timestamp;
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

    public Double getAvgSpeedKmh() {
        return avgSpeedKmh;
    }

    public void setAvgSpeedKmh(Double avgSpeedKmh) {
        this.avgSpeedKmh = avgSpeedKmh;
    }

    public Double getElevationStartMeters() {
        return elevationStartMeters;
    }

    public void setElevationStartMeters(Double elevationStartMeters) {
        this.elevationStartMeters = elevationStartMeters;
    }

    public Double getElevationEndMeters() {
        return elevationEndMeters;
    }

    public void setElevationEndMeters(Double elevationEndMeters) {
        this.elevationEndMeters = elevationEndMeters;
    }

    public Double getElevationMinMeters() {
        return elevationMinMeters;
    }

    public void setElevationMinMeters(Double elevationMinMeters) {
        this.elevationMinMeters = elevationMinMeters;
    }

    public Double getElevationMaxMeters() {
        return elevationMaxMeters;
    }

    public void setElevationMaxMeters(Double elevationMaxMeters) {
        this.elevationMaxMeters = elevationMaxMeters;
    }

    public Integer getPointCount() {
        return pointCount;
    }

    public void setPointCount(Integer pointCount) {
        this.pointCount = pointCount;
    }

    public Integer getSegmentCount() {
        return segmentCount;
    }

    public void setSegmentCount(Integer segmentCount) {
        this.segmentCount = segmentCount;
    }

    public Integer getStepCount() {
        return stepCount;
    }

    public void setStepCount(Integer stepCount) {
        this.stepCount = stepCount;
    }

    public List<Double> getBbox() {
        return bbox;
    }

    public void setBbox(List<Double> bbox) {
        this.bbox = bbox != null ? bbox : new ArrayList<>();
    }

    public List<String> getWarnings() {
        return warnings;
    }

    public void setWarnings(List<String> warnings) {
        this.warnings = warnings != null ? warnings : new ArrayList<>();
    }

    public List<OpenRouteExtraGroupDto> getExtras() {
        return extras;
    }

    public void setExtras(List<OpenRouteExtraGroupDto> extras) {
        this.extras = extras != null ? extras : new ArrayList<>();
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

    public String getService() {
        return service;
    }

    public void setService(String service) {
        this.service = service;
    }

    public String getEngineVersion() {
        return engineVersion;
    }

    public void setEngineVersion(String engineVersion) {
        this.engineVersion = engineVersion;
    }

    public String getEngineBuildDate() {
        return engineBuildDate;
    }

    public void setEngineBuildDate(String engineBuildDate) {
        this.engineBuildDate = engineBuildDate;
    }

    public String getGraphDate() {
        return graphDate;
    }

    public void setGraphDate(String graphDate) {
        this.graphDate = graphDate;
    }

    public Long getTimestamp() {
        return timestamp;
    }

    public void setTimestamp(Long timestamp) {
        this.timestamp = timestamp;
    }

    public boolean isConfigured() {
        return configured;
    }

    public void setConfigured(boolean configured) {
        this.configured = configured;
    }
}
