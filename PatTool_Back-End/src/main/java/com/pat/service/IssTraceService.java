package com.pat.service;

import com.pat.repo.IssTracePointRepository;
import com.pat.repo.domain.IssTracePoint;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Persists ISS ground-track samples and serves a decimated trace for globe display.
 */
@Service
public class IssTraceService {

    private static final Logger log = LoggerFactory.getLogger(IssTraceService.class);

    /** MongoDB {@code appParameters} key for the display point-count limit toggle (survives restarts). */
    public static final String PARAM_DISPLAY_LIMIT_ENABLED = "globe.iss.trace.display.limit.enabled";

    private final IssTracePointRepository repository;
    private final AppParameterService appParameterService;

    @Value("${globe.iss.trace.retention.days:30}")
    private int retentionDays;

    @Value("${globe.iss.trace.max-display-points:8000}")
    private int maxDisplayPoints;

    @Value("${globe.iss.trace.sample-interval.seconds:60}")
    private int sampleIntervalSeconds;

    /** Cap applied to the returned trace when the display limit toggle is ON. */
    @Value("${globe.iss.trace.display.limit.points:1000}")
    private int limitedDisplayPoints;

    @Value("${globe.iss.trace.display.limit.enabled-default:true}")
    private boolean displayLimitEnabledDefault;

    /** When {@code true} the trace is decimated to {@link #limitedDisplayPoints}; otherwise every point is returned. */
    private volatile boolean displayLimitEnabled;

    public IssTraceService(IssTracePointRepository repository, AppParameterService appParameterService) {
        this.repository = repository;
        this.appParameterService = appParameterService;
    }

    @PostConstruct
    public void init() {
        displayLimitEnabled = appParameterService.getBooleanSafe(PARAM_DISPLAY_LIMIT_ENABLED, displayLimitEnabledDefault);
        log.info("ISS trace display limit: enabled={}, maxPoints={}", displayLimitEnabled, getLimitedDisplayPoints());
    }

    public int getRetentionDays() {
        return retentionDays;
    }

    public int getSampleIntervalSeconds() {
        return Math.max(1, sampleIntervalSeconds);
    }

    public boolean isDisplayLimitEnabled() {
        return displayLimitEnabled;
    }

    /** Effective cap used when the display limit is enabled (at least 100). */
    public int getLimitedDisplayPoints() {
        return Math.max(100, limitedDisplayPoints);
    }

    /** Persists the flag in MongoDB so it survives backend restarts. */
    public void setDisplayLimitEnabled(boolean enabled) {
        displayLimitEnabled = enabled;
        appParameterService.setBoolean(
                PARAM_DISPLAY_LIMIT_ENABLED,
                enabled,
                "Limit the ISS trace returned for globe display to a fixed number of points (otherwise return all stored points).");
        log.info("ISS trace display limit {}", enabled ? "enabled" : "disabled");
    }

    /**
     * Append one sample at most every {@link #getSampleIntervalSeconds()} (default 1 minute).
     *
     * @return {@code true} when a new document was stored
     */
    public boolean recordPoint(double latitude, double longitude, Instant recordedAt) {
        return recordPoint(latitude, longitude, recordedAt, getSampleIntervalSeconds());
    }

    /**
     * Append one sample when at least {@code minIntervalSeconds} elapsed since the last stored point.
     *
     * @param minIntervalSeconds minimum spacing between samples (e.g. 900 for 15-minute background sampling)
     * @return {@code true} when a new document was stored
     */
    public boolean recordPoint(double latitude, double longitude, Instant recordedAt, int minIntervalSeconds) {
        if (!isValidCoordinate(latitude, longitude)) {
            return false;
        }
        int minSec = Math.max(1, minIntervalSeconds);
        Instant at = recordedAt != null ? recordedAt : Instant.now();
        var lastOpt = repository.findTopByOrderByRecordedAtDesc();
        if (lastOpt.isPresent()) {
            IssTracePoint last = lastOpt.get();
            Instant lastAt = last.getRecordedAt();
            if (lastAt != null) {
                long elapsedSec = Duration.between(lastAt, at).getSeconds();
                if (elapsedSec < minSec) {
                    return false;
                }
            }
        }
        repository.save(new IssTracePoint(latitude, longitude, at));
        purgeOlderThanRetention();
        return true;
    }

