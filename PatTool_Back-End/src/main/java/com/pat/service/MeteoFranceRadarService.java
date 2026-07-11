package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.*;
import java.util.zip.GZIPInputStream;

/**
 * Proxy for Météo-France radar data:
 * <ul>
 *   <li>Optional WMS tiles when {@code meteofrance.radar.wms.enabled} and a valid geoservices URL are configured</li>
 *   <li>DPRadar REST API when {@code meteofrance.api.token} is configured</li>
 * </ul>
 */
@Service
public class MeteoFranceRadarService {

    private static final Logger log = LoggerFactory.getLogger(MeteoFranceRadarService.class);

    private static final String DEFAULT_DPRADAR_BASE = "https://public-api.meteofrance.fr/public/DPRadar/v1";
    private static final String DEFAULT_WMS_BASE = "https://geoservices.meteofrance.fr/services/WMS";
    private static final String DEFAULT_WMS_LAYER = "RADARURANCE400M";
    private static final String OAUTH_TOKEN_URL = "https://portail-api.meteofrance.fr/token";
    private static final String RAINVIEWER_MAPS_URL = "https://api.rainviewer.com/public/weather-maps.json";
    private static final String RAINVIEWER_TILE_HOST = "https://tilecache.rainviewer.com";
    private static final java.util.regex.Pattern RAINVIEWER_FRAME_PATH =
            java.util.regex.Pattern.compile("^/v2/(radar|satellite)/[a-zA-Z0-9]+$");

    private final RestTemplate restTemplate;
    private final String apiToken;
    private final String oauthApplicationId;
    private final String dpradarBaseUrl;
    private final String wmsBaseUrl;
    private final String wmsLayer;
    private final boolean wmsEnabled;

    private final MeteoFranceRadarRefreshPreferenceService radarRefreshPreferenceService;

    private volatile String cachedOAuthToken;
    private volatile long cachedOAuthExpiresAtMs;
    private volatile Map<String, Object> cachedRainViewerMaps;
    private volatile long cachedRainViewerMapsAtMs;

    public MeteoFranceRadarService(
            RestTemplate restTemplate,
            MeteoFranceRadarRefreshPreferenceService radarRefreshPreferenceService,
            @Value("${meteofrance.api.token:}") String apiToken,
            @Value("${meteofrance.oauth.application-id:}") String oauthApplicationId,
            @Value("${meteofrance.radar.base.url:" + DEFAULT_DPRADAR_BASE + "}") String dpradarBaseUrl,
            @Value("${meteofrance.radar.wms.url:" + DEFAULT_WMS_BASE + "}") String wmsBaseUrl,
            @Value("${meteofrance.radar.wms.layer:" + DEFAULT_WMS_LAYER + "}") String wmsLayer,
            @Value("${meteofrance.radar.wms.enabled:false}") boolean wmsEnabled) {
        this.restTemplate = restTemplate;
        this.radarRefreshPreferenceService = radarRefreshPreferenceService;
        this.apiToken = normalizeToken(apiToken);
        this.oauthApplicationId = oauthApplicationId != null ? oauthApplicationId.trim() : "";
        this.dpradarBaseUrl = dpradarBaseUrl != null && !dpradarBaseUrl.isBlank() ? dpradarBaseUrl.trim() : DEFAULT_DPRADAR_BASE;
        this.wmsBaseUrl = wmsBaseUrl != null && !wmsBaseUrl.isBlank() ? wmsBaseUrl.trim() : DEFAULT_WMS_BASE;
        this.wmsLayer = wmsLayer != null && !wmsLayer.isBlank() ? wmsLayer.trim() : DEFAULT_WMS_LAYER;
        this.wmsEnabled = wmsEnabled;

        if (isConfigured()) {
            log.info("Météo-France radar credentials loaded (apiKey={}, oauthAppId={})",
                    !this.apiToken.isEmpty(), !this.oauthApplicationId.isEmpty());
        } else {
            log.info("Météo-France radar not configured — set meteofrance.api.token or meteofrance.oauth.application-id");
        }
        if (this.wmsEnabled) {
            log.info("Météo-France WMS proxy enabled (layer={}, url={})", this.wmsLayer, this.wmsBaseUrl);
        }
    }

