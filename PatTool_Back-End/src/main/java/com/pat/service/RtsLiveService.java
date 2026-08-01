package com.pat.service;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Best-effort live for RTS (ex-TSR) Swiss public channels: RTS 1 / RTS 2 / RTS Info.
 * <p>
 * Official Play RTS lives are often DRM / geo-locked. This service probes labeled public
 * HLS mirrors (Netplus OTT + iptv-org CH playlist) and returns the first clear
 * browser-playable stream (AVC + AAC when codecs are declared).
 * <p>
 * Virtual catalog URLs: {@code rts:rts1}, {@code rts:rts2}, {@code rts:rtsinfo}.
 */
@Service
public class RtsLiveService {

    private static final Logger log = LoggerFactory.getLogger(RtsLiveService.class);

    public static final String SCHEME_PREFIX = "rts:";

    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    private static final Pattern TVG_ID = Pattern.compile("tvg-id=\"([^\"]+)\"", Pattern.CASE_INSENSITIVE);
    private static final Pattern STREAM_INF = Pattern.compile(
            "#EXT-X-STREAM-INF:([^\\n\\r]*)[\\n\\r]+([^#\\n\\r][^\\n\\r]*)",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern CODECS_ATTR = Pattern.compile(
            "CODECS=\"([^\"]+)\"", Pattern.CASE_INSENSITIVE);

    private static final Duration MIRROR_CACHE_TTL = Duration.ofMinutes(25);
    private static final Duration MIRROR_CACHE_TTL_SHORT = Duration.ofMinutes(8);

    private static final Map<String, ChannelDef> CHANNELS = new LinkedHashMap<>();

    static {
        // Seeds must be labeled RTS1 / RTS Un in public playlists — never anonymous numeric paths.
        CHANNELS.put("rts1", new ChannelDef(
                "RTS 1",
                "General",
                "https://i.imgur.com/OP5lHv9.png",
                "rts1.ch",
                List.of(
                        "https://viamotionhsi.netplus.ch/live/eds/rts1hd/browser-HLS8/rts1hd.m3u8",
                        "http://41.205.70.146/RTSUN/index.m3u8"
                )));
        CHANNELS.put("rts2", new ChannelDef(
                "RTS 2",
                "General",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/RTS_Deux_2016.svg/512px-RTS_Deux_2016.svg.png",
                "rts2.ch",
                List.of(
                        "https://viamotionhsi.netplus.ch/live/eds/rts2hd/browser-HLS8/rts2hd.m3u8"
                )));
        CHANNELS.put("rtsinfo", new ChannelDef(
                "RTS Info",
                "News",
                "https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/switzerland/rts-info-ch.png",
                "rtsinfo.ch",
                List.of(
                        "https://rtsinfo-d.akamaized.net/out/v1/2b7ae2e1ba3f43c6aba15bced153baf5/index.m3u8",
                        "https://viamotionhsi.netplus.ch/live/eds/rtsinfohd/browser-HLS8/rtsinfohd.m3u8"
                )));
    }

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(8))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final ExecutorService probeExecutor = Executors.newFixedThreadPool(3, r -> {
        Thread t = new Thread(r, "rts-hls-probe");
        t.setDaemon(true);
        return t;
    });

    private final String playlistBaseUrl;
    private final ConcurrentHashMap<String, CachedUrl> streamCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Instant> failedUntil = new ConcurrentHashMap<>();
    private volatile CachedPlaylist playlistCache;

    public RtsLiveService(
            @Value("${app.tv.playlist-base-url:https://iptv-org.github.io/iptv/countries}") String playlistBaseUrl) {
        this.playlistBaseUrl = playlistBaseUrl;
    }

    @PostConstruct
    void warmMirrorCache() {
        probeExecutor.execute(() -> {
            for (String slug : CHANNELS.keySet()) {
                try {
                    resolveHlsUrl(slug, false);
                } catch (Exception e) {
                    log.debug("RTS warm {} skipped: {}", slug, e.toString());
                }
            }
        });
    }

    public static boolean isVirtualUrl(String url) {
        return url != null && url.regionMatches(true, 0, SCHEME_PREFIX, 0, SCHEME_PREFIX.length());
    }

    public static Optional<String> slugFromVirtualUrl(String url) {
        if (!isVirtualUrl(url)) {
            return Optional.empty();
        }
        String slug = url.substring(SCHEME_PREFIX.length()).trim().toLowerCase(Locale.ROOT);
        return slug.isEmpty() ? Optional.empty() : Optional.of(slug);
    }

