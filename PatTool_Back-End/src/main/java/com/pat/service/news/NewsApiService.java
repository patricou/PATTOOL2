package com.pat.service.news;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Implementation of {@link NewsProvider} backed by https://newsapi.org.
 *
 * Design goals:
 *  - Keep the API key server-side so it never ships in the JS bundle.
 *  - Respect the free "Developer" plan quota (100 req/day) via a small in-memory
 *    TTL cache keyed on the full URL.
 *  - Match the error-reporting style of {@code OpenWeatherService} (a
 *    {@code Map} with an {@code "error"} entry on failure) so the frontend
 *    keeps its {@code if (response.error)} branch.
 */
@Service
public class NewsApiService implements NewsProvider {

    private static final Logger log = LoggerFactory.getLogger(NewsApiService.class);
    private static final String API_KEY_HEADER = "X-Api-Key";
    private static final String USER_AGENT = "PATTOOL/1.0 (+https://www.patrickdeschamps.com)";

    private final RestTemplate restTemplate;

    @Value("${newsapi.api.base.url:https://newsapi.org/v2}")
    private String baseUrl;

    @Value("${newsapi.api.key:}")
    private String apiKey;

    @Value("${newsapi.cache.ttl.minutes:5}")
    private long cacheTtlMinutes;

    @Value("${newsapi.ticker.enabled.default:false}")
    private boolean tickerEnabledDefault;

    @Value("${newsapi.default.country:fr}")
    private String defaultCountry;

    @Value("${newsapi.default.language:fr}")
    private String defaultLanguage;

    /**
     * Daily quota of the NewsAPI plan, purely informative (displayed on the
     * News page). Override via {@code newsapi.quota.daily} if you upgrade.
     */
    @Value("${newsapi.quota.daily:100}")
    private int dailyQuota;

    private final Map<String, CachedEntry> cache = new ConcurrentHashMap<>();

    /**
     * Timestamps of every real (cache-miss) HTTP call made to NewsAPI.
     * We keep a rolling 24h window here: entries older than 24h are pruned
     * on every access. This is what feeds the "requests used today" counter
     * exposed via {@link #getStatus()}.
     */
    private final ConcurrentLinkedDeque<Instant> requestLog = new ConcurrentLinkedDeque<>();

    /** Cumulative count since the app started (never pruned). */
    private final AtomicLong totalRequests = new AtomicLong();

    public NewsApiService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    @jakarta.annotation.PostConstruct
    private void init() {
        if (apiKey != null && !apiKey.trim().isEmpty()) {
            log.info("NewsAPI key loaded (length: {}, starts with: {})",
                    apiKey.length(),
                    apiKey.length() > 4 ? apiKey.substring(0, 4) + "..." : "***");
        } else {
            log.warn("NewsAPI key is empty or not configured (newsapi.api.key).");
        }
    }

    // ---------------------------------------------------------------------
    // NewsProvider implementation
    // ---------------------------------------------------------------------

    @Override
    public Map<String, Object> getTopHeadlines(String country, String category, String query,
                                               Integer pageSize, Integer page) {
        Map<String, Object> keyMissing = missingKey();
        if (keyMissing != null) return keyMissing;

        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(baseUrl + "/top-headlines");
        if (notBlank(country))  builder.queryParam("country", country.toLowerCase());
        if (notBlank(category)) builder.queryParam("category", category.toLowerCase());
        if (notBlank(query))    builder.queryParam("q", query);
        builder.queryParam("pageSize", clamp(pageSize, 1, 100, 20));
        builder.queryParam("page", page == null || page < 1 ? 1 : page);

        // NewsAPI requires at least one of country/category/sources/q on /top-headlines.
        // If none was provided, default to country=us so the endpoint never 400s.
        if (!notBlank(country) && !notBlank(category) && !notBlank(query)) {
            builder.replaceQueryParam("country", "us");
        }

        return call(builder.toUriString());
    }

    @Override
    public Map<String, Object> getEverything(String query, String language, String from, String to,
                                             String sortBy, Integer pageSize, Integer page) {
        Map<String, Object> keyMissing = missingKey();
        if (keyMissing != null) return keyMissing;

        if (!notBlank(query)) {
            Map<String, Object> err = new HashMap<>();
            err.put("error", "Parameter 'q' is required for /everything");
            return err;
        }

        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(baseUrl + "/everything")
                .queryParam("q", query);
        if (notBlank(language)) builder.queryParam("language", language.toLowerCase());
        if (notBlank(from))     builder.queryParam("from", from);
        if (notBlank(to))       builder.queryParam("to", to);
        if (notBlank(sortBy))   builder.queryParam("sortBy", sortBy);
        builder.queryParam("pageSize", clamp(pageSize, 1, 100, 20));
        builder.queryParam("page", page == null || page < 1 ? 1 : page);

        return call(builder.toUriString());
    }

