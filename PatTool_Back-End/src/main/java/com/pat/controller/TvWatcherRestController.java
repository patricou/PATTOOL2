package com.pat.controller;

import com.pat.controller.dto.TvChannelDto;
import com.pat.controller.dto.TvCountryDto;
import com.pat.controller.dto.TvEpgBrowseChannelDto;
import com.pat.controller.dto.TvEpgNowDto;
import com.pat.controller.dto.TvEpgScheduleDto;
import com.pat.controller.dto.TvEpgSearchHitDto;
import com.pat.controller.dto.TvFavoritesDto;
import com.pat.controller.dto.TvRecordingDto;
import com.pat.controller.dto.TvRecordingRenameRequest;
import com.pat.controller.dto.TvRecordingStartRequest;
import com.pat.service.ArteReplayService;
import com.pat.service.CanalGroupLiveService;
import com.pat.service.FranceTvLiveService;
import com.pat.service.InternetArchiveReplayService;
import com.pat.service.M6GroupLiveService;
import com.pat.service.RadioFranceLiveService;
import com.pat.service.Tf1LiveService;
import com.pat.service.TvCatalogService;
import com.pat.service.TvEpgService;
import com.pat.service.TvFavoritesService;
import com.pat.service.TvLastChannelService;
import com.pat.service.TvRecordingService;
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
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.function.BiFunction;
import java.util.stream.Collectors;

