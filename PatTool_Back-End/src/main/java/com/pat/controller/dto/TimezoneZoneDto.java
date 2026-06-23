package com.pat.controller.dto;

/**
 * IANA time zone entry for the picker UI.
 */
public class TimezoneZoneDto {

    private String id;
    /** Short zone name at the reference instant (e.g. CEST, EST, IST). */
    private String abbreviation;
    private String offset;
    private int offsetSeconds;
    private String label;

    public TimezoneZoneDto() {
    }

    public TimezoneZoneDto(String id, String abbreviation, String offset, int offsetSeconds, String label) {
        this.id = id;
        this.abbreviation = abbreviation;
        this.offset = offset;
        this.offsetSeconds = offsetSeconds;
        this.label = label;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getAbbreviation() {
        return abbreviation;
    }

    public void setAbbreviation(String abbreviation) {
        this.abbreviation = abbreviation;
    }

    public String getOffset() {
        return offset;
    }

    public void setOffset(String offset) {
        this.offset = offset;
    }

    public int getOffsetSeconds() {
        return offsetSeconds;
    }

    public void setOffsetSeconds(int offsetSeconds) {
        this.offsetSeconds = offsetSeconds;
    }

    public String getLabel() {
        return label;
    }

    public void setLabel(String label) {
        this.label = label;
    }
}
