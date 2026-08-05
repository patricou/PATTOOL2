package com.pat.controller;

import com.pat.controller.dto.ArchiveAudioPlaylistDto;
import com.pat.controller.dto.ArchiveItemDetailDto;
import com.pat.controller.dto.ArchiveItemDto;
import com.pat.controller.dto.ArchiveRecentDto;
import com.pat.controller.dto.ArchiveSearchPageDto;
import com.pat.service.ArchiveAudioPlaylistService;
import com.pat.service.ArchiveRecentService;
import com.pat.service.InternetArchiveCatalogService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * Internet Archive explorer: search all mediatypes, item metadata/files,
 * playable resolve, Wayback Machine availability / CDX, and per-user recent.
 * <p>
 * Public read-only:
 * <ul>
 *   <li>{@code GET /api/external/archive/mediatypes}</li>
 *   <li>{@code GET /api/external/archive/sorts}</li>
 *   <li>{@code GET /api/external/archive/sections?mediatype=movies}</li>
 *   <li>{@code GET /api/external/archive/search?mediatype=&amp;section=&amp;q=&amp;page=}</li>
 *   <li>{@code GET /api/external/archive/catalog-cache/status}</li>
 *   <li>{@code POST /api/external/archive/catalog-cache/refresh}</li>
 *   <li>{@code GET /api/external/archive/item/{identifier}}</li>
 *   <li>{@code GET /api/external/archive/resolve/{identifier}}</li>
 *   <li>{@code GET /api/external/archive/wayback/available?url=}</li>
 *   <li>{@code GET /api/external/archive/wayback/cdx?url=&amp;limit=}</li>
 * </ul>
 * Authenticated (JWT):
 * <ul>
 *   <li>{@code GET/PUT /api/external/archive/recent} — last 10 selections</li>
 *   <li>{@code PUT /api/external/archive/recent/item} — touch one item (MRU)</li>
 *   <li>{@code DELETE /api/external/archive/recent/item?identifier=}</li>
 *   <li>{@code GET/PUT /api/external/archive/audio-playlist} — audio playlist</li>
 *   <li>{@code PUT /api/external/archive/audio-playlist/item} — add one audio item</li>
 *   <li>{@code DELETE /api/external/archive/audio-playlist/item?identifier=}</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/archive")
public class ArchiveWatcherRestController {

    @Autowired
    private InternetArchiveCatalogService internetArchiveCatalogService;

    @Autowired
    private ArchiveRecentService archiveRecentService;

    @Autowired
    private ArchiveAudioPlaylistService archiveAudioPlaylistService;

