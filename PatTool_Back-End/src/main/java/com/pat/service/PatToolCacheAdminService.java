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
    private final FranceTvLiveService franceTvLiveService;
    private final Tf1LiveService tf1LiveService;
    private final M6GroupLiveService m6GroupLiveService;
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
            FranceTvLiveService franceTvLiveService,
            Tf1LiveService tf1LiveService,
            M6GroupLiveService m6GroupLiveService,
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
        this.franceTvLiveService = franceTvLiveService;
        this.tf1LiveService = tf1LiveService;
        this.m6GroupLiveService = m6GroupLiveService;
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
        liveEntries += canalGroupLiveService.invalidateAll();
        clearedLive.add("canal-live");
        liveEntries += arteReplayService.invalidateAll();
        clearedLive.add("arte-replay");

        boolean started = mediaCatalogCacheService.startFullRefresh();
        List<String> rebuilding = List.of(
                "media-catalog", "tv-catalog", "tv-epg", "radio-catalog", "archive-org");

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("success", started);
        out.put("started", started);
        out.put("message", started
                ? "Media catalog refresh started (" + rebuilding.size()
                + " catalogs + " + clearedLive.size() + " live stream caches)"
                : "Media catalog refresh already running");
        out.put("rebuildingCaches", rebuilding);
        out.put("clearedLiveCaches", clearedLive);
        out.put("clearedLiveEntries", liveEntries);
        out.put("cacheCount", rebuilding.size() + clearedLive.size());
        out.put("status", mediaCatalogCacheService.status());
        return out;
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
        row.put("refreshable", def.refreshable);
        try {
            row.put("entryCount", def.counter.get());
            if (def.details != null) {
                row.put("details", def.details.get());
            }
        } catch (Exception e) {
            row.put("entryCount", 0);
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
                () -> imageCompressionService.getCacheStatistics()));

        list.add(new CacheDef(
                "media-catalog", "media",
                "SYSTEM.CACHE_REGISTRY.MEDIA_CATALOG",
                "SYSTEM.CACHE_REGISTRY.MEDIA_CATALOG_DESC",
                false, true,
                () -> {
                    long epg = 0;
                    Object epgObj = tvEpgService.cacheStats().get("epgCachedCountries");
                    if (epgObj instanceof Number n) {
                        epg = n.longValue();
                    }
                    Map<String, Object> ia = internetArchiveReplayService.cacheStats();
                    long iaPages = ((Number) ia.getOrDefault("iaPageCacheEntries", 0)).longValue();
                    long iaStreams = ((Number) ia.getOrDefault("iaStreamCacheEntries", 0)).longValue();
                    return tvCatalogService.cacheEntryCount()
                            + epg
                            + radioCatalogService.cacheEntryCount()
                            + iaPages
                            + iaStreams;
                },
                () -> 0,
                mediaCatalogCacheService::status));

        list.add(def("tv-catalog", "media",
                "SYSTEM.CACHE_REGISTRY.TV_CATALOG", "SYSTEM.CACHE_REGISTRY.TV_CATALOG_DESC",
                true, false,
                () -> (long) tvCatalogService.cacheEntryCount(),
                () -> {
                    int n = tvCatalogService.cacheEntryCount();
                    tvCatalogService.invalidateAll();
                    return n;
                }));

        list.add(def("tv-epg", "media",
                "SYSTEM.CACHE_REGISTRY.TV_EPG", "SYSTEM.CACHE_REGISTRY.TV_EPG_DESC",
                true, false,
                () -> {
                    Object n = tvEpgService.cacheStats().get("epgCachedCountries");
                    return n instanceof Number ? ((Number) n).longValue() : 0L;
                },
                () -> {
                    Object n = tvEpgService.cacheStats().get("epgCachedCountries");
                    int before = n instanceof Number ? ((Number) n).intValue() : 0;
                    tvEpgService.invalidateAll();
                    return before;
                },
                tvEpgService::cacheStats));

        list.add(def("radio-catalog", "media",
                "SYSTEM.CACHE_REGISTRY.RADIO_CATALOG", "SYSTEM.CACHE_REGISTRY.RADIO_CATALOG_DESC",
                true, false,
                () -> (long) radioCatalogService.cacheEntryCount(),
                () -> {
                    int n = radioCatalogService.cacheEntryCount();
                    radioCatalogService.invalidateAll();
                    return n;
                }));

        list.add(def("archive-org", "media",
                "SYSTEM.CACHE_REGISTRY.ARCHIVE_ORG", "SYSTEM.CACHE_REGISTRY.ARCHIVE_ORG_DESC",
                true, false,
                () -> {
                    Map<String, Object> s = internetArchiveReplayService.cacheStats();
                    return ((Number) s.getOrDefault("iaPageCacheEntries", 0)).longValue()
                            + ((Number) s.getOrDefault("iaStreamCacheEntries", 0)).longValue();
                },
                internetArchiveReplayService::invalidateAll,
                internetArchiveReplayService::cacheStats));

        list.add(def("france-tv-live", "media",
                "SYSTEM.CACHE_REGISTRY.FRANCE_TV_LIVE", "SYSTEM.CACHE_REGISTRY.FRANCE_TV_LIVE_DESC",
                true, false,
                () -> (long) franceTvLiveService.cacheEntryCount(),
                franceTvLiveService::invalidateAll));

        list.add(def("tf1-live", "media",
                "SYSTEM.CACHE_REGISTRY.TF1_LIVE", "SYSTEM.CACHE_REGISTRY.TF1_LIVE_DESC",
                true, false,
                () -> (long) tf1LiveService.cacheEntryCount(),
                tf1LiveService::invalidateAll));

        list.add(def("m6-live", "media",
                "SYSTEM.CACHE_REGISTRY.M6_LIVE", "SYSTEM.CACHE_REGISTRY.M6_LIVE_DESC",
                true, false,
                () -> (long) m6GroupLiveService.cacheEntryCount(),
                m6GroupLiveService::invalidateAll));

        list.add(def("canal-live", "media",
                "SYSTEM.CACHE_REGISTRY.CANAL_LIVE", "SYSTEM.CACHE_REGISTRY.CANAL_LIVE_DESC",
                true, false,
                () -> (long) canalGroupLiveService.cacheEntryCount(),
                canalGroupLiveService::invalidateAll));

        list.add(def("arte-replay", "media",
                "SYSTEM.CACHE_REGISTRY.ARTE_REPLAY", "SYSTEM.CACHE_REGISTRY.ARTE_REPLAY_DESC",
                true, false,
                () -> (long) arteReplayService.cacheEntryCount(),
                arteReplayService::invalidateAll));

        list.add(def("mf-temperature", "weather",
                "SYSTEM.CACHE_REGISTRY.MF_TEMPERATURE", "SYSTEM.CACHE_REGISTRY.MF_TEMPERATURE_DESC",
                true, false,
                () -> (long) meteoFranceObsService.cacheEntryCount() + openMeteoService.cacheEntryCount(),
                () -> meteoFranceObsService.clearTemperatureObservationCache()
                        + openMeteoService.clearTemperatureObservationCache()));

        list.add(def("mf-forecast-aromepi", "weather",
                "SYSTEM.CACHE_REGISTRY.MF_FORECAST_AROMEPI", "SYSTEM.CACHE_REGISTRY.MF_FORECAST_AROMEPI_DESC",
                true, false,
                () -> (long) meteoFranceAromepiService.cacheEntryCount(),
                () -> {
                    Object n = meteoFranceAromepiService.clearForecastCaches().get("totalEntries");
                    return n instanceof Number ? ((Number) n).intValue() : 0;
                }));

        list.add(def("mf-forecast-arpege", "weather",
                "SYSTEM.CACHE_REGISTRY.MF_FORECAST_ARPEGE", "SYSTEM.CACHE_REGISTRY.MF_FORECAST_ARPEGE_DESC",
                true, false,
                () -> (long) meteoFranceArpegeService.cacheEntryCount(),
                () -> {
                    Object n = meteoFranceArpegeService.clearForecastCaches().get("totalEntries");
                    return n instanceof Number ? ((Number) n).intValue() : 0;
                }));

        list.add(def("mf-clim", "weather",
                "SYSTEM.CACHE_REGISTRY.MF_CLIM", "SYSTEM.CACHE_REGISTRY.MF_CLIM_DESC",
                true, false,
                () -> (long) meteoFranceClimService.cacheEntryCount(),
                meteoFranceClimService::clearClimCache));

        list.add(def("ms-obs", "weather",
                "SYSTEM.CACHE_REGISTRY.MS_OBS", "SYSTEM.CACHE_REGISTRY.MS_OBS_DESC",
                true, false,
                () -> (long) meteoSwissObsService.cacheEntryCount(),
                meteoSwissObsService::clearAllCaches));

        list.add(def("ms-forecast", "weather",
                "SYSTEM.CACHE_REGISTRY.MS_FORECAST", "SYSTEM.CACHE_REGISTRY.MS_FORECAST_DESC",
                true, false,
                () -> (long) meteoSwissForecastService.cacheEntryCount(),
                meteoSwissForecastService::clearCache,
                meteoSwissForecastService::getStatus));

        list.add(def("mf-radar", "weather",
                "SYSTEM.CACHE_REGISTRY.MF_RADAR", "SYSTEM.CACHE_REGISTRY.MF_RADAR_DESC",
                true, false,
                () -> (long) meteoFranceRadarService.cacheEntryCount(),
                meteoFranceRadarService::clearCache));

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
                }));

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
                }));

        list.add(def("stock", "finance",
                "SYSTEM.CACHE_REGISTRY.STOCK", "SYSTEM.CACHE_REGISTRY.STOCK_DESC",
                true, false,
                () -> (long) twelveDataProxyService.cacheEntryCount(),
                () -> {
                    int n = twelveDataProxyService.cacheEntryCount();
                    twelveDataProxyService.clearCache();
                    return n;
                }));

        list.add(def("fx-frankfurter", "finance",
                "SYSTEM.CACHE_REGISTRY.FX", "SYSTEM.CACHE_REGISTRY.FX_DESC",
                true, false,
                () -> (long) frankfurterProxyService.cacheEntryCount(),
                () -> {
                    int n = frankfurterProxyService.cacheEntryCount();
                    frankfurterProxyService.clearCache();
                    return n;
                }));

        list.add(def("crypto-coingecko", "finance",
                "SYSTEM.CACHE_REGISTRY.CRYPTO", "SYSTEM.CACHE_REGISTRY.CRYPTO_DESC",
                true, false,
                () -> (long) coinGeckoProxyService.cacheEntryCount(),
                coinGeckoProxyService::clearCache));

        list.add(def("electricity", "other",
                "SYSTEM.CACHE_REGISTRY.ELECTRICITY", "SYSTEM.CACHE_REGISTRY.ELECTRICITY_DESC",
                true, false,
                () -> (long) electricityProxyService.cacheEntryCount(),
                electricityProxyService::clearCache));

        list.add(def("chemistry", "other",
                "SYSTEM.CACHE_REGISTRY.CHEMISTRY", "SYSTEM.CACHE_REGISTRY.CHEMISTRY_DESC",
                true, false,
                () -> (long) chemistryProxyService.cacheEntryCount(),
                chemistryProxyService::clearCache));

        list.add(def("geocode", "geo",
                "SYSTEM.CACHE_REGISTRY.GEOCODE", "SYSTEM.CACHE_REGISTRY.GEOCODE_DESC",
                true, false,
                () -> (long) geocodeService.cacheEntryCount(),
                geocodeService::clearCache));

        list.add(def("ip-geolocation", "geo",
                "SYSTEM.CACHE_REGISTRY.IP_GEO", "SYSTEM.CACHE_REGISTRY.IP_GEO_DESC",
                true, false,
                () -> (long) ipGeolocationService.cacheEntryCount(),
                () -> {
                    int n = ipGeolocationService.cacheEntryCount();
                    ipGeolocationService.clearCache();
                    return n;
                }));

        list.add(def("opensky", "geo",
                "SYSTEM.CACHE_REGISTRY.OPENSKY", "SYSTEM.CACHE_REGISTRY.OPENSKY_DESC",
                true, false,
                () -> (long) openSkyService.cacheEntryCount(),
                openSkyService::clearCache));

        list.add(def("globe-iss", "geo",
                "SYSTEM.CACHE_REGISTRY.GLOBE_ISS", "SYSTEM.CACHE_REGISTRY.GLOBE_ISS_DESC",
                true, false,
                () -> (long) globeProxyService.cacheEntryCount(),
                globeProxyService::clearIssNowCache));

        list.add(def("agenda-social", "other",
                "SYSTEM.CACHE_REGISTRY.AGENDA_SOCIAL", "SYSTEM.CACHE_REGISTRY.AGENDA_SOCIAL_DESC",
                true, false,
                agendaSocialGraphCache::cacheEntryCount,
                () -> {
                    long n = agendaSocialGraphCache.cacheEntryCount();
                    agendaSocialGraphCache.clearCache();
                    return (int) n;
                }));

        return list;
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
