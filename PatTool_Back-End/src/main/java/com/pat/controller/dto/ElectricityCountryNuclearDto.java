package com.pat.controller.dto;

/**
 * Production nucléaire agrégée pour un pays (ENTSO-E ou EIA).
 */
public class ElectricityCountryNuclearDto {

    private String countryCode;
    private String countryName;
    private String datetime;
    private Integer nuclearMw;
    private String source;
    private String note;

    public String getCountryCode() {
        return countryCode;
    }

    public void setCountryCode(String countryCode) {
        this.countryCode = countryCode;
    }

    public String getCountryName() {
        return countryName;
    }

    public void setCountryName(String countryName) {
        this.countryName = countryName;
    }

    public String getDatetime() {
        return datetime;
    }

    public void setDatetime(String datetime) {
        this.datetime = datetime;
    }

    public Integer getNuclearMw() {
        return nuclearMw;
    }

    public void setNuclearMw(Integer nuclearMw) {
        this.nuclearMw = nuclearMw;
    }

    public String getSource() {
        return source;
    }

    public void setSource(String source) {
        this.source = source;
    }

    public String getNote() {
        return note;
    }

    public void setNote(String note) {
        this.note = note;
    }
}