/**
 * Free worldwide IPTV (iptv-org) catalog + HLS stream proxy for the TV watcher page.
 * <p>
 * Public read-only:
 * <ul>
 *   <li>{@code GET /api/external/tv/countries}</li>
 *   <li>{@code GET /api/external/tv/channels?country=fr&amp;q=...&amp;group=...}</li>
 *   <li>{@code GET /api/external/tv/epg/now}</li>
 *   <li>{@code GET /api/external/tv/epg/schedule}</li>
 *   <li>{@code GET /api/external/tv/epg/search}</li>
 *   <li>{@code GET /api/external/tv/stream/{base64url}}</li>
 *   <li>{@code GET /api/external/tv/arte/sections}</li>
 *   <li>{@code GET /api/external/tv/arte/programs}</li>
 *   <li>{@code GET /api/external/tv/arte/resolve/{programId}}</li>
 *   <li>{@code GET /api/external/tv/ia/sections}</li>
 *   <li>{@code GET /api/external/tv/ia/programs}</li>
 *   <li>{@code GET /api/external/tv/ia/resolve/{identifier}}</li>
 * </ul>
 * Authenticated (per JWT subject):
 * <ul>
 *   <li>{@code GET/PUT /api/external/tv/favorites}</li>
 *   <li>{@code PUT /api/external/tv/favorites/item} — add one channel</li>
 *   <li>{@code DELETE /api/external/tv/favorites/item?id=...}</li>
 *   <li>{@code GET/PUT /api/external/tv/last-channel} — last watched channel</li>
 *   <li>{@code GET/POST /api/external/tv/recordings} — browser DVR upload (GridFS)</li>
 *   <li>{@code PATCH /api/external/tv/recordings/{id}} — rename</li>
 *   <li>{@code DELETE /api/external/tv/recordings/{id}}</li>
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

    @Autowired
    private M6GroupLiveService m6GroupLiveService;

    @Autowired
    private ArteReplayService arteReplayService;

    @Autowired
    private InternetArchiveReplayService internetArchiveReplayService;

    @Autowired
    private TvEpgService tvEpgService;

    @Autowired
    private TvRecordingService tvRecordingService;

    @GetMapping("/countries")
    public ResponseEntity<List<TvCountryDto>> countries() {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(5)).cachePublic().mustRevalidate())
                .body(tvCatalogService.listCountries());
    }

    /**
     * Channel count for a country, or worldwide total when {@code country=all}.
     */
    @GetMapping("/channel-count")
    public ResponseEntity<Map<String, Object>> channelCount(
            @RequestParam(defaultValue = "all") String country) {
        if (!tvCatalogService.isAllCountries(country) && !tvCatalogService.isSupportedCountry(country)) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid country code"));
        }
        int count = tvCatalogService.countChannels(country);
        String code = tvCatalogService.isAllCountries(country) ? "all" : country.trim().toLowerCase(Locale.ROOT);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(10)).cachePublic())
                .body(Map.of("country", code, "count", count));
    }

    @GetMapping("/channels")
    public ResponseEntity<?> channels(
            @RequestParam(defaultValue = "fr") String country,
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String group,
            @RequestParam(required = false, defaultValue = "10000") int limit) {
        if (tvCatalogService.isAllCountries(country)) {
            String query = q != null ? q.trim() : "";
            String groupFilter = group != null ? group.trim() : "";
            int safeLimit = Math.max(1, Math.min(limit <= 0 ? TvCatalogService.WORLDWIDE_SEARCH_MAX : limit,
                    TvCatalogService.WORLDWIDE_SEARCH_MAX));
            if (query.length() < 2 && groupFilter.isEmpty()) {
                return ResponseEntity.ok()
                        .cacheControl(CacheControl.noStore())
                        .body(Map.of(
                                "channels", List.of(),
                                "total", 0,
                                "limit", safeLimit,
                                "truncated", false
                        ));
            }
            TvCatalogService.TvChannelSearchResult worldwide =
                    tvCatalogService.searchAllCountries(query, groupFilter, safeLimit);
            boolean truncated = worldwide.total() > worldwide.channels().size();
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.maxAge(Duration.ofMinutes(2)).cachePublic())
                    .body(Map.of(
                            "channels", worldwide.channels(),
                            "total", worldwide.total(),
                            "limit", worldwide.limit(),
                            "truncated", truncated
                    ));
        }
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
        if (tvCatalogService.isAllCountries(country)) {
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.maxAge(Duration.ofMinutes(10)).cachePublic())
                    .body(tvCatalogService.listGroups("all"));
        }
        if (!tvCatalogService.isSupportedCountry(country)) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid country code"));
        }
        return ResponseEntity.ok(tvCatalogService.listGroups(country));
    }

    /**
     * Now / next programmes for channel XMLTV ids (comma-separated).
     * Example: {@code GET /epg/now?country=fr&ids=TF1.fr,M6.fr,France2.fr}
     */
    @GetMapping("/epg/now")
    public ResponseEntity<Map<String, TvEpgNowDto>> epgNow(
            @RequestParam(defaultValue = "fr") String country,
            @RequestParam("ids") String ids) {
        if (!StringUtils.hasText(ids)) {
            return ResponseEntity.ok(Map.of());
        }
        List<String> idList = Arrays.stream(ids.split(","))
                .map(String::trim)
                .filter(StringUtils::hasText)
                .collect(Collectors.toList());
        Map<String, TvEpgNowDto> result = tvEpgService.nowForIds(country, idList);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(2)).cachePublic())
                .body(result);
    }

    /**
     * Browse programmes by TV for one country (now/next overview).
     * Optional {@code q} filters by channel name / EPG id <strong>or</strong> programme title.
     * Example: {@code GET /epg/browse?country=fr&q=jt&limit=120}
     */
    @GetMapping("/epg/browse")
    public ResponseEntity<List<TvEpgBrowseChannelDto>> epgBrowse(
            @RequestParam(defaultValue = "fr") String country,
            @RequestParam(required = false) String q,
            @RequestParam(required = false, defaultValue = "120") int limit) {
        if (tvCatalogService.isAllCountries(country)) {
            return ResponseEntity.badRequest().build();
        }
        if (!tvCatalogService.isSupportedCountry(country)) {
            return ResponseEntity.badRequest().build();
        }
        String code = country.trim().toLowerCase(Locale.ROOT);
        Map<String, TvChannelDto> index = new HashMap<>();
        for (TvChannelDto ch : tvCatalogService.listChannels(code)) {
            String resolved = TvEpgService.resolveEpgChannelId(ch);
            if (StringUtils.hasText(resolved)) {
                index.putIfAbsent(resolved.toLowerCase(Locale.ROOT), ch);
            }
        }
        BiFunction<String, String, TvChannelDto> resolver =
                (cc, epgId) -> index.get(epgId != null ? epgId.toLowerCase(Locale.ROOT) : "");
        List<TvEpgBrowseChannelDto> rows = tvEpgService.browseChannels(code, q, limit, resolver);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(2)).cachePublic())
                .body(rows);
    }

    /**
     * Full EPG schedule for one channel (cached XMLTV window ≈ −6h … +36h).
     * Example: {@code GET /epg/schedule?country=fr&id=TF1.fr}
     */
    @GetMapping("/epg/schedule")
    public ResponseEntity<TvEpgScheduleDto> epgSchedule(
            @RequestParam(defaultValue = "fr") String country,
            @RequestParam("id") String id) {
        if (!StringUtils.hasText(id)) {
            return ResponseEntity.badRequest().build();
        }
        TvEpgScheduleDto schedule = tvEpgService.scheduleForId(country, id);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(5)).cachePublic())
                .body(schedule);
    }

    /**
     * Search programmes by title/description across the cached EPG window.
     * {@code country=all} scans major countries server-side.
     * Example: {@code GET /epg/search?country=fr&q=journal&limit=40}
     */
    @GetMapping("/epg/search")
    public ResponseEntity<List<TvEpgSearchHitDto>> epgSearch(
            @RequestParam(defaultValue = "fr") String country,
            @RequestParam("q") String q,
            @RequestParam(required = false, defaultValue = "40") int limit) {
        String query = q != null ? q.trim() : "";
        if (query.length() < 2) {
            return ResponseEntity.ok(List.of());
        }
        Map<String, Map<String, TvChannelDto>> epgIndexByCountry = new HashMap<>();
        BiFunction<String, String, TvChannelDto> resolver = (cc, epgId) -> {
            if (!StringUtils.hasText(epgId)) {
                return null;
            }
            Map<String, TvChannelDto> index = epgIndexByCountry.computeIfAbsent(cc, code -> {
                Map<String, TvChannelDto> map = new HashMap<>();
                if (!tvCatalogService.isSupportedCountry(code)) {
                    return map;
                }
                for (TvChannelDto ch : tvCatalogService.listChannels(code)) {
                    String resolved = TvEpgService.resolveEpgChannelId(ch);
                    if (StringUtils.hasText(resolved)) {
                        map.putIfAbsent(resolved.toLowerCase(Locale.ROOT), ch);
                    }
                }
                return map;
            });
            return index.get(epgId.toLowerCase(Locale.ROOT));
        };
        List<TvEpgSearchHitDto> hits = tvEpgService.searchProgrammes(country, query, limit, resolver);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(2)).cachePublic())
                .body(hits);
    }

    /** Recording capability / limits (public; start still requires JWT). */
    @GetMapping("/recordings/status")
    public ResponseEntity<Map<String, Object>> recordingsStatus() {
        return ResponseEntity.ok(tvRecordingService.statusInfo());
    }

    @GetMapping("/recordings")
    public ResponseEntity<List<TvRecordingDto>> listRecordings() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(tvRecordingService.listForSubject(sub));
    }

    @GetMapping("/recordings/{id}")
    public ResponseEntity<TvRecordingDto> getRecording(@PathVariable("id") String id) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return tvRecordingService.findForSubject(id, sub)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping(value = "/recordings", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<?> uploadRecording(
            @RequestPart("file") MultipartFile file,
            @RequestParam(value = "channelId", required = false) String channelId,
            @RequestParam(value = "channelName", required = false) String channelName,
            @RequestParam(value = "channelLogo", required = false) String channelLogo,
            @RequestParam(value = "country", required = false) String country,
            @RequestParam(value = "streamUrl", required = false) String streamUrl,
            @RequestParam(value = "durationSec", required = false) Integer durationSec) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        TvRecordingStartRequest meta = new TvRecordingStartRequest();
        meta.setChannelId(channelId);
        meta.setChannelName(channelName);
        meta.setChannelLogo(channelLogo);
        meta.setCountry(country);
        meta.setStreamUrl(streamUrl);
        meta.setDurationSec(durationSec);
        try {
            return ResponseEntity.status(HttpStatus.CREATED).body(tvRecordingService.upload(sub, meta, file));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of("error", e.getMessage()));
        }
    }

    @PatchMapping("/recordings/{id}")
    public ResponseEntity<?> renameRecording(
            @PathVariable("id") String id,
            @RequestBody TvRecordingRenameRequest body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            String name = body != null ? body.getChannelName() : null;
            return ResponseEntity.ok(tvRecordingService.rename(id, sub, name));
        } catch (IllegalArgumentException e) {
            if ("not_found".equals(e.getMessage())) {
                return ResponseEntity.notFound().build();
            }
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @DeleteMapping("/recordings/{id}")
    public ResponseEntity<?> deleteRecording(@PathVariable("id") String id) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            tvRecordingService.delete(id, sub);
            return ResponseEntity.noContent().build();
        } catch (IllegalArgumentException e) {
            return ResponseEntity.notFound().build();
        }
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
            return TvStreamProxyService.jsonError(HttpStatus.BAD_REQUEST, "invalid_encoded_url",
                    "URL de flux encodée invalide");
        }
        return proxyResolvedStream(upstream.get(), range, request);
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
            return TvStreamProxyService.jsonError(HttpStatus.BAD_REQUEST, "missing_url",
                    "URL de flux manquante");
        }
        String trimmed = url.trim();
        if (!(trimmed.startsWith("http://") || trimmed.startsWith("https://")
                || FranceTvLiveService.isVirtualUrl(trimmed)
                || Tf1LiveService.isVirtualUrl(trimmed)
                || CanalGroupLiveService.isVirtualUrl(trimmed)
                || RadioFranceLiveService.isVirtualUrl(trimmed)
                || M6GroupLiveService.isVirtualUrl(trimmed)
                || ArteReplayService.isVirtualUrl(trimmed)
                || InternetArchiveReplayService.isVirtualUrl(trimmed))) {
            return TvStreamProxyService.jsonError(HttpStatus.BAD_REQUEST, "invalid_url",
                    "L’URL doit être http(s) ou un flux live virtuel supporté");
        }
        return proxyResolvedStream(trimmed, range, request);
    }

    /**
     * Resolve virtual live URLs then proxy. On 401/403/404/5xx for france.tv / TF1 / M6,
     * invalidate the cached upstream and retry once with a fresh resolve (new token or mirror).
     */
    private ResponseEntity<byte[]> proxyResolvedStream(String upstream, String range, HttpServletRequest request) {
        ResponseEntity<byte[]> resolveError = resolveLiveUpstreamOrError(upstream);
        if (resolveError != null) {
            return resolveError;
        }
        Optional<String> resolved = resolveLiveUpstream(upstream);
        String proxyBase = buildProxyBase(request);
        String target = resolved.orElse(upstream);
        ResponseEntity<byte[]> first = tvStreamProxyService.proxy(target, proxyBase, range);
        if (!shouldRefreshVirtualLive(first, upstream)) {
            return first;
        }
        Optional<String> refreshed = refreshVirtualLiveUpstream(upstream);
        if (refreshed.isEmpty() || !StringUtils.hasText(refreshed.get())
                || isStillVirtualUrl(refreshed.get())) {
            return first;
        }
        if (refreshed.get().equalsIgnoreCase(target)) {
            return first;
        }
        return tvStreamProxyService.proxy(refreshed.get(), proxyBase, range);
    }

    private static boolean shouldRefreshVirtualLive(ResponseEntity<byte[]> response, String upstream) {
        if (response == null || !StringUtils.hasText(upstream)) {
            return false;
        }
        int code = response.getStatusCode().value();
        boolean bad = code == 401 || code == 403 || code == 404 || code >= 500;
        if (!bad) {
            return false;
        }
        return FranceTvLiveService.isVirtualUrl(upstream)
                || Tf1LiveService.isVirtualUrl(upstream)
                || M6GroupLiveService.isVirtualUrl(upstream)
                || ArteReplayService.isVirtualUrl(upstream)
                || InternetArchiveReplayService.isVirtualUrl(upstream);
    }

    private Optional<String> refreshVirtualLiveUpstream(String upstream) {
        if (FranceTvLiveService.isVirtualUrl(upstream)) {
            FranceTvLiveService.slugFromVirtualUrl(upstream).ifPresent(franceTvLiveService::invalidate);
            return franceTvLiveService.resolveVirtualOrPassthrough(upstream, true);
        }
        if (Tf1LiveService.isVirtualUrl(upstream)) {
            Tf1LiveService.slugFromVirtualUrl(upstream).ifPresent(tf1LiveService::invalidate);
            return tf1LiveService.resolveVirtualOrPassthrough(upstream, true);
        }
        if (M6GroupLiveService.isVirtualUrl(upstream)) {
            M6GroupLiveService.slugFromVirtualUrl(upstream).ifPresent(m6GroupLiveService::invalidate);
            return m6GroupLiveService.resolveVirtualOrPassthrough(upstream, true);
        }
        if (ArteReplayService.isVirtualUrl(upstream)) {
            ArteReplayService.programIdFromVirtualUrl(upstream)
                    .ifPresent(id -> arteReplayService.invalidate(id, "fr"));
            return arteReplayService.resolveVirtualOrPassthrough(upstream, true);
        }
        if (InternetArchiveReplayService.isVirtualUrl(upstream)) {
            InternetArchiveReplayService.identifierFromVirtualUrl(upstream)
                    .ifPresent(internetArchiveReplayService::invalidate);
            return internetArchiveReplayService.resolveVirtualOrPassthrough(upstream, true);
        }
        return Optional.empty();
    }

    private static boolean isStillVirtualUrl(String url) {
        return FranceTvLiveService.isVirtualUrl(url)
                || Tf1LiveService.isVirtualUrl(url)
                || CanalGroupLiveService.isVirtualUrl(url)
                || RadioFranceLiveService.isVirtualUrl(url)
                || M6GroupLiveService.isVirtualUrl(url)
                || ArteReplayService.isVirtualUrl(url)
                || InternetArchiveReplayService.isVirtualUrl(url);
    }

    /** Resolve a france.tv live channel to a fresh signed HLS URL (JSON). */
    @GetMapping("/live/francetv/{slug}")
    public ResponseEntity<?> resolveFranceTv(
            @PathVariable("slug") String slug,
            @RequestParam(value = "fresh", defaultValue = "false") boolean fresh) {
        Optional<String> hls = franceTvLiveService.resolveHlsUrl(slug, fresh);
        if (hls.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body(Map.of("error", "Unable to resolve france.tv live stream"));
        }
        String signed = hls.get();
        long expiresAtEpoch = FranceTvLiveService.parseAkamaiExpiry(signed)
                .map(Instant::getEpochSecond)
                .orElse(Instant.now().plus(Duration.ofMinutes(8)).getEpochSecond());
        return ResponseEntity.ok(Map.of(
                "slug", slug,
                "streamUrl", signed,
                "virtualUrl", FranceTvLiveService.virtualUrl(slug),
                "expiresAtEpoch", expiresAtEpoch
        ));
    }

    /** Whether TF1 account credentials are configured (preferred for official TF1+/TMC/TFX). */
    @GetMapping("/live/tf1/status")
    public ResponseEntity<Map<String, Object>> tf1Status() {
        return ResponseEntity.ok(Map.of(
                "configured", tf1LiveService.isConfigured(),
                "channels", List.of("tf1", "tmc", "tfx", "lci"),
                "mirrorsFallback", true
        ));
    }

    @GetMapping("/live/tf1/{slug}")
    public ResponseEntity<?> resolveTf1(
            @PathVariable("slug") String slug,
            @RequestParam(value = "fresh", defaultValue = "false") boolean fresh) {
        if (tf1LiveService.findChannel(slug).isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "Unknown TF1 channel"));
        }
        // Official path prefers credentials; IPTV mirrors are tried automatically when missing/invalid.
        Optional<String> hls = tf1LiveService.resolveHlsUrl(slug, fresh);
        if (hls.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of(
                    "error", "tf1_resolve_failed",
                    "message", "Impossible de résoudre le flux TF1 (API officielle et miroirs IPTV)"
            ));
        }
        long expiresAtEpoch = Instant.now().plus(Duration.ofMinutes(5)).getEpochSecond();
        return ResponseEntity.ok(Map.of(
                "slug", slug,
                "streamUrl", hls.get(),
                "virtualUrl", Tf1LiveService.virtualUrl(slug),
                "expiresAtEpoch", expiresAtEpoch
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

    /**
     * Resolve M6 / W9 / 6ter / Gulli via public IPTV mirrors (official M6+ is DRM-only).
     */
    @GetMapping("/live/m6group/{slug}")
    public ResponseEntity<?> resolveM6Group(
            @PathVariable("slug") String slug,
            @RequestParam(value = "fresh", defaultValue = "false") boolean fresh) {
        if (m6GroupLiveService.findChannel(slug).isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "Unknown M6 group channel"));
        }
        Optional<String> hls = m6GroupLiveService.resolveHlsUrl(slug, fresh);
        if (hls.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of(
                    "error", "m6group_resolve_failed",
                    "message", "M6+ officiel est protégé DRM — aucun miroir IPTV public disponible. "
                            + "Regardez sur https://www.m6.fr/m6/direct"
            ));
        }
        long expiresAtEpoch = Instant.now().plus(Duration.ofMinutes(5)).getEpochSecond();
        return ResponseEntity.ok(Map.of(
                "slug", slug,
                "streamUrl", hls.get(),
                "virtualUrl", M6GroupLiveService.virtualUrl(slug),
                "expiresAtEpoch", expiresAtEpoch
        ));
    }

    /**
     * ARTE replay catalog sections (EMAC v4 codes).
     */
    @GetMapping("/arte/sections")
    public ResponseEntity<Map<String, Object>> arteSections(
            @RequestParam(value = "lang", defaultValue = "fr") String lang) {
        String language = arteReplayService.normalizeLang(lang);
        List<Map<String, String>> sections = arteReplayService.sections().entrySet().stream()
                .map(e -> Map.of("code", e.getKey(), "label", e.getValue()))
                .collect(Collectors.toList());
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofHours(6)).cachePublic())
                .body(Map.of("lang", language, "sections", sections));
    }

    /**
     * ARTE replay / VOD listing (EMAC v4). Search when {@code q} has ≥ 2 characters.
     */
    @GetMapping("/arte/programs")
    public ResponseEntity<Map<String, Object>> artePrograms(
            @RequestParam(value = "lang", defaultValue = "fr") String lang,
            @RequestParam(value = "section", defaultValue = "MOST_RECENT") String section,
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "page", defaultValue = "1") int page) {
        ArteReplayService.ArteCatalogResult result = arteReplayService.listPrograms(lang, section, q, page);
        Map<String, Object> body = new HashMap<>();
        body.put("lang", result.language());
        body.put("section", result.section());
        body.put("page", result.page());
        body.put("pages", result.pages());
        body.put("total", result.total());
        body.put("programs", result.programs());
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(2)).cachePublic().mustRevalidate())
                .body(body);
    }

    /**
     * Resolve an ARTE program (or {@code LIVE}) to an upstream HLS URL.
     */
    @GetMapping("/arte/resolve/{programId}")
    public ResponseEntity<?> resolveArte(
            @PathVariable("programId") String programId,
            @RequestParam(value = "lang", defaultValue = "fr") String lang,
            @RequestParam(value = "fresh", defaultValue = "false") boolean fresh) {
        if (!arteReplayService.isValidProgramId(programId)) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid_arte_program_id"));
        }
        Optional<String> hls = arteReplayService.resolveHlsUrl(programId, lang, fresh);
        if (hls.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of(
                    "error", "arte_resolve_failed",
                    "message", "Impossible de résoudre le flux ARTE (droits expirés, géo-restriction ou programme indisponible)"
            ));
        }
        long expiresAtEpoch = Instant.now().plus(Duration.ofMinutes(8)).getEpochSecond();
        String id = "LIVE".equalsIgnoreCase(programId.trim()) ? "LIVE" : programId.trim();
        return ResponseEntity.ok(Map.of(
                "programId", id,
                "lang", arteReplayService.normalizeLang(lang),
                "streamUrl", hls.get(),
                "virtualUrl", ArteReplayService.virtualUrl(id),
                "expiresAtEpoch", expiresAtEpoch
        ));
    }

    /**
     * Internet Archive curated sections (feature films collections).
     */
    @GetMapping("/ia/sections")
    public ResponseEntity<Map<String, Object>> iaSections() {
        List<Map<String, String>> sections = internetArchiveReplayService.sections().entrySet().stream()
                .map(e -> Map.of("code", e.getKey(), "label", e.getValue()))
                .collect(Collectors.toList());
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofHours(6)).cachePublic())
                .body(Map.of("sections", sections));
    }

    /**
     * Internet Archive movie listing (Advanced Search). Search when {@code q} has ≥ 2 characters.
     */
    @GetMapping("/ia/programs")
    public ResponseEntity<Map<String, Object>> iaPrograms(
            @RequestParam(value = "section", defaultValue = "RECENT") String section,
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "page", defaultValue = "1") int page) {
        InternetArchiveReplayService.IaCatalogResult result =
                internetArchiveReplayService.listPrograms(section, q, page);
        Map<String, Object> body = new HashMap<>();
        body.put("section", result.section());
        body.put("page", result.page());
        body.put("pages", result.pages());
        body.put("total", result.total());
        body.put("programs", result.programs());
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(2)).cachePublic())
                .body(body);
    }

    /**
     * Resolve an Internet Archive identifier to a progressive MP4/HLS download URL.
     */
    @GetMapping("/ia/resolve/{identifier}")
    public ResponseEntity<?> resolveInternetArchive(
            @PathVariable("identifier") String identifier,
            @RequestParam(value = "fresh", defaultValue = "false") boolean fresh) {
        if (!internetArchiveReplayService.isValidIdentifier(identifier)) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid_ia_identifier"));
        }
        Optional<String> stream = internetArchiveReplayService.resolveStreamUrl(identifier, fresh);
        if (stream.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of(
                    "error", "ia_resolve_failed",
                    "message", "Impossible de résoudre le fichier vidéo Archive.org (item dark, sans MP4, ou indisponible)"
            ));
        }
        String id = identifier.trim();
        long expiresAtEpoch = Instant.now().plus(Duration.ofMinutes(30)).getEpochSecond();
        return ResponseEntity.ok(Map.of(
                "identifier", id,
                "streamUrl", stream.get(),
                "virtualUrl", InternetArchiveReplayService.virtualUrl(id),
                "progressive", true,
                "expiresAtEpoch", expiresAtEpoch
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
        if (M6GroupLiveService.isVirtualUrl(url)) {
            return m6GroupLiveService.resolveVirtualOrPassthrough(url);
        }
        if (ArteReplayService.isVirtualUrl(url)) {
            return arteReplayService.resolveVirtualOrPassthrough(url);
        }
        if (InternetArchiveReplayService.isVirtualUrl(url)) {
            return internetArchiveReplayService.resolveVirtualOrPassthrough(url);
        }
        return Optional.of(url);
    }

    /**
     * @return a JSON error response when live resolution fails; {@code null} when OK to proxy
     */
    private ResponseEntity<byte[]> resolveLiveUpstreamOrError(String url) {
        if (Tf1LiveService.isVirtualUrl(url)) {
            Optional<String> slug = Tf1LiveService.slugFromVirtualUrl(url);
            if (slug.isEmpty() || tf1LiveService.findChannel(slug.get()).isEmpty()) {
                return TvStreamProxyService.jsonError(HttpStatus.BAD_REQUEST, "unknown_tf1_channel",
                        "Chaîne TF1 inconnue");
            }
            Optional<String> hls = tf1LiveService.resolveHlsUrl(slug.get());
            if (hls.isEmpty() || !StringUtils.hasText(hls.get())) {
                return TvStreamProxyService.jsonError(HttpStatus.BAD_GATEWAY, "tf1_resolve_failed",
                        "Impossible de résoudre le flux TF1 (API officielle et miroirs IPTV)");
            }
            return null;
        }
        if (FranceTvLiveService.isVirtualUrl(url)) {
            Optional<String> hls = franceTvLiveService.resolveVirtualOrPassthrough(url);
            if (hls.isEmpty() || !StringUtils.hasText(hls.get()) || FranceTvLiveService.isVirtualUrl(hls.get())) {
                return TvStreamProxyService.jsonError(HttpStatus.BAD_GATEWAY, "francetv_resolve_failed",
                        "Impossible de résoudre le flux live france.tv");
            }
            return null;
        }
        if (CanalGroupLiveService.isVirtualUrl(url)) {
            Optional<String> hls = canalGroupLiveService.resolveVirtualOrPassthrough(url);
            if (hls.isEmpty() || !StringUtils.hasText(hls.get())
                    || CanalGroupLiveService.isVirtualUrl(hls.get())) {
                return TvStreamProxyService.jsonError(HttpStatus.BAD_GATEWAY, "canalgroup_resolve_failed",
                        "Impossible de résoudre le flux live CNews/CStar");
            }
            return null;
        }
        if (RadioFranceLiveService.isVirtualUrl(url)) {
            Optional<String> hls = radioFranceLiveService.resolveVirtualOrPassthrough(url);
            if (hls.isEmpty() || !StringUtils.hasText(hls.get())
                    || RadioFranceLiveService.isVirtualUrl(hls.get())) {
                return TvStreamProxyService.jsonError(HttpStatus.BAD_GATEWAY, "radiofrance_resolve_failed",
                        "Impossible de résoudre le flux live Radio France");
            }
            return null;
        }
        if (M6GroupLiveService.isVirtualUrl(url)) {
            Optional<String> hls = m6GroupLiveService.resolveVirtualOrPassthrough(url);
            if (hls.isEmpty() || !StringUtils.hasText(hls.get())
                    || M6GroupLiveService.isVirtualUrl(hls.get())) {
                return TvStreamProxyService.jsonError(HttpStatus.BAD_GATEWAY, "m6group_resolve_failed",
                        "M6+ officiel est protégé DRM — aucun miroir IPTV public disponible. "
                                + "Regardez sur https://www.m6.fr/m6/direct");
            }
            return null;
        }
        if (ArteReplayService.isVirtualUrl(url)) {
            Optional<String> programId = ArteReplayService.programIdFromVirtualUrl(url);
            if (programId.isEmpty()) {
                return TvStreamProxyService.jsonError(HttpStatus.BAD_REQUEST, "unknown_arte_program",
                        "Identifiant ARTE invalide");
            }
            Optional<String> hls = arteReplayService.resolveHlsUrl(programId.get(), "fr");
            if (hls.isEmpty() || !StringUtils.hasText(hls.get())) {
                return TvStreamProxyService.jsonError(HttpStatus.BAD_GATEWAY, "arte_resolve_failed",
                        "Impossible de résoudre le flux ARTE (droits / géo / indisponible)");
            }
            return null;
        }
        if (InternetArchiveReplayService.isVirtualUrl(url)) {
            Optional<String> identifier = InternetArchiveReplayService.identifierFromVirtualUrl(url);
            if (identifier.isEmpty()) {
                return TvStreamProxyService.jsonError(HttpStatus.BAD_REQUEST, "unknown_ia_item",
                        "Identifiant Internet Archive invalide");
            }
            Optional<String> stream = internetArchiveReplayService.resolveStreamUrl(identifier.get());
            if (stream.isEmpty() || !StringUtils.hasText(stream.get())) {
                return TvStreamProxyService.jsonError(HttpStatus.BAD_GATEWAY, "ia_resolve_failed",
                        "Impossible de résoudre le fichier vidéo Archive.org");
            }
            return null;
        }
        return null;
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
