package com.pat.controller;

import com.pat.controller.dto.GpsItineraryDto;
import com.pat.controller.dto.GpsItineraryShareRequest;
import com.pat.repo.domain.Member;
import com.pat.service.FriendsService;
import com.pat.service.GpsItineraryService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * Persist and share GPS itineraries between friends.
 * <p>
 * {@code GET/POST /api/gps-itineraries}<br>
 * {@code GET/PUT/DELETE /api/gps-itineraries/{id}}<br>
 * {@code POST /api/gps-itineraries/{id}/share}
 */
@RestController
@RequestMapping("/api/gps-itineraries")
public class GpsItineraryRestController {

    private final GpsItineraryService gpsItineraryService;
    private final FriendsService friendsService;

    public GpsItineraryRestController(
            GpsItineraryService gpsItineraryService,
            FriendsService friendsService) {
        this.gpsItineraryService = gpsItineraryService;
        this.friendsService = friendsService;
    }

    @GetMapping
    public ResponseEntity<?> list(Authentication authentication) {
        Member me = requireUser(authentication);
        if (me == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(gpsItineraryService.listForMember(me));
    }

    @GetMapping("/{id}")
    public ResponseEntity<?> get(@PathVariable String id, Authentication authentication) {
        Member me = requireUser(authentication);
        if (me == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return gpsItineraryService.getForMember(id, me)
                .<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<?> create(@RequestBody GpsItineraryDto body, Authentication authentication) {
        Member me = requireUser(authentication);
        if (me == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.status(HttpStatus.CREATED).body(gpsItineraryService.create(me, body));
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().body(Map.of("error", ex.getMessage()));
        }
    }

    @PutMapping("/{id}")
    public ResponseEntity<?> update(
            @PathVariable String id,
            @RequestBody GpsItineraryDto body,
            Authentication authentication) {
        Member me = requireUser(authentication);
        if (me == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return gpsItineraryService.update(id, me, body)
                    .<ResponseEntity<?>>map(ResponseEntity::ok)
                    .orElseGet(() -> ResponseEntity.notFound().build());
        } catch (SecurityException ex) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("error", ex.getMessage()));
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().body(Map.of("error", ex.getMessage()));
        }
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> delete(@PathVariable String id, Authentication authentication) {
        Member me = requireUser(authentication);
        if (me == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            if (!gpsItineraryService.delete(id, me)) {
                return ResponseEntity.notFound().build();
            }
            return ResponseEntity.noContent().build();
        } catch (SecurityException ex) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("error", ex.getMessage()));
        }
    }

    @PostMapping("/{id}/share")
    public ResponseEntity<?> share(
            @PathVariable String id,
            @RequestBody GpsItineraryShareRequest body,
            Authentication authentication) {
        Member me = requireUser(authentication);
        if (me == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            List<String> ids = body != null ? body.getMemberIds() : List.of();
            return ResponseEntity.ok(gpsItineraryService.share(id, me, ids));
        } catch (IllegalArgumentException ex) {
            if ("not_found".equals(ex.getMessage())) {
                return ResponseEntity.notFound().build();
            }
            return ResponseEntity.badRequest().body(Map.of("error", ex.getMessage()));
        } catch (SecurityException ex) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("error", ex.getMessage()));
        }
    }

    private Member requireUser(Authentication authentication) {
        return friendsService.getCurrentUser(authentication);
    }
}
