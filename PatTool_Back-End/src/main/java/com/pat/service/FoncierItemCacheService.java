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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Persists Foncier listings / DVF mutations found via the APIs so later searches
 * can use cache only, API only, or both.
 */
@Service
public class FoncierItemCacheService {

    private static final Logger log = LoggerFactory.getLogger(FoncierItemCacheService.class);
    public static final String CEREMA = "cerema";
    public static final String STREAM_ESTATE = "stream-estate";
    public static final String CHERCHER_TROUVER = "chercher-trouver";
    private static final int MAX_PER_PROVIDER = 5000;
    private static final Set<String> PROVIDERS = Set.of(CEREMA, STREAM_ESTATE, CHERCHER_TROUVER);

    private final ObjectMapper objectMapper;
    private final FoncierGeoService geoService;
    private final Map<String, ConcurrentHashMap<String, ObjectNode>> store = new ConcurrentHashMap<>();
    private final Object fileLock = new Object();

    @Value("${app.cache.persistence.dir:./cache}")
    private String cacheDir;

    public FoncierItemCacheService(ObjectMapper objectMapper, FoncierGeoService geoService) {
        this.objectMapper = objectMapper;
        this.geoService = geoService;
        for (String provider : PROVIDERS) {
            store.put(provider, new ConcurrentHashMap<>());
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
            for (String provider : PROVIDERS) {
                JsonNode bucket = root.get(provider);
                if (bucket == null || !bucket.isObject()) {
                    continue;
                }
                ConcurrentHashMap<String, ObjectNode> map = store.get(provider);
                bucket.fields().forEachRemaining(entry -> {
                    if (entry.getValue() != null && entry.getValue().isObject()) {
                        map.put(entry.getKey(), (ObjectNode) entry.getValue().deepCopy());
                    }
                });
                loaded += map.size();
            }
            log.info("Foncier item cache loaded: {} items from {}", loaded, file.toAbsolutePath());
        } catch (Exception ex) {
            log.warn("Foncier item cache load failed: {}", ex.getMessage());
        }
    }

    public enum Source {
        CACHE, BOTH, API;

