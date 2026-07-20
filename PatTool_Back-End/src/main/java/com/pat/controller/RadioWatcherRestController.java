package com.pat.controller;

import com.pat.controller.dto.RadioCountryDto;
import com.pat.controller.dto.RadioFavoritesDto;
import com.pat.controller.dto.RadioStationDto;
import com.pat.service.RadioCatalogService;
import com.pat.service.RadioFavoritesService;
import com.pat.service.RadioLastStationService;
import com.pat.service.RadioStreamProxyService;
import com.pat.service.TvStreamProxyService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
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
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * Worldwide internet radio catalog (radio-browser.info) + stream proxy for the Radio watcher page.
 * <p>
 * Public read-only:
 * <ul>
 *   <li>{@code GET /api/external/radio/countries}</li>
 *   <li>{@code GET /api/external/radio/stations?country=fr&amp;q=...&amp;tag=...}</li>
 *   <li>{@code GET /api/external/radio/stream/{base64url}}</li>
 * </ul>
 * Authenticated (per JWT subject):
 * <ul>
 *   <li>{@code GET/PUT /api/external/radio/favorites}</li>
 *   <li>{@code PUT/DELETE /api/external/radio/favorites/item}</li>
 *   <li>{@code GET/PUT /api/external/radio/last-station}</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/radio")
public class RadioWatcherRestController {

    @Autowired
    private RadioCatalogService radioCatalogService;

    @Autowired
    private RadioStreamProxyService radioStreamProxyService;

    @Autowired
    private RadioFavoritesService radioFavoritesService;

    @Autowired
    private RadioLastStationService radioLastStationService;

