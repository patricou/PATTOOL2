package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Une pose du calibrage Direction (caméra arrière) : tous les capteurs bruts.
 * Sert ensuite à déduire les formules d’attitude, pas à stocker un simple offset.
 */
@Document(collection = "direction_pattool_samples")
public class DirectionPattoolSample {

    @Id
    private String id;

    @Indexed
    private String ownerSubject;

    /** Surnom Member ({@code userName}), clé d’affichage et de lecture. */
    @Indexed
    private String ownerUsername;

    @Indexed
    private String sessionId;

    private String poseId;
    private Integer poseIndex;
    private Double expectedAz;
    private Double expectedEl;
    private String capturedAt;
    private String userAgent;

    /** Quaternion AbsoluteOrientationSensor [x, y, z, w]. */
    private List<Double> quat = new ArrayList<>();

    private Map<String, Object> mag = new LinkedHashMap<>();
    private Map<String, Object> accel = new LinkedHashMap<>();
    private Map<String, Object> gyro = new LinkedHashMap<>();
    private Map<String, Object> orient = new LinkedHashMap<>();
    private Integer screenAngle;
    private Map<String, Object> gps = new LinkedHashMap<>();
    private Map<String, Object> computed = new LinkedHashMap<>();
    private Map<String, Object> extras = new LinkedHashMap<>();

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getOwnerSubject() {
        return ownerSubject;
    }

    public void setOwnerSubject(String ownerSubject) {
        this.ownerSubject = ownerSubject;
    }

    public String getOwnerUsername() {
        return ownerUsername;
    }

    public void setOwnerUsername(String ownerUsername) {
        this.ownerUsername = ownerUsername;
    }

    public String getSessionId() {
        return sessionId;
    }

    public void setSessionId(String sessionId) {
        this.sessionId = sessionId;
    }

    public String getPoseId() {
        return poseId;
    }

    public void setPoseId(String poseId) {
        this.poseId = poseId;
    }

    public Integer getPoseIndex() {
        return poseIndex;
    }

    public void setPoseIndex(Integer poseIndex) {
        this.poseIndex = poseIndex;
    }

    public Double getExpectedAz() {
        return expectedAz;
    }

    public void setExpectedAz(Double expectedAz) {
        this.expectedAz = expectedAz;
    }

    public Double getExpectedEl() {
        return expectedEl;
    }

    public void setExpectedEl(Double expectedEl) {
        this.expectedEl = expectedEl;
    }

    public String getCapturedAt() {
        return capturedAt;
    }

    public void setCapturedAt(String capturedAt) {
        this.capturedAt = capturedAt;
    }

    public String getUserAgent() {
        return userAgent;
    }

    public void setUserAgent(String userAgent) {
        this.userAgent = userAgent;
    }

    public List<Double> getQuat() {
        return quat;
    }

    public void setQuat(List<Double> quat) {
        this.quat = quat != null ? quat : new ArrayList<>();
    }

    public Map<String, Object> getMag() {
        return mag;
    }

    public void setMag(Map<String, Object> mag) {
        this.mag = mag != null ? mag : new LinkedHashMap<>();
    }

    public Map<String, Object> getAccel() {
        return accel;
    }

    public void setAccel(Map<String, Object> accel) {
        this.accel = accel != null ? accel : new LinkedHashMap<>();
    }

    public Map<String, Object> getGyro() {
        return gyro;
    }

    public void setGyro(Map<String, Object> gyro) {
        this.gyro = gyro != null ? gyro : new LinkedHashMap<>();
    }

    public Map<String, Object> getOrient() {
        return orient;
    }

    public void setOrient(Map<String, Object> orient) {
        this.orient = orient != null ? orient : new LinkedHashMap<>();
    }

    public Integer getScreenAngle() {
        return screenAngle;
    }

    public void setScreenAngle(Integer screenAngle) {
        this.screenAngle = screenAngle;
    }

    public Map<String, Object> getGps() {
        return gps;
    }

    public void setGps(Map<String, Object> gps) {
        this.gps = gps != null ? gps : new LinkedHashMap<>();
    }

    public Map<String, Object> getComputed() {
        return computed;
    }

    public void setComputed(Map<String, Object> computed) {
        this.computed = computed != null ? computed : new LinkedHashMap<>();
    }

    public Map<String, Object> getExtras() {
        return extras;
    }

    public void setExtras(Map<String, Object> extras) {
        this.extras = extras != null ? extras : new LinkedHashMap<>();
    }
}
