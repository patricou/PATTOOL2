package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.dto.SentinelPrefsDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;

/**
 * Shared network-sentinel settings (MongoDB app parameter {@code network.sentinel.prefs}, JSON).
 */
@Service
public class NetworkSentinelPrefsService {

    private static final Logger log = LoggerFactory.getLogger(NetworkSentinelPrefsService.class);

    public static final String PARAM_PREFS = "network.sentinel.prefs";

    static final boolean DEFAULT_SCHEDULER_ENABLED = false;
    static final int DEFAULT_INTERVAL_MINUTES = 15;
    static final int DEFAULT_CAPTURE_SECONDS = 20;
    static final boolean DEFAULT_INCLUDE_DEVICE_SCAN = true;
    static final boolean DEFAULT_INCLUDE_CAPTURE = true;
    static final boolean DEFAULT_EMAIL_ENABLED = true;
    static final String DEFAULT_EMAIL_MIN_SEVERITY = "HIGH";
    private static final Set<String> SEVERITIES = Set.of("CRITICAL", "HIGH", "MEDIUM", "LOW");

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;

    public NetworkSentinelPrefsService(AppParameterService appParameterService, ObjectMapper objectMapper) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
    }

    public SentinelPrefsDto getPrefs() {
        return mergeWithDefaults(readStored().orElse(null));
    }

    public SentinelPrefsDto updatePrefs(SentinelPrefsDto patch) {
        SentinelPrefsDto current = getPrefs();
        if (patch == null) {
            return current;
        }
        SentinelPrefsDto merged = new SentinelPrefsDto(
                patch.schedulerEnabled() != null ? patch.schedulerEnabled() : current.schedulerEnabled(),
                patch.schedulerIntervalMinutes() != null ? clamp(patch.schedulerIntervalMinutes(), 5, 24 * 60)
                        : current.schedulerIntervalMinutes(),
                patch.captureSeconds() != null ? clamp(patch.captureSeconds(), 5, 120) : current.captureSeconds(),
                patch.includeDeviceScan() != null ? patch.includeDeviceScan() : current.includeDeviceScan(),
                patch.includeCapture() != null ? patch.includeCapture() : current.includeCapture(),
                patch.emailAlertsEnabled() != null ? patch.emailAlertsEnabled() : current.emailAlertsEnabled(),
                patch.emailMinSeverity() != null ? normalizeSeverity(patch.emailMinSeverity(), current.emailMinSeverity())
                        : current.emailMinSeverity(),
                patch.trustedRemoteCidrs() != null ? cleanCidrs(patch.trustedRemoteCidrs()) : current.trustedRemoteCidrs(),
                patch.expectedListeners() != null ? cleanListeners(patch.expectedListeners()) : current.expectedListeners(),
                patch.captureInterface() != null ? blankToNull(patch.captureInterface()) : current.captureInterface());
        writeStored(merged);
        return merged;
    }

    private Optional<SentinelPrefsDto> readStored() {
        Optional<AppParameter> row = appParameterService.find(PARAM_PREFS);
        if (row.isEmpty()) {
            return Optional.empty();
        }
        String raw = row.get().getParamValue();
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        try {
            return Optional.of(objectMapper.readValue(raw, SentinelPrefsDto.class));
        } catch (JsonProcessingException e) {
            log.warn("network.sentinel.prefs unreadable JSON: {}", e.getMessage());
            return Optional.empty();
        }
    }

    private void writeStored(SentinelPrefsDto prefs) {
        try {
            appParameterService.setJson(PARAM_PREFS, objectMapper.writeValueAsString(prefs),
                    "Network sentinel settings (scheduler, capture, alerts, trusted networks).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization network sentinel prefs", e);
        }
    }

    private SentinelPrefsDto mergeWithDefaults(SentinelPrefsDto s) {
        if (s == null) {
            s = new SentinelPrefsDto(null, null, null, null, null, null, null, null, null, null);
        }
        return new SentinelPrefsDto(
                s.schedulerEnabled() != null ? s.schedulerEnabled() : DEFAULT_SCHEDULER_ENABLED,
                s.schedulerIntervalMinutes() != null ? s.schedulerIntervalMinutes() : DEFAULT_INTERVAL_MINUTES,
                s.captureSeconds() != null ? s.captureSeconds() : DEFAULT_CAPTURE_SECONDS,
                s.includeDeviceScan() != null ? s.includeDeviceScan() : DEFAULT_INCLUDE_DEVICE_SCAN,
                s.includeCapture() != null ? s.includeCapture() : DEFAULT_INCLUDE_CAPTURE,
                s.emailAlertsEnabled() != null ? s.emailAlertsEnabled() : DEFAULT_EMAIL_ENABLED,
                s.emailMinSeverity() != null ? s.emailMinSeverity() : DEFAULT_EMAIL_MIN_SEVERITY,
                s.trustedRemoteCidrs() != null ? s.trustedRemoteCidrs() : List.of(),
                s.expectedListeners() != null ? s.expectedListeners() : List.of(),
                s.captureInterface());
    }

    private static int clamp(int v, int min, int max) {
        return Math.max(min, Math.min(max, v));
    }

    private static String normalizeSeverity(String s, String fallback) {
        String u = s.trim().toUpperCase(Locale.ROOT);
        return SEVERITIES.contains(u) ? u : fallback;
    }

    private static List<String> cleanCidrs(List<String> raws) {
        Set<String> out = new LinkedHashSet<>();
        for (String r : raws) {
            SentinelIpUtil.Cidr c = SentinelIpUtil.parseCidr(r);
            if (c != null) {
                out.add(c.toString());
            }
        }
        return new ArrayList<>(out);
    }

    private static List<String> cleanListeners(List<String> raws) {
        Set<String> out = new LinkedHashSet<>();
        for (String r : raws) {
            if (r == null) {
                continue;
            }
            String t = r.trim().toLowerCase(Locale.ROOT);
            if (t.matches("^\\d{1,5}$")) {
                t = "tcp:" + t;
            }
            if (t.matches("^(tcp|udp):\\d{1,5}$")) {
                out.add(t);
            }
        }
        return new ArrayList<>(out);
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }
}
