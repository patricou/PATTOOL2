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
import static org.junit.jupiter.api.Assertions.assertFalse;
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
    void cacheMapItemsCoverAllMatchesNotJustCurrentPage() {
        cache.putItems("sirene", pageWith(
                item("near", "Près", 48.8566, 2.3522, "baker"),
                item("mid", "Milieu", 48.86, 2.36, "baker"),
                item("far", "Loin-mais-dedans", 48.90, 2.40, "baker")));

        ArtisansItemCacheService.NearbyQuery query = query(48.8566, 2.3522, 10, "baker");
        query.perPage = 1;
        ObjectNode page = cache.page(query);
        assertEquals(3, page.path("total").asInt());
        assertEquals(1, page.path("items").size());
        assertEquals("near", page.path("items").get(0).path("id").asText());
        assertEquals(3, page.path("mapItems").size());
        String ids = page.path("mapItems").toString();
        assertTrue(ids.contains("near"));
        assertTrue(ids.contains("mid"));
        assertTrue(ids.contains("far"));
    }

    @Test
    void cachePageCanFilterByNafCode() {
        ObjectNode lawyer = item("law", "Cabinet", 48.8566, 2.3522, "");
        lawyer.put("activityCode", "69.10Z");
        cache.putItems("sirene", pageWith(
                item("bakery", "Pain", 48.8566, 2.3522, "baker"),
                lawyer));

        ArtisansItemCacheService.NearbyQuery query = query(48.8566, 2.3522, 10, "naf:69.10Z");
        ObjectNode page = cache.page(query);
        assertEquals(1, page.path("total").asInt());
        assertEquals("law", page.path("items").get(0).path("id").asText());
    }

    @Test
    void cachePageFiltersCityOnFullMatchNotCurrentPage() {
        ObjectNode gexNear = item("gex-near", "Près Gex", 48.8566, 2.3522, "baker");
        gexNear.put("city", "Gex");
        ObjectNode thoiry = item("thoiry", "Thoiry", 48.86, 2.36, "baker");
        thoiry.put("city", "Thoiry");
        ObjectNode gexFar = item("gex-far", "Loin Gex", 48.90, 2.40, "baker");
        gexFar.put("city", "Gex");
        cache.putItems("sirene", pageWith(gexNear, thoiry, gexFar));

        ArtisansItemCacheService.NearbyQuery all = query(48.8566, 2.3522, 10, "baker");
        all.perPage = 1;
        ObjectNode unfiltered = cache.page(all);
        assertEquals(3, unfiltered.path("total").asInt());
        assertEquals(2, unfiltered.path("cities").size());

        ArtisansItemCacheService.NearbyQuery gex = query(48.8566, 2.3522, 10, "baker");
        gex.perPage = 1;
        gex.city = "Gex";
        ObjectNode page = cache.page(gex);
        assertEquals(2, page.path("total").asInt());
        assertEquals(1, page.path("items").size());
        assertEquals("gex-near", page.path("items").get(0).path("id").asText());
        assertEquals(2, page.path("mapItems").size());
        assertEquals(2, page.path("cities").size());
        String cities = page.path("cities").toString();
        assertTrue(cities.contains("Gex"));
        assertTrue(cities.contains("Thoiry"));
    }

    @Test
    void cachePageHidesClosedWhenIncludeClosedFalse() {
        ObjectNode open = item("open", "Ouvert", 48.8566, 2.3522, "baker");
        open.put("openingHours", "24/7");
        ObjectNode shut = item("shut", "Fermé", 48.86, 2.36, "baker");
        shut.put("openingHours", "closed");
        cache.putItems("osm", pageWith(open, shut));

        ArtisansItemCacheService.NearbyQuery shown = query(48.8566, 2.3522, 10, "baker");
        shown.source = "osm";
        ObjectNode withClosed = cache.page(shown);
        assertEquals(2, withClosed.path("total").asInt());
        assertTrue(withClosed.path("mapItems").toString().contains("shut"));

        ArtisansItemCacheService.NearbyQuery hidden = query(48.8566, 2.3522, 10, "baker");
        hidden.source = "osm";
        hidden.includeClosed = false;
        ObjectNode openOnly = cache.page(hidden);
        assertEquals(1, openOnly.path("total").asInt());
        assertEquals("open", openOnly.path("items").get(0).path("id").asText());
        assertEquals(1, openOnly.path("mapItems").size());
        assertFalse(openOnly.path("items").get(0).path("closed").asBoolean(true));
    }

    @Test
    void cachePageSortsFullMatchBeforePaging() {
        cache.putItems("sirene", pageWith(
                item("near", "Zulu", 48.8566, 2.3522, "baker"),
                item("mid", "Alpha", 48.86, 2.36, "baker"),
                item("far", "Mike", 48.90, 2.40, "baker")));

        ArtisansItemCacheService.NearbyQuery closest = query(48.8566, 2.3522, 10, "baker");
        closest.perPage = 1;
        ObjectNode byDistance = cache.page(closest);
        assertEquals("near", byDistance.path("items").get(0).path("id").asText());

        ArtisansItemCacheService.NearbyQuery byName = query(48.8566, 2.3522, 10, "baker");
        byName.perPage = 1;
        byName.sort = "name-asc";
        ObjectNode named = cache.page(byName);
        assertEquals(3, named.path("total").asInt());
        assertEquals("mid", named.path("items").get(0).path("id").asText());

        ArtisansItemCacheService.NearbyQuery farthest = query(48.8566, 2.3522, 10, "baker");
        farthest.perPage = 1;
        farthest.sort = "distance-desc";
        assertEquals("far", cache.page(farthest).path("items").get(0).path("id").asText());
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
    void putItemsWithoutPersistStillUpdatesMemory() {
        long gen = cache.generation();
        cache.putItems("sirene", pageWith(item("1", "A", 48.85, 2.35, "baker")), gen, false);
        assertEquals(1, cache.size("sirene"));
        cache.flush();
        assertEquals(1, cache.size("sirene"));
    }

    @Test
    void itemsWithoutCoordsMatchOnlyWhenSwitchIsOn() {
        cache.putItems("sirene", pageWith(
                item("geo", "Avec GPS", 48.8566, 2.3522, "baker"),
                itemNoGeo("nogeo", "Sans GPS", "baker", 48.8566, 2.3522, 10)));

        ArtisansItemCacheService.NearbyQuery hidden = query(48.8566, 2.3522, 10, "baker");
        assertEquals(1, cache.page(hidden).path("total").asInt());
        assertEquals("geo", cache.page(hidden).path("items").get(0).path("id").asText());

        ArtisansItemCacheService.NearbyQuery shown = query(48.8566, 2.3522, 10, "baker");
        shown.includeWithoutCoords = true;
        assertEquals(2, cache.page(shown).path("total").asInt());

        ArtisansItemCacheService.NearbyQuery elsewhere = query(45.75, 4.85, 10, "baker");
        elsewhere.includeWithoutCoords = true;
        assertEquals(0, cache.page(elsewhere).path("total").asInt());

        ArtisansItemCacheService.NearbyQuery smaller = query(48.8566, 2.3522, 5, "baker");
        smaller.includeWithoutCoords = true;
        assertEquals(1, cache.page(smaller).path("total").asInt());
        assertEquals("geo", cache.page(smaller).path("items").get(0).path("id").asText());
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

    private ObjectNode itemNoGeo(
            String id, String name, String tradeKey, double originLat, double originLon, double radiusKm) {
        ObjectNode node = new ObjectMapper().createObjectNode();
        node.put("id", id);
        node.put("name", name);
        node.put("tradeKey", tradeKey);
        node.put("cacheOriginLat", originLat);
        node.put("cacheOriginLon", originLon);
        node.put("cacheOriginRadiusKm", radiusKm);
        return node;
    }
}
