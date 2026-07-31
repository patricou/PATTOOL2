package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.WebcamCodeLabelDto;
import com.pat.controller.dto.WebcamItemDto;
import com.pat.controller.dto.WebcamSearchPageDto;
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
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Windy Webcams API v3 catalog (worldwide live / timelapse webcams).
 * Docs: https://api.windy.com/webcams/docs
 */
@Service
public class WindyWebcamCatalogService {

    private static final Logger log = LoggerFactory.getLogger(WindyWebcamCatalogService.class);

    private static final String USER_AGENT = "PatTool/1.0 (webcam-watcher; https://github.com)";
    private static final String INCLUDE = "categories,images,location,player,urls";
    private static final Duration META_CACHE_TTL = Duration.ofHours(12);
    private static final Duration LIST_CACHE_TTL = Duration.ofMinutes(2);

    private final ObjectMapper objectMapper;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final ConcurrentHashMap<String, CacheEntry<List<WebcamCodeLabelDto>>> metaCache =
            new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CacheEntry<WebcamSearchPageDto>> listCache =
            new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CacheEntry<WebcamItemDto>> detailCache =
            new ConcurrentHashMap<>();

    @Value("${app.webcam.windy-api-base:https://api.windy.com/webcams/api/v3}")
    private String apiBase;

    @Value("${app.webcam.windy-api-key:}")
    private String apiKey;

    @Value("${app.webcam.search-cache-minutes:2}")
    private int searchCacheMinutes;

    public WindyWebcamCatalogService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public boolean isConfigured() {
        return StringUtils.hasText(apiKey);
    }

    public List<WebcamCodeLabelDto> continents(String lang) {
        return listMeta("continents", lang, "code", "name");
    }

    public List<WebcamCodeLabelDto> countries(String lang) {
        return listMeta("countries", lang, "code", "name");
    }

    public List<WebcamCodeLabelDto> categories(String lang) {
        return listMeta("categories", lang, "id", "name");
    }

    public WebcamSearchPageDto search(
            String countries,
            String continents,
            String categories,
            String nearby,
            String sortKey,
            String sortDirection,
            int limit,
            int offset,
            String lang) {
        int safeLimit = clamp(limit, 1, 50, 24);
        int safeOffset = Math.max(0, Math.min(offset, 1000));
        String safeLang = normalizeLang(lang);
        String safeSort = normalizeSortKey(sortKey);
        String safeDir = "asc".equalsIgnoreCase(sortDirection) ? "asc" : "desc";

        WebcamSearchPageDto page = new WebcamSearchPageDto();
        page.setLimit(safeLimit);
        page.setOffset(safeOffset);
        page.setCountries(trimOrNull(countries));
        page.setContinents(trimOrNull(continents));
        page.setCategories(trimOrNull(categories));
        page.setNearby(trimOrNull(nearby));
        page.setSortKey(safeSort);

        if (!isConfigured()) {
            page.setError("missing_api_key");
            page.setMessage("Configure app.webcam.windy-api-key (clé gratuite sur api.windy.com/keys)");
            return page;
        }

        String cacheKey = "list|" + safeLang + "|" + nullToEmpty(countries) + "|" + nullToEmpty(continents)
                + "|" + nullToEmpty(categories) + "|" + nullToEmpty(nearby) + "|" + safeSort + "|" + safeDir
                + "|" + safeLimit + "|" + safeOffset;
        CacheEntry<WebcamSearchPageDto> cached = listCache.get(cacheKey);
        if (cached != null && !cached.isExpired(listCacheTtl())) {
            return cached.value();
        }

        try {
            StringBuilder url = new StringBuilder(trimSlash(apiBase))
                    .append("/webcams?include=").append(enc(INCLUDE))
                    .append("&lang=").append(enc(safeLang))
                    .append("&limit=").append(safeLimit)
                    .append("&offset=").append(safeOffset)
                    .append("&sortKey=").append(enc(safeSort))
                    .append("&sortDirection=").append(enc(safeDir));
            if (StringUtils.hasText(countries)) {
                url.append("&countries=").append(enc(countries.trim()));
            }
            if (StringUtils.hasText(continents)) {
                url.append("&continents=").append(enc(continents.trim()));
            }
            if (StringUtils.hasText(categories)) {
                url.append("&categories=").append(enc(categories.trim()));
                url.append("&categoryOperation=or");
            }
            if (StringUtils.hasText(nearby)) {
                url.append("&nearby=").append(enc(nearby.trim()));
            }

            JsonNode root = getJson(url.toString());
            page.setTotal(root.path("total").asInt(0));
            List<WebcamItemDto> items = new ArrayList<>();
            JsonNode webcams = root.path("webcams");
            if (webcams.isArray()) {
                for (JsonNode node : webcams) {
                    WebcamItemDto item = mapWebcam(node);
                    if (item != null) {
                        items.add(item);
                    }
                }
            }
            page.setWebcams(items);
            listCache.put(cacheKey, new CacheEntry<>(page));
            return page;
        } catch (Exception e) {
            log.warn("Windy webcam search failed: {}", e.toString());
            page.setError("windy_error");
            page.setMessage(e.getMessage() != null ? e.getMessage() : "Windy API error");
            return page;
        }
    }

