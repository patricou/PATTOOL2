package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pat.controller.dto.YoutubeItemDto;
import com.pat.controller.dto.YoutubeSearchPageDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.HtmlUtils;
import org.springframework.web.util.UriComponentsBuilder;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

/**
 * YouTube Data API v3 proxy. The browser never calls googleapis.com and never
 * sees {@code app.youtube.api-key}. When that API is out of quota, search falls
 * back to YouTube's public search endpoint. Thumbnails are rewritten to this API too.
 */
@Service
public class YoutubeProxyService {

    private static final Logger log = LoggerFactory.getLogger(YoutubeProxyService.class);
    private static final String USER_AGENT = "PatTool/1.0 (youtube helper; https://www.patrickdeschamps.com)";
    private static final int DEFAULT_LIMIT = 12;
    private static final int MAX_LIMIT = 25;
    private static final Duration CACHE_TTL = Duration.ofMinutes(8);
    private static final Pattern SAFE_QUERY = Pattern.compile("^[\\p{L}\\p{N}\\p{P}\\p{S}\\p{Z}_]{1,100}$");
    private static final Pattern VIDEO_ID = Pattern.compile("^[a-zA-Z0-9_-]{11}$");
    private static final Pattern SAFE_TOKEN = Pattern.compile("^[A-Za-z0-9_-]{1,200}$");
    private static final Pattern SAFE_CHANNEL = Pattern.compile("^[A-Za-z0-9_-]{1,64}$");
    private static final Set<String> SAFE_TYPES = Set.of("video", "playlist", "channel");
    private static final Set<String> SAFE_ORDERS = Set.of(
            "date", "rating", "relevance", "title", "videoCount", "viewCount"
    );
    private static final Set<String> SAFE_REGIONS = Set.of(
            "FR", "US", "GB", "DE", "ES", "IT", "BE", "CH", "CA", "BR", "JP", "IN",
            "RU", "NL", "PT", "PL", "MX", "AR", "AU", "KR", "TW", "HK", "IL", "SA",
            "EG", "MA", "TN", "DZ", "GR", "TR", "SE", "NO", "DK", "FI", "IE", "AT",
            "CZ", "RO", "HU", "UA", "CN"
    );
    private static final Set<String> SAFE_LANGS = Set.of(
            "fr", "en", "de", "es", "it", "ru", "ja", "zh", "ar", "he", "el", "hi", "pt", "nl", "ko"
    );
    private static final int MAX_THUMB_BYTES = 2 * 1024 * 1024;
    private static final String INNERTUBE_SEARCH = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false";
    private static final String INNERTUBE_CLIENT = "2.20251022.01.00";
    private static final String INNERTUBE_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    /** Mobile web search answers in about a second. The desktop client is several times larger. */
    private static final String INNERTUBE_MWEB_UA =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    private static final Duration DATA_API_COOLDOWN = Duration.ofMinutes(20);
    /** Stop waiting once this elapses. The faster of the two searches is used as soon as it has videos. */
    private static final Duration CLIP_SEARCH_BUDGET = Duration.ofSeconds(4);

    private final RestTemplate restTemplate;
    /** Shorter wait for a title lookup, so a slow Data API falls through to public search sooner. */
    private final RestTemplate quickRestTemplate;
    private final ObjectMapper objectMapper;
    private final String apiBase;
    private final String apiKey;
    private final ConcurrentHashMap<String, CacheEntry> cache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, int[]> oembedSizes = new ConcurrentHashMap<>();
    /** Skip the Data API after a quota or rate-limit response so search stays fast. */
    private volatile Instant dataApiRetryAt = Instant.EPOCH;

    public YoutubeProxyService(
            RestTemplateBuilder builder,
            ObjectMapper objectMapper,
            @Value("${app.youtube.api-base:https://www.googleapis.com/youtube/v3}") String apiBase,
            @Value("${app.youtube.api-key:}") String apiKey) {
        this.restTemplate = builder
                .setConnectTimeout(Duration.ofSeconds(5))
                .setReadTimeout(Duration.ofSeconds(12))
                .build();
        this.quickRestTemplate = builder
                .setConnectTimeout(Duration.ofSeconds(3))
                .setReadTimeout(Duration.ofSeconds(4))
                .build();
        this.objectMapper = objectMapper;
        this.apiBase = trimSlash(apiBase);
        this.apiKey = apiKey == null ? "" : apiKey.trim();
    }

    public boolean isConfigured() {
        return StringUtils.hasText(apiKey);
    }

