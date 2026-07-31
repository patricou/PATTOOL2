package com.pat.controller;

import com.pat.controller.dto.WebcamCodeLabelDto;
import com.pat.controller.dto.WebcamItemDto;
import com.pat.controller.dto.WebcamSearchPageDto;
import com.pat.service.WindyWebcamCatalogService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Worldwide webcams via Windy Webcams API v3.
 * <p>
 * Public read-only:
 * <ul>
 *   <li>{@code GET /api/external/webcam/status}</li>
 *   <li>{@code GET /api/external/webcam/continents?lang=}</li>
 *   <li>{@code GET /api/external/webcam/countries?lang=}</li>
 *   <li>{@code GET /api/external/webcam/categories?lang=}</li>
 *   <li>{@code GET /api/external/webcam/webcams?countries=&amp;continents=&amp;categories=&amp;nearby=}</li>
 *   <li>{@code GET /api/external/webcam/webcams/{id}}</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/webcam")
public class WebcamWatcherRestController {

    @Autowired
    private WindyWebcamCatalogService windyWebcamCatalogService;

    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> status() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("configured", windyWebcamCatalogService.isConfigured());
        body.put("provider", "windy");
        body.put("docs", "https://api.windy.com/webcams/docs");
        body.put("keys", "https://api.windy.com/keys");
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(1)).cachePublic())
                .body(body);
    }

    @GetMapping("/continents")
    public ResponseEntity<Map<String, Object>> continents(
            @RequestParam(value = "lang", required = false, defaultValue = "en") String lang) {
        List<WebcamCodeLabelDto> continents = windyWebcamCatalogService.continents(lang);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("continents", continents);
        body.put("configured", windyWebcamCatalogService.isConfigured());
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofHours(6)).cachePublic())
                .body(body);
    }

    @GetMapping("/countries")
    public ResponseEntity<Map<String, Object>> countries(
            @RequestParam(value = "lang", required = false, defaultValue = "en") String lang) {
        List<WebcamCodeLabelDto> countries = windyWebcamCatalogService.countries(lang);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("countries", countries);
        body.put("configured", windyWebcamCatalogService.isConfigured());
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofHours(6)).cachePublic())
                .body(body);
    }

    @GetMapping("/categories")
    public ResponseEntity<Map<String, Object>> categories(
            @RequestParam(value = "lang", required = false, defaultValue = "en") String lang) {
        List<WebcamCodeLabelDto> categories = windyWebcamCatalogService.categories(lang);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("categories", categories);
        body.put("configured", windyWebcamCatalogService.isConfigured());
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofHours(6)).cachePublic())
                .body(body);
    }

    @GetMapping("/webcams")
    public ResponseEntity<WebcamSearchPageDto> webcams(
            @RequestParam(value = "countries", required = false) String countries,
            @RequestParam(value = "continents", required = false) String continents,
            @RequestParam(value = "categories", required = false) String categories,
            @RequestParam(value = "nearby", required = false) String nearby,
            @RequestParam(value = "sortKey", required = false, defaultValue = "popularity") String sortKey,
            @RequestParam(value = "sortDirection", required = false, defaultValue = "desc") String sortDirection,
            @RequestParam(value = "limit", required = false, defaultValue = "24") int limit,
            @RequestParam(value = "offset", required = false, defaultValue = "0") int offset,
            @RequestParam(value = "lang", required = false, defaultValue = "en") String lang) {
        WebcamSearchPageDto page = windyWebcamCatalogService.search(
                countries, continents, categories, nearby, sortKey, sortDirection, limit, offset, lang);
        CacheControl cache = page.getError() != null
                ? CacheControl.noStore()
                : CacheControl.maxAge(Duration.ofMinutes(1)).cachePrivate().mustRevalidate();
        return ResponseEntity.ok()
                .cacheControl(cache)
                .header("Vary", "Accept-Encoding")
                .body(page);
    }

    @GetMapping("/webcams/{id}")
    public ResponseEntity<?> webcam(
            @PathVariable("id") String id,
            @RequestParam(value = "lang", required = false, defaultValue = "en") String lang) {
        if (!windyWebcamCatalogService.isConfigured()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of(
                    "error", "missing_api_key",
                    "message", "Configure app.webcam.windy-api-key"
            ));
        }
        Optional<WebcamItemDto> item = windyWebcamCatalogService.getWebcam(id, lang);
        if (item.isEmpty()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not_found"));
        }
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(2)).cachePublic())
                .body(item.get());
    }
}
