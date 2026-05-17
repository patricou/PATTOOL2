package com.pat.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * Liens optionnels affichés par la page « Monde → Sécurité / périmètre autorisé ».
 * À configurer dans {@code application.properties} sous {@code pat.security-awareness.*}.
 */
@Component
@ConfigurationProperties(prefix = "pat.security-awareness")
public class SecurityAwarenessLinksProperties {

    /**
     * URL du tableau de bord de votre scanner auto-hébergé (OWASP ZAP, Burp Enterprise, etc.).
     */
    private String scannerDashboardUrl = "";

    /**
     * URL interne vers votre runbook ou procédure de test de sécurité.
     */
    private String internalRunbookUrl = "";

    public String getScannerDashboardUrl() {
        return scannerDashboardUrl;
    }

    public void setScannerDashboardUrl(String scannerDashboardUrl) {
        this.scannerDashboardUrl = scannerDashboardUrl;
    }

    public String getInternalRunbookUrl() {
        return internalRunbookUrl;
    }

    public void setInternalRunbookUrl(String internalRunbookUrl) {
        this.internalRunbookUrl = internalRunbookUrl;
    }
}
