package com.pat.service;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;

import java.io.InputStream;
import java.util.Collections;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Resolves ICAO airport codes (4 letters) to name, city and IATA using a bundled
 * OpenFlights-derived map ({@code airports-icao.json}).
 */
@Service
public class AirportLookupService {

    private static final Logger log = LoggerFactory.getLogger(AirportLookupService.class);

    private final Map<String, AirportInfo> icaoToAirport;

    public AirportLookupService(ObjectMapper objectMapper) {
        Map<String, AirportInfo> loaded = Collections.emptyMap();
        try (InputStream in = new ClassPathResource("airports-icao.json").getInputStream()) {
            loaded = objectMapper.readValue(in, new TypeReference<Map<String, AirportInfo>>() {});
            log.info("Airport lookup loaded ({} ICAO codes)", loaded.size());
        } catch (Exception e) {
            log.warn("Airport lookup unavailable: {}", e.getMessage());
        }
        this.icaoToAirport = loaded;
    }

    public Optional<AirportInfo> forIcao(String icaoCode) {
        if (icaoCode == null) {
            return Optional.empty();
        }
        String code = icaoCode.trim().toUpperCase(Locale.ROOT);
        if (code.length() != 4) {
            return Optional.empty();
        }
        AirportInfo info = icaoToAirport.get(code);
        return info == null || info.isEmpty() ? Optional.empty() : Optional.of(info);
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record AirportInfo(
            @JsonProperty("n") String name,
            @JsonProperty("c") String city,
            @JsonProperty("i") String iata,
            @JsonProperty("co") String country) {

        boolean isEmpty() {
            return (name == null || name.isBlank())
                    && (city == null || city.isBlank())
                    && (iata == null || iata.isBlank())
                    && (country == null || country.isBlank());
        }
    }
}
