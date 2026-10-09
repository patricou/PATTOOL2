package com.pat.dto;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * What the sentinel has learned about "normal" on this host (MongoDB app parameter, JSON).
 * Mutable on purpose: updated after each sweep.
 */
public class SentinelBaseline {

    /** "tcp:22" style keys of listeners seen on previous sweeps. */
    private Set<String> knownListeners = new HashSet<>();
    /** ip -> mac learned from ARP / Ethernet headers (gateway spoof detection). */
    private Map<String, String> arpTable = new HashMap<>();
    /** "user@sourceAddress" of successful logons already seen. */
    private Set<String> knownLogons = new HashSet<>();
    /** Public peers the host already talked to (outbound). Capped. */
    private Set<String> knownPublicPeers = new HashSet<>();
    /** Finding keys the admin acknowledged (suppressed from alerts, still listed as INFO). */
    private Set<String> acknowledgedKeys = new HashSet<>();
    /** finding key -> epoch millis of last e-mail alert. */
    private Map<String, Long> lastAlertedAt = new HashMap<>();
    private boolean initialized = false;
    private int sweepCount = 0;
    private Long updatedAt;

    public Set<String> getKnownListeners() {
        return knownListeners;
    }

    public void setKnownListeners(Set<String> knownListeners) {
        this.knownListeners = knownListeners != null ? knownListeners : new HashSet<>();
    }

    public Map<String, String> getArpTable() {
        return arpTable;
    }

    public void setArpTable(Map<String, String> arpTable) {
        this.arpTable = arpTable != null ? arpTable : new HashMap<>();
    }

    public Set<String> getKnownLogons() {
        return knownLogons;
    }

    public void setKnownLogons(Set<String> knownLogons) {
        this.knownLogons = knownLogons != null ? knownLogons : new HashSet<>();
    }

    public Set<String> getKnownPublicPeers() {
        return knownPublicPeers;
    }

    public void setKnownPublicPeers(Set<String> knownPublicPeers) {
        this.knownPublicPeers = knownPublicPeers != null ? knownPublicPeers : new HashSet<>();
    }

    public Set<String> getAcknowledgedKeys() {
        return acknowledgedKeys;
    }

    public void setAcknowledgedKeys(Set<String> acknowledgedKeys) {
        this.acknowledgedKeys = acknowledgedKeys != null ? acknowledgedKeys : new HashSet<>();
    }

    public Map<String, Long> getLastAlertedAt() {
        return lastAlertedAt;
    }

    public void setLastAlertedAt(Map<String, Long> lastAlertedAt) {
        this.lastAlertedAt = lastAlertedAt != null ? lastAlertedAt : new HashMap<>();
    }

    public boolean isInitialized() {
        return initialized;
    }

    public void setInitialized(boolean initialized) {
        this.initialized = initialized;
    }

    public int getSweepCount() {
        return sweepCount;
    }

    public void setSweepCount(int sweepCount) {
        this.sweepCount = sweepCount;
    }

    public Long getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(Long updatedAt) {
        this.updatedAt = updatedAt;
    }
}
