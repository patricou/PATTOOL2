package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.text.Collator;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Shared persistent cache of artisans / shops found via SIRENE or OSM.
 * All users read and write the same store.
 */
@Service
public class ArtisansItemCacheService {

    private static final Logger log = LoggerFactory.getLogger(ArtisansItemCacheService.class);
    public static final String SIRENE = "sirene";
    public static final String OSM = "osm";
    /** Enough for a full SIRENE near_point dump (10 000) plus other places. */
    private static final int MAX_PER_SOURCE = 50_000;
    /** Map markers are independent of list pagination (nearest-first pages cluster at the origin). */
    private static final int MAX_MAP_ITEMS = 10_000;
    private static final Set<String> SOURCES = Set.of(SIRENE, OSM);
    private static final Set<String> SORTS = Set.of(
            "distance-asc", "distance-desc", "name-asc", "name-desc", "trade-asc", "city-asc");

    private final ObjectMapper objectMapper;
    private final Map<String, ConcurrentHashMap<String, ObjectNode>> store = new ConcurrentHashMap<>();
    private final Object fileLock = new Object();
    private final AtomicLong generation = new AtomicLong();

    @Value("${app.cache.persistence.dir:./cache}")
    private String cacheDir;

    public ArtisansItemCacheService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        for (String source : SOURCES) {
            store.put(source, new ConcurrentHashMap<>());
        }
    }

    @PostConstruct
    void load() {
        Path file = filePath();
        if (!Files.isRegularFile(file)) {
            return;
        }
        try {
            JsonNode root = objectMapper.readTree(file.toFile());
            if (root == null || !root.isObject()) {
                return;
            }
            int loaded = 0;
            for (String source : SOURCES) {
                JsonNode bucket = root.get(source);
                if (bucket == null || !bucket.isObject()) {
                    continue;
                }
                ConcurrentHashMap<String, ObjectNode> map = store.get(source);
                bucket.fields().forEachRemaining(entry -> {
                    if (entry.getValue() != null && entry.getValue().isObject()) {
                        map.put(entry.getKey(), (ObjectNode) entry.getValue().deepCopy());
                    }
                });
                loaded += map.size();
            }
            log.info("Artisans item cache loaded: {} items from {}", loaded, file.toAbsolutePath());
        } catch (Exception ex) {
            log.warn("Artisans item cache load failed: {}", ex.getMessage());
        }
    }

    public enum CacheMode {
        CACHE, BOTH, API;

        public static CacheMode parse(String raw) {
            if (!StringUtils.hasText(raw)) {
                return CACHE;
            }
            return switch (raw.trim().toLowerCase(Locale.ROOT)) {
                case "cache" -> CACHE;
                case "api" -> API;
                case "both" -> BOTH;
                default -> CACHE;
            };
        }

        String wire() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    public long generation() {
        return generation.get();
    }

    public int size(String source) {
        ConcurrentHashMap<String, ObjectNode> map = store.get(normalizeSource(source));
        return map == null ? 0 : map.size();
    }

    public ObjectNode snapshot(String source) {
        String key = normalizeSource(source);
        ObjectNode root = objectMapper.createObjectNode();
        root.put("source", key);
        ConcurrentHashMap<String, ObjectNode> map = store.get(key);
        int total = map == null ? 0 : map.size();
        root.put("count", total);
        ArrayNode trades = objectMapper.createArrayNode();
        root.set("trades", trades);
        if (map == null || map.isEmpty()) {
            return root;
        }
        Map<String, Integer> counts = new java.util.HashMap<>();
        for (ObjectNode item : map.values()) {
            if (item == null) {
                continue;
            }
            String trade = text(item.get("tradeKey")).trim().toLowerCase(Locale.ROOT);
            if (!StringUtils.hasText(trade) || "all".equals(trade)) {
                trade = "other";
            }
            counts.merge(trade, 1, Integer::sum);
        }
        List<Map.Entry<String, Integer>> sorted = new ArrayList<>(counts.entrySet());
        sorted.sort((left, right) -> {
            int byCount = Integer.compare(right.getValue(), left.getValue());
            return byCount != 0 ? byCount : left.getKey().compareTo(right.getKey());
        });
        for (Map.Entry<String, Integer> entry : sorted) {
            ObjectNode row = objectMapper.createObjectNode();
            row.put("trade", entry.getKey());
            row.put("count", entry.getValue());
            trades.add(row);
        }
        return root;
    }

    public int clear(String source) {
        String key = normalizeSource(source);
        ConcurrentHashMap<String, ObjectNode> map = store.get(key);
        if (map == null) {
            return 0;
        }
        generation.incrementAndGet();
        int n = map.size();
        map.clear();
        persist();
        return n;
    }

    public void putItems(String source, JsonNode page) {
        putItems(source, page, generation.get());
    }

    public void putItems(String source, JsonNode page, long expectedGeneration) {
        putItems(source, page, expectedGeneration, true);
    }

    public void putItems(String source, JsonNode page, long expectedGeneration, boolean persistNow) {
        if (expectedGeneration != generation.get()) {
            return;
        }
        ConcurrentHashMap<String, ObjectNode> map = store.get(normalizeSource(source));
        if (map == null || page == null || !page.isObject()) {
            return;
        }
        JsonNode items = page.get("items");
        if (items == null || !items.isArray() || items.size() == 0) {
            return;
        }
        long now = System.currentTimeMillis();
        int added = 0;
        String src = normalizeSource(source);
        for (JsonNode item : items) {
            if (item == null || !item.isObject()) {
                continue;
            }
            ObjectNode copy = item.deepCopy();
            String id = itemId(copy);
            if (!StringUtils.hasText(id)) {
                continue;
            }
            copy.put("id", id);
            copy.put("source", src);
            copy.put("cachedAt", now);
            map.put(id, copy);
            added++;
        }
        if (added > 0) {
            evictOldest(map);
            if (persistNow) {
                persist();
            }
        }
    }

    public void flush() {
        persist();
    }

    public ObjectNode page(NearbyQuery query) {
        ObjectNode root = baseMeta(query);
        List<ObjectNode> matched = applyClosedFilter(applyCityFilter(root, match(query), query), query);
        return slice(root, matched, query.page, query.perPage);
    }

    public JsonNode merge(NearbyQuery query, JsonNode apiPage) {
        putItems(query.source, apiPage, query.generation);
        ObjectNode root = baseMeta(query);
        List<ObjectNode> merged = applyClosedFilter(applyCityFilter(root, mergeApiThenCache(query, apiPage), query), query);
        ObjectNode sliced = slice(root, merged, query.page, query.perPage);
        if (sliced.path("items").size() == 0 && apiPage != null && apiPage.path("items").size() > 0) {
            return annotate(query, apiPage);
        }
        return sliced;
    }

    public JsonNode annotate(NearbyQuery query, JsonNode apiPage) {
        if (apiPage == null || !apiPage.isObject()) {
            ObjectNode empty = baseMeta(query);
            empty.putArray("items");
            empty.put("total", 0);
            empty.put("page", query.page);
            empty.put("perPage", query.perPage);
            return empty;
        }
        ObjectNode copy = apiPage.deepCopy();
        copy.put("cacheMode", query.cacheMode.wire());
        copy.put("cacheCount", size(query.source));
        return copy;
    }

    private List<ObjectNode> mergeApiThenCache(NearbyQuery query, JsonNode apiPage) {
        List<ObjectNode> merged = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        if (apiPage != null && apiPage.path("items").isArray()) {
            for (JsonNode item : apiPage.get("items")) {
                if (item == null || !item.isObject()) {
                    continue;
                }
                ObjectNode copy = item.deepCopy();
                if (!matches(copy, query)) {
                    continue;
                }
                refreshDistance(copy, query);
                String id = itemId(copy);
                if (StringUtils.hasText(id)) {
                    seen.add(id);
                }
                copy.remove("cachedAt");
                merged.add(copy);
            }
        }
        for (ObjectNode cached : match(query)) {
            String id = itemId(cached);
            if (StringUtils.hasText(id) && seen.contains(id)) {
                continue;
            }
            if (StringUtils.hasText(id)) {
                seen.add(id);
            }
            merged.add(cached);
        }
        sortItems(merged, query);
        return merged;
    }

    private List<ObjectNode> match(NearbyQuery query) {
        ConcurrentHashMap<String, ObjectNode> map = store.get(normalizeSource(query.source));
        List<ObjectNode> out = new ArrayList<>();
        if (map == null) {
            return out;
        }
        for (ObjectNode item : map.values()) {
            if (item == null || !matches(item, query)) {
                continue;
            }
            ObjectNode copy = item.deepCopy();
            refreshDistance(copy, query);
            copy.remove("cachedAt");
            out.add(copy);
        }
        sortItems(out, query);
        return out;
    }

    private boolean matches(ObjectNode item, NearbyQuery query) {
        Double lat = asDouble(item.get("lat"));
        Double lon = asDouble(item.get("lon"));
        boolean hasCoords = lat != null && lon != null
                && Double.isFinite(lat) && Double.isFinite(lon);
        if (!hasCoords) {
            if (!query.includeWithoutCoords) {
                return false;
            }
            Double originLat = asDouble(item.get("cacheOriginLat"));
            Double originLon = asDouble(item.get("cacheOriginLon"));
            Double originRadius = asDouble(item.get("cacheOriginRadiusKm"));
            if (originLat == null || originLon == null) {
                return false;
            }
            double originDist = ArtisansNearbyService.haversineKm(query.lat, query.lon, originLat, originLon);
            double storedRadius = originRadius == null ? query.radiusKm : originRadius;
            if (originDist > 0.2 || query.radiusKm + 0.05 < storedRadius) {
                return false;
            }
        } else {
            double dist = ArtisansNearbyService.haversineKm(query.lat, query.lon, lat, lon);
            if (dist > query.radiusKm + 0.05) {
                return false;
            }
        }
        if (StringUtils.hasText(query.trade) && !"all".equals(query.trade)) {
            if (query.trade.startsWith("naf:")) {
                String wanted = query.trade.substring(4).trim().toUpperCase(Locale.ROOT);
                String code = text(item.get("activityCode")).trim().toUpperCase(Locale.ROOT);
                if (!wanted.equals(code)) {
                    return false;
                }
            } else {
                String tradeKey = text(item.get("tradeKey"));
                if (!query.trade.equalsIgnoreCase(tradeKey)) {
                    return false;
                }
            }
        }
        if (!StringUtils.hasText(query.text)) {
            return true;
        }
        String needle = query.text.toLowerCase(Locale.ROOT);
        return contains(item.get("name"), needle)
                || contains(item.get("legalName"), needle)
                || contains(item.get("city"), needle)
                || contains(item.get("address"), needle)
                || contains(item.get("activity"), needle)
                || contains(item.get("postalCode"), needle);
    }

    private List<ObjectNode> applyCityFilter(ObjectNode root, List<ObjectNode> matched, NearbyQuery query) {
        putCities(root, matched);
        if (!StringUtils.hasText(query.city)) {
            return matched;
        }
        String wanted = query.city.trim();
        List<ObjectNode> out = new ArrayList<>();
        for (ObjectNode item : matched) {
            if (text(item.get("city")).trim().equalsIgnoreCase(wanted)) {
                out.add(item);
            }
        }
        return out;
    }

    private List<ObjectNode> applyClosedFilter(List<ObjectNode> matched, NearbyQuery query) {
        for (ObjectNode item : matched) {
            item.put("closed", ArtisansOpeningHours.isClosedNow(text(item.get("openingHours"))));
        }
        if (query.includeClosed) {
            return matched;
        }
        List<ObjectNode> open = new ArrayList<>();
        for (ObjectNode item : matched) {
            if (!item.path("closed").asBoolean(false)) {
                open.add(item);
            }
        }
        return open;
    }

    private void putCities(ObjectNode root, List<ObjectNode> matched) {
        Map<String, String> byFold = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        for (ObjectNode item : matched) {
            String city = text(item.get("city")).trim();
            if (!StringUtils.hasText(city)) {
                continue;
            }
            byFold.putIfAbsent(city, city);
        }
        List<String> cities = new ArrayList<>(byFold.values());
        cities.sort(Collator.getInstance(Locale.FRENCH));
        ArrayNode arr = root.putArray("cities");
        for (String city : cities) {
            arr.add(city);
        }
    }

    private void sortItems(List<ObjectNode> items, NearbyQuery query) {
        String sort = normalizeSort(query.sort);
        Collator collator = Collator.getInstance(Locale.FRENCH);
        collator.setStrength(Collator.PRIMARY);
        items.sort((left, right) -> compareSorted(left, right, sort, collator));
    }

    private static String normalizeSort(String sort) {
        String key = sort == null ? "" : sort.trim().toLowerCase(Locale.ROOT);
        return SORTS.contains(key) ? key : "distance-asc";
    }

    private static int compareSorted(ObjectNode a, ObjectNode b, String sort, Collator collator) {
        double distA = a.path("distanceKm").asDouble(999);
        double distB = b.path("distanceKm").asDouble(999);
        int byName = collator.compare(text(a.get("name")), text(b.get("name")));
        return switch (sort) {
            case "distance-desc" -> {
                int byDist = Double.compare(distB, distA);
                yield byDist != 0 ? byDist : byName;
            }
            case "name-asc" -> byName != 0 ? byName : Double.compare(distA, distB);
            case "name-desc" -> byName != 0 ? -byName : Double.compare(distA, distB);
            case "trade-asc" -> {
                int byTrade = collator.compare(tradeSortKey(a), tradeSortKey(b));
                yield byTrade != 0 ? byTrade : byName;
            }
            case "city-asc" -> {
                int byCity = collator.compare(text(a.get("city")), text(b.get("city")));
                yield byCity != 0 ? byCity : byName;
            }
            default -> {
                int byDist = Double.compare(distA, distB);
                yield byDist != 0 ? byDist : byName;
            }
        };
    }

    private static String tradeSortKey(ObjectNode item) {
        String trade = text(item.get("tradeKey")).trim();
        return StringUtils.hasText(trade) ? trade : text(item.get("activity")).trim();
    }

    private static void refreshDistance(ObjectNode item, NearbyQuery query) {
        Double lat = asDouble(item.get("lat"));
        Double lon = asDouble(item.get("lon"));
        if (lat == null || lon == null) {
            return;
        }
        item.put("distanceKm", Math.round(
                ArtisansNearbyService.haversineKm(query.lat, query.lon, lat, lon) * 10.0) / 10.0);
    }

    private ObjectNode baseMeta(NearbyQuery query) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("source", query.source);
        root.put("cacheMode", query.cacheMode.wire());
        root.put("cacheCount", size(query.source));
        root.put("lat", query.lat);
        root.put("lon", query.lon);
        root.put("radiusKm", query.radiusKm);
        root.put("trade", query.trade);
        if (StringUtils.hasText(query.placeLabel)) {
            root.put("placeLabel", query.placeLabel);
        }
        return root;
    }

    private ObjectNode slice(ObjectNode root, List<ObjectNode> matched, int page, int perPage) {
        int p = Math.max(1, page);
        int size = perPage <= 0 ? Math.max(matched.size(), 1) : Math.max(1, perPage);
        int from = Math.min((p - 1) * size, matched.size());
        int to = Math.min(from + size, matched.size());
        ArrayNode items = objectMapper.createArrayNode();
        for (int i = from; i < to; i++) {
            items.add(matched.get(i));
        }
        root.put("page", p);
        root.put("perPage", perPage <= 0 ? 0 : size);
        root.put("total", matched.size());
        root.set("items", items);
        putMapItems(root, matched);
        return root;
    }

    private void putMapItems(ObjectNode root, List<ObjectNode> matched) {
        ArrayNode points = objectMapper.createArrayNode();
        int n = 0;
        for (ObjectNode item : matched) {
            Double lat = asDouble(item.get("lat"));
            Double lon = asDouble(item.get("lon"));
            if (lat == null || lon == null || !Double.isFinite(lat) || !Double.isFinite(lon)) {
                continue;
            }
            points.add(mapPoint(item));
            if (++n >= MAX_MAP_ITEMS) {
                break;
            }
        }
        root.set("mapItems", points);
    }

    private ObjectNode mapPoint(ObjectNode item) {
        ObjectNode point = objectMapper.createObjectNode();
        copyText(point, item, "id", "name", "legalName", "activity", "activityCode",
                "tradeKey", "address", "city", "postalCode", "url", "website", "openingHours");
        point.set("lat", item.get("lat"));
        point.set("lon", item.get("lon"));
        if (item.has("distanceKm")) {
            point.set("distanceKm", item.get("distanceKm"));
        }
        if (item.path("closed").isBoolean()) {
            point.put("closed", item.get("closed").asBoolean());
        }
        return point;
    }

    private static void copyText(ObjectNode dest, ObjectNode src, String... fields) {
        for (String field : fields) {
            String value = text(src.get(field));
            if (StringUtils.hasText(value)) {
                dest.put(field, value);
            }
        }
    }

    private static String itemId(ObjectNode item) {
        String id = text(item.get("id"));
        if (StringUtils.hasText(id)) {
            return id;
        }
        return String.join("|",
                text(item.get("name")),
                text(item.get("city")),
                text(item.get("address")),
                item.has("lat") ? item.get("lat").asText() : "",
                item.has("lon") ? item.get("lon").asText() : "");
    }

    private static String normalizeSource(String source) {
        String key = source == null ? "" : source.trim().toLowerCase(Locale.ROOT);
        return SOURCES.contains(key) ? key : "";
    }

    private static void evictOldest(ConcurrentHashMap<String, ObjectNode> map) {
        if (map.size() <= MAX_PER_SOURCE) {
            return;
        }
        List<Map.Entry<String, ObjectNode>> entries = new ArrayList<>(map.entrySet());
        entries.sort(Comparator.comparingLong(e -> e.getValue().path("cachedAt").asLong(0L)));
        int drop = map.size() - MAX_PER_SOURCE;
        for (int i = 0; i < drop && i < entries.size(); i++) {
            map.remove(entries.get(i).getKey());
        }
    }

    private void persist() {
        Path file = filePath();
        synchronized (fileLock) {
            try {
                Files.createDirectories(file.getParent());
                ObjectNode root = objectMapper.createObjectNode();
                for (String source : SOURCES) {
                    ObjectNode bucket = objectMapper.createObjectNode();
                    store.get(source).forEach(bucket::set);
                    root.set(source, bucket);
                }
                Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
                objectMapper.writerWithDefaultPrettyPrinter().writeValue(tmp.toFile(), root);
                try {
                    Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                } catch (IOException ignored) {
                    Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
                }
            } catch (IOException ex) {
                log.warn("Artisans item cache save failed: {}", ex.getMessage());
            }
        }
    }

    private Path filePath() {
        String dir = StringUtils.hasText(cacheDir) ? cacheDir : "./cache";
        return Path.of(dir).resolve("artisans-items.json");
    }

    private static String text(JsonNode node) {
        return node != null && node.isTextual() ? node.asText() : "";
    }

    private static boolean contains(JsonNode node, String needle) {
        String value = text(node).toLowerCase(Locale.ROOT);
        return StringUtils.hasText(value) && value.contains(needle);
    }

    private static Double asDouble(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return null;
        }
        if (node.isNumber()) {
            return node.asDouble();
        }
        if (node.isTextual()) {
            try {
                return Double.parseDouble(node.asText().trim());
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    public static final class NearbyQuery {
        public CacheMode cacheMode = CacheMode.CACHE;
        public String source = SIRENE;
        public double lat;
        public double lon;
        public double radiusKm;
        public String trade = "all";
        public int page = 1;
        public int perPage = 500;
        public String placeLabel = "";
        public String text = "";
        public String city = "";
        public String sort = "distance-asc";
        public long generation;
        public boolean includeWithoutCoords;
        public boolean includeClosed = true;
    }
}
