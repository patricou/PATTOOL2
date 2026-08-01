package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
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
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Resolves TF1 Group live HLS streams.
 * <p>
 * Authenticated channels (TF1 / TMC / TFX) and LCI: public IPTV seeds first for speed.
 * Official {@code mediainfo.tf1.fr} is a fallback (TF1/TMC/TFX need credentials; WAF often
 * blocks {@code www.tf1.fr/token/gigya/web}).
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
    private static final Pattern CODECS_ATTR = Pattern.compile(
            "CODECS=\"([^\"]+)\"", Pattern.CASE_INSENSITIVE);

    /** Sticky window for IPTV mirrors (no CDN token expiry). */
    private static final Duration MIRROR_CACHE_TTL = Duration.ofMinutes(25);
    /** Official TF1 CDN JWTs are short-lived. */
    private static final Duration OFFICIAL_CACHE_TTL = Duration.ofMinutes(5);
    private static final Duration CACHE_TTL_SHORT = Duration.ofMinutes(3);

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
                // 151.80 LCI_HD often advertises video-only CODECS (no mp4a) → silent playback.
                // Prefer the fast host variant that includes AAC audio.
                List.of(
                        "http://145.239.5.177/368/index.m3u8",
                        "http://151.80.18.177:86/LCI_HD/index.m3u8"
                )));
    }

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(4))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final ExecutorService probeExecutor = Executors.newFixedThreadPool(4, r -> {
        Thread t = new Thread(r, "tf1-hls-probe");
        t.setDaemon(true);
        return t;
    });

    private final ObjectMapper objectMapper;
    private final ConcurrentHashMap<String, CachedUrl> streamCache = new ConcurrentHashMap<>();
    /** Temporary blacklist of dead mirror / CDN URLs (flaky IPTV or expired JWT). */
    private final ConcurrentHashMap<String, Instant> failedUntil = new ConcurrentHashMap<>();
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

    /** Prefetch mirror URLs so the first click is not a cold probe. */
    @PostConstruct
    void warmMirrorCache() {
        probeExecutor.execute(() -> {
            for (String slug : CHANNELS.keySet()) {
                try {
                    resolveHlsUrl(slug, false);
                } catch (Exception e) {
                    log.debug("TF1 warm {} skipped: {}", slug, e.toString());
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
        return resolveHlsUrl(slug, false);
    }

    /**
     * @param forceRefresh when true, re-validate the sticky URL; only switch if it is dead.
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

        // Sticky path: keep the same working URL to avoid mid-playback cuts / resolve thrash.
        if (cached != null && !isTemporarilyFailed(cached.url)) {
            boolean cacheFresh = cached.expiresAt.isAfter(now);
            boolean official = isTf1CdnUrl(cached.url);
            if (cacheFresh && !forceRefresh) {
                // Trust cache — re-probing every playlist hit causes stalls on flaky mirrors.
                return Optional.of(cached.url);
            }
            // forceRefresh or expired: re-probe sticky first; keep it if still alive.
            if (probeClearHls(cached.url, official)) {
                Duration ttl = official ? OFFICIAL_CACHE_TTL : MIRROR_CACHE_TTL;
                streamCache.put(key, new CachedUrl(cached.url, now.plus(ttl)));
                return Optional.of(cached.url);
            }
            avoidUrl = cached.url;
            markFailed(cached.url, Duration.ofMinutes(2));
            streamCache.remove(key);
            log.info("TF1 live {} dropped dead sticky URL ({})", key, official ? "official" : "mirror");
            cached = null;
        } else if (cached != null) {
            avoidUrl = cached.url;
            streamCache.remove(key);
            cached = null;
        }

        // Prefer IPTV seeds (fast). Official mediainfo / Gigya is a slow fallback
        // (WAF often blocks the token exchange anyway).
        Optional<String> mirror = resolveFromMirrors(def, key, now, avoidUrl);
        if (mirror.isPresent()) {
            return mirror;
        }
        Optional<String> official = resolveOfficial(def, key);
        if (official.isPresent() && !sameUrl(official.get(), avoidUrl)
                && !isTemporarilyFailed(official.get())
                && probeClearHls(official.get(), true)) {
            clearFailed(official.get());
            streamCache.put(key, new CachedUrl(official.get(), now.plus(OFFICIAL_CACHE_TTL)));
            log.info("TF1 live {} resolved via official mediainfo", key);
            return official;
        }
        if (official.isPresent()) {
            markFailed(official.get(), Duration.ofMinutes(1));
            log.warn("TF1 live {} official URL rejected by CDN probe", key);
        }

        // Last resort: previously avoided URL if it still probes (better than nothing).
        if (StringUtils.hasText(avoidUrl) && probeClearHls(avoidUrl, isTf1CdnUrl(avoidUrl))) {
            clearFailed(avoidUrl);
            streamCache.put(key, new CachedUrl(avoidUrl, now.plus(CACHE_TTL_SHORT)));
            return Optional.of(avoidUrl);
        }
        log.warn("TF1 live: no official URL and no working IPTV mirror for {}", key);
        return Optional.empty();
    }

    /**
     * Drop a cached stream URL so the next resolve re-probes mirrors.
     * Short-blacklists the previous URL when the proxy already saw an upstream failure.
     */
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
        int n = streamCache.size() + (playlistCache != null ? 1 : 0);
        streamCache.clear();
        failedUntil.clear();
        playlistCache = null;
        return n;
    }

    public int cacheEntryCount() {
        return streamCache.size() + (playlistCache != null ? 1 : 0);
    }

    private Optional<String> resolveFromMirrors(ChannelDef def, String key, Instant now, String avoidUrl) {
        // Fast path: known seeds only — never block on iptv-org download first.
        Optional<String> seedHit = probeFirstWorking(def.seedUrls(), avoidUrl);
        if (seedHit.isPresent()) {
            clearFailed(seedHit.get());
            streamCache.put(key, new CachedUrl(seedHit.get(), now.plus(MIRROR_CACHE_TTL)));
            log.info("TF1 live {} resolved via IPTV seed {}", key, seedHit.get());
            return seedHit;
        }
        // Slow path: discover extra candidates from iptv-org (often empty for TF1).
        List<String> discovered = discoverFromIptvOrg(def.tvgIdPrefix());
        Optional<String> picked = probeFirstWorking(discovered, avoidUrl);
        if (picked.isPresent()) {
            clearFailed(picked.get());
            streamCache.put(key, new CachedUrl(picked.get(), now.plus(MIRROR_CACHE_TTL)));
            log.info("TF1 live {} resolved via IPTV mirror {}", key, picked.get());
            return picked;
        }
        return Optional.empty();
    }

    /**
     * Race candidates and return as soon as the first clear master playlist succeeds
     * (prefer lower index = seed order). Caps wait at ~5s.
     */
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

        // Common case: one seed — probe inline (no thread-pool hop).
        if (toProbe.size() == 1) {
            String url = toProbe.get(0);
            if (probeClearHls(url, isTf1CdnUrl(url))) {
                return Optional.of(url);
            }
            markFailed(url, Duration.ofSeconds(90));
            return Optional.empty();
        }

        AtomicReference<String> winner = new AtomicReference<>();
        AtomicInteger remaining = new AtomicInteger(toProbe.size());
        CountDownLatch done = new CountDownLatch(1);
        List<CompletableFuture<Void>> futures = new ArrayList<>(toProbe.size());

        for (String url : toProbe) {
            futures.add(CompletableFuture.runAsync(() -> {
                try {
                    if (winner.get() != null) {
                        return;
                    }
                    if (probeClearHls(url, isTf1CdnUrl(url)) && winner.compareAndSet(null, url)) {
                        done.countDown();
                    }
                } finally {
                    if (remaining.decrementAndGet() == 0) {
                        done.countDown();
                    }
                }
            }, probeExecutor));
        }

        try {
            done.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        // Cancel stragglers — result already decided.
        futures.forEach(f -> f.cancel(true));

        String url = winner.get();
        if (url != null) {
            return Optional.of(url);
        }
        toProbe.forEach(u -> markFailed(u, Duration.ofSeconds(90)));
        return Optional.empty();
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
                    .timeout(Duration.ofSeconds(12))
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

    private boolean probeClearHls(String url, boolean officialTf1) {
        try {
            // Master-only probe — media playlist fetch doubled cold-start latency for little gain;
            // the HLS proxy will surface dead variants immediately and trigger invalidate+retry.
            String master = fetchText(url, officialTf1);
            return isClearMasterPlaylist(master);
        } catch (Exception e) {
            log.debug("TF1 HLS probe failed for {}: {}", hostOf(url), e.toString());
            return false;
        }
    }

    private String fetchText(String url, boolean officialTf1) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(4))
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
        // Reject video-only variants (e.g. LCI_HD on 151.80: CODECS="avc1…" without mp4a).
        Matcher codecs = CODECS_ATTR.matcher(trimmed);
        boolean sawCodecs = false;
        boolean sawAudio = false;
        while (codecs.find()) {
            sawCodecs = true;
            String c = codecs.group(1).toLowerCase(Locale.ROOT);
            if (c.contains("mp4a") || c.contains("ac-3") || c.contains("ec-3")
                    || c.contains("opus") || c.contains("mp3")) {
                sawAudio = true;
                break;
            }
        }
        if (sawCodecs && !sawAudio) {
            return false;
        }
        return true;
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
