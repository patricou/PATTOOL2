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
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * US / Canada DOT traffic cameras via Road511 Features API.
 * Docs: https://road511.com/docs.html — cameras often expose JPEG stills; some also HLS ({@code video_url}).
 */
@Service
public class Road511WebcamCatalogService {

    private static final Logger log = LoggerFactory.getLogger(Road511WebcamCatalogService.class);

    private static final String USER_AGENT = "PatTool/1.0 (webcam-traffic; https://github.com)";
    private static final String PROVIDER = "road511";
    private static final Duration META_CACHE_TTL = Duration.ofHours(12);
    private static final Duration LIST_CACHE_TTL = Duration.ofMinutes(2);
    private static final Duration DETAIL_CACHE_TTL = Duration.ofMinutes(2);
    private static final int TEXT_SEARCH_NEARBY_RADIUS_KM = 50;
    private static final int TEXT_FILTER_FETCH_LIMIT = 100;
    /** US / CA route ids for Road511 {@code road=} (I-405, US-101, SR-99, CA-1, Hwy 17…). */
    private static final Pattern ROAD_QUERY = Pattern.compile(
            "^(?:(?:hwy|highway|route|rt|interstate)\\s+)?"
                    + "(?:(?:I|US|SR|CA|NY|TX|FL|WA|OR|CO|IL|OH|ON|BC|QC|AB|HWY)[- ]?)?\\d{1,4}[A-Z]?$",
            Pattern.CASE_INSENSITIVE);

    /** Canadian province / territory codes used by Road511. */
    private static final Set<String> CANADA_CODES = Set.of(
            "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT");

    /** Fallback picker when /jurisdictions is unavailable. */
    private static final List<WebcamCodeLabelDto> FALLBACK_JURISDICTIONS = List.of(
            label("CA", "California · USA"),
            label("TX", "Texas · USA"),
            label("NY", "New York · USA"),
            label("FL", "Florida · USA"),
            label("GA", "Georgia · USA"),
            label("MI", "Michigan · USA"),
            label("PA", "Pennsylvania · USA"),
            label("WA", "Washington · USA"),
            label("OR", "Oregon · USA"),
            label("CO", "Colorado · USA"),
            label("IL", "Illinois · USA"),
            label("OH", "Ohio · USA"),
            label("ON", "Ontario · Canada"),
            label("BC", "British Columbia · Canada"),
            label("QC", "Quebec · Canada"),
            label("AB", "Alberta · Canada")
    );

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

    @Value("${app.webcam.road511-api-base:https://api.road511.com/api/v1}")
    private String apiBase;

    @Value("${app.webcam.road511-api-key:}")
    private String apiKey;

    @Value("${app.webcam.search-cache-minutes:2}")
    private int searchCacheMinutes;

    public Road511WebcamCatalogService(ObjectMapper objectMapper, GeocodeService geocodeService) {
        this.objectMapper = objectMapper;
        this.geocodeService = geocodeService;
    }

    public boolean isConfigured() {
        return StringUtils.hasText(apiKey);
    }

    public List<WebcamCodeLabelDto> jurisdictions() {
        if (!isConfigured()) {
            return List.copyOf(FALLBACK_JURISDICTIONS);
        }
        String cacheKey = "jurisdictions-v2";
        CacheEntry<List<WebcamCodeLabelDto>> hit = metaCache.get(cacheKey);
        if (hit != null && !hit.expired(META_CACHE_TTL)) {
            return hit.value;
        }
        try {
            // scope=state → US states + Canadian provinces (not Europe / worldwide).
            String url = trimSlash(apiBase) + "/jurisdictions?scope=state";
            JsonNode root = getJson(url);
            List<WebcamCodeLabelDto> out = new ArrayList<>();
            JsonNode data = root != null && root.isArray() ? root
                    : (root != null ? firstArray(root, "data", "jurisdictions", "items") : null);
            if (data != null && data.isArray()) {
                for (JsonNode n : data) {
                    String code = text(n, "code", "id", "jurisdiction");
                    if (!StringUtils.hasText(code)) {
                        continue;
                    }
                    code = code.trim().toUpperCase(Locale.ROOT);
                    // Skip federal / agency feeds that aren't real state/province pickers
                    // (e.g. CBSA, ECCC, FHWA) — keep classic 2-letter geo codes.
                    if (code.length() != 2) {
                        continue;
                    }
                    boolean active = !n.has("is_active") || n.get("is_active").asBoolean(true);
                    if (!active) {
                        continue;
                    }
                    String country = text(n, "country");
                    String name = text(n, "name", "label", "title", "official_name");
                    if (!StringUtils.hasText(name)) {
                        name = code;
                    }
                    String countryLabel = countryLabel(country, code);
                    String label = name.trim() + (countryLabel != null ? " · " + countryLabel : "");
                    out.add(label(code, label));
                }
            }
            if (out.isEmpty()) {
                out.addAll(FALLBACK_JURISDICTIONS);
            } else {
                // Ensure common Canadian provinces stay visible even if a plan omits some.
                mergeMissing(out, FALLBACK_JURISDICTIONS);
                out.sort(Comparator.comparing(WebcamCodeLabelDto::getLabel, String.CASE_INSENSITIVE_ORDER));
            }
            metaCache.put(cacheKey, new CacheEntry<>(out));
            return out;
        } catch (Exception e) {
            log.warn("Road511 jurisdictions failed: {}", e.toString());
            return List.copyOf(FALLBACK_JURISDICTIONS);
        }
    }

