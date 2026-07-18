package com.pat.service;

import com.pat.config.RestTemplateConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import jakarta.annotation.PostConstruct;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import javax.imageio.ImageIO;
import javax.xml.parsers.DocumentBuilderFactory;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatterBuilder;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Proxy for Météo-France AROME-PI nowcasting (0–6 h UI horizon, 15 min steps) via WMS GetMap.
 * Domains: France 0.01° and France 0.025°. Supports TIME, dim_reference_time, ELEVATION.
 * Point forecast numeric values use Open-Meteo {@code meteofrance_seamless} minutely_15
 * (MF WMS does not expose GetFeatureInfo text).
 * API « AROMEPI 1.0 » on portail-api.meteofrance.fr — requires {@code meteofrance.aromepi.api.token}.
 */
@Service
public class MeteoFranceAromepiService {

    private static final Logger log = LoggerFactory.getLogger(MeteoFranceAromepiService.class);

    /** PatTool display / playback horizon (0–6 h). */
    private static final int FORECAST_HORIZON_MINUTES = 360;
    private static final int FORECAST_STEP_MINUTES = 15;
    private static final int FORECAST_MIN_OFFSET_MINUTES = 15;

    private static final String DEFAULT_BASE = "https://public-api.meteofrance.fr/public/aromepi/1.0";
    private static final String WMS_001 = "MF-NWP-HIGHRES-AROMEPI-001-FRANCE-WMS";
    private static final String WMS_0025 = "MF-NWP-HIGHRES-AROMEPI-0025-FRANCE-WMS";
    private static final String DOMAIN_001 = "001-FRANCE";
    private static final String DOMAIN_0025 = "0025-FRANCE";
    private static final String DEFAULT_WMS_SERVICE = WMS_001;
    private static final Duration CAPABILITIES_CACHE_TTL_FALLBACK = Duration.ofMinutes(10);
    /** Fallback when preference service unavailable — overridden by meteofrance.forecast.cache.minutes (default 5). */
    private static final Duration FORECAST_CACHE_TTL_FALLBACK = Duration.ofMinutes(5);
    private static final int TILE_CACHE_MAX_ENTRIES = 8192;
    private static final int WMS_MAX_RETRIES = 3;
    private static final long WMS_RETRY_BASE_MS = 450L;
    private static final Pattern LAYER_SAFE = Pattern.compile("^[A-Za-z0-9_\\-]+$");
    private static final Pattern STYLE_SAFE = Pattern.compile("^[A-Za-z0-9_\\-]+$");
    private static final Pattern ISO_TIME = Pattern.compile(
            "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?(\\.\\d+)?Z$");

    private static final String OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
    private static final DateTimeFormatter OPEN_METEO_MINUTELY_FMT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm").withZone(ZoneOffset.UTC);

    private static final List<String> PREFERRED_LAYER_ORDER = List.of(
            "TOTAL_WATER_PRECIPITATION__GROUND_OR_WATER_SURFACE",
            "TEMPERATURE__GROUND_OR_WATER_SURFACE",
            "RELATIVE_HUMIDITY__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
            "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
            "VISIBILITY_MINI_15MIN__GROUND_OR_WATER_SURFACE",
            "CONVECTIVE_AVAILABLE_POTENTIAL_ENERGY__GROUND_OR_WATER_SURFACE",
            "NEBUL__GROUND_OR_WATER_SURFACE",
            "RELATIVE_HUMIDITY__GROUND_OR_WATER_SURFACE",
            "WIND_SPEED__GROUND_OR_WATER_SURFACE",
            "VISIBILITY__GROUND_OR_WATER_SURFACE"
    );

    private final RestTemplate restTemplate;
    private final MeteoFranceForecastCachePreferenceService forecastCachePreferenceService;
    private final String apiToken;
    private final String baseUrl;
    private final String wmsService;
    private final long wmsMinIntervalMs;

    /** Capabilities cache keyed by WMS service id (001-FRANCE / 0025-FRANCE). */
    private final ConcurrentHashMap<String, CachedCapabilities> capabilitiesByService = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CachedMinutely15> minutely15Cache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CachedTile> tileCache = new ConcurrentHashMap<>();
    private final Semaphore wmsFetchSemaphore;
    /**
     * Upstream (Météo-France) throttling window: when we receive 429, pause all
     * subsequent WMS calls until this instant to avoid hammering the quota.
     */
    private volatile long wmsBackoffUntilMs = 0L;
    /** Next time (ms) a WMS request is allowed to start (global pacing). */
    private final AtomicLong nextWmsAllowedAtMs = new AtomicLong(0L);
    /** Recent tile HIT/MISS flags for UI map badge (majority of last N serves). */
    private static final int TILE_CACHE_HINT_WINDOW = 24;
    private final ConcurrentLinkedDeque<Boolean> recentTileCacheFlags = new ConcurrentLinkedDeque<>();
    private final AtomicBoolean lastCapabilitiesFromCache = new AtomicBoolean(false);

    public MeteoFranceAromepiService(
            @Qualifier(RestTemplateConfig.METEOFRANCE_CLIM_REST_TEMPLATE) RestTemplate restTemplate,
            MeteoFranceForecastCachePreferenceService forecastCachePreferenceService,
            @Value("${meteofrance.aromepi.api.token:}") String apiToken,
            @Value("${meteofrance.aromepi.base.url:" + DEFAULT_BASE + "}") String baseUrl,
            @Value("${meteofrance.aromepi.wms.service:" + DEFAULT_WMS_SERVICE + "}") String wmsService,
            @Value("${meteofrance.aromepi.wms.max.concurrent:2}") int wmsMaxConcurrent,
            @Value("${meteofrance.aromepi.wms.min-interval-ms:300}") long wmsMinIntervalMs) {
        this.restTemplate = restTemplate;
        this.forecastCachePreferenceService = forecastCachePreferenceService;
        this.apiToken = normalizeToken(apiToken);
        this.baseUrl = baseUrl != null && !baseUrl.isBlank()
                ? baseUrl.trim().replaceAll("/+$", "")
                : DEFAULT_BASE;
        this.wmsService = wmsService != null && !wmsService.isBlank()
                ? wmsService.trim()
                : DEFAULT_WMS_SERVICE;
        this.wmsMinIntervalMs = Math.max(0L, wmsMinIntervalMs);
        this.wmsFetchSemaphore = new Semaphore(Math.max(1, wmsMaxConcurrent), true);
        if (isConfigured()) {
            log.info("Météo-France AROME-PI credentials loaded (wms={})", this.wmsService);
        } else {
            log.info("Météo-France AROME-PI not configured — set meteofrance.aromepi.api.token "
                    + "(API « AROMEPI 1.0 » on portail-api.meteofrance.fr)");
        }
    }

    /** Prefetch WMS GetCapabilities so the first AROME-PI tab open is not blocked on MF latency. */
    @PostConstruct
    public void warmCapabilitiesCacheAsync() {
        if (!isConfigured()) {
            return;
        }
        CompletableFuture.runAsync(() -> {
            try {
                loadCapabilities(wmsService);
                log.info("Météo-France AROME-PI WMS capabilities cache warmed ({})", wmsService);
            } catch (Exception e) {
                log.debug("Météo-France AROME-PI capabilities warm-up skipped: {}", e.getMessage());
            }
        });
    }

    public Map<String, Object> getStatusFragment() {
        Map<String, Object> status = new LinkedHashMap<>();
        boolean configured = isConfigured();
        status.put("aromepiConfigured", configured);
        status.put("aromepiAuthValid", false);
        status.put("aromepiWmsService", wmsService);
        status.put("aromepiBaseUrl", baseUrl);
        if (configured) {
            if (looksLikeTruncatedApiKey(apiToken)) {
                status.put("aromepiAuthValid", false);
                status.put("aromepiAuthError",
                        "AROME-PI API key looks truncated (expected a full JWT with 3 segments). "
                                + "Paste the complete token into meteofrance.aromepi.api.token, then restart the backend.");
            } else {
                boolean valid = probeAuth();
                status.put("aromepiAuthValid", valid);
                if (!valid) {
                    status.put("aromepiAuthError",
                            "Invalid credentials or missing subscription to API « AROMEPI 1.0 ». "
                                    + "Use meteofrance.aromepi.api.token.");
                }
            }
        }
        status.put("aromepiEndpoints", List.of(
                "/api/external/meteofrance/aromepi/capabilities",
                "/api/external/meteofrance/aromepi/wms/{z}/{x}/{y}",
                "/api/external/meteofrance/aromepi/featureinfo",
                "/api/external/meteofrance/aromepi/point-forecast"
        ));
        status.putAll(getThrottleStatus());
        return status;
    }

