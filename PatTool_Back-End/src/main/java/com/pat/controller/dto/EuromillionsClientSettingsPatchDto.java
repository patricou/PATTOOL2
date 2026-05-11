package com.pat.controller.dto;

/**
 * PATCH {@code /api/euromillions/client-settings} — borne basse inclusive pour l’assistant.
 */
public class EuromillionsClientSettingsPatchDto {

    /** ISO yyyy-MM-dd */
    private String minDrawDateIso;

    public String getMinDrawDateIso() {
        return minDrawDateIso;
    }

    public void setMinDrawDateIso(String minDrawDateIso) {
        this.minDrawDateIso = minDrawDateIso;
    }
}
