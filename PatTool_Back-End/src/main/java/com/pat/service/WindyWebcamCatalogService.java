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
import java.text.Normalizer;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
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
    /** Windy has no free-text search; we scan pages then filter locally. */
    private static final int TEXT_SCAN_PAGE_SIZE = 50;
    private static final int TEXT_SCAN_MAX_ITEMS = 400;
    private static final int TEXT_SEARCH_NEARBY_RADIUS_KM = 80;

    private final ObjectMapper objectMapper;
    private final GeocodeService geocodeService;
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

    public WindyWebcamCatalogService(ObjectMapper objectMapper, GeocodeService geocodeService) {
        this.objectMapper = objectMapper;
        this.geocodeService = geocodeService;
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
            String q,
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
        String safeQ = trimOrNull(q);

        WebcamSearchPageDto page = new WebcamSearchPageDto();
        page.setLimit(safeLimit);
        page.setOffset(safeOffset);
        page.setCountries(trimOrNull(countries));
        page.setContinents(trimOrNull(continents));
        page.setCategories(trimOrNull(categories));
        page.setNearby(trimOrNull(nearby));
        page.setQ(safeQ);
        page.setSortKey(safeSort);

        if (!isConfigured()) {
            page.setError("missing_api_key");
            page.setMessage("Configure app.webcam.windy-api-key (clé gratuite sur api.windy.com/keys)");
            return page;
        }

        String effectiveCountries = trimOrNull(countries);
        String effectiveContinents = trimOrNull(continents);
        String effectiveNearby = trimOrNull(nearby);
        if (safeQ != null) {
            if (effectiveCountries == null) {
                String matchedCountry = matchCountryCode(safeQ, safeLang);
                if (matchedCountry != null) {
                    effectiveCountries = matchedCountry;
                } else if (effectiveNearby == null) {
                    effectiveNearby = resolveNearbyFromQuery(safeQ);
                    if (effectiveNearby != null) {
                        // Place search: prefer geo radius over a whole continent.
                        effectiveContinents = null;
                    }
                }
            } else if (effectiveNearby == null) {
                // Refine within the selected country (e.g. "Parma" + Italie).
                effectiveNearby = resolveNearbyFromQuery(safeQ);
                if (effectiveNearby != null) {
                    effectiveContinents = null;
                }
            }
        }
        page.setCountries(effectiveCountries);
        page.setContinents(effectiveContinents);
        page.setNearby(effectiveNearby);

        String cacheKey = "list|" + safeLang + "|" + nullToEmpty(effectiveCountries) + "|"
                + nullToEmpty(effectiveContinents) + "|" + nullToEmpty(categories) + "|"
                + nullToEmpty(effectiveNearby) + "|" + nullToEmpty(safeQ) + "|" + safeSort + "|" + safeDir
                + "|" + safeLimit + "|" + safeOffset;
        CacheEntry<WebcamSearchPageDto> cached = listCache.get(cacheKey);
        if (cached != null && !cached.isExpired(listCacheTtl())) {
            return cached.value();
        }

        try {
            if (safeQ != null) {
                boolean nearbyFromGeocode = effectiveNearby != null
                        && (nearby == null || nearby.isBlank());
                if (nearbyFromGeocode) {
                    // Place resolved via Nominatim — Windy nearby already scopes by location.
                    JsonNode root = fetchWindyList(effectiveCountries, effectiveContinents, categories,
                            effectiveNearby, safeSort, safeDir, safeLimit, safeOffset, safeLang);
                    page.setTotal(root.path("total").asInt(0));
                    page.setWebcams(mapWebcamList(root));
                } else {
                    searchWithTextFilter(page, effectiveCountries, effectiveContinents, categories,
                            effectiveNearby, safeQ, safeSort, safeDir, safeLimit, safeOffset, safeLang);
                }
            } else {
                JsonNode root = fetchWindyList(effectiveCountries, effectiveContinents, categories,
                        effectiveNearby, safeSort, safeDir, safeLimit, safeOffset, safeLang);
                page.setTotal(root.path("total").asInt(0));
                page.setWebcams(mapWebcamList(root));
            }
            listCache.put(cacheKey, new CacheEntry<>(page));
            return page;
        } catch (Exception e) {
            log.warn("Windy webcam search failed: {}", e.toString());
            page.setError("windy_error");
            page.setMessage(e.getMessage() != null ? e.getMessage() : "Windy API error");
            return page;
        }
    }

    private void searchWithTextFilter(
            WebcamSearchPageDto page,
            String countries,
            String continents,
            String categories,
            String nearby,
            String q,
            String sortKey,
            String sortDirection,
            int limit,
            int offset,
            String lang) throws Exception {
        List<String> tokens = tokenizeQuery(q);
        List<WebcamItemDto> matches = new ArrayList<>();
        int scanned = 0;
        int windyTotal = Integer.MAX_VALUE;
        int fetchOffset = 0;

        while (scanned < TEXT_SCAN_MAX_ITEMS && fetchOffset < windyTotal && fetchOffset <= 1000) {
            int batch = Math.min(TEXT_SCAN_PAGE_SIZE, TEXT_SCAN_MAX_ITEMS - scanned);
            JsonNode root = fetchWindyList(countries, continents, categories, nearby,
                    sortKey, sortDirection, batch, fetchOffset, lang);
            windyTotal = root.path("total").asInt(0);
            List<WebcamItemDto> batchItems = mapWebcamList(root);
            if (batchItems.isEmpty()) {
                break;
            }
            for (WebcamItemDto item : batchItems) {
                if (matchesQuery(item, tokens)) {
                    matches.add(item);
                }
            }
            scanned += batchItems.size();
            fetchOffset += batchItems.size();
            if (batchItems.size() < batch) {
                break;
            }
        }

        page.setTotal(matches.size());
        int from = Math.min(offset, matches.size());
        int to = Math.min(from + limit, matches.size());
        page.setWebcams(new ArrayList<>(matches.subList(from, to)));
    }

    private JsonNode fetchWindyList(
            String countries,
            String continents,
            String categories,
            String nearby,
            String sortKey,
            String sortDirection,
            int limit,
            int offset,
            String lang) throws Exception {
        StringBuilder url = new StringBuilder(trimSlash(apiBase))
                .append("/webcams?include=").append(enc(INCLUDE))
                .append("&lang=").append(enc(lang))
                .append("&limit=").append(limit)
                .append("&offset=").append(offset)
                .append("&sortKey=").append(enc(sortKey))
                .append("&sortDirection=").append(enc(sortDirection));
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
        return getJson(url.toString());
    }

    private List<WebcamItemDto> mapWebcamList(JsonNode root) {
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
        return items;
    }

    private String matchCountryCode(String q, String lang) {
        String needle = fold(q);
        if (!StringUtils.hasText(needle)) {
            return null;
        }
        for (WebcamCodeLabelDto c : countries(lang)) {
            if (c.getCode() == null) {
                continue;
            }
            if (fold(c.getCode()).equals(needle) || fold(c.getLabel()).equals(needle)) {
                return c.getCode();
            }
        }
        // Partial label match only for longer queries (avoid "a" → Australia).
        if (needle.length() >= 4) {
            for (WebcamCodeLabelDto c : countries(lang)) {
                String label = fold(c.getLabel());
                if (label != null && (label.contains(needle) || needle.contains(label))) {
                    return c.getCode();
                }
            }
        }
        return null;
    }

    private String resolveNearbyFromQuery(String q) {
        if (q.length() < 2) {
            return null;
        }
        try {
            List<Map<String, Object>> hits = geocodeService.search(q);
            if (hits == null || hits.isEmpty()) {
                return null;
            }
            Map<String, Object> first = hits.get(0);
            Object latObj = first.get("lat");
            Object lonObj = first.get("lon");
            if (!(latObj instanceof Number) || !(lonObj instanceof Number)) {
                return null;
            }
            double lat = ((Number) latObj).doubleValue();
            double lon = ((Number) lonObj).doubleValue();
            if (Double.isNaN(lat) || Double.isNaN(lon)) {
                return null;
            }
            return lat + "," + lon + "," + TEXT_SEARCH_NEARBY_RADIUS_KM;
        } catch (Exception e) {
            log.debug("Webcam text search geocode failed for '{}': {}", q, e.toString());
            return null;
        }
    }

    private static List<String> tokenizeQuery(String q) {
        String[] parts = fold(q).split("[\\s,;|/]+");
        Set<String> tokens = new LinkedHashSet<>();
        for (String part : parts) {
            if (part != null && part.length() >= 2) {
                tokens.add(part);
            }
        }
        if (tokens.isEmpty() && StringUtils.hasText(q) && fold(q).length() >= 1) {
            tokens.add(fold(q));
        }
        return new ArrayList<>(tokens);
    }

    private static boolean matchesQuery(WebcamItemDto item, List<String> tokens) {
        if (tokens == null || tokens.isEmpty()) {
            return true;
        }
        StringBuilder hay = new StringBuilder();
        appendHay(hay, item.getTitle());
        appendHay(hay, item.getCity());
        appendHay(hay, item.getRegion());
        appendHay(hay, item.getCountry());
        appendHay(hay, item.getCountryCode());
        appendHay(hay, item.getContinent());
        appendHay(hay, item.getId());
        if (item.getCategories() != null) {
            for (String cat : item.getCategories()) {
                appendHay(hay, cat);
            }
        }
        String haystack = fold(hay.toString());
        for (String token : tokens) {
            if (!haystack.contains(token)) {
                return false;
            }
        }
        return true;
    }

    private static void appendHay(StringBuilder hay, String value) {
        if (StringUtils.hasText(value)) {
            if (hay.length() > 0) {
                hay.append(' ');
            }
            hay.append(value);
        }
    }

    /** Lowercase + strip diacritics for tolerant matching (Parme / Parma). */
    private static String fold(String s) {
        if (s == null) {
            return "";
        }
        String n = Normalizer.normalize(s.trim(), Normalizer.Form.NFD)
                .replaceAll("\\p{M}+", "");
        return n.toLowerCase(Locale.ROOT);
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
        dto.setProvider("windy");
        dto.setTitle(text(node, "title"));
        dto.setStatus(text(node, "status"));
        if (node.has("viewCount") && !node.path("viewCount").isNull()) {
            dto.setViewCount(node.path("viewCount").asLong());
        }
        dto.setLastUpdatedOn(normalizeEpochOrIso(text(node, "lastUpdatedOn")));

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
            // Prefer embed URLs only — Windy "link" pages (www.windy.com) refuse iframe embedding.
            if (part.path("available").isBoolean() && !part.path("available").asBoolean()) {
                return null;
            }
            return text(part, "embed");
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
        if (v.isNumber()) {
            return Long.toString(v.asLong());
        }
        String s = v.asText(null);
        return StringUtils.hasText(s) ? s.trim() : null;
    }

    /** Windy often sends Unix epoch seconds; normalize to ISO-8601 for the UI. */
    private static String normalizeEpochOrIso(String raw) {
        if (!StringUtils.hasText(raw)) {
            return null;
        }
        String t = raw.trim();
        if (t.matches("^\\d{10,13}$")) {
            try {
                long n = Long.parseLong(t);
                long epochMs = n < 1_000_000_000_000L ? n * 1000L : n;
                return Instant.ofEpochMilli(epochMs).toString();
            } catch (NumberFormatException ignored) {
                return t;
            }
        }
        return t;
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
