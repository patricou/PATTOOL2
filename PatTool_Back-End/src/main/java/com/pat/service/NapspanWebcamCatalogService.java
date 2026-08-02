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
import java.util.HashMap;
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
 * European NAP traffic cameras via NAPSPAN Features API (DATEX II → GeoJSON).
 * Docs: https://napspan.com/docs.html — same contract family as Road511; stills + occasional HLS.
 */
@Service
public class NapspanWebcamCatalogService {

    private static final Logger log = LoggerFactory.getLogger(NapspanWebcamCatalogService.class);

    private static final String USER_AGENT = "PatTool/1.0 (webcam-europe; https://github.com)";
    private static final String PROVIDER = "napspan";
    private static final Duration META_CACHE_TTL = Duration.ofHours(12);
    private static final Duration DETAIL_CACHE_TTL = Duration.ofMinutes(2);
    /** Radius when free-text q is resolved as a place name via Nominatim. */
    private static final int TEXT_SEARCH_NEARBY_RADIUS_KM = 50;
    /** Page size when scanning the catalog for local title / road matches. */
    private static final int TEXT_FILTER_PAGE_SIZE = 100;
    /**
     * Max cameras to pull from NAPSPAN while applying a local filter.
     * Features API has no {@code road=} param — road queries must be scanned client-side.
     */
    private static final int TEXT_FILTER_SCAN_MAX = 1000;
    /**
     * Highway / route identifiers (A10, M25, N7, E15, B10, D1006, RN7, …).
     * Place names must not match — those are geocoded instead.
     */
    private static final Pattern ROAD_QUERY = Pattern.compile(
            "^(?:(?:autoroute|autostrada|autobahn|motorway|highway|route|strada|via)\\s+)?"
                    + "(?:[A-Z]{1,3}[- ]?)?\\d{1,4}[A-Z]?$",
            Pattern.CASE_INSENSITIVE);

    /** ISO-3166 alpha-3 names used by NAPSPAN jurisdiction codes. */
    private static final Map<String, String> COUNTRY_NAMES = countryNames();

    /**
     * Jurisdictions that currently expose {@code type=cameras} on NAPSPAN.
     * Many listed countries (CHE, NLD, ITA, federal DEU…) only have events/parking — not webcams.
     * Re-probe occasionally when NAPSPAN expands camera coverage.
     */
    private static final Set<String> CAMERA_JURISDICTION_CODES = Set.of(
            "FRA", "ESP", "SWE", "NOR", "FIN", "POL",
            "ISL", "LTU", "SVN",
            "DEU-BY",
            "GBR-SCT"
    );

    /** Fallback picker — only jurisdictions that expose cameras today. */
    private static final List<WebcamCodeLabelDto> FALLBACK_JURISDICTIONS = List.of(
            label("FRA", "France"),
            label("ESP", "Spain"),
            label("SWE", "Sweden"),
            label("NOR", "Norway"),
            label("FIN", "Finland"),
            label("POL", "Poland"),
            label("ISL", "Iceland"),
            label("LTU", "Lithuania"),
            label("SVN", "Slovenia"),
            label("DEU-BY", "Germany — Bavaria"),
            label("GBR-SCT", "United Kingdom — Scotland")
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

    @Value("${app.webcam.napspan-api-base:https://api.napspan.com/api/v1}")
    private String apiBase;

    @Value("${app.webcam.napspan-api-key:}")
    private String apiKey;

    @Value("${app.webcam.search-cache-minutes:2}")
    private int searchCacheMinutes;

    public NapspanWebcamCatalogService(ObjectMapper objectMapper, GeocodeService geocodeService) {
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
        // v3: allowlist of jurisdictions that publish cameras (CHE = events only).
        String cacheKey = "jurisdictions-cameras-v3";
        CacheEntry<List<WebcamCodeLabelDto>> hit = metaCache.get(cacheKey);
        if (hit != null && !hit.expired(META_CACHE_TTL)) {
            return hit.value;
        }
        try {
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
                    boolean active = !n.has("is_active") || n.get("is_active").asBoolean(true);
                    if (!active || !CAMERA_JURISDICTION_CODES.contains(code)) {
                        continue;
                    }
                    String name = text(n, "name", "label", "title", "official_name");
                    if (!StringUtils.hasText(name)) {
                        name = countryName(code);
                    }
                    out.add(label(code, name.trim()));
                }
            }
            if (out.isEmpty()) {
                out.addAll(FALLBACK_JURISDICTIONS);
            } else {
                mergeMissing(out, FALLBACK_JURISDICTIONS);
                out.sort(Comparator.comparing(WebcamCodeLabelDto::getLabel, String.CASE_INSENSITIVE_ORDER));
            }
            metaCache.put(cacheKey, new CacheEntry<>(out));
            return out;
        } catch (Exception e) {
            log.warn("NAPSPAN jurisdictions failed: {}", e.toString());
            return List.copyOf(FALLBACK_JURISDICTIONS);
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
        if (safeJur != null) {
            // NAPSPAN queries require ISO-3166 alpha-3 (FRA). Accept FR → FRA.
            safeJur = toNapspanJurisdiction(safeJur);
        }
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
            page.setMessage("Configure app.webcam.napspan-api-key (clé sur portal.napspan.com)");
            return page;
        }

