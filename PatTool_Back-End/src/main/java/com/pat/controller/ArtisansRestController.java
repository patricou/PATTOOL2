package com.pat.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pat.controller.dto.ArtisanFavoriteDto;
import com.pat.controller.dto.ArtisansFavoritesDto;
import com.pat.service.ArtisansFavoritesService;
import com.pat.service.ArtisansNearbyService;
import com.pat.service.ArtisansWebsiteLookupService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Nearby artisans / home trades.
 * {@code GET /api/external/artisans/nearby?source=sirene|osm&lat=&lon=&q=&radiusKm=&trade=&page=&text=}
 * Authenticated favorites: {@code GET/PUT /favorites}, {@code PUT/DELETE /favorites/item}.
 */
@RestController
@RequestMapping("/api/external/artisans")
public class ArtisansRestController {

    private final ArtisansNearbyService artisansNearbyService;
    private final ArtisansWebsiteLookupService artisansWebsiteLookupService;
    private final ArtisansFavoritesService artisansFavoritesService;
    private final ObjectMapper objectMapper;

    public ArtisansRestController(
            ArtisansNearbyService artisansNearbyService,
            ArtisansWebsiteLookupService artisansWebsiteLookupService,
            ArtisansFavoritesService artisansFavoritesService,
            ObjectMapper objectMapper) {
        this.artisansNearbyService = artisansNearbyService;
        this.artisansWebsiteLookupService = artisansWebsiteLookupService;
        this.artisansFavoritesService = artisansFavoritesService;
        this.objectMapper = objectMapper;
    }
    @GetMapping("/nearby")
    public ResponseEntity<JsonNode> nearby(
            @RequestParam(value = "source", required = false) String source,
            @RequestParam(value = "lat", required = false) Double lat,
            @RequestParam(value = "lon", required = false) Double lon,
            @RequestParam(value = "q", required = false) String address,
            @RequestParam(value = "radiusKm", required = false) Double radiusKm,
            @RequestParam(value = "trade", required = false) String trade,
            @RequestParam(value = "page", required = false) Integer page,
            @RequestParam(value = "perPage", required = false) Integer perPage,
            @RequestParam(value = "text", required = false) String text) {
        return ResponseEntity.ok(artisansNearbyService.nearby(
                source, lat, lon, address, radiusKm, trade, page, perPage, text));
    }

    @GetMapping("/website")
    public ResponseEntity<JsonNode> website(
            @RequestParam("name") String name,
            @RequestParam(value = "city", required = false) String city,
            @RequestParam(value = "postalCode", required = false) String postalCode,
            @RequestParam(value = "activity", required = false) String activity) {
        ObjectNode root = objectMapper.createObjectNode();
        String website = artisansWebsiteLookupService.lookup(name, city, postalCode, activity);
        if (website != null && !website.isBlank()) {
            root.put("website", website);
        } else {
            root.put("website", "");
        }
        return ResponseEntity.ok(root);
    }

    @GetMapping("/favorites")
    public ResponseEntity<ArtisansFavoritesDto> getFavorites() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(artisansFavoritesService.findForSubject(sub));
    }

    @PutMapping("/favorites")
    public ResponseEntity<?> putFavorites(@RequestBody ArtisansFavoritesDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(artisansFavoritesService.saveForSubject(sub, body));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @PutMapping("/favorites/item")
    public ResponseEntity<?> addFavorite(@RequestBody ArtisanFavoriteDto item) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(artisansFavoritesService.addFavorite(sub, item));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @DeleteMapping("/favorites/item")
    public ResponseEntity<ArtisansFavoritesDto> removeFavorite(
            @RequestParam("id") String id,
            @RequestParam(value = "source", required = false) String source) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(artisansFavoritesService.removeFavorite(sub, id, source));
    }

    private static String currentJwtSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        return jwt.getSubject();
    }
}
