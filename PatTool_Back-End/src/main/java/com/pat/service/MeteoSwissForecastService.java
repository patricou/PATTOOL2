package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import jakarta.annotation.PostConstruct;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * MeteoSwiss local forecast (Open Data STAC) — same point data as the MeteoSwiss app.
 * Downloads hourly CSV bundles per parameter, caches them server-side, resolves lat/lon to the nearest point.
 */
@Service
public class MeteoSwissForecastService {

    private static final Logger log = LoggerFactory.getLogger(MeteoSwissForecastService.class);

    private static final String STAC_ITEMS_URL =
            "https://data.geo.admin.ch/api/stac/v1/collections/ch.meteoschweiz.ogd-local-forecasting/items?limit=20";
    private static final String META_POINTS_URL =
            "https://data.geo.admin.ch/ch.meteoschweiz.ogd-local-forecasting/ogd-local-forecasting_meta_point.csv";

    private static final DateTimeFormatter CSV_TS = DateTimeFormatter.ofPattern("yyyyMMddHHmm");

    /** MeteoSwiss local forecast parameters merged into the unified timeline. */
    private static final String[] PARAM_SUFFIXES = {
            "tre200h0", "fu3010h0", "dkl010h0", "rre150h0", "rp0003i0", "jww003i0"
    };

    private static final double CH_MIN_LAT = 45.82;
    private static final double CH_MAX_LAT = 47.81;
    private static final double CH_MIN_LON = 5.96;
    private static final double CH_MAX_LON = 10.49;
    /** Reject when the nearest forecast point is farther than this (postal-code grid). */
    private static final double MAX_NEAREST_KM = 20.0;

    private final RestTemplate restTemplate;
    private final boolean enabled;
    private final AtomicBoolean refreshInProgress = new AtomicBoolean(false);

    private volatile List<PointRecord> points = List.of();
    private volatile ForecastCache cache;
    private volatile PrecipMapCache precipMapCache;
    private volatile String lastError;
    private volatile Instant lastRefreshAttempt;
    private volatile Instant lastSuccessfulRefresh;

    public MeteoSwissForecastService(
            RestTemplate restTemplate,
            @Value("${meteoswiss.forecast.enabled:true}") boolean enabled) {
        this.restTemplate = restTemplate;
        this.enabled = enabled;
    }

    @PostConstruct
    public void init() {
        if (!enabled) {
            log.info("MeteoSwiss forecast service disabled (meteoswiss.forecast.enabled=false)");
            return;
        }
        CompletableFuture.runAsync(this::refreshCacheSafe);
    }

    @Scheduled(cron = "${meteoswiss.forecast.refresh.cron:0 10 * * * *}")
    public void scheduledRefresh() {
        if (enabled) {
            refreshCacheSafe();
        }
    }

