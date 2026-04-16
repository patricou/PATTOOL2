package com.pat.controller;

import com.pat.service.news.NewsImageProxyService;
import com.pat.service.news.NewsProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * REST controller exposing news-retrieval endpoints to the Angular frontend.
 *
 * Mirrors the style of {@link com.pat.controller.ApiController}: thin pass-through
 * around a service, consistent {@code /api/external/...} prefix, JSON-only.
 */
@RestController
@RequestMapping("/api/external/news")
public class NewsApiController {

    private static final Logger log = LoggerFactory.getLogger(NewsApiController.class);

    @Autowired
    private NewsProvider newsProvider;

    @Autowired
    private NewsImageProxyService imageProxyService;

    /**
     * Top headlines from NewsAPI. At least one of country/category/q should be provided;
     * otherwise the service defaults to country=us to avoid a 400 from NewsAPI.
     */
    @GetMapping(value = "/top-headlines", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getTopHeadlines(
            @RequestParam(value = "country", required = false) String country,
            @RequestParam(value = "category", required = false) String category,
            @RequestParam(value = "q", required = false) String query,
            @RequestParam(value = "pageSize", required = false) Integer pageSize,
            @RequestParam(value = "page", required = false) Integer page) {
        log.debug("News /top-headlines country={} category={} q={} pageSize={} page={}",
                country, category, query, pageSize, page);
        return newsProvider.getTopHeadlines(country, category, query, pageSize, page);
    }

    /** Full-text article search. {@code q} is required by the provider. */
    @GetMapping(value = "/everything", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getEverything(
            @RequestParam("q") String query,
            @RequestParam(value = "language", required = false) String language,
            @RequestParam(value = "from", required = false) String from,
            @RequestParam(value = "to", required = false) String to,
            @RequestParam(value = "sortBy", required = false) String sortBy,
            @RequestParam(value = "pageSize", required = false) Integer pageSize,
            @RequestParam(value = "page", required = false) Integer page) {
        log.debug("News /everything q={} language={} from={} to={} sortBy={} pageSize={} page={}",
                query, language, from, to, sortBy, pageSize, page);
        return newsProvider.getEverything(query, language, from, to, sortBy, pageSize, page);
    }

    /** List of available sources filtered by country / category / language. */
    @GetMapping(value = "/sources", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getSources(
            @RequestParam(value = "country", required = false) String country,
            @RequestParam(value = "category", required = false) String category,
            @RequestParam(value = "language", required = false) String language) {
        log.debug("News /sources country={} category={} language={}", country, category, language);
        return newsProvider.getSources(country, category, language);
    }

    /** Health-check endpoint used by the frontend status panel. */
    @GetMapping(value = "/status", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getStatus() {
        log.debug("News /status");
        return newsProvider.getStatus();
    }

    /**
     * Image proxy used by the News page. Takes the original article image URL
     * as {@code u} and streams the image bytes back, upgrading {@code http://}
     * to {@code https://} when possible and bypassing {@code Referer}-based
     * hotlink blocks. Endpoint is public (no {@code Authorization} header on
     * {@code <img src>}), but {@link NewsImageProxyService} enforces SSRF,
     * size and content-type guards.
     */
    @GetMapping(value = "/image")
    public ResponseEntity<byte[]> proxyImage(@RequestParam("u") String imageUrl) {
        return imageProxyService.proxy(imageUrl);
    }
}
