package com.pat.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.pat.service.FoncierCeremaProxyService;
import com.pat.service.FoncierChercherTrouverProxyService;
import com.pat.service.FoncierGeoService;
import com.pat.service.FoncierItemCacheService;
import com.pat.service.FoncierItemCacheService.ListingQuery;
import com.pat.service.FoncierItemCacheService.Source;
import com.pat.service.FoncierStreamEstateProxyService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * French land / listings proxies for the Foncier menu.
 */
@RestController
@RequestMapping("/api/external/foncier")
public class FoncierRestController {

    private final FoncierGeoService geoService;
    private final FoncierCeremaProxyService ceremaProxyService;
    private final FoncierStreamEstateProxyService streamEstateProxyService;
    private final FoncierChercherTrouverProxyService chercherTrouverProxyService;
    private final FoncierItemCacheService itemCache;

    public FoncierRestController(
            FoncierGeoService geoService,
            FoncierCeremaProxyService ceremaProxyService,
            FoncierStreamEstateProxyService streamEstateProxyService,
            FoncierChercherTrouverProxyService chercherTrouverProxyService,
            FoncierItemCacheService itemCache) {
        this.geoService = geoService;
        this.ceremaProxyService = ceremaProxyService;
        this.streamEstateProxyService = streamEstateProxyService;
        this.chercherTrouverProxyService = chercherTrouverProxyService;
        this.itemCache = itemCache;
    }

    @GetMapping("/communes")
    public ResponseEntity<JsonNode> communes(@RequestParam("q") String query) {
        return ResponseEntity.ok(geoService.searchCommunes(query));
    }

    @GetMapping("/geocode")
    public ResponseEntity<?> geocode(
            @RequestParam("q") String query,
            @RequestParam(required = false) String postcode) {
        var hit = geoService.geocodeBan(query, postcode);
        if (hit == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not_found"));
        }
        return ResponseEntity.ok(hit);
    }

    @GetMapping("/cache/places")
    public ResponseEntity<?> cachePlaces(
            @RequestParam String provider,
            @RequestParam(required = false) String q) {
        String key = normalizeProvider(provider);
        if (key.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid_provider"));
        }
        return ResponseEntity.ok(itemCache.places(key, q));
    }

    @GetMapping("/cache")
    public ResponseEntity<?> cacheStatus(@RequestParam String provider) {
        String key = normalizeProvider(provider);
        if (key.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid_provider"));
        }
        return ResponseEntity.ok(itemCache.snapshot(key));
    }

    @PostMapping("/cache/clear")
    public ResponseEntity<Map<String, Object>> cacheClear(@RequestParam String provider) {
        String key = normalizeProvider(provider);
        if (key.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid_provider"));
        }
        int cleared = itemCache.clear(key);
        return ResponseEntity.ok(Map.of("provider", key, "cleared", cleared, "count", 0));
    }

    @GetMapping("/cerema/mutations")
    public ResponseEntity<?> ceremaMutations(
            @RequestParam String codeInsee,
            @RequestParam(required = false) String typeLocal,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer pageSize,
            @RequestParam(required = false) Integer radiusKm,
            @RequestParam(required = false) String source) {
        if (!StringUtils.hasText(codeInsee)) {
            return ResponseEntity.badRequest().body(Map.of("error", "insee_required"));
        }
        ListingQuery query = mutationQuery(codeInsee, typeLocal, page, pageSize, radiusKm, source);
        if (query.source == Source.CACHE) {
            return ResponseEntity.ok(itemCache.mutationsPage(query));
        }
        try {
            JsonNode api = ceremaProxyService.mutations(codeInsee, typeLocal, page, pageSize, radiusKm);
            if (query.source == Source.API) {
                itemCache.putItems(FoncierItemCacheService.CEREMA, api, codeInsee);
                return ResponseEntity.ok(itemCache.annotateApiPage(FoncierItemCacheService.CEREMA, api, query.source));
            }
            return ResponseEntity.ok(itemCache.mergeMutations(query, api));
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid_insee"));
        } catch (IllegalStateException ex) {
            if ("upstream_unavailable".equals(ex.getMessage())) {
                return cacheOrUpstreamError(query.source, itemCache.mutationsPage(query));
            }
            throw ex;
        } catch (Exception ex) {
            return cacheOrUpstreamError(query.source, itemCache.mutationsPage(query));
        }
    }

    @GetMapping("/stream-estate/status")
    public ResponseEntity<Map<String, Object>> streamEstateStatus() {
        return ResponseEntity.ok(Map.of(
                "configured", streamEstateProxyService.isConfigured(),
                "cacheCount", itemCache.size(FoncierItemCacheService.STREAM_ESTATE)));
    }