        public static Source parse(String raw) {
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

    public JsonNode places(String provider, String query) {
        ObjectNode root = objectMapper.createObjectNode();
        ArrayNode items = objectMapper.createArrayNode();
        root.set("items", items);
        ConcurrentHashMap<String, ObjectNode> map = store.get(normalizeProvider(provider));
        if (map == null) {
            return root;
        }
        String needle = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        Map<String, ObjectNode> unique = new LinkedHashMap<>();
        for (ObjectNode item : map.values()) {
            if (item == null) {
                continue;
            }
            String city = FoncierGeoService.text(item.get("city"));
            String zip = FoncierGeoService.text(item.get("zipcode"));
            String insee = padInsee(FoncierGeoService.text(item.get("insee")));
            if (!StringUtils.hasText(city) && !StringUtils.hasText(zip) && !StringUtils.hasText(insee)) {
                continue;
            }
            if (StringUtils.hasText(needle)
                    && !city.toLowerCase(Locale.ROOT).contains(needle)
                    && !zip.toLowerCase(Locale.ROOT).contains(needle)
                    && !insee.contains(needle)) {
                continue;
            }
            String key = StringUtils.hasText(insee)
                    ? insee
                    : (zip + "|" + city.toLowerCase(Locale.ROOT));
            unique.computeIfAbsent(key, ignored -> {
                ObjectNode place = objectMapper.createObjectNode();
                place.put("code", StringUtils.hasText(insee) ? insee : zip);
                place.put("nom", StringUtils.hasText(city) ? city : zip);
                if (StringUtils.hasText(zip)) {
                    ArrayNode zips = objectMapper.createArrayNode();
                    zips.add(zip);
                    place.set("codesPostaux", zips);
                }
                if (item.has("lat")) {
                    place.set("lat", item.get("lat"));
                }
                if (item.has("lon")) {
                    place.set("lon", item.get("lon"));
                }
                return place;
            });
            if (unique.size() >= 12) {
                break;
            }
        }
        unique.values().forEach(items::add);
        return root;
    }

    public int size(String provider) {
        ConcurrentHashMap<String, ObjectNode> map = store.get(normalizeProvider(provider));
        return map == null ? 0 : map.size();
    }

    public ObjectNode snapshot(String provider) {
        String key = normalizeProvider(provider);
        ObjectNode root = objectMapper.createObjectNode();
        root.put("provider", key);
        ArrayNode items = objectMapper.createArrayNode();
        ConcurrentHashMap<String, ObjectNode> map = store.get(key);
        if (map != null) {
            for (ObjectNode item : map.values()) {
                if (item == null) {
                    continue;
                }
                ObjectNode copy = item.deepCopy();
                copy.remove("cachedAt");
                items.add(copy);
            }
        }
        root.put("count", items.size());
        root.set("items", items);
        return root;
    }

    public int clear(String provider) {
        String key = normalizeProvider(provider);
        ConcurrentHashMap<String, ObjectNode> map = store.get(key);
        if (map == null) {
            return 0;
        }
        int n = map.size();
        map.clear();
        persist();
        return n;
    }

    public void putItems(String provider, JsonNode page, String codeInsee) {
        ConcurrentHashMap<String, ObjectNode> map = store.get(normalizeProvider(provider));
        if (map == null || page == null || !page.isObject()) {
            return;
        }
        JsonNode items = page.get("items");
        if (items == null || !items.isArray() || items.size() == 0) {
            return;
        }
        long now = System.currentTimeMillis();
        int added = 0;
        for (JsonNode item : items) {
            if (item == null || !item.isObject()) {
                continue;
            }
            ObjectNode copy = item.deepCopy();
            if (StringUtils.hasText(codeInsee)
                    && !StringUtils.hasText(FoncierGeoService.text(copy.get("insee")))
                    && !StringUtils.hasText(FoncierGeoService.text(copy.get("city")))
                    && !StringUtils.hasText(FoncierGeoService.text(copy.get("zipcode")))
                    && !copy.has("lat")) {
                copy.put("insee", codeInsee.trim());
            }
            String id = itemId(copy);
            if (!StringUtils.hasText(id)) {
                continue;
            }
            copy.put("id", id);
            copy.put("cachedAt", now);
            map.put(id, copy);
            added++;
        }
        if (added > 0) {
            evictOldest(map);
            persist();
        }
    }

    public ObjectNode listingsPage(String provider, ListingQuery query) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("configured", true);
        root.put("source", query.source.wire());
        root.put("cacheCount", size(provider));
        List<ObjectNode> matched = matchListings(provider, query);
        return fillAll(root, matched);
    }

    public ObjectNode mutationsPage(ListingQuery query) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("codeInsee", query.codeInsee == null ? "" : query.codeInsee);
        root.put("typeLocal", query.type == null ? "" : query.type);
        root.put("pageSize", query.pageSize);
        root.put("source", query.source.wire());
        root.put("cacheCount", size(CEREMA));
        List<ObjectNode> matched = matchListings(CEREMA, query);
        return fillAll(root, matched);
    }

    public JsonNode mergeListings(String provider, ListingQuery query, JsonNode apiPage) {
        putItems(provider, apiPage, query.codeInsee);
        ObjectNode root = objectMapper.createObjectNode();
        root.put("configured", apiPage != null && apiPage.path("configured").asBoolean(true));
        root.put("source", query.source.wire());
        root.put("cacheCount", size(provider));
        List<ObjectNode> merged = mergeApiThenCache(provider, query, apiPage);
        if (apiPage != null && !apiPage.path("hasNext").asBoolean(false)) {
            return fillAll(root, merged);
        }
        return slice(root, merged, query.page, query.pageSize);
    }

    public JsonNode mergeMutations(ListingQuery query, JsonNode apiPage) {
        putItems(CEREMA, apiPage, query.codeInsee);
        ObjectNode root = objectMapper.createObjectNode();
        root.put("codeInsee", query.codeInsee == null ? "" : query.codeInsee);
        root.put("typeLocal", query.type == null ? "" : query.type);
        root.put("pageSize", query.pageSize);
        root.put("source", query.source.wire());
        root.put("cacheCount", size(CEREMA));
        List<ObjectNode> merged = mergeApiThenCache(CEREMA, query, apiPage);
        if (apiPage != null && !apiPage.path("hasNext").asBoolean(false)) {
            return fillAll(root, merged);
        }
        return slice(root, merged, query.page, query.pageSize);
    }

