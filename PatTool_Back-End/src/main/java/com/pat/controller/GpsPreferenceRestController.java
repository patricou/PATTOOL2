package com.pat.controller;

import com.pat.controller.dto.GpsFollowPreferenceDto;
import com.pat.service.GpsFollowPreferenceService;
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
 * Per-user GPS map follow preference.
 * <p>
 * {@code GET/PUT /api/external/gps/follow-preferences}
 */
@RestController
@RequestMapping("/api/external/gps")
public class GpsPreferenceRestController {

    private final GpsFollowPreferenceService gpsFollowPreferenceService;

    public GpsPreferenceRestController(GpsFollowPreferenceService gpsFollowPreferenceService) {
        this.gpsFollowPreferenceService = gpsFollowPreferenceService;
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

    private static String currentJwtSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        String sub = jwt.getSubject();
        return (sub != null && !sub.isBlank()) ? sub : null;
    }
}