    /** Lightweight throttle status for the UI (no upstream call). */
    public Map<String, Object> getThrottleStatus() {
        return getThrottleStatus(false);
    }

    /**
     * @param resetTileHint when true, clears the recent HIT/MISS window so the next
     *                      map layer load is measured on its own (not mixed with older tiles).
     */
    public Map<String, Object> getThrottleStatus(boolean resetTileHint) {
        if (resetTileHint) {
            recentTileCacheFlags.clear();
        }
        Map<String, Object> status = new LinkedHashMap<>();
        long now = System.currentTimeMillis();
        long until = wmsBackoffUntilMs;
        boolean throttled = until > now;
        long retryAfterSec = throttled ? Math.max(1, Duration.ofMillis(until - now).toSeconds()) : 0;
        status.put("aromepiWmsThrottled", throttled);
        status.put("aromepiWmsRetryAfterSeconds", retryAfterSec);
        Boolean tilesCached = majorityTilesCached();
        status.put("aromepiTilesCacheKnown", tilesCached != null);
        status.put("aromepiTilesCached", tilesCached != null && tilesCached);
        status.put("aromepiCapabilitiesCached", lastCapabilitiesFromCache.get());
        status.put("forecastCacheTtlMinutes", forecastCacheTtl().toMinutes());
        return status;
    }

    public boolean isConfigured() {
        return !apiToken.isEmpty();
    }

    public Map<String, Object> getCapabilities() {
        return getCapabilities(null, null);
    }

    public Map<String, Object> getCapabilities(String domain, String referenceTime) {
        if (!isConfigured()) {
            return error("AROME-PI API key not configured. Set meteofrance.aromepi.api.token "
                    + "(API « AROMEPI 1.0 » on portail-api.meteofrance.fr)");
        }
        try {
            String service = resolveWmsService(domain);
            ParsedCapabilities parsed = loadCapabilities(service);
            String ref = normalizeReferenceTime(referenceTime, parsed);
            List<String> timeSteps = ref != null
                    ? generateTimeSteps(ref, FORECAST_HORIZON_MINUTES, FORECAST_STEP_MINUTES)
                    : parsed.timeSteps();
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("service", "AROMEPI");
            result.put("domain", domainIdForService(service));
            result.put("domains", List.of(
                    Map.of("id", DOMAIN_001, "label", "France 0.01°", "wmsService", WMS_001),
                    Map.of("id", DOMAIN_0025, "label", "France 0.025°", "wmsService", WMS_0025)
            ));
            result.put("resolution", service.contains("0025") ? "0.025" : "0.01");
            result.put("wmsService", service);
            result.put("bounds", parsed.bounds());
            result.put("referenceTimes", parsed.referenceTimes());
            result.put("defaultReferenceTime", ref != null ? ref : parsed.defaultReferenceTime());
            result.put("timeSteps", timeSteps);
            result.put("elevations", parsed.elevations());
            result.put("defaultElevation", parsed.defaultElevation());
            result.put("layers", parsed.layers());
            result.put("forecastHorizonMinutes", FORECAST_HORIZON_MINUTES);
            result.put("forecastStepMinutes", FORECAST_STEP_MINUTES);
            result.put("cached", lastCapabilitiesFromCache.get());
            result.put("cacheTtlMinutes", forecastCacheTtl().toMinutes());
            return result;
        } catch (HttpClientErrorException e) {
            if (e.getStatusCode() == HttpStatus.UNAUTHORIZED) {
                return error("AROME-PI API key rejected (401). Check meteofrance.aromepi.api.token.");
            }
            log.warn("AROME-PI GetCapabilities failed ({}): {}", e.getStatusCode(), e.getMessage());
            return error("GetCapabilities failed: HTTP " + e.getStatusCode().value());
        } catch (Exception e) {
            log.warn("AROME-PI GetCapabilities failed: {}", e.getMessage());
            return error("GetCapabilities failed: " + e.getMessage());
        }
    }

    public ResponseEntity<byte[]> getWmsTile(
            int z, int x, int y,
            String layer, String style,
            String time, String referenceTime,
            int width, int height) {
        return getWmsTile(z, x, y, layer, style, time, referenceTime, null, null, width, height);
    }

    public ResponseEntity<byte[]> getWmsTile(
            int z, int x, int y,
            String layer, String style,
            String time, String referenceTime,
            String domain,
            String elevation,
            int width, int height) {
        if (!isConfigured()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).build();
        }
        if (z < 0 || z > 18 || x < 0 || y < 0) {
            return ResponseEntity.badRequest().build();
        }
        if (width <= 0 || width > 1024 || height <= 0 || height > 1024) {
            return ResponseEntity.badRequest().build();
        }
        if (!isSafeLayer(layer) || (style != null && !style.isBlank() && !isSafeStyle(style))) {
            return ResponseEntity.badRequest().build();
        }
        if (!isValidIsoTime(time) || !isValidIsoTime(referenceTime)) {
            return ResponseEntity.badRequest().build();
        }
        String service = resolveWmsService(domain);
        time = normalizeForecastTime(time, referenceTime);
        String elev = normalizeElevation(elevation);

        int outWidth = width > 0 && width <= 1024 ? width : 256;
        int outHeight = height > 0 && height <= 1024 ? height : 256;
        String resolvedStyle = style != null && !style.isBlank() ? style.trim() : resolveDefaultStyle(layer, service);

        String cacheKey = tileCacheKey(service, z, x, y, layer, resolvedStyle, time, referenceTime, elev, outWidth, outHeight);
        CachedTile cachedTile = tileCache.get(cacheKey);
        if (cachedTile != null && cachedTile.isValid(forecastCacheTtl())) {
            // Serve memory cache even during upstream 429 backoff — avoids blank tiles for known frames.
            return pngTileResponse(cachedTile.png(), true);
        }

        ResponseEntity<byte[]> throttled = throttledResponseIfNeeded();
        if (throttled != null) {
            return throttled;
        }

        // WMS 1.3.0 + EPSG:4326: BBOX = minLat,minLon,maxLat,maxLon (MF AROME-PI documented usage).
        double[] bbox4326 = tileBbox4326(z, x, y);
        int[] wmsSize = wmsDimensionsForBbox(bbox4326, outWidth);
        int wmsWidth = wmsSize[0];
        int wmsHeight = wmsSize[1];

        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(wmsEndpoint(service, "GetMap"))
                .queryParam("SERVICE", "WMS")
                .queryParam("VERSION", "1.3.0")
                .queryParam("REQUEST", "GetMap")
                .queryParam("LAYERS", layer)
                .queryParam("STYLES", resolvedStyle)
                .queryParam("CRS", "EPSG:4326")
                .queryParam("BBOX", bbox4326[0] + "," + bbox4326[1] + "," + bbox4326[2] + "," + bbox4326[3])
                .queryParam("WIDTH", wmsWidth)
                .queryParam("HEIGHT", wmsHeight)
                .queryParam("FORMAT", "image/png")
                .queryParam("TRANSPARENT", "true")
                .queryParam("TIME", time)
                .queryParam("dim_reference_time", referenceTime);
        if (elev != null) {
            builder.queryParam("ELEVATION", elev);
        }
        String url = builder.build(true).toUriString();

