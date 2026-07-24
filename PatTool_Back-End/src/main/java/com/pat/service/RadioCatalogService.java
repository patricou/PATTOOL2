package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.RadioCountryDto;
import com.pat.controller.dto.RadioStationDto;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Loads worldwide internet radio stations from radio-browser.info and caches them in memory.
 * Uses multiple API mirrors with failover; failed fetches do not overwrite a warm cache with [].
 */
@Service
public class RadioCatalogService {

    private static final Logger log = LoggerFactory.getLogger(RadioCatalogService.class);

    private static final Pattern COUNTRY_CODE = Pattern.compile("^[a-z]{2}$");
    private static final String USER_AGENT = "PatTool/1.0 (radio-watcher; https://github.com)";

    /** Built-in mirrors when app.radio.api-base-urls is unset (network shrinks over time). */
    private static final List<String> DEFAULT_API_BASES = List.of(
            "https://de1.api.radio-browser.info",
            "https://de2.api.radio-browser.info",
            "https://all.api.radio-browser.info"
    );

    private final ObjectMapper objectMapper;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(12))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    /** Preferred first base (kept for backward compatibility with app.radio.api-base-url). */
    @Value("${app.radio.api-base-url:https://de1.api.radio-browser.info}")
    private String apiBaseUrl;

    /**
     * Optional comma-separated mirror list. When empty, uses {@link #apiBaseUrl} plus built-in fallbacks.
     */
    @Value("${app.radio.api-base-urls:}")
    private String apiBaseUrls;

    @Value("${app.radio.catalog-cache-minutes:60}")
    private int catalogCacheMinutes;

    private final ConcurrentHashMap<String, CacheEntry<List<RadioStationDto>>> stationCache = new ConcurrentHashMap<>();
    private volatile CacheEntry<List<RadioCountryDto>> countriesCache;
    private volatile CacheEntry<List<String>> worldwideTagsCache;
    private volatile int mirrorRotateOffset = 0;

    public RadioCatalogService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public boolean isAllCountries(String country) {
        return country != null && "all".equalsIgnoreCase(country.trim());
    }

    public boolean isSupportedCountry(String country) {
        if (!StringUtils.hasText(country)) {
            return false;
        }
        String code = country.trim().toLowerCase(Locale.ROOT);
        return COUNTRY_CODE.matcher(code).matches();
    }

    public List<RadioCountryDto> listCountries() {
        CacheEntry<List<RadioCountryDto>> cached = countriesCache;
        if (cached != null && !cached.isExpired(catalogCacheMinutes) && !cached.value.isEmpty()) {
            return cached.value;
        }
        synchronized (this) {
            cached = countriesCache;
            if (cached != null && !cached.isExpired(catalogCacheMinutes) && !cached.value.isEmpty()) {
                return cached.value;
            }
            List<RadioCountryDto> loaded = fetchCountries();
            if (!loaded.isEmpty()) {
                countriesCache = new CacheEntry<>(loaded);
                return loaded;
            }
            // Upstream down: keep serving a warm (even expired) cache rather than an empty UI.
            if (cached != null && !cached.value.isEmpty()) {
                log.warn("radio countries upstream failed — serving stale cache ({} entries)", cached.value.size());
                return cached.value;
            }
            countriesCache = new CacheEntry<>(List.of());
            return List.of();
        }
    }

    public int countStations(String country) {
        if (isAllCountries(country)) {
            return listCountries().stream().mapToInt(RadioCountryDto::getStationCount).sum();
        }
        String code = country.trim().toLowerCase(Locale.ROOT);
        return listCountries().stream()
                .filter(c -> code.equals(c.getCode()))
                .mapToInt(RadioCountryDto::getStationCount)
                .findFirst()
                .orElse(0);
    }

    public List<RadioStationDto> listStations(String country) {
        String code = country.trim().toLowerCase(Locale.ROOT);
        CacheEntry<List<RadioStationDto>> cached = stationCache.get(code);
        if (cached != null && !cached.isExpired(catalogCacheMinutes) && !cached.value.isEmpty()) {
            return cached.value;
        }
        List<RadioStationDto> loaded = fetchStationsByCountry(code);
        if (!loaded.isEmpty()) {
            stationCache.put(code, new CacheEntry<>(loaded));
            return loaded;
        }
        if (cached != null && !cached.value.isEmpty()) {
            log.warn("radio stations upstream failed for {} — serving stale cache ({} entries)",
                    code, cached.value.size());
            return cached.value;
        }
        // Do not poison the cache with [] on a transient 503 — next request will retry.
        return List.of();
    }

    /**
     * Worldwide station search. Requires a name query of at least 2 characters
     * <strong>or</strong> a non-empty genre/tag filter (same pattern as TV category search).
     */
    public List<RadioStationDto> searchAllCountries(String query, String tag, int limit) {
        String q = query != null ? query.trim() : "";
        String tagFilter = tag != null ? tag.trim() : "";
        if (q.length() < 2 && tagFilter.isEmpty()) {
            return List.of();
        }
        int safeLimit = Math.max(1, Math.min(limit, 300));
        return searchStations(q.length() >= 2 ? q : "", null, tagFilter, safeLimit);
    }

    public List<String> listTags(String country) {
        if (isAllCountries(country)) {
            return listWorldwideTags();
        }
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (RadioStationDto st : listStations(country)) {
            if (!StringUtils.hasText(st.getTags())) {
                continue;
            }
            for (String part : st.getTags().split(",")) {
                String tag = part.trim().toLowerCase(Locale.ROOT);
                if (tag.isEmpty() || tag.length() > 40) {
                    continue;
                }
                counts.merge(tag, 1, Integer::sum);
            }
        }
        return counts.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue(Comparator.reverseOrder())
                        .thenComparing(Map.Entry.comparingByKey()))
                .limit(80)
                .map(Map.Entry::getKey)
                .collect(Collectors.toList());
    }

    private List<String> listWorldwideTags() {
        CacheEntry<List<String>> cached = worldwideTagsCache;
        if (cached != null && !cached.isExpired(catalogCacheMinutes) && !cached.value.isEmpty()) {
            return cached.value;
        }
        synchronized (this) {
            cached = worldwideTagsCache;
            if (cached != null && !cached.isExpired(catalogCacheMinutes) && !cached.value.isEmpty()) {
                return cached.value;
            }
            List<String> loaded = fetchWorldwideTags();
            if (!loaded.isEmpty()) {
                worldwideTagsCache = new CacheEntry<>(loaded);
                return loaded;
            }
            if (cached != null && !cached.value.isEmpty()) {
                return cached.value;
            }
            return List.of();
        }
    }

    private List<String> fetchWorldwideTags() {
        try {
            JsonNode root = getJson("/json/tags?order=stationcount&reverse=true&hidebroken=true&limit=80");
            if (root == null || !root.isArray()) {
                return List.of();
            }
            List<String> tags = new ArrayList<>();
            for (JsonNode node : root) {
                String name = text(node, "name");
                if (!StringUtils.hasText(name)) {
                    continue;
                }
                String tag = name.trim().toLowerCase(Locale.ROOT);
                if (tag.isEmpty() || tag.length() > 40) {
                    continue;
                }
                tags.add(tag);
            }
            return tags;
        } catch (Exception e) {
            log.warn("radio worldwide tags fetch failed: {}", e.getMessage());
            return List.of();
        }
    }

    public Optional<RadioStationDto> findById(String stationUuid) {
        if (!StringUtils.hasText(stationUuid)) {
            return Optional.empty();
        }
        try {
            String path = "/json/stations/byuuid/" + encode(stationUuid.trim());
            JsonNode root = getJson(path);
            List<RadioStationDto> list = parseStations(root);
            return list.stream().findFirst();
        } catch (Exception e) {
            log.warn("radio station by uuid failed: {}", e.getMessage());
            return Optional.empty();
        }
    }

    private List<RadioCountryDto> fetchCountries() {
        try {
            JsonNode root = getJson("/json/countrycodes?order=name&hidebroken=true");
            if (root == null || !root.isArray()) {
                return List.of();
            }
            List<RadioCountryDto> list = new ArrayList<>();
            for (JsonNode node : root) {
                String code = text(node, "name");
                if (!StringUtils.hasText(code) || !COUNTRY_CODE.matcher(code.toLowerCase(Locale.ROOT)).matches()) {
                    continue;
                }
                code = code.toLowerCase(Locale.ROOT);
                int count = node.path("stationcount").asInt(0);
                if (count <= 0) {
                    continue;
                }
                String display = countryDisplayName(code);
                list.add(new RadioCountryDto(code, display, flagEmoji(code), count));
            }
            list.sort((a, b) -> {
                int pin = pinOrder(a.getCode()) - pinOrder(b.getCode());
                if (pin != 0) {
                    return pin;
                }
                return a.getName().compareToIgnoreCase(b.getName());
            });
            return list;
        } catch (Exception e) {
            log.warn("radio countries fetch failed: {}", e.getMessage());
            return List.of();
        }
    }

    private List<RadioStationDto> fetchStationsByCountry(String countryCode) {
        try {
            String path = "/json/stations/bycountrycodeexact/" + encode(countryCode.toUpperCase(Locale.ROOT))
                    + "?hidebroken=true&order=clickcount&reverse=true&limit=2000";
            JsonNode root = getJson(path);
            return parseStations(root);
        } catch (Exception e) {
            log.warn("radio stations fetch failed for {}: {}", countryCode, e.getMessage());
            return List.of();
        }
    }

    private List<RadioStationDto> searchStations(String name, String countryCode, String tag, int limit) {
        try {
            StringBuilder path = new StringBuilder("/json/stations/search?hidebroken=true&order=clickcount&reverse=true");
            path.append("&limit=").append(limit);
            if (StringUtils.hasText(name)) {
                path.append("&name=").append(encode(name.trim()));
            }
            if (StringUtils.hasText(countryCode) && !isAllCountries(countryCode)) {
                path.append("&countrycode=").append(encode(countryCode.trim().toUpperCase(Locale.ROOT)));
            }
            if (StringUtils.hasText(tag)) {
                path.append("&tag=").append(encode(tag.trim().toLowerCase(Locale.ROOT)));
            }
            JsonNode root = getJson(path.toString());
            return parseStations(root);
        } catch (Exception e) {
            log.warn("radio search failed: {}", e.getMessage());
            return List.of();
        }
    }

    private List<RadioStationDto> parseStations(JsonNode root) {
        if (root == null || !root.isArray()) {
            return List.of();
        }
        List<RadioStationDto> list = new ArrayList<>();
        for (JsonNode node : root) {
            RadioStationDto dto = toStation(node);
            if (dto != null) {
                list.add(dto);
            }
        }
        return list;
    }

    private RadioStationDto toStation(JsonNode node) {
        String id = text(node, "stationuuid");
        String name = text(node, "name");
        String stream = text(node, "url_resolved");
        if (!StringUtils.hasText(stream)) {
            stream = text(node, "url");
        }
        if (!StringUtils.hasText(id) || !StringUtils.hasText(name) || !StringUtils.hasText(stream)) {
            return null;
        }
        if (!(stream.startsWith("http://") || stream.startsWith("https://"))) {
            return null;
        }
        if (node.path("lastcheckok").asInt(1) == 0) {
            return null;
        }
        String country = text(node, "countrycode");
        if (StringUtils.hasText(country)) {
            country = country.toLowerCase(Locale.ROOT);
        }
        Integer bitrate = null;
        int br = node.path("bitrate").asInt(0);
        if (br > 0) {
            bitrate = br;
        }
        return new RadioStationDto(
                id.trim(),
                name.trim(),
                emptyHttpUrl(text(node, "favicon")),
                emptyToNull(text(node, "tags")),
                emptyToNull(country),
                stream.trim(),
                emptyToNull(text(node, "codec")),
                bitrate,
                emptyToNull(text(node, "language")),
                emptyHttpUrl(text(node, "homepage"))
        );
    }

    private JsonNode getJson(String pathAndQuery) throws Exception {
        List<String> bases = resolveApiBases();
        Exception lastError = null;
        for (int i = 0; i < bases.size(); i++) {
            int idx = Math.floorMod(mirrorRotateOffset + i, bases.size());
            String base = bases.get(idx);
            try {
                JsonNode node = getJsonFromBase(base, pathAndQuery);
                // Prefer a working mirror next time.
                mirrorRotateOffset = idx;
                return node;
            } catch (Exception e) {
                lastError = e;
                log.debug("radio-browser mirror failed {}: {}", base, e.toString());
            }
        }
        if (lastError != null) {
            throw lastError;
        }
        throw new IllegalStateException("no radio-browser mirrors configured");
    }

    private JsonNode getJsonFromBase(String apiBase, String pathAndQuery) throws Exception {
        String base = apiBase.endsWith("/") ? apiBase.substring(0, apiBase.length() - 1) : apiBase;
        URI uri = URI.create(base + pathAndQuery);
        HttpRequest request = HttpRequest.newBuilder(uri)
                .timeout(Duration.ofSeconds(20))
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/json")
                .GET()
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IllegalStateException("HTTP " + response.statusCode() + " from radio-browser (" + base + ")");
        }
        return objectMapper.readTree(response.body());
    }

    private List<String> resolveApiBases() {
        LinkedHashMap<String, Boolean> ordered = new LinkedHashMap<>();
        if (StringUtils.hasText(apiBaseUrls)) {
            for (String part : apiBaseUrls.split(",")) {
                String b = normalizeBase(part);
                if (b != null) {
                    ordered.put(b, Boolean.TRUE);
                }
            }
        }
        String preferred = normalizeBase(apiBaseUrl);
        if (preferred != null) {
            // Put preferred first.
            LinkedHashMap<String, Boolean> withPreferred = new LinkedHashMap<>();
            withPreferred.put(preferred, Boolean.TRUE);
            withPreferred.putAll(ordered);
            ordered = withPreferred;
        }
        if (ordered.isEmpty()) {
            for (String def : DEFAULT_API_BASES) {
                ordered.put(def, Boolean.TRUE);
            }
        } else {
            for (String def : DEFAULT_API_BASES) {
                ordered.putIfAbsent(def, Boolean.TRUE);
            }
        }
        return new ArrayList<>(ordered.keySet());
    }

    private static String normalizeBase(String raw) {
        if (!StringUtils.hasText(raw)) {
            return null;
        }
        String b = raw.trim();
        while (b.endsWith("/")) {
            b = b.substring(0, b.length() - 1);
        }
        if (!(b.startsWith("http://") || b.startsWith("https://"))) {
            return null;
        }
        return b;
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node.path(field);
        if (v.isMissingNode() || v.isNull()) {
            return null;
        }
        String s = v.asText(null);
        return s != null ? s.trim() : null;
    }

    private static String emptyToNull(String value) {
        if (!StringUtils.hasText(value)) {
            return null;
        }
        String t = value.trim();
        if (t.isEmpty() || "null".equalsIgnoreCase(t) || "undefined".equalsIgnoreCase(t)) {
            return null;
        }
        return t;
    }

    private static String emptyHttpUrl(String value) {
        String t = emptyToNull(value);
        if (t == null) {
            return null;
        }
        if (!(t.startsWith("http://") || t.startsWith("https://"))) {
            return null;
        }
        return t;
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static String countryDisplayName(String code) {
        try {
            String name = new Locale("", code.toUpperCase(Locale.ROOT)).getDisplayCountry(Locale.ENGLISH);
            if (StringUtils.hasText(name)) {
                return name;
            }
            return code.toUpperCase(Locale.ROOT);
        } catch (Exception e) {
            return code.toUpperCase(Locale.ROOT);
        }
    }

    private static String flagEmoji(String code) {
        if (code == null || code.length() != 2) {
            return "";
        }
        String upper = code.toUpperCase(Locale.ROOT);
        int a = Character.codePointAt(upper, 0) - 'A' + 0x1F1E6;
        int b = Character.codePointAt(upper, 1) - 'A' + 0x1F1E6;
        return new String(Character.toChars(a)) + new String(Character.toChars(b));
    }

    private static int pinOrder(String code) {
        if ("fr".equals(code)) {
            return 0;
        }
        if ("ch".equals(code)) {
            return 1;
        }
        if ("be".equals(code)) {
            return 2;
        }
        return 100;
    }

    private static final class CacheEntry<T> {
        final T value;
        final Instant loadedAt = Instant.now();

        CacheEntry(T value) {
            this.value = value;
        }

        boolean isExpired(int minutes) {
            return Instant.now().isAfter(loadedAt.plus(Duration.ofMinutes(Math.max(1, minutes))));
        }
    }
}
