package com.pat.controller.dto;

/**
 * Country available in the free IPTV catalog.
 */
public class TvCountryDto {

    private String code;
    private String name;
    private String flag;

    public TvCountryDto() {
    }

    public TvCountryDto(String code, String name, String flag) {
        this.code = code;
        this.name = name;
        this.flag = flag;
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
}
