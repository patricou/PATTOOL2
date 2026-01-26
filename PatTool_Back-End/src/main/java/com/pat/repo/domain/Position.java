package com.pat.repo.domain;

import java.util.Date;

/**
 * Represents a user position with coordinates, type, and timestamp
 * Coordinates are stored as Double (64-bit floating point) for maximum precision
 * This provides approximately 15-17 significant digits, which is sufficient for GPS coordinates
 * (GPS coordinates typically need 6-7 decimal places for meter-level accuracy)
 */
public class Position {
    private Date datetime;
    private String type; // "GPS" or "IP"
    private Double latitude;  // Double precision (64-bit) preserves full GPS accuracy
    private Double longitude; // Double precision (64-bit) preserves full GPS accuracy

    public Position() {
    }

    public Position(Date datetime, String type, Double latitude, Double longitude) {
        this.datetime = datetime;
        this.type = type;
        this.latitude = latitude;
        this.longitude = longitude;
    }

    public Date getDatetime() {
        return datetime;
    }

    public void setDatetime(Date datetime) {
        this.datetime = datetime;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public Double getLatitude() {
        return latitude;
    }

    public void setLatitude(Double latitude) {
        this.latitude = latitude;
    }

    public Double getLongitude() {
        return longitude;
    }

    public void setLongitude(Double longitude) {
        this.longitude = longitude;
    }
}
