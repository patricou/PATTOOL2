package com.pat.repo.domain;

/**
 * One GPS sample recorded while following a track (hiking / cycling GPS page).
 */
public class GpsRecordedPoint {

    /** Client-generated id for idempotent offline sync. */
    private String clientPointId;

    private double lat;
    private double lon;
    /** Metres (GPS / barometer / DEM). */
    private Double eleM;
    private Long timeMs;
    private Double speedKmh;
    private Double accuracyM;
    private Double slopePct;

    public String getClientPointId() {
        return clientPointId;
    }

    public void setClientPointId(String clientPointId) {
        this.clientPointId = clientPointId;
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

    public Double getEleM() {
        return eleM;
    }

    public void setEleM(Double eleM) {
        this.eleM = eleM;
    }

    public Long getTimeMs() {
        return timeMs;
    }

    public void setTimeMs(Long timeMs) {
        this.timeMs = timeMs;
    }

    public Double getSpeedKmh() {
        return speedKmh;
    }

    public void setSpeedKmh(Double speedKmh) {
        this.speedKmh = speedKmh;
    }

    public Double getAccuracyM() {
        return accuracyM;
    }

    public void setAccuracyM(Double accuracyM) {
        this.accuracyM = accuracyM;
    }

    public Double getSlopePct() {
        return slopePct;
    }

    public void setSlopePct(Double slopePct) {
        this.slopePct = slopePct;
    }
}
