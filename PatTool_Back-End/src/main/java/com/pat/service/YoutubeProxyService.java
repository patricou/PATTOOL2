package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * YouTube Data API v3 proxy. The browser never calls googleapis.com and never
 * sees {@code app.youtube.api-key}. Thumbnails are rewritten to this API too.
 */
@Service
public class YoutubeProxyService {

    private static final Logger log = LoggerFactory.getLogger(YoutubeProxyService.class);
    private static final String USER_AGENT = "PatTool/1.0 (youtube helper; https://www.patrickdeschamps.com)";
    private static final int DEFAULT_LIMIT = 12;
    private static final int MAX_LIMIT = 25;
    private static final Duration CACHE_TTL = Duration.ofMinutes(8);
    private static final Pattern SAFE_QUERY = Pattern.compile("^[\\p{L}\\p{N}\\p{P}\\p{S}\\p{Z}_]{1,100}$");
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

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final String apiBase;
    private final String apiKey;
    private final ConcurrentHashMap<String, CacheEntry> cache = new ConcurrentHashMap<>();

    public YoutubeProxyService(
            RestTemplateBuilder builder,
            ObjectMapper objectMapper,
            @Value("${app.youtube.api-base:https://www.googleapis.com/youtube/v3}") String apiBase,
            @Value("${app.youtube.api-key:}") String apiKey) {
        this.restTemplate = builder
                .setConnectTimeout(Duration.ofSeconds(5))
                .setReadTimeout(Duration.ofSeconds(12))
                .build();
        this.objectMapper = objectMapper;
        this.apiBase = trimSlash(apiBase);
        this.apiKey = apiKey == null ? "" : apiKey.trim();
    }

    public boolean isConfigured() {
        return StringUtils.hasText(apiKey);
    }

    /**
     * Proxy a YouTube CDN thumbnail. Host allow-list + SSRF guard; the browser
     * never talks to i.ytimg.com / ggpht directly.
     */
    public ResponseEntity<byte[]> proxyThumbnail(String rawUrl) {
        if (!isAllowedThumbUrl(rawUrl)) {
            return ResponseEntity.badRequest().build();
        }
        HttpURLConnection conn = null;
        try {
            URL u = new URL(rawUrl);
            InetAddress addr = InetAddress.getByName(u.getHost());
            if (addr.isAnyLocalAddress() || addr.isLoopbackAddress()
                    || addr.isLinkLocalAddress() || addr.isSiteLocalAddress()) {
                return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
            }
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(5_000);
            conn.setReadTimeout(8_000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", USER_AGENT);
            conn.setRequestProperty("Accept", "image/*,*/*;q=0.5");
            int code = conn.getResponseCode();
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
            String order) {
        if (!isConfigured()) {
            return YoutubeSearchPageDto.missingKey();
        }
        String q = query == null ? "" : query.trim();
        String kind = normalizeType(type);
        String region = normalizeRegion(regionCode);
        String lang = normalizeLang(relevanceLanguage);
        String channel = normalizeChannel(channelId);
        String token = normalizeToken(pageToken);
        String sort = normalizeOrder(order);
        int limit = clampLimit(maxResults);
        if (!StringUtils.hasText(q) && !StringUtils.hasText(channel)) {
            return emptyPage("search", q, kind, region);
        }
        if (StringUtils.hasText(q) && !SAFE_QUERY.matcher(q).matches()) {
            return YoutubeSearchPageDto.failure("invalid_query", "invalid_query");
        }
        String cacheKey = "search|" + q + "|" + kind + "|" + region + "|" + lang + "|" + channel + "|" + sort + "|" + token + "|" + limit;
        YoutubeSearchPageDto cached = fromCache(cacheKey);
        if (cached != null) {
            return cached;
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
        if (StringUtils.hasText(channel) && "video".equals(kind)) {
            builder.queryParam("channelId", channel);
        }
        if (StringUtils.hasText(sort) && !"relevance".equals(sort)) {
            builder.queryParam("order", sort);
        }
        if (StringUtils.hasText(token)) {
            builder.queryParam("pageToken", token);
        }
        JsonNode raw = fetchJson(withKey(builder), "search");
        if (raw == null) {
            return YoutubeSearchPageDto.failure("upstream_error", "YouTube search failed");
        }
        String apiError = apiError(raw);
        if (apiError != null) {
            return YoutubeSearchPageDto.failure(apiError, textOrEmpty(raw.path("error").path("message")));
        }
        List<YoutubeItemDto> items = mapSearchItems(raw.path("items"));
        if ("video".equals(kind)) {
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

    public YoutubeSearchPageDto popular(String regionCode, String pageToken, Integer maxResults) {
        if (!isConfigured()) {
            return YoutubeSearchPageDto.missingKey();
        }
        String region = normalizeRegion(regionCode);
        if (!StringUtils.hasText(region)) {
            region = "FR";
        }
        String token = normalizeToken(pageToken);
        int limit = clampLimit(maxResults);
        String cacheKey = "popular|" + region + "|" + token + "|" + limit;
        YoutubeSearchPageDto cached = fromCache(cacheKey);
        if (cached != null) {
            return cached;
        }
        UriComponentsBuilder builder = UriComponentsBuilder.fromUriString(apiBase + "/videos")
                .queryParam("part", "snippet,contentDetails,statistics")
                .queryParam("chart", "mostPopular")
                .queryParam("regionCode", region)
                .queryParam("maxResults", limit);
        if (StringUtils.hasText(token)) {
            builder.queryParam("pageToken", token);
        }
        JsonNode raw = fetchJson(withKey(builder), "popular");
        if (raw == null) {
            return YoutubeSearchPageDto.failure("upstream_error", "YouTube popular failed");
        }
        String apiError = apiError(raw);
        if (apiError != null) {
            return YoutubeSearchPageDto.failure(apiError, textOrEmpty(raw.path("error").path("message")));
        }
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
                    textOrNull(snippet.path("title")),
                    textOrNull(snippet.path("description")),
                    textOrNull(snippet.path("channelTitle")),
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
                    textOrNull(snippet.path("title")),
                    textOrNull(snippet.path("description")),
                    textOrNull(snippet.path("channelTitle")),
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
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
            headers.set(HttpHeaders.ACCEPT, "application/json");
            ResponseEntity<String> response = restTemplate.exchange(
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
                if ("quotaExceeded".equals(reason) || "dailyLimitExceeded".equals(reason)) {
                    return "quota_exceeded";
                }
                if ("keyInvalid".equals(reason) || "badRequest".equals(reason)) {
                    return "invalid_key";
                }
            }
        }
        int code = raw.path("error").path("code").asInt(0);
        if (code == 403) {
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
        return SAFE_TOKEN.matcher(value).matches() ? value : "";
    }

    private static String normalizeChannel(String channelId) {
        if (!StringUtils.hasText(channelId)) {
            return "";
        }
        String value = channelId.trim();
        return SAFE_CHANNEL.matcher(value).matches() ? value : "";
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
