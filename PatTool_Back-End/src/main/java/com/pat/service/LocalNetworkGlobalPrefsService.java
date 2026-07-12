package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.LocalNetworkGlobalPrefsDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Optional;

/**
 * Shared local-network switch states (MongoDB {@code local.network.global.prefs}, JSON).
 * Writable by admins only (enforced in {@link com.pat.controller.LocalNetworkController}).
 */
@Service
public class LocalNetworkGlobalPrefsService {

    private static final Logger log = LoggerFactory.getLogger(LocalNetworkGlobalPrefsService.class);

    public static final String PARAM_GLOBAL_PREFS = "local.network.global.prefs";

    private static final boolean DEFAULT_USE_EXTERNAL_VENDOR_API = false;
    private static final boolean DEFAULT_SCAN_SCHEDULER_ENABLED = false;
    private static final boolean DEFAULT_SHOW_ONLY_UNKNOWN = false;
    private static final boolean DEFAULT_SHOW_ONLY_MAC_CONFLICT = false;
    private static final boolean DEFAULT_WIFI_SCAN_USE_BACKEND = true;

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;

    public LocalNetworkGlobalPrefsService(AppParameterService appParameterService, ObjectMapper objectMapper) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
    }

    public boolean hasStoredPrefs() {
        return appParameterService.find(PARAM_GLOBAL_PREFS).isPresent();
    }

    public LocalNetworkGlobalPrefsDto getPrefs() {
        return mergeWithDefaults(readStored());
    }

    public LocalNetworkGlobalPrefsDto updatePrefs(LocalNetworkGlobalPrefsDto patch) {
        if (patch == null) {
            return getPrefs();
        }
        LocalNetworkGlobalPrefsDto current = mergeWithDefaults(readStored());
        LocalNetworkGlobalPrefsDto merged = new LocalNetworkGlobalPrefsDto(
                patch.useExternalVendorAPI() != null ? patch.useExternalVendorAPI() : current.useExternalVendorAPI(),
                patch.scanSchedulerEnabled() != null ? patch.scanSchedulerEnabled() : current.scanSchedulerEnabled(),
                patch.showOnlyUnknownDevices() != null ? patch.showOnlyUnknownDevices() : current.showOnlyUnknownDevices(),
                patch.showOnlyMacConflictDevices() != null ? patch.showOnlyMacConflictDevices()
                        : current.showOnlyMacConflictDevices(),
                patch.wifiScanUseBackend() != null ? patch.wifiScanUseBackend() : current.wifiScanUseBackend());
        writeStored(merged);
        return merged;
    }

    private Optional<LocalNetworkGlobalPrefsDto> readStored() {
        Optional<AppParameter> row = appParameterService.find(PARAM_GLOBAL_PREFS);
        if (row.isEmpty()) {
            return Optional.empty();
        }
        String raw = row.get().getParamValue();
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        try {
            return Optional.of(objectMapper.readValue(raw, LocalNetworkGlobalPrefsDto.class));
        } catch (JsonProcessingException e) {
            log.warn("local.network.global.prefs unreadable JSON: {}", e.getMessage());
            return Optional.empty();
        }
    }

    private void writeStored(LocalNetworkGlobalPrefsDto prefs) {
        try {
            String json = objectMapper.writeValueAsString(prefs);
            appParameterService.setJson(
                    PARAM_GLOBAL_PREFS,
                    json,
                    "Shared local-network UI switch states (all users, admin writes).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization local network global prefs", e);
        }
    }

    private LocalNetworkGlobalPrefsDto mergeWithDefaults(Optional<LocalNetworkGlobalPrefsDto> stored) {
        LocalNetworkGlobalPrefsDto s = stored.orElse(new LocalNetworkGlobalPrefsDto(
                null, null, null, null, null));
        return new LocalNetworkGlobalPrefsDto(
                s.useExternalVendorAPI() != null ? s.useExternalVendorAPI() : DEFAULT_USE_EXTERNAL_VENDOR_API,
                s.scanSchedulerEnabled() != null ? s.scanSchedulerEnabled() : DEFAULT_SCAN_SCHEDULER_ENABLED,
                s.showOnlyUnknownDevices() != null ? s.showOnlyUnknownDevices() : DEFAULT_SHOW_ONLY_UNKNOWN,
                s.showOnlyMacConflictDevices() != null ? s.showOnlyMacConflictDevices() : DEFAULT_SHOW_ONLY_MAC_CONFLICT,
                s.wifiScanUseBackend() != null ? s.wifiScanUseBackend() : DEFAULT_WIFI_SCAN_USE_BACKEND);
    }
}
