package com.pat.controller;

import com.pat.controller.dto.PatToolParametersResponseDto;
import com.pat.service.PatToolParametersService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Read-only admin view of application configuration (application.properties + Mongo overrides).
 */
@RestController
@RequestMapping("/api/admin/pattool-parameters")
public class PatToolParametersController {

    private final PatToolParametersService patToolParametersService;

    public PatToolParametersController(PatToolParametersService patToolParametersService) {
        this.patToolParametersService = patToolParametersService;
    }

    @GetMapping
    public ResponseEntity<PatToolParametersResponseDto> getParameters() {
        if (!hasAdminRole()) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        return ResponseEntity.ok(patToolParametersService.buildSnapshot());
    }

    private boolean hasAdminRole() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null) {
            return false;
        }
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(authority -> authority.equalsIgnoreCase("ROLE_Admin")
                        || authority.equalsIgnoreCase("ROLE_admin"));
    }
}
