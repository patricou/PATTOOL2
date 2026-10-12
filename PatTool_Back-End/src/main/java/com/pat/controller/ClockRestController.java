package com.pat.controller;

import com.pat.controller.dto.ClockPreferencesDto;
import com.pat.service.ClockPreferenceService;
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

/**
 * Per-user clock face, time zone and alarms.
 * {@code GET/PUT /api/external/clock/preferences}
 */
@RestController
@RequestMapping("/api/external/clock")
public class ClockRestController {

    private final ClockPreferenceService clockPreferenceService;

    public ClockRestController(ClockPreferenceService clockPreferenceService) {
        this.clockPreferenceService = clockPreferenceService;
    }

    @GetMapping("/preferences")
    public ResponseEntity<ClockPreferencesDto> getPreferences() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(clockPreferenceService.findForSubject(sub));
    }

    @PutMapping("/preferences")
    public ResponseEntity<ClockPreferencesDto> putPreferences(@RequestBody ClockPreferencesDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(clockPreferenceService.saveForSubject(sub, body, currentJwtEmail()));
    }

    private static String currentJwtSubject() {
        Jwt jwt = currentJwt();
        if (jwt == null) {
            return null;
        }
        String sub = jwt.getSubject();
        return (sub != null && !sub.isBlank()) ? sub : null;
    }

    private static String currentJwtEmail() {
        Jwt jwt = currentJwt();
        if (jwt == null) {
            return "";
        }
        String email = jwt.getClaimAsString("email");
        return email == null ? "" : email;
    }

    private static Jwt currentJwt() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        return jwt;
    }
}
