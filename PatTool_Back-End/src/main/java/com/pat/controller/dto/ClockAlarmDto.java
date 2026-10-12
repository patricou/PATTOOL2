package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Daily alarm stored with the per-user clock preferences.
 * {@code channel} is {@code ring} (browser chime) or {@code email}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class ClockAlarmDto {

    private String id = "";
    private int hour;
    private int minute;
    private String label = "";
    private String channel = "ring";
    private boolean enabled = true;
    /** Local calendar day ({@code yyyy-MM-dd}) of the last fire, in the user's zone. */
    private String lastFiredDate = "";

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public int getHour() {
        return hour;
    }

    public void setHour(int hour) {
        this.hour = hour;
    }

    public int getMinute() {
        return minute;
    }

    public void setMinute(int minute) {
        this.minute = minute;
    }

    public String getLabel() {
        return label;
    }

    public void setLabel(String label) {
        this.label = label;
    }

    public String getChannel() {
        return channel;
    }

    public void setChannel(String channel) {
        this.channel = channel;
    }

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public String getLastFiredDate() {
        return lastFiredDate;
    }

    public void setLastFiredDate(String lastFiredDate) {
        this.lastFiredDate = lastFiredDate;
    }
}
