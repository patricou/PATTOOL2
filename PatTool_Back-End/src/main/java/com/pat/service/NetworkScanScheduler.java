package com.pat.service;

import com.pat.controller.MailController;
import com.pat.repo.NetworkDeviceMappingRepository;
import com.pat.repo.NewDeviceHistoryRepository;
import com.pat.repo.domain.NetworkDeviceMapping;
import com.pat.repo.domain.NewDeviceHistory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import jakarta.annotation.PostConstruct;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;
import java.util.Date;

/**
 * Scheduled task to scan the network and send email notification if new devices are found
 * New devices are identified by MAC address - if a device's MAC address is not in NetworkDeviceMapping,
 * it is considered a new device
 */
@Service
public class NetworkScanScheduler {

    private static final Logger log = LoggerFactory.getLogger(NetworkScanScheduler.class);

    @Autowired
    private LocalNetworkService localNetworkService;

    @Autowired
    private NetworkDeviceMappingRepository deviceMappingRepository;

    @Autowired
    private NewDeviceHistoryRepository newDeviceHistoryRepository;

    @Autowired
    private MailController mailController;

    @Value("${app.network.scan.scheduler.enabled:false}")
    private boolean schedulerEnabledDefault;

    @Value("${app.network.scan.scheduler.cron:0 */10 * * * ?}")
    private String schedulerCron;

    // Runtime flag that can be updated via API (defaults to application.properties value)
    private volatile boolean schedulerEnabled;

    /**
     * Initialize scheduler enabled flag from application.properties
     * Called after dependency injection
     */
    @PostConstruct
    public void init() {
        this.schedulerEnabled = schedulerEnabledDefault;
        log.info("Network scan scheduler initialized. Enabled: {}", schedulerEnabled);
    }

    /**
     * Get current scheduler enabled status
     */
    public boolean isSchedulerEnabled() {
        return schedulerEnabled;
    }

    /**
     * Set scheduler enabled status (can be updated at runtime)
     */
    public void setSchedulerEnabled(boolean enabled) {
        this.schedulerEnabled = enabled;
        log.info("Network scan scheduler enabled flag updated to: {}", enabled);
    }

    /**
     * Get scan interval in minutes from cron expression
     * Parses cron expression format: "second minute hour day month weekday"
     * Supports cron patterns like every N minutes (e.g., every 10 minutes, every 5 minutes)
     * @return interval in minutes, or 10 as default if parsing fails
     */
    public int getScanIntervalMinutes() {
        try {
            if (schedulerCron == null || schedulerCron.trim().isEmpty()) {
                return 10; // Default
            }
            
            String[] parts = schedulerCron.trim().split("\\s+");
            if (parts.length < 2) {
                log.warn("Invalid cron expression format: {}", schedulerCron);
                return 10; // Default
            }
            
            String minutePart = parts[1]; // Second field is minutes
            
            // Handle "*/N" format (every N minutes)
            if (minutePart.startsWith("*/")) {
                try {
                    int interval = Integer.parseInt(minutePart.substring(2));
                    return interval > 0 ? interval : 10;
                } catch (NumberFormatException e) {
                    log.warn("Could not parse minute interval from cron: {}", minutePart);
                    return 10; // Default
                }
            }
            
            // Handle single number (specific minute) or other formats
            // If it's a specific minute or other format, we can't determine interval, return default
            log.warn("Cron minute pattern '{}' is not in */N format, using default interval", minutePart);
            return 10;
        } catch (Exception e) {
            log.error("Error parsing cron expression for interval: {}", schedulerCron, e);
            return 10; // Default fallback
        }
    }

