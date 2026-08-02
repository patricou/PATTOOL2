package com.pat.controller;

import com.pat.controller.dto.WebcamCodeLabelDto;
import com.pat.controller.dto.WebcamFavoritesDto;
import com.pat.controller.dto.WebcamItemDto;
import com.pat.controller.dto.WebcamSearchPageDto;
import com.pat.service.NapspanWebcamCatalogService;
import com.pat.service.Road511WebcamCatalogService;
import com.pat.service.WebcamFavoritesService;
import com.pat.service.WebcamLastService;
import com.pat.service.WindyWebcamCatalogService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Worldwide webcams via Windy, US/Canada DOT via Road511, Europe NAPs via NAPSPAN.
 * <p>
 * Public read-only catalog endpoints; authenticated {@code GET/PUT /last} and
 * {@code /favorites} per JWT subject.
 */
@RestController
@RequestMapping("/api/external/webcam")
public class WebcamWatcherRestController {

    @Autowired
    private WindyWebcamCatalogService windyWebcamCatalogService;

    @Autowired
    private Road511WebcamCatalogService road511WebcamCatalogService;

    @Autowired
    private NapspanWebcamCatalogService napspanWebcamCatalogService;

    @Autowired
    private WebcamLastService webcamLastService;

    @Autowired
    private WebcamFavoritesService webcamFavoritesService;

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