    public Map<String, Object> getStatus(String jwtSubject) {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("service", "Météo-France Radar");
        boolean configured = isConfigured();
        status.put("dpradarConfigured", configured);
        status.put("authValid", false);
        if (configured) {
            boolean valid = probeAuth();
            status.put("authValid", valid);
            if (!valid) {
                status.put("authError", "Invalid credentials (HTTP 401). Regenerate API key on portail-api.meteofrance.fr "
                        + "for API « Données Publiques Radar », or set meteofrance.oauth.application-id.");
            }
        }
        status.put("wmsAvailable", wmsEnabled);
        status.put("wmsOperational", wmsEnabled && probeWmsTile());
        status.put("wmsLayer", wmsLayer);
        status.put("radarMosaicPngSupported", false);
        if (wmsEnabled && Boolean.TRUE.equals(status.get("wmsOperational"))) {
            status.put("radarDisplayMode", "wms");
        } else if (configured && Boolean.TRUE.equals(status.get("authValid"))) {
            status.put("radarDisplayMode", "rainviewer-proxy");
            status.put("radarMapHint",
                    "DPRadar /produit returns HDF5/BUFR, not PNG. Map overlay uses RainViewer tiles; "
                            + "validity_time comes from Météo-France DPRadar.");
        } else {
            status.put("radarDisplayMode", "unavailable");
        }
        status.put("radarRequiresToken", true);
        status.put("defaultZone", "METROPOLE");
        status.put("defaultObservation", "REFLECTIVITE");
        status.put("defaultMaille", 1000);
        int refreshSec = radarRefreshPreferenceService.resolveEffectiveSeconds();
        status.put("radarRefreshSeconds", refreshSec);
        status.put("radarAutoRefreshEnabled", radarRefreshPreferenceService.resolveAutoRefreshEnabled());
        status.put("radarRefreshMinSeconds", 30);
        status.put("radarRefreshMaxSeconds", 600);
        status.put("mosaicBounds", mosaicBoundsWgs84());
        status.put("endpoints", List.of(
                "/api/external/meteofrance/status",
                "/api/external/meteofrance/radar/wms",
                "/api/external/meteofrance/radar/mosaic",
                "/api/external/meteofrance/radar/observations"
        ));
        return status;
    }

    /** WGS84 bounds for France métropole radar mosaic overlay. */
    public Map<String, Object> mosaicBoundsWgs84() {
        Map<String, Object> bounds = new LinkedHashMap<>();
        bounds.put("south", 40.8);
        bounds.put("west", -5.6);
        bounds.put("north", 52.0);
        bounds.put("east", 10.2);
        return bounds;
    }

