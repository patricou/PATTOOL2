package com.pat.controller;

import com.pat.controller.dto.YoutubeSearchPageDto;
import com.pat.service.YoutubeProxyService;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * YouTube Data API v3 proxy (read-only search + popular videos).
 * {@code GET /api/external/youtube/search?q=ISS}
 * {@code GET /api/external/youtube/popular?regionCode=FR}
 */
@RestController
@RequestMapping("/api/external/youtube")
public class YoutubeRestController {

    private final YoutubeProxyService youtubeProxyService;

    public YoutubeRestController(YoutubeProxyService youtubeProxyService) {
        this.youtubeProxyService = youtubeProxyService;
    }

    @GetMapping(value = "/status", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> status() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("configured", youtubeProxyService.isConfigured());
        return body;
    }

    @GetMapping(value = "/search", produces = MediaType.APPLICATION_JSON_VALUE)
    public YoutubeSearchPageDto search(
            @RequestParam(value = "q", required = false) String query,
            @RequestParam(value = "type", required = false) String type,
            @RequestParam(value = "regionCode", required = false) String regionCode,
            @RequestParam(value = "relevanceLanguage", required = false) String relevanceLanguage,
            @RequestParam(value = "channelId", required = false) String channelId,
            @RequestParam(value = "pageToken", required = false) String pageToken,
            @RequestParam(value = "maxResults", required = false) Integer maxResults,
            @RequestParam(value = "order", required = false) String order) {
        return youtubeProxyService.search(
                query, type, regionCode, relevanceLanguage, channelId, pageToken, maxResults, order);
    }

    @GetMapping(value = "/popular", produces = MediaType.APPLICATION_JSON_VALUE)
    public YoutubeSearchPageDto popular(
            @RequestParam(value = "regionCode", required = false) String regionCode,
            @RequestParam(value = "pageToken", required = false) String pageToken,
            @RequestParam(value = "maxResults", required = false) Integer maxResults) {
        return youtubeProxyService.popular(regionCode, pageToken, maxResults);
    }

    /** Thumbnail proxy — {@code <img src>} never hits YouTube/Google CDNs. */
    @GetMapping("/image")
    public ResponseEntity<byte[]> thumbnail(@RequestParam("u") String imageUrl) {
        return youtubeProxyService.proxyThumbnail(imageUrl);
    }
}