    @Override
    public Map<String, Object> getSources(String country, String category, String language) {
        Map<String, Object> keyMissing = missingKey();
        if (keyMissing != null) return keyMissing;

        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(baseUrl + "/top-headlines/sources");
        if (notBlank(country))  builder.queryParam("country", country.toLowerCase());
        if (notBlank(category)) builder.queryParam("category", category.toLowerCase());
        if (notBlank(language)) builder.queryParam("language", language.toLowerCase());
        return call(builder.toUriString());
    }

    @Override
    public Map<String, Object> getStatus() {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("service", "NewsAPI");
        status.put("baseUrl", baseUrl);
        boolean configured = apiKey != null && !apiKey.trim().isEmpty();
        status.put("configured", configured);
        status.put("cacheTtlMinutes", cacheTtlMinutes);
        status.put("cacheEntries", cache.size());
        status.put("tickerEnabledDefault", tickerEnabledDefault);
        status.put("defaultCountry", defaultCountry == null ? "" : defaultCountry.toLowerCase());
        status.put("defaultLanguage", defaultLanguage == null ? "" : defaultLanguage.toLowerCase());
        // Quota counters (informative). {@code requestsLast24h} is the real
        // network-call count over the rolling 24h window (cache hits do NOT
        // contribute). {@code totalRequestsSinceStartup} is cumulative.
        int used = countRequestsLast24h();
        status.put("requestsLast24h", used);
        status.put("quotaDaily", dailyQuota);
        if (dailyQuota > 0) {
            status.put("requestsRemaining", Math.max(0, dailyQuota - used));
        }
        Instant oldest = oldestRequestInWindow();
        if (oldest != null) {
            // Tell the UI when the oldest request in the current window will
            // "fall off" — that's when a slot becomes free again.
            status.put("oldestRequestAt", oldest.toString());
            status.put("windowResetsAt", oldest.plus(Duration.ofHours(24)).toString());
        }
        status.put("totalRequestsSinceStartup", totalRequests.get());
        if (!configured) {
            status.put("status", "unavailable");
            status.put("message", "API key is not configured (newsapi.api.key).");
            return status;
        }
        // Lightweight probe: 1-article headline call. Uses the cache so repeated checks
        // do not burn the daily quota.
        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(baseUrl + "/top-headlines")
                .queryParam("country", "us")
                .queryParam("pageSize", 1);
        Map<String, Object> probe = call(builder.toUriString());
        if (probe.containsKey("error")) {
            status.put("status", "unavailable");
            status.put("message", probe.get("error"));
        } else {
            status.put("status", "available");
            Object ts = probe.get("totalResults");
            if (ts != null) status.put("probeTotalResults", ts);
        }
        return status;
    }

    /**
     * {@inheritDoc}
     *
     * Note: this does not reset {@link #requestLog} on purpose. Cached
     * responses and quota consumption are orthogonal concerns — the 24h
     * counter must keep reflecting what was actually billed by NewsAPI,
     * so that the user cannot accidentally hide their quota usage by
     * flushing the cache.
     */
    @Override
    public Map<String, Object> clearCache() {
        int before = cache.size();
        cache.clear();
        log.info("NewsAPI cache cleared ({} entries dropped)", before);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("cleared", before);
        result.put("requestsLast24h", countRequestsLast24h());
        return result;
    }

    // ---------------------------------------------------------------------
    // HTTP + cache plumbing
    // ---------------------------------------------------------------------

    private Map<String, Object> missingKey() {
        if (apiKey == null || apiKey.trim().isEmpty()) {
            log.error("NewsAPI key is not configured!");
            Map<String, Object> err = new HashMap<>();
            err.put("error", "News API key is not configured. Please set newsapi.api.key in application.properties");
            return err;
        }
        return null;
    }

