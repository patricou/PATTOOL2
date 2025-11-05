package com.pat.service;

import com.pat.controller.MailController;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.HashSet;

/**
 * Scheduled task to send exception reports via email daily at 8:00 AM
 */
@Service
public class ExceptionReportScheduler {

    private static final Logger log = LoggerFactory.getLogger(ExceptionReportScheduler.class);

    @Autowired
    private ExceptionTrackingService exceptionTrackingService;

    @Autowired
    private MailController mailController;

    @Autowired
    private IpGeolocationService ipGeolocationService;

    /**
     * Send exception report email daily at 8:00 AM
     * Cron expression: "0 0 8 * * ?" = every day at 8:00 AM
     */
    @Scheduled(cron = "0 0 8 * * ?")
    public void sendExceptionReport() {
        // Get all tracked data and clear (scheduled daily report)
        Map<String, List<ExceptionTrackingService.ExceptionInfo>> exceptions = 
            exceptionTrackingService.getAndClearExceptions();
        
        Map<String, List<ExceptionTrackingService.ConnectionInfo>> connections = 
            exceptionTrackingService.getAndClearConnections();

        // For daily report, get logs without clearing (they're cleared daily in logs)
        Map<String, List<ExceptionTrackingService.LogInfo>> logs = 
            exceptionTrackingService.getLogsFromLastHours(24);

        if (exceptions.isEmpty() && connections.isEmpty() && logs.isEmpty()) {
            log.debug("No exceptions or connections to report - skipping email");
            return;
        }

        generateAndSendReport(exceptions, connections, logs, "Daily Report (8:00 AM)");
    }

    /**
     * Manually trigger exception report for the last 24 hours (called from REST endpoint)
     * This does NOT clear the tracked data
     * @return true if email was sent, false if no data to report
     */
    public boolean sendExceptionReportNow() {
        // Get data from last 24 hours without clearing
        Map<String, List<ExceptionTrackingService.ExceptionInfo>> exceptions = 
            exceptionTrackingService.getExceptionsFromLastHours(24);
        
        Map<String, List<ExceptionTrackingService.ConnectionInfo>> connections = 
            exceptionTrackingService.getConnectionsFromLastHours(24);

        Map<String, List<ExceptionTrackingService.LogInfo>> logs = 
            exceptionTrackingService.getLogsFromLastHours(24);

        if (exceptions.isEmpty() && connections.isEmpty() && logs.isEmpty()) {
            return false;
        }
        
        generateAndSendReport(exceptions, connections, logs, "Manual Report (Last 24 hours)");
        return true;
    }

