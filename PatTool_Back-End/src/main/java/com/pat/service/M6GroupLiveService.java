package com.pat.service;

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
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Best-effort live for M6 Group FTA channels (M6 / W9 / 6ter / Gulli).
 * <p>
 * Official M6+ / 6play lives are Widevine / FairPlay DRM — not playable in this HLS player.
 * This service probes public IPTV mirrors (seed URLs + current iptv-org FR playlist entries)
 * and returns the first clear HLS that responds.
 * <p>
 * Virtual catalog URLs: {@code m6group:m6}, {@code m6group:w9}, {@code m6group:6ter}, {@code m6group:gulli}.
 */
@Service
public class M6GroupLiveService {

    private static final Logger log = LoggerFactory.getLogger(M6GroupLiveService.class);

    public static final String SCHEME_PREFIX = "m6group:";

    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    private static final Pattern TVG_ID = Pattern.compile("tvg-id=\"([^\"]+)\"", Pattern.CASE_INSENSITIVE);

    private static final Map<String, ChannelDef> CHANNELS = new LinkedHashMap<>();

    static {
        // Official M6+ / 6play / 6cloud lives are DRM or IP-gated. Prefer clear IPTV mirrors
        // (same host family as TF1 mirrors) before slower/dead seeds and iptv-org discovery.
        CHANNELS.put("m6", new ChannelDef(
                "M6",
                "Entertainment",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4a/Logo_M6_2015.svg/512px-Logo_M6_2015.svg.png",
                "m6.fr",
                List.of(
                        "http://151.80.18.177:86/M6_HD/index.m3u8",
                        "http://cdn.haititivi.com/M6-HD/index.m3u8",
                        "http://99.27.51.147:8080/M6/index.m3u8"
                )));
        CHANNELS.put("w9", new ChannelDef(
                "W9",
                "Entertainment",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/4/40/W9_2018.svg/512px-W9_2018.svg.png",
                "w9.fr",
                List.of(
                        "http://151.80.18.177:86/W9_HD/index.m3u8",
                        "http://145.239.5.177/331a/index.m3u8"
                )));
        CHANNELS.put("6ter", new ChannelDef(
                "6ter",
                "Entertainment",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/6ter_2012.svg/512px-6ter_2012.svg.png",
                "6ter.fr",
                List.of("http://145.239.5.177/314/index.m3u8")));
        CHANNELS.put("gulli", new ChannelDef(
                "Gulli",
                "Kids",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0a/Gulli_2017.svg/512px-Gulli_2017.svg.png",
                "gulli.fr",
                List.of(
                        "http://99.27.51.147:8080/Gulli/index.m3u8",
                        "http://41.205.77.102/GULLI/index.m3u8"
                )));
    }

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(8))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final String playlistBaseUrl;
    private final ConcurrentHashMap<String, CachedUrl> streamCache = new ConcurrentHashMap<>();
    private volatile CachedPlaylist playlistCache;

    public M6GroupLiveService(
            @Value("${app.tv.playlist-base-url:https://iptv-org.github.io/iptv/countries}") String playlistBaseUrl) {
        this.playlistBaseUrl = playlistBaseUrl;
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
        Optional<ChannelDef> defOpt = findChannel(slug);
        if (defOpt.isEmpty()) {
            return Optional.empty();
        }
        ChannelDef def = defOpt.get();
        String key = slug.trim().toLowerCase(Locale.ROOT);
        CachedUrl cached = streamCache.get(key);
        Instant now = Instant.now();
        if (cached != null && cached.expiresAt.isAfter(now)) {
            if (probeClearHls(cached.url)) {
                return Optional.of(cached.url);
            }
            streamCache.remove(key);
            log.info("M6 group live {} dropped stale cached URL", key);
        }

        List<String> candidates = buildCandidates(def);
        for (String candidate : candidates) {
            if (probeClearHls(candidate)) {
                streamCache.put(key, new CachedUrl(candidate, now.plus(Duration.ofMinutes(8))));
                log.info("M6 group live resolved {} -> {}", key, candidate);
                return Optional.of(candidate);
            }
        }

        log.warn("M6 group live: no working public HLS for {} (official M6+ is DRM-only)", key);
        return Optional.empty();
    }

    public Optional<String> resolveVirtualOrPassthrough(String url) {
        Optional<String> slug = slugFromVirtualUrl(url);
        if (slug.isEmpty()) {
            return Optional.ofNullable(url);
        }
        return resolveHlsUrl(slug.get());
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
        String playlist = loadFrancePlaylist();
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

    private String loadFrancePlaylist() {
        Instant now = Instant.now();
        CachedPlaylist cached = playlistCache;
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.body;
        }
        String url = playlistBaseUrl.replaceAll("/+$", "") + "/fr.m3u";
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(20))
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "application/vnd.apple.mpegurl, text/plain, */*")
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300 || !StringUtils.hasText(response.body())) {
                log.warn("M6 group: iptv-org FR playlist HTTP {}", response.statusCode());
                return cached != null ? cached.body : null;
            }
            playlistCache = new CachedPlaylist(response.body(), now.plus(Duration.ofMinutes(30)));
            return response.body();
        } catch (Exception e) {
            log.warn("M6 group: failed to load iptv-org FR playlist: {}", e.toString());
            return cached != null ? cached.body : null;
        }
    }

    private boolean probeClearHls(String url) {
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(8))
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "*/*")
                    .GET();
            // 6play Referer only helps official 6cloud hosts; it can break third-party mirrors.
            if (isM6OfficialCdn(url)) {
                builder.header("Referer", "https://www.6play.fr/");
                builder.header("Origin", "https://www.6play.fr");
            }
            HttpResponse<String> response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                return false;
            }
            String body = response.body() != null ? response.body().trim() : "";
            if (body.length() < 8 || !body.contains("#EXTM3U")) {
                return false;
            }
            String upper = body.toUpperCase(Locale.ROOT);
            if (upper.contains("ACCESS DENIED") || upper.contains("PROTOCOL DISABLED")) {
                return false;
            }
            // Skip DRM / FairPlay / Sample-AES playlists — browser HLS.js cannot play them.
            if (upper.contains("SAMPLE-AES") || upper.contains("FAIRPLAY")
                    || upper.contains("COM.APPLE.STREAMINGKEYDELIVERY")
                    || upper.contains("SKD://")
                    || upper.contains("WIDEVINE")
                    || upper.contains("COM.WIDEVINE")) {
                return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isM6OfficialCdn(String url) {
        try {
            String host = URI.create(url).getHost();
            if (host == null) {
                return false;
            }
            String h = host.toLowerCase(Locale.ROOT);
            return h.contains("6cloud.fr") || h.contains("6play.fr") || h.contains("m6web");
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
}
