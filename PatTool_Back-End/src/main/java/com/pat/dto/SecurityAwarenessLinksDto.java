package com.pat.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Réponse GET {@code /api/config/security-awareness-links}.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class SecurityAwarenessLinksDto {

    private final String scannerDashboardUrl;
    private final String internalRunbookUrl;

    public SecurityAwarenessLinksDto(String scannerDashboardUrl, String internalRunbookUrl) {
        this.scannerDashboardUrl = scannerDashboardUrl;
        this.internalRunbookUrl = internalRunbookUrl;
    }

    public String getScannerDashboardUrl() {
        return scannerDashboardUrl;
    }

    public String getInternalRunbookUrl() {
        return internalRunbookUrl;
    }
}