    private List<ObjectNode> mergeApiThenCache(String provider, ListingQuery query, JsonNode apiPage) {
        List<ObjectNode> merged = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        if (apiPage != null && apiPage.path("items").isArray()) {
            for (JsonNode item : apiPage.get("items")) {
                if (item == null || !item.isObject()) {
                    continue;
                }
                ObjectNode copy = item.deepCopy();
                if (!matchesFilters(copy, query)) {
                    continue;
                }
                String id = itemId(copy);
                if (StringUtils.hasText(id)) {
                    seen.add(id);
                }
                merged.add(copy);
            }
        }
        for (ObjectNode cached : matchListings(provider, query)) {
            String id = itemId(cached);
            if (StringUtils.hasText(id) && seen.contains(id)) {
                continue;
            }
            if (StringUtils.hasText(id)) {
                seen.add(id);
            }
            merged.add(cached);
        }
        return merged;
    }

    public JsonNode annotateApiPage(String provider, JsonNode apiPage, Source source) {
        if (apiPage == null || !apiPage.isObject()) {
            ObjectNode empty = objectMapper.createObjectNode();
            empty.put("source", source.wire());
            empty.put("cacheCount", size(provider));
            empty.putArray("items");
            empty.put("count", 0);
            empty.put("hasNext", false);
            return empty;
        }
        ObjectNode copy = apiPage.deepCopy();
        copy.put("source", source.wire());
        copy.put("cacheCount", size(provider));
        return copy;
    }

    private List<ObjectNode> matchListings(String provider, ListingQuery query) {
        ConcurrentHashMap<String, ObjectNode> map = store.get(normalizeProvider(provider));
        List<ObjectNode> out = new ArrayList<>();
        if (map == null) {
            return out;
        }
        PlaceScope place = placeScope(provider, query);
        for (ObjectNode item : map.values()) {
            if (matchesPlace(item, place) && matchesFilters(item, query)) {
                out.add(item.deepCopy());
            }
        }
        out.sort(Comparator
                .comparingLong((ObjectNode n) -> n.path("cachedAt").asLong(0L))
                .reversed()
                .thenComparing(n -> FoncierGeoService.text(n.get("id"))));
        for (ObjectNode item : out) {
            item.remove("cachedAt");
        }
        return out;
    }

    private ObjectNode fillAll(ObjectNode root, List<ObjectNode> matched) {
        ArrayNode items = objectMapper.createArrayNode();
        for (ObjectNode item : matched) {
            items.add(item);
        }
        root.put("page", 1);
        root.put("count", matched.size());
        root.put("hasNext", false);
        root.set("items", items);
        return root;
    }

    private ObjectNode slice(ObjectNode root, List<ObjectNode> matched, int page, int pageSize) {
        int p = Math.max(1, page);
        int size = Math.max(1, pageSize);
        int from = (p - 1) * size;
        int to = Math.min(from + size, matched.size());
        ArrayNode items = objectMapper.createArrayNode();
        for (int i = from; i < to; i++) {
            items.add(matched.get(i));
        }
        root.put("page", p);
        root.put("count", matched.size());
        root.put("hasNext", to < matched.size());
        root.set("items", items);
        return root;
    }

