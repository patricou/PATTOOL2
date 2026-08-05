package com.pat.service;

import com.pat.service.news.NewsApiService;
import com.pat.service.news.NewsDataService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * Aggregates every known PatTool in-memory cache for the System admin page:
 * status (entry counts / details) and clear / refresh actions.
 */
@Service
public class PatToolCacheAdminService {

    private static final Logger log = LoggerFactory.getLogger(PatToolCacheAdminService.class);

    private final ImageCompressionService imageCompressionService;
    private final CachePersistenceService cachePersistenceService;
    private final MediaCatalogCacheService mediaCatalogCacheService;
    private final TvCatalogService tvCatalogService;
    private final TvEpgService tvEpgService;
    private final RadioCatalogService radioCatalogService;
    private final InternetArchiveReplayService internetArchiveReplayService;
    private final InternetArchiveCatalogService internetArchiveCatalogService;
    private final FranceTvLiveService franceTvLiveService;
    private final Tf1LiveService tf1LiveService;
    private final M6GroupLiveService m6GroupLiveService;
    private final RtsLiveService rtsLiveService;
    private final CanalGroupLiveService canalGroupLiveService;
    private final ArteReplayService arteReplayService;
    private final MeteoFranceObsService meteoFranceObsService;
    private final OpenMeteoService openMeteoService;
    private final MeteoFranceAromepiService meteoFranceAromepiService;
    private final MeteoFranceArpegeService meteoFranceArpegeService;
    private final MeteoFranceClimService meteoFranceClimService;
    private final MeteoSwissObsService meteoSwissObsService;
    private final MeteoSwissForecastService meteoSwissForecastService;
    private final MeteoFranceRadarService meteoFranceRadarService;
    private final NewsApiService newsApiService;
    private final NewsDataService newsDataService;
    private final TwelveDataProxyService twelveDataProxyService;
    private final FrankfurterProxyService frankfurterProxyService;
    private final CoinGeckoProxyService coinGeckoProxyService;
    private final ElectricityProxyService electricityProxyService;
    private final ChemistryProxyService chemistryProxyService;
    private final GeocodeService geocodeService;
    private final IpGeolocationService ipGeolocationService;
    private final OpenSkyService openSkyService;
    private final GlobeProxyService globeProxyService;
    private final AgendaSocialGraphCache agendaSocialGraphCache;

    public PatToolCacheAdminService(
            ImageCompressionService imageCompressionService,
            CachePersistenceService cachePersistenceService,
            MediaCatalogCacheService mediaCatalogCacheService,
            TvCatalogService tvCatalogService,
            TvEpgService tvEpgService,
            RadioCatalogService radioCatalogService,
            InternetArchiveReplayService internetArchiveReplayService,
            InternetArchiveCatalogService internetArchiveCatalogService,
            FranceTvLiveService franceTvLiveService,
            Tf1LiveService tf1LiveService,
            M6GroupLiveService m6GroupLiveService,
            RtsLiveService rtsLiveService,
            CanalGroupLiveService canalGroupLiveService,
            ArteReplayService arteReplayService,
            MeteoFranceObsService meteoFranceObsService,
            OpenMeteoService openMeteoService,
            MeteoFranceAromepiService meteoFranceAromepiService,
            MeteoFranceArpegeService meteoFranceArpegeService,
            MeteoFranceClimService meteoFranceClimService,
            MeteoSwissObsService meteoSwissObsService,
            MeteoSwissForecastService meteoSwissForecastService,
            MeteoFranceRadarService meteoFranceRadarService,
            NewsApiService newsApiService,
            NewsDataService newsDataService,
            TwelveDataProxyService twelveDataProxyService,
            FrankfurterProxyService frankfurterProxyService,
            CoinGeckoProxyService coinGeckoProxyService,
            ElectricityProxyService electricityProxyService,
            ChemistryProxyService chemistryProxyService,
            GeocodeService geocodeService,
            IpGeolocationService ipGeolocationService,
            OpenSkyService openSkyService,
            GlobeProxyService globeProxyService,
            AgendaSocialGraphCache agendaSocialGraphCache) {
        this.imageCompressionService = imageCompressionService;
        this.cachePersistenceService = cachePersistenceService;
        this.mediaCatalogCacheService = mediaCatalogCacheService;
        this.tvCatalogService = tvCatalogService;
        this.tvEpgService = tvEpgService;
        this.radioCatalogService = radioCatalogService;
        this.internetArchiveReplayService = internetArchiveReplayService;
        this.internetArchiveCatalogService = internetArchiveCatalogService;
        this.franceTvLiveService = franceTvLiveService;
        this.tf1LiveService = tf1LiveService;
        this.m6GroupLiveService = m6GroupLiveService;
        this.rtsLiveService = rtsLiveService;
        this.canalGroupLiveService = canalGroupLiveService;
        this.arteReplayService = arteReplayService;
        this.meteoFranceObsService = meteoFranceObsService;
        this.openMeteoService = openMeteoService;
        this.meteoFranceAromepiService = meteoFranceAromepiService;
        this.meteoFranceArpegeService = meteoFranceArpegeService;
        this.meteoFranceClimService = meteoFranceClimService;
        this.meteoSwissObsService = meteoSwissObsService;
        this.meteoSwissForecastService = meteoSwissForecastService;
        this.meteoFranceRadarService = meteoFranceRadarService;
        this.newsApiService = newsApiService;
        this.newsDataService = newsDataService;
        this.twelveDataProxyService = twelveDataProxyService;
        this.frankfurterProxyService = frankfurterProxyService;
        this.coinGeckoProxyService = coinGeckoProxyService;
        this.electricityProxyService = electricityProxyService;
        this.chemistryProxyService = chemistryProxyService;
        this.geocodeService = geocodeService;
        this.ipGeolocationService = ipGeolocationService;
        this.openSkyService = openSkyService;
        this.globeProxyService = globeProxyService;
        this.agendaSocialGraphCache = agendaSocialGraphCache;
    }