    /**
     * Proxy a WMS GetMap tile (EPSG:4326, WMS 1.3.0 axis order: lat,lon).
     */
    public ResponseEntity<byte[]> getWmsTile(double minLat, double minLon, double maxLat, double maxLon,
                                             int width, int height) {
        if (!wmsEnabled) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).build();
        }
        if (width <= 0 || width > 1024 || height <= 0 || height > 1024) {
            return ResponseEntity.badRequest().build();
        }
        if (!isValidBbox(minLat, minLon, maxLat, maxLon)) {
            return ResponseEntity.badRequest().build();
        }

        String url = UriComponentsBuilder.fromHttpUrl(wmsBaseUrl)
                .queryParam("SERVICE", "WMS")
                .queryParam("VERSION", "1.3.0")
                .queryParam("REQUEST", "GetMap")
                .queryParam("LAYERS", wmsLayer)
                .queryParam("CRS", "EPSG:4326")
                .queryParam("BBOX", minLat + "," + minLon + "," + maxLat + "," + maxLon)
                .queryParam("WIDTH", width)
                .queryParam("HEIGHT", height)
                .queryParam("FORMAT", "image/png")
                .queryParam("TRANSPARENT", "true")
                .queryParam("STYLES", "")
                .build(true)
                .toUriString();

        try {
            HttpHeaders reqHeaders = new HttpHeaders();
            reqHeaders.set(HttpHeaders.ACCEPT, "image/png,image/*,*/*");
            reqHeaders.set(HttpHeaders.USER_AGENT, "PATTOOL/1.0");

            ResponseEntity<byte[]> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(reqHeaders),
                    byte[].class
            );

            byte[] body = response.getBody();
            if (body == null || body.length == 0) {
                log.warn("Météo-France WMS tile empty for layer {} ({})", wmsLayer, wmsBaseUrl);
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
            }
            if (!isPng(body)) {
                String snippet = new String(body, 0, Math.min(body.length, 200), java.nio.charset.StandardCharsets.UTF_8);
                log.warn("Météo-France WMS did not return PNG ({} bytes, starts with: {}) — "
                                + "check meteofrance.radar.wms.url/layer or disable WMS",
                        body.length, snippet.replaceAll("\\s+", " ").trim());
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
            }

            HttpHeaders out = new HttpHeaders();
            MediaType contentType = response.getHeaders().getContentType();
            out.setContentType(contentType != null ? contentType : MediaType.IMAGE_PNG);
            out.setCacheControl(CacheControl.maxAge(java.time.Duration.ofMinutes(2)).cachePublic());
            return new ResponseEntity<>(body, out, HttpStatus.OK);
        } catch (Exception e) {
            log.warn("Météo-France WMS tile fetch failed ({}): {}", wmsLayer, e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    /** One-shot probe: France métropole sample tile (cached ~5 min). */
    private boolean probeWmsTile() {
        if (!wmsEnabled) {
            return false;
        }
        long now = System.currentTimeMillis();
        if (cachedWmsProbeAtMs > 0 && now - cachedWmsProbeAtMs < 300_000L) {
            return cachedWmsProbeOk;
        }
        ResponseEntity<byte[]> probe = getWmsTile(47.0, 0.0, 48.0, 1.5, 64, 64);
        cachedWmsProbeOk = probe.getStatusCode().is2xxSuccessful()
                && probe.getBody() != null
                && probe.getBody().length > 0;
        cachedWmsProbeAtMs = now;
        if (!cachedWmsProbeOk) {
            log.info("Météo-France WMS probe failed (layer={}, url={}). "
                            + "Disable meteofrance.radar.wms.enabled or configure a valid geoservices WMS URL.",
                    wmsLayer, wmsBaseUrl);
        }
        return cachedWmsProbeOk;
    }

    private volatile boolean cachedWmsProbeOk;
    private volatile long cachedWmsProbeAtMs;

    /**
     * Proxy a WMS GetMap tile from standard slippy-map coordinates (Web Mercator tile index → EPSG:4326 BBOX).
     */
    public ResponseEntity<byte[]> getWmsTileFromSlippyMap(int z, int x, int y, int width, int height) {
        if (!wmsEnabled) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).build();
        }
        if (z < 0 || z > 18 || x < 0 || y < 0) {
            return ResponseEntity.badRequest().build();
        }
        double[] bbox = tileBbox4326(z, x, y);
        return getWmsTile(bbox[0], bbox[1], bbox[2], bbox[3], width, height);
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
     * List observation types available for a mosaic zone (DPRadar API).
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> listObservations(String zone) {
        if (!isConfigured()) {
            return error("API credentials not configured. Set meteofrance.api.token or meteofrance.oauth.application-id");
        }
        String normalizedZone = normalizeZone(zone);
        String url = dpradarBaseUrl + "/mosaiques/" + normalizedZone + "/observations";
        return getJson(url);
    }

    /**
     * Metadata for a mosaic observation (validity_time, links, etc.).
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> getObservationMeta(String zone, String observation, Integer maille) {
        if (!isConfigured()) {
            return error("API credentials not configured. Set meteofrance.api.token or meteofrance.oauth.application-id");
        }
        String normalizedZone = normalizeZone(zone);
        String normalizedObservation = normalizeObservation(observation);
        int resolvedMaille = resolveMaille(maille);

        String url = dpradarBaseUrl + "/mosaiques/" + normalizedZone + "/observations/" + normalizedObservation;
        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(url)
                .queryParam("maille", resolvedMaille);
        Map<String, Object> meta = getJson(builder.build(true).toUriString());
        if (!meta.containsKey("error")) {
            meta.put("bounds", mosaicBoundsWgs84());
            meta.put("zone", normalizedZone);
            meta.put("observation", normalizedObservation);
            meta.put("maille", resolvedMaille);
        }
        return meta;
    }

    /**
     * Latest radar mosaic PNG from DPRadar API.
     */
    public ResponseEntity<byte[]> getLatestMosaicImage(String zone, String observation, Integer maille) {
        if (!isConfigured()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).build();
        }
        String normalizedZone = normalizeZone(zone);
        String normalizedObservation = normalizeObservation(observation);
        int resolvedMaille = resolveMaille(maille);

        String url = UriComponentsBuilder.fromHttpUrl(
                        dpradarBaseUrl + "/mosaiques/" + normalizedZone + "/observations/" + normalizedObservation + "/produit")
                .queryParam("maille", resolvedMaille)
                .build(true)
                .toUriString();

        try {
            HttpHeaders reqHeaders = authHeaders();
            reqHeaders.setAccept(List.of(MediaType.IMAGE_PNG, MediaType.APPLICATION_OCTET_STREAM, MediaType.ALL));

            ResponseEntity<byte[]> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(reqHeaders),
                    byte[].class
            );

            byte[] body = response.getBody();
            if (body == null || body.length == 0) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
            }

            MediaType contentType = response.getHeaders().getContentType();
            byte[] imageBytes = decodeMosaicImageBytes(body, contentType);
            if (!isPng(imageBytes)) {
                log.debug("DPRadar mosaic produit is {} ({} bytes raw, {} bytes decoded) — use WMS tiles for map display",
                        guessFormat(imageBytes, contentType), body.length, imageBytes.length);
                HttpHeaders reject = new HttpHeaders();
                reject.set("X-Radar-Format", guessFormat(imageBytes, contentType));
                reject.set("X-Radar-Fallback", "rainviewer");
                return new ResponseEntity<>(reject, HttpStatus.NO_CONTENT);
            }

            HttpHeaders out = new HttpHeaders();
            out.setContentType(MediaType.IMAGE_PNG);
            out.setCacheControl(CacheControl.maxAge(java.time.Duration.ofMinutes(2)).cachePublic());
            return new ResponseEntity<>(imageBytes, out, HttpStatus.OK);
        } catch (HttpClientErrorException e) {
            if (e.getStatusCode() == HttpStatus.UNAUTHORIZED) {
                logAuthFailureOnce();
            } else {
                log.warn("DPRadar mosaic fetch failed ({}): {}", e.getStatusCode(), e.getMessage());
            }
            return ResponseEntity.status(e.getStatusCode()).build();
        } catch (Exception e) {
            log.warn("DPRadar mosaic fetch failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    /**
     * Proxy RainViewer weather-maps metadata (avoids browser CORS; use host + path for tile URLs).
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> getRainViewerMaps() {
        long now = System.currentTimeMillis();
        Map<String, Object> cached = cachedRainViewerMaps;
        if (cached != null && now - cachedRainViewerMapsAtMs < 120_000L) {
            return cached;
        }
        try {
            ResponseEntity<Map> response = restTemplate.exchange(
                    RAINVIEWER_MAPS_URL,
                    HttpMethod.GET,
                    new HttpEntity<>(new HttpHeaders()),
                    Map.class
            );
            Map<String, Object> body = response.getBody();
            if (body == null || body.isEmpty()) {
                return error("RainViewer maps unavailable");
            }
            cachedRainViewerMaps = body;
            cachedRainViewerMapsAtMs = now;
            return body;
        } catch (Exception e) {
            log.warn("RainViewer maps fetch failed: {}", e.getMessage());
            return error("RainViewer maps fetch failed: " + e.getMessage());
        }
    }

    /**
     * Proxy a RainViewer radar or satellite tile (PNG). Path must match {@code /v2/radar/{hash}}
     * or {@code /v2/satellite/{hash}} from maps metadata.
     */
    public ResponseEntity<byte[]> getRainViewerTile(
            String framePath,
            int z,
            int x,
            int y,
            int size,
            int color,
            String options,
            float enhance) {
        if (framePath == null || framePath.isBlank() || !RAINVIEWER_FRAME_PATH.matcher(framePath.trim()).matches()) {
            return ResponseEntity.badRequest().build();
        }
        if (z < 0 || z > 12 || x < 0 || y < 0) {
            return ResponseEntity.badRequest().build();
        }
        int tileSize = size == 512 ? 512 : 256;
        int colorScheme = color >= 0 && color <= 8 ? color : 2;
        String tileOptions = normalizeRainViewerOptions(options);

        String url = RAINVIEWER_TILE_HOST + framePath.trim()
                + "/" + tileSize + "/" + z + "/" + x + "/" + y + "/" + colorScheme + "/" + tileOptions + ".png";

        try {
            ResponseEntity<byte[]> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(new HttpHeaders()),
                    byte[].class
            );
            byte[] body = response.getBody();
            if (body == null || body.length == 0) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
            }
            if (enhance > 0.95f && framePath.contains("/satellite/")) {
                body = CloudMapTileEnhancer.enhanceSatelliteIr(body, enhance);
            }
            HttpHeaders out = new HttpHeaders();
            MediaType contentType = response.getHeaders().getContentType();
            out.setContentType(contentType != null ? contentType : MediaType.IMAGE_PNG);
            out.setCacheControl(CacheControl.maxAge(java.time.Duration.ofMinutes(5)).cachePublic());
            return new ResponseEntity<>(body, out, HttpStatus.OK);
        } catch (HttpClientErrorException e) {
            return ResponseEntity.status(e.getStatusCode()).build();
        } catch (Exception e) {
            log.debug("RainViewer tile fetch failed (z={}, x={}, y={}): {}", z, x, y, e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    private static String normalizeRainViewerOptions(String options) {
        if (options == null || options.isBlank()) {
            return "1_1";
        }
        String trimmed = options.trim();
        if (trimmed.matches("[01]_[01]")) {
            return trimmed;
        }
        return "1_1";
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> getJson(String url) {
        try {
            HttpHeaders headers = authHeaders();
            headers.setAccept(List.of(MediaType.APPLICATION_JSON));

            ResponseEntity<Map> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    Map.class
            );
            Map<String, Object> body = response.getBody();
            return body != null ? body : new HashMap<>();
        } catch (HttpClientErrorException e) {
            if (e.getStatusCode() == HttpStatus.UNAUTHORIZED) {
                logAuthFailureOnce();
            } else {
                log.warn("Météo-France API error ({}): {}", e.getStatusCode(), e.getResponseBodyAsString());
            }
            Map<String, Object> err = error("Météo-France API error: " + e.getStatusCode());
            err.put("details", e.getResponseBodyAsString());
            err.put("authValid", false);
            return err;
        } catch (Exception e) {
            log.warn("Météo-France API call failed: {}", e.getMessage());
            return error("Météo-France API call failed: " + e.getMessage());
        }
    }

    private HttpHeaders authHeaders() {
        HttpHeaders headers = new HttpHeaders();
        String token = resolveEffectiveToken();
        headers.setBearerAuth(token);
        headers.set("apikey", token);
        headers.set(HttpHeaders.USER_AGENT, "PATTOOL/1.0");
        return headers;
    }

    private boolean isConfigured() {
        return !apiToken.isEmpty() || !oauthApplicationId.isEmpty();
    }

    private String resolveEffectiveToken() {
        if (!oauthApplicationId.isEmpty()) {
            return fetchOAuthAccessToken();
        }
        if (apiToken.isEmpty()) {
            throw new IllegalStateException("Météo-France API token not configured");
        }
        return apiToken;
    }

    private synchronized String fetchOAuthAccessToken() {
        long now = System.currentTimeMillis();
        if (cachedOAuthToken != null && now < cachedOAuthExpiresAtMs - 60_000L) {
            return cachedOAuthToken;
        }
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.AUTHORIZATION, "Basic " + oauthApplicationId);
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        headers.set(HttpHeaders.USER_AGENT, "PATTOOL/1.0");

        HttpEntity<String> request = new HttpEntity<>("grant_type=client_credentials", headers);
        @SuppressWarnings("unchecked")
        ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                OAUTH_TOKEN_URL,
                HttpMethod.POST,
                request,
                (Class<Map<String, Object>>) (Class<?>) Map.class
        );
        Map<String, Object> body = response.getBody();
        if (body == null || body.get("access_token") == null) {
            throw new IllegalStateException("OAuth token response missing access_token");
        }
        cachedOAuthToken = String.valueOf(body.get("access_token"));
        Object expiresIn = body.get("expires_in");
        long ttlSec = expiresIn instanceof Number number ? number.longValue() : 3600L;
        cachedOAuthExpiresAtMs = now + ttlSec * 1000L;
        return cachedOAuthToken;
    }

    private boolean probeAuth() {
        try {
            HttpHeaders headers = authHeaders();
            headers.setAccept(List.of(MediaType.APPLICATION_JSON));
            ResponseEntity<Void> response = restTemplate.exchange(
                    dpradarBaseUrl + "/mosaiques",
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    Void.class
            );
            return response.getStatusCode().is2xxSuccessful();
        } catch (HttpClientErrorException e) {
            if (e.getStatusCode() == HttpStatus.UNAUTHORIZED) {
                return false;
            }
            log.debug("Météo-France auth probe HTTP {}: {}", e.getStatusCode(), e.getResponseBodyAsString());
            return false;
        } catch (Exception e) {
            log.debug("Météo-France auth probe failed: {}", e.getMessage());
            return false;
        }
    }

    private static String normalizeToken(String raw) {
        if (raw == null) {
            return "";
        }
        String token = raw.trim();
        if (token.regionMatches(true, 0, "Bearer ", 0, 7)) {
            token = token.substring(7).trim();
        }
        return token;
    }

    private void logAuthFailureOnce() {
        log.warn("Météo-France DPRadar authentication failed (401 Invalid Credentials). "
                + "Subscribe to API « Données Publiques Radar » on portail-api.meteofrance.fr, "
                + "then generate a new API key (meteofrance.api.token) or use OAuth application id "
                + "(meteofrance.oauth.application-id). Do not use the Application consumer key/secret directly as Bearer token.");
    }

    private static boolean isPng(byte[] body) {
        return body.length >= 8
                && body[0] == (byte) 0x89
                && body[1] == 'P'
                && body[2] == 'N'
                && body[3] == 'G';
    }

    /** DPRadar often returns gzip-compressed PNG with content-type application/octet-stream+gzip. */
    private static byte[] decodeMosaicImageBytes(byte[] body, MediaType contentType) {
        if (body == null || body.length == 0 || isPng(body)) {
            return body;
        }
        if (isGzip(body) || isGzipContentType(contentType)) {
            byte[] decompressed = gunzip(body);
            if (decompressed != null && decompressed.length > 0) {
                return decompressed;
            }
        }
        return body;
    }

    private static boolean isGzip(byte[] body) {
        return body.length >= 2
                && (body[0] & 0xff) == 0x1f
                && (body[1] & 0xff) == 0x8b;
    }

    private static boolean isGzipContentType(MediaType contentType) {
        if (contentType == null) {
            return false;
        }
        return contentType.toString().toLowerCase(Locale.ROOT).contains("gzip");
    }

    private static byte[] gunzip(byte[] body) {
        try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(body));
             ByteArrayOutputStream out = new ByteArrayOutputStream(body.length * 2)) {
            in.transferTo(out);
            return out.toByteArray();
        } catch (IOException e) {
            return null;
        }
    }

    private static String guessFormat(byte[] body, MediaType contentType) {
        if (isPng(body)) {
            return MediaType.IMAGE_PNG_VALUE;
        }
        if (isGzip(body) || isGzipContentType(contentType)) {
            return "application/gzip";
        }
        if (contentType != null) {
            return contentType.toString();
        }
        if (body.length >= 4 && body[0] == 'H' && body[1] == 'D' && body[2] == 'F') {
            return "application/x-hdf5";
        }
        return "application/octet-stream";
    }

    private static Map<String, Object> error(String message) {
        Map<String, Object> map = new HashMap<>();
        map.put("error", message);
        return map;
    }

    private static String normalizeZone(String zone) {
        if (zone == null || zone.isBlank()) {
            return "METROPOLE";
        }
        return zone.trim().toUpperCase(Locale.ROOT);
    }

    private static String normalizeObservation(String observation) {
        if (observation == null || observation.isBlank()) {
            return "REFLECTIVITE";
        }
        return observation.trim().toUpperCase(Locale.ROOT);
    }

    private static int resolveMaille(Integer maille) {
        if (maille == null) {
            return 1000;
        }
        int[] allowed = {500, 1000};
        for (int value : allowed) {
            if (maille == value) {
                return value;
            }
        }
        return 1000;
    }

    private static boolean isValidBbox(double minLat, double minLon, double maxLat, double maxLon) {
        return minLat >= -90 && maxLat <= 90 && minLon >= -180 && maxLon <= 180
                && minLat < maxLat && minLon < maxLon
                && maxLat - minLat <= 30 && maxLon - minLon <= 30;
    }
}
