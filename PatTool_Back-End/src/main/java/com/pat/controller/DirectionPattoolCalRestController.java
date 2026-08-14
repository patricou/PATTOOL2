package com.pat.controller;

import com.pat.repo.domain.DirectionPattoolSample;
import com.pat.service.DirectionPattoolCalService;
import com.pat.service.LastRouteService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Enregistrements bruts du calibrage Direction (caméra arrière).
 * Clé métier = surnom Member ({@code userName}), résolu depuis le Keycloak {@code sub}.
 * <p>
 * {@code POST/GET/DELETE /api/direction/pattool-cal/samples}<br>
 * {@code GET /api/direction/pattool-cal/export}
 */
@RestController
@RequestMapping("/api/direction/pattool-cal")
public class DirectionPattoolCalRestController {

    private final DirectionPattoolCalService service;
    private final LastRouteService lastRouteService;

    public DirectionPattoolCalRestController(
            DirectionPattoolCalService service,
            LastRouteService lastRouteService) {
        this.service = service;
        this.lastRouteService = lastRouteService;
    }

    @PostMapping("/samples")
    public ResponseEntity<?> create(@RequestBody DirectionPattoolSample body) {
        Owner owner = currentOwner();
        if (owner == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            DirectionPattoolSample saved = service.save(owner.username, owner.subject, body);
            Map<String, Object> res = new LinkedHashMap<>();
            res.put("id", saved.getId());
            res.put("sessionId", saved.getSessionId());
            res.put("poseId", saved.getPoseId());
            res.put("ownerUsername", owner.username);
            res.put("count", service.count(owner.username, owner.subject));
            return ResponseEntity.status(HttpStatus.CREATED).body(res);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping("/samples")
    public ResponseEntity<?> list() {
        Owner owner = currentOwner();
        if (owner == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(service.listPayload(owner.username, owner.subject));
    }

    @GetMapping("/export")
    public ResponseEntity<?> export() {
        Owner owner = currentOwner();
        if (owner == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(service.export(owner.username, owner.subject));
    }

    @DeleteMapping("/samples")
    public ResponseEntity<?> deleteAll() {
        Owner owner = currentOwner();
        if (owner == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        service.deleteAll(owner.username, owner.subject);
        return ResponseEntity.noContent().build();
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