    public List<IssTracePointView> getTraceForDisplay() {
        Instant cutoff = Instant.now().minusSeconds(retentionDays * 86400L);
        List<IssTracePoint> raw = repository.findByRecordedAtAfterOrderByRecordedAtAsc(cutoff);
        if (!displayLimitEnabled) {
            return raw.stream().map(IssTracePointView::from).toList();
        }
        return decimateForDisplay(raw, getLimitedDisplayPoints());
    }

    /** Most recent stored sample (fast Mongo lookup for ISS-now fallback). */
    public Optional<IssTracePointView> findLatestPoint() {
        return repository.findTopByOrderByRecordedAtDesc().map(IssTracePointView::from);
    }

    public long purgeOlderThanRetention() {
        Instant cutoff = Instant.now().minusSeconds(retentionDays * 86400L);
        long deleted = repository.deleteByRecordedAtBefore(cutoff);
        if (deleted > 0) {
            log.debug("ISS trace purge: removed {} point(s) older than {} days", deleted, retentionDays);
        }
        return deleted;
    }

    /** Removes every stored ISS trace sample (admin / user clear from globe UI). */
    public long clearAll() {
        long count = repository.count();
        if (count > 0) {
            repository.deleteAll();
            log.info("ISS trace cleared: {} point(s) removed", count);
        }
        return count;
    }

    private List<IssTracePointView> decimateForDisplay(List<IssTracePoint> raw, int requestedCap) {
        if (raw == null || raw.isEmpty()) {
            return List.of();
        }
        int cap = Math.min(Math.max(100, maxDisplayPoints), Math.max(100, requestedCap));
        if (raw.size() <= cap) {
            return raw.stream().map(IssTracePointView::from).toList();
        }
        List<IssTracePointView> out = new ArrayList<>(cap);
        long minStepMs = getSampleIntervalSeconds() * 1000L;
        IssTracePoint first = raw.get(0);
        Instant firstAt = first.getRecordedAt() != null ? first.getRecordedAt() : Instant.EPOCH;
        Instant lastAt = raw.get(raw.size() - 1).getRecordedAt();
        long spanMs = lastAt != null ? Duration.between(firstAt, lastAt).toMillis() : 0L;
        long stepMs = Math.max(minStepMs, spanMs / Math.max(1L, cap - 1L));

        out.add(IssTracePointView.from(first));
        long nextPickMs = firstAt.toEpochMilli() + stepMs;
        for (int i = 1; i < raw.size() - 1; i++) {
            IssTracePoint p = raw.get(i);
            Instant at = p.getRecordedAt();
            if (at == null) {
                continue;
            }
            if (at.toEpochMilli() >= nextPickMs) {
                out.add(IssTracePointView.from(p));
                nextPickMs = at.toEpochMilli() + stepMs;
            }
        }
        IssTracePoint last = raw.get(raw.size() - 1);
        if (out.isEmpty() || !out.get(out.size() - 1).recordedAt().equals(
                last.getRecordedAt() != null ? last.getRecordedAt() : Instant.EPOCH)) {
            out.add(IssTracePointView.from(last));
        }
        return out;
    }

    private static boolean isValidCoordinate(double latitude, double longitude) {
        return Double.isFinite(latitude) && Double.isFinite(longitude)
                && Math.abs(latitude) <= 90.0 && Math.abs(longitude) <= 180.0;
    }

    public record IssTracePointView(double latitude, double longitude, Instant recordedAt) {
        static IssTracePointView from(IssTracePoint p) {
            return new IssTracePointView(
                    p.getLatitude() != null ? p.getLatitude() : 0.0,
                    p.getLongitude() != null ? p.getLongitude() : 0.0,
                    p.getRecordedAt() != null ? p.getRecordedAt() : Instant.EPOCH);
        }
    }
}
