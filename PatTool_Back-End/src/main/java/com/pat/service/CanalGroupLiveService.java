package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Resolves free Canal+ Group live channels (CNews / CStar) via Dailymotion live metadata
 * (same approach as streamlink's dailymotion plugin).
 * <p>
 * Virtual catalog URLs: {@code canalgroup:cnews}, {@code canalgroup:cstar}.
 */
@Service
public class CanalGroupLiveService {

    private static final Logger log = LoggerFactory.getLogger(CanalGroupLiveService.class);

    public static final String SCHEME_PREFIX = "canalgroup:";

    private static final String METADATA_API = "https://www.dailymotion.com/player/metadata/video/";
    private static final String USER_VIDEOS_API = "https://api.dailymotion.com/user/%s/videos";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    private static final Map<String, ChannelDef> CHANNELS = new LinkedHashMap<>();

    static {
        CHANNELS.put("cnews", new ChannelDef(
                "CNEWS",
                "x3b68jn",
                "CNews",
                "News",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/CNews_logo_2017.svg/512px-CNews_logo_2017.svg.png",
                "https://www.cnews.fr/"));
        CHANNELS.put("cstar", new ChannelDef(
                "CSTAR",
                "x5gv5v0",
                "CStar",
                "Entertainment",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0a/CStar_logo_2016.svg/512px-CStar_logo_2016.svg.png",
                "https://www.cstar.fr/"));
    }

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(12))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final ObjectMapper objectMapper;
    private final ConcurrentHashMap<String, CachedUrl> streamCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CachedMediaId> mediaIdCache = new ConcurrentHashMap<>();

    public CanalGroupLiveService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
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
            return Optional.of(cached.url);
        }
        try {
            String mediaId = resolveMediaId(def);
            String hls = fetchHlsFromMetadata(mediaId, def.embedder());
            if (!StringUtils.hasText(hls)) {
                return cached != null ? Optional.of(cached.url) : Optional.empty();
            }
            // Dailymotion live tokens rotate quickly.
            streamCache.put(key, new CachedUrl(hls, now.plus(Duration.ofMinutes(3))));
            return Optional.of(hls);
        } catch (Exception e) {
            log.warn("Canal group live resolve failed for {}: {}", key, e.toString());
            return cached != null ? Optional.of(cached.url) : Optional.empty();
        }
    }

    public Optional<String> resolveVirtualOrPassthrough(String url) {
        Optional<String> slug = slugFromVirtualUrl(url);
        if (slug.isEmpty()) {
            return Optional.ofNullable(url);
        }
        return resolveHlsUrl(slug.get());
    }

    private String resolveMediaId(ChannelDef def) {
        String user = def.dailymotionUser();
        CachedMediaId cached = mediaIdCache.get(user);
        Instant now = Instant.now();
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.mediaId;
        }
        try {
            String api = String.format(USER_VIDEOS_API, URLEncoder.encode(user, StandardCharsets.UTF_8))
                    + "?fields=id,title&flags=live_onair&limit=5&family_filter=false";
            HttpRequest req = HttpRequest.newBuilder(URI.create(api))
                    .timeout(Duration.ofSeconds(12))
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (resp.statusCode() >= 200 && resp.statusCode() < 300) {
                JsonNode list = objectMapper.readTree(resp.body()).path("list");
                String preferred = pickPreferredLiveId(list, def.fallbackMediaId(), def.displayName());
                if (StringUtils.hasText(preferred)) {
                    mediaIdCache.put(user, new CachedMediaId(preferred, now.plus(Duration.ofMinutes(30))));
                    return preferred;
                }
            }
        } catch (Exception e) {
            log.debug("Canal group live media-id lookup failed for {}: {}", user, e.toString());
        }
        return def.fallbackMediaId();
    }

    private static String pickPreferredLiveId(JsonNode list, String fallback, String displayName) {
        if (list == null || !list.isArray() || list.isEmpty()) {
            return fallback;
        }
        String needle = displayName != null ? displayName.toLowerCase(Locale.ROOT) : "";
        String first = null;
        for (JsonNode item : list) {
            String id = text(item, "id");
            if (!StringUtils.hasText(id)) {
                continue;
            }
            if (first == null) {
                first = id;
            }
            String title = text(item, "title");
            if (title != null) {
                String t = title.toLowerCase(Locale.ROOT);
                // Prefer main live over "PRIME" / secondary feeds.
                if (t.contains(needle) && !t.contains("prime")) {
                    return id;
                }
            }
        }
        return first != null ? first : fallback;
    }

    private String fetchHlsFromMetadata(String mediaId, String embedder) throws Exception {
        String api = METADATA_API + mediaId
                + "?embedder=" + URLEncoder.encode(embedder, StandardCharsets.UTF_8)
                + "&app=com.dailymotion.player";
        HttpRequest req = HttpRequest.newBuilder(URI.create(api))
                .timeout(Duration.ofSeconds(15))
                .header("User-Agent", USER_AGENT)
                .header("Referer", embedder)
                .header("Origin", originOf(embedder))
                .header("Accept", "application/json")
                .header("Cookie", "family_filter=off; ff=off")
                .header("priority", "u=1, i")
                .GET()
                .build();
        HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
            log.warn("Dailymotion metadata HTTP {} for {}", resp.statusCode(), mediaId);
            return null;
        }
        JsonNode root = objectMapper.readTree(resp.body());
        if (root.path("error").isObject()) {
            log.warn("Dailymotion metadata error for {}: {}", mediaId, root.path("error").path("message").asText(""));
            return null;
        }
        JsonNode auto = root.path("qualities").path("auto");
        if (auto.isArray()) {
            for (JsonNode q : auto) {
                if ("application/x-mpegURL".equalsIgnoreCase(text(q, "type"))) {
                    String url = text(q, "url");
                    if (StringUtils.hasText(url)) {
                        return url;
                    }
                }
            }
        }
        // Fallback: any m3u8 quality entry.
        JsonNode qualities = root.path("qualities");
        if (qualities.isObject()) {
            var fields = qualities.fields();
            while (fields.hasNext()) {
                var entry = fields.next();
                if (!entry.getValue().isArray()) {
                    continue;
                }
                for (JsonNode q : entry.getValue()) {
                    String url = text(q, "url");
                    if (StringUtils.hasText(url) && url.contains(".m3u8")) {
                        return url;
                    }
                }
            }
        }
        return null;
    }

    private static String originOf(String embedder) {
        try {
            URI uri = URI.create(embedder);
            if (uri.getScheme() != null && uri.getHost() != null) {
                return uri.getScheme() + "://" + uri.getHost();
            }
        } catch (Exception ignored) {
            // fall through
        }
        return "https://www.dailymotion.com";
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

    public record ChannelDef(
            String dailymotionUser,
            String fallbackMediaId,
            String displayName,
            String group,
            String logo,
            String embedder
    ) {
    }

    private record CachedUrl(String url, Instant expiresAt) {
    }

    private record CachedMediaId(String mediaId, Instant expiresAt) {
    }
}
