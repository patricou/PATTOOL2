package com.pat.repo.domain;

/**
 * Named place used as GPS route start, intermediate stop, or end.
 */
public class GpsPlacePoint {

    private double lat;
    private double lon;
    private String label;

    public GpsPlacePoint() {
    }

    public GpsPlacePoint(double lat, double lon, String label) {
        this.lat = lat;
        this.lon = lon;
        this.label = label;
    }

    public double getLat() {
        return lat;
    }

    public void setLat(double lat) {
        this.lat = lat;
    }

    public double getLon() {
        return lon;
    }

    public void setLon(double lon) {
        this.lon = lon;
    }

    public String getLabel() {
        return label;
    }

    public void setLabel(String label) {
        this.label = label;
    }
}