    private PlaceScope placeScope(String provider, ListingQuery query) {
        PlaceScope scope = new PlaceScope();
        scope.insee = padInsee(query.codeInsee == null ? "" : query.codeInsee.trim());
        scope.city = query.city == null ? "" : query.city.trim();
        scope.zip = query.zip == null ? "" : query.zip.trim();
        if (scope.city.matches("\\d{5}") && !StringUtils.hasText(scope.zip)) {
            scope.zip = scope.city;
            scope.city = "";
        }
        scope.radiusKm = query.radiusKm;
        if (query.lat != null && query.lon != null) {
            scope.lat = query.lat;
            scope.lon = query.lon;
        }
        boolean cacheOnly = query.source == Source.CACHE;
        if (cacheOnly) {
            if (scope.radiusKm > 0 && scope.lat == null) {
                inferCenterFromCache(provider, scope);
            }
        } else {
            ObjectNode center = geoService.centerOf(
                    StringUtils.hasText(scope.insee) ? scope.insee : null,
                    StringUtils.hasText(scope.city) ? scope.city : query.q);
            if (center != null) {
                if (!StringUtils.hasText(scope.city)) {
                    scope.city = FoncierGeoService.text(center.get("nom"));
                }
                if (!StringUtils.hasText(scope.insee)) {
                    scope.insee = padInsee(FoncierGeoService.text(center.get("code")));
                }
                List<String> zips = geoService.zipcodesOf(center);
                if (!StringUtils.hasText(scope.zip) && !zips.isEmpty()) {
                    scope.zip = zips.get(0);
                }
                if (scope.lat == null && center.has("lat") && center.has("lon")) {
                    scope.lat = center.get("lat").asDouble();
                    scope.lon = center.get("lon").asDouble();
                }
            }
            if (scope.radiusKm > 0 && scope.lat != null) {
                for (ObjectNode nearby : geoService.communesNear(scope.lat, scope.lon, scope.radiusKm)) {
                    String code = padInsee(FoncierGeoService.text(nearby.get("code")));
                    if (StringUtils.hasText(code)) {
                        scope.nearbyInsee.add(code);
                    }
                    String nom = FoncierGeoService.text(nearby.get("nom"));
                    if (StringUtils.hasText(nom)) {
                        scope.nearbyCities.add(nom.toLowerCase(Locale.ROOT));
                    }
                    scope.nearbyZips.addAll(geoService.zipcodesOf(nearby));
                }
            }
        }
        if (StringUtils.hasText(scope.insee)) {
            scope.nearbyInsee.add(scope.insee);
        }
        if (StringUtils.hasText(scope.zip)) {
            scope.nearbyZips.add(scope.zip);
        }
        if (StringUtils.hasText(scope.city)) {
            scope.nearbyCities.add(scope.city.toLowerCase(Locale.ROOT));
        }
        return scope;
    }

    private void inferCenterFromCache(String provider, PlaceScope scope) {
        ConcurrentHashMap<String, ObjectNode> map = store.get(normalizeProvider(provider));
        if (map == null) {
            return;
        }
        for (ObjectNode item : map.values()) {
            if (item == null || !item.has("lat") || !item.has("lon")) {
                continue;
            }
            String itemInsee = padInsee(FoncierGeoService.text(item.get("insee")));
            String itemZip = FoncierGeoService.text(item.get("zipcode"));
            String itemCity = FoncierGeoService.text(item.get("city"));
            boolean samePlace = (StringUtils.hasText(scope.insee) && scope.insee.equals(itemInsee))
                    || (StringUtils.hasText(scope.zip) && scope.zip.equals(itemZip))
                    || (StringUtils.hasText(scope.city) && scope.city.equalsIgnoreCase(itemCity));
            if (samePlace) {
                scope.lat = item.get("lat").asDouble();
                scope.lon = item.get("lon").asDouble();
                return;
            }
        }
    }

    private static boolean matchesPlace(ObjectNode item, PlaceScope place) {
        String itemInsee = padInsee(FoncierGeoService.text(item.get("insee")));
        String itemZip = FoncierGeoService.text(item.get("zipcode"));
        String itemCity = FoncierGeoService.text(item.get("city"));
        if (place.radiusKm > 0 && item.has("lat") && item.has("lon") && place.lat != null) {
            return FoncierGeoService.distanceKm(
                    place.lat, place.lon, item.get("lat").asDouble(), item.get("lon").asDouble())
                    <= place.radiusKm + 0.3;
        }
        if (place.radiusKm > 0) {
            return (!itemInsee.isEmpty() && place.nearbyInsee.contains(itemInsee))
                    || (!itemZip.isEmpty() && place.nearbyZips.contains(itemZip))
                    || (!itemCity.isEmpty() && place.nearbyCities.contains(itemCity.toLowerCase(Locale.ROOT)));
        }
        if (StringUtils.hasText(place.insee) && place.insee.equals(itemInsee)) {
            return true;
        }
        if (StringUtils.hasText(place.zip) && (place.zip.equals(itemZip) || itemZip.contains(place.zip))) {
            return true;
        }
        if (!StringUtils.hasText(place.city)) {
            return false;
        }
        String needle = place.city.toLowerCase(Locale.ROOT);
        String address = FoncierGeoService.text(item.get("address"));
        return itemCity.toLowerCase(Locale.ROOT).contains(needle)
                || address.toLowerCase(Locale.ROOT).contains(needle);
    }

