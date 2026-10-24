package com.pat.controller;

import com.pat.controller.dto.DeezerFavoriteItemDto;
import com.pat.controller.dto.DeezerFavoritesDto;
import com.pat.controller.dto.DeezerYoutubeLookupRequest;
import com.pat.service.DeezerCatalogService;
import com.pat.service.DeezerFavoritesService;
import com.pat.service.DeezerYoutubeLinkService;
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
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;

/**
 * Public Deezer catalog for the Deezer page. Previews are 30 seconds; there is no video.
 * <ul>
 *   <li>{@code GET /api/external/deezer/genres}</li>
 *   <li>{@code GET /api/external/deezer/chart?genre=0}</li>
 *   <li>{@code GET /api/external/deezer/search?q=&type=track}</li>
 *   <li>{@code GET /api/external/deezer/track/{id}}</li>
 *   <li>{@code GET /api/external/deezer/album/{id}}</li>
 *   <li>{@code GET /api/external/deezer/artist/{id}}</li>
 *   <li>{@code GET /api/external/deezer/artist/{id}/albums}</li>
 *   <li>{@code GET /api/external/deezer/playlist/{id}}</li>
 *   <li>{@code POST /api/external/deezer/youtube-links}</li>
 *   <li>{@code GET/PUT /api/external/deezer/favorites}</li>
 *   <li>{@code PUT/DELETE /api/external/deezer/favorites/item}</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/deezer")
public class DeezerRestController {

    private static final Set<String> SEARCH_TYPES = Set.of("track", "album", "artist", "playlist");

    private final DeezerCatalogService deezerCatalogService;
    private final DeezerYoutubeLinkService deezerYoutubeLinkService;
    private final DeezerFavoritesService deezerFavoritesService;

    public DeezerRestController(
            DeezerCatalogService deezerCatalogService,
            DeezerYoutubeLinkService deezerYoutubeLinkService,
            DeezerFavoritesService deezerFavoritesService) {
        this.deezerCatalogService = deezerCatalogService;
        this.deezerYoutubeLinkService = deezerYoutubeLinkService;
        this.deezerFavoritesService = deezerFavoritesService;
    }

    @GetMapping("/genres")
    public ResponseEntity<?> genres() {
        return ok(deezerCatalogService::genres, Duration.ofHours(6));
    }

    @GetMapping("/chart")
    public ResponseEntity<?> chart(@RequestParam(defaultValue = "0") long genre) {
        if (genre < 0 || genre > 1_000_000L) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid genre"));
        }
        return ok(() -> deezerCatalogService.chart(genre), Duration.ofMinutes(10));
    }

    @GetMapping("/search")
    public ResponseEntity<?> search(
            @RequestParam(defaultValue = "") String q,
            @RequestParam(defaultValue = "track") String type) {
        String query = q == null ? "" : q.trim();
        if (query.length() < 2 || query.length() > 120) {
            return ResponseEntity.badRequest().body(Map.of("error", "Query must be 2 to 120 characters"));
        }
        String kind = type == null ? "track" : type.trim().toLowerCase(Locale.ROOT);
        if (!SEARCH_TYPES.contains(kind)) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid type"));
        }
        return ok(() -> deezerCatalogService.search(query, kind), Duration.ofMinutes(2));
    }

    @GetMapping("/track/{id}")
    public ResponseEntity<?> track(
            @PathVariable long id,
            @RequestParam(defaultValue = "false") boolean fresh) {
        if (id <= 0) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid id"));
        }
        return ok(() -> deezerCatalogService.track(id, fresh), fresh ? Duration.ZERO : Duration.ofSeconds(60));
    }

    @GetMapping("/album/{id}")
    public ResponseEntity<?> album(@PathVariable long id) {
        if (id <= 0) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid id"));
        }
        return ok(() -> deezerCatalogService.album(id), Duration.ofMinutes(10));
    }

    @GetMapping("/artist/{id}/albums")
    public ResponseEntity<?> artistAlbums(@PathVariable long id) {
        if (id <= 0) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid id"));
        }
        return ok(() -> deezerCatalogService.artistAlbums(id), Duration.ofMinutes(10));
    }

    @GetMapping("/artist/{id}")
    public ResponseEntity<?> artist(@PathVariable long id) {
        if (id <= 0) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid id"));
        }
        return ok(() -> deezerCatalogService.artist(id), Duration.ofMinutes(10));
    }

    @GetMapping("/playlist/{id}")
    public ResponseEntity<?> playlist(@PathVariable long id) {
        if (id <= 0) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid id"));
        }
        return ok(() -> deezerCatalogService.playlist(id), Duration.ofMinutes(10));
    }

    @PostMapping("/youtube-links")
    public ResponseEntity<?> youtubeLinks(@RequestBody DeezerYoutubeLookupRequest body) {
        if (body == null || body.tracks() == null) {
            return ResponseEntity.badRequest().body(Map.of("error", "Missing tracks"));
        }
        if (body.tracks().size() > DeezerYoutubeLinkService.MAX_TRACKS) {
            return ResponseEntity.badRequest().body(Map.of("error", "Too many tracks"));
        }
        return ResponseEntity.ok(deezerYoutubeLinkService.resolve(body.tracks(), body.search()));
    }

    @GetMapping("/favorites")
    public ResponseEntity<DeezerFavoritesDto> getFavorites() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(deezerFavoritesService.findForSubject(sub));
    }

    @PutMapping("/favorites")
    public ResponseEntity<?> putFavorites(@RequestBody DeezerFavoritesDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.noStore())
                    .body(deezerFavoritesService.saveForSubject(sub, body));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @PutMapping("/favorites/item")
    public ResponseEntity<?> addFavorite(@RequestBody DeezerFavoriteItemDto item) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.noStore())
                    .body(deezerFavoritesService.addFavorite(sub, item));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @DeleteMapping("/favorites/item")
    public ResponseEntity<DeezerFavoritesDto> removeFavorite(
            @RequestParam("id") long id,
            @RequestParam("kind") String kind) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(deezerFavoritesService.removeFavorite(sub, id, kind));
    }

    private String currentJwtSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        String sub = jwt.getSubject();
        return StringUtils.hasText(sub) ? sub.trim() : null;
    }

    private ResponseEntity<?> ok(Supplier<?> call, Duration cache) {
        try {
            Object body = call.get();
            if (body == null) {
                return ResponseEntity.notFound().build();
            }
            ResponseEntity.BodyBuilder builder = ResponseEntity.ok();
            if (!cache.isZero() && !cache.isNegative()) {
                builder.cacheControl(CacheControl.maxAge(cache).cachePublic());
            } else {
                builder.cacheControl(CacheControl.noStore());
            }
            return builder.body(body);
        } catch (DeezerCatalogService.UpstreamException e) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", "Deezer indisponible"));
        }
    }
}