    /** Last opened webcam for the current user (empty body when none). */
    @GetMapping("/last")
    public ResponseEntity<WebcamItemDto> getLastWebcam() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        WebcamItemDto webcam = webcamLastService.findForSubject(sub);
        if (webcam == null) {
            return ResponseEntity.noContent().build();
        }
        return ResponseEntity.ok(webcam);
    }

    /** Persist the last opened webcam for the current user. */
    @PutMapping("/last")
    public ResponseEntity<?> putLastWebcam(@RequestBody WebcamItemDto webcam) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(webcamLastService.saveForSubject(sub, webcam));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping("/favorites")
    public ResponseEntity<WebcamFavoritesDto> getFavorites() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(webcamFavoritesService.findForSubject(sub));
    }

    @PutMapping("/favorites")
    public ResponseEntity<?> putFavorites(@RequestBody WebcamFavoritesDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(webcamFavoritesService.saveForSubject(sub, body));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    /** Add one webcam to the current user's favorites. */
    @PutMapping("/favorites/item")
    public ResponseEntity<?> addFavorite(@RequestBody WebcamItemDto webcam) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(webcamFavoritesService.addFavorite(sub, webcam));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    /** Remove one webcam from favorites by id (optional provider to disambiguate). */
    @DeleteMapping("/favorites/item")
    public ResponseEntity<WebcamFavoritesDto> removeFavorite(
            @RequestParam("id") String id,
            @RequestParam(value = "provider", required = false) String provider) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(webcamFavoritesService.removeFavorite(sub, id, provider));
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
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "sortKey", required = false, defaultValue = "popularity") String sortKey,
            @RequestParam(value = "sortDirection", required = false, defaultValue = "desc") String sortDirection,
            @RequestParam(value = "limit", required = false, defaultValue = "24") int limit,
            @RequestParam(value = "offset", required = false, defaultValue = "0") int offset,
            @RequestParam(value = "lang", required = false, defaultValue = "en") String lang) {
        WebcamSearchPageDto page = windyWebcamCatalogService.search(
                countries, continents, categories, nearby, q, sortKey, sortDirection, limit, offset, lang);
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

    @GetMapping("/traffic/status")
    public ResponseEntity<Map<String, Object>> trafficStatus() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("configured", road511WebcamCatalogService.isConfigured());
        body.put("provider", "road511");
        body.put("docs", "https://road511.com/docs.html");
        body.put("keys", "https://portal.road511.com");
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(1)).cachePublic())
                .body(body);
    }

    @GetMapping("/traffic/jurisdictions")
    public ResponseEntity<Map<String, Object>> trafficJurisdictions() {
        List<WebcamCodeLabelDto> jurisdictions = road511WebcamCatalogService.jurisdictions();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("jurisdictions", jurisdictions);
        body.put("configured", road511WebcamCatalogService.isConfigured());
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofHours(6)).cachePublic())
                .body(body);
    }

    @GetMapping("/traffic/cameras")
    public ResponseEntity<WebcamSearchPageDto> trafficCameras(
            @RequestParam(value = "jurisdiction", required = false) String jurisdiction,
            @RequestParam(value = "nearby", required = false) String nearby,
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "hasVideo", required = false, defaultValue = "false") boolean hasVideo,
            @RequestParam(value = "limit", required = false, defaultValue = "24") int limit,
            @RequestParam(value = "offset", required = false, defaultValue = "0") int offset) {
        WebcamSearchPageDto page = road511WebcamCatalogService.search(
                jurisdiction, nearby, q, hasVideo, limit, offset);
        CacheControl cache = page.getError() != null
                ? CacheControl.noStore()
                : CacheControl.maxAge(Duration.ofMinutes(1)).cachePrivate().mustRevalidate();
        return ResponseEntity.ok()
                .cacheControl(cache)
                .header("Vary", "Accept-Encoding")
                .body(page);
    }

    @GetMapping("/traffic/cameras/{id:.+}")
    public ResponseEntity<?> trafficCamera(@PathVariable("id") String id) {
        if (!road511WebcamCatalogService.isConfigured()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of(
                    "error", "missing_api_key",
                    "message", "Configure app.webcam.road511-api-key"
            ));
        }
        Optional<WebcamItemDto> item = road511WebcamCatalogService.getCamera(id);
        if (item.isEmpty()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not_found"));
        }
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(2)).cachePublic())
                .body(item.get());
    }

    // --- NAPSPAN / Europe traffic cameras ------------------------------------------------------

    @GetMapping("/europe/status")
    public ResponseEntity<Map<String, Object>> europeStatus() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("configured", napspanWebcamCatalogService.isConfigured());
        body.put("provider", "napspan");
        body.put("docs", "https://napspan.com/docs.html");
        body.put("keys", "https://portal.napspan.com");
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(1)).cachePublic())
                .body(body);
    }

    @GetMapping("/europe/jurisdictions")
    public ResponseEntity<Map<String, Object>> europeJurisdictions() {
        List<WebcamCodeLabelDto> jurisdictions = napspanWebcamCatalogService.jurisdictions();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("jurisdictions", jurisdictions);
        body.put("configured", napspanWebcamCatalogService.isConfigured());
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofHours(6)).cachePublic())
                .body(body);
    }

    @GetMapping("/europe/cameras")
    public ResponseEntity<WebcamSearchPageDto> europeCameras(
            @RequestParam(value = "jurisdiction", required = false) String jurisdiction,
            @RequestParam(value = "nearby", required = false) String nearby,
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "hasVideo", required = false, defaultValue = "false") boolean hasVideo,
            @RequestParam(value = "limit", required = false, defaultValue = "24") int limit,
            @RequestParam(value = "offset", required = false, defaultValue = "0") int offset) {
        WebcamSearchPageDto page = napspanWebcamCatalogService.search(
                jurisdiction, nearby, q, hasVideo, limit, offset);
        CacheControl cache = page.getError() != null
                ? CacheControl.noStore()
                : CacheControl.maxAge(Duration.ofMinutes(1)).cachePrivate().mustRevalidate();
        return ResponseEntity.ok()
                .cacheControl(cache)
                .header("Vary", "Accept-Encoding")
                .body(page);
    }

    @GetMapping("/europe/cameras/{id:.+}")
    public ResponseEntity<?> europeCamera(@PathVariable("id") String id) {
        if (!napspanWebcamCatalogService.isConfigured()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of(
                    "error", "missing_api_key",
                    "message", "Configure app.webcam.napspan-api-key"
            ));
        }
        Optional<WebcamItemDto> item = napspanWebcamCatalogService.getCamera(id);
        if (item.isEmpty()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not_found"));
        }
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(2)).cachePublic())
                .body(item.get());
    }

    private static String currentJwtSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        String sub = jwt.getSubject();
        return StringUtils.hasText(sub) ? sub.trim() : null;
    }
}
