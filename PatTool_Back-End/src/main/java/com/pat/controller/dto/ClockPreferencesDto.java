package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.ArrayList;
import java.util.List;

/**
 * Per-user clock page: watch face, IANA time zone and daily alarms.
 * An empty {@code timeZone} means the browser zone (not stored).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class ClockPreferencesDto {

    private String faceId = "classic";
    private String timeZone = "";
    /** Filled by the server from the account. Ignored when sent by the client. */
    private String notifyEmail = "";
    private List<ClockAlarmDto> alarms = new ArrayList<>();
    /** 100 is the designed look. Null means the client did not send a value. */
    private Integer contrast;
    private Integer brightness;
    private Integer reflection;
    private Integer intensity;
    private Integer brilliance;
    private Integer glare;

    public String getFaceId() {
        return faceId;
    }

    public void setFaceId(String faceId) {
        this.faceId = faceId;
    }

    public String getTimeZone() {
        return timeZone;
    }

    public void setTimeZone(String timeZone) {
        this.timeZone = timeZone;
    }

    public String getNotifyEmail() {
        return notifyEmail;
    }

    public void setNotifyEmail(String notifyEmail) {
        this.notifyEmail = notifyEmail;
    }

    public List<ClockAlarmDto> getAlarms() {
        return alarms;
    }

    public void setAlarms(List<ClockAlarmDto> alarms) {
        this.alarms = alarms;
    }

    public Integer getContrast() {
        return contrast;
    }

    public void setContrast(Integer contrast) {
        this.contrast = contrast;
    }

    public Integer getBrightness() {
        return brightness;
    }

    public void setBrightness(Integer brightness) {
        this.brightness = brightness;
    }

    public Integer getReflection() {
        return reflection;
    }

    public void setReflection(Integer reflection) {
        this.reflection = reflection;
    }

    public Integer getIntensity() {
        return intensity;
    }

    public void setIntensity(Integer intensity) {
        this.intensity = intensity;
    }

    public Integer getBrilliance() {
        return brilliance;
    }

    public void setBrilliance(Integer brilliance) {
        this.brilliance = brilliance;
    }

    public Integer getGlare() {
        return glare;
    }

    public void setGlare(Integer glare) {
        this.glare = glare;
    }
}
