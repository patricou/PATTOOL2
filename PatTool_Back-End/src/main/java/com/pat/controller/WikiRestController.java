package com.pat.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.pat.service.WikiProxyService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Wikipedia search and page summary proxy (read-only).
 * {@code GET /api/external/wiki/search?q=Sirius&lang=es}
 * {@code GET /api/external/wiki/summary?title=Sirius&lang=es}
 * Summary {@code lang} follows the UI language when that Wikipedia edition
 * exists; otherwise the proxy returns the article in the source language.
 */
@RestController
@RequestMapping("/api/external/wiki")
public class WikiRestController {

    private final WikiProxyService wikiProxyService;

    public WikiRestController(WikiProxyService wikiProxyService) {
        this.wikiProxyService = wikiProxyService;
    }

    @GetMapping("/search")
    public ResponseEntity<JsonNode> search(
            @RequestParam("q") String query,
            @RequestParam(value = "lang", required = false) String lang,
            @RequestParam(value = "limit", required = false) Integer limit) {
        return ResponseEntity.ok(wikiProxyService.search(query, lang, limit));
    }

    @GetMapping("/summary")
    public ResponseEntity<JsonNode> summary(
            @RequestParam("title") String title,
            @RequestParam(value = "lang", required = false) String lang) {
        return ResponseEntity.ok(wikiProxyService.fetchSummary(title, lang));
    }

    /**
     * Photo of a map attraction (camera icon). Wikidata and Wikipedia first,
     * then the OpenStreetMap object at the clicked point, then a geotagged
     * Commons file whose name matches the place.
     * {@code GET /api/external/wiki/poi-photo?id=Q243&name=Tour%20Eiffel&lat=48.858&lng=2.294&lang=fr}
     */
    @GetMapping("/poi-photo")
    public ResponseEntity<JsonNode> poiPhoto(
            @RequestParam(value = "id", required = false) String id,
            @RequestParam(value = "name", required = false) String name,
            @RequestParam(value = "nameEn", required = false) String nameEn,
            @RequestParam(value = "lat", required = false) Double lat,
            @RequestParam(value = "lng", required = false) Double lng,
            @RequestParam(value = "wikipedia", required = false) String wikipedia,
            @RequestParam(value = "commons", required = false) String commons,
            @RequestParam(value = "image", required = false) String image,
            @RequestParam(value = "source", required = false) String source,
            @RequestParam(value = "lang", required = false) String lang,
            @RequestParam(value = "radius", required = false) Double radius) {
        return ResponseEntity.ok(wikiProxyService.fetchPoiPhoto(
                id, name, nameEn, lat, lng, wikipedia, commons, image, source, lang, radius));
    }

    /** Mapillary thumbnail bytes for the 360° viewer. The CDN image is not readable from the page. */
    @GetMapping("/image")
    public ResponseEntity<byte[]> image(@RequestParam("url") String url) {
        return wikiProxyService.fetchPublicImage(url);
    }
}
