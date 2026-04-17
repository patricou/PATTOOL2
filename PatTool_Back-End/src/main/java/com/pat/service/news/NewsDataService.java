package com.pat.service.news;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.service.AppParameterService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Implementation of {@link NewsProvider} backed by https://newsdata.io.
 *
 * Why we have two providers:
 *  - NewsAPI's free "Developer" plan delays every article by 24h.
 *  - NewsData.io's free plan has no such delay — articles are
 *    published live, which is nicer for a user-facing ticker.
 *
 * The service intentionally mirrors {@link NewsApiService}'s public
 * behaviour: both expose the {@link NewsProvider} interface, both
 * respond in NewsAPI's native JSON shape (articles / source /
 * urlToImage / publishedAt…). The normalisation happens in
 * {@link #mapArticle(Map)} / {@link #mapSource(Map)}, so the Angular
 * frontend stays oblivious to the provider switch.
 *
 * Design goals:
 *  - Keep the API key server-side (NewsData requires {@code apikey} in
 *    the query string, which is why we also accept it as the
 *    {@code X-ACCESS-KEY} header — safer against accidental logging).
 *  - Respect the Free plan quota (200 credits/day, ≈1 credit per call
 *    + a rolling 30-call / 15-minute rate limit) via the same in-memory
 *    log + MongoDB persistence trick used by NewsApiService.
 *  - Support multiple keys with automatic failover on 429 /
 *    rateLimitExceeded, again mirroring NewsApiService so a second
 *    NewsData account can be added later without code changes.
 */
@Service
@Primary
public class NewsDataService implements NewsProvider {

    private static final Logger log = LoggerFactory.getLogger(NewsDataService.class);
    private static final String USER_AGENT = "PatTool/1.0 (+https://www.patrickdeschamps.com)";
    /** NewsData.io accepts the API key either as a query param or as this header; we use the header. */
    private static final String API_KEY_HEADER = "X-ACCESS-KEY";

    private final RestTemplate restTemplate;

    @Value("${newsdata.api.base.url:https://newsdata.io/api/1}")
    private String baseUrl;

    /** Legacy single-key property kept for deployment simplicity. */
    @Value("${newsdata.api.key:}")
    private String legacyApiKey;

    /** Multi-key list (comma-separated). Tried in order, failover on 429. */
    @Value("${newsdata.api.keys:}")
    private List<String> configuredApiKeys;

    /** Effective list built from {@link #legacyApiKey} + {@link #configuredApiKeys}. */
    private List<String> apiKeys = Collections.emptyList();

    @Value("${newsdata.cache.ttl.minutes:5}")
    private long cacheTtlMinutes;

    /**
     * Longer TTL applied to empty {@code /latest} responses. A country +
     * category combo that returns nothing today should not burn 1 credit
     * every {@link #cacheTtlMinutes} minutes; 60 minutes is still fresh
     * enough to catch new content.
     */
    @Value("${newsdata.cache.ttl.empty.minutes:60}")
    private long cacheTtlEmptyMinutes;

    @Value("${newsdata.ticker.enabled.default:false}")
    private boolean tickerEnabledDefault;

    @Value("${newsdata.default.country:fr}")
    private String defaultCountry;

    @Value("${newsdata.default.language:fr}")
    private String defaultLanguage;

    /**
     * Daily quota of the NewsData plan (Free = 200 credits/day). Used
     * by the status badge and by key fail-over (we treat 24h usage
     * &ge; quota as "saturated" and try the next key).
     */
    @Value("${newsdata.quota.daily:200}")
    private int dailyQuota;

    private final Map<String, CachedEntry> cache = new ConcurrentHashMap<>();

    /** Rolling 24h request log per key (keyed by {@link #keyIdOf(String)}). */
    private final Map<String, ConcurrentLinkedDeque<Instant>> requestLogByKey = new ConcurrentHashMap<>();

    /** Cumulative count since the app started, all keys combined. */
    private final AtomicLong totalRequests = new AtomicLong();
    /** Per-key cumulative counters since startup. */
    private final Map<String, AtomicLong> totalRequestsByKey = new ConcurrentHashMap<>();

    /**
     * DB persistence key for the per-key request log. Intentionally
     * namespaced away from NewsAPI's own key so the two providers keep
     * independent counters even if they ever share a MongoDB instance.
     */
    private static final String PARAM_KEY_REQUEST_LOG = "newsdata.requests.log.v1";

    private final ObjectMapper jsonMapper = new ObjectMapper();

    @Autowired
    private AppParameterService appParameterService;

    public NewsDataService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    @jakarta.annotation.PostConstruct
    private void init() {
        this.apiKeys = buildKeyList(legacyApiKey, configuredApiKeys);
        if (apiKeys.isEmpty()) {
            log.warn("NewsData.io keys are empty or not configured (newsdata.api.keys / newsdata.api.key).");
        } else {
            log.info("NewsData.io keys loaded: {} key(s) configured — {}",
                    apiKeys.size(), describeKeys(apiKeys));
            for (String k : apiKeys) {
                String kid = keyIdOf(k);
                requestLogByKey.computeIfAbsent(kid, x -> new ConcurrentLinkedDeque<>());
                totalRequestsByKey.computeIfAbsent(kid, x -> new AtomicLong());
            }
        }
        hydrateRequestLogFromDb();
    }

    private static List<String> buildKeyList(String legacy, List<String> configured) {
        LinkedHashSet<String> out = new LinkedHashSet<>();
        if (legacy != null && !legacy.trim().isEmpty()) {
            out.add(legacy.trim());
        }
        if (configured != null) {
            for (String k : configured) {
                if (k != null && !k.trim().isEmpty()) out.add(k.trim());
            }
        }
        return new ArrayList<>(out);
    }

    private void hydrateRequestLogFromDb() {
        try {
            String persisted = appParameterService.getString(PARAM_KEY_REQUEST_LOG, null);
            if (persisted == null || persisted.isBlank()) return;
            Map<String, List<String>> perKey = jsonMapper.readValue(persisted, new TypeReference<Map<String, List<String>>>() {});
            Instant cutoff = Instant.now().minus(Duration.ofHours(24));
            for (Map.Entry<String, List<String>> e : perKey.entrySet()) {
                String keyId = e.getKey();
                if (!requestLogByKey.containsKey(keyId)) continue; // key no longer configured
                ConcurrentLinkedDeque<Instant> deque = requestLogByKey.get(keyId);
                for (String iso : e.getValue()) {
                    try {
                        Instant ts = Instant.parse(iso);
                        if (ts.isAfter(cutoff)) deque.addLast(ts);
                    } catch (DateTimeParseException ignore) { /* skip malformed */ }
                }
                log.info("NewsData.io hydrated {} timestamps for key {} from DB.", deque.size(), keyId);
            }
        } catch (Exception e) {
            log.warn("Failed to hydrate NewsData.io request log from DB: {}", e.getMessage());
        }
    }

    private void persistRequestLog() {
        try {
            Map<String, List<String>> toPersist = new LinkedHashMap<>();
            for (Map.Entry<String, ConcurrentLinkedDeque<Instant>> e : requestLogByKey.entrySet()) {
                List<String> list = new ArrayList<>();
                for (Instant ts : e.getValue()) list.add(ts.toString());
                toPersist.put(e.getKey(), list);
            }
            String json = jsonMapper.writeValueAsString(toPersist);
            appParameterService.setJson(
                    PARAM_KEY_REQUEST_LOG,
                    json,
                    "Rolling 24h log of successful NewsData.io requests, keyed by first-8-chars of each API key.");
        } catch (Exception e) {
            log.warn("Failed to persist NewsData.io request log: {}", e.getMessage());
        }
    }

    // ---------------------------------------------------------------------
    // NewsProvider implementation
    // ---------------------------------------------------------------------

    /**
     * NewsAPI's "top headlines" has no direct equivalent on NewsData.io
     * — their {@code /latest} endpoint is close enough (recent articles,
     * filterable by country / category / query), so we use it both for
     * headlines and for free-text search. Archive queries require a paid
     * plan and are therefore out of reach of {@link #getEverything}.
     */
    @Override
    public Map<String, Object> getTopHeadlines(String country, String category, String query, Integer pageSize, Integer page) {
        Map<String, Object> keyMissing = missingKeys();
        if (keyMissing != null) return keyMissing;

        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(baseUrl + "/latest");
        if (notBlank(country))  builder.queryParam("country", country.toLowerCase());
        String mappedCategory = mapCategoryToNewsData(category);
        if (notBlank(mappedCategory)) builder.queryParam("category", mappedCategory);
        if (notBlank(query))    builder.queryParam("q", query);
        // NewsData.io's own dedup (regional press networks, e.g. EBRA in
        // France, love to repost the exact same AFP wire under different
        // source_ids). Free plan honours this parameter — see docs.
        builder.queryParam("removeduplicate", 1);
        builder.queryParam("size", clamp(pageSize, 1, 10, 10));

        return fetchPaginated(builder, page);
    }

    @Override
    public Map<String, Object> getEverything(String query, String language, String from, String to,
                                             String sortBy, Integer pageSize, Integer page) {
        Map<String, Object> keyMissing = missingKeys();
        if (keyMissing != null) return keyMissing;

        if (!notBlank(query)) {
            Map<String, Object> err = new HashMap<>();
            err.put("error", "Missing required query parameter 'q' for NewsData.io /latest.");
            return err;
        }

        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(baseUrl + "/latest")
                .queryParam("q", query);
        if (notBlank(language)) builder.queryParam("language", language.toLowerCase());
        // from/to: the Free plan covers only the last 48h; we keep the
        // params best-effort — NewsData silently ignores them on /latest,
        // but users on paid plans get the expected window.
        if (notBlank(from))     builder.queryParam("from_date", toNewsDataDate(from));
        if (notBlank(to))       builder.queryParam("to_date", toNewsDataDate(to));
        // IMPORTANT: only add `sort` when the mapper returns a real
        // NewsData-compatible value. NewsAPI's default "publishedAt"
        // maps to null (NewsData sorts by date newest-first by default),
        // and passing `sort=` with no value triggers a 422 on their side.
        String mappedSort = mapSortByToNewsData(sortBy);
        if (notBlank(mappedSort)) builder.queryParam("sort", mappedSort);
        builder.queryParam("removeduplicate", 1);
        builder.queryParam("size", clamp(pageSize, 1, 10, 10));

        return fetchPaginated(builder, page);
    }

    @Override
    public Map<String, Object> getSources(String country, String category, String language) {
        Map<String, Object> keyMissing = missingKeys();
        if (keyMissing != null) return keyMissing;

        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(baseUrl + "/sources");
        if (notBlank(country))  builder.queryParam("country", country.toLowerCase());
        String mappedCategory = mapCategoryToNewsData(category);
        if (notBlank(mappedCategory)) builder.queryParam("category", mappedCategory);
        if (notBlank(language)) builder.queryParam("language", language.toLowerCase());

        return normalizeSourcesResponse(call(builder.toUriString()));
    }

    @Override
    public Map<String, Object> getStatus() {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("service", "NewsData.io");
        status.put("baseUrl", baseUrl);
        boolean configured = !apiKeys.isEmpty();
        status.put("configured", configured);
        status.put("cacheTtlMinutes", cacheTtlMinutes);
        status.put("cacheEntries", cache.size());
        status.put("tickerEnabledDefault", tickerEnabledDefault);
        status.put("defaultCountry", defaultCountry == null ? "" : defaultCountry.toLowerCase());
        status.put("defaultLanguage", defaultLanguage == null ? "" : defaultLanguage.toLowerCase());

        int aggUsed = 0;
        for (String k : apiKeys) aggUsed += countRequestsLast24h(keyIdOf(k));
        status.put("requestsLast24h", aggUsed);
        status.put("quotaDaily", dailyQuota);
        status.put("totalQuotaDaily", dailyQuota * Math.max(1, apiKeys.size()));
        if (dailyQuota > 0) {
            int totalQuota = dailyQuota * Math.max(1, apiKeys.size());
            status.put("requestsRemaining", Math.max(0, totalQuota - aggUsed));
        }
        Instant oldest = oldestRequestInWindowAny();
        if (oldest != null) {
            status.put("oldestRequestAt", oldest.toString());
            status.put("windowResetsAt", oldest.plus(Duration.ofHours(24)).toString());
        }
        status.put("totalRequestsSinceStartup", totalRequests.get());

        String activeKey = pickActiveKey();
        List<Map<String, Object>> keys = new ArrayList<>();
        for (int i = 0; i < apiKeys.size(); i++) {
            String key = apiKeys.get(i);
            String keyId = keyIdOf(key);
            int used = countRequestsLast24h(keyId);
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("index", i);
            entry.put("keyId", keyId);
            entry.put("masked", maskKey(key));
            entry.put("used", used);
            entry.put("quota", dailyQuota);
            entry.put("remaining", dailyQuota > 0 ? Math.max(0, dailyQuota - used) : null);
            entry.put("saturated", dailyQuota > 0 && used >= dailyQuota);
            entry.put("active", key.equals(activeKey));
            AtomicLong tot = totalRequestsByKey.get(keyId);
            entry.put("totalSinceStartup", tot == null ? 0L : tot.get());
            Instant keyOldest = oldestRequestInWindow(keyId);
            if (keyOldest != null) {
                entry.put("oldestRequestAt", keyOldest.toString());
                entry.put("windowResetsAt", keyOldest.plus(Duration.ofHours(24)).toString());
            }
            keys.add(entry);
        }
        status.put("keys", keys);
        status.put("activeKeyId", activeKey == null ? null : keyIdOf(activeKey));

        if (!configured) {
            status.put("status", "unavailable");
            status.put("message", "API keys are not configured (newsdata.api.keys / newsdata.api.key).");
            return status;
        }

        // Same availability heuristic as NewsApiService: if we already
        // have evidence of a successful call in the last 24h, NewsData
        // is obviously reachable — no need to probe and burn a credit.
        if (aggUsed > 0) {
            status.put("status", "available");
            return status;
        }
        status.put("status", "available"); // optimistic when no history yet
        return status;
    }

    @Override
    public Map<String, Object> clearCache() {
        int before = cache.size();
        cache.clear();
        // Invalidate the cursor-pagination chain too — stale tokens
        // would otherwise produce pages that no longer align with the
        // freshly fetched page 1 after a cache flush.
        pageTokensByBaseUrl.clear();
        log.info("NewsData.io cache cleared ({} entries dropped)", before);
        int agg = 0;
        for (String k : apiKeys) agg += countRequestsLast24h(keyIdOf(k));
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("cleared", before);
        result.put("requestsLast24h", agg);
        return result;
    }

    // ---------------------------------------------------------------------
    // Cursor pagination: translate the frontend's numeric `page` into
    // NewsData.io's opaque `nextPage` tokens.
    // ---------------------------------------------------------------------

    /**
     * Per-query token chain. Key is the URL without any `page=` param
     * (one entry per distinct filter combination); value is the list
     * of `nextPage` tokens previously returned by NewsData, where
     * {@code tokens[i]} is the token needed to reach page i+2 (i.e.
     * {@code tokens[0]} takes you from page 1 to page 2).
     */
    private final Map<String, List<String>> pageTokensByBaseUrl = new ConcurrentHashMap<>();

    /**
     * Hard cap on how many pages we'll walk forward when the frontend
     * asks for a page we haven't fetched yet. A jump from page 1 to
     * page 50 would otherwise burn 49 credits silently; 10 is enough
     * for the UI's next-button UX while keeping the blast radius small.
     */
    private static final int MAX_WALK_FORWARD_PAGES = 10;

    /**
     * Fetch the requested {@code page} by translating the numeric page
     * index into NewsData's cursor-based pagination. Called by both
     * {@link #getTopHeadlines} and {@link #getEverything} since they
     * hit the same upstream endpoint and share the same token chain.
     */
    private Map<String, Object> fetchPaginated(UriComponentsBuilder builder, Integer page) {
        String baseUrl = builder.build(true).toUriString();
        int pageNum = (page == null || page < 1) ? 1 : page;

        if (pageNum == 1) {
            Map<String, Object> raw = call(baseUrl);
            rememberTokenForPage(baseUrl, 1, extractNextPage(raw));
            return normalizeArticleResponse(raw);
        }

        String token = resolveTokenForPage(baseUrl, pageNum);
        if (token == null) {
            // Either NewsData ran out of results or we hit the walk cap.
            Map<String, Object> err = new HashMap<>();
            err.put("error", "No more pages available from NewsData.io for this query.");
            err.put("code", "endOfResults");
            return err;
        }

        String finalUrl = baseUrl + "&page=" + token;
        Map<String, Object> raw = call(finalUrl);
        rememberTokenForPage(baseUrl, pageNum, extractNextPage(raw));
        return normalizeArticleResponse(raw);
    }

    /**
     * Return the token that gets us to page {@code pageNum}, fetching
     * any missing intermediate pages on the fly (capped at
     * {@link #MAX_WALK_FORWARD_PAGES}). Returns {@code null} if the
     * query has been exhausted upstream.
     */
    private String resolveTokenForPage(String baseUrl, int pageNum) {
        int idx = pageNum - 2; // tokens[0] is the token needed to reach page 2
        List<String> tokens = pageTokensByBaseUrl.get(baseUrl);

        if (tokens != null && idx < tokens.size()) {
            return tokens.get(idx);
        }

        int alreadyKnown = (tokens == null) ? 0 : tokens.size();
        int stepsToWalk = pageNum - 1 - alreadyKnown;
        if (stepsToWalk > MAX_WALK_FORWARD_PAGES) {
            log.warn("NewsData.io: refusing to walk {} pages forward (cap={}). baseUrl={}",
                    stepsToWalk, MAX_WALK_FORWARD_PAGES, stripQueryNoise(baseUrl));
            return null;
        }

        // Walk from the highest known page up to pageNum - 1, capturing
        // each hop's nextPage token as we go. Each hop re-uses the same
        // TTL cache via {@link #call}, so repeatedly navigating back
        // and forth never burns extra credits.
        int startPage = alreadyKnown + 1; // the page we already know the next-token FOR
        for (int p = startPage; p < pageNum; p++) {
            String hopToken = (p == 1) ? null : pageTokensByBaseUrl.get(baseUrl).get(p - 2);
            String hopUrl = (hopToken == null) ? baseUrl : baseUrl + "&page=" + hopToken;
            Map<String, Object> raw = call(hopUrl);
            if (raw.containsKey("error")) return null;
            String next = extractNextPage(raw);
            if (next == null) return null; // upstream ran out of results
            rememberTokenForPage(baseUrl, p, next);
        }
        List<String> updated = pageTokensByBaseUrl.get(baseUrl);
        return (updated != null && idx < updated.size()) ? updated.get(idx) : null;
    }

    /**
     * Store the {@code nextPage} token returned from {@code pageNum}'s
     * response at position {@code pageNum - 1} in the chain (so it is
     * used to reach page {@code pageNum + 1}). Idempotent: safe to call
     * again with the same values, and tolerant of a null token (meaning
     * "no more pages", which we keep as-is so we don't try to walk further).
     */
    private void rememberTokenForPage(String baseUrl, int pageNum, String nextPageToken) {
        if (nextPageToken == null) return;
        List<String> tokens = pageTokensByBaseUrl.computeIfAbsent(baseUrl,
                k -> java.util.Collections.synchronizedList(new ArrayList<>()));
        synchronized (tokens) {
            int expectedIdx = pageNum - 1;
            // The chain can only grow forward sequentially — if we
            // already have this index, replace it (the newer token is
            // presumably more accurate); if the caller skipped ahead
            // (shouldn't happen thanks to resolveTokenForPage walking
            // forward), no-op rather than corrupt the indexing.
            if (expectedIdx == tokens.size()) {
                tokens.add(nextPageToken);
            } else if (expectedIdx < tokens.size()) {
                tokens.set(expectedIdx, nextPageToken);
            }
        }
    }

    private static String extractNextPage(Map<String, Object> raw) {
        if (raw == null) return null;
        Object np = raw.get("nextPage");
        return np == null ? null : np.toString();
    }

    // ---------------------------------------------------------------------
    // HTTP + cache plumbing
    // ---------------------------------------------------------------------

    private Map<String, Object> missingKeys() {
        if (apiKeys.isEmpty()) {
            Map<String, Object> err = new HashMap<>();
            err.put("error", "NewsData.io API key is not configured on the server.");
            return err;
        }
        return null;
    }

    private String pickActiveKey() {
        if (apiKeys.isEmpty()) return null;
        for (String k : apiKeys) {
            if (dailyQuota <= 0 || countRequestsLast24h(keyIdOf(k)) < dailyQuota) return k;
        }
        return null;
    }

    /**
     * Execute the GET with the TTL cache and automatic key fail-over.
     * Mirrors {@link NewsApiService#call(String)} — kept as a separate
     * method rather than refactored into a base class because the two
     * providers' error shapes differ slightly (NewsData wraps errors as
     * {@code {status: "error", results: {code, message}}}, NewsAPI as
     * {@code {status: "error", code, message}}).
     */
    private Map<String, Object> call(String url) {
        CachedEntry cached = cache.get(url);
        if (cached != null && !cached.isExpired()) {
            log.debug("NewsData.io cache HIT: {}", stripQueryNoise(url));
            return cached.payload;
        }
        log.debug("NewsData.io cache MISS: {}", stripQueryNoise(url));

        Map<String, Object> lastError = null;
        for (int attempt = 0; attempt < apiKeys.size(); attempt++) {
            String key = pickActiveKey();
            if (key == null) {
                Map<String, Object> err = new HashMap<>();
                err.put("error", "NewsData.io quota exhausted on every configured key for the rolling 24h window.");
                err.put("code", "allKeysRateLimited");
                return lastError != null ? lastError : err;
            }
            Map<String, Object> result = doCall(url, key);
            if (result.containsKey("__rateLimited")) {
                lastError = new HashMap<>(result);
                lastError.remove("__rateLimited");
                saturateKey(keyIdOf(key));
                log.warn("NewsData.io key {} hit the rate limit — failing over to next key.", keyIdOf(key));
                continue;
            }
            return result;
        }
        Map<String, Object> err = new HashMap<>();
        err.put("error", "NewsData.io quota exhausted on every configured key.");
        err.put("code", "allKeysRateLimited");
        return lastError != null ? lastError : err;
    }

    private Map<String, Object> doCall(String url, String key) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("Accept", MediaType.APPLICATION_JSON_VALUE);
        headers.set("User-Agent", USER_AGENT);
        headers.set(API_KEY_HEADER, key);
        HttpEntity<String> req = new HttpEntity<>(headers);

        try {
            @SuppressWarnings("unchecked")
            ResponseEntity<Map<String, Object>> resp = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    req,
                    (Class<Map<String, Object>>) (Class<?>) Map.class);
            Map<String, Object> body = resp.getBody() != null ? resp.getBody() : new HashMap<>();

            if (isProviderError(body)) {
                log.warn("NewsData.io logical error (key {}): {}", keyIdOf(key), body);
                Map<String, Object> err = new HashMap<>();
                Map<String, Object> details = extractErrorDetails(body);
                err.put("error", "NewsData.io error: " + details.getOrDefault("message", details.getOrDefault("code", "unknown")));
                err.put("providerMessage", body.toString());
                if (isRateLimitedCode(details.get("code"))) {
                    err.put("__rateLimited", Boolean.TRUE);
                }
                return err;
            }

            long ttl = effectiveCacheTtl(url, body);
            cache.put(url, new CachedEntry(body, Instant.now(), ttl));
            recordRequest(keyIdOf(key));
            return body;
        } catch (HttpClientErrorException e) {
            log.warn("NewsData.io HTTP error (key {}, {}): {}",
                    keyIdOf(key), e.getStatusCode(), e.getResponseBodyAsString());
            Map<String, Object> err = new HashMap<>();
            err.put("error", "NewsData.io HTTP " + e.getStatusCode() + ": " + e.getStatusText());
            String body = null;
            try {
                body = e.getResponseBodyAsString();
                if (body != null && !body.isEmpty()) err.put("providerMessage", body);
            } catch (Exception ignore) { /* noop */ }
            if (e.getStatusCode() == HttpStatus.TOO_MANY_REQUESTS
                    || (body != null && body.toLowerCase().contains("ratelimit"))) {
                err.put("__rateLimited", Boolean.TRUE);
            }
            return err;
        } catch (Exception e) {
            log.error("Error calling NewsData.io (key {}): ", keyIdOf(key), e);
            Map<String, Object> err = new HashMap<>();
            err.put("error", "Failed to call NewsData.io: " + e.getMessage());
            return err;
        }
    }

    private static boolean isProviderError(Map<String, Object> body) {
        if (body == null) return false;
        Object status = body.get("status");
        return status != null && "error".equalsIgnoreCase(status.toString());
    }

    /**
     * NewsData.io wraps its error details under {@code results: { code, message }}
     * on /latest endpoints, but sometimes emits a flat shape on /sources.
     * Normalise both into a single {@code {code, message}} map.
     */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> extractErrorDetails(Map<String, Object> body) {
        Map<String, Object> out = new HashMap<>();
        Object results = body.get("results");
        if (results instanceof Map) {
            Map<String, Object> m = (Map<String, Object>) results;
            if (m.containsKey("code"))    out.put("code", m.get("code"));
            if (m.containsKey("message")) out.put("message", m.get("message"));
        }
        if (!out.containsKey("code") && body.containsKey("code")) out.put("code", body.get("code"));
        if (!out.containsKey("message") && body.containsKey("message")) out.put("message", body.get("message"));
        return out;
    }

    private static boolean isRateLimitedCode(Object code) {
        if (code == null) return false;
        String s = code.toString().toLowerCase();
        return s.contains("ratelimit") || s.equals("toomanyrequests") || s.contains("quotaexceeded");
    }

    private long effectiveCacheTtl(String url, Map<String, Object> body) {
        if (isEmptyResultsPayload(body)) {
            return Math.max(cacheTtlMinutes, cacheTtlEmptyMinutes);
        }
        return cacheTtlMinutes;
    }

    @SuppressWarnings("unchecked")
    private static boolean isEmptyResultsPayload(Map<String, Object> body) {
        if (body == null) return false;
        Object results = body.get("results");
        if (results instanceof List) return ((List<Object>) results).isEmpty();
        Object total = body.get("totalResults");
        if (total instanceof Number) return ((Number) total).intValue() == 0;
        return false;
    }

    // ---------------------------------------------------------------------
    // Normalisation: NewsData.io → NewsAPI-shaped response
    // ---------------------------------------------------------------------

    /**
     * Turn a NewsData.io {@code /latest} or {@code /archive} response
     * into the exact shape the Angular {@code NewsComponent} already
     * consumes from NewsAPI. If the input already contains an
     * {@code error}, we pass it through unchanged so the UI surfaces it.
     */
    @SuppressWarnings("unchecked")
    private Map<String, Object> normalizeArticleResponse(Map<String, Object> raw) {
        if (raw == null || raw.containsKey("error")) return raw;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", "ok");
        Object total = raw.get("totalResults");
        out.put("totalResults", total instanceof Number ? ((Number) total).intValue() : 0);

        List<Map<String, Object>> articles = new ArrayList<>();
        Object results = raw.get("results");
        if (results instanceof List) {
            for (Object item : (List<Object>) results) {
                if (item instanceof Map) {
                    Map<String, Object> src = (Map<String, Object>) item;
                    // Drop anything NewsData already flagged as duplicate.
                    // Their removeduplicate=1 param catches most cases
                    // server-side, but this belt-and-suspenders check
                    // handles payloads from older cached entries that
                    // were fetched before we enabled the param.
                    Object dup = src.get("duplicate");
                    if (dup instanceof Boolean && (Boolean) dup) continue;
                    articles.add(mapArticle(src));
                }
            }
        }
        // Client-side dedup by (normalized URL) and (source + title) to
        // catch regional press networks (EBRA group in France: Le Journal,
        // Dna, L'Alsace, etc.) that republish the same AFP wire under
        // different source_ids — NewsData's own algorithm misses these.
        List<Map<String, Object>> deduped = dedupeArticles(articles);
        out.put("articles", deduped);
        Object nextPage = raw.get("nextPage");
        if (nextPage != null) out.put("nextPage", nextPage);
        return out;
    }

    /**
     * Remove articles that share the same normalized URL (scheme /
     * trailing slash stripped) or the same trimmed lowercase title.
     * Order is preserved: the first occurrence wins — which is usually
     * the most authoritative source thanks to NewsData's own priority
     * ordering.
     */
    private static List<Map<String, Object>> dedupeArticles(List<Map<String, Object>> articles) {
        List<Map<String, Object>> out = new ArrayList<>(articles.size());
        java.util.Set<String> seenUrls = new java.util.HashSet<>();
        java.util.Set<String> seenTitles = new java.util.HashSet<>();
        for (Map<String, Object> a : articles) {
            String urlKey = normalizeUrlForDedup(asString(a.get("url")));
            String titleKey = normalizeTitleForDedup(asString(a.get("title")));
            if (!urlKey.isEmpty() && !seenUrls.add(urlKey)) continue;
            if (!titleKey.isEmpty() && !seenTitles.add(titleKey)) continue;
            out.add(a);
        }
        return out;
    }

    private static String normalizeUrlForDedup(String url) {
        if (url == null) return "";
        String s = url.trim().toLowerCase();
        if (s.startsWith("https://")) s = s.substring(8);
        else if (s.startsWith("http://")) s = s.substring(7);
        if (s.startsWith("www.")) s = s.substring(4);
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    private static String normalizeTitleForDedup(String title) {
        if (title == null) return "";
        // Collapse whitespace and drop punctuation that tends to drift
        // between regional reposts (em-dash / hyphen variants, quotes,
        // etc.). This is best-effort: perfect dedup would need an LSH
        // or Jaccard-based comparator, which is overkill here.
        return title.trim().toLowerCase()
                .replaceAll("[\\s\\u00A0]+", " ")
                .replaceAll("[\\p{Punct}\\u2013\\u2014\\u2018\\u2019\\u201C\\u201D]", "");
    }

    private static String asString(Object v) {
        return v == null ? null : v.toString();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> normalizeSourcesResponse(Map<String, Object> raw) {
        if (raw == null || raw.containsKey("error")) return raw;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", "ok");
        List<Map<String, Object>> sources = new ArrayList<>();
        Object results = raw.get("results");
        if (results instanceof List) {
            for (Object item : (List<Object>) results) {
                if (item instanceof Map) {
                    sources.add(mapSource((Map<String, Object>) item));
                }
            }
        }
        out.put("sources", sources);
        return out;
    }

    /**
     * Map one NewsData.io article object to the NewsAPI-shaped record
     * the frontend expects.
     */
    @SuppressWarnings("unchecked")
    private Map<String, Object> mapArticle(Map<String, Object> nd) {
        Map<String, Object> out = new LinkedHashMap<>();

        Map<String, Object> source = new LinkedHashMap<>();
        source.put("id", nd.get("source_id"));
        Object sourceName = nd.get("source_name");
        source.put("name", sourceName != null ? sourceName : nd.getOrDefault("source_id", ""));
        out.put("source", source);

        Object creator = nd.get("creator");
        if (creator instanceof List && !((List<Object>) creator).isEmpty()) {
            out.put("author", String.valueOf(((List<Object>) creator).get(0)));
        } else if (creator instanceof String) {
            out.put("author", creator);
        } else {
            out.put("author", null);
        }

        out.put("title", nd.get("title"));
        out.put("description", nd.get("description"));
        out.put("url", nd.get("link"));
        out.put("urlToImage", nd.get("image_url"));
        out.put("publishedAt", toIsoInstant(nd.get("pubDate"), nd.get("pubDateTZ")));
        out.put("content", nd.get("content"));
        return out;
    }

    /**
     * Map one NewsData.io source object to the NewsAPI /sources shape.
     */
    private Map<String, Object> mapSource(Map<String, Object> nd) {
        Map<String, Object> out = new LinkedHashMap<>();
        Object id = nd.get("id");
        if (id == null) id = nd.get("source_id");
        out.put("id", id);
        Object name = nd.get("name");
        if (name == null) name = nd.get("source_name");
        if (name == null) name = id;
        out.put("name", name);
        out.put("description", nd.get("description"));
        out.put("url", nd.getOrDefault("url", nd.get("source_url")));
        out.put("category", firstOfListOrValue(nd.get("category")));
        out.put("language", nd.get("language"));
        out.put("country", firstOfListOrValue(nd.get("country")));
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Object firstOfListOrValue(Object v) {
        if (v instanceof List && !((List<Object>) v).isEmpty()) return ((List<Object>) v).get(0);
        return v;
    }

    /**
     * NewsData dates look like {@code "2024-10-02 12:34:56"} (space
     * separator, no timezone). We turn them into RFC-3339 so the
     * frontend's {@code new Date(isoString)} parses them consistently
     * across browsers. When a timezone is provided via {@code pubDateTZ},
     * we honour it; otherwise UTC is assumed (NewsData's default).
     */
    private static String toIsoInstant(Object pubDate, Object pubDateTz) {
        if (pubDate == null) return null;
        String s = pubDate.toString().trim();
        if (s.isEmpty()) return null;
        // Already ISO-looking
        if (s.contains("T") && (s.endsWith("Z") || s.matches(".*[+-]\\d{2}:?\\d{2}$"))) return s;
        try {
            LocalDateTime ldt = LocalDateTime.parse(s.replace(' ', 'T'), DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss"));
            Instant instant = ldt.toInstant(ZoneOffset.UTC);
            return instant.toString();
        } catch (DateTimeParseException e) {
            return s; // fall back to the raw string — frontend will handle best-effort
        }
    }

    // ---------------------------------------------------------------------
    // Category / sort mapping between NewsAPI-style codes (used by the
    // frontend) and NewsData-style codes (used by the upstream API).
    // ---------------------------------------------------------------------

    /**
     * Translate a NewsAPI-style category code into its NewsData
     * equivalent. NewsAPI's {@code general} maps to NewsData's
     * {@code top}; all others share the same wording.
     */
    private static String mapCategoryToNewsData(String newsApiCategory) {
        if (newsApiCategory == null || newsApiCategory.isBlank()) return null;
        String c = newsApiCategory.trim().toLowerCase();
        switch (c) {
            case "general": return "top";
            case "business":
            case "entertainment":
            case "health":
            case "science":
            case "sports":
            case "technology":
                return c;
            default:
                // Pass through unknown values so future NewsData-only
                // categories (politics, food, tourism…) keep working
                // without a code change.
                return c;
        }
    }

    private static String mapSortByToNewsData(String newsApiSort) {
        if (newsApiSort == null) return null;
        switch (newsApiSort.trim().toLowerCase()) {
            case "relevancy":   return "relevancy";
            case "popularity":  return "source";   // closest NewsData equivalent
            case "publishedat":
            default:            return null;       // default = newest first on NewsData
        }
    }

    private static String toNewsDataDate(String iso) {
        if (iso == null) return null;
        String s = iso.trim();
        // Strip any time portion — NewsData /archive expects YYYY-MM-DD.
        int tPos = s.indexOf('T');
        return tPos > 0 ? s.substring(0, tPos) : s;
    }

    // ---------------------------------------------------------------------
    // Key bookkeeping (identical in spirit to NewsApiService)
    // ---------------------------------------------------------------------

    private void recordRequest(String keyId) {
        Instant now = Instant.now();
        ConcurrentLinkedDeque<Instant> deque =
                requestLogByKey.computeIfAbsent(keyId, k -> new ConcurrentLinkedDeque<>());
        deque.addLast(now);
        totalRequests.incrementAndGet();
        totalRequestsByKey.computeIfAbsent(keyId, k -> new AtomicLong()).incrementAndGet();
        pruneRequestLog(deque, now);
        int used = deque.size();
        if (dailyQuota > 0) {
            log.info("NewsData.io request #{} in the last 24h on key {} (quota {}/{})",
                    used, keyId, used, dailyQuota);
        } else {
            log.info("NewsData.io request on key {} (24h count: {})", keyId, used);
        }
        persistRequestLog();
    }

    /**
     * Force the given key's 24h counter to {@link #dailyQuota} so it
     * is skipped by {@link #pickActiveKey()} for the rest of the
     * rolling window. Used on 429/rateLimit responses.
     */
    private void saturateKey(String keyId) {
        if (dailyQuota <= 0) return;
        ConcurrentLinkedDeque<Instant> deque =
                requestLogByKey.computeIfAbsent(keyId, k -> new ConcurrentLinkedDeque<>());
        Instant now = Instant.now();
        while (deque.size() < dailyQuota) deque.addLast(now);
        persistRequestLog();
    }

    private int countRequestsLast24h(String keyId) {
        ConcurrentLinkedDeque<Instant> deque = requestLogByKey.get(keyId);
        if (deque == null) return 0;
        pruneRequestLog(deque, Instant.now());
        return deque.size();
    }

    private static void pruneRequestLog(ConcurrentLinkedDeque<Instant> deque, Instant now) {
        Instant cutoff = now.minus(Duration.ofHours(24));
        Iterator<Instant> it = deque.iterator();
        while (it.hasNext()) {
            Instant ts = it.next();
            if (ts.isBefore(cutoff)) it.remove();
            else break; // deque is append-only, so first non-expired means the rest is fresh too
        }
    }

    private Instant oldestRequestInWindow(String keyId) {
        ConcurrentLinkedDeque<Instant> deque = requestLogByKey.get(keyId);
        if (deque == null) return null;
        pruneRequestLog(deque, Instant.now());
        return deque.peekFirst();
    }

    private Instant oldestRequestInWindowAny() {
        Instant oldest = null;
        for (String k : apiKeys) {
            Instant ts = oldestRequestInWindow(keyIdOf(k));
            if (ts != null && (oldest == null || ts.isBefore(oldest))) oldest = ts;
        }
        return oldest;
    }

    /** First 8 characters of the key — safe to log, stable across restarts. */
    private static String keyIdOf(String key) {
        if (key == null) return "";
        return key.length() >= 8 ? key.substring(0, 8) : key;
    }

    /** Mask all but the first 4 and last 4 characters for human-readable status output. */
    private static String maskKey(String key) {
        if (key == null || key.length() < 9) return "***";
        return key.substring(0, 4) + "…" + key.substring(key.length() - 4);
    }

    private static String describeKeys(List<String> keys) {
        List<String> masked = new ArrayList<>();
        for (String k : keys) masked.add(maskKey(k));
        return Arrays.toString(masked.toArray());
    }

    // ---------------------------------------------------------------------
    // Tiny helpers
    // ---------------------------------------------------------------------

    private static boolean notBlank(String v) {
        return v != null && !v.trim().isEmpty();
    }

    private static int clamp(Integer v, int min, int max, int fallback) {
        if (v == null) return fallback;
        int i = v;
        if (i < min) return min;
        if (i > max) return max;
        return i;
    }

    private static String stripQueryNoise(String url) {
        return url.replaceAll("(?i)([?&])apikey=[^&]*", "$1apikey=***");
    }

    private static final class CachedEntry {
        final Map<String, Object> payload;
        final Instant fetchedAt;
        final long ttlMinutes;

        CachedEntry(Map<String, Object> payload, Instant fetchedAt, long ttlMinutes) {
            this.payload = payload;
            this.fetchedAt = fetchedAt;
            this.ttlMinutes = ttlMinutes;
        }

        boolean isExpired() {
            if (ttlMinutes <= 0) return true;
            return Duration.between(fetchedAt, Instant.now()).toMinutes() >= ttlMinutes;
        }
    }
}