    public Map<String, Object> listAll() {
        List<Map<String, Object>> caches = new ArrayList<>();
        for (CacheDef def : definitions()) {
            caches.add(statusOf(def));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("success", true);
        out.put("count", caches.size());
        out.put("caches", caches);
        return out;
    }

    public Map<String, Object> clearOne(String id) {
        CacheDef def = find(id);
        if (def == null) {
            return Map.of("success", false, "message", "Unknown cache id: " + id);
        }
        if (!def.clearable) {
            return Map.of("success", false, "message", "Cache is not clearable: " + id);
        }
        try {
            int cleared = def.clearer.get();
            log.info("Cleared cache {} ({} entries)", id, cleared);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("success", true);
            out.put("id", id);
            out.put("clearedEntries", cleared);
            out.put("cache", statusOf(def));
            return out;
        } catch (Exception e) {
            log.warn("Failed to clear cache {}: {}", id, e.toString());
            return Map.of("success", false, "message", e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }

    public Map<String, Object> clearAll() {
        List<Map<String, Object>> results = new ArrayList<>();
        int totalCleared = 0;
        for (CacheDef def : definitions()) {
            if (!def.clearable) {
                continue;
            }
            try {
                int cleared = def.clearer.get();
                totalCleared += cleared;
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("id", def.id);
                row.put("success", true);
                row.put("clearedEntries", cleared);
                results.add(row);
            } catch (Exception e) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("id", def.id);
                row.put("success", false);
                row.put("message", e.getMessage() != null ? e.getMessage() : e.toString());
                results.add(row);
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("success", true);
        out.put("totalClearedEntries", totalCleared);
        out.put("results", results);
        out.put("caches", listAll().get("caches"));
        return out;
    }

    /** Clear only the given cache ids (skips unknown / non-clearable). */
    public Map<String, Object> clearSelected(List<String> ids) {
        List<Map<String, Object>> results = new ArrayList<>();
        int totalCleared = 0;
        if (ids == null || ids.isEmpty()) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("success", false);
            out.put("message", "No cache ids provided");
            out.put("totalClearedEntries", 0);
            out.put("results", results);
            return out;
        }
        for (String id : ids) {
            if (id == null || id.isBlank()) {
                continue;
            }
            Map<String, Object> one = clearOne(id.trim());
            results.add(one);
            if (Boolean.TRUE.equals(one.get("success"))) {
                Object n = one.get("clearedEntries");
                if (n instanceof Number number) {
                    totalCleared += number.intValue();
                }
            }
        }
        boolean anyOk = results.stream().anyMatch(r -> Boolean.TRUE.equals(r.get("success")));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("success", anyOk);
        out.put("totalClearedEntries", totalCleared);
        out.put("clearedCount", (int) results.stream().filter(r -> Boolean.TRUE.equals(r.get("success"))).count());
        out.put("requestedCount", ids.size());
        out.put("results", results);
        out.put("caches", listAll().get("caches"));
        return out;
    }

    /**
     * Rebuild TV + EPG + radio + Archive.org catalogs, and clear live/replay stream URL caches
     * in the same operation so the whole media category is refreshed together.
     */
    public Map<String, Object> refreshMediaCatalog() {
        List<String> clearedLive = new ArrayList<>();
        int liveEntries = 0;
        liveEntries += franceTvLiveService.invalidateAll();
        clearedLive.add("france-tv-live");
        liveEntries += tf1LiveService.invalidateAll();
        clearedLive.add("tf1-live");
        liveEntries += m6GroupLiveService.invalidateAll();
        clearedLive.add("m6-live");
        liveEntries += rtsLiveService.invalidateAll();
        clearedLive.add("rts-live");
        liveEntries += canalGroupLiveService.invalidateAll();
        clearedLive.add("canal-live");
        liveEntries += arteReplayService.invalidateAll();
        clearedLive.add("arte-replay");

        boolean started = mediaCatalogCacheService.startFullRefresh();
        List<String> rebuilding = List.of(
                "media-catalog", "tv-catalog", "tv-epg", "radio-catalog", "archive-org", "archive-catalog");

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("success", started);
        out.put("started", started);
        out.put("message", started
                ? "Media catalog refresh started in parallel (" + rebuilding.size()
                + " catalogs + " + clearedLive.size() + " live stream caches = "
                + (rebuilding.size() + clearedLive.size()) + ")"
                : "Media catalog refresh already running");
        out.put("rebuildingCaches", rebuilding);
        out.put("clearedLiveCaches", clearedLive);
        out.put("clearedLiveEntries", liveEntries);
        out.put("cacheCount", rebuilding.size() + clearedLive.size());
        out.put("parallel", true);
        out.put("status", mediaCatalogCacheService.status());
        return out;
    }

    /**
     * Refresh one cache: rebuild/warm when possible, otherwise clear so the next
     * request reloads fresh data.
     */
    public Map<String, Object> refreshOne(String id) {
        if (id == null || id.isBlank()) {
            return Map.of("success", false, "message", "Missing cache id");
        }
        String cacheId = id.trim();
        if ("media-catalog".equals(cacheId)) {
            return refreshMediaCatalog();
        }

        CacheDef def = find(cacheId);
        if (def == null) {
            return Map.of("success", false, "message", "Unknown cache id: " + cacheId);
        }

        try {
            int before = def.counter.get().intValue();
            switch (cacheId) {
                case "tv-catalog" -> {
                    tvCatalogService.invalidateAll();
                    boolean started = tvCatalogService.scheduleReloadAllPlaylists();
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("success", true);
                    out.put("id", cacheId);
                    out.put("action", "refresh");
                    out.put("previousEntries", before);
                    out.put("started", started);
                    out.put("message", started
                            ? "TV catalog full reload started (all countries + worldwide list)"
                            : "TV catalog reload already running");
                    out.put("cache", statusOf(def));
                    return out;
                }
                case "tv-epg" -> {
                    tvEpgService.invalidateAll();
                    tvEpgService.warmFrequentCountries();
                }
                case "radio-catalog" -> radioCatalogService.reloadFrequent();
                case "archive-org" -> {
                    internetArchiveReplayService.invalidateAll();
                    internetArchiveReplayService.warmCatalog();
                }
                case "archive-catalog" -> {
                    boolean started = internetArchiveCatalogService.startCatalogRefresh();
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("success", started);
                    out.put("id", cacheId);
                    out.put("action", "refresh");
                    out.put("message", started
                            ? "Archive explorer catalogue refresh started (daily 05:00 job)"
                            : "Archive explorer catalogue refresh already running");
                    out.put("cache", statusOf(def));
                    return out;
                }
                case "image-compression" -> {
                    CachePersistenceService.CacheLoadResult loaded = cachePersistenceService.loadCache();
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("success", loaded.isSuccess());
                    out.put("id", cacheId);
                    out.put("action", "refresh");
                    out.put("entryCount", loaded.getEntryCount());
                    out.put("message", loaded.getMessage());
                    out.put("cache", statusOf(def));
                    return out;
                }
                case "ms-forecast" -> {
                    meteoSwissForecastService.clearCache();
                    // next request / status poll will trigger rebuild
                }
                default -> {
                    if (!def.clearable || def.clearer == null) {
                        return Map.of("success", false, "message", "Cache is not refreshable: " + cacheId);
                    }
                    def.clearer.get();
                }
            }
            log.info("Refreshed cache {} (before={} entries)", cacheId, before);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("success", true);
            out.put("id", cacheId);
            out.put("action", "refresh");
            out.put("previousEntries", before);
            out.put("cache", statusOf(def));
            return out;
        } catch (Exception e) {
            log.warn("Failed to refresh cache {}: {}", cacheId, e.toString());
            return Map.of("success", false, "message", e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }

    private CacheDef find(String id) {
        if (id == null) {
            return null;
        }
        for (CacheDef def : definitions()) {
            if (def.id.equals(id)) {
                return def;
            }
        }
        return null;
    }

    private Map<String, Object> statusOf(CacheDef def) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", def.id);
        row.put("category", def.category);
        row.put("nameKey", def.nameKey);
        row.put("descriptionKey", def.descriptionKey);
        row.put("clearable", def.clearable);
        row.put("refreshable", true);
        try {
            long records = def.counter.get();
            row.put("entryCount", records);
            row.put("recordCount", records);
            if (def.details != null) {
                Map<String, Object> details = def.details.get();
                row.put("details", details);
                if (details != null && details.get("recordUnit") != null) {
                    row.put("recordUnit", details.get("recordUnit"));
                }
            }
            if (!row.containsKey("recordUnit")) {
                row.put("recordUnit", "records");
            }
        } catch (Exception e) {
            row.put("entryCount", 0);
            row.put("recordCount", 0);
            row.put("recordUnit", "records");
            row.put("error", e.getMessage() != null ? e.getMessage() : e.toString());
        }
        return row;
    }

    private List<CacheDef> definitions() {
        List<CacheDef> list = new ArrayList<>();

        list.add(new CacheDef(
                "image-compression", "images",
                "SYSTEM.CACHE_REGISTRY.IMAGE_COMPRESSION",
                "SYSTEM.CACHE_REGISTRY.IMAGE_COMPRESSION_DESC",
                true, false,
                () -> {
                    Object n = imageCompressionService.getCacheStatistics().get("entryCount");
                    return n instanceof Number ? ((Number) n).longValue() : 0L;
                },
                () -> {
                    CachePersistenceService.CacheClearResult r = cachePersistenceService.clearCache();
                    return r.getMemoryEntries();
                },
                () -> {
                    Map<String, Object> d = new LinkedHashMap<>(imageCompressionService.getCacheStatistics());
                    d.put("recordUnit", "images");
                    return d;
                }));

        list.add(new CacheDef(
                "media-catalog", "media",
                "SYSTEM.CACHE_REGISTRY.MEDIA_CATALOG",
                "SYSTEM.CACHE_REGISTRY.MEDIA_CATALOG_DESC",
                false, true,
                () -> {
                    // Sum of child record volumes (channels + programmes + stations + IA items).
                    long total = tvCatalogService.cachedChannelCount();
                    Object epgProg = tvEpgService.cacheStats().get("epgCachedProgrammes");
                    if (epgProg instanceof Number n) {
                        total += n.longValue();
                    }
                    total += radioCatalogService.cachedStationCount();
                    Map<String, Object> ia = internetArchiveReplayService.cacheStats();
                    Object iaRec = ia.get("iaRecordCount");
                    if (iaRec instanceof Number n) {
                        total += n.longValue();
                    }
                    return total;
                },
                () -> 0,
                () -> {
                    Map<String, Object> status = new LinkedHashMap<>(mediaCatalogCacheService.status());
                    status.put("tvEntries", tvCatalogService.cacheEntryCount());
                    status.put("tvChannels", tvCatalogService.cachedChannelCount());
                    Map<String, Object> tvStats = tvCatalogService.cacheStats();
                    status.put("tvWorldwideChannels", tvStats.get("worldwideChannels"));
                    status.put("tvWorldwideChannelsRefreshedAt", tvStats.get("worldwideChannelsRefreshedAt"));
                    status.put("tvReloadBusy", tvStats.get("reloadBusy"));
                    Object epgObj = tvEpgService.cacheStats().get("epgCachedCountries");
                    status.put("epgEntries", epgObj instanceof Number n ? n.longValue() : 0L);
                    Object epgProg = tvEpgService.cacheStats().get("epgCachedProgrammes");
                    status.put("epgProgrammes", epgProg instanceof Number n ? n.longValue() : 0L);
                    status.put("radioEntries", radioCatalogService.cacheEntryCount());
                    status.put("radioStations", radioCatalogService.cachedStationCount());
                    Map<String, Object> ia = internetArchiveReplayService.cacheStats();
                    status.put("archiveEntries",
                            ((Number) ia.getOrDefault("iaPageCacheEntries", 0)).longValue()
                                    + ((Number) ia.getOrDefault("iaStreamCacheEntries", 0)).longValue());
                    status.put("archiveRecords", ((Number) ia.getOrDefault("iaRecordCount", 0)).longValue());
                    status.put("orchestrator", true);
                    status.put("recordUnit", "records");
                    return status;
                }));

        list.add(def("tv-catalog", "media",
                "SYSTEM.CACHE_REGISTRY.TV_CATALOG", "SYSTEM.CACHE_REGISTRY.TV_CATALOG_DESC",
                true, true,
                tvCatalogService::cachedChannelCount,
                () -> {
                    int n = tvCatalogService.cacheEntryCount();
                    tvCatalogService.invalidateAll();
                    return n;
                },
                () -> {
                    Map<String, Object> d = new LinkedHashMap<>(tvCatalogService.cacheStats());
                    d.put("recordUnit", "channels");
                    return d;
                }));

        list.add(def("tv-epg", "media",
                "SYSTEM.CACHE_REGISTRY.TV_EPG", "SYSTEM.CACHE_REGISTRY.TV_EPG_DESC",
                true, false,
                () -> {
                    Object n = tvEpgService.cacheStats().get("epgCachedProgrammes");
                    return n instanceof Number ? ((Number) n).longValue() : 0L;
                },
                () -> {
                    Object n = tvEpgService.cacheStats().get("epgCachedCountries");
                    int before = n instanceof Number ? ((Number) n).intValue() : 0;
                    tvEpgService.invalidateAll();
                    return before;
                },
                () -> {
                    Map<String, Object> d = new LinkedHashMap<>(tvEpgService.cacheStats());
                    d.put("recordUnit", "programmes");
                    return d;
                }));

        list.add(def("radio-catalog", "media",
                "SYSTEM.CACHE_REGISTRY.RADIO_CATALOG", "SYSTEM.CACHE_REGISTRY.RADIO_CATALOG_DESC",
                true, false,
                radioCatalogService::cachedStationCount,
                () -> {
                    int n = radioCatalogService.cacheEntryCount();
                    radioCatalogService.invalidateAll();
                    return n;
                },
                () -> {
                    Map<String, Object> d = new LinkedHashMap<>();
                    d.put("countries", radioCatalogService.cacheEntryCount());
                    d.put("stations", radioCatalogService.cachedStationCount());
                    d.put("recordUnit", "stations");
                    return d;
                }));

        list.add(def("archive-org", "media",
                "SYSTEM.CACHE_REGISTRY.ARCHIVE_ORG", "SYSTEM.CACHE_REGISTRY.ARCHIVE_ORG_DESC",
                true, false,
                () -> {
                    Map<String, Object> s = internetArchiveReplayService.cacheStats();
                    Object n = s.get("iaRecordCount");
                    return n instanceof Number ? ((Number) n).longValue() : 0L;
                },
                internetArchiveReplayService::invalidateAll,
                () -> {
                    Map<String, Object> d = new LinkedHashMap<>(internetArchiveReplayService.cacheStats());
                    d.put("recordUnit", "items");
                    return d;
                }));

        list.add(def("archive-catalog", "media",
                "SYSTEM.CACHE_REGISTRY.ARCHIVE_CATALOG", "SYSTEM.CACHE_REGISTRY.ARCHIVE_CATALOG_DESC",
                true, false,
                () -> (long) internetArchiveCatalogService.catalogEntryCount(),
                internetArchiveCatalogService::invalidateAll,
                () -> {
                    Map<String, Object> d = new LinkedHashMap<>(internetArchiveCatalogService.cacheStats());
                    d.put("recordUnit", "items");
                    return d;
                }));

        list.add(def("france-tv-live", "media",
                "SYSTEM.CACHE_REGISTRY.FRANCE_TV_LIVE", "SYSTEM.CACHE_REGISTRY.FRANCE_TV_LIVE_DESC",
                true, false,
                () -> (long) franceTvLiveService.cacheEntryCount(),
                franceTvLiveService::invalidateAll,
                unit("urls")));

        list.add(def("tf1-live", "media",
                "SYSTEM.CACHE_REGISTRY.TF1_LIVE", "SYSTEM.CACHE_REGISTRY.TF1_LIVE_DESC",
                true, false,
                () -> (long) tf1LiveService.cacheEntryCount(),
                tf1LiveService::invalidateAll,
                unit("urls")));

        list.add(def("m6-live", "media",
                "SYSTEM.CACHE_REGISTRY.M6_LIVE", "SYSTEM.CACHE_REGISTRY.M6_LIVE_DESC",
                true, false,
                () -> (long) m6GroupLiveService.cacheEntryCount(),
                m6GroupLiveService::invalidateAll,
                unit("urls")));

        list.add(def("rts-live", "media",
                "SYSTEM.CACHE_REGISTRY.RTS_LIVE", "SYSTEM.CACHE_REGISTRY.RTS_LIVE_DESC",
                true, false,
                () -> (long) rtsLiveService.cacheEntryCount(),
                rtsLiveService::invalidateAll,
                unit("urls")));

        list.add(def("canal-live", "media",
                "SYSTEM.CACHE_REGISTRY.CANAL_LIVE", "SYSTEM.CACHE_REGISTRY.CANAL_LIVE_DESC",
                true, false,
                () -> (long) canalGroupLiveService.cacheEntryCount(),
                canalGroupLiveService::invalidateAll,
                unit("urls")));

        list.add(def("arte-replay", "media",
                "SYSTEM.CACHE_REGISTRY.ARTE_REPLAY", "SYSTEM.CACHE_REGISTRY.ARTE_REPLAY_DESC",
                true, false,
                () -> (long) arteReplayService.cacheEntryCount(),
                arteReplayService::invalidateAll,
                unit("urls")));

        list.add(def("mf-temperature", "weather",
                "SYSTEM.CACHE_REGISTRY.MF_TEMPERATURE", "SYSTEM.CACHE_REGISTRY.MF_TEMPERATURE_DESC",
                true, false,
                () -> (long) meteoFranceObsService.cacheEntryCount() + openMeteoService.cacheEntryCount(),
                () -> meteoFranceObsService.clearTemperatureObservationCache()
                        + openMeteoService.clearTemperatureObservationCache(),
                unit("records")));

        list.add(def("mf-forecast-aromepi", "weather",
                "SYSTEM.CACHE_REGISTRY.MF_FORECAST_AROMEPI", "SYSTEM.CACHE_REGISTRY.MF_FORECAST_AROMEPI_DESC",
                true, false,
                () -> (long) meteoFranceAromepiService.cacheEntryCount(),
                () -> {
                    Object n = meteoFranceAromepiService.clearForecastCaches().get("totalEntries");
                    return n instanceof Number ? ((Number) n).intValue() : 0;
                },
                unit("tiles")));

        list.add(def("mf-forecast-arpege", "weather",
                "SYSTEM.CACHE_REGISTRY.MF_FORECAST_ARPEGE", "SYSTEM.CACHE_REGISTRY.MF_FORECAST_ARPEGE_DESC",
                true, false,
                () -> (long) meteoFranceArpegeService.cacheEntryCount(),
                () -> {
                    Object n = meteoFranceArpegeService.clearForecastCaches().get("totalEntries");
                    return n instanceof Number ? ((Number) n).intValue() : 0;
                },
                unit("tiles")));

        list.add(def("mf-clim", "weather",
                "SYSTEM.CACHE_REGISTRY.MF_CLIM", "SYSTEM.CACHE_REGISTRY.MF_CLIM_DESC",
                true, false,
                () -> (long) meteoFranceClimService.cacheEntryCount(),
                meteoFranceClimService::clearClimCache,
                unit("records")));

        list.add(def("ms-obs", "weather",
                "SYSTEM.CACHE_REGISTRY.MS_OBS", "SYSTEM.CACHE_REGISTRY.MS_OBS_DESC",
                true, false,
                () -> (long) meteoSwissObsService.cacheEntryCount(),
                meteoSwissObsService::clearAllCaches,
                unit("records")));

        list.add(def("ms-forecast", "weather",
                "SYSTEM.CACHE_REGISTRY.MS_FORECAST", "SYSTEM.CACHE_REGISTRY.MS_FORECAST_DESC",
                true, false,
                () -> (long) meteoSwissForecastService.cacheEntryCount(),
                meteoSwissForecastService::clearCache,
                () -> {
                    Map<String, Object> d = new LinkedHashMap<>(meteoSwissForecastService.getStatus());
                    d.put("recordUnit", "frames");
                    return d;
                }));

        list.add(def("mf-radar", "weather",
                "SYSTEM.CACHE_REGISTRY.MF_RADAR", "SYSTEM.CACHE_REGISTRY.MF_RADAR_DESC",
                true, false,
                () -> (long) meteoFranceRadarService.cacheEntryCount(),
                meteoFranceRadarService::clearCache,
                unit("records")));

        list.add(def("news-api", "news",
                "SYSTEM.CACHE_REGISTRY.NEWS_API", "SYSTEM.CACHE_REGISTRY.NEWS_API_DESC",
                true, false,
                () -> {
                    Object n = newsApiService.getStatus().get("cacheEntries");
                    return n instanceof Number ? ((Number) n).longValue() : 0L;
                },
                () -> {
                    Object n = newsApiService.clearCache().get("cleared");
                    return n instanceof Number ? ((Number) n).intValue() : 0;
                },
                unit("responses")));

        list.add(def("newsdata", "news",
                "SYSTEM.CACHE_REGISTRY.NEWSDATA", "SYSTEM.CACHE_REGISTRY.NEWSDATA_DESC",
                true, false,
                () -> {
                    Object n = newsDataService.getStatus().get("cacheEntries");
                    return n instanceof Number ? ((Number) n).longValue() : 0L;
                },
                () -> {
                    Object n = newsDataService.clearCache().get("cleared");
                    return n instanceof Number ? ((Number) n).intValue() : 0;
                },
                unit("responses")));

        list.add(def("stock", "finance",
                "SYSTEM.CACHE_REGISTRY.STOCK", "SYSTEM.CACHE_REGISTRY.STOCK_DESC",
                true, false,
                () -> (long) twelveDataProxyService.cacheEntryCount(),
                () -> {
                    int n = twelveDataProxyService.cacheEntryCount();
                    twelveDataProxyService.clearCache();
                    return n;
                },
                unit("quotes")));

        list.add(def("fx-frankfurter", "finance",
                "SYSTEM.CACHE_REGISTRY.FX", "SYSTEM.CACHE_REGISTRY.FX_DESC",
                true, false,
                () -> (long) frankfurterProxyService.cacheEntryCount(),
                () -> {
                    int n = frankfurterProxyService.cacheEntryCount();
                    frankfurterProxyService.clearCache();
                    return n;
                },
                unit("rates")));

        list.add(def("crypto-coingecko", "finance",
                "SYSTEM.CACHE_REGISTRY.CRYPTO", "SYSTEM.CACHE_REGISTRY.CRYPTO_DESC",
                true, false,
                () -> (long) coinGeckoProxyService.cacheEntryCount(),
                coinGeckoProxyService::clearCache,
                unit("quotes")));

        list.add(def("electricity", "other",
                "SYSTEM.CACHE_REGISTRY.ELECTRICITY", "SYSTEM.CACHE_REGISTRY.ELECTRICITY_DESC",
                true, false,
                () -> (long) electricityProxyService.cacheEntryCount(),
                electricityProxyService::clearCache,
                unit("records")));

        list.add(def("chemistry", "other",
                "SYSTEM.CACHE_REGISTRY.CHEMISTRY", "SYSTEM.CACHE_REGISTRY.CHEMISTRY_DESC",
                true, false,
                () -> (long) chemistryProxyService.cacheEntryCount(),
                chemistryProxyService::clearCache,
                unit("elements")));

        list.add(def("geocode", "geo",
                "SYSTEM.CACHE_REGISTRY.GEOCODE", "SYSTEM.CACHE_REGISTRY.GEOCODE_DESC",
                true, false,
                () -> (long) geocodeService.cacheEntryCount(),
                geocodeService::clearCache,
                unit("records")));

        list.add(def("ip-geolocation", "geo",
                "SYSTEM.CACHE_REGISTRY.IP_GEO", "SYSTEM.CACHE_REGISTRY.IP_GEO_DESC",
                true, false,
                () -> (long) ipGeolocationService.cacheEntryCount(),
                () -> {
                    int n = ipGeolocationService.cacheEntryCount();
                    ipGeolocationService.clearCache();
                    return n;
                },
                unit("records")));

        list.add(def("opensky", "geo",
                "SYSTEM.CACHE_REGISTRY.OPENSKY", "SYSTEM.CACHE_REGISTRY.OPENSKY_DESC",
                true, false,
                () -> (long) openSkyService.cacheEntryCount(),
                openSkyService::clearCache,
                unit("records")));

        list.add(def("globe-iss", "geo",
                "SYSTEM.CACHE_REGISTRY.GLOBE_ISS", "SYSTEM.CACHE_REGISTRY.GLOBE_ISS_DESC",
                true, false,
                () -> (long) globeProxyService.cacheEntryCount(),
                globeProxyService::clearIssNowCache,
                unit("records")));

        list.add(def("agenda-social", "other",
                "SYSTEM.CACHE_REGISTRY.AGENDA_SOCIAL", "SYSTEM.CACHE_REGISTRY.AGENDA_SOCIAL_DESC",
                true, false,
                agendaSocialGraphCache::cacheEntryCount,
                () -> {
                    long n = agendaSocialGraphCache.cacheEntryCount();
                    agendaSocialGraphCache.clearCache();
                    return (int) n;
                },
                unit("edges")));

        return list;
    }

    private static Supplier<Map<String, Object>> unit(String recordUnit) {
        return () -> {
            Map<String, Object> d = new LinkedHashMap<>();
            d.put("recordUnit", recordUnit);
            return d;
        };
    }

    private static CacheDef def(
            String id, String category, String nameKey, String descriptionKey,
            boolean clearable, boolean refreshable,
            Supplier<Long> counter, Supplier<Integer> clearer) {
        return new CacheDef(id, category, nameKey, descriptionKey, clearable, refreshable, counter, clearer, null);
    }

    private static CacheDef def(
            String id, String category, String nameKey, String descriptionKey,
            boolean clearable, boolean refreshable,
            Supplier<Long> counter, Supplier<Integer> clearer, Supplier<Map<String, Object>> details) {
        return new CacheDef(id, category, nameKey, descriptionKey, clearable, refreshable, counter, clearer, details);
    }

    private static final class CacheDef {
        final String id;
        final String category;
        final String nameKey;
        final String descriptionKey;
        final boolean clearable;
        final boolean refreshable;
        final Supplier<Long> counter;
        final Supplier<Integer> clearer;
        final Supplier<Map<String, Object>> details;

        CacheDef(
                String id, String category, String nameKey, String descriptionKey,
                boolean clearable, boolean refreshable,
                Supplier<Long> counter, Supplier<Integer> clearer,
                Supplier<Map<String, Object>> details) {
            this.id = id;
            this.category = category;
            this.nameKey = nameKey;
            this.descriptionKey = descriptionKey;
            this.clearable = clearable;
            this.refreshable = refreshable;
            this.counter = counter;
            this.clearer = clearer;
            this.details = details;
        }
    }
}
