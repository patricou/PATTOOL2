package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * Best-effort live for Eurosport 1 / 2 (France).
 * <p>
 * Official Max / Eurosport Player linear streams require a paid package (Discovery
 * {@code channelPlaybackInfo} returns 403 with the anonymous realm token). This service:
 * <ol>
 *   <li>probes optional clear HLS URLs from {@code app.tv.eurosport.eurosport1-hls} /
 *       {@code app.tv.eurosport.eurosport2-hls} (comma-separated);</li>
 *   <li>optionally calls Discovery Direct with {@code app.tv.eurosport.disco-token}
 *       (bearer from a logged-in eurosportplayer.com / Max session).</li>
 * </ol>
 * Virtual catalog URLs: {@code eurosport:1}, {@code eurosport:2}.
 */
@Service
public class EurosportLiveService {

    private static final Logger log = LoggerFactory.getLogger(EurosportLiveService.class);

    public static final String SCHEME_PREFIX = "eurosport:";

    private static final String TOKEN_URL = "https://eu3-prod-direct.eurosport.com/token?realm=eurosport";
    private static final String PLAYBACK_URL =
            "https://eu3-prod-direct.eurosport.com/playback/v2/channelPlaybackInfo/";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    private static final Duration MIRROR_CACHE_TTL = Duration.ofMinutes(20);
    private static final Duration DISCO_CACHE_TTL = Duration.ofMinutes(4);

    private static final Map<String, ChannelDef> CHANNELS = new LinkedHashMap<>();

    static {
        CHANNELS.put("1", new ChannelDef(
                "Eurosport 1",
                "Sports",
                "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/france/eurosport-1-fr.png",
                "EUROSPORT1.fr",
                "97"));
        CHANNELS.put("2", new ChannelDef(
                "Eurosport 2",
                "Sports",
                "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/france/eurosport-2-fr.png",
                "EUROSPORT2.fr",
                "106"));
    }

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final ObjectMapper objectMapper;
    private final ConcurrentHashMap<String, CachedUrl> streamCache = new ConcurrentHashMap<>();
    private final List<String> seeds1;
    private final List<String> seeds2;
    private final String discoToken;

    private volatile CachedToken realmToken;

    public EurosportLiveService(
            ObjectMapper objectMapper,
            @Value("${app.tv.eurosport.eurosport1-hls:}") String eurosport1Hls,
            @Value("${app.tv.eurosport.eurosport2-hls:}") String eurosport2Hls,
            @Value("${app.tv.eurosport.disco-token:}") String discoToken) {
        this.objectMapper = objectMapper;
        this.seeds1 = splitSeeds(eurosport1Hls);
        this.seeds2 = splitSeeds(eurosport2Hls);
        this.discoToken = discoToken != null ? discoToken.trim() : "";
    }

    public static boolean isVirtualUrl(String url) {
        return url != null && url.regionMatches(true, 0, SCHEME_PREFIX, 0, SCHEME_PREFIX.length());
    }

    public static Optional<String> slugFromVirtualUrl(String url) {
        if (!isVirtualUrl(url)) {
            return Optional.empty();
        }
        String slug = url.substring(SCHEME_PREFIX.length()).trim().toLowerCase(Locale.ROOT);
        // Accept eurosport:1, eurosport:eurosport1, eurosport:eurosport-1
        if (slug.startsWith("eurosport")) {
            slug = slug.replace("eurosport", "").replace("-", "").replace("_", "");
        }
        return slug.isEmpty() ? Optional.empty() : Optional.of(slug);
    }

    public static String virtualUrl(String slug) {
        return SCHEME_PREFIX + normalizeSlug(slug);
    }

    public Map<String, ChannelDef> channels() {
        return CHANNELS;
    }

    public Optional<ChannelDef> findChannel(String slug) {
        String key = normalizeSlug(slug);
        if (key.isEmpty()) {
            return Optional.empty();
        }
        return Optional.ofNullable(CHANNELS.get(key));
    }

    public Optional<String> resolveHlsUrl(String slug) {
        return resolveHlsUrl(slug, false);
    }

