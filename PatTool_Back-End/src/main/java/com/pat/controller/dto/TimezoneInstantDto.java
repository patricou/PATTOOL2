package com.pat.controller.dto;

/**
 * A date-time expressed in a specific IANA zone.
 */
public class TimezoneInstantDto {

    private String dateTime;
    private String zone;
    /** Short zone name at this instant (e.g. CEST, EST, IST). */
    private String abbreviation;
    private String iso;
    private String offset;
    /** Calendar day delta vs source local date (e.g. +1 when crossing midnight). */
    private Integer dayDifference;

    public TimezoneInstantDto() {
    }

    public String getDateTime() {
        return dateTime;
    }

    public void setDateTime(String dateTime) {
        this.dateTime = dateTime;
    }

    public String getZone() {
        return zone;
    }

    public void setZone(String zone) {
        this.zone = zone;
    }

    public String getAbbreviation() {
        return abbreviation;
    }

    public void setAbbreviation(String abbreviation) {
        this.abbreviation = abbreviation;
    }

    public String getIso() {
        return iso;
    }

    public void setIso(String iso) {
        this.iso = iso;
    }

    public String getOffset() {
        return offset;
    }

    public void setOffset(String offset) {
        this.offset = offset;
    }

    public Integer getDayDifference() {
        return dayDifference;
    }

    public void setDayDifference(Integer dayDifference) {
        this.dayDifference = dayDifference;
    }
}