    @GetMapping("/mediatypes")
    public ResponseEntity<Map<String, Object>> mediatypes() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("mediatypes", internetArchiveCatalogService.mediatypes());
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofHours(12)).cachePublic())
                .body(body);
    }

    @GetMapping("/sorts")
    public ResponseEntity<Map<String, Object>> sorts() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sorts", internetArchiveCatalogService.sorts());
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofHours(12)).cachePublic())
                .body(body);
    }

    @GetMapping("/sections")
    public ResponseEntity<Map<String, Object>> sections(
            @RequestParam(value = "mediatype", defaultValue = "all") String mediatype) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("mediatype", internetArchiveCatalogService.normalizeMediatype(mediatype));
        body.put("sections", internetArchiveCatalogService.sections(mediatype));
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofHours(6)).cachePublic())
                .body(body);
    }

    @GetMapping("/search")
    public ResponseEntity<ArchiveSearchPageDto> search(
            @RequestParam(value = "mediatype", defaultValue = "all") String mediatype,
            @RequestParam(value = "section", required = false) String section,
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "creator", required = false) String creator,
            @RequestParam(value = "language", required = false) String language,
            @RequestParam(value = "sort", required = false) String sort,
            @RequestParam(value = "page", defaultValue = "1") int page) {
        ArchiveSearchPageDto result = internetArchiveCatalogService.search(
                mediatype, section, q, creator, language, sort, page);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(2)).cachePrivate().mustRevalidate())
                .header("Vary", "Accept-Encoding")
                .body(result);
    }

    @GetMapping("/catalog-cache/status")
    public ResponseEntity<Map<String, Object>> catalogCacheStatus() {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(internetArchiveCatalogService.catalogCacheStatus());
    }

    @PostMapping("/catalog-cache/refresh")
    public ResponseEntity<Map<String, Object>> catalogCacheRefresh(
            @RequestParam(value = "force", defaultValue = "true") boolean force) {
        Map<String, Object> body = new LinkedHashMap<>();
        boolean started = internetArchiveCatalogService.startCatalogRefresh(force);
        if (!started) {
            body.put("accepted", false);
            body.put("busy", true);
            body.putAll(internetArchiveCatalogService.catalogCacheStatus());
            return ResponseEntity.status(HttpStatus.CONFLICT).body(body);
        }
        body.put("accepted", true);
        body.put("busy", true);
        body.putAll(internetArchiveCatalogService.catalogCacheStatus());
        return ResponseEntity.accepted().body(body);
    }

    @GetMapping("/item/{identifier}")
    public ResponseEntity<?> item(@PathVariable("identifier") String identifier) {
        if (!internetArchiveCatalogService.isValidIdentifier(identifier)) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid_ia_identifier"));
        }
        Optional<ArchiveItemDetailDto> item = internetArchiveCatalogService.getItem(identifier);
        if (item.isEmpty()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not_found"));
        }
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(15)).cachePublic())
                .body(item.get());
    }

    @GetMapping("/resolve/{identifier}")
    public ResponseEntity<?> resolve(
            @PathVariable("identifier") String identifier,
            @RequestParam(value = "fresh", defaultValue = "false") boolean fresh) {
        if (!internetArchiveCatalogService.isValidIdentifier(identifier)) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid_ia_identifier"));
        }
        Optional<Map<String, Object>> resolved =
                internetArchiveCatalogService.resolvePlayable(identifier, fresh);
        if (resolved.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of(
                    "error", "ia_resolve_failed",
                    "message", "Aucun média jouable trouvé pour cet item Archive.org"
            ));
        }
        return ResponseEntity.ok(resolved.get());
    }

    @GetMapping("/wayback/available")
    public ResponseEntity<Map<String, Object>> waybackAvailable(
            @RequestParam("url") String url) {
        if (!StringUtils.hasText(url)) {
            return ResponseEntity.badRequest().body(Map.of("error", "empty_url"));
        }
        Map<String, Object> body = internetArchiveCatalogService.waybackAvailable(url);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(10)).cachePublic())
                .body(body);
    }

    @GetMapping("/wayback/cdx")
    public ResponseEntity<Map<String, Object>> waybackCdx(
            @RequestParam("url") String url,
            @RequestParam(value = "limit", defaultValue = "20") int limit) {
        if (!StringUtils.hasText(url)) {
            return ResponseEntity.badRequest().body(Map.of("error", "empty_url"));
        }
        Map<String, Object> body = internetArchiveCatalogService.waybackCdx(url, limit);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(10)).cachePublic())
                .body(body);
    }

    @GetMapping("/recent")
    public ResponseEntity<ArchiveRecentDto> getRecent() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(archiveRecentService.findForSubject(sub));
    }

    @PutMapping("/recent")
    public ResponseEntity<?> putRecent(@RequestBody ArchiveRecentDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(archiveRecentService.saveForSubject(sub, body));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    /** Add/move one item to the front of the current user's last-10 list. */
    @PutMapping("/recent/item")
    public ResponseEntity<?> touchRecent(@RequestBody ArchiveItemDto item) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(archiveRecentService.touchRecent(sub, item));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    /** Remove one item from recent by Archive.org identifier. */
    @DeleteMapping("/recent/item")
    public ResponseEntity<ArchiveRecentDto> removeRecent(@RequestParam("identifier") String identifier) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(archiveRecentService.removeRecent(sub, identifier));
    }

    @GetMapping("/audio-playlist")
    public ResponseEntity<ArchiveAudioPlaylistDto> getAudioPlaylist() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(archiveAudioPlaylistService.findForSubject(sub));
    }

    @PutMapping("/audio-playlist")
    public ResponseEntity<?> putAudioPlaylist(@RequestBody ArchiveAudioPlaylistDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(archiveAudioPlaylistService.saveForSubject(sub, body));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    /** Add one audio/etree item to the playlist (append, dedupe). */
    @PutMapping("/audio-playlist/item")
    public ResponseEntity<?> addAudioPlaylistItem(@RequestBody ArchiveItemDto item) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok(archiveAudioPlaylistService.addItem(sub, item));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    /** Remove one item from the audio playlist by identifier. */
    @DeleteMapping("/audio-playlist/item")
    public ResponseEntity<ArchiveAudioPlaylistDto> removeAudioPlaylistItem(
            @RequestParam("identifier") String identifier) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(archiveAudioPlaylistService.removeItem(sub, identifier));
    }

    private static String currentJwtSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        return jwt.getSubject();
    }
}
