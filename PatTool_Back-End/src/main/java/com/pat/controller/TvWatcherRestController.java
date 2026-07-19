package com.pat.controller;

import com.pat.controller.dto.TvChannelDto;
import com.pat.controller.dto.TvCountryDto;
import com.pat.controller.dto.TvFavoritesDto;
import com.pat.service.CanalGroupLiveService;
import com.pat.service.FranceTvLiveService;
import com.pat.service.RadioFranceLiveService;
import com.pat.service.Tf1LiveService;
import com.pat.service.TvCatalogService;
import com.pat.service.TvFavoritesService;
import com.pat.service.TvLastChannelService;
import com.pat.service.TvStreamProxyService;
import jakarta.servlet.http.HttpServletRequest;
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

import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * Free worldwide IPTV (iptv-org) catalog + HLS stream proxy for the TV watcher page.
 * <p>
 * Public read-only:
 * <ul>
 *   <li>{@code GET /api/external/tv/countries}</li>
 *   <li>{@code GET /api/external/tv/channels?country=fr&amp;q=...&amp;group=...}</li>
 *   <li>{@code GET /api/external/tv/stream/{base64url}}</li>
 * </ul>
 * Authenticated (per JWT subject):
 * <ul>
 *   <li>{@code GET/PUT /api/external/tv/favorites}</li>
 *   <li>{@code PUT /api/external/tv/favorites/item} — add one channel</li>
 *   <li>{@code DELETE /api/external/tv/favorites/item?id=...}</li>
 *   <li>{@code GET/PUT /api/external/tv/last-channel} — last watched channel</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/tv")
public class TvWatcherRestController {

    @Autowired
    private TvCatalogService tvCatalogService;

    @Autowired
    private TvStreamProxyService tvStreamProxyService;

    @Autowired
    private TvFavoritesService tvFavoritesService;

    @Autowired
    private TvLastChannelService tvLastChannelService;

    @Autowired
    private FranceTvLiveService franceTvLiveService;

    @Autowired
    private Tf1LiveService tf1LiveService;

    @Autowired
    private CanalGroupLiveService canalGroupLiveService;

    @Autowired
    private RadioFranceLiveService radioFranceLiveService;