    public Optional<String> resolveHlsUrl(String slug, boolean forceRefresh) {
        Optional<ChannelDef> defOpt = findChannel(slug);
        if (defOpt.isEmpty()) {
            return Optional.empty();
        }
        ChannelDef def = defOpt.get();
        String key = normalizeSlug(slug);
        Instant now = Instant.now();
        CachedUrl cached = streamCache.get(key);
        if (!forceRefresh && cached != null && cached.expiresAt.isAfter(now)) {
            return Optional.of(cached.url);
        }

        List<String> seeds = "2".equals(key) ? seeds2 : seeds1;
        for (String seed : seeds) {
            if (probeHls(seed)) {
                streamCache.put(key, new CachedUrl(seed, now.plus(MIRROR_CACHE_TTL)));
                return Optional.of(seed);
            }
        }

        Optional<String> disco = resolveViaDiscovery(def);
        if (disco.isPresent()) {
            streamCache.put(key, new CachedUrl(disco.get(), now.plus(DISCO_CACHE_TTL)));
            return disco;
        }

        if (cached != null) {
            return Optional.of(cached.url);
        }
        return Optional.empty();
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

    public void invalidate(String slug) {
        String key = normalizeSlug(slug);
        if (!key.isEmpty()) {
            streamCache.remove(key);
        }
    }

    public int invalidateAll() {
        int n = streamCache.size();
        streamCache.clear();
        realmToken = null;
        return n;
    }

    public int cacheEntryCount() {
        return streamCache.size();
    }

    public boolean hasConfiguredSeeds() {
        return !seeds1.isEmpty() || !seeds2.isEmpty() || StringUtils.hasText(discoToken);
    }

    private Optional<String> resolveViaDiscovery(ChannelDef def) {
        try {
            String bearer = StringUtils.hasText(discoToken) ? discoToken : fetchRealmToken();
            if (!StringUtils.hasText(bearer)) {
                return Optional.empty();
            }
            String api = PLAYBACK_URL + def.discoChannelId() + "?usePreAuth=true";
            HttpRequest req = HttpRequest.newBuilder(URI.create(api))
                    .timeout(Duration.ofSeconds(15))
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "application/json")
                    .header("Authorization", "Bearer " + bearer)
                    .header("x-disco-client", "WEB:UNKNOWN:esplayer:6.5.0")
                    .header("x-disco-params", "realm=eurosport,bid=eurosport,features=ar")
                    .GET()
                    .build();
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (resp.statusCode() == 403 || resp.statusCode() == 401) {
                log.debug("Eurosport Discovery playback denied for {} (HTTP {}) — needs subscription token or HLS seeds",
                        def.discoChannelId(), resp.statusCode());
                return Optional.empty();
            }
            if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
                log.warn("Eurosport Discovery playback HTTP {} for {}", resp.statusCode(), def.discoChannelId());
                return Optional.empty();
            }
            JsonNode root = objectMapper.readTree(resp.body());
            JsonNode streaming = root.path("data").path("attributes").path("streaming");
            String hls = firstStreamUrl(streaming, "hls");
            if (StringUtils.hasText(hls)) {
                return Optional.of(hls);
            }
            hls = firstStreamUrl(streaming, "dash");
            return StringUtils.hasText(hls) ? Optional.of(hls) : Optional.empty();
        } catch (Exception e) {
            log.warn("Eurosport Discovery resolve failed for {}: {}", def.discoChannelId(), e.toString());
            return Optional.empty();
        }
    }

    private String fetchRealmToken() {
        CachedToken cached = realmToken;
        Instant now = Instant.now();
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.token;
        }
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(TOKEN_URL))
                    .timeout(Duration.ofSeconds(10))
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
                return null;
            }
            String token = objectMapper.readTree(resp.body())
                    .path("data").path("attributes").path("token").asText(null);
            if (!StringUtils.hasText(token)) {
                return null;
            }
            realmToken = new CachedToken(token, now.plus(Duration.ofMinutes(25)));
            return token;
        } catch (Exception e) {
            log.debug("Eurosport realm token failed: {}", e.toString());
            return null;
        }
    }

    private boolean probeHls(String url) {
        if (!StringUtils.hasText(url)) {
            return false;
        }
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(url.trim()))
                    .timeout(Duration.ofSeconds(8))
                    .header("User-Agent", USER_AGENT)
                    .GET()
                    .build();
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
                return false;
            }
            String body = resp.body() != null ? resp.body() : "";
            return body.contains("#EXTM3U");
        } catch (Exception e) {
            return false;
        }
    }

    private static String firstStreamUrl(JsonNode streaming, String type) {
        if (streaming == null || !streaming.isObject()) {
            return null;
        }
        JsonNode node = streaming.path(type);
        if (node.isObject()) {
            String url = text(node, "url");
            if (StringUtils.hasText(url)) {
                return url;
            }
        }
        if (node.isArray()) {
            for (JsonNode item : node) {
                String url = text(item, "url");
                if (StringUtils.hasText(url)) {
                    return url;
                }
            }
        }
        return null;
    }

    private static String text(JsonNode node, String field) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return null;
        }
        JsonNode v = node.path(field);
        if (v.isMissingNode() || v.isNull()) {
            return null;
        }
        String s = v.asText(null);
        return s != null && !s.isBlank() ? s.trim() : null;
    }

    private static List<String> splitSeeds(String raw) {
        if (!StringUtils.hasText(raw)) {
            return List.of();
        }
        return Arrays.stream(raw.split("[,;\\s]+"))
                .map(String::trim)
                .filter(s -> s.startsWith("http://") || s.startsWith("https://"))
                .collect(Collectors.toCollection(ArrayList::new));
    }

    private static String normalizeSlug(String slug) {
        if (slug == null) {
            return "";
        }
        String s = slug.trim().toLowerCase(Locale.ROOT);
        if (s.startsWith("eurosport")) {
            s = s.replace("eurosport", "").replace("-", "").replace("_", "");
        }
        if ("eurosport1".equals(s) || "es1".equals(s)) {
            return "1";
        }
        if ("eurosport2".equals(s) || "es2".equals(s)) {
            return "2";
        }
        return s;
    }

    public record ChannelDef(
            String displayName,
            String group,
            String logo,
            String epgId,
            String discoChannelId
    ) {
    }

    private record CachedUrl(String url, Instant expiresAt) {
    }

    private record CachedToken(String token, Instant expiresAt) {
    }
}
