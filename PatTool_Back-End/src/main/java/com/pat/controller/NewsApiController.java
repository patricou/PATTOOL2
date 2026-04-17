package com.pat.controller;

import com.pat.service.news.NewsImageProxyService;
import com.pat.service.news.NewsProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * REST controller exposing news-retrieval endpoints to the Angular frontend.
 *
 * Two providers are wired in:
 *  - {@code newsDataService}  → https://newsdata.io  (default, no 24h delay)
 *  - {@code newsApiService}   → https://newsapi.org  (fallback, 100 req/day)
 *
 * The active provider is chosen per-request via the {@code ?provider=...}
 * query parameter. Values: {@code newsdata} (default) or {@code newsapi}.
 * The frontend persists the selection in localStorage so users keep the
 * provider they picked across page reloads.
 */
@RestController
@RequestMapping("/api/external/news")
public class NewsApiController {

    private static final Logger log = LoggerFactory.getLogger(NewsApiController.class);

    /** Default provider when the request omits {@code ?provider=...}. */
    private static final String DEFAULT_PROVIDER = "newsdata";

    @Autowired
    @Qualifier("newsDataService")
    private NewsProvider newsDataService;

    @Autowired
    @Qualifier("newsApiService")
    private NewsProvider newsApiService;

    @Autowired
    private NewsImageProxyService imageProxyService;

    /**
     * Resolve the right provider bean for this request. Unknown values
     * fall back to the default so a typo in {@code ?provider=} never
     * takes the News page down.
     */
    private NewsProvider pickProvider(String provider) {
        String p = provider == null ? DEFAULT_PROVIDER : provider.trim().toLowerCase();
        switch (p) {
            case "newsapi":  return newsApiService;
            case "newsdata": return newsDataService;
            default:
                log.debug("Unknown news provider '{}', falling back to '{}'.", provider, DEFAULT_PROVIDER);
                return newsDataService;
        }
    }

    /**
     * Top headlines from the selected provider. At least one of country/category/q
     * should be provided; otherwise the service defaults to country=us to avoid a
     * 400 from the upstream API.
     */
    @GetMapping(value = "/top-headlines", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getTopHeadlines(
            @RequestParam(value = "provider", required = false) String provider,
            @RequestParam(value = "country", required = false) String country,
            @RequestParam(value = "category", required = false) String category,
            @RequestParam(value = "q", required = false) String query,
            @RequestParam(value = "pageSize", required = false) Integer pageSize,
            @RequestParam(value = "page", required = false) Integer page) {
        log.debug("News /top-headlines provider={} country={} category={} q={} pageSize={} page={}",
                provider, country, category, query, pageSize, page);
        return pickProvider(provider).getTopHeadlines(country, category, query, pageSize, page);
    }

    /** Full-text article search. {@code q} is required by the provider. */
    @GetMapping(value = "/everything", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getEverything(
            @RequestParam(value = "provider", required = false) String provider,
            @RequestParam("q") String query,
            @RequestParam(value = "language", required = false) String language,
            @RequestParam(value = "from", required = false) String from,
            @RequestParam(value = "to", required = false) String to,
            @RequestParam(value = "sortBy", required = false) String sortBy,
            @RequestParam(value = "pageSize", required = false) Integer pageSize,
            @RequestParam(value = "page", required = false) Integer page) {
        log.debug("News /everything provider={} q={} language={} from={} to={} sortBy={} pageSize={} page={}",
                provider, query, language, from, to, sortBy, pageSize, page);
        return pickProvider(provider).getEverything(query, language, from, to, sortBy, pageSize, page);
    }

    /** List of available sources filtered by country / category / language. */
    @GetMapping(value = "/sources", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getSources(
            @RequestParam(value = "provider", required = false) String provider,
            @RequestParam(value = "country", required = false) String country,
            @RequestParam(value = "category", required = false) String category,
            @RequestParam(value = "language", required = false) String language) {
        log.debug("News /sources provider={} country={} category={} language={}",
                provider, country, category, language);
        return pickProvider(provider).getSources(country, category, language);
    }

    /**
     * Health-check endpoint used by the frontend status panel. Returns
     * the selected provider's status (keys, quota usage, cache size…).
     */
    @GetMapping(value = "/status", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getStatus(
            @RequestParam(value = "provider", required = false) String provider) {
        log.debug("News /status provider={}", provider);
        Map<String, Object> status = pickProvider(provider).getStatus();
        // Echo the effective provider so the UI can label the badge
        // correctly even when no ?provider= was passed (default fallback).
        if (status != null && !status.containsKey("providerId")) {
            Map<String, Object> enriched = new LinkedHashMap<>(status);
            enriched.put("providerId", provider == null ? DEFAULT_PROVIDER : provider.toLowerCase());
            return enriched;
        }
        return status;
    }

    /**
     * Flush the selected provider's response cache. Each provider keeps
     * its own cache so clearing one does not affect the other.
     * POST on purpose: it is a state-changing operation that must not be
     * replayed automatically by browsers / proxies.
     */
    @PostMapping(value = "/cache/clear", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> clearCache(
            @RequestParam(value = "provider", required = false) String provider) {
        log.info("News /cache/clear requested for provider={}", provider);
        return pickProvider(provider).clearCache();
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