    private static String countryLabel(String country, String code) {
        if (StringUtils.hasText(country)) {
            String c = country.trim().toUpperCase(Locale.ROOT);
            if ("CA".equals(c)) {
                return "Canada";
            }
            if ("US".equals(c) || "USA".equals(c)) {
                return "USA";
            }
            return c;
        }
        if (CANADA_CODES.contains(code)) {
            return "Canada";
        }
        return "USA";
    }

    private static void mergeMissing(List<WebcamCodeLabelDto> into, List<WebcamCodeLabelDto> extras) {
        Set<String> have = new HashSet<>();
        for (WebcamCodeLabelDto j : into) {
            if (j.getCode() != null) {
                have.add(j.getCode().toUpperCase(Locale.ROOT));
            }
        }
        for (WebcamCodeLabelDto extra : extras) {
            if (extra.getCode() == null) {
                continue;
            }
            String code = extra.getCode().toUpperCase(Locale.ROOT);
            if (!have.contains(code)) {
                into.add(label(code, extra.getLabel()));
                have.add(code);
            }
        }
    }

    public WebcamSearchPageDto search(
            String jurisdiction,
            String nearby,
            String q,
            boolean hasVideoOnly,
            int limit,
            int offset) {
        int safeLimit = clamp(limit, 1, 50, 24);
        int safeOffset = Math.max(0, Math.min(offset, 5000));
        String safeJur = trimOrNull(jurisdiction);
        String safeNearby = trimOrNull(nearby);
        String safeQ = trimOrNull(q);

        WebcamSearchPageDto page = new WebcamSearchPageDto();
        page.setLimit(safeLimit);
        page.setOffset(safeOffset);
        page.setCountries(safeJur);
        page.setNearby(safeNearby);
        page.setQ(safeQ);

        if (!isConfigured()) {
            page.setError("missing_api_key");
            page.setMessage("Configure app.webcam.road511-api-key (clé sur portal.road511.com)");
            return page;
        }

        // Road511 only accepts road= for free text. Place names must be geocoded.
        String roadParam = null;
        boolean localTextFilter = false;
        if (safeQ != null) {
            if (looksLikeRoadQuery(safeQ)) {
                roadParam = safeQ;
            } else if (safeNearby == null) {
                String geoFromQ = resolveNearbyFromQuery(safeQ, safeJur);
                if (geoFromQ != null) {
                    safeNearby = geoFromQ;
                    page.setNearby(safeNearby);
                } else {
                    localTextFilter = true;
                }
            } else {
                localTextFilter = true;
            }
        }

        String cacheKey = "list|" + safeJur + "|" + safeNearby + "|" + safeQ + "|" + hasVideoOnly
                + "|" + roadParam + "|" + localTextFilter + "|" + safeLimit + "|" + safeOffset;
        CacheEntry<WebcamSearchPageDto> hit = listCache.get(cacheKey);
        Duration ttl = listCacheTtl();
        if (hit != null && !hit.expired(ttl)) {
            return copyPage(hit.value);
        }

        try {
            boolean fetchThenPage = hasVideoOnly || localTextFilter;
            int fetchLimit = fetchThenPage
                    ? Math.min(Math.max(safeLimit * 4, TEXT_FILTER_FETCH_LIMIT), 100)
                    : safeLimit;
            int fetchOffset = fetchThenPage ? 0 : safeOffset;

            StringBuilder url = new StringBuilder(trimSlash(apiBase))
                    .append("/features?type=cameras&active=true")
                    .append("&limit=").append(fetchLimit)
                    .append("&offset=").append(fetchOffset);

            if (safeJur != null && safeNearby == null) {
                url.append("&jurisdiction=").append(enc(safeJur));
            }
            Nearby geo = parseNearby(safeNearby);
            if (geo != null) {
                url.append("&lat=").append(geo.lat)
                        .append("&lng=").append(geo.lon)
                        .append("&radius_km=").append(geo.radiusKm);
            }
            if (roadParam != null) {
                url.append("&road=").append(enc(roadParam));
            }

            JsonNode root = getJson(url.toString());
            List<WebcamItemDto> mapped = new ArrayList<>();
            JsonNode data = root != null ? firstArray(root, "data", "features", "items") : null;
            if (data != null && data.isArray()) {
                for (JsonNode n : data) {
                    WebcamItemDto item = mapFeature(n);
                    if (item == null || !StringUtils.hasText(item.getId())) {
                        continue;
                    }
                    if (hasVideoOnly && !Boolean.TRUE.equals(item.getHasVideo())) {
                        continue;
                    }
                    mapped.add(item);
                }
            }

            if (localTextFilter && safeQ != null) {
                List<String> tokens = tokenizeQuery(safeQ);
                mapped = new ArrayList<>(mapped.stream().filter(item -> matchesQuery(item, tokens)).toList());
            }

            int total;
            if (fetchThenPage) {
                // Filtered locally — page within the filtered slice.
                total = mapped.size();
                int from = Math.min(safeOffset, mapped.size());
                int to = Math.min(from + safeLimit, mapped.size());
                mapped = new ArrayList<>(mapped.subList(from, to));
            } else {
                total = root != null && root.has("total") && root.get("total").canConvertToInt()
                        ? root.get("total").asInt()
                        : mapped.size();
            }

            // Prefer cameras with HLS when not filtering.
            if (!hasVideoOnly) {
                mapped.sort(Comparator
                        .comparing((WebcamItemDto w) -> !Boolean.TRUE.equals(w.getHasVideo()))
                        .thenComparing(w -> w.getTitle() != null ? w.getTitle() : "", String.CASE_INSENSITIVE_ORDER));
            }

            page.setTotal(Math.max(total, mapped.size()));
            page.setWebcams(mapped);
            listCache.put(cacheKey, new CacheEntry<>(copyPage(page)));
            return page;
        } catch (Exception e) {
            log.warn("Road511 camera search failed: {}", e.toString());
            page.setError("upstream_error");
            page.setMessage(e.getMessage() != null ? e.getMessage() : "Road511 request failed");
            return page;
        }
    }

