package com.pat.service;

import com.pat.controller.dto.TemperatureLabelsRequestDto;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * MeteoSwiss SwissMetNet (ogd-smn) automatic weather station observations for map temperature labels.
 * Open Data — no API key required.
 */
@Service
public class MeteoSwissObsService {

    private static final Logger log = LoggerFactory.getLogger(MeteoSwissObsService.class);

    private static final String META_STATIONS_URL =
            "https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ogd-smn_meta_stations.csv";
    private static final String STATION_T_NOW_URL =
            "https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/%s/ogd-smn_%s_t_now.csv";
    private static final String STATION_H_NOW_URL =
            "https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/%s/ogd-smn_%s_h_now.csv";
    private static final String STATION_H_RECENT_URL =
            "https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/%s/ogd-smn_%s_h_recent.csv";

    private static final DateTimeFormatter OBS_TS =
            DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm");
    /** MeteoSwiss {@code reference_timestamp} values are UTC wall-clock times (see opendata docs). */
    private static final ZoneId OBS_ZONE = ZoneOffset.UTC;

    private static final double CH_MIN_LAT = 45.82;
    private static final double CH_MAX_LAT = 47.81;
    private static final double CH_MIN_LON = 5.96;
    private static final double CH_MAX_LON = 10.49;

    private static final Duration DEFAULT_CACHE_TTL = Duration.ofMinutes(5);
    private static final Duration HISTORY_CACHE_TTL = Duration.ofMinutes(30);
    private static final String AUTOMATIC_STATION_MARKER = "automatic weather stations";

    private static final List<String> MAJOR_CITY_NAME_TOKENS = List.of(
            "ZÜRICH", "ZURICH", "GENÈVE", "GENEVE", "GENEVA", "BERN", "BERNE", "BASEL", "BÂLE",
            "LAUSANNE", "LUZERN", "LUCERNE", "LUGANO", "ST. GALLEN", "WINTERTHUR", "BIEL",
            "THUN", "CHUR", "SION", "NEUCHÂTEL", "NEUCHATEL", "FRIBOURG", "SCHAFFHAUSEN", "ZUG");

    private final RestTemplate restTemplate;
    private final boolean enabled;

    private volatile List<SmnStation> catalog = List.of();
    private final ConcurrentHashMap<String, ObsCacheEntry> obsCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, BoundsCacheEntry> boundsResponseCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, HistoryCacheEntry> historyResponseCache = new ConcurrentHashMap<>();

    public MeteoSwissObsService(
            RestTemplate restTemplate,
            @Value("${meteoswiss.obs.enabled:true}") boolean enabled) {
        this.restTemplate = restTemplate;
        this.enabled = enabled;
    }

    @PostConstruct
    public void init() {
        if (enabled) {
            CompletableFuture.runAsync(this::ensureCatalogLoaded);
        }
    }

    public Map<String, Object> getStatusFragment() {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("meteoswissSmnEnabled", enabled);
        status.put("meteoswissSmnStationCount", catalog.size());
        status.put("meteoswissSmnReady", !catalog.isEmpty());
        return status;
    }