    public Map<String, Object> getForecastByCoordinates(
            double lat, double lon, int horizonHours, int stepMinutes) {
        if (!enabled) {
            return error("MeteoSwiss forecast service is disabled");
        }
        if (!isInSwitzerland(lat, lon)) {
            return error("Coordinates outside MeteoSwiss local forecast coverage (Switzerland)");
        }
        ensurePointsLoaded();
        if (points.isEmpty()) {
            return error("MeteoSwiss point registry unavailable");
        }
        ForecastCache active = cache;
        if (active == null) {
            requestCacheRefreshIfIdle();
            if (refreshInProgress.get()) {
                return error("MeteoSwiss forecast data is loading, please retry in a minute");
            }
            if (lastError != null && !lastError.isBlank()) {
                return error(lastError);
            }
            return error("MeteoSwiss forecast data is loading, please retry in a minute");
        }

        NearestPoint nearest = findNearestPoint(lat, lon);
        if (nearest == null || nearest.distanceKm() > MAX_NEAREST_KM) {
            return error("No MeteoSwiss forecast point near this location (max "
                    + MAX_NEAREST_KM + " km)");
        }

        List<Map<String, Object>> rawList = active.listByPointId().get(nearest.point().id());
        if (rawList == null || rawList.isEmpty()) {
            return error("No forecast steps for the nearest MeteoSwiss point");
        }

        List<Map<String, Object>> filtered = ForecastHorizonFilter.filterList(rawList, horizonHours, stepMinutes);
        if (filtered.isEmpty()) {
            Map<String, Object> err = error("MeteoSwiss forecast empty for selected horizon and step");
            err.put("meteoswissPoint", pointMeta(nearest));
            return err;
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("patSource", "meteoswiss");
        result.put("list", filtered);
        result.put("count", filtered.size());
        result.put("forecastHorizonHours", MeteoFranceForecastPreferenceService.clampHorizon(horizonHours));
        result.put("forecastStepMinutes", MeteoFranceForecastPreferenceService.clampStep(stepMinutes));
        result.put("meteoswissPoint", pointMeta(nearest));
        result.put("city", Map.of(
                "coord", Map.of("lat", nearest.point().lat(), "lon", nearest.point().lon()),
                "name", nearest.point().displayName()));
        result.put("attribution", "Source: MeteoSwiss");
        return result;
    }

    public Map<String, Object> getPrecipMapCapabilities(int horizonHours) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("patSource", "meteoswiss");
        result.put("attribution", "Source: MeteoSwiss");
        result.put("bounds", precipBounds());
        result.put("south", CH_MIN_LAT);
        result.put("north", CH_MAX_LAT);
        result.put("west", CH_MIN_LON);
        result.put("east", CH_MAX_LON);
        if (!enabled) {
            result.put("error", "MeteoSwiss forecast service is disabled");
            return result;
        }
        PrecipMapCache active = precipMapCache;
        if (active == null) {
            requestCacheRefreshIfIdle();
            if (refreshInProgress.get()) {
                result.put("error", "MeteoSwiss precipitation map is loading, please retry in a minute");
                return result;
            }
            if (lastError != null && !lastError.isBlank()) {
                result.put("error", lastError);
                return result;
            }
            result.put("error", "MeteoSwiss precipitation map is loading, please retry in a minute");
            return result;
        }
        int horizon = MeteoFranceForecastPreferenceService.clampHorizon(horizonHours);
        long now = Instant.now().getEpochSecond();
        long horizonEnd = now + (long) horizon * 3600L;
        List<Map<String, Object>> frames = new ArrayList<>();
        for (long epoch : active.epochs()) {
            if (epoch < now - 1800 || epoch > horizonEnd) {
                continue;
            }
            Map<String, Object> frame = new LinkedHashMap<>();
            frame.put("dt", epoch);
            frame.put("offsetHours", Math.round((epoch - now) / 3600.0 * 10.0) / 10.0);
            frame.put("maxMm", active.maxMmByEpoch().getOrDefault(epoch, 0.0));
            frames.add(frame);
        }
        result.put("frames", frames);
        result.put("frameCount", frames.size());
        result.put("itemId", active.itemId());
        result.put("loadedAt", active.loadedAt().toString());
        result.put("stepMinutes", 60);
        if (frames.isEmpty()) {
            result.put("error", "No precipitation frames for selected horizon");
        }
        return result;
    }

    public byte[] getPrecipMapFramePng(long epoch) {
        PrecipMapCache active = precipMapCache;
        if (active == null) {
            return null;
        }
        return active.pngByEpoch().get(epoch);
    }

    public Map<String, Object> getStatus() {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("enabled", enabled);
        status.put("ready", cache != null);
        status.put("loading", refreshInProgress.get());
        status.put("pointCount", points.size());
        if (cache != null) {
            status.put("itemId", cache.itemId());
            status.put("loadedAt", cache.loadedAt().toString());
            status.put("stepCountSample", cache.listByPointId().values().stream()
                    .findFirst().map(List::size).orElse(0));
        }
        if (precipMapCache != null) {
            status.put("precipFrameCount", precipMapCache.epochs().size());
        }
        if (lastSuccessfulRefresh != null) {
            status.put("lastSuccessfulRefresh", lastSuccessfulRefresh.toString());
        }
        if (lastRefreshAttempt != null) {
            status.put("lastRefreshAttempt", lastRefreshAttempt.toString());
        }
        if (lastError != null) {
            status.put("lastError", lastError);
        }
        return status;
    }

    private void requestCacheRefreshIfIdle() {
        if (!refreshInProgress.get()) {
            CompletableFuture.runAsync(this::refreshCacheSafe);
        }
    }