    @GetMapping("/countries")
    public ResponseEntity<List<TvCountryDto>> countries() {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofHours(12)).cachePublic())
                .body(tvCatalogService.listCountries());
    }

    @GetMapping("/channels")
    public ResponseEntity<?> channels(
            @RequestParam(defaultValue = "fr") String country,
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String group) {
        if (!tvCatalogService.isSupportedCountry(country)) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid country code"));
        }
        List<TvChannelDto> channels = tvCatalogService.listChannels(country);
        String query = q != null ? q.trim().toLowerCase(Locale.ROOT) : "";
        String groupFilter = group != null ? group.trim().toLowerCase(Locale.ROOT) : "";

        List<TvChannelDto> filtered = channels.stream()
                .filter(ch -> query.isEmpty()
                        || (ch.getName() != null && ch.getName().toLowerCase(Locale.ROOT).contains(query))
                        || (ch.getGroup() != null && ch.getGroup().toLowerCase(Locale.ROOT).contains(query)))
                .filter(ch -> groupFilter.isEmpty()
                        || (ch.getGroup() != null && ch.getGroup().toLowerCase(Locale.ROOT).contains(groupFilter)))
                .collect(Collectors.toList());

        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(5)).cachePublic())
                .body(filtered);
    }

    @GetMapping("/groups")
    public ResponseEntity<?> groups(@RequestParam(defaultValue = "fr") String country) {
        if (!tvCatalogService.isSupportedCountry(country)) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid country code"));
        }
        List<String> groups = tvCatalogService.listChannels(country).stream()
                .map(TvChannelDto::getGroup)
                .filter(StringUtils::hasText)
                .map(g -> g.split(";")[0].trim())
                .filter(StringUtils::hasText)
                .distinct()
                .sorted(String.CASE_INSENSITIVE_ORDER)
                .collect(Collectors.toList());
        return ResponseEntity.ok(groups);
    }

    @GetMapping("/favorites")
    public ResponseEntity<TvFavoritesDto> getFavorites() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(tvFavoritesService.findForSubject(sub));
    }

    @PutMapping("/favorites")
    public ResponseEntity<?> putFavorites(@RequestBody TvFavoritesDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(tvFavoritesService.saveForSubject(sub, body));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    /** Add one channel to the current user's favorites. */
    @PutMapping("/favorites/item")
    public ResponseEntity<?> addFavorite(@RequestBody TvChannelDto channel) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(tvFavoritesService.addFavorite(sub, channel));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    /** Remove one channel from favorites by channel id. */
    @DeleteMapping("/favorites/item")
    public ResponseEntity<TvFavoritesDto> removeFavorite(@RequestParam("id") String id) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(tvFavoritesService.removeFavorite(sub, id));
    }

    /** Last watched channel for the current user (empty body when none). */
    @GetMapping("/last-channel")
    public ResponseEntity<TvChannelDto> getLastChannel() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        TvChannelDto channel = tvLastChannelService.findForSubject(sub);
        if (channel == null) {
            return ResponseEntity.noContent().build();
        }
        return ResponseEntity.ok(channel);
    }

    /** Persist the last watched channel for the current user. */
    @PutMapping("/last-channel")
    public ResponseEntity<?> putLastChannel(@RequestBody TvChannelDto channel) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(tvLastChannelService.saveForSubject(sub, channel));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    /**
     * Proxy an upstream media URL. Path segment is Base64-URL (no padding) of the absolute URL.
     */
    @GetMapping(value = "/stream/{encodedUrl:.+}")
    public ResponseEntity<byte[]> stream(
            @PathVariable("encodedUrl") String encodedUrl,
            @RequestHeader(value = "Range", required = false) String range,
            HttpServletRequest request) {
        Optional<String> upstream = TvStreamProxyService.decodeUpstreamUrl(encodedUrl);
        if (upstream.isEmpty()) {
            return ResponseEntity.badRequest().build();
        }
        Optional<String> resolved = resolveLiveUpstream(upstream.get());
        if (resolved.isEmpty() || !StringUtils.hasText(resolved.get())) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
        String proxyBase = buildProxyBase(request);
        return tvStreamProxyService.proxy(resolved.get(), proxyBase, range);
    }

    /**
     * Convenience: {@code GET /stream?url=https://...} (URL-encoded). Prefer the path form for HLS.
     */
    @GetMapping(value = "/stream", produces = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<byte[]> streamQuery(
            @RequestParam("url") String url,
            @RequestHeader(value = "Range", required = false) String range,
            HttpServletRequest request) {
        if (!StringUtils.hasText(url)) {
            return ResponseEntity.badRequest().build();
        }
        String trimmed = url.trim();
        if (!(trimmed.startsWith("http://") || trimmed.startsWith("https://")
                || FranceTvLiveService.isVirtualUrl(trimmed)
                || Tf1LiveService.isVirtualUrl(trimmed)
                || CanalGroupLiveService.isVirtualUrl(trimmed)
                || RadioFranceLiveService.isVirtualUrl(trimmed))) {
            return ResponseEntity.badRequest().build();
        }
        Optional<String> resolved = resolveLiveUpstream(trimmed);
        if (resolved.isEmpty() || !StringUtils.hasText(resolved.get())) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
        String proxyBase = buildProxyBase(request);
        return tvStreamProxyService.proxy(resolved.get(), proxyBase, range);
    }

    /** Resolve a france.tv live channel to a fresh signed HLS URL (JSON). */
    @GetMapping("/live/francetv/{slug}")
    public ResponseEntity<?> resolveFranceTv(@PathVariable("slug") String slug) {
        Optional<String> hls = franceTvLiveService.resolveHlsUrl(slug);
        if (hls.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body(Map.of("error", "Unable to resolve france.tv live stream"));
        }
        return ResponseEntity.ok(Map.of(
                "slug", slug,
                "streamUrl", hls.get(),
                "virtualUrl", FranceTvLiveService.virtualUrl(slug)
        ));
    }

    /** Whether TF1 account credentials are configured (required for TF1/TMC/TFX). */
    @GetMapping("/live/tf1/status")
    public ResponseEntity<Map<String, Object>> tf1Status() {
        return ResponseEntity.ok(Map.of(
                "configured", tf1LiveService.isConfigured(),
                "channels", List.of("tf1", "tmc", "tfx", "lci")
        ));
    }

    @GetMapping("/live/tf1/{slug}")
    public ResponseEntity<?> resolveTf1(@PathVariable("slug") String slug) {
        if (tf1LiveService.findChannel(slug).isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "Unknown TF1 channel"));
        }
        boolean needsAuth = tf1LiveService.findChannel(slug).map(Tf1LiveService.ChannelDef::requiresAuth).orElse(true);
        if (needsAuth && !tf1LiveService.isConfigured()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of(
                    "error", "tf1_credentials_missing",
                    "message", "Set app.tv.tf1.email and app.tv.tf1.password (free TF1 account) in application.properties"
            ));
        }
        Optional<String> hls = tf1LiveService.resolveHlsUrl(slug);
        if (hls.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body(Map.of("error", "Unable to resolve TF1 live stream"));
        }
        return ResponseEntity.ok(Map.of(
                "slug", slug,
                "streamUrl", hls.get(),
                "virtualUrl", Tf1LiveService.virtualUrl(slug)
        ));
    }

    /** Resolve CNews / CStar live HLS via Dailymotion metadata (JSON). */
    @GetMapping("/live/canalgroup/{slug}")
    public ResponseEntity<?> resolveCanalGroup(@PathVariable("slug") String slug) {
        if (canalGroupLiveService.findChannel(slug).isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "Unknown Canal group channel"));
        }
        Optional<String> hls = canalGroupLiveService.resolveHlsUrl(slug);
        if (hls.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body(Map.of("error", "Unable to resolve Canal group live stream"));
        }
        return ResponseEntity.ok(Map.of(
                "slug", slug,
                "streamUrl", hls.get(),
                "virtualUrl", CanalGroupLiveService.virtualUrl(slug)
        ));
    }

    /** Resolve Radio France live HLS (JSON). */
    @GetMapping("/live/radiofrance/{slug}")
    public ResponseEntity<?> resolveRadioFrance(@PathVariable("slug") String slug) {
        if (radioFranceLiveService.findChannel(slug).isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "Unknown Radio France station"));
        }
        Optional<String> hls = radioFranceLiveService.resolveHlsUrl(slug);
        if (hls.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body(Map.of("error", "Unable to resolve Radio France live stream"));
        }
        return ResponseEntity.ok(Map.of(
                "slug", slug,
                "streamUrl", hls.get(),
                "virtualUrl", RadioFranceLiveService.virtualUrl(slug)
        ));
    }

    private Optional<String> resolveLiveUpstream(String url) {
        if (Tf1LiveService.isVirtualUrl(url)) {
            return tf1LiveService.resolveVirtualOrPassthrough(url);
        }
        if (FranceTvLiveService.isVirtualUrl(url)) {
            return franceTvLiveService.resolveVirtualOrPassthrough(url);
        }
        if (CanalGroupLiveService.isVirtualUrl(url)) {
            return canalGroupLiveService.resolveVirtualOrPassthrough(url);
        }
        if (RadioFranceLiveService.isVirtualUrl(url)) {
            return radioFranceLiveService.resolveVirtualOrPassthrough(url);
        }
        return Optional.of(url);
    }

    private static String buildProxyBase(HttpServletRequest request) {
        String forwardedProto = request.getHeader("X-Forwarded-Proto");
        String forwardedHost = request.getHeader("X-Forwarded-Host");
        String scheme = StringUtils.hasText(forwardedProto) ? forwardedProto : request.getScheme();
        String host = StringUtils.hasText(forwardedHost) ? forwardedHost : request.getHeader("Host");
        if (!StringUtils.hasText(host)) {
            host = request.getServerName() + (request.getServerPort() > 0 ? ":" + request.getServerPort() : "");
        }
        return scheme + "://" + host + "/api/external/tv/stream/";
    }

    private static String currentJwtSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        return jwt.getSubject();
    }
}
