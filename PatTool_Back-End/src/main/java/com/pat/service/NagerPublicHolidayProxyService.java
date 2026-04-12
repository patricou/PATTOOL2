package com.pat.service;

import com.pat.controller.dto.NagerCountryDto;
import com.pat.controller.dto.NagerPublicHolidayDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * Appelle l’API publique Nager.Date depuis le serveur (évite CORS / expose une URL PatTool).
 */
@Service
public class NagerPublicHolidayProxyService {

    private static final Logger log = LoggerFactory.getLogger(NagerPublicHolidayProxyService.class);

    private final RestTemplate restTemplate;

    @Value("${app.nager.api-base:https://date.nager.at/api/v3}")
    private String apiBase;

    public NagerPublicHolidayProxyService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public List<NagerCountryDto> fetchAvailableCountries() {
        String url = normalizeBase(apiBase) + "/AvailableCountries";
        try {
            NagerCountryDto[] arr = restTemplate.getForObject(url, NagerCountryDto[].class);
            if (arr == null) {
                return Collections.emptyList();
            }
            return Arrays.asList(arr);
        } catch (Exception e) {
            log.warn("Nager AvailableCountries failed ({}): {}", url, e.toString());
            return Collections.emptyList();
        }
    }

    public List<NagerPublicHolidayDto> fetchPublicHolidays(int year, String countryCode) {
        String url = String.format("%s/PublicHolidays/%d/%s", normalizeBase(apiBase), year, countryCode);
        try {
            NagerPublicHolidayDto[] arr = restTemplate.getForObject(url, NagerPublicHolidayDto[].class);
            if (arr == null) {
                return Collections.emptyList();
            }
            return Arrays.asList(arr);
        } catch (Exception e) {
            log.warn("Nager PublicHolidays failed ({}): {}", url, e.toString());
            return Collections.emptyList();
        }
    }

    private static String normalizeBase(String base) {
        if (base == null || base.isBlank()) {
            return "https://date.nager.at/api/v3";
        }
        return base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }
}
