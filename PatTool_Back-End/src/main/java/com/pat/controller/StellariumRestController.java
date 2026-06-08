package com.pat.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.pat.controller.dto.StellariumConfigDto;
import com.pat.service.StellariumProxyService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.concurrent.TimeUnit;

/**
 * Proxy for Stellarium Web public APIs and HTML sky-map viewer.
 * <p>
 * Endpoints:
 * <ul>
 *   <li>{@code GET /api/external/stellarium/config} — observer location + embed URLs (server-side geolocation)</li>
 *   <li>{@code GET /api/external/stellarium/viewer} — HTML iframe page wrapping Stellarium Web</li>
 *   <li>{@code GET /api/external/stellarium/skysources?q=} — object search (Noctua Sky API)</li>
 *   <li>{@code GET /api/external/stellarium/skysources/name/{name}} — object lookup by name</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/stellarium")
public class StellariumRestController {

    private final StellariumProxyService stellariumProxyService;

    public StellariumRestController(StellariumProxyService stellariumProxyService) {
        this.stellariumProxyService = stellariumProxyService;
    }

    @GetMapping("/config")
    public ResponseEntity<StellariumConfigDto> config(
            HttpServletRequest request,
            @RequestParam(required = false) Double lat,
            @RequestParam(required = false) Double lon) {
        return ResponseEntity.ok(stellariumProxyService.buildConfig(request, lat, lon));
    }

    @GetMapping(value = "/viewer", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> viewer(
            @RequestParam(defaultValue = "48.8566") double lat,
            @RequestParam(defaultValue = "2.3522") double lon) {
        String html = stellariumProxyService.buildViewerHtml(lat, lon);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(0, TimeUnit.SECONDS).cachePrivate())
                .contentType(MediaType.TEXT_HTML)
                .body(html);
    }

    @GetMapping("/skysources")
    public ResponseEntity<JsonNode> searchSkySources(@RequestParam("q") String query) {
        return ResponseEntity.ok(stellariumProxyService.searchSkySources(query));
    }

    @GetMapping("/skysources/name/{name}")
    public ResponseEntity<JsonNode> skySourceByName(@PathVariable("name") String name) {
        return ResponseEntity.ok(stellariumProxyService.skySourceByName(name));
    }
}