    /**
     * Scheduled network scan - runs every 10 minutes when enabled
     * Scans the network and sends email if new devices (by MAC address) are found
     */
    @Scheduled(cron = "${app.network.scan.scheduler.cron:0 */10 * * * ?}")
    public void scheduledNetworkScan() {
        if (!schedulerEnabled) {
            log.debug("Network scan scheduler is disabled (app.network.scan.scheduler.enabled=false)");
            return;
        }

        log.debug("========== SCHEDULED NETWORK SCAN STARTED ==========");
        long startTime = System.currentTimeMillis();

        try {
            // Load all existing device mappings from MongoDB
            List<NetworkDeviceMapping> existingMappings = deviceMappingRepository.findAll();
            Set<String> knownMacAddresses = existingMappings.stream()
                    .map(NetworkDeviceMapping::getMacAddress)
                    .filter(mac -> mac != null && !mac.trim().isEmpty())
                    .map(this::normalizeMacAddress)
                    .collect(Collectors.toSet());

            log.debug("Loaded {} existing device mappings from MongoDB", existingMappings.size());
            log.debug("Known MAC addresses: {}", knownMacAddresses.size());

            // Collect all found devices during scan
            List<Map<String, Object>> foundDevices = new ArrayList<>();
            List<Map<String, Object>> newDevices = new ArrayList<>();

            // Perform network scan with callback to collect devices
            localNetworkService.scanLocalNetworkStreaming(false, (device, progress, total) -> {
                if (device != null && !device.isEmpty()) {
                    foundDevices.add(device);
                    
                    // Check if device is new (by MAC address)
                    String macAddress = (String) device.get("macAddress");
                    if (macAddress != null && !macAddress.trim().isEmpty()) {
                        String normalizedMac = normalizeMacAddress(macAddress);
                        if (!knownMacAddresses.contains(normalizedMac)) {
                            // This is a new device
                            newDevices.add(device);
                            log.debug("New device detected: IP={}, MAC={}, Hostname={}", 
                                    device.get("ipAddress"), macAddress, device.get("hostname"));
                        }
                    }
                }
            });

            long scanDuration = System.currentTimeMillis() - startTime;
            log.debug("Network scan completed in {} ms. Found {} devices, {} new devices", 
                    scanDuration, foundDevices.size(), newDevices.size());

            // Save new devices to history in MongoDB
            if (!newDevices.isEmpty()) {
                log.debug("Saving {} new device(s) to history in MongoDB", newDevices.size());
                saveNewDevicesToHistory(newDevices);
                
                log.debug("Sending email notification for {} new device(s)", newDevices.size());
                sendNewDeviceNotificationEmail(newDevices);
            } else {
                log.debug("No new devices found - email notification skipped");
            }

        } catch (Exception e) {
            log.error("Error during scheduled network scan: {}", e.getMessage(), e);
        }

        log.debug("========== SCHEDULED NETWORK SCAN COMPLETED ==========");
    }

    /**
     * Save new devices to history in MongoDB
     */
    private void saveNewDevicesToHistory(List<Map<String, Object>> newDevices) {
        try {
            for (Map<String, Object> device : newDevices) {
                String macAddress = (String) device.get("macAddress");
                
                // Skip if no MAC address
                if (macAddress == null || macAddress.trim().isEmpty()) {
                    continue;
                }
                
                // Always add a new entry to history, even if device already exists (to track detection times)
                String normalizedMac = normalizeMacAddress(macAddress);
                
                NewDeviceHistory historyEntry = new NewDeviceHistory();
                historyEntry.setIpAddress((String) device.get("ipAddress"));
                historyEntry.setHostname((String) device.get("hostname"));
                historyEntry.setMacAddress(normalizedMac);
                historyEntry.setVendor((String) device.get("vendor"));
                historyEntry.setDeviceType((String) device.get("deviceType"));
                historyEntry.setOs((String) device.get("os"));
                
                // Convert open ports list to comma-separated string
                @SuppressWarnings("unchecked")
                List<Integer> openPorts = (List<Integer>) device.get("openPorts");
                if (openPorts != null && !openPorts.isEmpty()) {
                    String portsStr = openPorts.stream()
                            .map(String::valueOf)
                            .collect(Collectors.joining(", "));
                    historyEntry.setOpenPorts(portsStr);
                }
                
                historyEntry.setDetectionDate(new Date());
                
                newDeviceHistoryRepository.save(historyEntry);
                log.debug("Saved new device detection to history: IP={}, MAC={}, DetectionDate={}", 
                        historyEntry.getIpAddress(), historyEntry.getMacAddress(), historyEntry.getDetectionDate());
            }
        } catch (Exception e) {
            log.error("Error saving new devices to history: {}", e.getMessage(), e);
        }
    }

    /**
     * Send email notification for new devices
     */
    private void sendNewDeviceNotificationEmail(List<Map<String, Object>> newDevices) {
        try {
            String subject = "[PatTool] Nouveaux appareils détectés sur le réseau - " + 
                            newDevices.size() + " appareil(s)";
            
            String body = generateNewDeviceEmailHtml(newDevices);
            
            mailController.sendMail(subject, body, true); // true = HTML format
            
            log.debug("Email notification sent successfully for {} new device(s)", newDevices.size());
        } catch (Exception e) {
            log.error("Failed to send email notification for new devices: {}", e.getMessage(), e);
        }
    }

