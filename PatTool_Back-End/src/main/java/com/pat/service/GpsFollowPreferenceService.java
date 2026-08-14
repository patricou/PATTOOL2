package com.pat.service;

import com.pat.controller.dto.GpsFollowPreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.springframework.stereotype.Service;

import java.util.Optional;

/**
 * Per-user GPS follow-user preference, stored in {@code appParameters}
 * under key {@code gps.follow-user.&lt;Member.userName&gt;} (legacy Keycloak id still readable).
 */
@Service
public class GpsFollowPreferenceService {

    static final String PARAM_KEY_PREFIX = "gps.follow-user.";

    private final AppParameterService appParameterService;
    private final UserOwnerService userOwnerService;

    public GpsFollowPreferenceService(AppParameterService appParameterService, UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.userOwnerService = userOwnerService;
    }

    public GpsFollowPreferenceDto findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return new GpsFollowPreferenceDto(false);
        }
        return new GpsFollowPreferenceDto(Boolean.parseBoolean(row.get().getParamValue()));
    }

    public GpsFollowPreferenceDto saveForSubject(String jwtSubject, GpsFollowPreferenceDto body) {
        boolean follow = body != null && body.isFollowUser();
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        appParameterService.setBoolean(
                key,
                follow,
                "GPS routing: recenter maps on user position every 5s (per user).");
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return new GpsFollowPreferenceDto(follow);
    }
}
