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
 * {@code GET /api/external/wiki/search?q=Sirius&lang=fr}
 * {@code GET /api/external/wiki/summary?title=Sirius&lang=fr}
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
}
