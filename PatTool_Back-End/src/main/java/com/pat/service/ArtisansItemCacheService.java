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
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
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
    private static final int MAX_PER_SOURCE = 8000;
    private static final Set<String> SOURCES = Set.of(SIRENE, OSM);

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
            persist();
        }
    }

    public ObjectNode page(NearbyQuery query) {
        ObjectNode root = baseMeta(query);
        List<ObjectNode> matched = match(query);
        return slice(root, matched, query.page, query.perPage);
    }

    public JsonNode merge(NearbyQuery query, JsonNode apiPage) {
        putItems(query.source, apiPage, query.generation);
        ObjectNode root = baseMeta(query);
        List<ObjectNode> merged = mergeApiThenCache(query, apiPage);
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
        merged.sort(Comparator.comparingDouble(n -> n.path("distanceKm").asDouble(999)));
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
        out.sort(Comparator.comparingDouble(n -> n.path("distanceKm").asDouble(999)));
        return out;
    }

    private boolean matches(ObjectNode item, NearbyQuery query) {
        Double lat = asDouble(item.get("lat"));
        Double lon = asDouble(item.get("lon"));
        if (lat == null || lon == null) {
            return false;
        }
        double dist = ArtisansNearbyService.haversineKm(query.lat, query.lon, lat, lon);
        if (dist > query.radiusKm + 0.05) {
            return false;
        }
        if (StringUtils.hasText(query.trade) && !"all".equals(query.trade)) {
            String tradeKey = text(item.get("tradeKey"));
            if (!query.trade.equalsIgnoreCase(tradeKey)) {
                return false;
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
        int size = Math.max(1, perPage);
        int from = Math.min((p - 1) * size, matched.size());
        int to = Math.min(from + size, matched.size());
        ArrayNode items = objectMapper.createArrayNode();
        for (int i = from; i < to; i++) {
            items.add(matched.get(i));
        }
        root.put("page", p);
        root.put("perPage", size);
        root.put("total", matched.size());
        root.set("items", items);
        return root;
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
        public long generation;
    }
}
