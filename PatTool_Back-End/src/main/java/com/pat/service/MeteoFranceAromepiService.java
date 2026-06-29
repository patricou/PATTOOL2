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
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
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
import java.util.regex.Pattern;

/**
 * Proxy for Météo-France AROME-PI nowcasting (0–6 h, 15 min steps) via WMS GetMap / GetFeatureInfo.
 * API « AROMEPI 1.0 » on portail-api.meteofrance.fr — requires {@code meteofrance.aromepi.api.token}.
 */
@Service
public class MeteoFranceAromepiService {

    private static final Logger log = LoggerFactory.getLogger(MeteoFranceAromepiService.class);

    private static final String DEFAULT_BASE = "https://public-api.meteofrance.fr/public/aromepi/1.0";
    private static final String DEFAULT_WMS_SERVICE = "MF-NWP-HIGHRES-AROMEPI-001-FRANCE-WMS";
    private static final Duration CAPABILITIES_CACHE_TTL = Duration.ofMinutes(10);
    private static final int TILE_SIZE = 256;
    private static final double EARTH_RADIUS = 6378137.0;
    private static final Pattern LAYER_SAFE = Pattern.compile("^[A-Za-z0-9_\\-]+$");
    private static final Pattern STYLE_SAFE = Pattern.compile("^[A-Za-z0-9_\\-]+$");
    private static final Pattern ISO_TIME = Pattern.compile(
            "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?(\\.\\d+)?Z$");

    private static final List<String> PREFERRED_LAYER_ORDER = List.of(
            "NEBUL__GROUND_OR_WATER_SURFACE",
            "TOTAL_WATER_PRECIPITATION__GROUND_OR_WATER_SURFACE",
            "TEMPERATURE__GROUND_OR_WATER_SURFACE",
            "RELATIVE_HUMIDITY__GROUND_OR_WATER_SURFACE",
            "WIND_SPEED__GROUND_OR_WATER_SURFACE",
            "VISIBILITY__GROUND_OR_WATER_SURFACE"
    );

    private final RestTemplate restTemplate;
    private final String apiToken;
    private final String baseUrl;
    private final String wmsService;

    private volatile CachedCapabilities cachedCapabilities;

    public MeteoFranceAromepiService(
            @Qualifier(RestTemplateConfig.METEOFRANCE_CLIM_REST_TEMPLATE) RestTemplate restTemplate,
            @Value("${meteofrance.aromepi.api.token:}") String apiToken,
            @Value("${meteofrance.aromepi.base.url:" + DEFAULT_BASE + "}") String baseUrl,
            @Value("${meteofrance.aromepi.wms.service:" + DEFAULT_WMS_SERVICE + "}") String wmsService) {
        this.restTemplate = restTemplate;
        this.apiToken = normalizeToken(apiToken);
        this.baseUrl = baseUrl != null && !baseUrl.isBlank()
                ? baseUrl.trim().replaceAll("/+$", "")
                : DEFAULT_BASE;
        this.wmsService = wmsService != null && !wmsService.isBlank()
                ? wmsService.trim()
                : DEFAULT_WMS_SERVICE;
        if (isConfigured()) {
            log.info("Météo-France AROME-PI credentials loaded (wms={})", this.wmsService);
        } else {
            log.info("Météo-France AROME-PI not configured — set meteofrance.aromepi.api.token "
                    + "(API « AROMEPI 1.0 » on portail-api.meteofrance.fr)");
        }
    }

    public Map<String, Object> getStatusFragment() {
        Map<String, Object> status = new LinkedHashMap<>();
        boolean configured = isConfigured();
        status.put("aromepiConfigured", configured);
        status.put("aromepiAuthValid", false);
        status.put("aromepiWmsService", wmsService);
        status.put("aromepiBaseUrl", baseUrl);
        if (configured) {
            boolean valid = probeAuth();
            status.put("aromepiAuthValid", valid);
            if (!valid) {
                status.put("aromepiAuthError",
                        "Invalid credentials or missing subscription to API « AROMEPI 1.0 ». "
                                + "Use meteofrance.aromepi.api.token.");
            }
        }
        status.put("aromepiEndpoints", List.of(
                "/api/external/meteofrance/aromepi/capabilities",
                "/api/external/meteofrance/aromepi/wms/{z}/{x}/{y}",
                "/api/external/meteofrance/aromepi/featureinfo",
                "/api/external/meteofrance/aromepi/point-forecast"
        ));
        return status;
    }

    public boolean isConfigured() {
        return !apiToken.isEmpty();
    }

