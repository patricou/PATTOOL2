package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Shared local-network UI switch states (same for every user), stored in MongoDB
 * under {@code local.network.global.prefs}.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record LocalNetworkGlobalPrefsDto(
        Boolean useExternalVendorAPI,
        Boolean scanSchedulerEnabled,
        Boolean showOnlyUnknownDevices,
        Boolean showOnlyMacConflictDevices,
        Boolean wifiScanUseBackend) {
}
