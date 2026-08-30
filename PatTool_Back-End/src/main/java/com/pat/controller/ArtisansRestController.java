package com.pat.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.pat.service.ArtisansNearbyService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Nearby artisans / home trades.
 * {@code GET /api/external/artisans/nearby?source=sirene|osm&lat=&lon=&q=&radiusKm=&trade=&page=}
 */
@RestController
@RequestMapping("/api/external/artisans")
public class ArtisansRestController {

    private final ArtisansNearbyService artisansNearbyService;

    public ArtisansRestController(ArtisansNearbyService artisansNearbyService) {
        this.artisansNearbyService = artisansNearbyService;
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
            @RequestParam(value = "perPage", required = false) Integer perPage) {
        return ResponseEntity.ok(artisansNearbyService.nearby(
                source, lat, lon, address, radiusKm, trade, page, perPage));
    }
}
