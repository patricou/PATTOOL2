package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Resolves TF1 Group live HLS streams.
 * <p>
 * Primary path: official {@code mediainfo.tf1.fr} (same as streamlink) — TF1 / TMC / TFX need a
 * free TF1 account ({@code app.tv.tf1.email} + {@code app.tv.tf1.password}); LCI often works without.
 * Fallback: public IPTV mirrors (seed URLs + iptv-org FR playlist) when the official API fails
 * (bad credentials, geo, temporary 403).
 * <p>
 * Virtual catalog URLs: {@code tf1:tf1}, {@code tf1:tmc}, {@code tf1:tfx}, {@code tf1:lci}.
 */
@Service
public class Tf1LiveService {

    private static final Logger log = LoggerFactory.getLogger(Tf1LiveService.class);

    public static final String SCHEME_PREFIX = "tf1:";

    private static final String MEDIA_API = "https://mediainfo.tf1.fr/mediainfocombo/";
    private static final String LOGIN_URL = "https://compte.tf1.fr/accounts.login";
    private static final String TOKEN_URL = "https://www.tf1.fr/token/gigya/web";
    private static final String GIGYA_API_KEY =
            "3_hWgJdARhz_7l1oOp3a8BDLoR9cuWZpUaKG4aqF7gum9_iK3uTZ2VlDBl8ANf8FVk";
    private static final List<String> CONSENT_IDS = List.of(
            "4", "10001", "10003", "10005", "10007", "10009", "10011", "10013", "10015", "10017", "10019"
    );
    /** iPhone UA forces HLS delivery instead of DASH. */
    private static final String IPHONE_UA =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
                    + "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    private static final String DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/124.0.0.0 Safari/537.36";

    private static final Pattern TVG_ID = Pattern.compile("tvg-id=\"([^\"]+)\"", Pattern.CASE_INSENSITIVE);

    private static final Map<String, ChannelDef> CHANNELS = new LinkedHashMap<>();