    private static boolean matchesFilters(ObjectNode item, ListingQuery query) {
        if (StringUtils.hasText(query.type)) {
            String type = query.type.trim().toLowerCase(Locale.ROOT);
            String itemType = (FoncierGeoService.text(item.get("type"))
                    + " " + FoncierGeoService.text(item.get("typeLocal"))).toLowerCase(Locale.ROOT);
            if (!itemType.contains(type)
                    && !(type.equals("appartement") && itemType.contains("apartment"))
                    && !(type.equals("maison") && itemType.contains("house"))
                    && !(type.equals("terrain") && itemType.contains("land"))) {
                return false;
            }
        }
        if (query.priceMin != null && item.has("price") && item.get("price").asDouble() < query.priceMin) {
            return false;
        }
        if (query.priceMax != null && item.has("price") && item.get("price").asDouble() > query.priceMax) {
            return false;
        }
        if (query.surfaceMin != null && item.has("surface") && item.get("surface").asDouble() < query.surfaceMin) {
            return false;
        }
        if (query.surfaceMax != null && item.has("surface") && item.get("surface").asDouble() > query.surfaceMax) {
            return false;
        }
        return true;
    }

    private static String padInsee(String raw) {
        if (raw == null) {
            return "";
        }
        String digits = raw.replaceAll("\\D", "");
        if (digits.isEmpty()) {
            return raw.trim();
        }
        if (digits.length() >= 5) {
            return digits.substring(0, 5);
        }
        return "0".repeat(5 - digits.length()) + digits;
    }

    private static String itemId(ObjectNode item) {
        String id = FoncierGeoService.text(item.get("id"));
        if (StringUtils.hasText(id)) {
            return id;
        }
        return String.join("|",
                FoncierGeoService.text(item.get("title")),
                FoncierGeoService.text(item.get("address")),
                FoncierGeoService.text(item.get("city")),
                FoncierGeoService.text(item.get("date")),
                item.has("price") ? item.get("price").asText() : "");
    }

    private static String normalizeProvider(String provider) {
        String key = provider == null ? "" : provider.trim().toLowerCase(Locale.ROOT);
        return PROVIDERS.contains(key) ? key : "";
    }

    private static void evictOldest(ConcurrentHashMap<String, ObjectNode> map) {
        if (map.size() <= MAX_PER_PROVIDER) {
            return;
        }
        List<Map.Entry<String, ObjectNode>> entries = new ArrayList<>(map.entrySet());
        entries.sort(Comparator.comparingLong(e -> e.getValue().path("cachedAt").asLong(0L)));
        int drop = map.size() - MAX_PER_PROVIDER;
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
                for (String provider : PROVIDERS) {
                    ObjectNode bucket = objectMapper.createObjectNode();
                    store.get(provider).forEach(bucket::set);
                    root.set(provider, bucket);
                }
                Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
                objectMapper.writerWithDefaultPrettyPrinter().writeValue(tmp.toFile(), root);
                try {
                    Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                } catch (IOException ignored) {
                    Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
                }
            } catch (IOException ex) {
                log.warn("Foncier item cache save failed: {}", ex.getMessage());
            }
        }
    }

    private Path filePath() {
        String dir = StringUtils.hasText(cacheDir) ? cacheDir : "./cache";
        return Path.of(dir).resolve("foncier-items.json");
    }

    public static final class ListingQuery {
        public Source source = Source.BOTH;
        public String q;
        public String codeInsee;
        public String city;
        public String zip;
        public String type;
        public Integer priceMin;
        public Integer priceMax;
        public Integer surfaceMin;
        public Integer surfaceMax;
        public int radiusKm;
        public Double lat;
        public Double lon;
        public int page = 1;
        public int pageSize = 20;
    }

    private static final class PlaceScope {
        String insee = "";
        String city = "";
        String zip = "";
        Double lat;
        Double lon;
        int radiusKm;
        final Set<String> nearbyInsee = new HashSet<>();
        final Set<String> nearbyZips = new HashSet<>();
        final Set<String> nearbyCities = new HashSet<>();
    }
}
