package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Élément de la liste {@code AvailableCountries} de l’API Nager.Date (proxy backend).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class NagerCountryDto {

    /** Nager.Date expose {@code countryCode} ; on garde {@code key} côté API PatTool / Angular. */
    @JsonAlias("countryCode")
    private String key;
    private String name;

    public String getKey() {
        return key;
    }

    public void setKey(String key) {
        this.key = key;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }
}