    /**
     * Generate HTML email body for new device notification
     * Style similar to other emails in the application
     */
    private String generateNewDeviceEmailHtml(List<Map<String, Object>> newDevices) {
        StringBuilder bodyBuilder = new StringBuilder();
        bodyBuilder.append("<!DOCTYPE html><html><head><meta charset='UTF-8'>");
        bodyBuilder.append("<style>");
        bodyBuilder.append("body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 15px; line-height: 1.8; color: #2c3e50; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); margin: 0; padding: 20px; }");
        bodyBuilder.append(".container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); overflow: hidden; }");
        bodyBuilder.append(".header { background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; padding: 25px; text-align: center; border-bottom: 4px solid #1e7e34; }");
        bodyBuilder.append(".header h1 { margin: 0; font-size: 24px; font-weight: 700; text-shadow: 2px 2px 4px rgba(0,0,0,0.2); letter-spacing: 1px; }");
        bodyBuilder.append(".header-icon { font-size: 32px; margin-bottom: 10px; }");
        bodyBuilder.append(".content { padding: 30px; background: #fafafa; }");
        bodyBuilder.append(".message { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #28a745; }");
        bodyBuilder.append(".device-info { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }");
        bodyBuilder.append(".device-info h3 { margin: 0 0 15px 0; color: #333; font-weight: 600; }");
        bodyBuilder.append(".info-item { margin: 10px 0; padding: 10px; background: #f8f9fa; border-radius: 6px; }");
        bodyBuilder.append(".info-label { font-weight: 700; color: #495057; margin-right: 10px; }");
        bodyBuilder.append(".info-value { color: #212529; }");
        bodyBuilder.append(".footer { background: #e9ecef; padding: 20px; text-align: center; color: #6c757d; font-size: 12px; }");
        bodyBuilder.append("</style></head><body>");
        
        bodyBuilder.append("<div class='container'>");
        bodyBuilder.append("<div class='header'>");
        bodyBuilder.append("<div class='header-icon'>🔍</div>");
        bodyBuilder.append("<h1>Nouveaux Appareils Détectés</h1>");
        bodyBuilder.append("</div>");
        
        bodyBuilder.append("<div class='content'>");
        bodyBuilder.append("<div class='message'>");
        bodyBuilder.append("<p><strong>").append(newDevices.size()).append(" nouveau(x) appareil(s)</strong> ");
        bodyBuilder.append("ont été détecté(s) sur votre réseau local. Ces appareils n'étaient pas présents dans la base de données des appareils connus.</p>");
        bodyBuilder.append("<p>Veuillez vérifier ces appareils et les ajouter à la base de données si nécessaire.</p>");
        bodyBuilder.append("</div>");
        
        // Add each new device
        int deviceNumber = 1;
        for (Map<String, Object> device : newDevices) {
            bodyBuilder.append("<div class='device-info'>");
            bodyBuilder.append("<h3>Appareil #").append(deviceNumber++).append("</h3>");
            
            addInfoItem(bodyBuilder, "Adresse IP", (String) device.get("ipAddress"));
            addInfoItem(bodyBuilder, "Nom d'hôte", (String) device.get("hostname"));
            addInfoItem(bodyBuilder, "Adresse MAC", (String) device.get("macAddress"));
            addInfoItem(bodyBuilder, "Fabricant", (String) device.get("vendor"));
            addInfoItem(bodyBuilder, "Type d'appareil", (String) device.get("deviceType"));
            addInfoItem(bodyBuilder, "Système d'exploitation", (String) device.get("os"));
            
            // Add open ports if available
            @SuppressWarnings("unchecked")
            List<Integer> openPorts = (List<Integer>) device.get("openPorts");
            if (openPorts != null && !openPorts.isEmpty()) {
                String portsStr = openPorts.stream()
                        .map(String::valueOf)
                        .collect(Collectors.joining(", "));
                addInfoItem(bodyBuilder, "Ports ouverts", portsStr);
            }
            
            bodyBuilder.append("</div>");
        }
        
        bodyBuilder.append("<div class='footer'>");
        bodyBuilder.append("<p>Cet email a été envoyé automatiquement par PatTool.</p>");
        bodyBuilder.append("<p>Scanné le: ").append(escapeHtml(LocalDateTime.now().format(
                DateTimeFormatter.ofPattern("dd-MM-yyyy HH:mm:ss")))).append("</p>");
        bodyBuilder.append("</div>");
        
        bodyBuilder.append("</div>");
        bodyBuilder.append("</div>");
        bodyBuilder.append("</body></html>");
        
        return bodyBuilder.toString();
    }

    /**
     * Add an info item to the email HTML
     */
    private void addInfoItem(StringBuilder builder, String label, String value) {
        if (value == null || value.trim().isEmpty()) {
            value = "N/A";
        }
        builder.append("<div class='info-item'>");
        builder.append("<span class='info-label'>").append(escapeHtml(label)).append(":</span>");
        builder.append("<span class='info-value'>").append(escapeHtml(value)).append("</span>");
        builder.append("</div>");
    }

    /**
     * Escape HTML special characters
     */
    private String escapeHtml(String text) {
        if (text == null) {
            return "";
        }
        return text.replace("&", "&amp;")
                  .replace("<", "&lt;")
                  .replace(">", "&gt;")
                  .replace("\"", "&quot;")
                  .replace("'", "&#39;");
    }

    /**
     * Normalize MAC address for comparison (uppercase, remove separators)
     */
    private String normalizeMacAddress(String macAddress) {
        if (macAddress == null || macAddress.trim().isEmpty()) {
            return "";
        }
        return macAddress.trim().toUpperCase().replaceAll("[:-]", "").replaceAll("\\s", "");
    }
}
