package com.pat.controller;

import com.pat.controller.dto.GpsFollowPreferenceDto;
import com.pat.controller.dto.GpsSlopeScalePreferenceDto;
import com.pat.service.GpsFollowPreferenceService;
import com.pat.service.GpsSlopeScalePreferenceService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Per-user GPS preferences.
 * <p>
 * {@code GET/PUT /api/external/gps/follow-preferences}
 * {@code GET/PUT /api/external/gps/slope-scale}
 */
@RestController
@RequestMapping("/api/external/gps")
public class GpsPreferenceRestController {

    private final GpsFollowPreferenceService gpsFollowPreferenceService;
    private final GpsSlopeScalePreferenceService gpsSlopeScalePreferenceService;

    public GpsPreferenceRestController(
            GpsFollowPreferenceService gpsFollowPreferenceService,
            GpsSlopeScalePreferenceService gpsSlopeScalePreferenceService) {
        this.gpsFollowPreferenceService = gpsFollowPreferenceService;
        this.gpsSlopeScalePreferenceService = gpsSlopeScalePreferenceService;
    }

    @GetMapping("/follow-preferences")
    public ResponseEntity<GpsFollowPreferenceDto> getFollowPreferences() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(gpsFollowPreferenceService.findForSubject(sub));
    }

    @PutMapping("/follow-preferences")
    public ResponseEntity<?> putFollowPreferences(@RequestBody GpsFollowPreferenceDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(gpsFollowPreferenceService.saveForSubject(sub, body));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping("/slope-scale")
    public ResponseEntity<GpsSlopeScalePreferenceDto> getSlopeScale() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(gpsSlopeScalePreferenceService.findForSubject(sub));
    }

    @PutMapping("/slope-scale")
    public ResponseEntity<?> putSlopeScale(@RequestBody GpsSlopeScalePreferenceDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(gpsSlopeScalePreferenceService.saveForSubject(sub, body));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    private static String currentJwtSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        String sub = jwt.getSubject();
        return (sub != null && !sub.isBlank()) ? sub : null;
    }
}
