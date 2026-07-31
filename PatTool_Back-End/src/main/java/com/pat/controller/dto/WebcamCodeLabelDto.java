package com.pat.controller.dto;

/**
 * Simple code/label pair for Windy filter lists (countries, continents, categories).
 */
public class WebcamCodeLabelDto {

    private String code;
    private String label;

    public WebcamCodeLabelDto() {
    }

    public WebcamCodeLabelDto(String code, String label) {
        this.code = code;
        this.label = label;
    }

    public String getCode() {
        return code;
    }

    public void setCode(String code) {
        this.code = code;
    }

    public String getLabel() {
        return label;
    }

    public void setLabel(String label) {
        this.label = label;
    }
}