    /** Official oEmbed width and height. The id is fixed here so the call cannot be turned into an open fetch. */
    public int[] clipSize(String videoId) {
        String id = videoId == null ? "" : videoId.trim();
        if (!VIDEO_ID.matcher(id).matches()) {
            return null;
        }
        int[] cached = oembedSizes.get(id);
        if (cached != null) {
            return cached;
        }
        URI uri = URI.create("https://www.youtube.com/oembed?format=json&url="
                + URLEncoder.encode("https://www.youtube.com/watch?v=" + id, StandardCharsets.UTF_8));
        JsonNode raw = fetchJson(uri, "oembed");
        if (raw == null || !raw.path("width").canConvertToInt() || !raw.path("height").canConvertToInt()) {
            return null;
        }
        int width = raw.path("width").asInt(0);
        int height = raw.path("height").asInt(0);
        if (width < 16 || height < 16) {
            return null;
        }
        int[] size = new int[] { width, height };
        oembedSizes.put(id, size);
        return size;
    }

    /** Official oEmbed title. Empty when YouTube has no public title for this id. */
    public String clipTitle(String videoId) {
        String id = videoId == null ? "" : videoId.trim();
        if (!VIDEO_ID.matcher(id).matches()) {
            return null;
        }
        URI uri = URI.create("https://www.youtube.com/oembed?format=json&url="
                + URLEncoder.encode("https://www.youtube.com/watch?v=" + id, StandardCharsets.UTF_8));
        JsonNode raw = fetchJson(uri, "oembed");
        if (raw == null) {
            return null;
        }
        String title = raw.path("title").asText("").replaceAll("[\\p{Cntrl}]", "").trim();
        if (!StringUtils.hasText(title)) {
            return null;
        }
        return title.length() > 120 ? title.substring(0, 120) : title;
    }

    /**
     * Proxy a YouTube CDN thumbnail. Host allow-list + SSRF guard; the browser
     * never talks to i.ytimg.com / ggpht directly.
     */
    public ResponseEntity<byte[]> proxyThumbnail(String rawUrl) {
        return fetchThumbnail(rawUrl, 3);
    }

