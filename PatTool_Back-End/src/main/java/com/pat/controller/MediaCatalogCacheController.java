package com.pat.controller;

import com.pat.service.MediaCatalogCacheService;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Status + manual refresh for all media catalog caches (TV, EPG, radio, Archive.org).
 * Same full refresh as the 07:00 / 17:00 / 20:00 schedule.
 */
@RestController
@RequestMapping("/api/external/media/catalog-cache")
public class MediaCatalogCacheController {

    private final MediaCatalogCacheService mediaCatalogCacheService;

    public MediaCatalogCacheController(MediaCatalogCacheService mediaCatalogCacheService) {
        this.mediaCatalogCacheService = mediaCatalogCacheService;
    }

    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> status() {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(mediaCatalogCacheService.status());
    }

    @PostMapping("/refresh")
    public ResponseEntity<Map<String, Object>> refresh() {
        Map<String, Object> body = new LinkedHashMap<>();
        boolean started = mediaCatalogCacheService.startFullRefresh();
        if (!started) {
            body.put("accepted", false);
            body.put("busy", true);
            body.putAll(mediaCatalogCacheService.status());
            return ResponseEntity.status(HttpStatus.CONFLICT).body(body);
        }
        body.put("accepted", true);
        body.put("busy", true);
        body.putAll(mediaCatalogCacheService.status());
        return ResponseEntity.accepted().body(body);
    }
}
