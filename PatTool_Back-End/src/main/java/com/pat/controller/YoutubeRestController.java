package com.pat.controller;

import com.pat.controller.dto.YoutubeFavoritesDto;
import com.pat.controller.dto.YoutubeItemDto;
import com.pat.controller.dto.YoutubeSearchPageDto;
import com.pat.service.YoutubeFavoritesService;
import com.pat.service.YoutubeProxyService;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * YouTube Data API v3 proxy (read-only search + popular videos) and per-user favorites.
 * {@code GET /api/external/youtube/search?q=ISS}
 * {@code GET /api/external/youtube/popular?regionCode=FR}
 */
@RestController
@RequestMapping("/api/external/youtube")
public class YoutubeRestController {

    private final YoutubeProxyService youtubeProxyService;
    private final YoutubeFavoritesService youtubeFavoritesService;

    public YoutubeRestController(
            YoutubeProxyService youtubeProxyService, YoutubeFavoritesService youtubeFavoritesService) {
        this.youtubeProxyService = youtubeProxyService;
        this.youtubeFavoritesService = youtubeFavoritesService;
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

    @GetMapping("/favorites")
    public ResponseEntity<YoutubeFavoritesDto> getFavorites() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(youtubeFavoritesService.findForSubject(sub));
    }

    @PutMapping("/favorites")
    public ResponseEntity<?> putFavorites(@RequestBody YoutubeFavoritesDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(youtubeFavoritesService.saveForSubject(sub, body));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @PutMapping("/favorites/item")
    public ResponseEntity<?> addFavorite(@RequestBody YoutubeItemDto item) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(youtubeFavoritesService.addFavorite(sub, item));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @DeleteMapping("/favorites/item")
    public ResponseEntity<YoutubeFavoritesDto> removeFavorite(
            @RequestParam("id") String id,
            @RequestParam(value = "kind", required = false) String kind) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(youtubeFavoritesService.removeFavorite(sub, id, kind));
    }

    private String currentJwtSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        String sub = jwt.getSubject();
        return StringUtils.hasText(sub) ? sub.trim() : null;
    }
}
