package com.pat.controller;

import com.pat.controller.dto.AudioEqualizerPreferenceDto;
import com.pat.service.AudioEqualizerPreferenceService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Per-user audio equalizer (current settings + one custom preset).
 * {@code GET/PUT /api/external/audio/equalizer}
 */
@RestController
@RequestMapping("/api/external/audio/equalizer")
public class AudioEqualizerRestController {

    private final AudioEqualizerPreferenceService audioEqualizerPreferenceService;

    public AudioEqualizerRestController(AudioEqualizerPreferenceService audioEqualizerPreferenceService) {
        this.audioEqualizerPreferenceService = audioEqualizerPreferenceService;
    }

    @GetMapping
    public ResponseEntity<AudioEqualizerPreferenceDto> getPreference() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(audioEqualizerPreferenceService.findForSubject(sub));
    }

    @PutMapping
    public ResponseEntity<?> putPreference(@RequestBody AudioEqualizerPreferenceDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(audioEqualizerPreferenceService.saveForSubject(sub, body));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    private String currentJwtSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        String sub = jwt.getSubject();
        return StringUtils.hasText(sub) ? sub.trim() : null;
    }
}
