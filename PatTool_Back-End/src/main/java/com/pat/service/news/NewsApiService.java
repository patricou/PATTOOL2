package com.pat.service.news;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.service.AppParameterService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
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

    /**
     * Legacy single-key property. Still read for backward compatibility and
     * merged into {@link #apiKeys} at {@link #init()} time (at position 0 if
     * not already present).
     */
    @Value("${newsapi.api.key:}")
    private String legacyApiKey;

    /**
     * Ordered list of NewsAPI keys. The service tries them top-to-bottom:
     * as soon as one exhausts its per-24h quota (locally tracked) or NewsAPI
     * answers {@code 429 rateLimited}, the service transparently switches to
     * the next key and retries the same request.
     *
     * Spring's property binding parses comma-separated values automatically
     * when the target is a {@code List<String>}.
     */
    @Value("${newsapi.api.keys:}")
    private List<String> configuredApiKeys;

    /** Effective list built from {@link #legacyApiKey} + {@link #configuredApiKeys}. */
    private List<String> apiKeys = Collections.emptyList();

    @Value("${newsapi.cache.ttl.minutes:5}")
    private long cacheTtlMinutes;

    /**
     * Longer TTL applied to empty {@code /top-headlines} responses. A
     * country with no /top-headlines coverage (Peru, Lebanon, Finland…)
     * will otherwise burn 2 NewsAPI slots every {@link #cacheTtlMinutes}
     * minutes (one for the empty /top-headlines, one for the /everything
     * fallback). With a 60-minute TTL on the empty payload, the
     * frontend's cold-cache pair of calls collapses to roughly 1 call
     * every hour instead of every 5 minutes.
     */
    @Value("${newsapi.cache.ttl.empty.minutes:60}")
    private long cacheTtlEmptyMinutes;

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
     * Rolling 24h request log, now keyed by {@link #keyIdOf(String) keyId}
     * so each configured NewsAPI key gets its own quota counter.
     * Entries older than 24h are pruned on every access.
     */
    private final Map<String, ConcurrentLinkedDeque<Instant>> requestLogByKey = new ConcurrentHashMap<>();

    /** Cumulative count since the app started (never pruned), across all keys. */
    private final AtomicLong totalRequests = new AtomicLong();

    /** Per-key cumulative counters since startup (never pruned). */
    private final Map<String, AtomicLong> totalRequestsByKey = new ConcurrentHashMap<>();

    /**
     * Legacy persistence key (pre-multi-key). Plain JSON array of ISO-8601
     * instants for the single configured key. Read once at startup for
     * migration and then left untouched.
     */
    private static final String PARAM_KEY_REQUEST_LOG_V1 = "newsapi.requests.log.v1";

    /**
     * Current persistence key. JSON object mapping {@code keyId} (first 8
     * chars of the NewsAPI key) to an array of ISO-8601 instants. Bump the
     * {@code vN} suffix if the value shape ever changes.
     */
    private static final String PARAM_KEY_REQUEST_LOG = "newsapi.requests.log.v2";

    /** Shared JSON codec for the per-key request log. */
    private final ObjectMapper jsonMapper = new ObjectMapper();

    /** DB-backed storage so the counter survives backend restarts. */
    @Autowired
    private AppParameterService appParameterService;

    public NewsApiService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    @jakarta.annotation.PostConstruct
    private void init() {
        this.apiKeys = buildKeyList(legacyApiKey, configuredApiKeys);
        if (apiKeys.isEmpty()) {
            log.warn("NewsAPI keys are empty or not configured (newsapi.api.keys / newsapi.api.key).");
        } else {
            log.info("NewsAPI keys loaded: {} key(s) configured — {}",
                    apiKeys.size(), describeKeys(apiKeys));
            for (String k : apiKeys) {
                String kid = keyIdOf(k);
                requestLogByKey.computeIfAbsent(kid, x -> new ConcurrentLinkedDeque<>());
                totalRequestsByKey.computeIfAbsent(kid, x -> new AtomicLong());
            }
        }
        hydrateRequestLogFromDb();
    }

    /**
     * Merge the legacy single-key property and the multi-key list into one
     * ordered, de-duplicated list. Legacy key (if present) wins position 0
     * so existing deployments behave identically until a second key is added.
     */
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

    /**
     * Rebuild the in-memory per-key {@link #requestLogByKey} from its
     * persisted copy so the 24h counters are accurate right after a
     * backend restart.
     *
     * Priority:
     *  1. v2 entry (map keyed by keyId) — the current shape.
     *  2. v1 entry (flat array) — legacy, migrated into the first
     *     configured key's bucket and re-persisted as v2.
     *  3. Neither — seed an empty v2 row so the collection materializes.
     */
    private void hydrateRequestLogFromDb() {
        try {
            String rawV2 = appParameterService.getString(PARAM_KEY_REQUEST_LOG, null);
            if (rawV2 != null && !rawV2.isEmpty()) {
                Map<String, List<Instant>> parsed = parseJsonInstantMap(rawV2);
                Instant cutoff = Instant.now().minus(Duration.ofHours(24));
                int loaded = 0, total = 0;
                for (Map.Entry<String, List<Instant>> e : parsed.entrySet()) {
                    ConcurrentLinkedDeque<Instant> deque =
                            requestLogByKey.computeIfAbsent(e.getKey(), x -> new ConcurrentLinkedDeque<>());
                    for (Instant t : e.getValue()) {
                        total++;
                        if (t != null && !t.isBefore(cutoff)) {
                            deque.addLast(t);
                            loaded++;
                        }
                    }
                }
                log.info("NewsAPI request log: restored {} entries across {} key(s) from the last 24h (out of {} persisted).",
                        loaded, parsed.size(), total);
                if (loaded != total) persistRequestLog();
                return;
            }

            // v1 → v2 migration. Only attempted once (after migration v1
            // remains but is ignored because v2 now exists).
            String rawV1 = appParameterService.getString(PARAM_KEY_REQUEST_LOG_V1, null);
            if (rawV1 != null && !rawV1.isEmpty() && !apiKeys.isEmpty()) {
                List<Instant> legacyList = parseJsonInstantArray(rawV1);
                Instant cutoff = Instant.now().minus(Duration.ofHours(24));
                String firstKeyId = keyIdOf(apiKeys.get(0));
                ConcurrentLinkedDeque<Instant> deque =
                        requestLogByKey.computeIfAbsent(firstKeyId, x -> new ConcurrentLinkedDeque<>());
                int loaded = 0;
                for (Instant t : legacyList) {
                    if (t != null && !t.isBefore(cutoff)) {
                        deque.addLast(t);
                        loaded++;
                    }
                }
                log.info("NewsAPI request log: migrated {} v1 entries into key {} (of {} persisted). v2 persisted now.",
                        loaded, firstKeyId, legacyList.size());
                persistRequestLog();
                return;
            }

            log.info("NewsAPI request log: no persisted entries found, creating empty seed row.");
            persistRequestLog();
        } catch (Exception e) {
            // Never fail startup because of a corrupted parameter blob.
            log.warn("NewsAPI request log: failed to restore from DB, starting fresh. Reason: {}", e.getMessage());
        }
    }

    // ---------------------------------------------------------------------
    // NewsProvider implementation
    // ---------------------------------------------------------------------

    @Override
    public Map<String, Object> getTopHeadlines(String country, String category, String query,
                                               Integer pageSize, Integer page) {
        Map<String, Object> keyMissing = missingKeys();
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
        Map<String, Object> keyMissing = missingKeys();
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
        Map<String, Object> keyMissing = missingKeys();
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
        boolean configured = !apiKeys.isEmpty();
        status.put("configured", configured);
        status.put("cacheTtlMinutes", cacheTtlMinutes);
        status.put("cacheEntries", cache.size());
        status.put("tickerEnabledDefault", tickerEnabledDefault);
        status.put("defaultCountry", defaultCountry == null ? "" : defaultCountry.toLowerCase());
        status.put("defaultLanguage", defaultLanguage == null ? "" : defaultLanguage.toLowerCase());

        // Aggregate quota counters across every configured key — kept for
        // backward compatibility with the existing frontend. {@code quotaDaily}
        // is the per-key quota; {@code totalQuotaDaily} is the sum (useful
        // when the user wants a single big "300/day" gauge).
        int aggUsed = 0;
        for (String k : apiKeys) aggUsed += countRequestsLast24h(keyIdOf(k));
        status.put("requestsLast24h", aggUsed);
        status.put("quotaDaily", dailyQuota);
        status.put("totalQuotaDaily", dailyQuota * apiKeys.size());
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

        // Per-key breakdown. {@code active=true} marks the key that will be
        // used for the next uncached request (first one with headroom).
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
            status.put("message", "API keys are not configured (newsapi.api.keys / newsapi.api.key).");
            return status;
        }

        // Availability check.
        //
        // The simple (and NewsAPI-expensive) approach is to probe
        // /top-headlines?country=us&pageSize=1 every time. That burns
        // one quota slot per cache expiry (5 min by default), which
        // on a page where the user refreshes the status badge every
        // so often is a non-trivial chunk of the 100/day free tier.
        //
        // Cheaper and equally informative:
        //   1. If we have AT LEAST ONE successful request in the
        //      rolling 24h log, NewsAPI is clearly reachable AND
        //      accepting our keys — no probe needed.
        //   2. Otherwise, if the probe URL is already in the cache
        //      (warm from a previous /status call), reuse it for free.
        //   3. Only as a true cold-start fallback do we actually fire
        //      the probe. In that case it's a single call every time
        //      the cache expires, not once per status refresh.
        if (aggUsed > 0) {
            status.put("status", "available");
            return status;
        }
        String probeUrl = UriComponentsBuilder.fromHttpUrl(baseUrl + "/top-headlines")
                .queryParam("country", "us")
                .queryParam("pageSize", 1)
                .toUriString();
        CachedEntry cachedProbe = cache.get(probeUrl);
        if (cachedProbe != null && !cachedProbe.isExpired()) {
            status.put("status", "available");
            Object ts = cachedProbe.payload.get("totalResults");
            if (ts != null) status.put("probeTotalResults", ts);
            return status;
        }
        Map<String, Object> probe = call(probeUrl);
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
        int agg = 0;
        for (String k : apiKeys) agg += countRequestsLast24h(keyIdOf(k));
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("cleared", before);
        result.put("requestsLast24h", agg);
        return result;
    }

    // ---------------------------------------------------------------------
    // HTTP + cache plumbing
    // ---------------------------------------------------------------------

    private Map<String, Object> missingKeys() {
        if (apiKeys.isEmpty()) {
            log.error("NewsAPI keys are not configured!");
            Map<String, Object> err = new HashMap<>();
            err.put("error", "News API keys are not configured. Please set newsapi.api.keys in application.properties");
            return err;
        }
        return null;
    }

    /**
     * Execute the GET, using the TTL cache when possible, with automatic
     * fail-over across {@link #apiKeys}.
     *
     * Algorithm:
     *  1. Serve a fresh cache hit straight away (no key consumed).
     *  2. Pick the first key whose 24h counter is below {@code dailyQuota}.
     *  3. Call NewsAPI with that key.
     *  4. If NewsAPI answers {@code 429 rateLimited} (or the equivalent 200
     *     OK logical error with {@code code=rateLimited}), mark the key as
     *     saturated for the rest of the 24h window and try the next key.
     *  5. Any other error (401, 400, network…) is returned immediately —
     *     it won't get better by switching keys.
     */
    private Map<String, Object> call(String url) {
        CachedEntry cached = cache.get(url);
        if (cached != null && !cached.isExpired()) {
            log.debug("NewsAPI cache HIT: {}", stripQueryNoise(url));
            return cached.payload;
        }
        log.debug("NewsAPI cache MISS: {}", stripQueryNoise(url));

        Map<String, Object> lastError = null;
        // Attempt each key in order. We loop at most apiKeys.size() times
        // so a transient issue never turns into an infinite retry storm.
        for (int attempt = 0; attempt < apiKeys.size(); attempt++) {
            String key = pickActiveKey();
            if (key == null) {
                Map<String, Object> err = new HashMap<>();
                err.put("error", "NewsAPI quota exhausted on every configured key for the rolling 24h window.");
                err.put("code", "allKeysRateLimited");
                return lastError != null ? lastError : err;
            }
            Map<String, Object> result = doCall(url, key);
            if (result.containsKey("__rateLimited")) {
                // Key just hit its quota. Mark it saturated and try the next one.
                lastError = new HashMap<>(result);
                lastError.remove("__rateLimited");
                saturateKey(keyIdOf(key));
                log.warn("NewsAPI key {} hit the rate limit — failing over to next key.", keyIdOf(key));
                continue;
            }
            return result;
        }
        // All keys exhausted in a row (fully saturated).
        Map<String, Object> err = new HashMap<>();
        err.put("error", "NewsAPI quota exhausted on every configured key.");
        err.put("code", "allKeysRateLimited");
        return lastError != null ? lastError : err;
    }

    /**
     * Perform a single HTTP GET with the given key. Returns either the
     * decoded body (success), or an error map. Rate-limit failures are
     * flagged with a transient {@code "__rateLimited"} entry so the outer
     * {@link #call(String)} loop knows it should try the next key.
     */
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

            // Some "200 OK" responses from NewsAPI still wrap a logical error
            // ({@code {"status":"error","code":"...","message":"..."}}). Treat
            // those as failures too: surface the error to the caller AND do
            // NOT record the call in the 24h counter.
            if (isProviderError(body)) {
                log.warn("NewsAPI logical error (key {}): {}", keyIdOf(key), body);
                Map<String, Object> err = new HashMap<>();
                err.put("error", "NewsAPI error: " + body.getOrDefault("message", body.getOrDefault("code", "unknown")));
                err.put("providerMessage", body.toString());
                if (isRateLimitedCode(body.get("code"))) {
                    err.put("__rateLimited", Boolean.TRUE);
                }
                return err;
            }

            long ttl = effectiveCacheTtl(url, body);
            cache.put(url, new CachedEntry(body, Instant.now(), ttl));
            recordRequest(keyIdOf(key));
            return body;
        } catch (HttpClientErrorException e) {
            // 429 / 401 / 400 / ... the request reached NewsAPI but came back
            // as an error. We deliberately do NOT bump the 24h counter: only
            // successful calls are counted.
            log.warn("NewsAPI HTTP error (key {}, {}): {}",
                    keyIdOf(key), e.getStatusCode(), e.getResponseBodyAsString());
            Map<String, Object> err = new HashMap<>();
            err.put("error", "NewsAPI HTTP " + e.getStatusCode() + ": " + e.getStatusText());
            String body = null;
            try {
                body = e.getResponseBodyAsString();
                if (body != null && !body.isEmpty()) err.put("providerMessage", body);
            } catch (Exception ignore) { /* noop */ }
            // Trigger fail-over on 429 or on any payload carrying a rateLimited code.
            if (e.getStatusCode() == HttpStatus.TOO_MANY_REQUESTS
                    || (body != null && body.toLowerCase().contains("ratelimited"))) {
                err.put("__rateLimited", Boolean.TRUE);
            }
            return err;
        } catch (Exception e) {
            log.error("Error calling NewsAPI (key {}): ", keyIdOf(key), e);
            Map<String, Object> err = new HashMap<>();
            err.put("error", "Failed to call NewsAPI: " + e.getMessage());
            return err;
        }
    }

    /**
     * NewsAPI sometimes returns 200 OK with a logical error body. Detect
     * that here so we can treat it exactly like an HTTP error.
     */
    private static boolean isProviderError(Map<String, Object> body) {
        if (body == null) return false;
        Object status = body.get("status");
        return status != null && "error".equalsIgnoreCase(status.toString());
    }

    /** True when a NewsAPI {@code code} field signals a quota-exhaustion condition. */
    private static boolean isRateLimitedCode(Object code) {
        if (code == null) return false;
        String s = code.toString().toLowerCase();
        return s.contains("ratelimited") || s.equals("maximumresultsreached");
    }

    /**
     * Append the current instant to the given key's rolling log and prune
     * anything older than 24h. Also bumps the lifetime counters (global and
     * per-key). Called once per SUCCESSFUL cache-miss response (2xx AND not a
     * logical NewsAPI error body). Failed calls (HTTP 4xx/5xx, network
     * errors, provider errors returned as 200 OK) are NOT counted.
     */
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
            log.info("NewsAPI request #{} in the last 24h on key {} (quota {}/{})",
                    used, keyId, used, dailyQuota);
        } else {
            log.info("NewsAPI request #{} in the last 24h on key {}", used, keyId);
        }
        persistRequestLog();
    }

    /**
     * Push enough {@link Instant#now()} timestamps into the given key's
     * deque so that its per-24h counter reaches {@link #dailyQuota}. Used
     * when NewsAPI just told us the key is rate-limited: we want the next
     * {@link #pickActiveKey()} call to skip it immediately without waiting
     * for our local counter to catch up.
     */
    private void saturateKey(String keyId) {
        if (dailyQuota <= 0) return;
        ConcurrentLinkedDeque<Instant> deque =
                requestLogByKey.computeIfAbsent(keyId, k -> new ConcurrentLinkedDeque<>());
        Instant now = Instant.now();
        pruneRequestLog(deque, now);
        while (deque.size() < dailyQuota) deque.addLast(now);
        persistRequestLog();
    }

    /**
     * Serialize the full per-key log map to JSON and upsert it in
     * {@code appParameters}. Cheap enough (≤ a few KB) to be safe to call
     * on every successful request.
     */
    private void persistRequestLog() {
        try {
            Map<String, List<String>> wire = new LinkedHashMap<>();
            for (Map.Entry<String, ConcurrentLinkedDeque<Instant>> e : requestLogByKey.entrySet()) {
                List<String> list = new ArrayList<>(e.getValue().size());
                for (Instant i : e.getValue()) list.add(i.toString());
                wire.put(e.getKey(), list);
            }
            String json = jsonMapper.writeValueAsString(wire);
            appParameterService.setJson(
                    PARAM_KEY_REQUEST_LOG,
                    json,
                    "Rolling 24h log of successful NewsAPI requests, keyed by first-8-chars of each API key.");
        } catch (Exception e) {
            // Persistence is best-effort: the in-memory counters are still
            // correct for this session even if the DB write fails.
            log.warn("NewsAPI request log: failed to persist to DB. Reason: {}", e.getMessage());
        }
    }

    /**
     * Parse the v2 JSON shape {@code {"<keyId>": ["iso", ...], ...}} into a
     * usable map. Lenient: malformed entries are skipped rather than fatal.
     */
    private Map<String, List<Instant>> parseJsonInstantMap(String json) {
        Map<String, List<Instant>> out = new LinkedHashMap<>();
        if (json == null || json.trim().isEmpty()) return out;
        try {
            Map<String, List<String>> raw = jsonMapper.readValue(
                    json, new TypeReference<Map<String, List<String>>>() {});
            if (raw == null) return out;
            for (Map.Entry<String, List<String>> e : raw.entrySet()) {
                List<Instant> list = new ArrayList<>();
                if (e.getValue() != null) {
                    for (String s : e.getValue()) {
                        if (s == null) continue;
                        try { list.add(Instant.parse(s)); }
                        catch (DateTimeParseException ignore) { /* skip bad entry */ }
                    }
                }
                out.put(e.getKey(), list);
            }
        } catch (Exception e) {
            log.warn("NewsAPI request log (v2): could not parse persisted JSON: {}", e.getMessage());
        }
        return out;
    }

    /**
     * Legacy v1 parser: {@code ["2026-04-16T10:14:32Z", ...]} → list of
     * Instants. Kept solely for the one-time v1→v2 migration on startup.
     */
    private static List<Instant> parseJsonInstantArray(String json) {
        List<Instant> out = new ArrayList<>();
        if (json == null) return out;
        String trimmed = json.trim();
        if (trimmed.isEmpty() || trimmed.equals("[]")) return out;
        if (trimmed.charAt(0) != '[' || trimmed.charAt(trimmed.length() - 1) != ']') return out;
        String body = trimmed.substring(1, trimmed.length() - 1);
        if (body.trim().isEmpty()) return out;
        for (String raw : body.split(",")) {
            String s = raw.trim();
            if (s.length() < 2) continue;
            if (s.charAt(0) == '"') s = s.substring(1);
            if (!s.isEmpty() && s.charAt(s.length() - 1) == '"') s = s.substring(0, s.length() - 1);
            try {
                out.add(Instant.parse(s));
            } catch (DateTimeParseException ex) {
                // ignore malformed entries
            }
        }
        return out;
    }

    /** Drop every timestamp older than 24 hours from the given deque. */
    private static void pruneRequestLog(ConcurrentLinkedDeque<Instant> deque, Instant now) {
        Instant cutoff = now.minus(Duration.ofHours(24));
        Iterator<Instant> it = deque.iterator();
        while (it.hasNext()) {
            if (it.next().isBefore(cutoff)) {
                it.remove();
            } else {
                // Timestamps are appended in order, so stop at first fresh one.
                break;
            }
        }
    }

    /** Current count of NewsAPI requests made in the last 24 hours for a single key. */
    private int countRequestsLast24h(String keyId) {
        ConcurrentLinkedDeque<Instant> deque = requestLogByKey.get(keyId);
        if (deque == null) return 0;
        pruneRequestLog(deque, Instant.now());
        return deque.size();
    }

    /** Instant of the oldest request still inside the 24h window for a single key. */
    private Instant oldestRequestInWindow(String keyId) {
        ConcurrentLinkedDeque<Instant> deque = requestLogByKey.get(keyId);
        if (deque == null) return null;
        pruneRequestLog(deque, Instant.now());
        return deque.peekFirst();
    }

    /** Oldest request instant across ALL keys (the earliest-expiring slot overall). */
    private Instant oldestRequestInWindowAny() {
        Instant oldest = null;
        for (String k : apiKeys) {
            Instant o = oldestRequestInWindow(keyIdOf(k));
            if (o != null && (oldest == null || o.isBefore(oldest))) oldest = o;
        }
        return oldest;
    }

    /**
     * First key whose 24h counter is strictly below {@link #dailyQuota}.
     * Returns {@code null} when every key is saturated — the caller treats
     * this as an "all keys exhausted" error.
     */
    private String pickActiveKey() {
        if (apiKeys.isEmpty()) return null;
        if (dailyQuota <= 0) return apiKeys.get(0); // no per-key quota tracking
        for (String k : apiKeys) {
            if (countRequestsLast24h(keyIdOf(k)) < dailyQuota) return k;
        }
        return null;
    }

    /**
     * Stable short identifier for a NewsAPI key, safe to log and store in
     * the DB. Uses the first 8 characters: NewsAPI keys are 32-hex strings,
     * so 8 chars is more than enough to tell two keys apart without ever
     * exposing the full secret.
     */
    private static String keyIdOf(String key) {
        if (key == null) return "";
        String k = key.trim();
        return k.length() <= 8 ? k : k.substring(0, 8);
    }

    /** Fully masked key for UI display: {@code "749a****ba27"}. */
    private static String maskKey(String key) {
        if (key == null) return "";
        String k = key.trim();
        if (k.length() <= 8) return "****";
        String head = k.substring(0, 4);
        String tail = k.substring(k.length() - 4);
        return head + "****" + tail;
    }

    /** Debug helper for startup logs: "[749a****ba27, 8bcd****ef90]". */
    private static String describeKeys(List<String> keys) {
        return Arrays.toString(keys.stream().map(NewsApiService::maskKey).toArray());
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

    /**
     * Decide how long the given response should stay in the cache.
     *
     * Rule: an empty {@code /top-headlines} body (which typically means
     * the country is not covered by NewsAPI's /top-headlines endpoint —
     * Peru, Lebanon, Finland…) is cached for a much longer window, so
     * the client-side fallback to /everything doesn't re-probe the same
     * empty country every {@link #cacheTtlMinutes} minutes. Any other
     * payload uses the default TTL.
     */
    private long effectiveCacheTtl(String url, Map<String, Object> body) {
        if (url != null && url.contains("/top-headlines") && !url.contains("/sources")
                && isEmptyArticlesPayload(body)) {
            return Math.max(cacheTtlMinutes, cacheTtlEmptyMinutes);
        }
        return cacheTtlMinutes;
    }

    /**
     * True when a NewsAPI articles response carries no articles (either
     * because the list is missing, not an array, or empty). Works on
     * both {@code /top-headlines} and {@code /everything} shapes.
     */
    private static boolean isEmptyArticlesPayload(Map<String, Object> body) {
        if (body == null) return false;
        Object articles = body.get("articles");
        if (articles instanceof List) {
            return ((List<?>) articles).isEmpty();
        }
        Object total = body.get("totalResults");
        if (total instanceof Number) {
            return ((Number) total).intValue() == 0;
        }
        return false;
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