    private void refreshCacheSafe() {
        if (!enabled || !refreshInProgress.compareAndSet(false, true)) {
            return;
        }
        lastRefreshAttempt = Instant.now();
        try {
            ensurePointsLoaded();
            Map<String, Object> item = resolveLatestItemWithAssets();
            if (item == null) {
                lastError = "No MeteoSwiss STAC forecast item with data found";
                return;
            }
            String itemId = String.valueOf(item.get("id"));
            CacheBuildResult built = buildCacheFromItem(itemId, item);
            if (built == null || built.forecast() == null) {
                lastError = "Failed to parse MeteoSwiss forecast files for " + itemId;
                return;
            }
            cache = built.forecast();
            precipMapCache = built.precip();
            lastError = null;
            lastSuccessfulRefresh = Instant.now();
            log.info("MeteoSwiss forecast cache refreshed: item={}, points={}, sampleSteps={}, precipFrames={}",
                    itemId, built.forecast().listByPointId().size(),
                    built.forecast().listByPointId().values().stream().findFirst().map(List::size).orElse(0),
                    precipMapCache != null ? precipMapCache.epochs().size() : 0);
        } catch (Exception e) {
            lastError = e.getMessage() != null ? e.getMessage() : "MeteoSwiss refresh failed";
            log.warn("MeteoSwiss forecast refresh failed: {}", e.getMessage());
        } finally {
            refreshInProgress.set(false);
        }
    }

