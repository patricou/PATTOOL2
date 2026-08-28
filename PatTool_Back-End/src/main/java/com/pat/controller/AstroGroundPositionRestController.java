package com.pat.controller;

import com.pat.controller.dto.AstroGroundPositionDto;
import com.pat.service.AstroGroundPositionService;
import com.pat.service.LastRouteService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Positions au sol du viseur d’astres, persistées par username.
 * {@code GET/POST /api/astro/ground-positions}<br>
 * {@code PUT/DELETE /api/astro/ground-positions/{id}}
 */
@RestController
@RequestMapping("/api/astro/ground-positions")
public class AstroGroundPositionRestController {

    private final AstroGroundPositionService service;
    private final LastRouteService lastRouteService;

    public AstroGroundPositionRestController(
            AstroGroundPositionService service,
            LastRouteService lastRouteService) {
        this.service = service;
        this.lastRouteService = lastRouteService;
    }

    @GetMapping
    public ResponseEntity<?> list() {
        Owner owner = currentOwner();
        if (owner == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(Map.of(
                "ownerUsername", owner.username,
                "positions", service.list(owner.username, owner.subject)));
    }

    @PostMapping
    public ResponseEntity<?> create(@RequestBody AstroGroundPositionDto body) {
        Owner owner = currentOwner();
        if (owner == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.status(HttpStatus.CREATED)
                    .body(service.create(owner.username, owner.subject, body));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @PutMapping("/{id}")
    public ResponseEntity<?> update(@PathVariable String id, @RequestBody AstroGroundPositionDto body) {
        Owner owner = currentOwner();
        if (owner == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(service.update(owner.username, owner.subject, id, body));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.status(notFound(e) ? HttpStatus.NOT_FOUND : HttpStatus.BAD_REQUEST)
                    .body(Map.of("error", e.getMessage()));
        }
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> delete(@PathVariable String id) {
        Owner owner = currentOwner();
        if (owner == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            service.delete(owner.username, owner.subject, id);
            return ResponseEntity.noContent().build();
        } catch (IllegalArgumentException e) {
            return ResponseEntity.status(notFound(e) ? HttpStatus.NOT_FOUND : HttpStatus.BAD_REQUEST)
                    .body(Map.of("error", e.getMessage()));
        }
    }

    private static boolean notFound(IllegalArgumentException e) {
        return e.getMessage() != null && e.getMessage().contains("not found");
    }

    private Owner currentOwner() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        String username = lastRouteService.resolveOwnerUsername(jwt);
        String subject = jwt.getSubject();
        if (!StringUtils.hasText(username)) {
            return null;
        }
        return new Owner(username, StringUtils.hasText(subject) ? subject : null);
    }

    private record Owner(String username, String subject) {}
}