    public Optional<WebcamItemDto> getWebcam(String webcamId, String lang) {
        if (!StringUtils.hasText(webcamId) || !webcamId.matches("^[0-9]{1,20}$")) {
            return Optional.empty();
        }
        if (!isConfigured()) {
            return Optional.empty();
        }
        String safeLang = normalizeLang(lang);
        String cacheKey = "detail|" + webcamId + "|" + safeLang;
        CacheEntry<WebcamItemDto> cached = detailCache.get(cacheKey);
        if (cached != null && !cached.isExpired(listCacheTtl())) {
            return Optional.of(cached.value());
        }
        try {
            String url = trimSlash(apiBase) + "/webcams/" + webcamId
                    + "?include=" + enc(INCLUDE)
                    + "&lang=" + enc(safeLang);
            JsonNode root = getJson(url);
            WebcamItemDto item = mapWebcam(root);
            if (item == null) {
                return Optional.empty();
            }
            detailCache.put(cacheKey, new CacheEntry<>(item));
            return Optional.of(item);
        } catch (Exception e) {
            log.warn("Windy webcam detail failed for {}: {}", webcamId, e.toString());
            return Optional.empty();
        }
    }

    private List<WebcamCodeLabelDto> listMeta(String path, String lang, String codeField, String nameField) {
        String safeLang = normalizeLang(lang);
        String cacheKey = path + "|" + safeLang;
        CacheEntry<List<WebcamCodeLabelDto>> cached = metaCache.get(cacheKey);
        if (cached != null && !cached.isExpired(META_CACHE_TTL)) {
            return cached.value();
        }
        if (!isConfigured()) {
            return List.of();
        }
        try {
            String url = trimSlash(apiBase) + "/" + path + "?lang=" + enc(safeLang);
            JsonNode root = getJson(url);
            List<WebcamCodeLabelDto> list = new ArrayList<>();
            if (root.isArray()) {
                for (JsonNode node : root) {
                    String code = text(node, codeField);
                    String name = text(node, nameField);
                    if (StringUtils.hasText(code)) {
                        list.add(new WebcamCodeLabelDto(code, StringUtils.hasText(name) ? name : code));
                    }
                }
            }
            list.sort(Comparator.comparing(c -> c.getLabel() != null ? c.getLabel() : "",
                    String.CASE_INSENSITIVE_ORDER));
            metaCache.put(cacheKey, new CacheEntry<>(list));
            return list;
        } catch (Exception e) {
            log.warn("Windy {} list failed: {}", path, e.toString());
            return List.of();
        }
    }

    private WebcamItemDto mapWebcam(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return null;
        }
        String id = node.path("webcamId").asText(null);
        if (!StringUtils.hasText(id)) {
            id = node.path("id").asText(null);
        }
        if (!StringUtils.hasText(id)) {
            return null;
        }
        WebcamItemDto dto = new WebcamItemDto();
        dto.setId(id);
        dto.setTitle(text(node, "title"));
        dto.setStatus(text(node, "status"));
        if (node.has("viewCount") && !node.path("viewCount").isNull()) {
            dto.setViewCount(node.path("viewCount").asLong());
        }
        dto.setLastUpdatedOn(text(node, "lastUpdatedOn"));

        JsonNode location = node.path("location");
        if (location.isObject()) {
            dto.setCity(text(location, "city"));
            dto.setRegion(text(location, "region"));
            dto.setCountry(text(location, "country"));
            dto.setCountryCode(text(location, "country_code"));
            dto.setContinent(text(location, "continent"));
            dto.setContinentCode(text(location, "continent_code"));
            if (location.has("latitude") && location.path("latitude").isNumber()) {
                dto.setLatitude(location.path("latitude").asDouble());
            }
            if (location.has("longitude") && location.path("longitude").isNumber()) {
                dto.setLongitude(location.path("longitude").asDouble());
            }
        }

