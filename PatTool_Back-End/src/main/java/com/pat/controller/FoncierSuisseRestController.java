package com.pat.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.pat.service.FoncierImmoswipeProxyService;
import com.pat.service.FoncierItemCacheService;
import com.pat.service.FoncierItemCacheService.ListingQuery;
import com.pat.service.FoncierItemCacheService.Source;
import com.pat.service.FoncierSuisseGeoService;
import com.pat.service.news.NewsImageProxyService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Swiss property search via Immoswipe (ai.immoswipe.ch OpenAPI).
 */
@RestController
@RequestMapping("/api/external/foncier-suisse")
public class FoncierSuisseRestController {

    private final FoncierSuisseGeoService geoService;
    private final FoncierImmoswipeProxyService immoswipe;
    private final FoncierItemCacheService itemCache;
    private final NewsImageProxyService imageProxyService;

    public FoncierSuisseRestController(
            FoncierSuisseGeoService geoService,
            FoncierImmoswipeProxyService immoswipe,
            FoncierItemCacheService itemCache,
            NewsImageProxyService imageProxyService) {
        this.geoService = geoService;
        this.immoswipe = immoswipe;
        this.itemCache = itemCache;
        this.imageProxyService = imageProxyService;
    }

    @GetMapping("/image")
    public ResponseEntity<byte[]> proxyImage(@RequestParam("u") String imageUrl) {
        return imageProxyService.proxy(imageUrl);
    }

    @GetMapping("/places")
    public ResponseEntity<JsonNode> places(@RequestParam("q") String query) {
        return ResponseEntity.ok(geoService.searchPlaces(query));
    }

    @GetMapping("/geocode")
    public ResponseEntity<?> geocode(
            @RequestParam("q") String query,
            @RequestParam(required = false) String postcode) {
        var hit = geoService.geocode(query, postcode);
        if (hit == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not_found"));
        }
        return ResponseEntity.ok(hit);
    }

    @GetMapping("/cache")
    public ResponseEntity<?> cache() {
        return ResponseEntity.ok(itemCache.snapshot(FoncierItemCacheService.IMMOSWIPE));
    }

    @PostMapping("/cache/clear")
    public ResponseEntity<Map<String, Object>> cacheClear() {
        int cleared = itemCache.clear(FoncierItemCacheService.IMMOSWIPE);
        return ResponseEntity.ok(Map.of(
                "provider", FoncierItemCacheService.IMMOSWIPE,
                "cleared", cleared,
                "count", 0));
    }