    /**
     * Nearest SwissMetNet station temperature for each requested point (popup / trace viewer).
     */
    public Map<String, Object> getTemperatureLabelsForPoints(List<TemperatureLabelsRequestDto.Point> targets) {
        if (!enabled) {
            return error("MeteoSwiss SMN observations are disabled");
        }
        ensureCatalogLoaded();
        if (catalog.isEmpty()) {
            return error("MeteoSwiss SMN station catalog is loading, please retry shortly");
        }
        if (targets == null || targets.isEmpty()) {
            Map<String, Object> empty = new LinkedHashMap<>();
            empty.put("source", "meteoswiss-smn");
            empty.put("points", List.of());
            empty.put("count", 0);
            empty.put("requested", 0);
            return empty;
        }

        List<Map<String, Object>> points = new ArrayList<>();
        for (TemperatureLabelsRequestDto.Point target : targets) {
            if (!isInSwitzerland(target.lat(), target.lon())) {
                continue;
            }
            SmnStation station = resolveStationForTarget(target);
            if (station == null) {
                continue;
            }
            Map<String, Object> point = fetchStationTemperaturePoint(station);
            if (point == null) {
                continue;
            }
            applyCatalogCoordinates(station, point);
            double distKm = haversineKm(target.lat(), target.lon(), station.lat(), station.lon());
            if (distKm >= 0.05) {
                point.put("nearestStationKm", round(distKm, 1));
            }
            points.add(point);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("source", "meteoswiss-smn");
        result.put("points", points);
        result.put("count", points.size());
        result.put("requested", targets.size());
        result.put("cacheTtlMinutes", DEFAULT_CACHE_TTL.toMinutes());
        return result;
    }

    /**
     * Force-refresh one or more stations from SwissMetNet {@code t_now} CSV and store fresh values in the station cache.
     */
    public Map<String, Object> refreshTemperaturePoints(List<TemperatureLabelsRequestDto.Point> targets) {
        if (targets != null) {
            for (TemperatureLabelsRequestDto.Point target : targets) {
                if (!isInSwitzerland(target.lat(), target.lon())) {
                    continue;
                }
                SmnStation station = resolveStationForTarget(target);
                if (station != null) {
                    obsCache.remove(station.id());
                }
            }
        }
        Map<String, Object> result = getTemperatureLabelsForPoints(targets);
        result.put("refreshed", true);
        return result;
    }

    /**
     * Nearest SwissMetNet station + hourly archived observations for a map point (ogd-smn h_recent + h_now).
     * Response shape mirrors DPClim horaire for the point timeline modal.
     */
    public Map<String, Object> getNearbyHourlyHistory(double lat, double lon, int days, String stationId, boolean forceRefresh) {
        if (!enabled) {
            return error("MeteoSwiss SMN observations are disabled");
        }
        if (!isInSwitzerland(lat, lon)) {
            return error("Coordinates outside Switzerland");
        }
        ensureCatalogLoaded();
        if (catalog.isEmpty()) {
            return error("MeteoSwiss SMN station catalog is loading, please retry shortly");
        }

        int resolvedDays = clampHistoryDays(days);
        SmnStation station = resolveStationForCoordinates(lat, lon, stationId);
        if (station == null) {
            return error("No MeteoSwiss SMN station found for this location");
        }

        String cacheKey = station.id().toUpperCase(Locale.ROOT) + "|" + resolvedDays;
        if (!forceRefresh) {
            HistoryCacheEntry cached = historyResponseCache.get(cacheKey);
            if (cached != null && cached.isValid(HISTORY_CACHE_TTL)) {
                Map<String, Object> copy = new LinkedHashMap<>(cached.result());
                copy.put("cached", true);
                return copy;
            }
        }

        Instant periodEnd = Instant.now().truncatedTo(ChronoUnit.HOURS);
        Instant periodStart = periodEnd.minus(resolvedDays - 1L, ChronoUnit.DAYS).truncatedTo(ChronoUnit.DAYS);

        String abbr = station.id().toLowerCase(Locale.ROOT);
        Map<Long, Map<String, Object>> rowByEpoch = new LinkedHashMap<>();
        mergeHourlyCsvIntoRows(
                STATION_H_RECENT_URL.formatted(abbr, abbr), periodStart, periodEnd, rowByEpoch);
        mergeHourlyCsvIntoRows(
                STATION_H_NOW_URL.formatted(abbr, abbr), periodStart, periodEnd, rowByEpoch);

        List<Map<String, Object>> rows = rowByEpoch.values().stream()
                .sorted(Comparator.comparingLong(row -> ((Number) row.get("epochSeconds")).longValue()))
                .toList();

        Map<String, Object> stationMeta = new LinkedHashMap<>();
        stationMeta.put("id", station.id());
        stationMeta.put("name", station.name());
        stationMeta.put("lat", station.lat());
        stationMeta.put("lon", station.lon());
        stationMeta.put("distanceKm", round(haversineKm(lat, lon, station.lat(), station.lon()), 1));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("frequency", "horaire");
        result.put("requestedDays", resolvedDays);
        result.put("periodStart", periodStart.toString());
        result.put("periodEnd", periodEnd.toString());
        result.put("station", stationMeta);
        result.put("rows", rows);
        result.put("source", "MeteoSwiss SMN");
        result.put("patSource", "meteoswiss-smn");
        result.put("cacheTtlMinutes", HISTORY_CACHE_TTL.toMinutes());
        historyResponseCache.put(cacheKey, new HistoryCacheEntry(result, Instant.now()));
        return result;
    }

    /** Clears in-memory MeteoSwiss SMN hourly history response cache. */
    public int clearHistoryCache() {
        int cleared = historyResponseCache.size();
        historyResponseCache.clear();
        return cleared;
    }

    public Map<String, Object> getTemperatureLabelsInBounds(
            double minLat, double maxLat, double minLon, double maxLon, int maxStations) {
        if (!enabled) {
            return error("MeteoSwiss SMN observations are disabled");
        }
        ensureCatalogLoaded();
        if (catalog.isEmpty()) {
            return error("MeteoSwiss SMN station catalog is loading, please retry shortly");
        }

        double south = Math.min(minLat, maxLat);
        double north = Math.max(minLat, maxLat);
        double west = Math.min(minLon, maxLon);
        double east = Math.max(minLon, maxLon);
        int stationLimit = clampMaxStations(maxStations);
        String boundsKey = boundsCacheKey(south, north, west, east, stationLimit);

        BoundsCacheEntry cachedBounds = boundsResponseCache.get(boundsKey);
        if (cachedBounds != null && cachedBounds.isValid(DEFAULT_CACHE_TTL)) {
            return cachedBounds.copyResult();
        }

        try {
            List<SmnStation> inBounds = catalog.stream()
                    .filter(s -> s.lat >= south && s.lat <= north && s.lon >= west && s.lon <= east)
                    .toList();

            StationSelection selection = selectStationsForViewport(
                    inBounds, stationLimit, south, north, west, east);
            List<Map<String, Object>> points = selection.stations().parallelStream()
                    .map(this::fetchStationTemperaturePoint)
                    .filter(Objects::nonNull)
                    .collect(Collectors.toCollection(ArrayList::new));

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("source", "meteoswiss-smn");
            result.put("points", points);
            result.put("count", points.size());
            result.put("stationsQueried", selection.stations().size());
            result.put("stationsInBounds", inBounds.size());
            result.put("detailLevel", selection.detailLevel());
            result.put("cacheTtlMinutes", DEFAULT_CACHE_TTL.toMinutes());
            boundsResponseCache.put(boundsKey, new BoundsCacheEntry(result, Instant.now()));
            return result;
        } catch (Exception e) {
            log.warn("MeteoSwiss SMN temperature labels failed: {}", e.getMessage());
            return error("MeteoSwiss SMN temperature labels failed: " + e.getMessage());
        }
    }

    private Map<String, Object> fetchStationTemperaturePoint(SmnStation station) {
        ObsCacheEntry cached = obsCache.get(station.id());
        if (cached != null && cached.isValid(DEFAULT_CACHE_TTL)) {
            Map<String, Object> point = new LinkedHashMap<>(cached.point());
            point.put("cached", true);
            applyCatalogCoordinates(station, point);
            return point;
        }

        String abbr = station.id().toLowerCase(Locale.ROOT);
        String url = STATION_T_NOW_URL.formatted(abbr, abbr);
        try {
            ParsedObservation parsed = restTemplate.execute(
                    url, org.springframework.http.HttpMethod.GET, null, this::parseStationTNowCsv);
            if (parsed == null || parsed.tempC == null) {
                return null;
            }
            Map<String, Object> point = new LinkedHashMap<>();
            applyCatalogCoordinates(station, point);
            point.put("tempC", parsed.tempC);
            point.put("stationId", station.id());
            point.put("stationName", station.name);
            if (parsed.humidityPct != null) {
                point.put("humidityPct", parsed.humidityPct);
            }
            if (parsed.windDirectionDeg != null) {
                point.put("windDirectionDeg", parsed.windDirectionDeg);
            }
            if (parsed.windSpeedMs != null) {
                point.put("windSpeedMs", parsed.windSpeedMs);
            }
            if (parsed.precipitationMm != null) {
                point.put("precipitationMm", parsed.precipitationMm);
            }
            if (parsed.pressureHpa != null) {
                point.put("pressureHpa", parsed.pressureHpa);
            }
            if (parsed.observedAt != null) {
                point.put("observedAt", parsed.observedAt);
            }
            point.put("source", "meteoswiss-smn");
            obsCache.put(station.id(), new ObsCacheEntry(point, Instant.now()));
            return point;
        } catch (Exception e) {
            log.debug("MeteoSwiss SMN fetch failed for {}: {}", station.id(), e.getMessage());
            if (cached != null) {
                Map<String, Object> point = new LinkedHashMap<>(cached.point());
                point.put("cached", true);
                point.put("stale", true);
                applyCatalogCoordinates(station, point);
                return point;
            }
            return null;
        }
    }

    private ParsedObservation parseStationTNowCsv(org.springframework.http.client.ClientHttpResponse response) {
        try (InputStream body = response.getBody();
             BufferedReader reader = new BufferedReader(new InputStreamReader(body, StandardCharsets.ISO_8859_1))) {
            String headerLine = reader.readLine();
            if (headerLine == null || headerLine.isBlank()) {
                return null;
            }
            String[] headers = headerLine.split(";", -1);
            int tsIdx = findColumn(headers, "reference_timestamp");
            int tempIdx = findColumn(headers, "tre200s0");
            int tempFallbackIdx = findColumn(headers, "tresurs0");
            int tempGrassIdx = findColumn(headers, "tre005s0");
            int humidityIdx = findColumn(headers, "ure200s0");
            int windSpeedIdx = findColumn(headers, "fu3010z0");
            int windDirIdx = findColumn(headers, "dkl010z0");
            int precipIdx = findColumn(headers, "rre150z0");
            int pressureIdx = findColumn(headers, "pp0qffs0");

            ParsedObservation best = null;
            Instant bestObservedAt = null;
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }
                String[] cols = line.split(";", -1);
                Double tempC = firstDouble(cols, tempIdx, tempFallbackIdx, tempGrassIdx);
                if (tempC == null) {
                    continue;
                }
                Instant observedInstant = null;
                if (tsIdx >= 0 && cols.length > tsIdx) {
                    observedInstant = parseObservedInstant(cols[tsIdx]);
                }
                if (best != null && observedInstant != null && bestObservedAt != null
                        && !observedInstant.isAfter(bestObservedAt)) {
                    continue;
                }
                ParsedObservation row = new ParsedObservation();
                row.tempC = round(tempC, 1);
                row.humidityPct = parseDouble(cols, humidityIdx);
                row.windDirectionDeg = parseDouble(cols, windDirIdx);
                Double windKmh = parseDouble(cols, windSpeedIdx);
                if (windKmh != null) {
                    row.windSpeedMs = round(windKmh / 3.6, 1);
                }
                row.precipitationMm = parseDouble(cols, precipIdx);
                row.pressureHpa = parseDouble(cols, pressureIdx);
                if (observedInstant != null) {
                    row.observedAt = observedInstant.toString();
                }
                best = row;
                bestObservedAt = observedInstant;
            }
            return best;
        } catch (Exception e) {
            return null;
        }
    }

    private void ensureCatalogLoaded() {
        if (!catalog.isEmpty()) {
            return;
        }
        synchronized (this) {
            if (!catalog.isEmpty()) {
                return;
            }
            catalog = loadCatalog(META_STATIONS_URL);
            log.info("MeteoSwiss SMN station catalog loaded: {} automatic stations", catalog.size());
        }
    }

    private List<SmnStation> loadCatalog(String url) {
        List<SmnStation> loaded = new ArrayList<>(220);
        try {
            restTemplate.execute(url, org.springframework.http.HttpMethod.GET, null, response -> {
                try (InputStream body = response.getBody();
                     BufferedReader reader = new BufferedReader(
                             new InputStreamReader(body, StandardCharsets.ISO_8859_1))) {
                    String headerLine = reader.readLine();
                    if (headerLine == null) {
                        return null;
                    }
                    String[] headers = headerLine.split(";", -1);
                    int abbrIdx = findColumn(headers, "station_abbr");
                    int nameIdx = findColumn(headers, "station_name");
                    int typeIdx = findColumn(headers, "station_type_en");
                    int latIdx = findColumn(headers, "station_coordinates_wgs84_lat");
                    int lonIdx = findColumn(headers, "station_coordinates_wgs84_lon");
                    String line;
                    while ((line = reader.readLine()) != null) {
                        if (line.isBlank()) {
                            continue;
                        }
                        String[] cols = line.split(";", -1);
                        if (cols.length <= Math.max(abbrIdx, Math.max(latIdx, lonIdx))) {
                            continue;
                        }
                        if (typeIdx >= 0 && cols.length > typeIdx) {
                            String type = cols[typeIdx].toLowerCase(Locale.ROOT);
                            if (!type.contains(AUTOMATIC_STATION_MARKER)) {
                                continue;
                            }
                        }
                        String id = clean(cols[abbrIdx]);
                        Double lat = parseDouble(cols, latIdx);
                        Double lon = parseDouble(cols, lonIdx);
                        if (id == null || lat == null || lon == null) {
                            continue;
                        }
                        String name = nameIdx >= 0 && cols.length > nameIdx ? clean(cols[nameIdx]) : id;
                        loaded.add(new SmnStation(id, name != null ? name : id, lat, lon));
                    }
                }
                return null;
            });
        } catch (Exception e) {
            log.warn("MeteoSwiss SMN station catalog download failed: {}", e.getMessage());
        }
        return List.copyOf(loaded);
    }

    private static void applyCatalogCoordinates(SmnStation station, Map<String, Object> point) {
        point.put("lat", station.lat());
        point.put("lon", station.lon());
        point.put("stationLat", station.lat());
        point.put("stationLon", station.lon());
    }

    private record SmnStation(String id, String name, double lat, double lon) {}

    private static class ParsedObservation {
        Double tempC;
        Double humidityPct;
        Double windDirectionDeg;
        Double windSpeedMs;
        Double precipitationMm;
        Double pressureHpa;
        String observedAt;
    }

    private record ObsCacheEntry(Map<String, Object> point, Instant loadedAt) {
        boolean isValid(Duration ttl) {
            return loadedAt.plus(ttl).isAfter(Instant.now());
        }
    }

    private record BoundsCacheEntry(Map<String, Object> result, Instant loadedAt) {
        boolean isValid(Duration ttl) {
            return loadedAt.plus(ttl).isAfter(Instant.now());
        }

        Map<String, Object> copyResult() {
            Map<String, Object> copy = new LinkedHashMap<>(result);
            copy.put("cached", true);
            return copy;
        }
    }

    private record HistoryCacheEntry(Map<String, Object> result, Instant loadedAt) {
        boolean isValid(Duration ttl) {
            return loadedAt.plus(ttl).isAfter(Instant.now());
        }
    }

    private record StationSelection(List<SmnStation> stations, String detailLevel) {}

    private static StationSelection selectStationsForViewport(
            List<SmnStation> inBounds, int maxStations,
            double south, double north, double west, double east) {
        if (inBounds.isEmpty()) {
            return new StationSelection(inBounds, "none");
        }
        double latSpan = north - south;
        double lonSpan = east - west;
        double area = latSpan * lonSpan;
        int limit = Math.min(maxStations, inBounds.size());

        boolean largeView = latSpan > 2.8 || lonSpan > 3.2 || area > 6;
        boolean mediumView = !largeView && (latSpan > 1.2 || lonSpan > 1.4 || area > 1.2);

        if (largeView) {
            List<SmnStation> major = pickMajorCityStations(inBounds, Math.min(20, limit));
            if (!major.isEmpty()) {
                return new StationSelection(major, "major-cities");
            }
            return new StationSelection(limitStations(inBounds, Math.min(16, limit)), "sparse");
        }
        if (mediumView) {
            List<SmnStation> major = pickMajorCityStations(inBounds, limit);
            if (major.size() >= limit) {
                return new StationSelection(major, "major-cities");
            }
            Set<String> usedIds = major.stream().map(SmnStation::id).collect(Collectors.toCollection(LinkedHashSet::new));
            List<SmnStation> mixed = new ArrayList<>(major);
            inBounds.stream()
                    .filter(s -> !usedIds.contains(s.id()))
                    .sorted(Comparator.comparing(SmnStation::id))
                    .limit(limit - mixed.size())
                    .forEach(mixed::add);
            return new StationSelection(mixed, "mixed");
        }
        return new StationSelection(limitStations(inBounds, limit), "all");
    }

    private static List<SmnStation> pickMajorCityStations(List<SmnStation> inBounds, int limit) {
        return inBounds.stream()
                .filter(MeteoSwissObsService::isMajorCityStation)
                .sorted(Comparator.comparingInt(MeteoSwissObsService::majorCityRank)
                        .thenComparing(SmnStation::id))
                .limit(limit)
                .toList();
    }

    private static boolean isMajorCityStation(SmnStation station) {
        String upper = station.name().toUpperCase(Locale.ROOT);
        for (String token : MAJOR_CITY_NAME_TOKENS) {
            if (upper.contains(token)) {
                return true;
            }
        }
        return false;
    }

    private static int majorCityRank(SmnStation station) {
        String upper = station.name().toUpperCase(Locale.ROOT);
        for (int i = 0; i < MAJOR_CITY_NAME_TOKENS.size(); i++) {
            if (upper.contains(MAJOR_CITY_NAME_TOKENS.get(i))) {
                return i;
            }
        }
        return MAJOR_CITY_NAME_TOKENS.size();
    }

    private SmnStation resolveStationForTarget(TemperatureLabelsRequestDto.Point target) {
        return resolveStationForCoordinates(target.lat(), target.lon(), target.stationId());
    }

    private SmnStation resolveStationForCoordinates(double lat, double lon, String stationId) {
        if (stationId != null && !stationId.isBlank()) {
            String wanted = stationId.trim();
            for (SmnStation station : catalog) {
                if (station.id().equalsIgnoreCase(wanted)) {
                    return station;
                }
            }
        }
        return catalog.stream()
                .min(Comparator.comparingDouble(station ->
                        haversineKm(lat, lon, station.lat(), station.lon())))
                .orElse(null);
    }

    private static int clampHistoryDays(int days) {
        if (days < 1) {
            return 7;
        }
        return Math.min(days, 30);
    }

    private void mergeHourlyCsvIntoRows(
            String url,
            Instant periodStart,
            Instant periodEnd,
            Map<Long, Map<String, Object>> rowByEpoch) {
        try {
            restTemplate.execute(url, HttpMethod.GET, null, response ->
                    parseHourlyCsvRows(response.getBody(), periodStart, periodEnd, rowByEpoch));
        } catch (Exception e) {
            log.debug("MeteoSwiss SMN hourly CSV failed ({}): {}", url, e.getMessage());
        }
    }

    private Void parseHourlyCsvRows(
            InputStream body,
            Instant periodStart,
            Instant periodEnd,
            Map<Long, Map<String, Object>> rowByEpoch) {
        if (body == null) {
            return null;
        }
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(body, StandardCharsets.ISO_8859_1))) {
            String headerLine = reader.readLine();
            if (headerLine == null || headerLine.isBlank()) {
                return null;
            }
            String[] headers = headerLine.split(";", -1);
            int tsIdx = findColumn(headers, "reference_timestamp");
            int tempIdx = findColumn(headers, "tre200s0");
            int tempFallbackIdx = findColumn(headers, "tresurs0");
            int tempGrassIdx = findColumn(headers, "tre005s0");
            int humidityIdx = findColumn(headers, "ure200s0");
            int windSpeedIdx = findColumn(headers, "fu3010z0");
            int precipIdx = findColumn(headers, "rre150z0");

            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }
                String[] cols = line.split(";", -1);
                if (tsIdx < 0 || cols.length <= tsIdx) {
                    continue;
                }
                Instant observedInstant = parseObservedInstant(cols[tsIdx]);
                if (observedInstant == null) {
                    continue;
                }
                Instant slotInstant = observedInstant.truncatedTo(ChronoUnit.HOURS);
                if (slotInstant.isBefore(periodStart) || slotInstant.isAfter(periodEnd)) {
                    continue;
                }
                Double tempC = firstDouble(cols, tempIdx, tempFallbackIdx, tempGrassIdx);
                if (tempC == null) {
                    continue;
                }
                Map<String, Object> row = new LinkedHashMap<>();
                long epochSeconds = slotInstant.getEpochSecond();
                row.put("epochSeconds", epochSeconds);
                row.put("reference_timestamp", cols[tsIdx].trim());
                row.put("T", round(tempC, 1));
                Double humidity = parseDouble(cols, humidityIdx);
                if (humidity != null) {
                    row.put("U", Math.round(humidity));
                }
                Double windKmh = parseDouble(cols, windSpeedIdx);
                if (windKmh != null) {
                    row.put("FF", round(windKmh / 3.6, 2));
                }
                Double precip = parseDouble(cols, precipIdx);
                if (precip != null) {
                    row.put("RR", precip);
                }
                rowByEpoch.put(epochSeconds, row);
            }
        } catch (Exception e) {
            log.debug("MeteoSwiss SMN hourly CSV parse failed: {}", e.getMessage());
        }
        return null;
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

    private static List<SmnStation> limitStations(List<SmnStation> inBounds, int limit) {
        if (inBounds.size() <= limit) {
            return inBounds;
        }
        return inBounds.stream()
                .sorted(Comparator.comparing(SmnStation::id))
                .limit(limit)
                .toList();
    }

    private static int clampMaxStations(int maxStations) {
        if (maxStations < 4) {
            return 4;
        }
        return Math.min(maxStations, 96);
    }

    private static String boundsCacheKey(double south, double north, double west, double east, int limit) {
        return String.format(Locale.ROOT, "%.3f|%.3f|%.3f|%.3f|%d", south, north, west, east, limit);
    }

    private static int findColumn(String[] headers, String name) {
        for (int i = 0; i < headers.length; i++) {
            if (name.equalsIgnoreCase(headers[i].trim())) {
                return i;
            }
        }
        return -1;
    }

    private static Double firstDouble(String[] cols, int... indices) {
        for (int idx : indices) {
            Double value = parseDouble(cols, idx);
            if (value != null) {
                return value;
            }
        }
        return null;
    }

    private static Double parseDouble(String[] cols, int idx) {
        if (idx < 0 || cols.length <= idx) {
            return null;
        }
        String raw = cols[idx];
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return Double.parseDouble(raw.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String clean(String raw) {
        if (raw == null) {
            return null;
        }
        String trimmed = raw.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static Instant parseObservedInstant(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            LocalDateTime ldt = LocalDateTime.parse(raw.trim(), OBS_TS);
            return ldt.atZone(OBS_ZONE).toInstant();
        } catch (DateTimeParseException e) {
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
        err.put("patSource", "meteoswiss-smn");
        return err;
    }
}