    /**
     * Generate and send the exception/connection report email in HTML format
     * @param exceptions Map of exceptions by IP address
     * @param connections Map of connections by IP address
     * @param logs Map of log messages by IP address
     * @param reportType Type of report (for subject line)
     */
    private void generateAndSendReport(
            Map<String, List<ExceptionTrackingService.ExceptionInfo>> exceptions,
            Map<String, List<ExceptionTrackingService.ConnectionInfo>> connections,
            Map<String, List<ExceptionTrackingService.LogInfo>> logs,
            String reportType) {
        
        int totalConnections = connections.values().stream().mapToInt(List::size).sum();
        int totalExceptions = exceptions.values().stream().mapToInt(List::size).sum();
        int totalLogs = logs.values().stream().mapToInt(List::size).sum();

        String subject = "Exception & Connection Report - " + reportType + " - " + 
                        totalConnections + " connections, " + totalExceptions + " exceptions";
        
        // Generate HTML email body with colors
        StringBuilder bodyBuilder = new StringBuilder();
        bodyBuilder.append("<!DOCTYPE html><html><head><meta charset='UTF-8'>");
        bodyBuilder.append("<style>");
        bodyBuilder.append("body { font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333; background-color: #f5f5f5; margin: 0; padding: 10px; }");
        bodyBuilder.append(".header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px; border-radius: 5px; margin-bottom: 15px; }");
        bodyBuilder.append(".header h1 { margin: 0; font-size: 18px; }");
        bodyBuilder.append(".section { background: white; margin: 15px 0; padding: 15px; border-radius: 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }");
        bodyBuilder.append(".section-header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 10px; margin: -15px -15px 15px -15px; border-radius: 5px 5px 0 0; font-weight: bold; }");
        bodyBuilder.append(".connection-section { border-left: 4px solid #28a745; }");
        bodyBuilder.append(".exception-section { border-left: 4px solid #dc3545; }");
        bodyBuilder.append(".log-section { border-left: 4px solid #ffc107; }");
        bodyBuilder.append(".ip-block { background: #f8f9fa; padding: 10px; margin: 10px 0; border-radius: 5px; border-left: 3px solid #007bff; }");
        bodyBuilder.append(".ip-header { font-weight: bold; color: #007bff; font-size: 16px; margin-bottom: 8px; }");
        bodyBuilder.append(".info-item { margin: 5px 0; padding: 5px 0; }");
        bodyBuilder.append(".label { font-weight: bold; color: #555; }");
        bodyBuilder.append(".value { color: #333; }");
        bodyBuilder.append(".new-user { background: #d4edda; color: #155724; padding: 2px 6px; border-radius: 3px; font-size: 12px; }");
        bodyBuilder.append(".summary { background: #e9ecef; padding: 15px; border-radius: 5px; margin-top: 20px; }");
        bodyBuilder.append(".summary-item { margin: 5px 0; }");
        bodyBuilder.append("table { width: 100%; border-collapse: collapse; margin: 10px 0; }");
        bodyBuilder.append("td { padding: 8px; border-bottom: 1px solid #ddd; }");
        bodyBuilder.append(".timestamp { color: #6c757d; font-size: 12px; }");
        bodyBuilder.append(".connection-item { background: #f8f9fa; padding: 10px; margin: 8px 0; border-radius: 4px; border-left: 3px solid #28a745; }");
        bodyBuilder.append(".exception-item { background: #fff5f5; padding: 10px; margin: 8px 0; border-radius: 4px; border-left: 3px solid #dc3545; }");
        bodyBuilder.append(".log-item { background: #fffbf0; padding: 10px; margin: 8px 0; border-radius: 4px; border-left: 3px solid #ffc107; }");
        bodyBuilder.append(".ip-highlight { color: #007bff; font-weight: bold !important; font-size: 15px; background: #e7f3ff; padding: 4px 8px; border-radius: 4px; display: inline-block; }");
        bodyBuilder.append(".domain-highlight { color: #28a745; font-weight: bold !important; font-size: 15px; background: #d4edda; padding: 4px 8px; border-radius: 4px; display: inline-block; }");
        bodyBuilder.append(".location-highlight { color: #dc3545; font-weight: bold !important; font-size: 15px; background: #f8d7da; padding: 4px 8px; border-radius: 4px; display: inline-block; }");
        bodyBuilder.append("</style></head><body>");
        
        // Header
        bodyBuilder.append("<div class='header'><h1>📊 RAPPORT D'EXCEPTIONS ET DE CONNEXIONS UTILISATEURS</h1></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>Type:</span> <span class='value'>").append(escapeHtml(reportType)).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>Genere le:</span> <span class='value'>").append(escapeHtml(formatDateTime(LocalDateTime.now()))).append("</span></div>");
        bodyBuilder.append("<div class='summary'><div class='summary-item'><span class='label'>Total connexions:</span> <span style='color: #28a745; font-weight: bold;'>").append(totalConnections).append("</span></div>");
        bodyBuilder.append("<div class='summary-item'><span class='label'>Total exceptions:</span> <span style='color: #dc3545; font-weight: bold;'>").append(totalExceptions).append("</span></div>");
        bodyBuilder.append("<div class='summary-item'><span class='label'>Total logs:</span> <span style='color: #ffc107; font-weight: bold;'>").append(totalLogs).append("</span></div></div>");

        // ========== SECTION 1: CONNEXIONS UTILISATEURS ==========
        if (totalConnections > 0) {
            bodyBuilder.append("<div class='section connection-section'>");
            bodyBuilder.append("<div class='section-header'>🔵 CONNEXIONS UTILISATEURS</div>");

            Set<String> connectionIpAddresses = new HashSet<>(connections.keySet());
            
            for (String ipAddress : connectionIpAddresses) {
                List<ExceptionTrackingService.ConnectionInfo> connectionList = connections.get(ipAddress);
                if (connectionList == null || connectionList.isEmpty()) {
                continue;
            }

            IpGeolocationService.IPInfo ipInfo = ipGeolocationService.getCompleteIpInfo(ipAddress);

                bodyBuilder.append("<div class='ip-block'>");
                bodyBuilder.append("<div class='ip-header'>📍 IP: ").append(escapeHtml(ipAddress)).append("</div>");
                bodyBuilder.append("<div class='info-item'><span class='label'>Domain Name:</span> <span class='value'>").append(escapeHtml(ipInfo.getDomainName() != null && !ipInfo.getDomainName().isEmpty() ? ipInfo.getDomainName() : "N/A")).append("</span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'>Location:</span> <span class='value'>").append(escapeHtml(ipInfo.getLocation())).append("</span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'>Nombre de connexions:</span> <span style='color: #28a745; font-weight: bold;'>").append(connectionList.size()).append("</span></div>");
                bodyBuilder.append("</div>");

                int index = 1;
                for (ExceptionTrackingService.ConnectionInfo info : connectionList) {
                    bodyBuilder.append("<div class='connection-item'>");
                    bodyBuilder.append("<strong>Connexion #").append(index);
                    if (info.isNewUser()) {
                        bodyBuilder.append(" <span class='new-user'>NOUVEAU UTILISATEUR</span>");
                    }
                    bodyBuilder.append("</strong><br>");
                    bodyBuilder.append("<div class='timestamp'>Date/Heure: ").append(escapeHtml(formatDateTime(info.getTimestamp()))).append("</div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>IP:</strong></span> <span class='value'><span class='ip-highlight'>").append(escapeHtml(ipAddress)).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>Domain Name:</strong></span> <span class='value'><span class='domain-highlight'>").append(escapeHtml(ipInfo.getDomainName() != null && !ipInfo.getDomainName().isEmpty() ? ipInfo.getDomainName() : "N/A")).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>Location:</strong></span> <span class='value'><span class='location-highlight'>").append(escapeHtml(ipInfo.getLocation())).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'>Utilisateur:</span> <span class='value'>").append(escapeHtml(info.getUsername() != null ? info.getUsername() : "N/A")).append("</span></div>");
                    
                    String fullName = "";
                    if (info.getFirstName() != null && !info.getFirstName().trim().isEmpty()) {
                        fullName = info.getFirstName().trim();
                    }
                    if (info.getLastName() != null && !info.getLastName().trim().isEmpty()) {
                        if (!fullName.isEmpty()) fullName += " ";
                        fullName += info.getLastName().trim();
                    }
                    if (!fullName.isEmpty()) {
                        bodyBuilder.append("<div class='info-item'><span class='label'>Nom complet:</span> <span class='value'>").append(escapeHtml(fullName)).append("</span></div>");
                    }
                    
                    if (info.getEmail() != null && !info.getEmail().isEmpty()) {
                        bodyBuilder.append("<div class='info-item'><span class='label'>Email:</span> <span class='value'>").append(escapeHtml(info.getEmail())).append("</span></div>");
                    }
                    if (info.getRoles() != null && !info.getRoles().isEmpty()) {
                        bodyBuilder.append("<div class='info-item'><span class='label'>Rôles:</span> <span class='value'>").append(escapeHtml(info.getRoles())).append("</span></div>");
                    }
                    bodyBuilder.append("</div>");
                    index++;
                }
            }
            bodyBuilder.append("</div>");
        }