        log.debug("AROME-PI GetMap URL: {}", url.replace(apiToken, "***"));
        try {
            byte[] raw = fetchWmsPngWithRetry(url);
            if (raw == null) {
                ResponseEntity<byte[]> again = throttledResponseIfNeeded();
                return again != null ? again : ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
            }
            byte[] scaled = resamplePng(raw, outWidth, outHeight);
            putTileCache(cacheKey, scaled);
            return pngTileResponse(scaled, false);
        } catch (HttpClientErrorException e) {
            if (e.getStatusCode() == HttpStatus.UNAUTHORIZED) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }
            if (e.getStatusCode() == HttpStatus.TOO_MANY_REQUESTS) {
                // Propagate 429 to the browser so it can stop retrying aggressively.
                ResponseEntity<byte[]> resp = throttledResponseIfNeeded();
                return resp != null ? resp : ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS).build();
            }
            log.warn("AROME-PI image fetch failed ({}): {} body={}",
                    e.getStatusCode(), e.getMessage(), truncateForLog(e.getResponseBodyAsByteArray(), 400));
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        } catch (HttpServerErrorException e) {
            log.warn("AROME-PI image fetch failed ({}): {} body={}",
                    e.getStatusCode(), e.getMessage(), truncateForLog(e.getResponseBodyAsByteArray(), 400));
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        } catch (Exception e) {
            log.warn("AROME-PI image fetch failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    private ResponseEntity<byte[]> pngTileResponse(byte[] png, boolean fromCache) {
        recordTileCacheFlag(fromCache);
        HttpHeaders out = new HttpHeaders();
        out.setContentType(MediaType.IMAGE_PNG);
        // Force every Leaflet tile request through the server so HIT/MISS is accurate for the UI badge.
        out.setCacheControl(CacheControl.noStore());
        out.set("X-Pat-Cache", fromCache ? "HIT" : "MISS");
        out.set("Access-Control-Expose-Headers", "X-Pat-Cache");
        return new ResponseEntity<>(png, out, HttpStatus.OK);
    }

    private void recordTileCacheFlag(boolean fromCache) {
        recentTileCacheFlags.addLast(fromCache);
        while (recentTileCacheFlags.size() > TILE_CACHE_HINT_WINDOW) {
            recentTileCacheFlags.pollFirst();
        }
    }

    /**
     * {@code null} when no tiles served yet in the current hint window.
     * Live if any recent tile was a MISS; Cache only when every recent tile was a HIT.
     */
    private Boolean majorityTilesCached() {
        if (recentTileCacheFlags.isEmpty()) {
            return null;
        }
        for (Boolean flag : recentTileCacheFlags) {
            if (!Boolean.TRUE.equals(flag)) {
                return false;
            }
        }
        return true;
    }

    private Duration forecastCacheTtl() {
        try {
            return forecastCachePreferenceService.resolveServerDuration();
        } catch (Exception e) {
            return FORECAST_CACHE_TTL_FALLBACK;
        }
    }

    private Duration capabilitiesCacheTtl() {
        Duration forecast = forecastCacheTtl();
        return forecast.compareTo(CAPABILITIES_CACHE_TTL_FALLBACK) < 0
                ? forecast
                : CAPABILITIES_CACHE_TTL_FALLBACK;
    }

    /** Clears in-memory AROME-PI forecast caches (tiles, capabilities, Open-Meteo point series). */
    public Map<String, Object> clearForecastCaches() {
        int tiles = tileCache.size();
        int caps = capabilitiesByService.size();
        int point = minutely15Cache.size();
        tileCache.clear();
        capabilitiesByService.clear();
        minutely15Cache.clear();
        recentTileCacheFlags.clear();
        lastCapabilitiesFromCache.set(false);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("tileEntries", tiles);
        result.put("capabilitiesEntries", caps);
        result.put("pointForecastEntries", point);
        result.put("totalEntries", tiles + caps + point);
        return result;
    }

    private byte[] fetchWmsPngWithRetry(String url) throws InterruptedException {
        long now = System.currentTimeMillis();
        long backoffUntil = wmsBackoffUntilMs;
        if (backoffUntil > now) {
            return null;
        }
        HttpStatusCodeException lastHttpError = null;
        Exception lastError = null;
        for (int attempt = 1; attempt <= WMS_MAX_RETRIES; attempt++) {
            paceWmsRequests();
            wmsFetchSemaphore.acquire();
            try {
                HttpHeaders reqHeaders = authHeaders();
                reqHeaders.setAccept(List.of(MediaType.IMAGE_PNG, MediaType.IMAGE_JPEG, MediaType.ALL));
                ResponseEntity<byte[]> response = restTemplate.exchange(
                        url, HttpMethod.GET, new HttpEntity<>(reqHeaders), byte[].class);
                byte[] body = response.getBody();
                if (body == null || body.length == 0) {
                    lastError = new IllegalStateException("Empty WMS response");
                } else if (isFaultResponseBody(body, response.getHeaders().getContentType())) {
                    lastError = new IllegalStateException("WMS returned fault XML");
                    log.debug("AROME-PI GetMap fault body: {}", truncateForLog(body, 400));
                } else {
                    return body;
                }
            } catch (HttpClientErrorException e) {
                if (e.getStatusCode() == HttpStatus.UNAUTHORIZED) {
                    throw e;
                }
                if (e.getStatusCode() == HttpStatus.TOO_MANY_REQUESTS) {
                    registerWmsThrottle(e);
                    throw e;
                }
                lastHttpError = e;
            } catch (HttpServerErrorException e) {
                lastHttpError = e;
            } catch (Exception e) {
                lastError = e;
            } finally {
                wmsFetchSemaphore.release();
            }
            if (lastHttpError != null) {
                if (!isRetryableWmsStatus(lastHttpError.getStatusCode()) || attempt >= WMS_MAX_RETRIES) {
                    throw lastHttpError;
                }
                log.debug("AROME-PI WMS retry {}/{} after HTTP {}", attempt, WMS_MAX_RETRIES,
                        lastHttpError.getStatusCode().value());
            } else if (attempt >= WMS_MAX_RETRIES) {
                break;
            } else {
                log.debug("AROME-PI WMS retry {}/{} after transient error", attempt, WMS_MAX_RETRIES);
            }
            Thread.sleep(WMS_RETRY_BASE_MS * attempt);
            lastHttpError = null;
        }
        if (lastHttpError != null) {
            throw lastHttpError;
        }
        if (lastError != null) {
            throw new IllegalStateException(lastError.getMessage() != null
                    ? lastError.getMessage()
                    : "WMS fetch failed");
        }
        return null;
    }

    private void paceWmsRequests() throws InterruptedException {
        if (wmsMinIntervalMs <= 0) {
            return;
        }
        while (true) {
            long now = System.currentTimeMillis();
            long allowedAt = nextWmsAllowedAtMs.get();
            long startAt = Math.max(now, allowedAt);
            long next = startAt + wmsMinIntervalMs;
            if (nextWmsAllowedAtMs.compareAndSet(allowedAt, next)) {
                long sleepMs = startAt - now;
                if (sleepMs > 0) {
                    Thread.sleep(sleepMs);
                }
                return;
            }
        }
    }

    private static boolean isRetryableWmsStatus(HttpStatusCode status) {
        int code = status.value();
        return status.is5xxServerError();
    }

    private void registerWmsThrottle(HttpClientErrorException e) {
        long now = System.currentTimeMillis();
        long until = now + Duration.ofMinutes(1).toMillis();

        HttpHeaders headers = e.getResponseHeaders();
        if (headers != null) {
            String retryAfter = headers.getFirst(HttpHeaders.RETRY_AFTER);
            Long retrySec = parseRetryAfterSeconds(retryAfter);
            if (retrySec != null && retrySec > 0) {
                until = Math.max(until, now + retrySec * 1000L);
            }
        }

        String body = null;
        try {
            body = e.getResponseBodyAsString(StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            // ignore
        }
        Long bodyUntil = parseMeteoFranceNextAccessTimeMs(body);
        if (bodyUntil != null) {
            until = Math.max(until, bodyUntil);
        }

        if (until > wmsBackoffUntilMs) {
            wmsBackoffUntilMs = until;
            log.warn("AROME-PI rate limited (429); pausing new WMS fetches for ~{} s (cached tiles still served)",
                    Math.max(1, Duration.ofMillis(until - now).toSeconds()));
        }
    }

    private static Long parseRetryAfterSeconds(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return Long.parseLong(raw.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static final Pattern MF_NEXT_ACCESS_TIME =
            Pattern.compile("\"nextAccessTime\"\\s*:\\s*\"([^\"]+)\"");

    private static Long parseMeteoFranceNextAccessTimeMs(String body) {
        if (body == null || body.isBlank()) {
            return null;
        }
        var m = MF_NEXT_ACCESS_TIME.matcher(body);
        if (!m.find()) {
            return null;
        }
        String raw = m.group(1);
        if (raw == null || raw.isBlank()) {
            return null;
        }

        // Example observed:
        // "2026-juil.-13 19:15:00+0000 UTC"
        // (French month abbreviation, with dot)
        try {
            DateTimeFormatter fmt1 = new DateTimeFormatterBuilder()
                    .parseCaseInsensitive()
                    .appendPattern("yyyy-MMM.-dd HH:mm:ssZ 'UTC'")
                    .toFormatter(Locale.FRENCH);
            return fmt1.parse(raw.trim(), Instant::from).toEpochMilli();
        } catch (DateTimeParseException ignored) {
            // fallthrough
        } catch (Exception ignored) {
            // fallthrough
        }
        try {
            DateTimeFormatter fmt2 = new DateTimeFormatterBuilder()
                    .parseCaseInsensitive()
                    .appendPattern("yyyy-MMM-dd HH:mm:ssZ 'UTC'")
                    .toFormatter(Locale.FRENCH);
            return fmt2.parse(raw.trim(), Instant::from).toEpochMilli();
        } catch (Exception ignored) {
            // fallthrough
        }
        return null;
    }

    private ResponseEntity<byte[]> throttledResponseIfNeeded() {
        long now = System.currentTimeMillis();
        long until = wmsBackoffUntilMs;
        if (until <= now) {
            return null;
        }
        long retryAfterSec = Math.max(1, Duration.ofMillis(until - now).toSeconds());
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.RETRY_AFTER, String.valueOf(retryAfterSec));
        headers.setCacheControl(CacheControl.noStore());
        return new ResponseEntity<>(new byte[0], headers, HttpStatus.TOO_MANY_REQUESTS);
    }

    private static boolean isFaultResponseBody(byte[] body, MediaType contentType) {
        if (contentType != null && (contentType.includes(MediaType.TEXT_XML)
                || contentType.includes(MediaType.APPLICATION_XML))) {
            return true;
        }
        return body.length >= 5 && body[0] == '<';
    }

    private static String tileCacheKey(
            String service,
            int z, int x, int y,
            String layer, String style,
            String time, String referenceTime,
            String elevation,
            int width, int height) {
        return service + "|" + z + "|" + x + "|" + y + "|" + layer + "|" + style + "|" + time + "|"
                + referenceTime + "|" + (elevation != null ? elevation : "") + "|" + width + "x" + height;
    }

    private void putTileCache(String key, byte[] png) {
        if (tileCache.size() >= TILE_CACHE_MAX_ENTRIES) {
            evictExpiredTiles();
            if (tileCache.size() >= TILE_CACHE_MAX_ENTRIES) {
                tileCache.clear();
            }
        }
        tileCache.put(key, new CachedTile(png, System.currentTimeMillis()));
    }

    private void evictExpiredTiles() {
        tileCache.entrySet().removeIf(entry ->
                !entry.getValue().isValid(forecastCacheTtl()));
    }

    public Map<String, Object> getFeatureInfo(
            double lat, double lon,
            String layer, String style,
            String time, String referenceTime,
            int width, int height) {
        return getFeatureInfo(lat, lon, layer, style, time, referenceTime, null, null, width, height);
    }

    public Map<String, Object> getFeatureInfo(
            double lat, double lon,
            String layer, String style,
            String time, String referenceTime,
            String domain,
            String elevation,
            int width, int height) {
        if (!isConfigured()) {
            return error("AROME-PI API key not configured");
        }
        if (!isValidLatLon(lat, lon) || !isSafeLayer(layer)) {
            return error("Invalid parameters");
        }
        if (!isValidIsoTime(time) || !isValidIsoTime(referenceTime)) {
            return error("Invalid time parameters");
        }
        String service = resolveWmsService(domain);
        time = normalizeForecastTime(time, referenceTime);
        String elev = normalizeElevation(elevation);

        if (openMeteoVariableForLayer(layer) != null) {
            OpenMeteoMinutely15 series = fetchOpenMeteoMinutely15Cached(lat, lon, time, time);
            Object value = lookupLayerValue(layer, series, time);
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("layer", layer);
            result.put("time", time);
            result.put("referenceTime", referenceTime);
            result.put("domain", domainIdForService(service));
            result.put("elevation", elev);
            result.put("lat", lat);
            result.put("lon", lon);
            result.put("value", value);
            result.put("source", "open-meteo-mf");
            return result;
        }

        int mapWidth = width > 0 && width <= 512 ? width : 256;
        int mapHeight = height > 0 && height <= 512 ? height : 256;
        double[] bbox = pointBbox4326(lat, lon, mapWidth, mapHeight);
        String resolvedStyle = style != null && !style.isBlank() ? style.trim() : resolveDefaultStyle(layer, service);
        int i = mapWidth / 2;
        int j = mapHeight / 2;

        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(wmsEndpoint(service, "GetFeatureInfo"))
                .queryParam("SERVICE", "WMS")
                .queryParam("VERSION", "1.3.0")
                .queryParam("REQUEST", "GetFeatureInfo")
                .queryParam("LAYERS", layer)
                .queryParam("QUERY_LAYERS", layer)
                .queryParam("STYLES", resolvedStyle)
                .queryParam("CRS", "EPSG:4326")
                .queryParam("BBOX", bbox[0] + "," + bbox[1] + "," + bbox[2] + "," + bbox[3])
                .queryParam("WIDTH", mapWidth)
                .queryParam("HEIGHT", mapHeight)
                .queryParam("I", i)
                .queryParam("J", j)
                .queryParam("INFO_FORMAT", "text/plain")
                .queryParam("FEATURE_COUNT", 1)
                .queryParam("TIME", time)
                .queryParam("dim_reference_time", referenceTime);
        if (elev != null) {
            builder.queryParam("ELEVATION", elev);
        }
        String url = builder.build(true).toUriString();

        try {
            HttpHeaders headers = authHeaders();
            headers.setAccept(List.of(MediaType.TEXT_PLAIN, MediaType.APPLICATION_JSON, MediaType.ALL));
            ResponseEntity<String> response = restTemplate.exchange(
                    url, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            String body = response.getBody();
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("layer", layer);
            result.put("time", time);
            result.put("referenceTime", referenceTime);
            result.put("domain", domainIdForService(service));
            result.put("elevation", elev);
            result.put("lat", lat);
            result.put("lon", lon);
            result.put("raw", body != null ? body.trim() : "");
            result.put("value", parseFeatureInfoValue(body));
            return result;
        } catch (Exception e) {
            log.debug("AROME-PI GetFeatureInfo failed for {}: {}", layer, e.getMessage());
            return error("GetFeatureInfo failed: " + e.getMessage());
        }
    }

    /**
     * Point forecast timeline: Open-Meteo meteofrance_seamless minutely_15 aligned to AROME-PI time steps.
     */
    public Map<String, Object> getPointForecast(
            double lat, double lon,
            List<String> layers,
            String referenceTime) {
        return getPointForecast(lat, lon, layers, referenceTime, null);
    }

    public Map<String, Object> getPointForecast(
            double lat, double lon,
            List<String> layers,
            String referenceTime,
            String domain) {
        if (!isConfigured()) {
            return error("AROME-PI API key not configured");
        }
        if (!isValidLatLon(lat, lon)) {
            return error("Invalid coordinates");
        }

        Map<String, Object> caps = getCapabilities(domain, referenceTime);
        if (caps.containsKey("error")) {
            return caps;
        }

        String service = resolveWmsService(domain);

        @SuppressWarnings("unchecked")
        List<String> timeSteps = (List<String>) caps.get("timeSteps");
        String ref = referenceTime != null && !referenceTime.isBlank()
                ? referenceTime.trim()
                : String.valueOf(caps.get("defaultReferenceTime"));
        ref = normalizeReferenceTime(ref, caps);

        List<String> resolvedLayers = resolveForecastLayers(layers, caps);
        OpenMeteoMinutely15 minutelySeries = null;
        if (timeSteps != null && !timeSteps.isEmpty()) {
            String firstStep = normalizeForecastTime(timeSteps.get(0), ref);
            String lastStep = normalizeForecastTime(timeSteps.get(timeSteps.size() - 1), ref);
            minutelySeries = fetchOpenMeteoMinutely15Cached(lat, lon, firstStep, lastStep);
        }

        List<Map<String, Object>> steps = new ArrayList<>();
        if (timeSteps != null) {
            for (String time : timeSteps) {
                String stepTime = normalizeForecastTime(time, ref);
                Map<String, Object> step = new LinkedHashMap<>();
                step.put("time", stepTime);
                step.put("offsetMinutes", offsetMinutes(ref, stepTime));
                Map<String, Object> values = new LinkedHashMap<>();
                for (String layer : resolvedLayers) {
                    Object value = lookupLayerValue(layer, minutelySeries, stepTime);
                    if (value != null) {
                        values.put(layer, value);
                    }
                }
                step.put("values", values);
                steps.add(step);
            }
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("lat", lat);
        result.put("lon", lon);
        result.put("domain", domainIdForService(service));
        result.put("referenceTime", ref);
        result.put("layers", resolvedLayers);
        result.put("steps", steps);
        result.put("valueSource", "open-meteo-mf");
        return result;
    }

    private List<String> resolveForecastLayers(List<String> requested, Map<String, Object> caps) {
        if (requested != null && !requested.isEmpty()) {
            return requested.stream()
                    .filter(MeteoFranceAromepiService::isSafeLayer)
                    .distinct()
                    .limit(6)
                    .toList();
        }
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> capLayers = (List<Map<String, Object>>) caps.get("layers");
        if (capLayers == null || capLayers.isEmpty()) {
            return PREFERRED_LAYER_ORDER.stream().limit(4).toList();
        }
        List<String> names = capLayers.stream()
                .map(l -> String.valueOf(l.get("name")))
                .filter(MeteoFranceAromepiService::isSafeLayer)
                .toList();
        List<String> ordered = new ArrayList<>();
        for (String pref : PREFERRED_LAYER_ORDER) {
            if (names.contains(pref)) {
                ordered.add(pref);
            }
        }
        for (String name : names) {
            if (!ordered.contains(name) && ordered.size() < 6) {
                ordered.add(name);
            }
        }
        return ordered.isEmpty() ? PREFERRED_LAYER_ORDER.stream().limit(4).toList() : ordered;
    }

    private ParsedCapabilities loadCapabilities() {
        return loadCapabilities(wmsService);
    }

    private ParsedCapabilities loadCapabilities(String service) {
        String svc = service != null && !service.isBlank() ? service.trim() : wmsService;
        long now = System.currentTimeMillis();
        CachedCapabilities cached = capabilitiesByService.get(svc);
        if (cached != null && now - cached.fetchedAtMs < capabilitiesCacheTtl().toMillis()) {
            lastCapabilitiesFromCache.set(true);
            return cached.parsed;
        }
        String url = UriComponentsBuilder.fromHttpUrl(wmsEndpoint(svc, "GetCapabilities"))
                .queryParam("SERVICE", "WMS")
                .queryParam("VERSION", "1.3.0")
                .queryParam("REQUEST", "GetCapabilities")
                .build(true)
                .toUriString();

        HttpHeaders headers = authHeaders();
        headers.setAccept(List.of(MediaType.APPLICATION_XML, MediaType.TEXT_XML, MediaType.ALL));
        ResponseEntity<byte[]> response = restTemplate.exchange(
                url, HttpMethod.GET, new HttpEntity<>(headers), byte[].class);
        byte[] body = response.getBody();
        if (body == null || body.length == 0) {
            throw new IllegalStateException("Empty GetCapabilities response");
        }
        ParsedCapabilities parsed = parseCapabilitiesXml(body);
        capabilitiesByService.put(svc, new CachedCapabilities(now, parsed));
        lastCapabilitiesFromCache.set(false);
        return parsed;
    }

    private ParsedCapabilities parseCapabilitiesXml(byte[] xmlBytes) {
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            Document doc = factory.newDocumentBuilder()
                    .parse(new ByteArrayInputStream(xmlBytes));

            List<LayerInfo> allLayers = new ArrayList<>();
            collectLayers(doc.getDocumentElement(), allLayers);

            Map<String, Object> bounds = defaultBounds();
            for (LayerInfo layer : allLayers) {
                if (layer.bounds != null) {
                    bounds = layer.bounds;
                }
            }

            String defaultRef = resolveLatestReferenceTime(allLayers);
            List<String> referenceTimes = collectAllReferenceTimes(allLayers);
            if (defaultRef == null && !referenceTimes.isEmpty()) {
                defaultRef = referenceTimes.get(referenceTimes.size() - 1);
            }

            // Forecast steps must be relative to the selected model run (reference time).
            List<String> timeSteps = defaultRef != null
                    ? generateTimeSteps(defaultRef, FORECAST_HORIZON_MINUTES, FORECAST_STEP_MINUTES)
                    : List.of();
            if (timeSteps.isEmpty() && defaultRef != null) {
                timeSteps = List.of(defaultRef);
            }
            if (referenceTimes.isEmpty() && defaultRef != null) {
                referenceTimes = List.of(defaultRef);
            }

            List<String> elevations = collectAllElevations(allLayers);
            String defaultElevation = resolveDefaultElevation(allLayers);

            List<Map<String, Object>> layerMaps = allLayers.stream()
                    .filter(l -> l.name != null && !l.name.isBlank())
                    .filter(l -> l.name.contains("__"))
                    .sorted(Comparator.comparingInt(l -> preferredLayerIndex(l.name)))
                    .map(this::toLayerMap)
                    .collect(java.util.stream.Collectors.toMap(
                            m -> String.valueOf(m.get("name")),
                            m -> m,
                            (a, b) -> a,
                            LinkedHashMap::new))
                    .values().stream()
                    .toList();

            return new ParsedCapabilities(
                    bounds, referenceTimes, defaultRef, timeSteps, elevations, defaultElevation, layerMaps);
        } catch (Exception e) {
            throw new IllegalStateException("Failed to parse AROME-PI GetCapabilities XML", e);
        }
    }

    private void collectLayers(Element element, List<LayerInfo> out) {
        if (element == null) {
            return;
        }
        String tag = localName(element);
        if ("Layer".equalsIgnoreCase(tag)) {
            LayerInfo info = parseLayerElement(element);
            if (info.name != null && !info.name.isBlank()) {
                out.add(info);
            }
        }
        NodeList children = element.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            Node child = children.item(i);
            if (child instanceof Element childEl) {
                collectLayers(childEl, out);
            }
        }
    }

    private LayerInfo parseLayerElement(Element layerEl) {
        LayerInfo info = new LayerInfo();
        info.name = textChild(layerEl, "Name");
        info.title = textChild(layerEl, "Title");
        info.style = firstStyleName(layerEl);
        info.category = categorizeLayer(info.name);

        NodeList dims = layerEl.getElementsByTagName("*");
        for (int i = 0; i < dims.getLength(); i++) {
            if (!(dims.item(i) instanceof Element dimEl)) {
                continue;
            }
            if (!"Dimension".equalsIgnoreCase(localName(dimEl))) {
                continue;
            }
            String dimName = dimEl.getAttribute("name");
            String value = dimEl.getTextContent() != null ? dimEl.getTextContent().trim() : "";
            if (value.isBlank()) {
                continue;
            }
            if ("time".equalsIgnoreCase(dimName)) {
                info.timeSteps = expandDimensionValues(value);
            } else if (dimName != null && dimName.toLowerCase(Locale.ROOT).contains("reference")) {
                info.referenceTimes = expandDimensionValues(value);
            } else if ("elevation".equalsIgnoreCase(dimName) || "height".equalsIgnoreCase(dimName)) {
                info.elevations = expandDimensionValues(value);
                String def = dimEl.getAttribute("default");
                if (def != null && !def.isBlank()) {
                    info.defaultElevation = def.trim();
                }
            }
        }

        String bbox = textChild(layerEl, "EX_GeographicBoundingBox");
        if (bbox == null) {
            Double west = parseDouble(textChild(layerEl, "westBoundLongitude"));
            Double east = parseDouble(textChild(layerEl, "eastBoundLongitude"));
            Double south = parseDouble(textChild(layerEl, "southBoundLatitude"));
            Double north = parseDouble(textChild(layerEl, "northBoundLatitude"));
            if (west != null && east != null && south != null && north != null) {
                info.bounds = boundsMap(south, west, north, east);
            }
        }
        return info;
    }

    private Map<String, Object> toLayerMap(LayerInfo layer) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("name", layer.name);
        map.put("title", layer.title != null ? layer.title : layer.name);
        map.put("style", layer.style != null ? layer.style : "");
        map.put("category", layer.category);
        if (layer.elevations != null && !layer.elevations.isEmpty()) {
            map.put("elevations", layer.elevations);
            map.put("defaultElevation", layer.defaultElevation != null
                    ? layer.defaultElevation
                    : layer.elevations.get(0));
        }
        if (layer.referenceTimes != null && !layer.referenceTimes.isEmpty()) {
            map.put("layerReferenceTimes", layer.referenceTimes.size() > 8
                    ? layer.referenceTimes.subList(layer.referenceTimes.size() - 8, layer.referenceTimes.size())
                    : layer.referenceTimes);
        }
        return map;
    }

    private int preferredLayerIndex(String name) {
        int idx = PREFERRED_LAYER_ORDER.indexOf(name);
        return idx >= 0 ? idx : 1000 + name.hashCode() % 500;
    }

    private String categorizeLayer(String name) {
        if (name == null) {
            return "other";
        }
        String upper = name.toUpperCase(Locale.ROOT);
        if (upper.contains("NEBUL") || upper.contains("NEB")) {
            return "cloud";
        }
        if (upper.contains("PRECIPITATION") || upper.contains("EAU") || upper.contains("NEIGE")
                || upper.contains("GRAUPEL") || upper.contains("GRELE")) {
            return "precipitation";
        }
        if (upper.contains("TEMPERATURE") || upper.matches("T__.*")) {
            return "temperature";
        }
        if (upper.contains("HUMIDITY") || upper.contains("HU__")) {
            return "humidity";
        }
        if (upper.contains("WIND") || upper.contains("FF_") || upper.contains("U_RAF") || upper.contains("V_RAF")) {
            return "wind";
        }
        if (upper.contains("VISIB")) {
            return "visibility";
        }
        return "other";
    }

    private List<String> expandDimensionValues(String raw) {
        if (raw == null || raw.isBlank()) {
            return List.of();
        }
        String trimmed = raw.trim();
        if (trimmed.contains("/")) {
            String[] parts = trimmed.split("/", 3);
            if (parts.length == 3) {
                try {
                    Instant start = Instant.parse(parts[0]);
                    Instant end = Instant.parse(parts[1]);
                    Duration step = parseDuration(parts[2]);
                    List<String> values = new ArrayList<>();
                    for (Instant t = start; !t.isAfter(end); t = t.plus(step)) {
                        values.add(DateTimeFormatter.ISO_INSTANT.format(t));
                    }
                    return values;
                } catch (Exception e) {
                    log.debug("Could not parse dimension interval {}: {}", trimmed, e.getMessage());
                }
            }
        }
        String[] tokens = trimmed.split(",");
        Set<String> unique = new LinkedHashSet<>();
        for (String token : tokens) {
            String t = token.trim();
            if (!t.isEmpty()) {
                unique.add(t);
            }
        }
        return new ArrayList<>(unique);
    }

    private Duration parseDuration(String iso) {
        if (iso == null || iso.isBlank()) {
            return Duration.ofMinutes(15);
        }
        String s = iso.trim().toUpperCase(Locale.ROOT);
        if (s.startsWith("PT")) {
            s = s.substring(2);
            if (s.endsWith("M")) {
                return Duration.ofMinutes(Long.parseLong(s.substring(0, s.length() - 1)));
            }
            if (s.endsWith("H")) {
                return Duration.ofHours(Long.parseLong(s.substring(0, s.length() - 1)));
            }
        }
        return Duration.ofMinutes(15);
    }

    private List<String> generateTimeSteps(String referenceTime, int horizonMinutes, int stepMinutes) {
        try {
            Instant ref = Instant.parse(referenceTime);
            List<String> steps = new ArrayList<>();
            // MF AROME-PI WMS has no dataset at T+0; first valid step is T+15 min.
            for (int m = stepMinutes; m <= horizonMinutes; m += stepMinutes) {
                steps.add(DateTimeFormatter.ISO_INSTANT.format(ref.plus(m, ChronoUnit.MINUTES)));
            }
            return steps;
        } catch (Exception e) {
            return List.of();
        }
    }

    private static List<String> collectAllElevations(List<LayerInfo> allLayers) {
        Set<String> unique = new LinkedHashSet<>();
        for (LayerInfo layer : allLayers) {
            if (layer.elevations != null) {
                unique.addAll(layer.elevations);
            }
        }
        return new ArrayList<>(unique);
    }

    private static String resolveDefaultElevation(List<LayerInfo> allLayers) {
        for (LayerInfo layer : allLayers) {
            if (layer.defaultElevation != null && !layer.defaultElevation.isBlank()) {
                return layer.defaultElevation;
            }
        }
        List<String> all = collectAllElevations(allLayers);
        return all.isEmpty() ? null : all.get(0);
    }

    private static List<String> collectAllReferenceTimes(List<LayerInfo> allLayers) {
        Set<String> unique = new LinkedHashSet<>();
        for (LayerInfo layer : allLayers) {
            if (layer.referenceTimes != null) {
                unique.addAll(layer.referenceTimes);
            }
        }
        return unique.stream()
                .filter(MeteoFranceAromepiService::isValidIsoTime)
                .sorted(Comparator.comparing(t -> Instant.parse(t.trim())))
                .toList();
    }

    private static String resolveLatestReferenceTime(List<LayerInfo> allLayers) {
        List<String> refs = collectAllReferenceTimes(allLayers);
        return refs.isEmpty() ? null : refs.get(refs.size() - 1);
    }

    /** WMS TIME must be referenceTime + [15..horizon] min; T+0 is not published by MF AROME-PI WMS. */
    static String normalizeForecastTime(String time, String referenceTime) {
        if (time == null || referenceTime == null) {
            return referenceTime;
        }
        try {
            Instant ref = Instant.parse(referenceTime.trim());
            Instant forecast = Instant.parse(time.trim());
            long minutes = ChronoUnit.MINUTES.between(ref, forecast);
            if (minutes >= FORECAST_MIN_OFFSET_MINUTES && minutes <= FORECAST_HORIZON_MINUTES) {
                return DateTimeFormatter.ISO_INSTANT.format(forecast);
            }
        } catch (Exception e) {
            // fall through
        }
        try {
            Instant ref = Instant.parse(referenceTime.trim());
            return DateTimeFormatter.ISO_INSTANT.format(ref.plus(FORECAST_MIN_OFFSET_MINUTES, ChronoUnit.MINUTES));
        } catch (Exception e) {
            return referenceTime.trim();
        }
    }

    @SuppressWarnings("unchecked")
    private static String normalizeReferenceTime(String referenceTime, Map<String, Object> caps) {
        if (referenceTime == null || referenceTime.isBlank() || "null".equals(referenceTime)) {
            Object def = caps.get("defaultReferenceTime");
            return def != null ? String.valueOf(def) : referenceTime;
        }
        try {
            Instant ref = Instant.parse(referenceTime.trim());
            Object refList = caps.get("referenceTimes");
            if (refList instanceof List<?> list && !list.isEmpty()) {
                Instant latest = null;
                for (Object item : list) {
                    Instant candidate = Instant.parse(String.valueOf(item).trim());
                    if (latest == null || candidate.isAfter(latest)) {
                        latest = candidate;
                    }
                }
                if (latest != null && ref.isBefore(latest.minus(6, ChronoUnit.HOURS))) {
                    return DateTimeFormatter.ISO_INSTANT.format(latest);
                }
            }
            return DateTimeFormatter.ISO_INSTANT.format(ref);
        } catch (Exception e) {
            Object def = caps.get("defaultReferenceTime");
            return def != null ? String.valueOf(def) : referenceTime.trim();
        }
    }

    private String resolveDefaultStyle(String layer) {
        return resolveDefaultStyle(layer, wmsService);
    }

    private String resolveDefaultStyle(String layer, String service) {
        try {
            ParsedCapabilities caps = loadCapabilities(service);
            for (Map<String, Object> l : caps.layers()) {
                if (layer.equals(l.get("name"))) {
                    Object style = l.get("style");
                    if (style != null && !String.valueOf(style).isBlank()) {
                        return String.valueOf(style);
                    }
                }
            }
        } catch (Exception e) {
            log.debug("Could not resolve default style for {}: {}", layer, e.getMessage());
        }
        return "";
    }

    private static String truncateForLog(byte[] body, int maxLen) {
        if (body == null || body.length == 0) {
            return "";
        }
        String text = new String(body, 0, Math.min(body.length, maxLen), java.nio.charset.StandardCharsets.UTF_8);
        return text.replaceAll("\\s+", " ").trim();
    }

    private boolean probeAuth() {
        CachedCapabilities cached = capabilitiesByService.get(wmsService);
        if (cached != null
                && System.currentTimeMillis() - cached.fetchedAtMs < capabilitiesCacheTtl().toMillis()) {
            return true;
        }
        try {
            loadCapabilities(wmsService);
            return true;
        } catch (HttpClientErrorException e) {
            if (e.getStatusCode() == HttpStatus.UNAUTHORIZED) {
                return false;
            }
            log.debug("AROME-PI auth probe failed: {}", e.getMessage());
            return false;
        } catch (Exception e) {
            log.debug("AROME-PI auth probe failed: {}", e.getMessage());
            return false;
        }
    }

    private HttpHeaders authHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(apiToken);
        headers.set("apikey", apiToken);
        headers.set(HttpHeaders.USER_AGENT, "PATTOOL/1.0");
        return headers;
    }

    private String wmsEndpoint(String operation) {
        return wmsEndpoint(wmsService, operation);
    }

    private String wmsEndpoint(String service, String operation) {
        String svc = service != null && !service.isBlank() ? service.trim() : wmsService;
        return baseUrl + "/wms/" + svc + "/" + operation;
    }

    private String resolveWmsService(String domain) {
        if (domain == null || domain.isBlank()) {
            return wmsService;
        }
        String d = domain.trim().toUpperCase(Locale.ROOT);
        if (d.contains("0025") || d.contains("0.025")) {
            return WMS_0025;
        }
        if (d.contains("001") || d.contains("0.01")) {
            return WMS_001;
        }
        if (d.contains("AROMEPI") && d.contains("WMS")) {
            return domain.trim();
        }
        return wmsService;
    }

    private static String domainIdForService(String service) {
        if (service != null && service.contains("0025")) {
            return DOMAIN_0025;
        }
        return DOMAIN_001;
    }

    private static String normalizeElevation(String elevation) {
        if (elevation == null || elevation.isBlank() || "null".equalsIgnoreCase(elevation)) {
            return null;
        }
        String e = elevation.trim();
        if (!e.matches("^-?\\d+(\\.\\d+)?$")) {
            return null;
        }
        return e;
    }

    private String normalizeReferenceTime(String referenceTime, ParsedCapabilities parsed) {
        if (parsed == null) {
            return referenceTime;
        }
        Map<String, Object> caps = new LinkedHashMap<>();
        caps.put("defaultReferenceTime", parsed.defaultReferenceTime());
        caps.put("referenceTimes", parsed.referenceTimes());
        return normalizeReferenceTime(referenceTime, caps);
    }

    private static double[] tileBbox4326(int z, int x, int y) {
        double n = Math.pow(2, z);
        double minLon = x / n * 360.0 - 180.0;
        double maxLon = (x + 1) / n * 360.0 - 180.0;
        double maxLat = Math.toDegrees(Math.atan(Math.sinh(Math.PI * (1 - 2.0 * y / n))));
        double minLat = Math.toDegrees(Math.atan(Math.sinh(Math.PI * (1 - 2.0 * (y + 1) / n))));
        return new double[]{minLat, minLon, maxLat, maxLon};
    }

    /**
     * MF WMS EPSG:4326 expects WIDTH:HEIGHT ≈ lonSpan:latSpan; square requests leave transparent bands.
     */
    private static int[] wmsDimensionsForBbox(double[] bbox4326, int baseSize) {
        double latSpan = Math.abs(bbox4326[2] - bbox4326[0]);
        double lonSpan = Math.abs(bbox4326[3] - bbox4326[1]);
        if (latSpan <= 0 || lonSpan <= 0 || baseSize <= 0) {
            return new int[]{baseSize, baseSize};
        }
        double ratio = lonSpan / latSpan;
        int w;
        int h;
        if (ratio >= 1.0) {
            w = baseSize;
            h = Math.max(16, (int) Math.round(baseSize / ratio));
        } else {
            h = baseSize;
            w = Math.max(16, (int) Math.round(baseSize * ratio));
        }
        return new int[]{w, h};
    }

    private static byte[] resamplePng(byte[] pngBytes, int targetWidth, int targetHeight) throws IOException {
        BufferedImage src = ImageIO.read(new ByteArrayInputStream(pngBytes));
        if (src == null) {
            return pngBytes;
        }
        if (src.getWidth() == targetWidth && src.getHeight() == targetHeight) {
            return pngBytes;
        }
        BufferedImage dst = new BufferedImage(targetWidth, targetHeight, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = dst.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.drawImage(src, 0, 0, targetWidth, targetHeight, null);
        g.dispose();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(dst, "png", out);
        return out.toByteArray();
    }

    private static double[] pointBbox4326(double lat, double lon, int width, int height) {
        double latSpan = 0.12 * height / 256.0;
        double cosLat = Math.max(0.2, Math.abs(Math.cos(Math.toRadians(lat))));
        double lonSpan = latSpan / cosLat * width / (double) height;
        return new double[]{lat - latSpan / 2, lon - lonSpan / 2, lat + latSpan / 2, lon + lonSpan / 2};
    }

    private static Object parseFeatureInfoValue(String body) {
        if (body == null || body.isBlank()) {
            return null;
        }
        String[] lines = body.trim().split("\\R");
        for (String line : lines) {
            String trimmed = line.trim();
            int eq = trimmed.indexOf('=');
            if (eq > 0) {
                String key = trimmed.substring(0, eq).trim().toLowerCase(Locale.ROOT);
                if (key.contains("value") || key.contains("grey") || key.contains("band")) {
                    String val = trimmed.substring(eq + 1).trim();
                    try {
                        return Double.parseDouble(val);
                    } catch (NumberFormatException e) {
                        return val;
                    }
                }
            }
            try {
                return Double.parseDouble(trimmed);
            } catch (NumberFormatException ignored) {
                // continue
            }
        }
        return body.trim();
    }

    private static long offsetMinutes(String referenceTime, String time) {
        try {
            return Duration.between(Instant.parse(referenceTime), Instant.parse(time)).toMinutes();
        } catch (Exception e) {
            return 0;
        }
    }

    private OpenMeteoMinutely15 fetchOpenMeteoMinutely15Cached(
            double lat, double lon, String startIso, String endIso) {
        String cacheKey = String.format(Locale.ROOT, "%.4f|%.4f|%s|%s", lat, lon, startIso, endIso);
        CachedMinutely15 cached = minutely15Cache.get(cacheKey);
        if (cached != null && cached.isValid(forecastCacheTtl())) {
            return cached.data();
        }
        OpenMeteoMinutely15 fetched = fetchOpenMeteoMinutely15(lat, lon, startIso, endIso);
        if (fetched != null && !fetched.times().isEmpty()) {
            minutely15Cache.put(cacheKey, new CachedMinutely15(fetched, System.currentTimeMillis()));
        }
        return fetched;
    }

    @SuppressWarnings("unchecked")
    private OpenMeteoMinutely15 fetchOpenMeteoMinutely15(
            double lat, double lon, String startIso, String endIso) {
        try {
            Instant start = Instant.parse(startIso);
            Instant end = Instant.parse(endIso);
            String url = UriComponentsBuilder.fromHttpUrl(OPEN_METEO_FORECAST_URL)
                    .queryParam("latitude", lat)
                    .queryParam("longitude", lon)
                    .queryParam("models", "meteofrance_seamless")
                    .queryParam("minutely_15", "temperature_2m,relative_humidity_2m,precipitation,cape")
                    .queryParam("start_minutely_15", OPEN_METEO_MINUTELY_FMT.format(start))
                    .queryParam("end_minutely_15", OPEN_METEO_MINUTELY_FMT.format(end))
                    .queryParam("timezone", "UTC")
                    .build(true)
                    .toUriString();

            ResponseEntity<Object> response = restTemplate.getForEntity(url, Object.class);
            Object body = response.getBody();
            if (!(body instanceof Map<?, ?> root)) {
                return OpenMeteoMinutely15.empty();
            }
            Object minutelyObj = root.get("minutely_15");
            if (!(minutelyObj instanceof Map<?, ?> minutely)) {
                return OpenMeteoMinutely15.empty();
            }
            Object timesObj = minutely.get("time");
            if (!(timesObj instanceof List<?> timesList)) {
                return OpenMeteoMinutely15.empty();
            }
            List<String> times = new ArrayList<>(timesList.size());
            for (Object t : timesList) {
                times.add(String.valueOf(t));
            }
            Map<String, List<Double>> variables = new LinkedHashMap<>();
            for (String var : List.of("temperature_2m", "relative_humidity_2m", "precipitation", "cape")) {
                Object valuesObj = minutely.get(var);
                if (valuesObj instanceof List<?> valuesList) {
                    List<Double> values = new ArrayList<>(valuesList.size());
                    for (Object v : valuesList) {
                        values.add(v instanceof Number n ? n.doubleValue() : null);
                    }
                    variables.put(var, values);
                }
            }
            return new OpenMeteoMinutely15(times, variables);
        } catch (Exception e) {
            log.warn("Open-Meteo meteofrance_seamless minutely_15 fetch failed: {}", e.getMessage());
            return OpenMeteoMinutely15.empty();
        }
    }

    private static Object lookupLayerValue(String layer, OpenMeteoMinutely15 series, String stepTimeIso) {
        if (series == null || series.times().isEmpty()) {
            return null;
        }
        String variable = openMeteoVariableForLayer(layer);
        if (variable == null) {
            return null;
        }
        List<Double> values = series.variables().get(variable);
        if (values == null || values.isEmpty()) {
            return null;
        }
        int idx = indexOfMinutelyTime(series.times(), stepTimeIso);
        if (idx < 0 || idx >= values.size()) {
            return null;
        }
        Double raw = values.get(idx);
        if (raw == null) {
            return null;
        }
        return formatLayerValue(layer, raw);
    }

    private static String openMeteoVariableForLayer(String layer) {
        if (layer == null) {
            return null;
        }
        String u = layer.toUpperCase(Locale.ROOT);
        if (u.contains("PRECIPITATION")) {
            return "precipitation";
        }
        if (u.contains("TEMPERATURE")) {
            return "temperature_2m";
        }
        if (u.contains("HUMIDITY")) {
            return "relative_humidity_2m";
        }
        if (u.contains("CAPE") || u.contains("CONVECTIVE_AVAILABLE_POTENTIAL_ENERGY")) {
            return "cape";
        }
        return null;
    }

    private static Object formatLayerValue(String layer, double raw) {
        String u = layer.toUpperCase(Locale.ROOT);
        if (u.contains("PRECIPITATION")) {
            return Math.round(raw * 100.0) / 100.0;
        }
        if (u.contains("TEMPERATURE")) {
            return Math.round(raw * 10.0) / 10.0;
        }
        if (u.contains("HUMIDITY")) {
            return Math.round(raw);
        }
        if (u.contains("CAPE") || u.contains("CONVECTIVE_AVAILABLE_POTENTIAL_ENERGY")) {
            return Math.round(raw);
        }
        return Math.round(raw * 10.0) / 10.0;
    }

    private static int indexOfMinutelyTime(List<String> times, String isoInstant) {
        try {
            Instant target = Instant.parse(isoInstant);
            for (int i = 0; i < times.size(); i++) {
                Instant t = parseOpenMeteoMinutelyTime(times.get(i));
                if (t.equals(target)) {
                    return i;
                }
            }
            for (int i = 0; i < times.size(); i++) {
                Instant t = parseOpenMeteoMinutelyTime(times.get(i));
                if (Math.abs(Duration.between(t, target).toMinutes()) <= 1) {
                    return i;
                }
            }
        } catch (Exception e) {
            log.debug("Minutely time index lookup failed for {}: {}", isoInstant, e.getMessage());
        }
        return -1;
    }

    private static Instant parseOpenMeteoMinutelyTime(String raw) {
        String s = raw.trim();
        if (s.endsWith("Z")) {
            return Instant.parse(s);
        }
        if (s.length() == 16) {
            return Instant.parse(s + ":00Z");
        }
        if (s.length() == 19 && !s.contains("+") && !s.endsWith("Z")) {
            return Instant.parse(s + "Z");
        }
        return Instant.parse(s);
    }

    private record OpenMeteoMinutely15(List<String> times, Map<String, List<Double>> variables) {
        static OpenMeteoMinutely15 empty() {
            return new OpenMeteoMinutely15(List.of(), Map.of());
        }
    }

    private record CachedMinutely15(OpenMeteoMinutely15 data, long fetchedAtMs) {
        boolean isValid(Duration ttl) {
            Duration effective = ttl != null ? ttl : FORECAST_CACHE_TTL_FALLBACK;
            return System.currentTimeMillis() - fetchedAtMs < effective.toMillis();
        }
    }

    private static Map<String, Object> defaultBounds() {
        return boundsMap(40.0, -6.0, 51.5, 10.0);
    }

    private static Map<String, Object> boundsMap(double south, double west, double north, double east) {
        Map<String, Object> bounds = new LinkedHashMap<>();
        bounds.put("south", south);
        bounds.put("west", west);
        bounds.put("north", north);
        bounds.put("east", east);
        return bounds;
    }

    private static Map<String, Object> error(String message) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("error", message);
        return map;
    }

    private static String normalizeToken(String raw) {
        if (raw == null) {
            return "";
        }
        String t = raw.trim();
        if (t.regionMatches(true, 0, "Bearer ", 0, 7)) {
            t = t.substring(7).trim();
        }
        return t;
    }

    /** Météo-France portal API keys are JWTs: header.payload.signature (~2k chars). */
    private static boolean looksLikeTruncatedApiKey(String token) {
        if (token == null || token.isBlank()) {
            return false;
        }
        long dots = token.chars().filter(ch -> ch == '.').count();
        return dots != 2 || token.length() < 400;
    }

    private static boolean isValidLatLon(double lat, double lon) {
        return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    }

    private static boolean isValidIsoTime(String time) {
        return time != null && !time.isBlank() && ISO_TIME.matcher(time.trim()).matches();
    }

    private static boolean isSafeLayer(String layer) {
        return layer != null && !layer.isBlank() && LAYER_SAFE.matcher(layer.trim()).matches();
    }

    private static boolean isSafeStyle(String style) {
        return style != null && !style.isBlank() && STYLE_SAFE.matcher(style.trim()).matches();
    }

    private static String localName(Node node) {
        String name = node.getLocalName();
        return name != null ? name : node.getNodeName();
    }

    private static String textChild(Element parent, String tag) {
        NodeList nodes = parent.getElementsByTagName("*");
        for (int i = 0; i < nodes.getLength(); i++) {
            if (!(nodes.item(i) instanceof Element el)) {
                continue;
            }
            if (tag.equalsIgnoreCase(localName(el))) {
                String text = el.getTextContent();
                return text != null ? text.trim() : null;
            }
        }
        return null;
    }

    private static String firstStyleName(Element layerEl) {
        NodeList styles = layerEl.getElementsByTagName("*");
        for (int i = 0; i < styles.getLength(); i++) {
            if (!(styles.item(i) instanceof Element el)) {
                continue;
            }
            if ("Style".equalsIgnoreCase(localName(el))) {
                String name = textChild(el, "Name");
                if (name != null && !name.isBlank()) {
                    return name;
                }
            }
        }
        return null;
    }

    private static Double parseDouble(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return Double.parseDouble(raw.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private record CachedTile(byte[] png, long fetchedAtMs) {
        boolean isValid(Duration ttl) {
            Duration effective = ttl != null ? ttl : FORECAST_CACHE_TTL_FALLBACK;
            return System.currentTimeMillis() - fetchedAtMs < effective.toMillis();
        }
    }

    private record CachedCapabilities(long fetchedAtMs, ParsedCapabilities parsed) {}

    private record ParsedCapabilities(
            Map<String, Object> bounds,
            List<String> referenceTimes,
            String defaultReferenceTime,
            List<String> timeSteps,
            List<String> elevations,
            String defaultElevation,
            List<Map<String, Object>> layers) {}

    private static final class LayerInfo {
        String name;
        String title;
        String style;
        String category;
        List<String> timeSteps;
        List<String> referenceTimes;
        List<String> elevations;
        String defaultElevation;
        Map<String, Object> bounds;
    }
}
