package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.RadioFavoritesDto;
import com.pat.controller.dto.RadioStationDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Per-user radio station favorites, stored in {@code appParameters}
 * under key {@code radio.favorites.<JWT sub>}.
 */
@Service
public class RadioFavoritesService {

    private static final Logger log = LoggerFactory.getLogger(RadioFavoritesService.class);

    static final String PARAM_KEY_PREFIX = "radio.favorites.";
    private static final int MAX_FAVORITES = 80;
    private static final int MAX_ID_LEN = 160;
    private static final int MAX_NAME_LEN = 200;
    private static final int MAX_URL_LEN = 2000;

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;

    public RadioFavoritesService(AppParameterService appParameterService, ObjectMapper objectMapper) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
    }

    public RadioFavoritesDto findForSubject(String jwtSubject) {
        if (!StringUtils.hasText(jwtSubject)) {
            return new RadioFavoritesDto();
        }
        String key = PARAM_KEY_PREFIX + jwtSubject;
        Optional<AppParameter> row = appParameterService.find(key);
        if (row.isEmpty()) {
            return new RadioFavoritesDto();
        }
        String raw = row.get().getParamValue();
        if (!StringUtils.hasText(raw)) {
            return new RadioFavoritesDto();
        }
        try {
            RadioFavoritesDto dto = objectMapper.readValue(raw, RadioFavoritesDto.class);
            return normalize(dto);
        } catch (JsonProcessingException e) {
            log.debug("radio.favorites unreadable JSON for key {}: {}", key, e.getMessage());
            return new RadioFavoritesDto();
        }
    }

    public RadioFavoritesDto saveForSubject(String jwtSubject, RadioFavoritesDto dto) {
        if (!StringUtils.hasText(jwtSubject)) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        RadioFavoritesDto normalized = normalize(dto);
        String key = PARAM_KEY_PREFIX + jwtSubject;
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Radio watcher: per-user favorite stations (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization radio favorites", e);
        }
        return normalized;
    }

    public RadioFavoritesDto addFavorite(String jwtSubject, RadioStationDto station) {
        RadioFavoritesDto current = findForSubject(jwtSubject);
        RadioStationDto normalizedStation = normalizeStation(station);
        if (normalizedStation == null) {
            throw new IllegalArgumentException("invalid station");
        }
        Map<String, RadioStationDto> byId = new LinkedHashMap<>();
        for (RadioStationDto existing : current.getStations()) {
            byId.put(favoriteKey(existing), existing);
        }
        byId.put(favoriteKey(normalizedStation), normalizedStation);
        List<RadioStationDto> list = new ArrayList<>(byId.values());
        if (list.size() > MAX_FAVORITES) {
            list = new ArrayList<>(list.subList(list.size() - MAX_FAVORITES, list.size()));
        }
        return saveForSubject(jwtSubject, new RadioFavoritesDto(list));
    }

    public RadioFavoritesDto removeFavorite(String jwtSubject, String stationId) {
        if (!StringUtils.hasText(stationId)) {
            return findForSubject(jwtSubject);
        }
        String id = stationId.trim();
        RadioFavoritesDto current = findForSubject(jwtSubject);
        List<RadioStationDto> kept = new ArrayList<>();
        for (RadioStationDto st : current.getStations()) {
            if (st.getId() == null || !st.getId().equals(id)) {
                kept.add(st);
            }
        }
        return saveForSubject(jwtSubject, new RadioFavoritesDto(kept));
    }

    private RadioFavoritesDto normalize(RadioFavoritesDto dto) {
        if (dto == null || dto.getStations() == null) {
            return new RadioFavoritesDto();
        }
        List<RadioStationDto> cleaned = new ArrayList<>();
        Map<String, RadioStationDto> byId = new LinkedHashMap<>();
        for (RadioStationDto st : dto.getStations()) {
            RadioStationDto n = normalizeStation(st);
            if (n != null) {
                byId.put(favoriteKey(n), n);
            }
        }
        cleaned.addAll(byId.values());
        if (cleaned.size() > MAX_FAVORITES) {
            cleaned = new ArrayList<>(cleaned.subList(cleaned.size() - MAX_FAVORITES, cleaned.size()));
        }
        return new RadioFavoritesDto(cleaned);
    }

    static RadioStationDto normalizeStation(RadioStationDto st) {
        if (st == null) {
            return null;
        }
        String streamUrl = trimTo(st.getStreamUrl(), MAX_URL_LEN);
        if (!StringUtils.hasText(streamUrl)
                || !(streamUrl.startsWith("http://") || streamUrl.startsWith("https://"))) {
            return null;
        }
        String name = trimTo(st.getName(), MAX_NAME_LEN);
        if (!StringUtils.hasText(name)) {
            return null;
        }
        String id = trimTo(st.getId(), MAX_ID_LEN);
        if (!StringUtils.hasText(id)) {
            id = Integer.toHexString(streamUrl.hashCode());
        }
        String country = trimTo(st.getCountry(), 8);
        if (country != null) {
            country = country.toLowerCase(Locale.ROOT);
        }
        return new RadioStationDto(
                id,
                name,
                trimTo(st.getLogo(), MAX_URL_LEN),
                trimTo(st.getTags(), 200),
                country,
                streamUrl,
                trimTo(st.getCodec(), 40),
                st.getBitrate(),
                trimTo(st.getLanguage(), 80),
                trimTo(st.getHomepage(), MAX_URL_LEN)
        );
    }

    private static String favoriteKey(RadioStationDto st) {
        return st.getId() != null ? st.getId() : st.getStreamUrl();
    }

    private static String trimTo(String value, int max) {
        if (value == null) {
            return null;
        }
        String t = value.trim();
        if (t.isEmpty()) {
            return null;
        }
        return t.length() > max ? t.substring(0, max) : t;
    }
}
