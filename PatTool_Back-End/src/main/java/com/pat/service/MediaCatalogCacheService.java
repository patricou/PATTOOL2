package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Single coordinator for in-memory media catalogs (TV playlists, TV EPG, radio, Archive.org).
 * <p>
 * All of them are refreshed together:
 * <ul>
 *   <li>every day at 07:00, 17:00 and 20:00 (server time)</li>
 *   <li>when the user clicks « Rafraîchir les caches »</li>
 * </ul>
 * No boot warm-up and no separate nightly job.
 */
@Service
public class MediaCatalogCacheService {

    private static final Logger log = LoggerFactory.getLogger(MediaCatalogCacheService.class);

    private final TvCatalogService tvCatalogService;
    private final TvEpgService tvEpgService;
    private final RadioCatalogService radioCatalogService;
    private final InternetArchiveReplayService internetArchiveReplayService;

    private final AtomicBoolean refreshBusy = new AtomicBoolean(false);
    private final ExecutorService refreshExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "media-catalog-refresh");
        t.setDaemon(true);
        return t;
    });

    private volatile Instant lastStartedAt;
    private volatile Instant lastCompletedAt;
    private volatile Long lastDurationMs;
    private volatile String lastError;
    private volatile String lastPhase;

    public MediaCatalogCacheService(
            TvCatalogService tvCatalogService,
            TvEpgService tvEpgService,
            RadioCatalogService radioCatalogService,
            InternetArchiveReplayService internetArchiveReplayService) {
        this.tvCatalogService = tvCatalogService;
        this.tvEpgService = tvEpgService;
        this.radioCatalogService = radioCatalogService;
        this.internetArchiveReplayService = internetArchiveReplayService;
    }

    /** Full refresh of every media catalog at 07:00, 17:00 and 20:00. */
    @Scheduled(cron = "${app.media.catalog.refresh-cron:0 0 7,17,20 * * *}")
    public void scheduledFullRefresh() {
        log.info("Media catalog scheduled full refresh starting (07/17/20)");
        if (!startFullRefresh()) {
            log.info("Media catalog scheduled full refresh skipped (already busy)");
        }
    }

    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("busy", refreshBusy.get());
        out.put("lastStartedAt", lastStartedAt != null ? lastStartedAt.toString() : null);
        out.put("lastCompletedAt", lastCompletedAt != null ? lastCompletedAt.toString() : null);
        out.put("lastDurationMs", lastDurationMs);
        out.put("lastError", lastError);
        out.put("lastPhase", lastPhase);
        out.putAll(tvEpgService.cacheStats());
        out.putAll(internetArchiveReplayService.cacheStats());
        return out;
    }

    /**
     * Start a full background refresh of TV + EPG + radio + Archive.org
     * running the heavy catalog jobs <strong>in parallel</strong>.
     * Returns {@code false} if one is already running.
     */
    public boolean startFullRefresh() {
        if (!refreshBusy.compareAndSet(false, true)) {
            return false;
        }
        lastStartedAt = Instant.now();
        lastError = null;
        lastPhase = "starting";
        refreshExecutor.execute(() -> {
            long t0 = System.currentTimeMillis();
            try {
                lastPhase = "parallel-catalogs";
                log.info("Media catalog full refresh: TV + EPG + radio + Archive.org in parallel");

                java.util.concurrent.CompletableFuture<Void> tv =
                        java.util.concurrent.CompletableFuture.runAsync(() -> {
                            log.info("Media catalog parallel: TV channels");
                            tvCatalogService.reloadAllPlaylists();
                        });
                java.util.concurrent.CompletableFuture<Void> epg =
                        java.util.concurrent.CompletableFuture.runAsync(() -> {
                            log.info("Media catalog parallel: TV EPG (all countries)");
                            tvEpgService.reloadCountries(tvCatalogService.allCountryCodes());
                        });
                java.util.concurrent.CompletableFuture<Void> radio =
                        java.util.concurrent.CompletableFuture.runAsync(() -> {
                            log.info("Media catalog parallel: radio (all countries)");
                            radioCatalogService.reloadAllCountries();
                        });
                java.util.concurrent.CompletableFuture<Void> archive =
                        java.util.concurrent.CompletableFuture.runAsync(() -> {
                            log.info("Media catalog parallel: Archive.org movie listings");
                            internetArchiveReplayService.warmCatalog();
                        });

                java.util.concurrent.CompletableFuture.allOf(tv, epg, radio, archive).join();

                lastPhase = "done";
                lastError = null;
            } catch (Exception e) {
                lastError = e.getMessage() != null ? e.getMessage() : e.toString();
                lastPhase = "error";
                log.warn("Media catalog full refresh failed: {}", e.toString());
            } finally {
                lastDurationMs = System.currentTimeMillis() - t0;
                lastCompletedAt = Instant.now();
                refreshBusy.set(false);
                log.info("Media catalog full refresh finished in {} ms (phase={})", lastDurationMs, lastPhase);
            }
        });
        return true;
    }
}
