package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.config.RestTemplateConfig;
import com.pat.controller.dto.ReliefHorizonResponse;
import com.pat.controller.dto.ReliefPeakDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

import javax.imageio.ImageIO;
import jakarta.annotation.PreDestroy;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * PeakFinder-style 360° DEM horizon + OSM named peaks.
 * Terrarium tiles (Mapzen / AWS terrain-tiles) and Overpass are fetched server-side.
 */
@Service
public class ReliefFinderService {

    private static final Logger log = LoggerFactory.getLogger(ReliefFinderService.class);
    private static final String UA = "PATTOOL-ReliefFinder/1.0";
    private static final int MAX_TILE_BYTES = 400_000;
    private static final int MAX_OVERPASS_BYTES = 2 * 1024 * 1024;
    private static final int TILE_CACHE_MAX = 160;
    private static final int RESULT_CACHE_MAX = 40;
    private static final long RESULT_TTL_MS = TimeUnit.MINUTES.toMillis(20);
    private static final double EYE_HEIGHT_M = 1.7;
    private static final double VISIBLE_EL_SLACK_DEG = 0.22;
    private static final int MAX_PEAKS = 80;

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final String terrariumUrlTemplate;
    private final List<String> overpassUrls;
    private final ExecutorService pool = Executors.newFixedThreadPool(8);

