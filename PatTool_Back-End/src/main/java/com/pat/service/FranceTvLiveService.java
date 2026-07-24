package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Resolves official france.tv live HLS manifests (France 2/3/4/5, franceinfo) via the public
 * player API + Akamai token — same approach as streamlink/yt-dlp.
 * <p>
 * Virtual catalog URLs use the scheme {@code francetv:france-2} etc.
 */
@Service
public class FranceTvLiveService {

    private static final Logger log = LoggerFactory.getLogger(FranceTvLiveService.class);

    public static final String SCHEME_PREFIX = "francetv:";

    private static final String PLAYER_API = "https://k7.ftven.fr/videos/";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    /**
     * Akamai {@code hdnea=exp=} tokens for france.tv live are ~10 minutes (measured).
     * Cache must expire before the token, otherwise reconnect keeps serving a 403 URL.
     */
    private static final Duration TOKEN_SAFETY_MARGIN = Duration.ofSeconds(90);
    private static final Duration FALLBACK_CACHE_TTL = Duration.ofMinutes(8);
    private static final Pattern AKAMAI_EXP = Pattern.compile("(?:[?&~]|^|/)exp[=:](\\d{9,12})");

    /** Stable live video IDs from france.tv direct pages. */
    private static final Map<String, ChannelDef> CHANNELS = new LinkedHashMap<>();

