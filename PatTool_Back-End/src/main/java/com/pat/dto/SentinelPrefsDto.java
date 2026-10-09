package com.pat.dto;

import java.util.List;

/**
 * Shared network-sentinel settings (MongoDB app parameter, admin writes). Null = keep current.
 *
 * @param emailMinSeverity   lowest severity that triggers an e-mail: CRITICAL | HIGH | MEDIUM | LOW
 * @param trustedRemoteCidrs public addresses / CIDRs that are legitimate (VPN endpoint, own office...)
 * @param expectedListeners  listeners that are legitimate, "tcp:443" form
 * @param captureInterface   capture interface override (tshark/tcpdump -i); null = auto
 */
public record SentinelPrefsDto(
        Boolean schedulerEnabled,
        Integer schedulerIntervalMinutes,
        Integer captureSeconds,
        Boolean includeDeviceScan,
        Boolean includeCapture,
        Boolean emailAlertsEnabled,
        String emailMinSeverity,
        List<String> trustedRemoteCidrs,
        List<String> expectedListeners,
        String captureInterface) {
}
