package com.pat.controller;

import com.pat.controller.dto.GpsSessionDto;
import com.pat.repo.domain.Member;
import com.pat.service.FriendsService;
import com.pat.service.GpsSessionService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Persist GPS follow sessions (planned track + recorded samples).
 * <p>
 * {@code GET /api/gps-sessions}<br>
 * {@code GET /api/gps-sessions/{id}}<br>
 * {@code POST /api/gps-sessions/sync}<br>
 * {@code DELETE /api/gps-sessions/{id}}
 */
@RestController
@RequestMapping("/api/gps-sessions")
public class GpsSessionRestController {

    private final GpsSessionService gpsSessionService;
    private final FriendsService friendsService;

    public GpsSessionRestController(GpsSessionService gpsSessionService, FriendsService friendsService) {
        this.gpsSessionService = gpsSessionService;
        this.friendsService = friendsService;
    }

    @GetMapping
    public ResponseEntity<?> list(Authentication authentication) {
        Member me = requireUser(authentication);
        if (me == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(gpsSessionService.listForMember(me));
    }

    @GetMapping("/{id}")
    public ResponseEntity<?> get(@PathVariable String id, Authentication authentication) {
        Member me = requireUser(authentication);
        if (me == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return gpsSessionService.getForMember(id, me)
                .<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping("/sync")
    public ResponseEntity<?> sync(@RequestBody GpsSessionDto body, Authentication authentication) {
        Member me = requireUser(authentication);
        if (me == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(gpsSessionService.sync(me, body));
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().body(Map.of("error", ex.getMessage()));
        } catch (SecurityException ex) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("error", ex.getMessage()));
        }
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> delete(@PathVariable String id, Authentication authentication) {
        Member me = requireUser(authentication);
        if (me == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            if (!gpsSessionService.delete(id, me)) {
                return ResponseEntity.notFound().build();
            }
            return ResponseEntity.noContent().build();
        } catch (SecurityException ex) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("error", ex.getMessage()));
        }
    }

    private Member requireUser(Authentication authentication) {
        return friendsService.getCurrentUser(authentication);
    }
}
