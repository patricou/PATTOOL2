package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

/**
 * One recorded ISS sub-point sample (latitude / longitude + UTC timestamp).
 */
@Document(collection = "iss_trace_points")
public class IssTracePoint {

    @Id
    private String id;

    private Double latitude;
    private Double longitude;
    private Instant recordedAt;

    public IssTracePoint() {
    }

    public IssTracePoint(Double latitude, Double longitude, Instant recordedAt) {
        this.latitude = latitude;
        this.longitude = longitude;
        this.recordedAt = recordedAt != null ? recordedAt : Instant.now();
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
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

    public Instant getRecordedAt() {
        return recordedAt;
    }

    public void setRecordedAt(Instant recordedAt) {
        this.recordedAt = recordedAt;
    }
}
