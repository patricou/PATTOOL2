package com.pat.controller;

import com.pat.controller.dto.ReliefHorizonResponse;
import com.pat.service.ReliefFinderService;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import static org.springframework.http.HttpStatus.BAD_REQUEST;

/**
 * PeakFinder-style DEM horizon + named peaks for the Relief Finder page.
 * <p>
 * {@code GET /api/external/relief-finder/horizon?lat=&lon=&radiusKm=&observerAltM=&stepDeg=}
 */
@RestController
@RequestMapping("/api/external/relief-finder")
public class ReliefFinderRestController {

    private final ReliefFinderService reliefFinderService;

    public ReliefFinderRestController(ReliefFinderService reliefFinderService) {
        this.reliefFinderService = reliefFinderService;
    }

    @GetMapping(value = "/horizon", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<ReliefHorizonResponse> horizon(
            @RequestParam double lat,
            @RequestParam double lon,
            @RequestParam(defaultValue = "60") double radiusKm,
            @RequestParam(required = false) Double observerAltM,
            @RequestParam(defaultValue = "0.5") double stepDeg) {
        if (!Double.isFinite(lat) || !Double.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            throw new ResponseStatusException(BAD_REQUEST, "Invalid coordinates");
        }
        return ResponseEntity.ok(reliefFinderService.compute(lat, lon, radiusKm, observerAltM, stepDeg));
    }
}
