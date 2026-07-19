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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Resolves TF1 Group live HLS streams via {@code mediainfo.tf1.fr} (same approach as streamlink).
 * <p>
 * TF1 / TMC / TFX require a free TF1 account ({@code app.tv.tf1.email} + {@code app.tv.tf1.password}).
 * LCI (TF1 Info) often works without credentials.
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

    private static final Map<String, ChannelDef> CHANNELS = new LinkedHashMap<>();

    static {
        CHANNELS.put("tf1", new ChannelDef(
                "L_TF1", "TF1", true,
                "https://i.imgur.com/QxHt9NC.png", "Entertainment"));
        CHANNELS.put("tmc", new ChannelDef(
                "L_TMC", "TMC", true,
                "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/TMC_logo_2016.svg/512px-TMC_logo_2016.svg.png",
                "Entertainment"));
        CHANNELS.put("tfx", new ChannelDef(
                "L_TFX", "TFX", true,
                "https://i.imgur.com/d91GcVf.png", "Entertainment"));
        CHANNELS.put("lci", new ChannelDef(
                "L_LCI", "LCI", false,
                "https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/LCI_-_Logo_%28France%29.svg/512px-LCI_-_Logo_%28France%29.svg.png",
                "News"));
    }

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(12))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final ObjectMapper objectMapper;
    private final ConcurrentHashMap<String, CachedUrl> streamCache = new ConcurrentHashMap<>();
    private final AtomicReference<CachedToken> userToken = new AtomicReference<>();

    @Value("${app.tv.tf1.email:}")
    private String tf1Email;

    @Value("${app.tv.tf1.password:}")
    private String tf1Password;

    public Tf1LiveService(ObjectMapper objectMapper) {
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
            return Optional.of(cached.url);
        }

        if (def.requiresAuth() && !isConfigured()) {
            log.warn("TF1 live {} requires app.tv.tf1.email / app.tv.tf1.password", key);
            return Optional.empty();
        }

        try {
            String bearer = def.requiresAuth() ? acquireUserToken() : null;
            String hls = fetchDeliveryUrl(def.mediaId(), bearer);
            if (!StringUtils.hasText(hls) && def.requiresAuth() && bearer != null) {
                // Token may be stale — force re-login once.
                userToken.set(null);
                bearer = acquireUserToken();
                hls = fetchDeliveryUrl(def.mediaId(), bearer);
            }
            if (!StringUtils.hasText(hls)) {
                return cached != null ? Optional.of(cached.url) : Optional.empty();
            }
            streamCache.put(key, new CachedUrl(hls, now.plus(Duration.ofMinutes(20))));
            return Optional.of(hls);
        } catch (Exception e) {
            log.warn("TF1 live resolve failed for {}: {}", key, e.toString());
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
        // Gigya often returns soft codes (e.g. 206002 Account Pending Verification) while still
        // providing UID + signature that work for the TF1 token exchange.
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
                .header("User-Agent", IPHONE_UA)
                .header("Origin", "https://www.tf1.fr")
                .header("Referer", "https://www.tf1.fr/")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> tokResp = httpClient.send(tokReq, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        JsonNode tokJson = objectMapper.readTree(tokResp.body());
        String token = text(tokJson, "token");
        if (token == null) {
            throw new IllegalStateException("TF1 token exchange failed");
        }
        return token;
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

    /** @param requiresAuth true for TF1/TMC/TFX; false for LCI */
    public record ChannelDef(String mediaId, String name, boolean requiresAuth, String logo, String group) {
    }

    private record CachedUrl(String url, Instant expiresAt) {
    }

    private record CachedToken(String token, Instant expiresAt) {
    }
}