    /** Execute the GET, using the TTL cache when possible. */
    private Map<String, Object> call(String url) {
        CachedEntry cached = cache.get(url);
        if (cached != null && !cached.isExpired(cacheTtlMinutes)) {
            log.debug("NewsAPI cache HIT: {}", stripQueryNoise(url));
            return cached.payload;
        }
        log.debug("NewsAPI cache MISS: {}", stripQueryNoise(url));

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("Accept", MediaType.APPLICATION_JSON_VALUE);
        headers.set("User-Agent", USER_AGENT);
        headers.set(API_KEY_HEADER, apiKey.trim());
        HttpEntity<String> req = new HttpEntity<>(headers);

        try {
            @SuppressWarnings("unchecked")
            ResponseEntity<Map<String, Object>> resp = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    req,
                    (Class<Map<String, Object>>) (Class<?>) Map.class);
            Map<String, Object> body = resp.getBody() != null ? resp.getBody() : new HashMap<>();
            cache.put(url, new CachedEntry(body, Instant.now()));
            recordRequest();
            return body;
        } catch (HttpClientErrorException e) {
            // Still count quota-burning errors (400/429/...): the request
            // *was* sent and NewsAPI debits the quota regardless of the
            // response status, so the user deserves to see it.
            recordRequest();
            log.warn("NewsAPI HTTP error ({}): {}", e.getStatusCode(), e.getResponseBodyAsString());
            Map<String, Object> err = new HashMap<>();
            err.put("error", "NewsAPI HTTP " + e.getStatusCode() + ": " + e.getStatusText());
            try {
                // NewsAPI returns structured errors like {"status":"error","code":"apiKeyInvalid","message":"..."}.
                String body = e.getResponseBodyAsString();
                if (body != null && !body.isEmpty()) err.put("providerMessage", body);
            } catch (Exception ignore) { /* noop */ }
            return err;
        } catch (Exception e) {
            log.error("Error calling NewsAPI: ", e);
            Map<String, Object> err = new HashMap<>();
            err.put("error", "Failed to call NewsAPI: " + e.getMessage());
            return err;
        }
    }

    /**
     * Append the current instant to the rolling log and prune anything
     * older than 24h. Also bumps the lifetime counter. Called once per
     * real network call (cache miss), regardless of HTTP status.
     */
    private void recordRequest() {
        Instant now = Instant.now();
        requestLog.addLast(now);
        totalRequests.incrementAndGet();
        pruneRequestLog(now);
        int used = requestLog.size();
        if (dailyQuota > 0) {
            log.info("NewsAPI request #{} in the last 24h (quota {}/{})",
                    used, used, dailyQuota);
        } else {
            log.info("NewsAPI request #{} in the last 24h", used);
        }
    }

    /** Drop every timestamp older than 24 hours. */
    private void pruneRequestLog(Instant now) {
        Instant cutoff = now.minus(Duration.ofHours(24));
        Iterator<Instant> it = requestLog.iterator();
        while (it.hasNext()) {
            if (it.next().isBefore(cutoff)) {
                it.remove();
            } else {
                // Timestamps are appended in order, so stop at first fresh one.
                break;
            }
        }
    }

    /** Current count of NewsAPI requests made in the last 24 hours. */
    private int countRequestsLast24h() {
        pruneRequestLog(Instant.now());
        return requestLog.size();
    }

    /** Instant of the oldest request still inside the 24h window, or {@code null}. */
    private Instant oldestRequestInWindow() {
        pruneRequestLog(Instant.now());
        return requestLog.peekFirst();
    }

    private static boolean notBlank(String s) {
        return s != null && !s.trim().isEmpty();
    }

    private static int clamp(Integer v, int min, int max, int defaultValue) {
        if (v == null) return defaultValue;
        if (v < min) return min;
        if (v > max) return max;
        return v;
    }

    private static String stripQueryNoise(String url) {
        // Remove potential apiKey query noise (we send it via header, but guard anyway)
        return url.replaceAll("(?i)([?&])apiKey=[^&]*", "$1apiKey=***");
    }

    private static final class CachedEntry {
        final Map<String, Object> payload;
        final Instant fetchedAt;

        CachedEntry(Map<String, Object> payload, Instant fetchedAt) {
            this.payload = payload;
            this.fetchedAt = fetchedAt;
        }

        boolean isExpired(long ttlMinutes) {
            if (ttlMinutes <= 0) return true;
            return Duration.between(fetchedAt, Instant.now()).toMinutes() >= ttlMinutes;
        }
    }
}
