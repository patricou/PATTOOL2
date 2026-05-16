package com.pat.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;
import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record WifiScanResult(
        String hostName,
        /** Backend host network name hint (may duplicate hostName); useful when hostname is unresolved. */
        String captureHostLabel,
        String captureSourceExplanationEn,
        String captureSourceExplanationFr,
        String platformKey,
        String platformDescription,
        Instant scannedAt,
        List<VisibleWifiNetwork> networks,
        String warning
) {}