    @GetMapping("/listings")
    public ResponseEntity<?> listings(
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String type,
            @RequestParam(required = false) Integer priceMin,
            @RequestParam(required = false) Integer priceMax,
            @RequestParam(required = false) Integer roomsMin,
            @RequestParam(required = false) Integer surfaceMin,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) String zip,
            @RequestParam(required = false) String locale,
            @RequestParam(required = false) String source) {
        ListingQuery query = listingQuery(q, type, priceMin, priceMax, surfaceMin, page, zip, source);
        if (query.source == Source.CACHE) {
            return ResponseEntity.ok(itemCache.listingsPage(FoncierItemCacheService.IMMOSWIPE, query));
        }
        try {
            JsonNode body = immoswipe.search(q, type, priceMin, priceMax, roomsMin, surfaceMin, page, locale);
            if (body == null) {
                return cacheOrUpstream(query.source, query);
            }
            itemCache.putItems(FoncierItemCacheService.IMMOSWIPE, body, null);
            return ResponseEntity.ok(itemCache.annotateApiPage(
                    FoncierItemCacheService.IMMOSWIPE, body, query.source));
        } catch (IllegalStateException ex) {
            return cacheOrUpstream(query.source, query);
        }
    }

    @GetMapping("/popular")
    public ResponseEntity<?> popular(
            @RequestParam(required = false) String locale,
            @RequestParam(required = false) String source) {
        Source src = Source.parse(source);
        ListingQuery query = new ListingQuery();
        query.source = src;
        query.page = 1;
        query.pageSize = 50;
        if (src == Source.CACHE) {
            return ResponseEntity.ok(itemCache.listingsPage(FoncierItemCacheService.IMMOSWIPE, query));
        }
        try {
            JsonNode body = immoswipe.popular(locale);
            if (body == null) {
                return cacheOrUpstream(src, query);
            }
            itemCache.putItems(FoncierItemCacheService.IMMOSWIPE, body, null);
            return ResponseEntity.ok(itemCache.annotateApiPage(FoncierItemCacheService.IMMOSWIPE, body, src));
        } catch (IllegalStateException ex) {
            return cacheOrUpstream(src, query);
        }
    }

    @GetMapping("/listings/{id}")
    public ResponseEntity<?> listing(
            @PathVariable String id,
            @RequestParam(required = false) String locale) {
        try {
            JsonNode body = immoswipe.listingDetail(id, locale);
            if (body == null) {
                return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not_found"));
            }
            return ResponseEntity.ok(body);
        } catch (IllegalStateException ex) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", "upstream_unavailable"));
        }
    }

    @GetMapping("/listings/{id}/similar")
    public ResponseEntity<?> similar(
            @PathVariable String id,
            @RequestParam(required = false) String locale) {
        try {
            JsonNode body = immoswipe.similar(id, locale);
            return ResponseEntity.ok(body == null ? Map.of("items", java.util.List.of()) : body);
        } catch (IllegalStateException ex) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", "upstream_unavailable"));
        }
    }

    @GetMapping("/chances")
    public ResponseEntity<?> chances(
            @RequestParam String location,
            @RequestParam String rooms,
            @RequestParam String budget,
            @RequestParam String household,
            @RequestParam String timeframe,
            @RequestParam(required = false) String income,
            @RequestParam(required = false) String workplace,
            @RequestParam(required = false) String locationType,
            @RequestParam(required = false) String locale) {
        try {
            return ResponseEntity.ok(immoswipe.chances(
                    location, rooms, budget, household, timeframe, income, workplace, locationType, locale));
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().body(Map.of("error", "missing_params"));
        } catch (IllegalStateException ex) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", "upstream_unavailable"));
        }
    }

    @GetMapping("/guides")
    public ResponseEntity<?> guides(
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String locale) {
        try {
            return ResponseEntity.ok(immoswipe.guides(q, locale));
        } catch (IllegalStateException ex) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", "upstream_unavailable"));
        }
    }

    @GetMapping("/guides/{slug}")
    public ResponseEntity<?> guide(
            @PathVariable String slug,
            @RequestParam(required = false) String locale) {
        try {
            JsonNode body = immoswipe.guide(slug, locale);
            if (body == null) {
                return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not_found"));
            }
            return ResponseEntity.ok(body);
        } catch (IllegalStateException ex) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", "upstream_unavailable"));
        }
    }

    @GetMapping("/faqs")
    public ResponseEntity<?> faqs(
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String role,
            @RequestParam(required = false) String locale) {
        try {
            return ResponseEntity.ok(immoswipe.faqs(q, role, locale));
        } catch (IllegalStateException ex) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", "upstream_unavailable"));
        }
    }

    private static ListingQuery listingQuery(
            String q,
            String type,
            Integer priceMin,
            Integer priceMax,
            Integer surfaceMin,
            Integer page,
            String zip,
            String source) {
        ListingQuery query = new ListingQuery();
        query.source = Source.parse(source);
        query.q = q;
        query.type = type;
        query.priceMin = priceMin;
        query.priceMax = priceMax;
        query.surfaceMin = surfaceMin;
        query.page = page == null || page < 1 ? 1 : page;
        query.pageSize = 20;
        query.city = q == null ? "" : q.trim();
        query.zip = zip == null ? "" : zip.trim();
        return query;
    }

    private ResponseEntity<?> cacheOrUpstream(Source source, ListingQuery query) {
        if (source == Source.BOTH || source == Source.CACHE) {
            JsonNode cached = itemCache.listingsPage(FoncierItemCacheService.IMMOSWIPE, query);
            if (cached != null && cached.path("items").isArray() && cached.path("items").size() > 0) {
                return ResponseEntity.ok(cached);
            }
        }
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", "upstream_unavailable"));
    }
}
