package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ArtisansItemCacheServiceTest {

    @TempDir
    Path tempDir;

    private ArtisansItemCacheService cache;

    @BeforeEach
    void setUp() {
        cache = new ArtisansItemCacheService(new ObjectMapper());
        ReflectionTestUtils.setField(cache, "cacheDir", tempDir.toString());
    }

    @Test
    void putAndClearAreSharedForSource() {
        cache.putItems("sirene", pageWith(item("123", "Boulangerie Dupont", 48.85, 2.35, "baker")));
        assertEquals(1, cache.size("sirene"));
        assertEquals(0, cache.size("osm"));

        int cleared = cache.clear("sirene");
        assertEquals(1, cleared);
        assertEquals(0, cache.size("sirene"));
    }

    @Test
    void cachePageFiltersByRadiusAndTrade() {
        cache.putItems("sirene", pageWith(
                item("1", "Près", 48.8566, 2.3522, "baker"),
                item("2", "Loin", 45.75, 4.85, "baker"),
                item("3", "Autre métier", 48.8566, 2.3522, "plumber")));

        ArtisansItemCacheService.NearbyQuery query = query(48.8566, 2.3522, 10, "baker");
        ObjectNode page = cache.page(query);
        assertEquals(1, page.path("total").asInt());
        assertEquals("1", page.path("items").get(0).path("id").asText());
        assertEquals(3, page.path("cacheCount").asInt());
        assertEquals("cache", page.path("cacheMode").asText());
    }

    @Test
    void mergeAddsCachedExtrasAndDedupe() {
        cache.putItems("sirene", pageWith(item("cached", "Ancien", 48.8566, 2.3522, "baker")));
        ObjectNode api = pageWith(item("fresh", "Nouveau", 48.8567, 2.3523, "baker"));

        ArtisansItemCacheService.NearbyQuery query = query(48.8566, 2.3522, 10, "baker");
        query.cacheMode = ArtisansItemCacheService.CacheMode.BOTH;
        ObjectNode merged = (ObjectNode) cache.merge(query, api);
        assertEquals(2, merged.path("total").asInt());
        assertEquals(2, merged.path("cacheCount").asInt());
        assertTrue(merged.path("items").toString().contains("fresh"));
        assertTrue(merged.path("items").toString().contains("cached"));
    }

    @Test
    void putItemsIgnoresStaleGenerationAfterClear() {
        long gen = cache.generation();
        cache.putItems("sirene", pageWith(item("1", "A", 48.85, 2.35, "baker")), gen);
        assertEquals(1, cache.size("sirene"));
        cache.clear("sirene");
        cache.putItems("sirene", pageWith(item("2", "B", 48.85, 2.35, "baker")), gen);
        assertEquals(0, cache.size("sirene"));
    }

    private static ArtisansItemCacheService.NearbyQuery query(
            double lat, double lon, double radiusKm, String trade) {
        ArtisansItemCacheService.NearbyQuery query = new ArtisansItemCacheService.NearbyQuery();
        query.cacheMode = ArtisansItemCacheService.CacheMode.CACHE;
        query.source = "sirene";
        query.lat = lat;
        query.lon = lon;
        query.radiusKm = radiusKm;
        query.trade = trade;
        query.page = 1;
        query.perPage = 500;
        return query;
    }

    private ObjectNode pageWith(ObjectNode... items) {
        ObjectMapper mapper = new ObjectMapper();
        ObjectNode root = mapper.createObjectNode();
        ArrayNode array = mapper.createArrayNode();
        for (ObjectNode item : items) {
            array.add(item);
        }
        root.set("items", array);
        return root;
    }

    private ObjectNode item(String id, String name, double lat, double lon, String tradeKey) {
        ObjectNode node = new ObjectMapper().createObjectNode();
        node.put("id", id);
        node.put("name", name);
        node.put("lat", lat);
        node.put("lon", lon);
        node.put("tradeKey", tradeKey);
        return node;
    }
}
