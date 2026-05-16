package com.pat.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * WLAN BSSID enumerated on the PatTool backend host OS (browser cannot do this).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record VisibleWifiNetwork(
        String ssid,
        String bssid,
        Integer signalPercent,
        String authentication,
        Integer signalDbm
) {}
