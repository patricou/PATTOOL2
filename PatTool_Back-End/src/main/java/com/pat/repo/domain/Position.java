package com.pat.repo.domain;

import java.util.Date;

/**
 * Represents a user position with coordinates, type, and timestamp
 * Coordinates are stored as Double (64-bit) with full precision
 * When merging consecutive same-address positions, dateFrom = first time at that address, dateTo = last update
 */
public class Position {
    private Date datetime;   // legacy / same as dateTo for new data
    private Date dateFrom;    // start of stay at this address (when merged with previous same-address)
    private Date dateTo;      // end / last update at this address
    private String type; // "GPS" or "IP"
    private Double latitude;
    private Double longitude;

    public Position() {
    }

    public Position(Date datetime, String type, Double latitude, Double longitude) {
        this.datetime = datetime;
        this.dateFrom = datetime;
        this.dateTo = datetime;
        this.type = type;
        this.latitude = latitude;
        this.longitude = longitude;
    }

    /** Create position with explicit date range (e.g. when merging with previous same-address) */
    public Position(Date dateFrom, Date dateTo, String type, Double latitude, Double longitude) {
        this.datetime = dateTo;
        this.dateFrom = dateFrom;
        this.dateTo = dateTo;
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

    public Date getDateFrom() {
        return dateFrom;
    }

    public void setDateFrom(Date dateFrom) {
        this.dateFrom = dateFrom;
    }

    public Date getDateTo() {
        return dateTo;
    }

    public void setDateTo(Date dateTo) {
        this.dateTo = dateTo;
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
