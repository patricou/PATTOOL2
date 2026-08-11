package com.pat.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.pat.service.EclipseProxyService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Proxy for eclipse APIs (USNO + OPALE/IMCCE).
 * <p>
 * Endpoints:
 * <ul>
 *   <li>{@code GET /api/external/eclipse/usno/solar/year?year=}</li>
 *   <li>{@code GET /api/external/eclipse/usno/solar/local?date=&amp;lat=&amp;lon=&amp;height=}</li>
 *   <li>{@code GET /api/external/eclipse/opale/year?body=10|301&amp;year=}</li>
 *   <li>{@code GET /api/external/eclipse/opale/day?body=10|301&amp;date=&amp;lat=&amp;lon=&amp;height=}</li>
 *   <li>{@code GET /api/external/eclipse/visibility?lat=&amp;lon=&amp;height=&amp;yearsAhead=}</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/eclipse")
public class EclipseRestController {

    private final EclipseProxyService eclipseProxyService;

    public EclipseRestController(EclipseProxyService eclipseProxyService) {
        this.eclipseProxyService = eclipseProxyService;
    }

    @GetMapping("/usno/solar/year")
    public ResponseEntity<JsonNode> usnoSolarYear(@RequestParam int year) {
        return ResponseEntity.ok(eclipseProxyService.usnoSolarYear(year));
    }

    @GetMapping("/usno/solar/local")
    public ResponseEntity<JsonNode> usnoSolarLocal(
            @RequestParam String date,
            @RequestParam double lat,
            @RequestParam double lon,
            @RequestParam(defaultValue = "0") int height) {
        return ResponseEntity.ok(eclipseProxyService.usnoSolarLocal(date, lat, lon, height));
    }

    @GetMapping("/opale/year")
    public ResponseEntity<JsonNode> opaleYear(
            @RequestParam int body,
            @RequestParam int year) {
        return ResponseEntity.ok(eclipseProxyService.opaleYear(body, year));
    }

    @GetMapping("/opale/day")
    public ResponseEntity<JsonNode> opaleDay(
            @RequestParam int body,
            @RequestParam String date,
            @RequestParam(required = false) Double lat,
            @RequestParam(required = false) Double lon,
            @RequestParam(required = false) Integer height) {
        return ResponseEntity.ok(eclipseProxyService.opaleDay(body, date, lat, lon, height));
    }

    /**
     * Solar eclipse visibility at an observer location: in-progress event (if any),
     * next visible eclipse with magnitude / obscuration %, and time remaining.
     */
    @GetMapping("/visibility")
    public ResponseEntity<JsonNode> visibility(
            @RequestParam double lat,
            @RequestParam double lon,
            @RequestParam(defaultValue = "0") int height,
            @RequestParam(required = false) Integer yearsAhead) {
        return ResponseEntity.ok(eclipseProxyService.visibilityAtLocation(lat, lon, height, yearsAhead));
    }
}
