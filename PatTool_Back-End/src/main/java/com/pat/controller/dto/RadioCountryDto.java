package com.pat.controller.dto;

/**
 * Country available in the world radio catalog.
 */
public class RadioCountryDto {

    private String code;
    private String name;
    private String flag;
    private int stationCount;

    public RadioCountryDto() {
    }

    public RadioCountryDto(String code, String name, String flag, int stationCount) {
        this.code = code;
        this.name = name;
        this.flag = flag;
        this.stationCount = stationCount;
    }

    public String getCode() {
        return code;
    }

    public void setCode(String code) {
        this.code = code;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getFlag() {
        return flag;
    }

    public void setFlag(String flag) {
        this.flag = flag;
    }

    public int getStationCount() {
        return stationCount;
    }

    public void setStationCount(int stationCount) {
        this.stationCount = stationCount;
    }
}