    private void ensurePointsLoaded() {
        if (!points.isEmpty()) {
            return;
        }
        synchronized (this) {
            if (!points.isEmpty()) {
                return;
            }
            points = loadPoints(META_POINTS_URL);
            log.info("MeteoSwiss point registry loaded: {} points", points.size());
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> resolveLatestItemWithAssets() {
        try {
            ResponseEntity<Object> response = restTemplate.getForEntity(STAC_ITEMS_URL, Object.class);
            if (!(response.getBody() instanceof Map<?, ?> body)) {
                return null;
            }
            Object featuresObj = body.get("features");
            if (!(featuresObj instanceof List<?> features) || features.isEmpty()) {
                return null;
            }
            Map<String, Object> bestItem = null;
            String bestRef = null;
            for (Object featureObj : features) {
                if (!(featureObj instanceof Map<?, ?> feature)) {
                    continue;
                }
                Map<String, Object> item = (Map<String, Object>) feature;
                String ref = latestAssetReference(item, "tre200h0");
                if (ref == null) {
                    continue;
                }
                if (bestRef == null || ref.compareTo(bestRef) > 0) {
                    bestRef = ref;
                    bestItem = item;
                }
            }
            return bestItem;
        } catch (Exception e) {
            log.warn("MeteoSwiss STAC item list failed: {}", e.getMessage());
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private static String latestAssetReference(Map<String, Object> item, String suffix) {
        Object assetsObj = item.get("assets");
        if (!(assetsObj instanceof Map<?, ?> assets)) {
            return null;
        }
        String best = null;
        for (Map.Entry<?, ?> entry : assets.entrySet()) {
            String key = String.valueOf(entry.getKey());
            if (!key.endsWith("." + suffix + ".csv")) {
                continue;
            }
            int dot = key.lastIndexOf('.');
            int prev = key.lastIndexOf('.', dot - 1);
            if (prev < 0) {
                continue;
            }
            String ref = key.substring(prev + 1, dot);
            if (best == null || ref.compareTo(best) > 0) {
                best = ref;
            }
        }
        return best;
    }

    @SuppressWarnings("unchecked")
    private CacheBuildResult buildCacheFromItem(String itemId, Map<String, Object> item) {
        Object assetsObj = item.get("assets");
        if (!(assetsObj instanceof Map<?, ?> assets) || assets.isEmpty()) {
            return null;
        }

        Map<String, String> paramUrls = new LinkedHashMap<>();
        for (String suffix : PARAM_SUFFIXES) {
            String url = findAssetUrl(assets, suffix);
            if (url != null) {
                paramUrls.put(suffix, url);
            }
        }
        if (!paramUrls.containsKey("tre200h0")) {
            log.warn("MeteoSwiss item {} missing temperature asset", itemId);
            return null;
        }

        Map<Integer, Map<Long, StepBuilder>> merged = new HashMap<>(8192);
        for (Map.Entry<String, String> entry : paramUrls.entrySet()) {
            mergeParameterCsv(entry.getKey(), entry.getValue(), merged);
        }

        Map<Integer, List<Map<String, Object>>> listByPoint = new HashMap<>(merged.size());
        long nowEpoch = Instant.now().getEpochSecond();
        for (Map.Entry<Integer, Map<Long, StepBuilder>> pointEntry : merged.entrySet()) {
            List<Map<String, Object>> steps = new ArrayList<>();
            for (Map.Entry<Long, StepBuilder> stepEntry : pointEntry.getValue().entrySet()) {
                if (stepEntry.getKey() < nowEpoch - 7200) {
                    continue;
                }
                Map<String, Object> itemMap = stepEntry.getValue().toForecastItem(stepEntry.getKey());
                if (itemMap != null) {
                    steps.add(itemMap);
                }
            }
            steps.sort(Comparator.comparingLong(step -> ((Number) step.get("dt")).longValue()));
            if (!steps.isEmpty()) {
                listByPoint.put(pointEntry.getKey(), steps);
            }
        }
        if (listByPoint.isEmpty()) {
            return null;
        }
        ForecastCache forecast = new ForecastCache(itemId, Instant.now(), listByPoint);
        PrecipMapCache precip = buildPrecipMapCache(itemId, merged);
        return new CacheBuildResult(forecast, precip);
    }

    private PrecipMapCache buildPrecipMapCache(String itemId, Map<Integer, Map<Long, StepBuilder>> merged) {
        Map<Long, Map<Integer, Double>> precipByEpoch = new LinkedHashMap<>();
        long nowEpoch = Instant.now().getEpochSecond();
        for (Map.Entry<Integer, Map<Long, StepBuilder>> pointEntry : merged.entrySet()) {
            for (Map.Entry<Long, StepBuilder> stepEntry : pointEntry.getValue().entrySet()) {
                if (stepEntry.getKey() < nowEpoch - 7200) {
                    continue;
                }
                Double mm = stepEntry.getValue().precipMm;
                if (mm == null || mm < 0) {
                    continue;
                }
                precipByEpoch
                        .computeIfAbsent(stepEntry.getKey(), k -> new HashMap<>())
                        .put(pointEntry.getKey(), mm);
            }
        }
        if (precipByEpoch.isEmpty()) {
            log.warn("MeteoSwiss precip map: no hourly precipitation values in cache");
            return null;
        }
        List<Long> epochs = precipByEpoch.keySet().stream().sorted().toList();
        Map<Long, byte[]> pngByEpoch = new LinkedHashMap<>();
        Map<Long, Double> maxMmByEpoch = new LinkedHashMap<>();
        try {
            for (long epoch : epochs) {
                Map<Integer, Double> byPoint = precipByEpoch.get(epoch);
                double maxMm = byPoint != null
                        ? byPoint.values().stream()
                        .filter(v -> v != null && v > 0)
                        .mapToDouble(Double::doubleValue)
                        .max()
                        .orElse(0)
                        : 0;
                maxMmByEpoch.put(epoch, maxMm);
                byte[] png = MeteoSwissPrecipRasterizer.renderFrame(
                        CH_MIN_LAT, CH_MAX_LAT, CH_MIN_LON, CH_MAX_LON,
                        points, byPoint);
                pngByEpoch.put(epoch, png);
            }
        } catch (Exception e) {
            log.warn("MeteoSwiss precip raster failed: {}", e.getMessage());
            return null;
        }
        return new PrecipMapCache(itemId, Instant.now(), epochs, pngByEpoch, maxMmByEpoch);
    }

    private static List<List<Double>> precipBounds() {
        return List.of(
                List.of(CH_MIN_LAT, CH_MIN_LON),
                List.of(CH_MAX_LAT, CH_MAX_LON));
    }

    @SuppressWarnings("unchecked")
    private static String findAssetUrl(Map<?, ?> assets, String suffix) {
        for (Map.Entry<?, ?> entry : assets.entrySet()) {
            String key = String.valueOf(entry.getKey());
            if (!key.endsWith("." + suffix + ".csv")) {
                continue;
            }
            if (entry.getValue() instanceof Map<?, ?> asset) {
                Object href = asset.get("href");
                if (href != null) {
                    return String.valueOf(href);
                }
            }
        }
        return null;
    }

    private void mergeParameterCsv(String paramSuffix, String url, Map<Integer, Map<Long, StepBuilder>> merged) {
        try {
            restTemplate.execute(url, org.springframework.http.HttpMethod.GET, null, response -> {
                try (InputStream body = response.getBody();
                     BufferedReader reader = new BufferedReader(
                             new InputStreamReader(body, StandardCharsets.ISO_8859_1))) {
                    String line;
                    boolean header = true;
                    while ((line = reader.readLine()) != null) {
                        if (header) {
                            header = false;
                            continue;
                        }
                        if (line.isBlank()) {
                            continue;
                        }
                        String[] parts = line.split(";", -1);
                        if (parts.length < 4) {
                            continue;
                        }
                        int pointId = parseInt(parts[0], -1);
                        long epoch = parseCsvEpoch(parts[2]);
                        if (pointId < 0 || epoch <= 0) {
                            continue;
                        }
                        Double value = parseDouble(parts[3]);
                        if (value == null) {
                            continue;
                        }
                        Map<Long, StepBuilder> byTime = merged.computeIfAbsent(pointId, k -> new HashMap<>(256));
                        StepBuilder step = byTime.computeIfAbsent(epoch, k -> new StepBuilder());
                        step.apply(paramSuffix, value);
                    }
                }
                return null;
            });
        } catch (Exception e) {
            log.warn("MeteoSwiss CSV download failed ({}): {}", paramSuffix, e.getMessage());
        }
    }

    private List<PointRecord> loadPoints(String url) {
        List<PointRecord> loaded = new ArrayList<>(6000);
        try {
            restTemplate.execute(url, org.springframework.http.HttpMethod.GET, null, response -> {
                try (InputStream body = response.getBody();
                     BufferedReader reader = new BufferedReader(
                             new InputStreamReader(body, StandardCharsets.ISO_8859_1))) {
                    String line;
                    boolean header = true;
                    while ((line = reader.readLine()) != null) {
                        if (header) {
                            header = false;
                            continue;
                        }
                        if (line.isBlank()) {
                            continue;
                        }
                        String[] parts = line.split(";", -1);
                        if (parts.length < 14) {
                            continue;
                        }
                        int id = parseInt(parts[0], -1);
                        double lat = parseDouble(parts[12]) != null ? parseDouble(parts[12]) : 0;
                        double lon = parseDouble(parts[13]) != null ? parseDouble(parts[13]) : 0;
                        if (id < 0 || lat == 0 || lon == 0) {
                            continue;
                        }
                        String postal = parts[3].isBlank() ? null : parts[3].trim();
                        String name = parts[4].isBlank() ? null : parts[4].trim();
                        double height = parseDouble(parts[9]) != null ? parseDouble(parts[9]) : 0;
                        loaded.add(new PointRecord(id, lat, lon, name, postal, height));
                    }
                }
                return null;
            });
        } catch (Exception e) {
            log.warn("MeteoSwiss points metadata download failed: {}", e.getMessage());
        }
        return List.copyOf(loaded);
    }

    private NearestPoint findNearestPoint(double lat, double lon) {
        PointRecord best = null;
        double bestDist = Double.MAX_VALUE;
        for (PointRecord point : points) {
            double dist = haversineKm(lat, lon, point.lat(), point.lon());
            if (dist < bestDist) {
                bestDist = dist;
                best = point;
            }
        }
        return best == null ? null : new NearestPoint(best, bestDist);
    }

    private static Map<String, Object> pointMeta(NearestPoint nearest) {
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("id", nearest.point().id());
        meta.put("name", nearest.point().displayName());
        if (nearest.point().postalCode() != null) {
            meta.put("postalCode", nearest.point().postalCode());
        }
        meta.put("lat", nearest.point().lat());
        meta.put("lon", nearest.point().lon());
        meta.put("distanceKm", round(nearest.distanceKm(), 1));
        return meta;
    }

    private static boolean isInSwitzerland(double lat, double lon) {
        return lat >= CH_MIN_LAT && lat <= CH_MAX_LAT && lon >= CH_MIN_LON && lon <= CH_MAX_LON;
    }

    private static double haversineKm(double lat1, double lon1, double lat2, double lon2) {
        double r = 6371.0;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    private static long parseCsvEpoch(String raw) {
        if (raw == null || raw.isBlank()) {
            return 0;
        }
        try {
            LocalDateTime ldt = LocalDateTime.parse(raw.trim(), CSV_TS);
            return ldt.toInstant(ZoneOffset.UTC).getEpochSecond();
        } catch (DateTimeParseException e) {
            return 0;
        }
    }

    private static int parseInt(String raw, int fallback) {
        try {
            return Integer.parseInt(raw.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
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

    private static double round(double value, int decimals) {
        double factor = Math.pow(10, decimals);
        return Math.round(value * factor) / factor;
    }

    private static Map<String, Object> error(String message) {
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("error", message);
        err.put("patSource", "meteoswiss");
        return err;
    }

    record PointRecord(int id, double lat, double lon, String name, String postalCode, double heightM) {
        String displayName() {
            if (name != null && postalCode != null) {
                return name + " (" + postalCode + ")";
            }
            if (name != null) {
                return name;
            }
            if (postalCode != null) {
                return postalCode;
            }
            return "Point " + id;
        }
    }

    private record NearestPoint(PointRecord point, double distanceKm) {}

    private record ForecastCache(
            String itemId, Instant loadedAt, Map<Integer, List<Map<String, Object>>> listByPointId) {}

    private record CacheBuildResult(ForecastCache forecast, PrecipMapCache precip) {}

    private record PrecipMapCache(
            String itemId,
            Instant loadedAt,
            List<Long> epochs,
            Map<Long, byte[]> pngByEpoch,
            Map<Long, Double> maxMmByEpoch) {}

    static final class StepBuilder {
        private Double tempC;
        private Double windSpeedMs;
        private Double windDeg;
        private Double precipMm;
        private Double pop;
        private Integer weatherCode;

        void apply(String paramSuffix, double value) {
            switch (paramSuffix) {
                case "tre200h0" -> tempC = round(value, 1);
                case "fu3010h0" -> windSpeedMs = round(value / 3.6, 2);
                case "dkl010h0" -> windDeg = (double) Math.round(value);
                case "rre150h0" -> precipMm = round(value, 2);
                case "rp0003i0" -> pop = Math.min(1.0, Math.max(0.0, value / 100.0));
                case "jww003i0" -> weatherCode = (int) Math.round(value);
                default -> { }
            }
        }

        Map<String, Object> toForecastItem(long epoch) {
            if (tempC == null) {
                return null;
            }
            Map<String, Object> main = new LinkedHashMap<>();
            main.put("temp", tempC);
            main.put("temp_min", tempC);
            main.put("temp_max", tempC);

            Map<String, Object> item = new LinkedHashMap<>();
            item.put("dt", epoch);
            item.put("main", main);

            if (weatherCode != null) {
                item.put("weather", List.of(Map.of(
                        "id", weatherCode,
                        "description", weatherSymbolDescription(weatherCode),
                        "icon", weatherSymbolIcon(weatherCode))));
            }
            if (windSpeedMs != null || windDeg != null) {
                Map<String, Object> wind = new LinkedHashMap<>();
                if (windSpeedMs != null) {
                    wind.put("speed", windSpeedMs);
                }
                if (windDeg != null) {
                    wind.put("deg", (int) Math.round(windDeg));
                }
                item.put("wind", wind);
            }
            if (precipMm != null && precipMm > 0) {
                item.put("rain", Map.of("1h", precipMm));
            }
            if (pop != null) {
                item.put("pop", pop);
            }
            return item;
        }
    }

    private static String weatherSymbolDescription(int code) {
        return switch (code) {
            case 1 -> "Ensoleillé";
            case 2 -> "Partiellement ensoleillé";
            case 3 -> "Partiellement nuageux";
            case 4 -> "Couvert";
            case 5 -> "Brouillard";
            case 6 -> "Bruine";
            case 7 -> "Pluie";
            case 8 -> "Averses";
            case 9 -> "Orages";
            case 10 -> "Neige";
            case 11 -> "Averses de neige";
            case 12 -> "Vent fort";
            default -> "Conditions météo (" + code + ")";
        };
    }

    private static String weatherSymbolIcon(int code) {
        return switch (code) {
            case 1 -> "01d";
            case 2, 3 -> "02d";
            case 4, 5 -> "03d";
            case 6, 7, 8 -> "09d";
            case 9 -> "11d";
            case 10, 11 -> "13d";
            default -> "50d";
        };
    }
}
