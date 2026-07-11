package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Optional;

/**
 * Server-side ISS position sampling for the historical MongoDB trace.
 * The {@link #PARAM_BACKGROUND_ENABLED} flag is the master recording toggle (globe client POST and scheduler).
 */
@Service
public class IssTraceBackgroundScheduler {

    private static final Logger log = LoggerFactory.getLogger(IssTraceBackgroundScheduler.class);

    /** MongoDB {@code appParameters} key (survives restarts). */
    public static final String PARAM_BACKGROUND_ENABLED = "globe.iss.trace.background.enabled";

    private final GlobeProxyService globeProxyService;
    private final IssTraceService issTraceService;
    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;

    @Value("${globe.iss.trace.background.enabled-default:false}")
    private boolean enabledDefault;

    @Value("${globe.iss.trace.background.interval.seconds:900}")
    private int backgroundIntervalSeconds;

    private volatile boolean backgroundEnabled;

    public IssTraceBackgroundScheduler(
            GlobeProxyService globeProxyService,
            IssTraceService issTraceService,
            AppParameterService appParameterService,
            ObjectMapper objectMapper) {
        this.globeProxyService = globeProxyService;
        this.issTraceService = issTraceService;
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
    }

    @PostConstruct
    public void init() {
        backgroundEnabled = appParameterService.getBooleanSafe(PARAM_BACKGROUND_ENABLED, enabledDefault);
        log.info(
                "ISS trace background scheduler: enabled={}, intervalSec={}",
                backgroundEnabled,
                getBackgroundIntervalSeconds());
    }

    public boolean isBackgroundEnabled() {
        return backgroundEnabled;
    }

    public int getBackgroundIntervalSeconds() {
        return Math.max(60, backgroundIntervalSeconds);
    }

    public int getBackgroundIntervalMinutes() {
        return getBackgroundIntervalSeconds() / 60;
    }

    /**
     * Persists the flag in MongoDB and optionally records one sample immediately when turning on.
     */
    public void setBackgroundEnabled(boolean enabled) {
        backgroundEnabled = enabled;
        appParameterService.setBoolean(
                PARAM_BACKGROUND_ENABLED,
                enabled,
                "Record ISS ground-track samples to MongoDB (globe client while open and server scheduler every interval).");
        log.info("ISS trace recording {}", enabled ? "enabled" : "disabled");
        if (enabled) {
            sampleIssPositionNow();
        }
    }

    /** Every 15 minutes by default ({@code globe.iss.trace.background.interval.seconds}). */
    @Scheduled(fixedRateString = "${globe.iss.trace.background.fixed-rate-ms:900000}")
    public void scheduledBackgroundSample() {
        if (!backgroundEnabled) {
            return;
        }
        sampleIssPositionNow();
    }

    /** Fetches ISS position from the proxied feed and stores one point if the interval elapsed. */
    public boolean sampleIssPositionNow() {
        if (!backgroundEnabled) {
            return false;
        }
        try {
            Optional<double[]> latLon = fetchCurrentIssLatLon();
            if (latLon.isEmpty()) {
                log.debug("ISS background sample skipped: no coordinates from upstream");
                return false;
            }
            double lat = latLon.get()[0];
            double lon = latLon.get()[1];
            boolean stored = issTraceService.recordPoint(
                    lat, lon, Instant.now(), getBackgroundIntervalSeconds());
            if (stored) {
                log.debug("ISS background sample stored: {}, {}", lat, lon);
            }
            return stored;
        } catch (Exception e) {
            log.warn("ISS background sample failed: {}", e.getMessage());
            return false;
        }
    }

    private Optional<double[]> fetchCurrentIssLatLon() throws Exception {
        byte[] payload = globeProxyService.fetchOpenNotifyIssNow();
        JsonNode root = objectMapper.readTree(payload);
        JsonNode pos = root.get("iss_position");
        if (pos == null || !pos.has("latitude") || !pos.has("longitude")) {
            return Optional.empty();
        }
        double lat = Double.parseDouble(pos.get("latitude").asText());
        double lon = Double.parseDouble(pos.get("longitude").asText());
        if (!Double.isFinite(lat) || !Double.isFinite(lon) || Math.abs(lat) > 90.0 || Math.abs(lon) > 180.0) {
            return Optional.empty();
        }
        return Optional.of(new double[] { lat, lon });
    }
}