    static {
        CHANNELS.put("tf1", new ChannelDef(
                "L_TF1", "TF1", true,
                "https://i.imgur.com/QxHt9NC.png", "Entertainment",
                "tf1.fr",
                List.of("http://151.80.18.177:86/TF1_HD/index.m3u8")));
        CHANNELS.put("tmc", new ChannelDef(
                "L_TMC", "TMC", true,
                "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/TMC_logo_2016.svg/512px-TMC_logo_2016.svg.png",
                "Entertainment",
                "tmc.fr",
                List.of("http://151.80.18.177:86/TMC/index.m3u8")));
        CHANNELS.put("tfx", new ChannelDef(
                "L_TFX", "TFX", true,
                "https://i.imgur.com/d91GcVf.png", "Entertainment",
                "tfx.fr",
                List.of("http://145.239.5.177/315/index.m3u8")));
        CHANNELS.put("lci", new ChannelDef(
                "L_LCI", "LCI", false,
                "https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/LCI_-_Logo_%28France%29.svg/512px-LCI_-_Logo_%28France%29.svg.png",
                "News",
                "lci.fr",
                List.of("http://151.80.18.177:86/LCI_HD/index.m3u8")));
    }

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(12))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final ObjectMapper objectMapper;
    private final ConcurrentHashMap<String, CachedUrl> streamCache = new ConcurrentHashMap<>();
    private final AtomicReference<CachedToken> userToken = new AtomicReference<>();
    private final String playlistBaseUrl;
    private volatile CachedPlaylist playlistCache;

    @Value("${app.tv.tf1.email:}")
    private String tf1Email;

    @Value("${app.tv.tf1.password:}")
    private String tf1Password;

    public Tf1LiveService(
            ObjectMapper objectMapper,
            @Value("${app.tv.playlist-base-url:https://iptv-org.github.io/iptv/countries}") String playlistBaseUrl) {
        this.objectMapper = objectMapper;
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

    public boolean isConfigured() {
        return StringUtils.hasText(tf1Email) && StringUtils.hasText(tf1Password);
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
            boolean official = isTf1CdnUrl(cached.url);
            if (probeClearHls(cached.url, official)) {
                return Optional.of(cached.url);
            }
            streamCache.remove(key);
            log.info("TF1 live {} dropped stale cached URL ({})", key, official ? "official" : "mirror");
        }

        // Official TF1+ token exchange (www.tf1.fr/token/gigya/web) is often blocked by bot
        // protection ("Malicious request"). Prefer public IPTV mirrors for authenticated
        // channels, then fall back to official when mirrors are down.
        if (def.requiresAuth()) {
            Optional<String> mirror = resolveFromMirrors(def, key, now);
            if (mirror.isPresent()) {
                return mirror;
            }
            Optional<String> official = resolveOfficial(def, key);
            if (official.isPresent() && probeClearHls(official.get(), true)) {
                streamCache.put(key, new CachedUrl(official.get(), now.plus(Duration.ofMinutes(8))));
                log.info("TF1 live {} resolved via official mediainfo", key);
                return official;
            }
            if (official.isPresent()) {
                log.warn("TF1 live {} official URL rejected by CDN probe", key);
            }
        } else {
            Optional<String> official = resolveOfficial(def, key);
            if (official.isPresent() && probeClearHls(official.get(), true)) {
                streamCache.put(key, new CachedUrl(official.get(), now.plus(Duration.ofMinutes(8))));
                log.info("TF1 live {} resolved via official mediainfo", key);
                return official;
            }
            Optional<String> mirror = resolveFromMirrors(def, key, now);
            if (mirror.isPresent()) {
                return mirror;
            }
        }

        if (cached != null) {
            return Optional.of(cached.url);
        }
        log.warn("TF1 live: no official URL and no working IPTV mirror for {}", key);
        return Optional.empty();
    }

    private Optional<String> resolveFromMirrors(ChannelDef def, String key, Instant now) {
        for (String candidate : buildMirrorCandidates(def)) {
            if (probeClearHls(candidate, false)) {
                streamCache.put(key, new CachedUrl(candidate, now.plus(Duration.ofMinutes(8))));
                log.info("TF1 live {} resolved via IPTV mirror {}", key, candidate);
                return Optional.of(candidate);
            }
        }
        return Optional.empty();
    }

    public Optional<String> resolveVirtualOrPassthrough(String url) {
        Optional<String> slug = slugFromVirtualUrl(url);
        if (slug.isEmpty()) {
            return Optional.ofNullable(url);
        }
        return resolveHlsUrl(slug.get());
    }

    private Optional<String> resolveOfficial(ChannelDef def, String key) {
        if (def.requiresAuth() && !isConfigured()) {
            log.warn("TF1 live {} official path needs app.tv.tf1.email / app.tv.tf1.password — trying mirrors", key);
            return Optional.empty();
        }
        try {
            String bearer = def.requiresAuth() ? acquireUserToken() : null;
            String hls = fetchDeliveryUrl(def.mediaId(), bearer);
            if (!StringUtils.hasText(hls) && def.requiresAuth() && bearer != null) {
                userToken.set(null);
                bearer = acquireUserToken();
                hls = fetchDeliveryUrl(def.mediaId(), bearer);
            }
            if (StringUtils.hasText(hls)) {
                return Optional.of(hls);
            }
        } catch (Exception e) {
            log.warn("TF1 official resolve failed for {}: {}", key, e.toString());
        }
        return Optional.empty();
    }

    private String acquireUserToken() throws Exception {
        CachedToken cached = userToken.get();
        Instant now = Instant.now();
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.token;
        }
        synchronized (this) {
            cached = userToken.get();
            if (cached != null && cached.expiresAt.isAfter(Instant.now())) {
                return cached.token;
            }
            String token = loginAndGetToken();
            userToken.set(new CachedToken(token, Instant.now().plus(Duration.ofHours(6))));
            return token;
        }
    }

    private String loginAndGetToken() throws Exception {
        String form = "loginID=" + URLEncoder.encode(tf1Email.trim(), StandardCharsets.UTF_8)
                + "&password=" + URLEncoder.encode(tf1Password, StandardCharsets.UTF_8)
                + "&APIKey=" + URLEncoder.encode(GIGYA_API_KEY, StandardCharsets.UTF_8)
                + "&includeUserInfo=true";

        HttpRequest loginReq = HttpRequest.newBuilder(URI.create(LOGIN_URL))
                .timeout(Duration.ofSeconds(20))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .header("User-Agent", IPHONE_UA)
                .POST(HttpRequest.BodyPublishers.ofString(form))
                .build();
        HttpResponse<String> loginResp = httpClient.send(loginReq, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        JsonNode loginJson = objectMapper.readTree(loginResp.body());
        String uid = text(loginJson, "UID");
        String signature = text(loginJson, "UIDSignature");
        String ts = text(loginJson, "signatureTimestamp");
        int errorCode = loginJson.path("errorCode").asInt(-1);
        if (uid == null || signature == null || ts == null) {
            String details = loginJson.path("errorDetails").asText(
                    loginJson.path("errorMessage").asText("unknown"));
            throw new IllegalStateException("TF1 login failed (errorCode=" + errorCode + "): " + details);
        }
        if (errorCode != 0) {
            log.info("TF1 Gigya login soft errorCode={} ({}); continuing with UID/signature",
                    errorCode, loginJson.path("errorDetails").asText(
                            loginJson.path("errorMessage").asText("")));
        }

        com.fasterxml.jackson.databind.node.ObjectNode node = objectMapper.createObjectNode();
        node.put("uid", uid);
        node.put("signature", signature);
        node.put("timestamp", Long.parseLong(ts));
        node.set("consent_ids", objectMapper.valueToTree(CONSENT_IDS));
        String body = objectMapper.writeValueAsString(node);

        HttpRequest tokReq = HttpRequest.newBuilder(URI.create(TOKEN_URL))
                .timeout(Duration.ofSeconds(15))
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/plain, */*")
                .header("Accept-Language", "fr-FR,fr;q=0.9,en;q=0.8")
                .header("User-Agent", DESKTOP_UA)
                .header("Origin", "https://www.tf1.fr")
                .header("Referer", "https://www.tf1.fr/tf1/direct")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> tokResp = httpClient.send(tokReq, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        String tokBody = tokResp.body() != null ? tokResp.body().trim() : "";
        if (tokBody.isEmpty() || looksLikeBotBlock(tokBody)) {
            throw new IllegalStateException(
                    "TF1 token exchange blocked by www.tf1.fr WAF (bot protection). "
                            + "Official API unavailable from this server — IPTV mirrors will be used.");
        }
        if (!tokBody.startsWith("{")) {
            throw new IllegalStateException("TF1 token exchange returned non-JSON (HTTP "
                    + tokResp.statusCode() + ")");
        }
        JsonNode tokJson = objectMapper.readTree(tokBody);
        String token = text(tokJson, "token");
        if (token == null) {
            throw new IllegalStateException("TF1 token exchange failed");
        }
        return token;
    }

    private static boolean looksLikeBotBlock(String body) {
        String lower = body.toLowerCase(Locale.ROOT);
        return lower.contains("malicious")
                || lower.contains("bot detected")
                || lower.contains("access denied")
                || lower.contains("captcha");
    }

    private String fetchDeliveryUrl(String mediaId, String bearer) throws Exception {
        String api = MEDIA_API + mediaId + "?context=MYTF1&pver=5015000";
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(api))
                .timeout(Duration.ofSeconds(20))
                .header("User-Agent", IPHONE_UA)
                .header("Accept", "application/json")
                .header("Origin", "https://www.tf1.fr")
                .header("Referer", "https://www.tf1.fr/")
                .GET();
        if (StringUtils.hasText(bearer)) {
            b.header("Authorization", "Bearer " + bearer);
        }
        HttpResponse<String> resp = httpClient.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
            log.warn("TF1 mediainfo HTTP {} for {}", resp.statusCode(), mediaId);
            return null;
        }
        JsonNode delivery = objectMapper.readTree(resp.body()).path("delivery");
        int code = delivery.path("code").asInt(-1);
        if (code != 200) {
            log.warn("TF1 delivery code {} error={} for {}", code, delivery.path("error").asText(""), mediaId);
            return null;
        }
        return text(delivery, "url");
    }

    private List<String> buildMirrorCandidates(ChannelDef def) {
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
                    .header("User-Agent", DESKTOP_UA)
                    .header("Accept", "application/vnd.apple.mpegurl, text/plain, */*")
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300 || !StringUtils.hasText(response.body())) {
                log.warn("TF1 mirrors: iptv-org FR playlist HTTP {}", response.statusCode());
                return cached != null ? cached.body : null;
            }
            playlistCache = new CachedPlaylist(response.body(), now.plus(Duration.ofMinutes(30)));
            return response.body();
        } catch (Exception e) {
            log.warn("TF1 mirrors: failed to load iptv-org FR playlist: {}", e.toString());
            return cached != null ? cached.body : null;
        }
    }

    private boolean probeClearHls(String url) {
        return probeClearHls(url, isTf1CdnUrl(url));
    }

    private boolean probeClearHls(String url, boolean officialTf1) {
        try {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(10))
                    .header("User-Agent", officialTf1 ? IPHONE_UA : DESKTOP_UA)
                    .header("Accept", "*/*")
                    .GET();
            if (officialTf1) {
                b.header("Origin", "https://www.tf1.fr");
                b.header("Referer", "https://www.tf1.fr/");
            }
            HttpResponse<String> response = httpClient.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                log.debug("TF1 HLS probe HTTP {} for {}", response.statusCode(), hostOf(url));
                return false;
            }
            String body = response.body() != null ? response.body().trim() : "";
            if (body.length() < 8 || !body.contains("#EXTM3U")) {
                return false;
            }
            String upper = body.toUpperCase(Locale.ROOT);
            if (upper.contains("SAMPLE-AES") || upper.contains("FAIRPLAY")
                    || upper.contains("COM.APPLE.STREAMINGKEYDELIVERY")
                    || upper.contains("SKD://")
                    || upper.contains("WIDEVINE")
                    || upper.contains("COM.WIDEVINE")) {
                log.debug("TF1 HLS probe rejected DRM playlist for {}", hostOf(url));
                return false;
            }
            return true;
        } catch (Exception e) {
            log.debug("TF1 HLS probe failed for {}: {}", hostOf(url), e.toString());
            return false;
        }
    }

    private static boolean isTf1CdnUrl(String url) {
        try {
            String host = URI.create(url).getHost();
            if (host == null) {
                return false;
            }
            String h = host.toLowerCase(Locale.ROOT);
            return h.endsWith("tf1.fr") || h.contains("diff.tf1.fr") || h.contains("tf1info.fr");
        } catch (Exception e) {
            return false;
        }
    }

    private static String hostOf(String url) {
        try {
            String host = URI.create(url).getHost();
            return host != null ? host : url;
        } catch (Exception e) {
            return url;
        }
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

    /** @param requiresAuth true for TF1/TMC/TFX official path; false for LCI */
    public record ChannelDef(
            String mediaId,
            String name,
            boolean requiresAuth,
            String logo,
            String group,
            String tvgIdPrefix,
            List<String> seedUrls
    ) {
    }

    private record CachedUrl(String url, Instant expiresAt) {
    }

    private record CachedToken(String token, Instant expiresAt) {
    }

    private record CachedPlaylist(String body, Instant expiresAt) {
    }
}