    static {
        CHANNELS.put("france-2", new ChannelDef(
                "006194ea-117d-4bcf-94a9-153d999c59ae",
                "France 2",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/5/53/France_2_2018.svg/960px-France_2_2018.svg.png",
                "General"));
        CHANNELS.put("france-3", new ChannelDef(
                "29bdf749-7082-4426-a4f3-595cc436aa0d",
                "France 3",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/France_3_2018.svg/960px-France_3_2018.svg.png",
                "General"));
        CHANNELS.put("france-4", new ChannelDef(
                "9a6a7670-dde9-4264-adbc-55b89558594b",
                "France 4",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3b/France_4_2018.svg/960px-France_4_2018.svg.png",
                "Kids"));
        CHANNELS.put("france-5", new ChannelDef(
                "45007886-f3ff-4b3e-9706-1ef1014c5a60",
                "France 5",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/5/50/France_5_2018.svg/960px-France_5_2018.svg.png",
                "General"));
        CHANNELS.put("franceinfo", new ChannelDef(
                "35be22fb-1569-43ff-857c-99bf81defa2e",
                "franceinfo",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/0/03/Franceinfo.svg/960px-Franceinfo.svg.png",
                "News"));
    }

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(12))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final ObjectMapper objectMapper;
    private final ConcurrentHashMap<String, CachedUrl> cache = new ConcurrentHashMap<>();

    public FranceTvLiveService(ObjectMapper objectMapper) {
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

    /**
     * Returns a short-lived signed HLS master playlist URL for the given france.tv live slug.
     */
    public Optional<String> resolveHlsUrl(String slug) {
        return resolveHlsUrl(slug, false);
    }

    /**
     * @param forceRefresh when true, bypass the in-memory signed-URL cache (e.g. after HTTP 403).
     */
    public Optional<String> resolveHlsUrl(String slug, boolean forceRefresh) {
        Optional<ChannelDef> def = findChannel(slug);
        if (def.isEmpty()) {
            return Optional.empty();
        }
        String key = slug.trim().toLowerCase(Locale.ROOT);
        Instant now = Instant.now();
        if (!forceRefresh) {
            CachedUrl cached = cache.get(key);
            if (cached != null && cached.expiresAt.isAfter(now) && !isAkamaiUrlExpired(cached.url, now)) {
                return Optional.of(cached.url);
            }
        } else {
            cache.remove(key);
        }
        try {
            String signed = fetchSignedHls(def.get().videoId());
            if (signed == null || signed.isBlank()) {
                CachedUrl stale = cache.get(key);
                if (stale != null && stale.expiresAt.isAfter(now) && !isAkamaiUrlExpired(stale.url, now)) {
                    return Optional.of(stale.url);
                }
                return Optional.empty();
            }
            Instant expiresAt = cacheExpiryForSignedUrl(signed, now);
            cache.put(key, new CachedUrl(signed, expiresAt));
            return Optional.of(signed);
        } catch (Exception e) {
            log.warn("France.tv live resolve failed for {}: {}", key, e.toString());
            CachedUrl stale = cache.get(key);
            if (stale != null && stale.expiresAt.isAfter(now) && !isAkamaiUrlExpired(stale.url, now)) {
                return Optional.of(stale.url);
            }
            return Optional.empty();
        }
    }

    /** Drop a cached signed URL so the next resolve fetches a fresh Akamai token. */
    public void invalidate(String slug) {
        if (slug == null) {
            return;
        }
        cache.remove(slug.trim().toLowerCase(Locale.ROOT));
    }

    /**
     * Resolve a virtual {@code francetv:…} URL to a real https HLS URL.
     */
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

    static Instant cacheExpiryForSignedUrl(String signedUrl, Instant now) {
        Optional<Instant> tokenExp = parseAkamaiExpiry(signedUrl);
        if (tokenExp.isPresent()) {
            Instant soft = tokenExp.get().minus(TOKEN_SAFETY_MARGIN);
            // Never cache past the real token; keep a tiny positive TTL if already near expiry.
            if (soft.isAfter(now.plusSeconds(15))) {
                return soft;
            }
            return now.plusSeconds(15);
        }
        return now.plus(FALLBACK_CACHE_TTL);
    }

    static boolean isAkamaiUrlExpired(String url, Instant now) {
        return parseAkamaiExpiry(url).map(exp -> !exp.isAfter(now)).orElse(false);
    }

    public static Optional<Instant> parseAkamaiExpiry(String url) {
        if (url == null || url.isBlank()) {
            return Optional.empty();
        }
        Matcher m = AKAMAI_EXP.matcher(url);
        if (!m.find()) {
            return Optional.empty();
        }
        try {
            long epoch = Long.parseLong(m.group(1));
            // Guard against absurd values.
            if (epoch < 1_000_000_000L || epoch > 4_000_000_000L) {
                return Optional.empty();
            }
            return Optional.of(Instant.ofEpochSecond(epoch));
        } catch (NumberFormatException e) {
            return Optional.empty();
        }
    }

    private String fetchSignedHls(String videoId) throws Exception {
        String apiUrl = PLAYER_API + videoId
                + "?device_type=mobile&browser=safari&domain=www.france.tv"
                + "&country_code=FR&os=ios&w=1920&h=1080&player_version=5.51.35";

        HttpRequest apiReq = HttpRequest.newBuilder(URI.create(apiUrl))
                .timeout(Duration.ofSeconds(20))
                .header("User-Agent", USER_AGENT)
                .header("Origin", "https://www.france.tv")
                .header("Referer", "https://www.france.tv/")
                .header("Accept", "application/json")
                .GET()
                .build();
        HttpResponse<String> apiResp = httpClient.send(apiReq, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (apiResp.statusCode() < 200 || apiResp.statusCode() >= 300) {
            log.warn("France.tv player API HTTP {} for {}", apiResp.statusCode(), videoId);
            return null;
        }

        JsonNode root = objectMapper.readTree(apiResp.body());
        JsonNode video = root.path("video");
        String streamUrl = text(video, "url");
        if (streamUrl == null) {
            return null;
        }
        String akamai = text(video.path("token"), "akamai");
        if (akamai == null || akamai.isBlank()) {
            // Some responses expose a ready DAI URL; prefer token when present.
            String dai = text(video.path("token"), "dai");
            return dai != null ? dai : streamUrl;
        }

        String sep = akamai.contains("?") ? "&" : "?";
        String tokenUrl = akamai + sep + "url=" + URLEncoder.encode(streamUrl, StandardCharsets.UTF_8);
        HttpRequest tokReq = HttpRequest.newBuilder(URI.create(tokenUrl))
                .timeout(Duration.ofSeconds(15))
                .header("User-Agent", USER_AGENT)
                .header("Origin", "https://www.france.tv")
                .header("Referer", "https://www.france.tv/")
                .header("Accept", "application/json")
                .GET()
                .build();
        HttpResponse<String> tokResp = httpClient.send(tokReq, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (tokResp.statusCode() < 200 || tokResp.statusCode() >= 300) {
            log.warn("France.tv Akamai token HTTP {} for {}", tokResp.statusCode(), videoId);
            return streamUrl;
        }
        JsonNode tok = objectMapper.readTree(tokResp.body());
        String signed = text(tok, "url");
        return signed != null ? signed : streamUrl;
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

    public record ChannelDef(String videoId, String name, String logo, String group) {
    }

    private record CachedUrl(String url, Instant expiresAt) {
    }
}
