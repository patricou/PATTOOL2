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
 */
@Service
public class RadioCatalogService {

    private static final Logger log = LoggerFactory.getLogger(RadioCatalogService.class);

    private static final Pattern COUNTRY_CODE = Pattern.compile("^[a-z]{2}$");
    private static final String USER_AGENT = "PatTool/1.0 (radio-watcher; https://github.com)";

    private final ObjectMapper objectMapper;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(12))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    @Value("${app.radio.api-base-url:https://de1.api.radio-browser.info}")
    private String apiBaseUrl;

    @Value("${app.radio.catalog-cache-minutes:60}")
    private int catalogCacheMinutes;

    private final ConcurrentHashMap<String, CacheEntry<List<RadioStationDto>>> stationCache = new ConcurrentHashMap<>();
    private volatile CacheEntry<List<RadioCountryDto>> countriesCache;

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
        if (cached != null && !cached.isExpired(catalogCacheMinutes)) {
            return cached.value;
        }
        synchronized (this) {
            cached = countriesCache;
            if (cached != null && !cached.isExpired(catalogCacheMinutes)) {
                return cached.value;
            }
            List<RadioCountryDto> loaded = fetchCountries();
            countriesCache = new CacheEntry<>(loaded);
            return loaded;
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
        if (cached != null && !cached.isExpired(catalogCacheMinutes)) {
            return cached.value;
        }
        List<RadioStationDto> loaded = fetchStationsByCountry(code);
        stationCache.put(code, new CacheEntry<>(loaded));
        return loaded;
    }

    public List<RadioStationDto> searchAllCountries(String query, String tag, int limit) {
        String q = query != null ? query.trim() : "";
        if (q.length() < 2) {
            return List.of();
        }
        int safeLimit = Math.max(1, Math.min(limit, 300));
        return searchStations(q, null, tag, safeLimit);
    }

    public List<String> listTags(String country) {
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
        String base = apiBaseUrl.endsWith("/") ? apiBaseUrl.substring(0, apiBaseUrl.length() - 1) : apiBaseUrl;
        URI uri = URI.create(base + pathAndQuery);
        HttpRequest request = HttpRequest.newBuilder(uri)
                .timeout(Duration.ofSeconds(25))
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/json")
                .GET()
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IllegalStateException("HTTP " + response.statusCode() + " from radio-browser");
        }
        return objectMapper.readTree(response.body());
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
