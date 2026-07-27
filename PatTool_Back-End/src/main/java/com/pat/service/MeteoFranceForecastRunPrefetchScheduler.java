package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/**
 * Detects when Météo-France exposes a new ARPEGE / AROME-PI model run (via GetCapabilities)
 * and immediately warms forecast caches (capabilities, Open-Meteo point series, sample WMS tiles)
 * so the UI can serve the new run without waiting for the first interactive request.
 */
@Service
public class MeteoFranceForecastRunPrefetchScheduler {

    private static final Logger log = LoggerFactory.getLogger(MeteoFranceForecastRunPrefetchScheduler.class);

    private final MeteoFranceArpegeService arpegeService;
    private final MeteoFranceAromepiService aromepiService;
    private final boolean enabled;
    private final double warmLat;
    private final double warmLon;

    public MeteoFranceForecastRunPrefetchScheduler(
            MeteoFranceArpegeService arpegeService,
            MeteoFranceAromepiService aromepiService,
            @Value("${meteofrance.forecast.run-prefetch.enabled:true}") boolean enabled,
            @Value("${meteofrance.forecast.run-prefetch.lat:48.8566}") double warmLat,
            @Value("${meteofrance.forecast.run-prefetch.lon:2.3522}") double warmLon) {
        this.arpegeService = arpegeService;
        this.aromepiService = aromepiService;
        this.enabled = enabled;
        this.warmLat = warmLat;
        this.warmLon = warmLon;
        if (enabled) {
            log.info("Météo-France forecast run prefetch enabled (warm point {}, {})",
                    warmLat, warmLon);
        } else {
            log.info("Météo-France forecast run prefetch disabled "
                    + "(meteofrance.forecast.run-prefetch.enabled=false)");
        }
    }

    /**
     * Poll often enough to catch ARPEGE publication (~4h20 after 00/06/12/18 UTC)
     * and AROME-PI cycle updates without hammering MF (one GetCapabilities each).
     */
    @Scheduled(cron = "${meteofrance.forecast.run-prefetch.cron:0 */5 * * * *}")
    public void pollForNewRuns() {
        if (!enabled) {
            return;
        }
        try {
            boolean arpege = arpegeService.pollAndPrefetchIfNewRun(warmLat, warmLon);
            if (arpege) {
                log.info("ARPEGE forecast caches refreshed after new model exposure");
            }
        } catch (Exception e) {
            log.warn("ARPEGE run-prefetch tick failed: {}", e.getMessage());
        }
        try {
            boolean aromepi = aromepiService.pollAndPrefetchIfNewRun(warmLat, warmLon);
            if (aromepi) {
                log.info("AROME-PI forecast caches refreshed after new model exposure");
            }
        } catch (Exception e) {
            log.warn("AROME-PI run-prefetch tick failed: {}", e.getMessage());
        }
    }
}