    @GetMapping("/countries")
    public ResponseEntity<List<RadioCountryDto>> countries() {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(5)).cachePublic().mustRevalidate())
                .body(radioCatalogService.listCountries());
    }

    @GetMapping("/station-count")
    public ResponseEntity<Map<String, Object>> stationCount(
            @RequestParam(defaultValue = "all") String country) {
        if (!radioCatalogService.isAllCountries(country) && !radioCatalogService.isSupportedCountry(country)) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid country code"));
        }
        int count = radioCatalogService.countStations(country);
        String code = radioCatalogService.isAllCountries(country) ? "all" : country.trim().toLowerCase(Locale.ROOT);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(10)).cachePublic())
                .body(Map.of("country", code, "count", count));
    }

    @GetMapping("/stations")
    public ResponseEntity<?> stations(
            @RequestParam(defaultValue = "fr") String country,
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String tag,
            @RequestParam(required = false, defaultValue = "200") int limit) {
        if (radioCatalogService.isAllCountries(country)) {
            String query = q != null ? q.trim() : "";
            if (query.length() < 2) {
                return ResponseEntity.ok()
                        .cacheControl(CacheControl.noStore())
                        .body(List.of());
            }
            List<RadioStationDto> worldwide = radioCatalogService.searchAllCountries(query, tag, limit);
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.maxAge(Duration.ofMinutes(2)).cachePublic())
                    .body(worldwide);
        }
        if (!radioCatalogService.isSupportedCountry(country)) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid country code"));
        }
        List<RadioStationDto> stations = radioCatalogService.listStations(country);
        String query = q != null ? q.trim().toLowerCase(Locale.ROOT) : "";
        String tagFilter = tag != null ? tag.trim().toLowerCase(Locale.ROOT) : "";

        List<RadioStationDto> filtered = stations.stream()
                .filter(st -> query.isEmpty()
                        || (st.getName() != null && st.getName().toLowerCase(Locale.ROOT).contains(query))
                        || (st.getTags() != null && st.getTags().toLowerCase(Locale.ROOT).contains(query)))
                .filter(st -> tagFilter.isEmpty()
                        || (st.getTags() != null && st.getTags().toLowerCase(Locale.ROOT).contains(tagFilter)))
                .limit(Math.max(1, Math.min(limit, 500)))
                .collect(Collectors.toList());

        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(5)).cachePublic())
                .body(filtered);
    }

    @GetMapping("/tags")
    public ResponseEntity<?> tags(@RequestParam(defaultValue = "fr") String country) {
        if (radioCatalogService.isAllCountries(country)) {
            return ResponseEntity.ok(List.of());
        }
        if (!radioCatalogService.isSupportedCountry(country)) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid country code"));
        }
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(10)).cachePublic())
                .body(radioCatalogService.listTags(country));
    }

    @GetMapping("/stations/{id}")
    public ResponseEntity<?> stationById(@PathVariable("id") String id) {
        return radioCatalogService.findById(id)
                .<ResponseEntity<?>>map(st -> ResponseEntity.ok()
                        .cacheControl(CacheControl.maxAge(Duration.ofMinutes(30)).cachePublic())
                        .body(st))
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/favorites")
    public ResponseEntity<RadioFavoritesDto> getFavorites() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(radioFavoritesService.findForSubject(sub));
    }

    @PutMapping("/favorites")
    public ResponseEntity<?> putFavorites(@RequestBody RadioFavoritesDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(radioFavoritesService.saveForSubject(sub, body));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @PutMapping("/favorites/item")
    public ResponseEntity<?> addFavorite(@RequestBody RadioStationDto station) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(radioFavoritesService.addFavorite(sub, station));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @DeleteMapping("/favorites/item")
    public ResponseEntity<RadioFavoritesDto> removeFavorite(@RequestParam("id") String id) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(radioFavoritesService.removeFavorite(sub, id));
    }

    @GetMapping("/last-station")
    public ResponseEntity<RadioStationDto> getLastStation() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        RadioStationDto station = radioLastStationService.findForSubject(sub);
        if (station == null) {
            return ResponseEntity.noContent().build();
        }
        return ResponseEntity.ok(station);
    }

    @PutMapping("/last-station")
    public ResponseEntity<?> putLastStation(@RequestBody RadioStationDto station) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(radioLastStationService.saveForSubject(sub, station));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping(value = "/stream/{encodedUrl:.+}")
    public void stream(
            @PathVariable("encodedUrl") String encodedUrl,
            @RequestHeader(value = "Range", required = false) String range,
            HttpServletRequest request,
            HttpServletResponse response) throws IOException {
        Optional<String> upstream = TvStreamProxyService.decodeUpstreamUrl(encodedUrl);
        if (upstream.isEmpty()) {
            response.setStatus(HttpStatus.BAD_REQUEST.value());
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            response.getOutputStream().write(
                    "{\"error\":\"invalid_encoded_url\",\"message\":\"URL de flux encodée invalide\"}"
                            .getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return;
        }
        String proxyBase = buildProxyBase(request);
        radioStreamProxyService.proxyRadio(upstream.get(), proxyBase, range, response);
    }

    @GetMapping(value = "/stream")
    public void streamQuery(
            @RequestParam("url") String url,
            @RequestHeader(value = "Range", required = false) String range,
            HttpServletRequest request,
            HttpServletResponse response) throws IOException {
        if (!StringUtils.hasText(url)) {
            response.setStatus(HttpStatus.BAD_REQUEST.value());
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            response.getOutputStream().write(
                    "{\"error\":\"missing_url\",\"message\":\"URL de flux manquante\"}"
                            .getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return;
        }
        String trimmed = url.trim();
        if (!(trimmed.startsWith("http://") || trimmed.startsWith("https://"))) {
            response.setStatus(HttpStatus.BAD_REQUEST.value());
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            response.getOutputStream().write(
                    "{\"error\":\"invalid_url\",\"message\":\"L’URL doit être http(s)\"}"
                            .getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return;
        }
        String proxyBase = buildProxyBase(request);
        radioStreamProxyService.proxyRadio(trimmed, proxyBase, range, response);
    }

    private String buildProxyBase(HttpServletRequest request) {
        String forwardedProto = request.getHeader("X-Forwarded-Proto");
        String forwardedHost = request.getHeader("X-Forwarded-Host");
        String scheme = StringUtils.hasText(forwardedProto) ? forwardedProto : request.getScheme();
        String host = StringUtils.hasText(forwardedHost) ? forwardedHost : request.getServerName();
        int port = request.getServerPort();
        boolean defaultPort = ("http".equalsIgnoreCase(scheme) && port == 80)
                || ("https".equalsIgnoreCase(scheme) && port == 443)
                || StringUtils.hasText(forwardedHost);
        String portPart = defaultPort ? "" : (":" + port);
        String context = request.getContextPath() != null ? request.getContextPath() : "";
        return scheme + "://" + host + portPart + context + "/api/external/radio/stream/";
    }

    private String currentJwtSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        String sub = jwt.getSubject();
        return StringUtils.hasText(sub) ? sub.trim() : null;
    }
}
