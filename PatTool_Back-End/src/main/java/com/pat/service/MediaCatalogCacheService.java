package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Coordinates in-memory caches for TV playlists, TV EPG, and radio catalogs:
 * full refresh ~90s after boot, nightly at 04:00, EPG+radio all countries at 07/17/20, and manual refresh.
 */
@Service
public class MediaCatalogCacheService {

    private static final Logger log = LoggerFactory.getLogger(MediaCatalogCacheService.class);

    private final TvCatalogService tvCatalogService;
    private final TvEpgService tvEpgService;
    private final RadioCatalogService radioCatalogService;

    private final AtomicBoolean refreshBusy = new AtomicBoolean(false);
    private final ExecutorService refreshExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "media-catalog-refresh");
        t.setDaemon(true);
        return t;
    });
    private final ScheduledExecutorService bootScheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "media-catalog-boot-refresh");
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
            RadioCatalogService radioCatalogService) {
        this.tvCatalogService = tvCatalogService;
        this.tvEpgService = tvEpgService;
        this.radioCatalogService = radioCatalogService;
    }

    /** Full catalog refresh ~90s after boot (keeps startup responsive). */
    @EventListener(ApplicationReadyEvent.class)
    public void onApplicationReady() {
        bootScheduler.schedule(() -> {
            log.info("Media catalog boot full refresh starting");
            if (!startFullRefresh()) {
                log.info("Media catalog boot full refresh skipped (already busy)");
            }
        }, 90, TimeUnit.SECONDS);
    }

    /** Full catalog refresh every night at 04:00 (server time). */
    @Scheduled(cron = "${app.media.catalog.nightly-warm-cron:0 0 4 * * *}")
    public void nightlyFullRefresh() {
        log.info("Media catalog nightly full refresh starting");
        if (!startFullRefresh()) {
            log.info("Media catalog nightly full refresh skipped (already busy)");
        }
    }

    /** EPG + radio refresh for every country at 07:00, 17:00 and 20:00. */
    @Scheduled(cron = "${app.media.catalog.epg-refresh-cron:0 0 7,17,20 * * *}")
    public void scheduledEpgAndRadioFullRefresh() {
        if (refreshBusy.get()) {
            log.info("Media catalog EPG/radio refresh skipped (full refresh already busy)");
            return;
        }
        log.info("Media catalog EPG + radio full refresh starting (all countries)");
        refreshExecutor.execute(() -> {
            try {
                log.info("Media catalog scheduled refresh: TV EPG (all countries)");
                tvEpgService.reloadCountries(tvCatalogService.allCountryCodes());
                log.info("Media catalog scheduled refresh: radio (all countries)");
                radioCatalogService.reloadAllCountries();
                log.info("Media catalog EPG + radio full refresh finished");
            } catch (Exception e) {
                log.warn("Media catalog EPG/radio full refresh failed: {}", e.toString());
            }
        });
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
        return out;
    }

    /**
     * Start a full background refresh. Returns {@code false} if one is already running.
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
                lastPhase = "tv-channels";
                log.info("Media catalog full refresh: TV channels");
                tvCatalogService.reloadAllPlaylists();

                lastPhase = "tv-epg";
                log.info("Media catalog full refresh: TV EPG (all countries)");
                tvEpgService.reloadCountries(tvCatalogService.allCountryCodes());

                lastPhase = "radio";
                log.info("Media catalog full refresh: radio (all countries)");
                radioCatalogService.reloadAllCountries();

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