    public Map<String, Object> getCapabilities() {
        if (!isConfigured()) {
            return error("AROME-PI API key not configured. Set meteofrance.aromepi.api.token "
                    + "(API « AROMEPI 1.0 » on portail-api.meteofrance.fr)");
        }
        try {
            ParsedCapabilities parsed = loadCapabilities();
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("service", "AROMEPI");
            result.put("resolution", wmsService.contains("0025") ? "0.025" : "0.01");
            result.put("wmsService", wmsService);
            result.put("bounds", parsed.bounds());
            result.put("referenceTimes", parsed.referenceTimes());
            result.put("defaultReferenceTime", parsed.defaultReferenceTime());
            result.put("timeSteps", parsed.timeSteps());
            result.put("layers", parsed.layers());
            result.put("forecastHorizonMinutes", 360);
            result.put("forecastStepMinutes", 15);
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

        double[] bbox3857 = tileBbox3857(z, x, y, width, height);
        String resolvedStyle = style != null && !style.isBlank() ? style.trim() : resolveDefaultStyle(layer);

        String url = UriComponentsBuilder.fromHttpUrl(wmsEndpoint("GetMap"))
                .queryParam("SERVICE", "WMS")
                .queryParam("VERSION", "1.3.0")
                .queryParam("REQUEST", "GetMap")
                .queryParam("LAYERS", layer)
                .queryParam("STYLES", resolvedStyle)
                .queryParam("CRS", "EPSG:3857")
                .queryParam("BBOX", bbox3857[0] + "," + bbox3857[1] + "," + bbox3857[2] + "," + bbox3857[3])
                .queryParam("WIDTH", width)
                .queryParam("HEIGHT", height)
                .queryParam("FORMAT", "image/png")
                .queryParam("TRANSPARENT", "true")
                .queryParam("TIME", time)
                .queryParam("DIM_REFERENCE_TIME", referenceTime)
                .build(true)
                .toUriString();

        return fetchImage(url, Duration.ofMinutes(5));
    }

    public Map<String, Object> getFeatureInfo(
            double lat, double lon,
            String layer, String style,
            String time, String referenceTime,
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

        int mapWidth = width > 0 && width <= 512 ? width : 256;
        int mapHeight = height > 0 && height <= 512 ? height : 256;
        double[] bbox = pointBbox3857(lat, lon, mapWidth, mapHeight);
        String resolvedStyle = style != null && !style.isBlank() ? style.trim() : resolveDefaultStyle(layer);
        int i = mapWidth / 2;
        int j = mapHeight / 2;

        String url = UriComponentsBuilder.fromHttpUrl(wmsEndpoint("GetFeatureInfo"))
                .queryParam("SERVICE", "WMS")
                .queryParam("VERSION", "1.3.0")
                .queryParam("REQUEST", "GetFeatureInfo")
                .queryParam("LAYERS", layer)
                .queryParam("QUERY_LAYERS", layer)
                .queryParam("STYLES", resolvedStyle)
                .queryParam("CRS", "EPSG:3857")
                .queryParam("BBOX", bbox[0] + "," + bbox[1] + "," + bbox[2] + "," + bbox[3])
                .queryParam("WIDTH", mapWidth)
                .queryParam("HEIGHT", mapHeight)
                .queryParam("I", i)
                .queryParam("J", j)
                .queryParam("INFO_FORMAT", "text/plain")
                .queryParam("FEATURE_COUNT", 1)
                .queryParam("TIME", time)
                .queryParam("DIM_REFERENCE_TIME", referenceTime)
                .build(true)
                .toUriString();

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
     * Point forecast timeline: GetFeatureInfo for each time step on selected layers.
     */
    public Map<String, Object> getPointForecast(
            double lat, double lon,
            List<String> layers,
            String referenceTime) {
        if (!isConfigured()) {
            return error("AROME-PI API key not configured");
        }
        if (!isValidLatLon(lat, lon)) {
            return error("Invalid coordinates");
        }

        Map<String, Object> caps = getCapabilities();
        if (caps.containsKey("error")) {
            return caps;
        }

        @SuppressWarnings("unchecked")
        List<String> timeSteps = (List<String>) caps.get("timeSteps");
        String ref = referenceTime != null && !referenceTime.isBlank()
                ? referenceTime.trim()
                : String.valueOf(caps.get("defaultReferenceTime"));

        List<String> resolvedLayers = resolveForecastLayers(layers, caps);
        List<Map<String, Object>> steps = new ArrayList<>();
        if (timeSteps != null) {
            for (String time : timeSteps) {
                Map<String, Object> step = new LinkedHashMap<>();
                step.put("time", time);
                step.put("offsetMinutes", offsetMinutes(ref, time));
                Map<String, Object> values = new LinkedHashMap<>();
                for (String layer : resolvedLayers) {
                    Map<String, Object> fi = getFeatureInfo(lat, lon, layer, null, time, ref, 256, 256);
                    if (!fi.containsKey("error")) {
                        values.put(layer, fi.get("value"));
                        Object raw = fi.get("raw");
                        if (raw != null && !String.valueOf(raw).isBlank()) {
                            values.put(layer + "_raw", raw);
                        }
                    }
                }
                step.put("values", values);
                steps.add(step);
            }
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("lat", lat);
        result.put("lon", lon);
        result.put("referenceTime", ref);
        result.put("layers", resolvedLayers);
        result.put("steps", steps);
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
        long now = System.currentTimeMillis();
        CachedCapabilities cached = cachedCapabilities;
        if (cached != null && now - cached.fetchedAtMs < CAPABILITIES_CACHE_TTL.toMillis()) {
            return cached.parsed;
        }
        String url = UriComponentsBuilder.fromHttpUrl(wmsEndpoint("GetCapabilities"))
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
        cachedCapabilities = new CachedCapabilities(now, parsed);
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

            List<String> referenceTimes = new ArrayList<>();
            List<String> timeSteps = new ArrayList<>();
            Map<String, Object> bounds = defaultBounds();

            for (LayerInfo layer : allLayers) {
                if (layer.referenceTimes != null && referenceTimes.isEmpty()) {
                    referenceTimes.addAll(layer.referenceTimes);
                }
                if (layer.timeSteps != null && timeSteps.isEmpty()) {
                    timeSteps.addAll(layer.timeSteps);
                }
                if (layer.bounds != null) {
                    bounds = layer.bounds;
                }
            }

            if (timeSteps.isEmpty() && !referenceTimes.isEmpty()) {
                timeSteps = generateTimeSteps(referenceTimes.get(0), 360, 15);
            }
            if (referenceTimes.isEmpty() && !timeSteps.isEmpty()) {
                referenceTimes = List.of(timeSteps.get(0));
            }

            String defaultRef = referenceTimes.isEmpty() ? null : referenceTimes.get(referenceTimes.size() - 1);
            if (defaultRef == null && !timeSteps.isEmpty()) {
                defaultRef = timeSteps.get(0);
            }

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
                    .limit(80)
                    .toList();

            return new ParsedCapabilities(bounds, referenceTimes, defaultRef, timeSteps, layerMaps);
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
            for (int m = 0; m <= horizonMinutes; m += stepMinutes) {
                steps.add(DateTimeFormatter.ISO_INSTANT.format(ref.plus(m, ChronoUnit.MINUTES)));
            }
            return steps;
        } catch (Exception e) {
            return List.of();
        }
    }

    private String resolveDefaultStyle(String layer) {
        try {
            ParsedCapabilities caps = loadCapabilities();
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

    private ResponseEntity<byte[]> fetchImage(String url, Duration cacheMaxAge) {
        try {
            HttpHeaders reqHeaders = authHeaders();
            reqHeaders.setAccept(List.of(MediaType.IMAGE_PNG, MediaType.IMAGE_JPEG, MediaType.ALL));

            ResponseEntity<byte[]> response = restTemplate.exchange(
                    url, HttpMethod.GET, new HttpEntity<>(reqHeaders), byte[].class);

            byte[] body = response.getBody();
            if (body == null || body.length == 0) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
            }

            HttpHeaders out = new HttpHeaders();
            MediaType contentType = response.getHeaders().getContentType();
            out.setContentType(contentType != null ? contentType : MediaType.IMAGE_PNG);
            out.setCacheControl(CacheControl.maxAge(cacheMaxAge).cachePublic());
            return new ResponseEntity<>(body, out, HttpStatus.OK);
        } catch (HttpClientErrorException e) {
            if (e.getStatusCode() == HttpStatus.UNAUTHORIZED) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }
            log.debug("AROME-PI image fetch failed ({}): {}", e.getStatusCode(), e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        } catch (Exception e) {
            log.debug("AROME-PI image fetch failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    private boolean probeAuth() {
        try {
            loadCapabilities();
            return true;
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
        return baseUrl + "/wms/" + wmsService + "/" + operation;
    }

    private static double[] tileBbox3857(int z, int x, int y, int width, int height) {
        double mapSize = TILE_SIZE * Math.pow(2, z);
        double originShift = Math.PI * EARTH_RADIUS;
        double resolution = (2 * originShift) / mapSize;
        double tileMapSize = width * resolution;

        double minX = x * tileMapSize - originShift;
        double maxX = (x + 1) * tileMapSize - originShift;
        double maxY = originShift - y * tileMapSize;
        double minY = originShift - (y + 1) * tileMapSize;
        return new double[]{minY, minX, maxY, maxX};
    }

    private static double[] pointBbox3857(double lat, double lon, int width, int height) {
        double mx = lon * originShift() / 180.0;
        double my = Math.log(Math.tan((90 + lat) * Math.PI / 360.0)) / (Math.PI / 180.0);
        my = my * originShift() / 180.0;
        double span = 12_000.0;
        double halfW = span * width / 256.0 / 2.0;
        double halfH = span * height / 256.0 / 2.0;
        return new double[]{my - halfH, mx - halfW, my + halfH, mx + halfW};
    }

    private static double originShift() {
        return Math.PI * EARTH_RADIUS;
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

    private record CachedCapabilities(long fetchedAtMs, ParsedCapabilities parsed) {}

    private record ParsedCapabilities(
            Map<String, Object> bounds,
            List<String> referenceTimes,
            String defaultReferenceTime,
            List<String> timeSteps,
            List<Map<String, Object>> layers) {}

    private static final class LayerInfo {
        String name;
        String title;
        String style;
        String category;
        List<String> timeSteps;
        List<String> referenceTimes;
        Map<String, Object> bounds;
    }
}
