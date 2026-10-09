package com.pat.repo.domain;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One detection produced by the network sentinel (embedded in {@link NetworkSentinelSweep}).
 * Texts are English; the UI translates category / severity and shows detail as-is.
 */
public class NetworkSentinelFinding {

    public static final String SEV_CRITICAL = "CRITICAL";
    public static final String SEV_HIGH = "HIGH";
    public static final String SEV_MEDIUM = "MEDIUM";
    public static final String SEV_LOW = "LOW";
    public static final String SEV_INFO = "INFO";

    /** Stable dedup key, e.g. "EXTERNAL_INBOUND|1.2.3.4|tcp:22". */
    private String key;
    private String category;
    private String severity;
    private String title;
    private String detail;
    private Map<String, Object> evidence = new LinkedHashMap<>();
    private boolean acknowledged;
    /** True when the finding indicates an intrusion that already succeeded (vs. an attempt / anomaly). */
    private boolean intrusionSucceeded;

    public NetworkSentinelFinding() {
    }

    public NetworkSentinelFinding(String key, String category, String severity, String title, String detail,
            boolean intrusionSucceeded) {
        this.key = key;
        this.category = category;
        this.severity = severity;
        this.title = title;
        this.detail = detail;
        this.intrusionSucceeded = intrusionSucceeded;
    }

    public NetworkSentinelFinding evidence(String k, Object v) {
        if (k != null && v != null) {
            evidence.put(k, v);
        }
        return this;
    }

    public static int severityRank(String severity) {
        if (severity == null) {
            return 0;
        }
        return switch (severity) {
            case SEV_CRITICAL -> 4;
            case SEV_HIGH -> 3;
            case SEV_MEDIUM -> 2;
            case SEV_LOW -> 1;
            default -> 0;
        };
    }

    public String getKey() {
        return key;
    }

    public void setKey(String key) {
        this.key = key;
    }

    public String getCategory() {
        return category;
    }

    public void setCategory(String category) {
        this.category = category;
    }

    public String getSeverity() {
        return severity;
    }

    public void setSeverity(String severity) {
        this.severity = severity;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getDetail() {
        return detail;
    }

    public void setDetail(String detail) {
        this.detail = detail;
    }

    public Map<String, Object> getEvidence() {
        return evidence;
    }

    public void setEvidence(Map<String, Object> evidence) {
        this.evidence = evidence != null ? evidence : new LinkedHashMap<>();
    }

    public boolean isAcknowledged() {
        return acknowledged;
    }

    public void setAcknowledged(boolean acknowledged) {
        this.acknowledged = acknowledged;
    }

    public boolean isIntrusionSucceeded() {
        return intrusionSucceeded;
    }

    public void setIntrusionSucceeded(boolean intrusionSucceeded) {
        this.intrusionSucceeded = intrusionSucceeded;
    }
}
