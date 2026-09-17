package com.pat.service;

import com.pat.controller.dto.GpsSlopeScalePreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.springframework.stereotype.Service;

import java.util.Locale;
import java.util.Optional;

/**
 * Per-user GPS slope display coefficient, stored in {@code appParameters}
 * under key {@code gps.slope-coef.&lt;Member.userName&gt;}.
 */
@Service
public class GpsSlopeScalePreferenceService {

    static final String PARAM_KEY_PREFIX = "gps.slope-coef.";

    private final AppParameterService appParameterService;
    private final UserOwnerService userOwnerService;

    public GpsSlopeScalePreferenceService(
            AppParameterService appParameterService,
            UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.userOwnerService = userOwnerService;
    }

    public GpsSlopeScalePreferenceDto findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return new GpsSlopeScalePreferenceDto(GpsSlopeScalePreferenceDto.DEFAULT_COEF);
        }
        return new GpsSlopeScalePreferenceDto(parseCoef(row.get().getParamValue()));
    }

    public GpsSlopeScalePreferenceDto saveForSubject(String jwtSubject, GpsSlopeScalePreferenceDto body) {
        double coef = clamp(body != null ? body.getSlopeCoef() : GpsSlopeScalePreferenceDto.DEFAULT_COEF);
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        appParameterService.setString(
                key,
                formatCoef(coef),
                "GPS slope diagram multiplier (per user). 4.5 maps 20° to a vertical needle.");
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return new GpsSlopeScalePreferenceDto(coef);
    }

    static double parseCoef(String raw) {
        if (raw == null || raw.isBlank()) {
            return GpsSlopeScalePreferenceDto.DEFAULT_COEF;
        }
        try {
            return clamp(Double.parseDouble(raw.trim().replace(',', '.')));
        } catch (NumberFormatException e) {
            return GpsSlopeScalePreferenceDto.DEFAULT_COEF;
        }
    }

    static double clamp(double value) {
        if (!Double.isFinite(value)) {
            return GpsSlopeScalePreferenceDto.DEFAULT_COEF;
        }
        double rounded = Math.round(value * 10.0) / 10.0;
        return Math.max(
                GpsSlopeScalePreferenceDto.MIN_COEF,
                Math.min(GpsSlopeScalePreferenceDto.MAX_COEF, rounded));
    }

    private static String formatCoef(double coef) {
        return String.format(Locale.US, "%.1f", coef);
    }
}
