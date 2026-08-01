package com.pat.service;

import com.pat.controller.dto.GpsFollowPreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.Optional;

/**
 * Per-user GPS follow-user preference, stored in {@code appParameters}
 * under key {@code gps.follow-user.&lt;JWT sub&gt;}.
 */
@Service
public class GpsFollowPreferenceService {

    static final String PARAM_KEY_PREFIX = "gps.follow-user.";

    private final AppParameterService appParameterService;

    public GpsFollowPreferenceService(AppParameterService appParameterService) {
        this.appParameterService = appParameterService;
    }

    public GpsFollowPreferenceDto findForSubject(String jwtSubject) {
        if (!StringUtils.hasText(jwtSubject)) {
            return new GpsFollowPreferenceDto(false);
        }
        String key = PARAM_KEY_PREFIX + jwtSubject;
        Optional<AppParameter> row = appParameterService.find(key);
        if (row.isEmpty()) {
            return new GpsFollowPreferenceDto(false);
        }
        return new GpsFollowPreferenceDto(Boolean.parseBoolean(row.get().getParamValue()));
    }

    public GpsFollowPreferenceDto saveForSubject(String jwtSubject, GpsFollowPreferenceDto body) {
        if (!StringUtils.hasText(jwtSubject)) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        boolean follow = body != null && body.isFollowUser();
        String key = PARAM_KEY_PREFIX + jwtSubject;
        appParameterService.setBoolean(
                key,
                follow,
                "GPS routing: recenter maps on user position every 5s (per user).");
        return new GpsFollowPreferenceDto(follow);
    }
}