    private ResponseEntity<byte[]> fetchThumbnail(String rawUrl, int redirectsLeft) {
        if (!isAllowedThumbUrl(rawUrl)) {
            return ResponseEntity.badRequest().build();
        }
        HttpURLConnection conn = null;
        try {
            URL u = new URL(rawUrl);
            for (InetAddress addr : InetAddress.getAllByName(u.getHost())) {
                if (!com.pat.util.SsrfGuard.isPublicAddress(addr)) {
                    return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
                }
            }
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(5_000);
            conn.setReadTimeout(8_000);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("User-Agent", USER_AGENT);
            conn.setRequestProperty("Accept", "image/*,*/*;q=0.5");
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String location = conn.getHeaderField("Location");
                String next = location == null || location.isBlank()
                        ? ""
                        : URI.create(rawUrl).resolve(location.trim()).toString();
                if (redirectsLeft <= 0 || !isAllowedThumbUrl(next)) {
                    return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
                }
                conn.disconnect();
                conn = null;
                return fetchThumbnail(next, redirectsLeft - 1);
            }
            if (code < 200 || code >= 400) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
            }
            String contentType = conn.getContentType();
            if (contentType == null || !contentType.toLowerCase(Locale.ROOT).startsWith("image/")) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
            }
            try (InputStream is = conn.getInputStream();
                 ByteArrayOutputStream bos = new ByteArrayOutputStream(8192)) {
                byte[] buf = new byte[8192];
                int read;
                int total = 0;
                while ((read = is.read(buf)) != -1) {
                    total += read;
                    if (total > MAX_THUMB_BYTES) {
                        return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).build();
                    }
                    bos.write(buf, 0, read);
                }
                HttpHeaders headers = new HttpHeaders();
                try {
                    headers.setContentType(MediaType.parseMediaType(contentType));
                } catch (Exception e) {
                    headers.setContentType(MediaType.IMAGE_JPEG);
                }
                headers.setCacheControl(CacheControl.maxAge(Duration.ofHours(6)).cachePublic());
                headers.set("X-Content-Type-Options", "nosniff");
                headers.setContentLength(total);
                return new ResponseEntity<>(bos.toByteArray(), headers, HttpStatus.OK);
            }
        } catch (UnknownHostException e) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        } catch (Exception e) {
            log.debug("YouTube thumb proxy failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignore) {
                    // noop
                }
            }
        }
    }

    public YoutubeSearchPageDto search(
            String query,
            String type,
            String regionCode,
            String relevanceLanguage,
            String channelId,
            String pageToken,
            Integer maxResults,
            String order,
            String videoCategoryId) {
        return search(query, type, regionCode, relevanceLanguage, channelId, pageToken, maxResults, order, videoCategoryId, true);
    }

    /**
     * @param enrich when false, skip the extra {@code videos.list} call. A clip lookup only needs the id and the title.
     */
    public YoutubeSearchPageDto search(
            String query,
            String type,
            String regionCode,
            String relevanceLanguage,
            String channelId,
            String pageToken,
            Integer maxResults,
            String order,
            String videoCategoryId,
            boolean enrich) {
        String q = query == null ? "" : query.trim();
        String kind = normalizeType(type);
        String region = normalizeRegion(regionCode);
        String lang = normalizeLang(relevanceLanguage);
        String channel = normalizeChannel(channelId);
        String token = normalizeToken(pageToken);
        String sort = normalizeOrder(order);
        String category = "video".equals(kind) ? normalizeCategory(videoCategoryId) : "";
        int limit = clampLimit(maxResults);
        if (!StringUtils.hasText(q) && !StringUtils.hasText(channel) && !StringUtils.hasText(category)) {
            return emptyPage("search", q, kind, region);
        }
        if (StringUtils.hasText(q) && !SAFE_QUERY.matcher(q).matches()) {
            return YoutubeSearchPageDto.failure("invalid_query", "invalid_query");
        }
        String cacheBase = "search|" + q + "|" + kind + "|" + region + "|" + lang + "|" + channel + "|" + sort + "|" + category + "|" + token + "|" + limit + "|";
        String cacheKey = cacheBase + (enrich ? "full" : "lite");
        YoutubeSearchPageDto cached = fromCache(cacheKey);
        if (cached == null && !enrich) {
            cached = fromCache(cacheBase + "full");
        }
        if (cached != null) {
            return cached;
        }
        if (!enrich && "video".equals(kind) && !isInnertubeContinuation(token)) {
            YoutubeSearchPageDto clip = searchClip(q, region, lang, limit);
            if (clip != null) {
                cache.put(cacheKey, new CacheEntry(clip, Instant.now().plus(CACHE_TTL)));
                return clip;
            }
            if (!isConfigured()) {
                return YoutubeSearchPageDto.missingKey();
            }
            return YoutubeSearchPageDto.failure("upstream_error", "YouTube search failed");
        }
        UriComponentsBuilder builder = UriComponentsBuilder.fromUriString(apiBase + "/search")
                .queryParam("part", "snippet")
                .queryParam("type", kind)
                .queryParam("maxResults", limit)
                .queryParam("safeSearch", "moderate");
        if (StringUtils.hasText(q)) {
            builder.queryParam("q", q);
        }
        if (StringUtils.hasText(region)) {
            builder.queryParam("regionCode", region);
        }
        if (StringUtils.hasText(lang)) {
            builder.queryParam("relevanceLanguage", lang);
        }
        if (StringUtils.hasText(channel) && ("video".equals(kind) || "playlist".equals(kind))) {
            builder.queryParam("channelId", channel);
        }
        if (StringUtils.hasText(sort) && !"relevance".equals(sort)) {
            builder.queryParam("order", sort);
        }
        if (StringUtils.hasText(category)) {
            builder.queryParam("videoCategoryId", category);
        }
        if (StringUtils.hasText(token) && !isInnertubeContinuation(token)) {
            builder.queryParam("pageToken", token);
        }
        String failureCode = "upstream_error";
        String failureMessage = "YouTube search failed";
        if (isConfigured() && !isInnertubeContinuation(token) && !dataApiCoolingDown()) {
            JsonNode raw = fetchJson(enrich ? restTemplate : quickRestTemplate, withKey(builder), "search");
            String apiError = raw == null ? "upstream_error" : apiError(raw);
            if (raw != null && apiError == null) {
                List<YoutubeItemDto> items = mapSearchItems(raw.path("items"));
                if (enrich && "video".equals(kind)) {
                    items = enrichVideos(items);
                }
                YoutubeSearchPageDto page = new YoutubeSearchPageDto(
                        true,
                        null,
                        null,
                        "search",
                        q,
                        kind,
                        region,
                        textOrNull(raw.path("nextPageToken")),
                        textOrNull(raw.path("prevPageToken")),
                        raw.path("pageInfo").path("totalResults").asInt(items.size()),
                        items
                );
                cache.put(cacheKey, new CacheEntry(page, Instant.now().plus(CACHE_TTL)));
                return page;
            }
            failureCode = apiError;
            failureMessage = raw == null
                    ? "YouTube search failed"
                    : textOrEmpty(raw.path("error").path("message"));
            // A short timeout on a title lookup must not park the Data API for the whole app.
            if (enrich || "quota_exceeded".equals(apiError) || "invalid_key".equals(apiError)) {
                coolDownDataApi(apiError);
            }
        }
        YoutubeSearchPageDto fallback = searchWithInnertube(q, kind, region, lang, sort, category, token, limit);
        if (fallback != null) {
            cache.put(cacheKey, new CacheEntry(fallback, Instant.now().plus(CACHE_TTL)));
            return fallback;
        }
        if (!isConfigured()) {
            return YoutubeSearchPageDto.missingKey();
        }
        return YoutubeSearchPageDto.failure(failureCode, failureMessage);
    }

    public YoutubeSearchPageDto popular(String regionCode, String pageToken, Integer maxResults, String videoCategoryId) {
        String region = normalizeRegion(regionCode);
        if (!StringUtils.hasText(region)) {
            region = "FR";
        }
        String token = normalizeToken(pageToken);
        String category = normalizeCategory(videoCategoryId);
        int limit = clampLimit(maxResults);
        String cacheKey = "popular|" + region + "|" + category + "|" + token + "|" + limit;
        YoutubeSearchPageDto cached = fromCache(cacheKey);
        if (cached != null) {
            return cached;
        }
        UriComponentsBuilder builder = UriComponentsBuilder.fromUriString(apiBase + "/videos")
                .queryParam("part", "snippet,contentDetails,statistics")
                .queryParam("chart", "mostPopular")
                .queryParam("regionCode", region)
                .queryParam("maxResults", limit);
        if (StringUtils.hasText(category)) {
            builder.queryParam("videoCategoryId", category);
        }
        if (StringUtils.hasText(token) && !isInnertubeContinuation(token)) {
            builder.queryParam("pageToken", token);
        }
        String failureCode = "upstream_error";
        String failureMessage = "YouTube popular failed";
        if (isConfigured() && !isInnertubeContinuation(token) && !dataApiCoolingDown()) {
            JsonNode raw = fetchJson(withKey(builder), "popular");
            String apiError = raw == null ? "upstream_error" : apiError(raw);
            if (raw != null && apiError == null) {
                List<YoutubeItemDto> items = mapVideoItems(raw.path("items"));
                YoutubeSearchPageDto page = new YoutubeSearchPageDto(
                        true,
                        null,
                        null,
                        "popular",
                        null,
                        "video",
                        region,
                        textOrNull(raw.path("nextPageToken")),
                        textOrNull(raw.path("prevPageToken")),
                        raw.path("pageInfo").path("totalResults").asInt(items.size()),
                        items
                );
                cache.put(cacheKey, new CacheEntry(page, Instant.now().plus(CACHE_TTL)));
                return page;
            }
            failureCode = apiError;
            failureMessage = raw == null
                    ? "YouTube popular failed"
                    : textOrEmpty(raw.path("error").path("message"));
            coolDownDataApi(apiError);
        }
        YoutubeSearchPageDto fallback = popularWithInnertube(region, category, token, limit);
        if (fallback != null) {
            cache.put(cacheKey, new CacheEntry(fallback, Instant.now().plus(CACHE_TTL)));
            return fallback;
        }
        if (!isConfigured()) {
            return YoutubeSearchPageDto.missingKey();
        }
        return YoutubeSearchPageDto.failure(failureCode, failureMessage);
    }

    /**
     * A clip id does not need the desktop search page. The Data API and the smaller mobile
     * search run together; the first answer with videos is kept. They share the common pool
     * so one slow lookup cannot queue the next click.
     */
    private YoutubeSearchPageDto searchClip(String query, String region, String lang, int limit) {
        CompletableFuture<YoutubeSearchPageDto> dataApi = CompletableFuture.supplyAsync(() -> clipDataApi(query, limit));
        CompletableFuture<YoutubeSearchPageDto> mobile = CompletableFuture.supplyAsync(
                () -> clipPublic(query, region, lang, limit));
        YoutubeSearchPageDto ready = firstWithVideos(dataApi, mobile, CLIP_SEARCH_BUDGET);
        if (hasVideos(ready)) {
            return ready;
        }
        YoutubeSearchPageDto data = quiet(dataApi);
        if (data != null && data.error() == null) {
            return data;
        }
        return quiet(mobile);
    }

    private YoutubeSearchPageDto clipDataApi(String query, int limit) {
        if (!isConfigured() || dataApiCoolingDown()) {
            return null;
        }
        UriComponentsBuilder builder = UriComponentsBuilder.fromUriString(apiBase + "/search")
                .queryParam("part", "snippet")
                .queryParam("type", "video")
                .queryParam("maxResults", limit)
                .queryParam("safeSearch", "moderate")
                .queryParam("q", query);
        JsonNode raw = fetchJson(quickRestTemplate, withKey(builder), "search");
        String apiError = raw == null ? "upstream_error" : apiError(raw);
        if (raw != null && apiError == null) {
            List<YoutubeItemDto> items = mapSearchItems(raw.path("items"));
            return new YoutubeSearchPageDto(
                    true,
                    null,
                    null,
                    "search",
                    query,
                    "video",
                    "",
                    textOrNull(raw.path("nextPageToken")),
                    textOrNull(raw.path("prevPageToken")),
                    raw.path("pageInfo").path("totalResults").asInt(items.size()),
                    items
            );
        }
        if ("quota_exceeded".equals(apiError) || "invalid_key".equals(apiError)) {
            coolDownDataApi(apiError);
        }
        return null;
    }

    private YoutubeSearchPageDto clipPublic(String query, String region, String lang, int limit) {
        String hl = StringUtils.hasText(lang) ? lang : (YoutubeInnertube.isFrenchRegion(region) ? "fr" : "en");
        String gl = StringUtils.hasText(region) ? region : "FR";
        JsonNode raw = postInnertube(
                query, "video", hl, gl, "", "", "MWEB", INNERTUBE_CLIENT, INNERTUBE_MWEB_UA, quickRestTemplate);
        if (raw == null || raw.has("error")) {
            return null;
        }
        List<YoutubeItemDto> items = YoutubeInnertube.items(raw, "video", limit);
        if (items.isEmpty()) {
            return null;
        }
        return new YoutubeSearchPageDto(
                true,
                null,
                null,
                "search",
                query,
                "video",
                gl,
                null,
                null,
                items.size(),
                items
        );
    }

    private YoutubeSearchPageDto firstWithVideos(
            CompletableFuture<YoutubeSearchPageDto> primary,
            CompletableFuture<YoutubeSearchPageDto> secondary,
            Duration budget) {
        CompletableFuture<YoutubeSearchPageDto> gate = new CompletableFuture<>();
        Runnable look = () -> {
            YoutubeSearchPageDto first = quiet(primary);
            YoutubeSearchPageDto second = quiet(secondary);
            if (hasVideos(first)) {
                gate.complete(first);
            } else if (hasVideos(second)) {
                gate.complete(second);
            } else if (primary.isDone() && secondary.isDone()) {
                gate.complete(null);
            }
        };
        primary.whenComplete((page, error) -> look.run());
        secondary.whenComplete((page, error) -> look.run());
        try {
            return gate.get(budget.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException timeout) {
            look.run();
            return gate.getNow(null);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return null;
        } catch (ExecutionException failed) {
            return null;
        }
    }

    private static YoutubeSearchPageDto quiet(CompletableFuture<YoutubeSearchPageDto> future) {
        if (!future.isDone() || future.isCompletedExceptionally() || future.isCancelled()) {
            return null;
        }
        return future.getNow(null);
    }

    private static boolean hasVideos(YoutubeSearchPageDto page) {
        return page != null && page.error() == null && page.items() != null && !page.items().isEmpty();
    }

    private YoutubeSearchPageDto searchWithInnertube(
            String query,
            String kind,
            String region,
            String lang,
            String sort,
            String category,
            String token,
            int limit) {
        String effectiveQuery = query;
        if (!StringUtils.hasText(effectiveQuery)) {
            if (!StringUtils.hasText(category)) {
                return null;
            }
            effectiveQuery = YoutubeInnertube.categoryQuery(category, region);
        }
        String hl = StringUtils.hasText(lang) ? lang : (YoutubeInnertube.isFrenchRegion(region) ? "fr" : "en");
        String gl = StringUtils.hasText(region) ? region : "FR";
        return innertubePage(effectiveQuery, kind, hl, gl, sort, token, limit, "search", query, region);
    }

    private YoutubeSearchPageDto popularWithInnertube(String region, String category, String token, int limit) {
        boolean themed = StringUtils.hasText(category);
        String query = themed ? YoutubeInnertube.categoryQuery(category, region) : "a";
        String order = themed ? "viewCount" : "date";
        String hl = YoutubeInnertube.isFrenchRegion(region) ? "fr" : "en";
        return innertubePage(query, "video", hl, region, order, token, limit, "popular", null, region);
    }

    private YoutubeSearchPageDto innertubePage(
            String query,
            String kind,
            String hl,
            String gl,
            String sort,
            String token,
            int limit,
            String pageKind,
            String reportedQuery,
            String region) {
        JsonNode raw = postInnertube(query, kind, hl, gl, sort, isInnertubeContinuation(token) ? token : "");
        if (raw == null || raw.has("error")) {
            return null;
        }
        List<YoutubeItemDto> items = YoutubeInnertube.items(raw, kind, limit);
        String next = YoutubeInnertube.continuation(raw);
        if (items.isEmpty() && !StringUtils.hasText(next)) {
            return null;
        }
        return new YoutubeSearchPageDto(
                true,
                null,
                null,
                pageKind,
                reportedQuery,
                kind,
                region,
                next,
                null,
                items.size(),
                items
        );
    }

    private JsonNode postInnertube(String query, String type, String hl, String gl, String order, String continuation) {
        return postInnertube(query, type, hl, gl, order, continuation, "WEB", INNERTUBE_CLIENT, INNERTUBE_UA, restTemplate);
    }

    private JsonNode postInnertube(
            String query,
            String type,
            String hl,
            String gl,
            String order,
            String continuation,
            String clientName,
            String clientVersion,
            String userAgent,
            RestTemplate http) {
        ObjectNode root = objectMapper.createObjectNode();
        ObjectNode client = root.putObject("context").putObject("client");
        client.put("hl", StringUtils.hasText(hl) ? hl : "fr");
        client.put("gl", StringUtils.hasText(gl) ? gl : "FR");
        client.put("clientName", clientName);
        client.put("clientVersion", clientVersion);
        if (StringUtils.hasText(continuation)) {
            root.put("continuation", continuation);
        } else {
            root.put("query", query);
            root.put("params", YoutubeInnertube.searchParams(type, order));
        }
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.set(HttpHeaders.USER_AGENT, userAgent);
            headers.set(HttpHeaders.ACCEPT, "application/json");
            headers.set(HttpHeaders.ACCEPT_LANGUAGE, client.get("hl").asText() + ",en;q=0.5");
            headers.set("Origin", "https://www.youtube.com");
            ResponseEntity<String> response = http.exchange(
                    URI.create(INNERTUBE_SEARCH),
                    HttpMethod.POST,
                    new HttpEntity<>(objectMapper.writeValueAsString(root), headers),
                    String.class
            );
            String body = response.getBody();
            if (!StringUtils.hasText(body)) {
                return null;
            }
            return objectMapper.readTree(body);
        } catch (HttpStatusCodeException e) {
            log.warn("YouTube public search HTTP {}", e.getStatusCode().value());
            return null;
        } catch (Exception e) {
            log.warn("YouTube public search failed: {}", e.getMessage());
            return null;
        }
    }

    private boolean dataApiCoolingDown() {
        return Instant.now().isBefore(dataApiRetryAt);
    }

    private void coolDownDataApi(String reason) {
        Instant now = Instant.now();
        if (now.isBefore(dataApiRetryAt)) {
            return;
        }
        dataApiRetryAt = now.plus(DATA_API_COOLDOWN);
        log.warn("YouTube Data API unavailable ({}), public search fallback until {}", reason, dataApiRetryAt);
    }

    private List<YoutubeItemDto> enrichVideos(List<YoutubeItemDto> items) {
        LinkedHashSet<String> ids = new LinkedHashSet<>();
        for (YoutubeItemDto item : items) {
            if (item != null && "video".equals(item.kind()) && StringUtils.hasText(item.id())) {
                ids.add(item.id());
            }
        }
        if (ids.isEmpty()) {
            return items;
        }
        UriComponentsBuilder builder = UriComponentsBuilder.fromUriString(apiBase + "/videos")
                .queryParam("part", "contentDetails,statistics")
                .queryParam("id", String.join(",", ids));
        JsonNode raw = fetchJson(withKey(builder), "videos");
        if (raw == null || apiError(raw) != null) {
            return items;
        }
        Map<String, YoutubeItemDto> extra = new HashMap<>();
        for (JsonNode node : raw.path("items")) {
            String id = textOrEmpty(node.path("id"));
            extra.put(id, new YoutubeItemDto(
                    id,
                    "video",
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    textOrNull(node.path("contentDetails").path("duration")),
                    longOrNull(node.path("statistics").path("viewCount")),
                    null
            ));
        }
        List<YoutubeItemDto> merged = new ArrayList<>(items.size());
        for (YoutubeItemDto item : items) {
            YoutubeItemDto stats = extra.get(item.id());
            if (stats == null) {
                merged.add(item);
            } else {
                merged.add(new YoutubeItemDto(
                        item.id(),
                        item.kind(),
                        item.title(),
                        item.description(),
                        item.channelTitle(),
                        item.channelId(),
                        item.publishedAt(),
                        item.thumbnailUrl(),
                        stats.duration(),
                        stats.viewCount(),
                        item.liveBroadcast()
                ));
            }
        }
        return merged;
    }

    private List<YoutubeItemDto> mapSearchItems(JsonNode items) {
        List<YoutubeItemDto> out = new ArrayList<>();
        if (items == null || !items.isArray()) {
            return out;
        }
        for (JsonNode node : items) {
            JsonNode idNode = node.path("id");
            String kindRaw = textOrEmpty(idNode.path("kind"));
            String kind;
            String id;
            if (kindRaw.endsWith("#video") || idNode.hasNonNull("videoId")) {
                kind = "video";
                id = textOrEmpty(idNode.path("videoId"));
            } else if (kindRaw.endsWith("#playlist") || idNode.hasNonNull("playlistId")) {
                kind = "playlist";
                id = textOrEmpty(idNode.path("playlistId"));
            } else if (kindRaw.endsWith("#channel") || idNode.hasNonNull("channelId")) {
                kind = "channel";
                id = textOrEmpty(idNode.path("channelId"));
            } else {
                continue;
            }
            if (!StringUtils.hasText(id)) {
                continue;
            }
            JsonNode snippet = node.path("snippet");
            out.add(new YoutubeItemDto(
                    id,
                    kind,
                    htmlTextOrNull(snippet.path("title")),
                    htmlTextOrNull(snippet.path("description")),
                    htmlTextOrNull(snippet.path("channelTitle")),
                    textOrNull(snippet.path("channelId")),
                    textOrNull(snippet.path("publishedAt")),
                    thumbnailUrl(snippet.path("thumbnails")),
                    null,
                    null,
                    textOrNull(snippet.path("liveBroadcastContent"))
            ));
        }
        return out;
    }

    private List<YoutubeItemDto> mapVideoItems(JsonNode items) {
        List<YoutubeItemDto> out = new ArrayList<>();
        if (items == null || !items.isArray()) {
            return out;
        }
        for (JsonNode node : items) {
            String id = textOrEmpty(node.path("id"));
            if (!StringUtils.hasText(id)) {
                continue;
            }
            JsonNode snippet = node.path("snippet");
            out.add(new YoutubeItemDto(
                    id,
                    "video",
                    htmlTextOrNull(snippet.path("title")),
                    htmlTextOrNull(snippet.path("description")),
                    htmlTextOrNull(snippet.path("channelTitle")),
                    textOrNull(snippet.path("channelId")),
                    textOrNull(snippet.path("publishedAt")),
                    thumbnailUrl(snippet.path("thumbnails")),
                    textOrNull(node.path("contentDetails").path("duration")),
                    longOrNull(node.path("statistics").path("viewCount")),
                    textOrNull(snippet.path("liveBroadcastContent"))
            ));
        }
        return out;
    }

    private URI withKey(UriComponentsBuilder builder) {
        return builder.queryParam("key", apiKey).build().encode().toUri();
    }

    private JsonNode fetchJson(URI uri, String label) {
        return fetchJson(restTemplate, uri, label);
    }

    private JsonNode fetchJson(RestTemplate http, URI uri, String label) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
            headers.set(HttpHeaders.ACCEPT, "application/json");
            ResponseEntity<String> response = http.exchange(
                    uri,
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    String.class
            );
            String body = response.getBody();
            if (!StringUtils.hasText(body)) {
                return null;
            }
            return objectMapper.readTree(body);
        } catch (HttpStatusCodeException e) {
            log.warn("YouTube HTTP {} for {}: {}", e.getStatusCode().value(), label, e.getStatusCode());
            String body = e.getResponseBodyAsString();
            if (StringUtils.hasText(body)) {
                try {
                    return objectMapper.readTree(body);
                } catch (Exception ignored) {
                    return null;
                }
            }
            return null;
        } catch (RestClientException e) {
            log.warn("YouTube unavailable for {}: {}", label, e.getMessage());
            return null;
        } catch (Exception e) {
            log.warn("YouTube parse failed for {}: {}", label, e.getMessage());
            return null;
        }
    }

    private String apiError(JsonNode raw) {
        if (raw == null || !raw.has("error")) {
            return null;
        }
        JsonNode errors = raw.path("error").path("errors");
        if (errors.isArray()) {
            for (JsonNode err : errors) {
                String reason = textOrEmpty(err.path("reason"));
                if ("quotaExceeded".equals(reason) || "dailyLimitExceeded".equals(reason) || "rateLimitExceeded".equals(reason)) {
                    return "quota_exceeded";
                }
                if ("keyInvalid".equals(reason) || "badRequest".equals(reason)) {
                    return "invalid_key";
                }
            }
        }
        int code = raw.path("error").path("code").asInt(0);
        if (code == 403 || code == 429) {
            return "quota_exceeded";
        }
        return "upstream_error";
    }

    private YoutubeSearchPageDto fromCache(String key) {
        CacheEntry entry = cache.get(key);
        if (entry == null) {
            return null;
        }
        if (Instant.now().isAfter(entry.expiresAt())) {
            cache.remove(key, entry);
            return null;
        }
        return entry.page();
    }

    private static YoutubeSearchPageDto emptyPage(String kind, String query, String type, String region) {
        return new YoutubeSearchPageDto(
                true, null, null, kind, query, type, region, null, null, 0, List.of()
        );
    }

    private static String thumbnailUrl(JsonNode thumbs) {
        for (String size : List.of("high", "medium", "default")) {
            String url = textOrEmpty(thumbs.path(size).path("url"));
            if (isAllowedThumbUrl(url)) {
                return "external/youtube/image?u=" + URLEncoder.encode(url, StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    static boolean isAllowedThumbUrl(String rawUrl) {
        if (!StringUtils.hasText(rawUrl) || !rawUrl.startsWith("https://")) {
            return false;
        }
        try {
            URI uri = URI.create(rawUrl);
            String host = uri.getHost();
            if (host == null) {
                return false;
            }
            String h = host.toLowerCase(Locale.ROOT);
            return h.equals("img.youtube.com")
                    || h.equals("i.ytimg.com")
                    || h.endsWith(".ytimg.com")
                    || h.equals("yt3.ggpht.com")
                    || h.endsWith(".ggpht.com")
                    || h.equals("yt3.googleusercontent.com");
        } catch (Exception e) {
            return false;
        }
    }

    private static String normalizeType(String type) {
        String value = type == null ? "video" : type.trim().toLowerCase(Locale.ROOT);
        return SAFE_TYPES.contains(value) ? value : "video";
    }

    private static String normalizeOrder(String order) {
        if (!StringUtils.hasText(order)) {
            return "";
        }
        String value = order.trim();
        if ("views".equalsIgnoreCase(value)) {
            value = "viewCount";
        }
        return SAFE_ORDERS.contains(value) ? value : "";
    }

    private static String normalizeRegion(String region) {
        if (!StringUtils.hasText(region)) {
            return "";
        }
        String code = region.trim().toUpperCase(Locale.ROOT);
        return SAFE_REGIONS.contains(code) ? code : "";
    }

    private static String normalizeLang(String lang) {
        if (!StringUtils.hasText(lang)) {
            return "";
        }
        String code = lang.trim().toLowerCase(Locale.ROOT);
        if (code.startsWith("jp")) {
            code = "ja";
        } else if (code.startsWith("cn")) {
            code = "zh";
        } else if (code.startsWith("in")) {
            code = "hi";
        }
        if (code.length() > 2) {
            code = code.substring(0, 2);
        }
        return SAFE_LANGS.contains(code) ? code : "";
    }

    private static String normalizeToken(String token) {
        if (!StringUtils.hasText(token)) {
            return "";
        }
        String value = token.trim();
        if (SAFE_TOKEN.matcher(value).matches()) {
            return value;
        }
        if (value.length() <= 4000 && value.chars().allMatch(ch -> ch >= 33 && ch <= 126)) {
            return value;
        }
        return "";
    }

    private static boolean isInnertubeContinuation(String token) {
        return token != null && token.length() > 200;
    }

    private static String normalizeChannel(String channelId) {
        if (!StringUtils.hasText(channelId)) {
            return "";
        }
        String value = channelId.trim();
        return SAFE_CHANNEL.matcher(value).matches() ? value : "";
    }

    /** YouTube video category ids are small integers (e.g. 10 = Music). */
    private static String normalizeCategory(String categoryId) {
        if (!StringUtils.hasText(categoryId)) {
            return "";
        }
        String value = categoryId.trim();
        return value.matches("\\d{1,3}") ? value : "";
    }

    private static int clampLimit(Integer limit) {
        if (limit == null) {
            return DEFAULT_LIMIT;
        }
        return Math.max(1, Math.min(MAX_LIMIT, limit));
    }

    private static String trimSlash(String base) {
        if (!StringUtils.hasText(base)) {
            return "https://www.googleapis.com/youtube/v3";
        }
        String value = base.trim();
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    private static String textOrEmpty(JsonNode node) {
        return node != null && node.isTextual() ? node.asText() : "";
    }

    private static String textOrNull(JsonNode node) {
        String value = textOrEmpty(node);
        return StringUtils.hasText(value) ? value : null;
    }

    /** YouTube titles/descriptions often arrive HTML-encoded (`&#39;`, `&amp;`, `&quot;`). */
    private static String htmlTextOrNull(JsonNode node) {
        String value = textOrNull(node);
        if (value == null) {
            return null;
        }
        String decoded = HtmlUtils.htmlUnescape(value);
        if (decoded.contains("&")) {
            decoded = HtmlUtils.htmlUnescape(decoded);
        }
        return decoded;
    }

    private static Long longOrNull(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return null;
        }
        if (node.isNumber()) {
            return node.asLong();
        }
        if (node.isTextual()) {
            try {
                return Long.parseLong(node.asText());
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private record CacheEntry(YoutubeSearchPageDto page, Instant expiresAt) {
    }
}