    public static String virtualUrl(String slug) {
        return SCHEME_PREFIX + slug;
    }

    public Map<String, ChannelDef> channels() {
        return CHANNELS;
    }

    public Optional<ChannelDef> findChannel(String slug) {
        if (slug == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(CHANNELS.get(slug.trim().toLowerCase(Locale.ROOT)));
    }

    public Optional<String> resolveHlsUrl(String slug) {
        return resolveHlsUrl(slug, false);
    }

    /**
     * @param forceRefresh when true, re-validate the sticky mirror; only switch if it is dead.
     */
    public Optional<String> resolveHlsUrl(String slug, boolean forceRefresh) {
        Optional<ChannelDef> defOpt = findChannel(slug);
        if (defOpt.isEmpty()) {
            return Optional.empty();
        }
        ChannelDef def = defOpt.get();
        String key = slug.trim().toLowerCase(Locale.ROOT);
        Instant now = Instant.now();
        String avoidUrl = null;
        CachedUrl cached = streamCache.get(key);

        if (cached != null && !isTemporarilyFailed(cached.url)) {
            boolean cacheFresh = cached.expiresAt.isAfter(now);
            if (cacheFresh && !forceRefresh) {
                return Optional.of(cached.url);
            }
            if (probeClearHls(cached.url)) {
                streamCache.put(key, new CachedUrl(cached.url, now.plus(MIRROR_CACHE_TTL)));
                return Optional.of(cached.url);
            }
            avoidUrl = cached.url;
            markFailed(cached.url, Duration.ofMinutes(2));
            streamCache.remove(key);
            log.info("RTS live {} dropped dead sticky URL", key);
            cached = null;
        } else if (cached != null) {
            avoidUrl = cached.url;
            streamCache.remove(key);
            cached = null;
        }

        List<String> candidates = buildCandidates(def);
        Optional<String> picked = probeFirstWorking(candidates, avoidUrl);
        if (picked.isPresent()) {
            clearFailed(picked.get());
            streamCache.put(key, new CachedUrl(picked.get(), now.plus(MIRROR_CACHE_TTL)));
            log.info("RTS live resolved {} -> {}", key, picked.get());
            return picked;
        }
        if (StringUtils.hasText(avoidUrl) && probeClearHls(avoidUrl)) {
            clearFailed(avoidUrl);
            streamCache.put(key, new CachedUrl(avoidUrl, now.plus(MIRROR_CACHE_TTL_SHORT)));
            return Optional.of(avoidUrl);
        }
        log.warn("RTS live: no working public HLS for {}", key);
        return Optional.empty();
    }

    public void invalidate(String slug) {
        if (slug == null) {
            return;
        }
        String key = slug.trim().toLowerCase(Locale.ROOT);
        CachedUrl cached = streamCache.remove(key);
        if (cached != null) {
            markFailed(cached.url, Duration.ofMinutes(1));
        }
    }

    public int invalidateAll() {
        int n = streamCache.size();
        streamCache.clear();
        return n;
    }

    public int cacheEntryCount() {
        return streamCache.size();
    }

    public Optional<String> resolveVirtualOrPassthrough(String url) {
        return resolveVirtualOrPassthrough(url, false);
    }

    public Optional<String> resolveVirtualOrPassthrough(String url, boolean forceRefresh) {
        Optional<String> slug = slugFromVirtualUrl(url);
        if (slug.isEmpty()) {
            return Optional.ofNullable(url);
        }
        return resolveHlsUrl(slug.get(), forceRefresh);
    }

    private Optional<String> probeFirstWorking(List<String> candidates, String avoidUrl) {
        List<String> toProbe = new ArrayList<>();
        for (String candidate : candidates) {
            if (!StringUtils.hasText(candidate) || sameUrl(candidate, avoidUrl) || isTemporarilyFailed(candidate)) {
                continue;
            }
            toProbe.add(candidate.trim());
        }
        if (toProbe.isEmpty()) {
            for (String candidate : candidates) {
                if (StringUtils.hasText(candidate) && !sameUrl(candidate, avoidUrl)) {
                    toProbe.add(candidate.trim());
                }
            }
        }
        if (toProbe.isEmpty()) {
            return Optional.empty();
        }
        List<CompletableFuture<ProbeResult>> futures = new ArrayList<>();
        for (int i = 0; i < toProbe.size(); i++) {
            final String url = toProbe.get(i);
            final int order = i;
            futures.add(CompletableFuture.supplyAsync(() -> {
                boolean ok = probeClearHls(url);
                return new ProbeResult(url, ok, order);
            }, probeExecutor));
        }
        try {
            CompletableFuture.allOf(futures.toArray(CompletableFuture[]::new))
                    .orTimeout(18, TimeUnit.SECONDS)
                    .exceptionally(ex -> null)
                    .join();
        } catch (Exception ignored) {
            // individual futures may still complete
        }
        return futures.stream()
                .map(f -> {
                    try {
                        return f.getNow(null);
                    } catch (Exception e) {
                        return null;
                    }
                })
                .filter(r -> r != null && r.ok)
                .sorted(Comparator.comparingInt(r -> r.order))
                .map(r -> r.url)
                .findFirst()
                .or(() -> {
                    toProbe.forEach(u -> markFailed(u, Duration.ofSeconds(90)));
                    return Optional.empty();
                });
    }

    private static boolean sameUrl(String a, String b) {
        if (a == null || b == null) {
            return false;
        }
        return a.trim().equalsIgnoreCase(b.trim());
    }

    private void markFailed(String url, Duration ttl) {
        if (!StringUtils.hasText(url)) {
            return;
        }
        failedUntil.put(url.trim(), Instant.now().plus(ttl));
    }

    private void clearFailed(String url) {
        if (StringUtils.hasText(url)) {
            failedUntil.remove(url.trim());
        }
    }

    private boolean isTemporarilyFailed(String url) {
        if (!StringUtils.hasText(url)) {
            return false;
        }
        Instant until = failedUntil.get(url.trim());
        if (until == null) {
            return false;
        }
        if (until.isBefore(Instant.now())) {
            failedUntil.remove(url.trim());
            return false;
        }
        return true;
    }

    private List<String> buildCandidates(ChannelDef def) {
        Set<String> ordered = new LinkedHashSet<>();
        for (String seed : def.seedUrls()) {
            if (StringUtils.hasText(seed)) {
                ordered.add(seed.trim());
            }
        }
        for (String discovered : discoverFromIptvOrg(def.tvgIdPrefix())) {
            ordered.add(discovered);
        }
        return new ArrayList<>(ordered);
    }

    private List<String> discoverFromIptvOrg(String tvgPrefix) {
        String playlist = loadSwitzerlandPlaylist();
        if (!StringUtils.hasText(playlist)) {
            return List.of();
        }
        List<String> found = new ArrayList<>();
        String[] lines = playlist.split("\n");
        String pendingTvg = null;
        for (String raw : lines) {
            String line = raw != null ? raw.trim() : "";
            if (line.startsWith("#EXTINF")) {
                Matcher m = TVG_ID.matcher(line);
                pendingTvg = m.find() ? m.group(1) : null;
                continue;
            }
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            if (pendingTvg != null && matchesTvg(pendingTvg, tvgPrefix)
                    && (line.startsWith("http://") || line.startsWith("https://"))) {
                found.add(line);
            }
            pendingTvg = null;
        }
        return found;
    }

    private static boolean matchesTvg(String tvgId, String prefix) {
        String id = tvgId.toLowerCase(Locale.ROOT);
        String p = prefix.toLowerCase(Locale.ROOT);
        return id.equals(p) || id.startsWith(p + "@") || id.startsWith(p + "#");
    }

    private String loadSwitzerlandPlaylist() {
        Instant now = Instant.now();
        CachedPlaylist cached = playlistCache;
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.body;
        }
        String url = playlistBaseUrl.replaceAll("/+$", "") + "/ch.m3u";
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(20))
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "application/vnd.apple.mpegurl, text/plain, */*")
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300 || !StringUtils.hasText(response.body())) {
                log.warn("RTS: iptv-org CH playlist HTTP {}", response.statusCode());
                return cached != null ? cached.body : null;
            }
            playlistCache = new CachedPlaylist(response.body(), now.plus(Duration.ofMinutes(30)));
            return response.body();
        } catch (Exception e) {
            log.warn("RTS: failed to load iptv-org CH playlist: {}", e.toString());
            return cached != null ? cached.body : null;
        }
    }

    private boolean probeClearHls(String url) {
        try {
            String master = fetchText(url);
            if (!isClearMasterPlaylist(master)) {
                return false;
            }
            if (declaresVideoOnlyCodecs(master)) {
                return false;
            }
            String mediaUrl = pickBrowserMediaPlaylist(url, master);
            if (mediaUrl == null) {
                return master.contains("#EXTINF") || master.contains("#EXT-X-TARGETDURATION");
            }
            String media = fetchText(mediaUrl);
            if (!StringUtils.hasText(media) || !media.contains("#EXTM3U")) {
                return false;
            }
            String upper = media.toUpperCase(Locale.ROOT);
            if (upper.contains("ACCESS DENIED") || upper.contains("PROTOCOL DISABLED")
                    || upper.contains("SAMPLE-AES") || upper.contains("WIDEVINE") || upper.contains("FAIRPLAY")) {
                return false;
            }
            return media.contains("#EXTINF") || media.contains(".ts") || media.contains(".m4s");
        } catch (Exception e) {
            return false;
        }
    }

    /** Reject masters that advertise video without AAC (silent playback). */
    private static boolean declaresVideoOnlyCodecs(String body) {
        if (!StringUtils.hasText(body)) {
            return false;
        }
        Matcher m = CODECS_ATTR.matcher(body);
        boolean sawCodecs = false;
        boolean anyWithAudio = false;
        while (m.find()) {
            sawCodecs = true;
            String codecs = m.group(1).toLowerCase(Locale.ROOT);
            if (codecs.contains("mp4a") || codecs.contains("aac") || codecs.contains("ac-3")
                    || codecs.contains("ec-3") || codecs.contains("opus")) {
                anyWithAudio = true;
            }
        }
        return sawCodecs && !anyWithAudio;
    }

    private String fetchText(String url) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(10))
                .header("User-Agent", USER_AGENT)
                .header("Accept", "*/*")
                .GET();
        if (isNetplusHost(url)) {
            builder.header("Referer", "https://www.netplus.ch/");
            builder.header("Origin", "https://www.netplus.ch");
        }
        HttpResponse<String> response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            return null;
        }
        return response.body();
    }

    private static boolean isClearMasterPlaylist(String body) {
        if (!StringUtils.hasText(body)) {
            return false;
        }
        String trimmed = body.trim();
        if (trimmed.length() < 8 || !trimmed.contains("#EXTM3U")) {
            return false;
        }
        String upper = trimmed.toUpperCase(Locale.ROOT);
        if (upper.contains("ACCESS DENIED") || upper.contains("PROTOCOL DISABLED")
                || upper.contains("WRONG_COUNTRY") || upper.contains("X-DENY")) {
            return false;
        }
        if (upper.contains("SAMPLE-AES") || upper.contains("FAIRPLAY")
                || upper.contains("COM.APPLE.STREAMINGKEYDELIVERY")
                || upper.contains("SKD://")
                || upper.contains("WIDEVINE")
                || upper.contains("COM.WIDEVINE")) {
            return false;
        }
        return true;
    }

    private static String pickBrowserMediaPlaylist(String masterUrl, String masterBody) {
        Matcher m = STREAM_INF.matcher(masterBody);
        String fallback = null;
        while (m.find()) {
            String attrs = m.group(1) != null ? m.group(1) : "";
            String uri = m.group(2) != null ? m.group(2).trim() : "";
            if (!StringUtils.hasText(uri)) {
                continue;
            }
            String attrsLower = attrs.toLowerCase(Locale.ROOT);
            boolean hevc = attrsLower.contains("hvc1") || attrsLower.contains("hev1") || attrsLower.contains("hevc");
            boolean avc = attrsLower.contains("avc1") || attrsLower.contains("avc3");
            boolean hasAudio = attrsLower.contains("mp4a") || attrsLower.contains("aac")
                    || !attrsLower.contains("codecs=");
            if (hevc && !avc) {
                continue;
            }
            if (!hasAudio && attrsLower.contains("codecs=")) {
                continue;
            }
            String abs = resolveAgainst(masterUrl, uri);
            if (avc && hasAudio) {
                return abs;
            }
            if (fallback == null) {
                fallback = abs;
            }
        }
        return fallback;
    }

    private static String resolveAgainst(String baseUrl, String ref) {
        try {
            return URI.create(baseUrl).resolve(ref).toString();
        } catch (Exception e) {
            return ref;
        }
    }

    private static boolean isNetplusHost(String url) {
        try {
            String host = URI.create(url).getHost();
            if (host == null) {
                return false;
            }
            String h = host.toLowerCase(Locale.ROOT);
            return h.contains("netplus.ch") || h.contains("viamotion");
        } catch (Exception e) {
            return false;
        }
    }

    public record ChannelDef(
            String name,
            String group,
            String logo,
            String tvgIdPrefix,
            List<String> seedUrls
    ) {
    }

    private record CachedUrl(String url, Instant expiresAt) {
    }

    private record CachedPlaylist(String body, Instant expiresAt) {
    }

    private record ProbeResult(String url, boolean ok, int order) {
    }
}
