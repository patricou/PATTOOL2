package com.pat.controller;

import com.pat.controller.dto.TmdbDetailDto;
import com.pat.controller.dto.TmdbGenresDto;
import com.pat.controller.dto.TmdbPageDto;
import com.pat.service.TmdbProxyService;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * TMDB v3 proxy for the Media page (trending, search, discover, detail).
 * {@code GET /api/external/tmdb/trending?media=all&window=week}
 * {@code GET /api/external/tmdb/search?q=Dune&media=movie}
 * {@code GET /api/external/tmdb/discover?media=movie&genre=28}
 * {@code GET /api/external/tmdb/detail?media=movie&id=603}
 */
@RestController
@RequestMapping("/api/external/tmdb")
public class TmdbRestController {

    private final TmdbProxyService tmdbProxyService;

    public TmdbRestController(TmdbProxyService tmdbProxyService) {
        this.tmdbProxyService = tmdbProxyService;
    }

    @GetMapping(value = "/status", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> status() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("configured", tmdbProxyService.isConfigured());
        return body;
    }

    @GetMapping(value = "/trending", produces = MediaType.APPLICATION_JSON_VALUE)
    public TmdbPageDto trending(
            @RequestParam(value = "media", required = false) String media,
            @RequestParam(value = "window", required = false) String window,
            @RequestParam(value = "lang", required = false) String lang,
            @RequestParam(value = "page", required = false) Integer page) {
        return tmdbProxyService.trending(media, window, lang, page);
    }

    @GetMapping(value = "/search", produces = MediaType.APPLICATION_JSON_VALUE)
    public TmdbPageDto search(
            @RequestParam(value = "q", required = false) String query,
            @RequestParam(value = "media", required = false) String media,
            @RequestParam(value = "lang", required = false) String lang,
            @RequestParam(value = "page", required = false) Integer page) {
        String kind = "all".equals(media) ? "multi" : media;
        return tmdbProxyService.search(query, kind, lang, page);
    }

    @GetMapping(value = "/discover", produces = MediaType.APPLICATION_JSON_VALUE)
    public TmdbPageDto discover(
            @RequestParam(value = "media", required = false) String media,
            @RequestParam(value = "genre", required = false) Integer genre,
            @RequestParam(value = "year", required = false) Integer year,
            @RequestParam(value = "sort", required = false) String sort,
            @RequestParam(value = "lang", required = false) String lang,
            @RequestParam(value = "page", required = false) Integer page) {
        return tmdbProxyService.discover(media, genre, year, sort, lang, page);
    }

    @GetMapping(value = "/genres", produces = MediaType.APPLICATION_JSON_VALUE)
    public TmdbGenresDto genres(
            @RequestParam(value = "media", required = false) String media,
            @RequestParam(value = "lang", required = false) String lang) {
        return tmdbProxyService.genres(media, lang);
    }

    @GetMapping(value = "/detail", produces = MediaType.APPLICATION_JSON_VALUE)
    public TmdbDetailDto detail(
            @RequestParam(value = "media") String media,
            @RequestParam(value = "id") long id,
            @RequestParam(value = "lang", required = false) String lang) {
        return tmdbProxyService.detail(media, id, lang);
    }
}
