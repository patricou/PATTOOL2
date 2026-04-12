package com.pat.controller.dto;

/**
 * Pays déduit de l’adresse IP du client (calendrier — jours fériés Nager).
 * {@code countryCode} peut être null (IP locale, échec de géolocalisation).
 */
public class PublicHolidayClientCountryDto {

    private final String countryCode;

    public PublicHolidayClientCountryDto(String countryCode) {
        this.countryCode = countryCode;
    }

    public String getCountryCode() {
        return countryCode;
    }
}