        JsonNode images = node.path("images").path("current");
        if (images.isObject()) {
            String preview = firstImage(images, "preview", "thumbnail", "icon");
            String thumb = firstImage(images, "thumbnail", "icon", "preview");
            dto.setImagePreviewUrl(preview);
            dto.setImageUrl(thumb != null ? thumb : preview);
        }

        JsonNode player = node.path("player");
        if (player.isObject()) {
            dto.setPlayerDayUrl(playerUrl(player, "day"));
            dto.setPlayerLiveUrl(playerUrl(player, "live"));
            dto.setPlayerMonthUrl(playerUrl(player, "month"));
        }

        JsonNode urls = node.path("urls");
        if (urls.isObject()) {
            dto.setDetailUrl(text(urls, "detail"));
        }
        if (!StringUtils.hasText(dto.getDetailUrl())) {
            dto.setDetailUrl("https://www.windy.com/webcams/" + id);
        }

        List<String> cats = new ArrayList<>();
        JsonNode categories = node.path("categories");
        if (categories.isArray()) {
            for (JsonNode cat : categories) {
                String name = text(cat, "name");
                if (!StringUtils.hasText(name)) {
                    name = text(cat, "id");
                }
                if (StringUtils.hasText(name)) {
                    cats.add(name);
                }
            }
        }
        dto.setCategories(cats);
        return dto;
    }

    private static String playerUrl(JsonNode player, String key) {
        JsonNode part = player.path(key);
        if (part.isTextual()) {
            return part.asText(null);
        }
        if (part.isObject()) {
            String embed = text(part, "embed");
            if (StringUtils.hasText(embed)) {
                return embed;
            }
            return text(part, "link");
        }
        return null;
    }

    private static String firstImage(JsonNode images, String... keys) {
        for (String key : keys) {
            String url = text(images, key);
            if (StringUtils.hasText(url)) {
                return url;
            }
        }
        return null;
    }

    private JsonNode getJson(String url) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/json")
                .header("x-windy-api-key", apiKey.trim())
                .GET();
        HttpResponse<String> response = httpClient.send(builder.build(),
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        int code = response.statusCode();
        if (code == 401 || code == 403) {
            throw new IllegalStateException("Clé Windy invalide ou non autorisée (HTTP " + code + ")");
        }
        if (code < 200 || code >= 300) {
            throw new IllegalStateException("HTTP " + code + " from Windy");
        }
        String body = response.body();
        if (!StringUtils.hasText(body)) {
            throw new IllegalStateException("Empty response from Windy");
        }
        return objectMapper.readTree(body);
    }

    private Duration listCacheTtl() {
        int minutes = Math.max(1, Math.min(searchCacheMinutes, 30));
        return Duration.ofMinutes(minutes);
    }

    private static String normalizeLang(String lang) {
        if (!StringUtils.hasText(lang)) {
            return "en";
        }
        String l = lang.trim().toLowerCase(Locale.ROOT);
        if (l.startsWith("jp") || l.equals("ja")) {
            return "ja";
        }
        if (l.startsWith("cn") || l.startsWith("zh")) {
            return "zh";
        }
        if (l.length() >= 2) {
            return l.substring(0, 2);
        }
        return "en";
    }

    private static String normalizeSortKey(String sortKey) {
        if ("createdOn".equalsIgnoreCase(sortKey)) {
            return "createdOn";
        }
        return "popularity";
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node.path(field);
        if (v.isMissingNode() || v.isNull()) {
            return null;
        }
        String s = v.asText(null);
        return StringUtils.hasText(s) ? s.trim() : null;
    }

    private static String trimOrNull(String s) {
        return StringUtils.hasText(s) ? s.trim() : null;
    }

    private static String nullToEmpty(String s) {
        return s != null ? s.trim() : "";
    }

    private static String trimSlash(String base) {
        if (base == null || base.isBlank()) {
            return "https://api.windy.com/webcams/api/v3";
        }
        String b = base.trim();
        while (b.endsWith("/")) {
            b = b.substring(0, b.length() - 1);
        }
        return b;
    }

    private static String enc(String value) {
        return URLEncoder.encode(value != null ? value : "", StandardCharsets.UTF_8);
    }

    private static int clamp(int value, int min, int max, int fallback) {
        if (value < min || value > max) {
            return fallback;
        }
        return value;
    }

    private record CacheEntry<T>(T value, Instant createdAt) {
        CacheEntry(T value) {
            this(value, Instant.now());
        }

        boolean isExpired(Duration ttl) {
            return Instant.now().isAfter(createdAt.plus(ttl));
        }
    }
}
