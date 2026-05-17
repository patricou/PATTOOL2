package com.pat.controller;

import com.pat.config.SecurityAwarenessLinksProperties;
import com.pat.dto.SecurityAwarenessLinksDto;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Expose des métadonnées non sensibles pour la page sécurité / périmètre autorisé (JWT requis).
 */
@RestController
@RequestMapping("/api/config")
public class SecurityAwarenessConfigController {

    private final SecurityAwarenessLinksProperties properties;

    public SecurityAwarenessConfigController(SecurityAwarenessLinksProperties properties) {
        this.properties = properties;
    }

    @GetMapping("/security-awareness-links")
    public SecurityAwarenessLinksDto getSecurityAwarenessLinks() {
        return new SecurityAwarenessLinksDto(
                blankToNull(properties.getScannerDashboardUrl()),
                blankToNull(properties.getInternalRunbookUrl()));
    }

    private static String blankToNull(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }
}
