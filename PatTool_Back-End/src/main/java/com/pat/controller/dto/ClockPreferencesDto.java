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
}