    @GetMapping("/stream-estate/listings")
    public ResponseEntity<?> streamEstateListings(
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String type,
            @RequestParam(required = false) Integer priceMin,
            @RequestParam(required = false) Integer priceMax,
            @RequestParam(required = false) Integer surfaceMin,
            @RequestParam(required = false) Integer surfaceMax,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) String codeInsee,
            @RequestParam(required = false) Integer radiusKm,
            @RequestParam(required = false) Double lat,
            @RequestParam(required = false) Double lon,
            @RequestParam(required = false) String source) {
        return listings(
                FoncierItemCacheService.STREAM_ESTATE,
                streamEstateProxyService::listings,
                q, type, priceMin, priceMax, surfaceMin, surfaceMax, page, codeInsee, radiusKm, lat, lon, source);
    }

    @GetMapping("/chercher-trouver/status")
    public ResponseEntity<Map<String, Object>> chercherTrouverStatus() {
        return ResponseEntity.ok(Map.of(
                "configured", chercherTrouverProxyService.isConfigured(),
                "cacheCount", itemCache.size(FoncierItemCacheService.CHERCHER_TROUVER)));
    }

    @GetMapping("/chercher-trouver/listings")
    public ResponseEntity<?> chercherTrouverListings(
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String type,
            @RequestParam(required = false) Integer priceMin,
            @RequestParam(required = false) Integer priceMax,
            @RequestParam(required = false) Integer surfaceMin,
            @RequestParam(required = false) Integer surfaceMax,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) String codeInsee,
            @RequestParam(required = false) Integer radiusKm,
            @RequestParam(required = false) Double lat,
            @RequestParam(required = false) Double lon,
            @RequestParam(required = false) String source) {
        return listings(
                FoncierItemCacheService.CHERCHER_TROUVER,
                chercherTrouverProxyService::listings,
                q, type, priceMin, priceMax, surfaceMin, surfaceMax, page, codeInsee, radiusKm, lat, lon, source);
    }

    private ResponseEntity<?> listings(
            String provider,
            ListingFn fn,
            String q,
            String type,
            Integer priceMin,
            Integer priceMax,
            Integer surfaceMin,
            Integer surfaceMax,
            Integer page,
            String codeInsee,
            Integer radiusKm,
            Double lat,
            Double lon,
            String source) {
        ListingQuery query = listingQuery(
                q, type, priceMin, priceMax, surfaceMin, surfaceMax, page, codeInsee, radiusKm, lat, lon, source);
        if (query.source == Source.CACHE) {
            return ResponseEntity.ok(itemCache.listingsPage(provider, query));
        }
        try {
            JsonNode body = fn.search(q, type, priceMin, priceMax, surfaceMin, surfaceMax, page, codeInsee, radiusKm);
            if (body == null) {
                return cacheOrUpstreamError(query.source, itemCache.listingsPage(provider, query));
            }
            if (query.source == Source.API) {
                itemCache.putItems(provider, body, codeInsee);
                return ResponseEntity.ok(itemCache.annotateApiPage(provider, body, query.source));
            }
            return ResponseEntity.ok(itemCache.mergeListings(provider, query, body));
        } catch (IllegalStateException ex) {
            String code = ex.getMessage();
            if ("upstream_unavailable".equals(code)) {
                return cacheOrUpstreamError(query.source, itemCache.listingsPage(provider, query));
            }
            if (query.source == Source.BOTH) {
                return ResponseEntity.ok(itemCache.listingsPage(provider, query));
            }
            if ("invalid_key".equals(code)) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", "invalid_key"));
            }
            if ("insufficient_credits".equals(code)) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of(
                        "error", "insufficient_credits",
                        "billingUrl", "https://stream.estate/console/billing"));
            }
            if ("forbidden".equals(code)) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", "forbidden"));
            }
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of("error", "not_configured"));
        }
    }

    private static ListingQuery listingQuery(
            String q,
            String type,
            Integer priceMin,
            Integer priceMax,
            Integer surfaceMin,
            Integer surfaceMax,
            Integer page,
            String codeInsee,
            Integer radiusKm,
            Double lat,
            Double lon,
            String source) {
        ListingQuery query = new ListingQuery();
        query.source = Source.parse(source);
        query.q = q;
        query.type = type;
        query.priceMin = priceMin;
        query.priceMax = priceMax;
        query.surfaceMin = surfaceMin;
        query.surfaceMax = surfaceMax;
        query.page = page == null || page < 1 ? 1 : page;
        query.pageSize = 20;
        query.codeInsee = codeInsee;
        String trimmed = q == null ? "" : q.trim();
        if (trimmed.matches("\\d{5}")) {
            query.zip = trimmed;
        } else {
            query.city = trimmed;
        }
        query.radiusKm = FoncierGeoService.clampRadiusKm(radiusKm);
        if (lat != null && lon != null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
            query.lat = lat;
            query.lon = lon;
        }
        return query;
    }

    private static ListingQuery mutationQuery(
            String codeInsee,
            String typeLocal,
            Integer page,
            Integer pageSize,
            Integer radiusKm,
            String source) {
        ListingQuery query = new ListingQuery();
        query.source = Source.parse(source);
        query.codeInsee = codeInsee;
        query.type = typeLocal;
        query.page = page == null || page < 1 ? 1 : page;
        query.pageSize = pageSize == null ? 40 : pageSize;
        query.radiusKm = FoncierGeoService.clampRadiusKm(radiusKm);
        return query;
    }

    private static ResponseEntity<?> cacheOrUpstreamError(Source source, JsonNode cached) {
        if (source == Source.BOTH && cached != null && cached.path("items").isArray() && cached.path("items").size() > 0) {
            return ResponseEntity.ok(cached);
        }
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", "upstream_unavailable"));
    }

    private static String normalizeProvider(String provider) {
        if (!StringUtils.hasText(provider)) {
            return "";
        }
        String key = provider.trim().toLowerCase();
        if (FoncierItemCacheService.CEREMA.equals(key)
                || FoncierItemCacheService.STREAM_ESTATE.equals(key)
                || FoncierItemCacheService.CHERCHER_TROUVER.equals(key)) {
            return key;
        }
        return "";
    }

    @FunctionalInterface
    private interface ListingFn {
        JsonNode search(
                String q,
                String type,
                Integer priceMin,
                Integer priceMax,
                Integer surfaceMin,
                Integer surfaceMax,
                Integer page,
                String codeInsee,
                Integer radiusKm);
    }
}
