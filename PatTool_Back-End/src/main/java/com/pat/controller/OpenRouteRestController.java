package com.pat.controller;

import com.pat.controller.dto.OpenRouteDirectionsDto;
import com.pat.service.OpenRouteProxyService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * OpenRouteService proxy for the PatTool GPS page (Monde).
 * <p>
 * Endpoints:
 * <ul>
 *   <li>{@code GET /api/external/openroute/status} — whether the API key is configured</li>
 *   <li>{@code GET /api/external/openroute/directions?profile=&startLat=&startLon=&endLat=&endLon=&viaLat=&viaLon=&lang=}
 *       — optional repeated {@code viaLat}/{@code viaLon} pairs for intermediate stops</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/openroute")
public class OpenRouteRestController {

    private final OpenRouteProxyService openRouteProxyService;

    public OpenRouteRestController(OpenRouteProxyService openRouteProxyService) {
        this.openRouteProxyService = openRouteProxyService;
    }

    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> status() {
        return ResponseEntity.ok(Collections.singletonMap(
                "configured",
                openRouteProxyService.isConfigured()));
    }

    @GetMapping("/directions")
    public ResponseEntity<?> directions(
            @RequestParam String profile,
            @RequestParam double startLat,
            @RequestParam double startLon,
            @RequestParam double endLat,
            @RequestParam double endLon,
            @RequestParam(required = false) List<Double> viaLat,
            @RequestParam(required = false) List<Double> viaLon,
            @RequestParam(required = false) String lang) {

        if (!StringUtils.hasText(profile)) {
            return ResponseEntity.badRequest().body(Map.of("error", "profile_required"));
        }

        List<double[]> vias;
        try {
            vias = zipViaPoints(viaLat, viaLon);
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid_via"));
        }

        try {
            OpenRouteDirectionsDto dto = openRouteProxyService.directions(
                    profile, startLat, startLon, endLat, endLon, vias, lang);
            if (dto == null) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                        .body(Map.of("error", "upstream_failed"));
            }
            if (dto.getCoordinates() == null || dto.getCoordinates().isEmpty()) {
                return ResponseEntity.status(HttpStatus.NOT_FOUND)
                        .body(Map.of("error", "no_route"));
            }
            return ResponseEntity.ok(dto);
        } catch (IllegalStateException ex) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("error", "not_configured"));
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid_request"));
        }
    }

    private static List<double[]> zipViaPoints(List<Double> viaLat, List<Double> viaLon) {
        int latCount = viaLat == null ? 0 : viaLat.size();
        int lonCount = viaLon == null ? 0 : viaLon.size();
        if (latCount != lonCount) {
            throw new IllegalArgumentException("via_mismatch");
        }
        if (latCount == 0) {
            return List.of();
        }
        List<double[]> vias = new ArrayList<>(latCount);
        for (int i = 0; i < latCount; i++) {
            Double lat = viaLat.get(i);
            Double lon = viaLon.get(i);
            if (lat == null || lon == null) {
                throw new IllegalArgumentException("via_null");
            }
            vias.add(new double[] { lat, lon });
        }
        return vias;
    }
}