    private final Map<String, short[]> tileCache = Collections.synchronizedMap(
            new LinkedHashMap<>(64, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, short[]> eldest) {
                    return size() > TILE_CACHE_MAX;
                }
            });

    private final ConcurrentHashMap<String, CachedHorizon> resultCache = new ConcurrentHashMap<>();

    public ReliefFinderService(
            @Qualifier(RestTemplateConfig.RELIEF_FINDER_REST_TEMPLATE) RestTemplate restTemplate,
            ObjectMapper objectMapper,
            @Value("${relief.finder.terrarium-url:https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png}")
                    String terrariumUrlTemplate,
            @Value("${relief.finder.overpass-urls:https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter}")
                    String overpassUrlsCsv) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
        this.terrariumUrlTemplate = terrariumUrlTemplate;
        this.overpassUrls = parseCsv(overpassUrlsCsv);
    }

    @PreDestroy
    void shutdown() {
        pool.shutdownNow();
    }

    public ReliefHorizonResponse compute(
            double lat,
            double lon,
            double radiusKm,
            Double observerAltM,
            double stepDeg) {
        double latC = clamp(lat, -85.0, 85.0);
        double lonC = ReliefFinderMath.normalizeLon(lon);
        double radius = clamp(radiusKm, 15.0, 150.0);
        double step = stepDeg <= 0.75 ? 0.5 : 1.0;
        String key = cacheKey(latC, lonC, radius, observerAltM, step);
        CachedHorizon hit = resultCache.get(key);
        if (hit != null && hit.expiresAt > Instant.now().toEpochMilli()) {
            return hit.value;
        }
        pruneResultCache();
        ReliefHorizonResponse computed = computeUncached(latC, lonC, radius, observerAltM, step);
        resultCache.put(key, new CachedHorizon(computed, Instant.now().toEpochMilli() + RESULT_TTL_MS));
        return computed;
    }

    private ReliefHorizonResponse computeUncached(
            double lat,
            double lon,
            double radiusKm,
            Double observerAltM,
            double stepDeg) {
        int zoom = ReliefFinderMath.zoomForRadiusKm(radiusKm);
        List<int[]> tiles = tilesCovering(lat, lon, radiusKm, zoom);
        fetchTiles(zoom, tiles);
        TileAtlas atlas = (z, x, y) -> tileCache.get(ReliefFinderMath.tileKey(z, x, y));

        double demAtObs = ReliefFinderMath.sampleElevation(lat, lon, zoom, atlas);
        if (!Double.isFinite(demAtObs)) {
            demAtObs = 0;
        }
        double observerH = observerAltM != null && Double.isFinite(observerAltM)
                ? observerAltM
                : demAtObs + EYE_HEIGHT_M;

        int n = (int) Math.round(360.0 / stepDeg);
        float[] horizonEl = new float[n];
        float[] horizonDist = new float[n];
        double maxDist = radiusKm * 1000.0;
        for (int i = 0; i < n; i++) {
            double az = i * stepDeg;
            double bestEl = -90;
            double bestDist = maxDist;
            for (double dist = 50; dist <= maxDist; dist = nextSampleDist(dist, maxDist)) {
                double[] dest = ReliefFinderMath.destination(lat, lon, az, dist);
                double h = ReliefFinderMath.sampleElevation(dest[0], dest[1], zoom, atlas);
                if (!Double.isFinite(h)) {
                    continue;
                }
                double el = ReliefFinderMath.elevationDeg(observerH, h, dist);
                if (Double.isFinite(el) && el > bestEl) {
                    bestEl = el;
                    bestDist = dist;
                }
            }
            horizonEl[i] = (float) bestEl;
            horizonDist[i] = (float) bestDist;
        }

        List<ReliefPeakDto> peaks = List.of();
        String peakSource = "none";
        try {
            peaks = loadPeaks(lat, lon, radiusKm, observerH, zoom, atlas, horizonEl, horizonDist, stepDeg);
            peakSource = "openstreetmap-overpass";
        } catch (RuntimeException e) {
            log.warn("Relief Finder peaks failed: {}", e.toString());
        }

        return new ReliefHorizonResponse(
                lat,
                lon,
                Math.round(observerH * 10) / 10.0,
                radiusKm,
                stepDeg,
                zoom,
                horizonEl,
                horizonDist,
                peaks,
                "mapzen-terrarium",
                peakSource);
    }

    private static double nextSampleDist(double dist, double maxDist) {
        double next = dist < 1500 ? dist + 80 : dist * 1.08;
        if (next > maxDist && dist < maxDist) {
            return maxDist;
        }
        return next;
    }

    private List<ReliefPeakDto> loadPeaks(
            double lat,
            double lon,
            double radiusKm,
            double observerH,
            int zoom,
            TileAtlas atlas,
            float[] horizonEl,
            float[] horizonDist,
            double stepDeg) {
        JsonNode root = fetchOverpass(lat, lon, radiusKm);
        if (root == null || !root.has("elements")) {
            return List.of();
        }
        List<ReliefPeakDto> all = new ArrayList<>();
        for (JsonNode el : root.get("elements")) {
            JsonNode tags = el.path("tags");
            String name = firstName(tags);
            if (name == null) {
                continue;
            }
            double pLat = el.path("lat").asDouble(Double.NaN);
            double pLon = el.path("lon").asDouble(Double.NaN);
            if (!Double.isFinite(pLat) || !Double.isFinite(pLon)) {
                continue;
            }
            double distM = ReliefFinderMath.haversineM(lat, lon, pLat, pLon);
            if (distM < 250 || distM > radiusKm * 1000 + 200) {
                continue;
            }
            double eleM = parseEle(tags.path("ele").asText(null));
            if (!Double.isFinite(eleM)) {
                eleM = ReliefFinderMath.sampleElevation(pLat, pLon, zoom, atlas);
            }
            if (!Double.isFinite(eleM)) {
                continue;
            }
            double az = ReliefFinderMath.initialBearingDeg(lat, lon, pLat, pLon);
            double elDeg = ReliefFinderMath.elevationDeg(observerH, eleM, distM);
            if (!Double.isFinite(elDeg)) {
                continue;
            }
            int idx = horizonIndex(az, stepDeg, horizonEl.length);
            double skyline = horizonEl[idx];
            double skylineDist = horizonDist[idx];
            boolean visible = elDeg >= skyline - VISIBLE_EL_SLACK_DEG
                    || (elDeg >= skyline - 0.45 && distM <= skylineDist + 800);
            all.add(new ReliefPeakDto(
                    name,
                    round6(pLat),
                    round6(pLon),
                    Math.round(eleM),
                    Math.round(az * 10) / 10.0,
                    Math.round(elDeg * 100) / 100.0,
                    Math.round(distM / 10.0) / 100.0,
                    visible));
        }
        all.sort(Comparator
                .comparing(ReliefPeakDto::visible).reversed()
                .thenComparing(Comparator.comparingDouble(ReliefPeakDto::eleM).reversed()));
        if (all.size() > MAX_PEAKS) {
            List<ReliefPeakDto> kept = new ArrayList<>();
            for (ReliefPeakDto p : all) {
                if (p.visible() || kept.size() < MAX_PEAKS / 2) {
                    kept.add(p);
                }
                if (kept.size() >= MAX_PEAKS) {
                    break;
                }
            }
            return kept;
        }
        return all;
    }

    static int horizonIndex(double azDeg, double stepDeg, int n) {
        int i = (int) Math.round(ReliefFinderMath.normalizeDeg(azDeg) / stepDeg) % n;
        if (i < 0) {
            i += n;
        }
        return i;
    }

    private JsonNode fetchOverpass(double lat, double lon, double radiusKm) {
        String query = String.format(
                Locale.US,
                """
                [out:json][timeout:25];
                (
                  node["natural"="peak"](around:%d,%.5f,%.5f);
                  node["natural"="volcano"](around:%d,%.5f,%.5f);
                );
                out tags center;
                """,
                Math.round(radiusKm * 1000), lat, lon,
                Math.round(radiusKm * 1000), lat, lon);
        Exception last = null;
        for (String url : overpassUrls) {
            try {
                HttpHeaders headers = new HttpHeaders();
                headers.set(HttpHeaders.USER_AGENT, UA);
                headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
                headers.setAccept(List.of(MediaType.APPLICATION_JSON));
                HttpEntity<String> entity = new HttpEntity<>("data=" + urlEncode(query), headers);
                ResponseEntity<byte[]> response = restTemplate.exchange(url, HttpMethod.POST, entity, byte[].class);
                byte[] body = response.getBody();
                if (body == null || body.length == 0 || body.length > MAX_OVERPASS_BYTES) {
                    continue;
                }
                return objectMapper.readTree(body);
            } catch (Exception e) {
                last = e;
                log.debug("Overpass {} failed: {}", url, e.toString());
            }
        }
        if (last != null) {
            throw new IllegalStateException("Overpass unavailable", last);
        }
        return null;
    }

    private void fetchTiles(int zoom, List<int[]> tiles) {
        List<CompletableFuture<Void>> jobs = new ArrayList<>();
        for (int[] t : tiles) {
            String key = ReliefFinderMath.tileKey(zoom, t[0], t[1]);
            if (tileCache.containsKey(key)) {
                continue;
            }
            jobs.add(CompletableFuture.runAsync(() -> loadTile(zoom, t[0], t[1]), pool));
        }
        if (jobs.isEmpty()) {
            return;
        }
        try {
            CompletableFuture.allOf(jobs.toArray(CompletableFuture[]::new)).get(45, TimeUnit.SECONDS);
        } catch (Exception e) {
            log.warn("Relief Finder tile wait: {}", e.toString());
        }
    }

    private void loadTile(int zoom, int x, int y) {
        String key = ReliefFinderMath.tileKey(zoom, x, y);
        if (tileCache.containsKey(key)) {
            return;
        }
        String url = terrariumUrlTemplate
                .replace("{z}", Integer.toString(zoom))
                .replace("{x}", Integer.toString(x))
                .replace("{y}", Integer.toString(y));
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.USER_AGENT, UA);
            headers.set(HttpHeaders.ACCEPT, "image/png");
            ResponseEntity<byte[]> response = restTemplate.exchange(
                    url, HttpMethod.GET, new HttpEntity<>(headers), byte[].class);
            byte[] body = response.getBody();
            if (body == null || body.length == 0 || body.length > MAX_TILE_BYTES) {
                return;
            }
            BufferedImage img = ImageIO.read(new ByteArrayInputStream(body));
            if (img == null || img.getWidth() < ReliefFinderMath.TILE_SIZE
                    || img.getHeight() < ReliefFinderMath.TILE_SIZE) {
                return;
            }
            short[] data = new short[ReliefFinderMath.TILE_SIZE * ReliefFinderMath.TILE_SIZE];
            for (int py = 0; py < ReliefFinderMath.TILE_SIZE; py++) {
                for (int px = 0; px < ReliefFinderMath.TILE_SIZE; px++) {
                    data[py * ReliefFinderMath.TILE_SIZE + px] =
                            ReliefFinderMath.terrariumHeightShort(img.getRGB(px, py));
                }
            }
            tileCache.put(key, data);
        } catch (RestClientException e) {
            log.debug("Terrarium tile {} failed: {}", key, e.toString());
        } catch (Exception e) {
            log.warn("Terrarium decode {} failed: {}", key, e.toString());
        }
    }

    private List<int[]> tilesCovering(double lat, double lon, double radiusKm, int zoom) {
        double[] xy = new double[2];
        ReliefFinderMath.latLonToTile(lat, lon, zoom, xy);
        double metersPerPixel = 156543.03392 * Math.cos(Math.toRadians(lat)) / (1 << zoom);
        double tileM = metersPerPixel * ReliefFinderMath.TILE_SIZE;
        int span = Math.max(1, (int) Math.ceil((radiusKm * 1000.0) / tileM) + 1);
        int cx = (int) Math.floor(xy[0]);
        int cy = (int) Math.floor(xy[1]);
        int n = ReliefFinderMath.tileCount(zoom);
        List<int[]> out = new ArrayList<>();
        for (int dy = -span; dy <= span; dy++) {
            int ty = cy + dy;
            if (ty < 0 || ty >= n) {
                continue;
            }
            for (int dx = -span; dx <= span; dx++) {
                int tx = ((cx + dx) % n + n) % n;
                out.add(new int[] { tx, ty });
            }
        }
        return out;
    }

    private void pruneResultCache() {
        if (resultCache.size() < RESULT_CACHE_MAX) {
            return;
        }
        long now = Instant.now().toEpochMilli();
        resultCache.entrySet().removeIf(e -> e.getValue().expiresAt < now);
        if (resultCache.size() >= RESULT_CACHE_MAX) {
            resultCache.clear();
        }
    }

    private static String cacheKey(double lat, double lon, double radius, Double obsAlt, double step) {
        long alat = Math.round(lat * 500);
        long alon = Math.round(lon * 500);
        long alt = obsAlt == null || !Double.isFinite(obsAlt) ? Long.MIN_VALUE : Math.round(obsAlt);
        return alat + ":" + alon + ":" + Math.round(radius) + ":" + alt + ":" + step;
    }

    private static String firstName(JsonNode tags) {
        if (tags == null || tags.isMissingNode()) {
            return null;
        }
        for (String key : List.of("name", "name:fr", "name:en", "name:de", "name:it")) {
            String v = tags.path(key).asText(null);
            if (v != null) {
                String t = v.trim();
                if (t.length() >= 2 && !t.equalsIgnoreCase("unnamed")) {
                    return t.length() > 48 ? t.substring(0, 48) : t;
                }
            }
        }
        return null;
    }

    private static double parseEle(String raw) {
        if (raw == null || raw.isBlank()) {
            return Double.NaN;
        }
        String t = raw.trim().replace(',', '.').replace("m", "").replace(" ", "");
        try {
            return Double.parseDouble(t);
        } catch (NumberFormatException e) {
            return Double.NaN;
        }
    }

    private static String urlEncode(String q) {
        return java.net.URLEncoder.encode(q, java.nio.charset.StandardCharsets.UTF_8);
    }

    private static List<String> parseCsv(String csv) {
        List<String> out = new ArrayList<>();
        for (String p : csv.split(",")) {
            String t = p.trim();
            if (!t.isEmpty()) {
                out.add(t);
            }
        }
        return out;
    }

    private static double clamp(double v, double lo, double hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    private static double round6(double v) {
        return Math.round(v * 1_000_000.0) / 1_000_000.0;
    }

    private record CachedHorizon(ReliefHorizonResponse value, long expiresAt) {}

    @FunctionalInterface
    private interface TileAtlas extends ReliefFinderMath.TileAtlas {}
}