    private String resolveNearbyFromQuery(String q, String jurisdiction) {
        if (q.length() < 2) {
            return null;
        }
        String query = q;
        if (StringUtils.hasText(jurisdiction)) {
            String hint = jurisdictionHint(jurisdiction);
            if (StringUtils.hasText(hint)) {
                query = q + ", " + hint;
            }
        }
        try {
            List<Map<String, Object>> hits = geocodeService.search(query);
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
            log.debug("Road511 place geocode failed for '{}': {}", q, e.toString());
            return null;
        }
    }

    private static String jurisdictionHint(String code) {
        String c = code.trim().toUpperCase(Locale.ROOT);
        return switch (c) {
            case "CA" -> "California, USA";
            case "TX" -> "Texas, USA";
            case "NY" -> "New York, USA";
            case "FL" -> "Florida, USA";
            case "WA" -> "Washington, USA";
            case "OR" -> "Oregon, USA";
            case "ON" -> "Ontario, Canada";
            case "BC" -> "British Columbia, Canada";
            case "QC" -> "Quebec, Canada";
            case "AB" -> "Alberta, Canada";
            default -> CANADA_CODES.contains(c) ? c + ", Canada" : c + ", USA";
        };
    }

    static boolean looksLikeRoadQuery(String q) {
        if (!StringUtils.hasText(q)) {
            return false;
        }
        String t = q.trim();
        if (t.length() > 24) {
            return false;
        }
        return ROAD_QUERY.matcher(t).matches();
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

    private static String fold(String s) {
        if (s == null) {
            return "";
        }
        String n = Normalizer.normalize(s.trim(), Normalizer.Form.NFD)
                .replaceAll("\\p{M}+", "");
        return n.toLowerCase(Locale.ROOT);
    }

    public Optional<WebcamItemDto> getCamera(String id) {
        if (!isConfigured() || !StringUtils.hasText(id)) {
            return Optional.empty();
        }
        String safeId = id.trim();
        CacheEntry<WebcamItemDto> hit = detailCache.get(safeId);
        if (hit != null && !hit.expired(DETAIL_CACHE_TTL)) {
            return Optional.of(copyItem(hit.value));
        }
        try {
            String url = trimSlash(apiBase) + "/features/" + encPath(safeId) + "/details";
            JsonNode root = getJson(url);
            JsonNode node = root;
            if (root != null && root.has("data") && root.get("data").isObject()) {
                node = root.get("data");
            } else if (root != null && root.has("feature") && root.get("feature").isObject()) {
                node = root.get("feature");
            }
            WebcamItemDto item = mapFeature(node);
            if (item == null || !StringUtils.hasText(item.getId())) {
                return Optional.empty();
            }
            detailCache.put(safeId, new CacheEntry<>(copyItem(item)));
            return Optional.of(item);
        } catch (Exception e) {
            log.warn("Road511 camera detail failed id={}: {}", safeId, e.toString());
            return Optional.empty();
        }
    }

    private WebcamItemDto mapFeature(JsonNode n) {
        if (n == null || n.isNull() || !n.isObject()) {
            return null;
        }
        JsonNode props = n.has("properties") && n.get("properties").isObject()
                ? n.get("properties") : n;

        String id = text(n, "id");
        if (!StringUtils.hasText(id)) {
            id = text(props, "id");
        }
        if (!StringUtils.hasText(id)) {
            return null;
        }

        String name = text(n, "name", "title");
        if (!StringUtils.hasText(name)) {
            name = text(props, "name", "title", "description");
        }
        String jurisdiction = text(n, "jurisdiction");
        if (!StringUtils.hasText(jurisdiction)) {
            jurisdiction = text(props, "jurisdiction", "state");
        }
        String roadName = text(n, "road_name", "road");
        if (!StringUtils.hasText(roadName)) {
            roadName = text(props, "road_name", "road");
        }
        String direction = text(n, "direction");
        if (!StringUtils.hasText(direction)) {
            direction = text(props, "direction");
        }
        String county = text(props, "county", "nearby_place");
        String nearbyPlace = text(props, "nearby_place");
        String imageUrl = text(props, "image_url", "imageUrl", "url");
        String videoUrl = text(props, "video_url", "videoUrl", "stream_url", "hls_url");

        Double lat = number(n, "latitude", "lat");
        Double lon = number(n, "longitude", "lng", "lon");
        if (lat == null || lon == null) {
            JsonNode geom = n.get("geometry");
            if (geom != null && geom.has("coordinates") && geom.get("coordinates").isArray()
                    && geom.get("coordinates").size() >= 2) {
                lon = geom.get("coordinates").get(0).asDouble();
                lat = geom.get("coordinates").get(1).asDouble();
            }
        }

        boolean active = !n.has("is_active") || n.get("is_active").asBoolean(true);
        if (!active) {
            return null;
        }

        WebcamItemDto dto = new WebcamItemDto();
        dto.setId(id.trim());
        dto.setProvider(PROVIDER);
        dto.setTitle(StringUtils.hasText(name) ? name.trim() : id.trim());
        dto.setStatus(active ? "active" : "inactive");
        dto.setRegion(StringUtils.hasText(jurisdiction) ? jurisdiction.trim().toUpperCase(Locale.ROOT) : null);
        dto.setCity(firstNonBlank(nearbyPlace, county));
        String jur = dto.getRegion();
        if (jur != null && CANADA_CODES.contains(jur)) {
            dto.setCountry("Canada");
            dto.setCountryCode("CA");
            dto.setContinent("North America");
            dto.setContinentCode("NA");
        } else {
            dto.setCountry("United States");
            dto.setCountryCode("US");
            dto.setContinent("North America");
            dto.setContinentCode("NA");
        }
        dto.setLatitude(lat);
        dto.setLongitude(lon);
        String source = text(n, "source");
        if (!StringUtils.hasText(source)) {
            source = text(props, "source");
        }
        String sourceId = text(n, "source_id", "sourceId");
        String lastUpdated = firstNonBlank(
                text(n, "last_updated", "lastUpdated", "lastUpdatedOn"),
                text(props, "last_updated", "lastUpdated", "lastUpdatedOn", "updated_at", "timestamp"));
        String lastImageTime = text(props, "last_image_time", "lastImageTime", "capture_time", "captured_at");
        dto.setSource(source);
        dto.setSourceId(sourceId);
        dto.setFeatureType("cameras");
        dto.setRoadName(roadName);
        dto.setDirection(direction);
        if (StringUtils.hasText(lastImageTime)) {
            dto.setLastImageTime(lastImageTime.trim());
        }
        if (StringUtils.hasText(lastUpdated)) {
            dto.setLastUpdatedOn(lastUpdated.trim());
        } else if (StringUtils.hasText(lastImageTime)) {
            dto.setLastUpdatedOn(lastImageTime.trim());
        }
        dto.setImageUrl(imageUrl);
        dto.setImagePreviewUrl(imageUrl);
        boolean hasVideo = StringUtils.hasText(videoUrl);
        dto.setHasVideo(hasVideo);
        if (hasVideo) {
            dto.setPlayerLiveUrl(videoUrl.trim());
        }
        dto.setDetailUrl("https://map.road511.com");
        List<String> cats = new ArrayList<>();
        cats.add("traffic");
        if (hasVideo) {
            cats.add("hls");
        }
        if (StringUtils.hasText(roadName)) {
            cats.add(roadName.trim());
        }
        if (StringUtils.hasText(direction)) {
            cats.add(direction.trim());
        }
        dto.setCategories(cats);
        // Preserve extra scalar properties (km, angle, …)
        if (props != null && props.isObject()) {
            java.util.Set<String> skip = java.util.Set.of(
                    "id", "name", "title", "description", "jurisdiction", "state", "source", "source_id", "sourceId",
                    "road_name", "road", "direction", "county", "nearby_place", "city",
                    "image_url", "imageUrl", "url", "video_url", "videoUrl", "stream_url", "hls_url",
                    "last_updated", "lastUpdated", "lastUpdatedOn", "updated_at", "timestamp",
                    "last_image_time", "lastImageTime", "capture_time", "captured_at", "views");
            props.fields().forEachRemaining(entry -> {
                String key = entry.getKey();
                if (!StringUtils.hasText(key) || skip.contains(key)) {
                    return;
                }
                JsonNode val = entry.getValue();
                if (val == null || val.isNull() || val.isObject() || val.isArray()) {
                    return;
                }
                String s = val.asText(null);
                if (StringUtils.hasText(s)) {
                    java.util.Map<String, String> details = dto.getDetails();
                    if (details == null) {
                        details = new java.util.LinkedHashMap<>();
                        dto.setDetails(details);
                    }
                    details.putIfAbsent(key, s.trim());
                }
            });
        }
        return dto;
    }

    private JsonNode getJson(String url) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/json")
                .header("X-API-Key", apiKey.trim())
                .GET()
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() == 401 || response.statusCode() == 403) {
            throw new IllegalStateException("Road511 API key rejected (HTTP " + response.statusCode() + ")");
        }
        if (response.statusCode() >= 400) {
            throw new IllegalStateException("Road511 HTTP " + response.statusCode());
        }
        return objectMapper.readTree(response.body());
    }

    private Duration listCacheTtl() {
        int minutes = clamp(searchCacheMinutes, 1, 30, 2);
        return Duration.ofMinutes(minutes);
    }

    private static Nearby parseNearby(String nearby) {
        if (!StringUtils.hasText(nearby)) {
            return null;
        }
        String[] parts = nearby.split(",");
        if (parts.length < 2) {
            return null;
        }
        try {
            double lat = Double.parseDouble(parts[0].trim());
            double lon = Double.parseDouble(parts[1].trim());
            double radius = parts.length >= 3 ? Double.parseDouble(parts[2].trim()) : 100d;
            radius = Math.max(5d, Math.min(radius, 500d));
            return new Nearby(lat, lon, radius);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static JsonNode firstArray(JsonNode root, String... keys) {
        for (String key : keys) {
            if (root.has(key) && root.get(key).isArray()) {
                return root.get(key);
            }
        }
        return null;
    }

    private static String text(JsonNode n, String... keys) {
        if (n == null) {
            return null;
        }
        for (String key : keys) {
            if (n.has(key) && !n.get(key).isNull()) {
                String v = n.get(key).asText(null);
                if (StringUtils.hasText(v)) {
                    return v.trim();
                }
            }
        }
        return null;
    }

    private static Double number(JsonNode n, String... keys) {
        if (n == null) {
            return null;
        }
        for (String key : keys) {
            if (n.has(key) && n.get(key).isNumber()) {
                return n.get(key).asDouble();
            }
            if (n.has(key) && n.get(key).isTextual()) {
                try {
                    return Double.parseDouble(n.get(key).asText().trim());
                } catch (NumberFormatException ignored) {
                    // try next
                }
            }
        }
        return null;
    }

    private static String firstNonBlank(String... values) {
        if (values == null) {
            return null;
        }
        for (String v : values) {
            if (StringUtils.hasText(v)) {
                return v.trim();
            }
        }
        return null;
    }

    private static WebcamCodeLabelDto label(String code, String name) {
        WebcamCodeLabelDto dto = new WebcamCodeLabelDto();
        dto.setCode(code);
        dto.setLabel(name);
        return dto;
    }

    private static String trimSlash(String base) {
        if (base == null) {
            return "";
        }
        String t = base.trim();
        while (t.endsWith("/")) {
            t = t.substring(0, t.length() - 1);
        }
        return t;
    }

    private static String trimOrNull(String s) {
        if (!StringUtils.hasText(s)) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    private static String encPath(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static int clamp(int value, int min, int max, int fallback) {
        if (value < min || value > max) {
            return fallback;
        }
        return value;
    }

    private static WebcamSearchPageDto copyPage(WebcamSearchPageDto src) {
        WebcamSearchPageDto page = new WebcamSearchPageDto();
        page.setTotal(src.getTotal());
        page.setLimit(src.getLimit());
        page.setOffset(src.getOffset());
        page.setCountries(src.getCountries());
        page.setNearby(src.getNearby());
        page.setQ(src.getQ());
        page.setError(src.getError());
        page.setMessage(src.getMessage());
        List<WebcamItemDto> cams = new ArrayList<>();
        if (src.getWebcams() != null) {
            for (WebcamItemDto w : src.getWebcams()) {
                cams.add(copyItem(w));
            }
        }
        page.setWebcams(cams);
        return page;
    }

    private static WebcamItemDto copyItem(WebcamItemDto src) {
        WebcamItemDto dto = new WebcamItemDto();
        dto.setId(src.getId());
        dto.setProvider(src.getProvider());
        dto.setTitle(src.getTitle());
        dto.setDescription(src.getDescription());
        dto.setStatus(src.getStatus());
        dto.setViewCount(src.getViewCount());
        dto.setLastUpdatedOn(src.getLastUpdatedOn());
        dto.setLastImageTime(src.getLastImageTime());
        dto.setCity(src.getCity());
        dto.setRegion(src.getRegion());
        dto.setCountry(src.getCountry());
        dto.setCountryCode(src.getCountryCode());
        dto.setContinent(src.getContinent());
        dto.setContinentCode(src.getContinentCode());
        dto.setLatitude(src.getLatitude());
        dto.setLongitude(src.getLongitude());
        dto.setImageUrl(src.getImageUrl());
        dto.setImagePreviewUrl(src.getImagePreviewUrl());
        dto.setPlayerDayUrl(src.getPlayerDayUrl());
        dto.setPlayerLiveUrl(src.getPlayerLiveUrl());
        dto.setPlayerMonthUrl(src.getPlayerMonthUrl());
        dto.setDetailUrl(src.getDetailUrl());
        dto.setHasVideo(src.getHasVideo());
        dto.setRoadName(src.getRoadName());
        dto.setDirection(src.getDirection());
        dto.setSource(src.getSource());
        dto.setSourceId(src.getSourceId());
        dto.setFeatureType(src.getFeatureType());
        dto.setCategories(src.getCategories() != null ? new ArrayList<>(src.getCategories()) : new ArrayList<>());
        dto.setDetails(src.getDetails());
        return dto;
    }

    private record Nearby(double lat, double lon, double radiusKm) {
    }

    private record CacheEntry<T>(T value, Instant at) {
        CacheEntry(T value) {
            this(value, Instant.now());
        }

        boolean expired(Duration ttl) {
            return at.plus(ttl).isBefore(Instant.now());
        }
    }
}