        // ========== SECTION 2: EXCEPTIONS ==========
        if (totalExceptions > 0) {
            bodyBuilder.append("<div class='section exception-section'>");
            bodyBuilder.append("<div class='section-header'>🔴 EXCEPTIONS</div>");

            Set<String> exceptionIpAddresses = new HashSet<>(exceptions.keySet());
            
            // Liste des IPs avec exceptions
            if (!exceptionIpAddresses.isEmpty()) {
                bodyBuilder.append("<div style='background: #fff5f5; padding: 10px; margin: 10px 0; border-radius: 4px;'><strong>--- IPs avec exceptions ---</strong></div>");
                for (String ipAddress : exceptionIpAddresses) {
                    IpGeolocationService.IPInfo ipInfo = ipGeolocationService.getCompleteIpInfo(ipAddress);
                    int exceptionCount = exceptions.getOrDefault(ipAddress, List.of()).size();
                    
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>IP:</strong></span> <span class='value'><span class='ip-highlight'>").append(escapeHtml(ipAddress)).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>Domain Name:</strong></span> <span class='value'><span class='domain-highlight'>").append(escapeHtml(ipInfo.getDomainName() != null && !ipInfo.getDomainName().isEmpty() ? ipInfo.getDomainName() : "N/A")).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>Location:</strong></span> <span class='value'><span class='location-highlight'>").append(escapeHtml(ipInfo.getLocation())).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'>Nombre d'exceptions:</span> <span style='color: #dc3545; font-weight: bold;'>").append(exceptionCount).append("</span></div><br>");
                }
            }
            
            // Détails des exceptions
            for (String ipAddress : exceptionIpAddresses) {
                List<ExceptionTrackingService.ExceptionInfo> exceptionList = exceptions.get(ipAddress);
                if (exceptionList == null || exceptionList.isEmpty()) {
                    continue;
                }

                IpGeolocationService.IPInfo ipInfo = ipGeolocationService.getCompleteIpInfo(ipAddress);

                bodyBuilder.append("<div class='ip-block'>");
                bodyBuilder.append("<div class='ip-header'>📍 <strong>IP:</strong> <span class='ip-highlight'>").append(escapeHtml(ipAddress)).append("</span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'><strong>Domain Name:</strong></span> <span class='value'><span class='domain-highlight'>").append(escapeHtml(ipInfo.getDomainName() != null && !ipInfo.getDomainName().isEmpty() ? ipInfo.getDomainName() : "N/A")).append("</span></span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'><strong>Location:</strong></span> <span class='value'><span class='location-highlight'>").append(escapeHtml(ipInfo.getLocation())).append("</span></span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'>Nombre d'exceptions:</span> <span style='color: #dc3545; font-weight: bold;'>").append(exceptionList.size()).append("</span></div>");
                bodyBuilder.append("</div>");

                int index = 1;
                for (ExceptionTrackingService.ExceptionInfo info : exceptionList) {
                    bodyBuilder.append("<div class='exception-item'>");
                    bodyBuilder.append("<strong>Exception #").append(index).append("</strong><br>");
                    bodyBuilder.append("<div class='timestamp'>Date/Heure: ").append(escapeHtml(formatDateTime(info.getTimestamp()))).append("</div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'>Type:</span> <span class='value' style='color: #dc3545;'>").append(escapeHtml(info.getExceptionType())).append("</span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'>Message:</span> <span class='value'>").append(escapeHtml(info.getMessage() != null ? info.getMessage() : "N/A")).append("</span></div>");
                    if (info.getLogMessage() != null && !info.getLogMessage().isEmpty()) {
                        bodyBuilder.append("<div class='info-item'><span class='label'>Log:</span> <span class='value'>").append(escapeHtml(info.getLogMessage())).append("</span></div>");
                    }
                    bodyBuilder.append("<div class='info-item'><span class='label'>Méthode:</span> <span class='value'>").append(escapeHtml(info.getRequestMethod() != null ? info.getRequestMethod() : "N/A")).append("</span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'>URI:</span> <span class='value'>").append(escapeHtml(info.getRequestUri() != null ? info.getRequestUri() : "N/A")).append("</span></div>");
                    bodyBuilder.append("</div>");
                    index++;
                }
            }
            bodyBuilder.append("</div>");
        }

        // ========== SECTION 3: LOGS AVEC IP ==========
        if (totalLogs > 0) {
            bodyBuilder.append("<div class='section log-section'>");
            bodyBuilder.append("<div class='section-header'>🟡 LOGS AVEC IP</div>");

            Set<String> logIpAddresses = new HashSet<>(logs.keySet());
            
            // Liste des IPs avec logs
            if (!logIpAddresses.isEmpty()) {
                bodyBuilder.append("<div style='background: #fffbf0; padding: 10px; margin: 10px 0; border-radius: 4px;'><strong>--- IPs avec logs ---</strong></div>");
                for (String ipAddress : logIpAddresses) {
                    IpGeolocationService.IPInfo ipInfo = ipGeolocationService.getCompleteIpInfo(ipAddress);
                    int logCount = logs.getOrDefault(ipAddress, List.of()).size();
                    
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>IP:</strong></span> <span class='value'><span class='ip-highlight'>").append(escapeHtml(ipAddress)).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>Domain Name:</strong></span> <span class='value'><span class='domain-highlight'>").append(escapeHtml(ipInfo.getDomainName() != null && !ipInfo.getDomainName().isEmpty() ? ipInfo.getDomainName() : "N/A")).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>Location:</strong></span> <span class='value'><span class='location-highlight'>").append(escapeHtml(ipInfo.getLocation())).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'>Nombre de logs:</span> <span style='color: #ffc107; font-weight: bold;'>").append(logCount).append("</span></div><br>");
                }
            }
            
            // Détails des logs
            for (String ipAddress : logIpAddresses) {
                List<ExceptionTrackingService.LogInfo> logList = logs.get(ipAddress);
                if (logList == null || logList.isEmpty()) {
                    continue;
                }

                IpGeolocationService.IPInfo ipInfo = ipGeolocationService.getCompleteIpInfo(ipAddress);

                bodyBuilder.append("<div class='ip-block'>");
                bodyBuilder.append("<div class='ip-header'>📍 <strong>IP:</strong> <span class='ip-highlight'>").append(escapeHtml(ipAddress)).append("</span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'><strong>Domain Name:</strong></span> <span class='value'><span class='domain-highlight'>").append(escapeHtml(ipInfo.getDomainName() != null && !ipInfo.getDomainName().isEmpty() ? ipInfo.getDomainName() : "N/A")).append("</span></span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'><strong>Location:</strong></span> <span class='value'><span class='location-highlight'>").append(escapeHtml(ipInfo.getLocation())).append("</span></span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'>Nombre de logs:</span> <span style='color: #ffc107; font-weight: bold;'>").append(logList.size()).append("</span></div>");
                bodyBuilder.append("</div>");

                int index = 1;
                for (ExceptionTrackingService.LogInfo info : logList) {
                    bodyBuilder.append("<div class='log-item'>");
                    bodyBuilder.append("<strong>Log #").append(index).append("</strong><br>");
                    bodyBuilder.append("<div class='timestamp'>Date/Heure: ").append(escapeHtml(formatDateTime(info.getTimestamp()))).append("</div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'>Message:</span> <span class='value'>").append(escapeHtml(info.getLogMessage() != null ? info.getLogMessage() : "N/A")).append("</span></div>");
                    bodyBuilder.append("</div>");
                    index++;
                }
            }
            bodyBuilder.append("</div>");
        }

        // ========== SUMMARY ==========
        Set<String> allIpAddresses = new HashSet<>();
        allIpAddresses.addAll(connections.keySet());
        allIpAddresses.addAll(exceptions.keySet());
        allIpAddresses.addAll(logs.keySet());
        
        bodyBuilder.append("<div class='summary'>");
        bodyBuilder.append("<div class='section-header' style='margin: -15px -15px 15px -15px; border-radius: 5px 5px 0 0;'>📋 RESUME</div>");
        bodyBuilder.append("<div class='summary-item'><span class='label'>Adresses IP uniques:</span> <span style='font-weight: bold; color: #007bff;'>").append(allIpAddresses.size()).append("</span></div>");
        bodyBuilder.append("<div class='summary-item'><span class='label'>Total connexions:</span> <span style='color: #28a745; font-weight: bold;'>").append(totalConnections).append("</span></div>");
        bodyBuilder.append("<div class='summary-item'><span class='label'>Total exceptions:</span> <span style='color: #dc3545; font-weight: bold;'>").append(totalExceptions).append("</span></div>");
        bodyBuilder.append("<div class='summary-item'><span class='label'>Total logs:</span> <span style='color: #ffc107; font-weight: bold;'>").append(totalLogs).append("</span></div>");
        bodyBuilder.append("<div class='summary-item'><span class='label'>Total evenements:</span> <span style='font-weight: bold;'>").append(totalConnections + totalExceptions + totalLogs).append("</span></div>");
        bodyBuilder.append("</div>");

        bodyBuilder.append("</body></html>");
        String body = bodyBuilder.toString();
        
        try {
            mailController.sendMail(subject, body, true); // true = HTML format
        } catch (Exception e) {
            log.error("Failed to send email for report type {}: {}", reportType, e.getMessage(), e);
            throw e;
        }
    }

    /**
     * Format date and time as dd-MM-yyyy hh:mm:ss + zone
     */
    private String formatDateTime(LocalDateTime dateTime) {
        if (dateTime == null) {
            return "N/A";
        }
        ZoneId zoneId = ZoneId.systemDefault();
        String zone = zoneId.toString();
        DateTimeFormatter formatter = DateTimeFormatter.ofPattern("dd-MM-yyyy HH:mm:ss");
        return dateTime.format(formatter) + " +" + zone;
    }

    /**
     * Escape HTML special characters to prevent XSS and ensure proper rendering
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
}