        // NAPSPAN Features API has no free-text / road= filter (docs: jurisdiction, geo, bbox only).
        // Road ids (e.g. "a6") and other text must be matched locally after scanning pages.
        // Place names (e.g. "etrembiere") are geocoded to lat/lng.
        boolean roadFilter = false;
        String roadId = null;
        boolean localTextFilter = false;
        if (safeQ != null) {
            if (looksLikeRoadQuery(safeQ)) {
                roadFilter = true;
                roadId = normalizeRoadId(safeQ);
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
                + "|" + roadFilter + "|" + nullToEmpty(roadId) + "|" + localTextFilter
                + "|" + safeLimit + "|" + safeOffset;
        CacheEntry<WebcamSearchPageDto> hit = listCache.get(cacheKey);
        Duration ttl = listCacheTtl();
        if (hit != null && !hit.expired(ttl)) {
            return copyPage(hit.value);
        }

        try {
            boolean fetchThenPage = hasVideoOnly || localTextFilter || roadFilter;
            List<WebcamItemDto> mapped;
            int total;

            if (fetchThenPage) {
                mapped = scanAndFilter(safeJur, safeNearby, hasVideoOnly, roadId, localTextFilter ? safeQ : null);
                total = mapped.size();
                if (!hasVideoOnly) {
                    mapped.sort(Comparator
                            .comparing((WebcamItemDto w) -> !Boolean.TRUE.equals(w.getHasVideo()))
                            .thenComparing(w -> w.getTitle() != null ? w.getTitle() : "",
                                    String.CASE_INSENSITIVE_ORDER));
                }
                int from = Math.min(safeOffset, mapped.size());
                int to = Math.min(from + safeLimit, mapped.size());
                mapped = new ArrayList<>(mapped.subList(from, to));
            } else {
                JsonNode root = fetchFeaturesPage(safeJur, safeNearby, safeLimit, safeOffset);
                mapped = mapFeatureArray(root, false);
                total = root != null && root.has("total") && root.get("total").canConvertToInt()
                        ? root.get("total").asInt()
                        : mapped.size();
                mapped.sort(Comparator
                        .comparing((WebcamItemDto w) -> !Boolean.TRUE.equals(w.getHasVideo()))
                        .thenComparing(w -> w.getTitle() != null ? w.getTitle() : "",
                                String.CASE_INSENSITIVE_ORDER));
            }

            page.setTotal(Math.max(total, mapped.size()));
            page.setWebcams(mapped);
            listCache.put(cacheKey, new CacheEntry<>(copyPage(page)));
            return page;
        } catch (Exception e) {
            log.warn("NAPSPAN camera search failed: {}", e.toString());
            page.setError("upstream_error");
            page.setMessage(e.getMessage() != null ? e.getMessage() : "NAPSPAN request failed");
            return page;
        }
    }

    /**
     * Pull up to {@link #TEXT_FILTER_SCAN_MAX} cameras and keep those matching HLS / road / text.
     */
    private List<WebcamItemDto> scanAndFilter(
            String jurisdiction,
            String nearby,
            boolean hasVideoOnly,
            String roadId,
            String textQ) throws Exception {
        List<WebcamItemDto> matches = new ArrayList<>();
        List<String> tokens = textQ != null ? tokenizeQuery(textQ) : List.of();
        int scanned = 0;
        int apiTotal = Integer.MAX_VALUE;
        int fetchOffset = 0;

        while (scanned < TEXT_FILTER_SCAN_MAX && fetchOffset < apiTotal) {
            int batch = Math.min(TEXT_FILTER_PAGE_SIZE, TEXT_FILTER_SCAN_MAX - scanned);
            JsonNode root = fetchFeaturesPage(jurisdiction, nearby, batch, fetchOffset);
            if (root != null && root.has("total") && root.get("total").canConvertToInt()) {
                apiTotal = root.get("total").asInt();
            }
            List<WebcamItemDto> batchItems = mapFeatureArray(root, false);
            if (batchItems.isEmpty()) {
                break;
            }
            for (WebcamItemDto item : batchItems) {
                if (hasVideoOnly && !Boolean.TRUE.equals(item.getHasVideo())) {
                    continue;
                }
                if (roadId != null && !matchesRoadId(item, roadId)) {
                    continue;
                }
                if (!tokens.isEmpty() && !matchesQuery(item, tokens)) {
                    continue;
                }
                matches.add(item);
            }
            scanned += batchItems.size();
            fetchOffset += batchItems.size();
            if (batchItems.size() < batch) {
                break;
            }
        }
        return matches;
    }

    private JsonNode fetchFeaturesPage(String jurisdiction, String nearby, int limit, int offset)
            throws Exception {
        StringBuilder url = new StringBuilder(trimSlash(apiBase))
                .append("/features?type=cameras&active=true")
                .append("&limit=").append(limit)
                .append("&offset=").append(offset);

        // Free plan requires jurisdiction on every features query — keep it even with
        // lat/lng (docs: ...&jurisdiction=ESP&lat=...&lng=...&radius_km=50).
        if (jurisdiction != null) {
            url.append("&jurisdiction=").append(enc(jurisdiction));
        }
        Nearby geo = parseNearby(nearby);
        if (geo != null) {
            url.append("&lat=").append(geo.lat)
                    .append("&lng=").append(geo.lon)
                    .append("&radius_km=").append(geo.radiusKm);
        }
        return getJson(url.toString());
    }

    private List<WebcamItemDto> mapFeatureArray(JsonNode root, boolean hasVideoOnly) {
        List<WebcamItemDto> mapped = new ArrayList<>();
        JsonNode data = root != null ? firstArray(root, "data", "features", "items") : null;
        if (data == null || !data.isArray()) {
            return mapped;
        }
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
        return mapped;
    }

    private String resolveNearbyFromQuery(String q, String jurisdictionIso3) {
        if (q.length() < 2) {
            return null;
        }
        String query = q;
        if (StringUtils.hasText(jurisdictionIso3)) {
            String country = countryName(jurisdictionIso3);
            if (StringUtils.hasText(country) && !country.equalsIgnoreCase(jurisdictionIso3)) {
                query = q + ", " + country;
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
            log.debug("NAPSPAN place geocode failed for '{}': {}", q, e.toString());
            return null;
        }
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

    /** "a6" / "A-6" / "autoroute A6" → "A6". */
    static String normalizeRoadId(String q) {
        if (!StringUtils.hasText(q)) {
            return "";
        }
        String t = q.trim();
        t = t.replaceAll("(?i)^(autoroute|autostrada|autobahn|motorway|highway|route|strada|via)\\s+", "");
        t = t.replaceAll("[\\s\\-]+", "");
        return t.toUpperCase(Locale.ROOT);
    }

    /**
     * Match road id as a whole token (A6 matches "Autoroute A6 …" / "A-6" / road_name A6,
     * but not A10 / A61).
     */
    static boolean matchesRoadId(WebcamItemDto item, String roadId) {
        if (item == null || !StringUtils.hasText(roadId)) {
            return false;
        }
        String needle = roadId.trim().toUpperCase(Locale.ROOT);
        Pattern boundary = Pattern.compile(
                "(?<![A-Z0-9])" + Pattern.quote(needle) + "(?![0-9])");
        StringBuilder hay = new StringBuilder();
        appendHay(hay, item.getTitle());
        appendHay(hay, item.getCity());
        appendHay(hay, item.getId());
        if (item.getCategories() != null) {
            for (String cat : item.getCategories()) {
                appendHay(hay, cat);
            }
        }
        // Compact "A 6" / "A-6" → "A6" so spaced titles still match.
        String compact = hay.toString().toUpperCase(Locale.ROOT)
                .replaceAll("([A-Z])[\\s\\-]+(\\d)", "$1$2");
        return boundary.matcher(compact).find();
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
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
            log.warn("NAPSPAN camera detail failed id={}: {}", safeId, e.toString());
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
        String jurisdiction = text(n, "jurisdiction", "source");
        if (!StringUtils.hasText(jurisdiction)) {
            jurisdiction = text(props, "jurisdiction", "country", "source");
        }
        if (StringUtils.hasText(jurisdiction)) {
            jurisdiction = toNapspanJurisdiction(jurisdiction);
        }
        String roadName = text(n, "road_name", "road");
        if (!StringUtils.hasText(roadName)) {
            roadName = text(props, "road_name", "road");
        }
        String direction = text(n, "direction");
        if (!StringUtils.hasText(direction)) {
            direction = text(props, "direction");
        }
        String place = firstNonBlank(
                text(props, "nearby_place", "city", "municipality", "county"),
                text(n, "city"));
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
        dto.setTitle(StringUtils.hasText(name) ? decodeBasicHtml(name.trim()) : id.trim());
        dto.setStatus(active ? "active" : "inactive");
        dto.setRegion(jurisdiction);
        dto.setCity(place);
        dto.setCountry(countryName(jurisdiction));
        dto.setCountryCode(jurisdiction);
        dto.setContinent("Europe");
        dto.setContinentCode("EU");
        dto.setLatitude(lat);
        dto.setLongitude(lon);
        dto.setImageUrl(imageUrl);
        dto.setImagePreviewUrl(imageUrl);
        boolean hasVideo = StringUtils.hasText(videoUrl);
        dto.setHasVideo(hasVideo);
        if (hasVideo) {
            dto.setPlayerLiveUrl(videoUrl.trim());
        }
        dto.setDetailUrl("https://napspan.com");
        List<String> cats = new ArrayList<>();
        cats.add("traffic");
        cats.add("europe");
        if (hasVideo) {
            String vu = videoUrl.trim().toLowerCase(Locale.ROOT);
            if (vu.contains(".m3u8") || vu.contains("playlist.m3u8")) {
                cats.add("hls");
            } else {
                cats.add("video");
            }
        }
        if (StringUtils.hasText(roadName)) {
            cats.add(roadName.trim());
        }
        if (StringUtils.hasText(direction)) {
            cats.add(direction.trim());
        }
        dto.setCategories(cats);
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
        int status = response.statusCode();
        if (status >= 400) {
            throw new IllegalStateException(napspanHttpError(status, response.body()));
        }
        return objectMapper.readTree(response.body());
    }

    private String napspanHttpError(int status, String body) {
        String code = null;
        String message = null;
        try {
            if (StringUtils.hasText(body)) {
                JsonNode err = objectMapper.readTree(body);
                if (err != null) {
                    code = text(err, "code");
                    message = text(err, "error", "message");
                }
            }
        } catch (Exception ignored) {
            // fall through to status-based message
        }
        if (status == 401) {
            return "NAPSPAN API key rejected (HTTP 401)";
        }
        if (status == 403) {
            if ("plan_jurisdiction".equals(code)) {
                return "NAPSPAN Free plan requires a country (jurisdiction) filter"
                        + (StringUtils.hasText(message) ? ": " + message : "");
            }
            if ("trial_expired".equals(code) || "subscription_expired".equals(code)) {
                return "NAPSPAN plan expired (" + code + ")";
            }
            if (StringUtils.hasText(code)) {
                return "NAPSPAN plan limit (HTTP 403, " + code + ")"
                        + (StringUtils.hasText(message) ? ": " + message : "");
            }
            return "NAPSPAN plan limit or key rejected (HTTP 403)"
                    + (StringUtils.hasText(message) ? ": " + message : "");
        }
        if (status == 429) {
            return "NAPSPAN rate limit exceeded (HTTP 429)";
        }
        return "NAPSPAN HTTP " + status
                + (StringUtils.hasText(message) ? ": " + message : "");
    }

    private Duration listCacheTtl() {
        int minutes = clamp(searchCacheMinutes, 1, 30, 2);
        return Duration.ofMinutes(minutes);
    }

    /**
     * NAPSPAN feature filters use ISO-3166 alpha-3 ({@code FRA}, {@code ESP}).
     * Convert common alpha-2 aliases so older UI state still works.
     */
    private static String toNapspanJurisdiction(String raw) {
        String c = raw.trim().toUpperCase(Locale.ROOT);
        return switch (c) {
            case "FR" -> "FRA";
            case "DE" -> "DEU";
            case "NL" -> "NLD";
            case "BE" -> "BEL";
            case "ES" -> "ESP";
            case "IT" -> "ITA";
            case "AT" -> "AUT";
            case "CH" -> "CHE";
            case "GB", "UK" -> "GBR";
            case "SE" -> "SWE";
            case "DK" -> "DNK";
            case "NO" -> "NOR";
            case "PL" -> "POL";
            case "FI" -> "FIN";
            case "IE" -> "IRL";
            case "PT" -> "PRT";
            case "CZ" -> "CZE";
            case "HU" -> "HUN";
            case "HR" -> "HRV";
            case "SI" -> "SVN";
            case "EE" -> "EST";
            case "LV" -> "LVA";
            case "LT" -> "LTU";
            case "LU" -> "LUX";
            case "CY" -> "CYP";
            case "IS" -> "ISL";
            case "UA" -> "UKR";
            default -> c;
        };
    }

    private static String countryName(String code) {
        if (!StringUtils.hasText(code)) {
            return "Europe";
        }
        String n = COUNTRY_NAMES.get(code.toUpperCase(Locale.ROOT));
        return n != null ? n : code.toUpperCase(Locale.ROOT);
    }

    private static Map<String, String> countryNames() {
        Map<String, String> m = new HashMap<>();
        m.put("DEU", "Germany");
        m.put("FRA", "France");
        m.put("NLD", "Netherlands");
        m.put("BEL", "Belgium");
        m.put("ESP", "Spain");
        m.put("ITA", "Italy");
        m.put("AUT", "Austria");
        m.put("CHE", "Switzerland");
        m.put("GBR", "United Kingdom");
        m.put("SWE", "Sweden");
        m.put("DNK", "Denmark");
        m.put("NOR", "Norway");
        m.put("POL", "Poland");
        m.put("FIN", "Finland");
        m.put("IRL", "Ireland");
        m.put("PRT", "Portugal");
        m.put("CZE", "Czechia");
        m.put("HUN", "Hungary");
        m.put("HRV", "Croatia");
        m.put("SVN", "Slovenia");
        m.put("EST", "Estonia");
        m.put("LVA", "Latvia");
        m.put("LTU", "Lithuania");
        m.put("LUX", "Luxembourg");
        m.put("CYP", "Cyprus");
        m.put("ISL", "Iceland");
        m.put("UKR", "Ukraine");
        // alpha-2 aliases for display if ever stored
        m.put("DE", "Germany");
        m.put("FR", "France");
        m.put("NL", "Netherlands");
        m.put("BE", "Belgium");
        m.put("ES", "Spain");
        m.put("IT", "Italy");
        return Map.copyOf(m);
    }

    private static String decodeBasicHtml(String s) {
        if (s == null || s.indexOf('&') < 0) {
            return s;
        }
        return s
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&apos;", "'")
                .replace("&#39;", "'")
                .replace("&agrave;", "à").replace("&Agrave;", "À")
                .replace("&aacute;", "á").replace("&Aacute;", "Á")
                .replace("&acirc;", "â").replace("&Acirc;", "Â")
                .replace("&auml;", "ä").replace("&Auml;", "Ä")
                .replace("&ccedil;", "ç").replace("&Ccedil;", "Ç")
                .replace("&egrave;", "è").replace("&Egrave;", "È")
                .replace("&eacute;", "é").replace("&Eacute;", "É")
                .replace("&ecirc;", "ê").replace("&Ecirc;", "Ê")
                .replace("&euml;", "ë").replace("&Euml;", "Ë")
                .replace("&igrave;", "ì").replace("&Igrave;", "Ì")
                .replace("&iacute;", "í").replace("&Iacute;", "Í")
                .replace("&icirc;", "î").replace("&Icirc;", "Î")
                .replace("&iuml;", "ï").replace("&Iuml;", "Ï")
                .replace("&ntilde;", "ñ").replace("&Ntilde;", "Ñ")
                .replace("&ograve;", "ò").replace("&Ograve;", "Ò")
                .replace("&oacute;", "ó").replace("&Oacute;", "Ó")
                .replace("&ocirc;", "ô").replace("&Ocirc;", "Ô")
                .replace("&ouml;", "ö").replace("&Ouml;", "Ö")
                .replace("&ugrave;", "ù").replace("&Ugrave;", "Ù")
                .replace("&uacute;", "ú").replace("&Uacute;", "Ú")
                .replace("&ucirc;", "û").replace("&Ucirc;", "Û")
                .replace("&uuml;", "ü").replace("&Uuml;", "Ü")
                .replace("&nbsp;", " ");
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
        dto.setStatus(src.getStatus());
        dto.setViewCount(src.getViewCount());
        dto.setLastUpdatedOn(src.getLastUpdatedOn());
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
        dto.setCategories(src.getCategories() != null ? new ArrayList<>(src.getCategories()) : new ArrayList<>());
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
