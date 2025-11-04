package com.pat.service;

import com.pat.controller.MailController;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

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

        if (exceptions.isEmpty() && connections.isEmpty()) {
            log.debug("No exceptions or connections to report - skipping email");
            return;
        }

        generateAndSendReport(exceptions, connections, "Daily Report (8:00 AM)");
    }

    /**
     * Manually trigger exception report for the last 24 hours (called from REST endpoint)
     * This does NOT clear the tracked data
     */
    public void sendExceptionReportNow() {
        // Get data from last 24 hours without clearing
        Map<String, List<ExceptionTrackingService.ExceptionInfo>> exceptions = 
            exceptionTrackingService.getExceptionsFromLastHours(24);
        
        Map<String, List<ExceptionTrackingService.ConnectionInfo>> connections = 
            exceptionTrackingService.getConnectionsFromLastHours(24);

        if (exceptions.isEmpty() && connections.isEmpty()) {
            log.debug("No exceptions or connections in last 24 hours to report - skipping email");
            return;
        }

        generateAndSendReport(exceptions, connections, "Manual Report (Last 24 hours)");
    }

    /**
     * Generate and send the exception/connection report email
     * @param exceptions Map of exceptions by IP address
     * @param connections Map of connections by IP address
     * @param reportType Type of report (for subject line)
     */
    private void generateAndSendReport(
            Map<String, List<ExceptionTrackingService.ExceptionInfo>> exceptions,
            Map<String, List<ExceptionTrackingService.ConnectionInfo>> connections,
            String reportType) {
        
        int totalConnections = connections.values().stream().mapToInt(List::size).sum();
        log.info("Preparing {} email for {} exception IP address(es) and {} connection IP address(es)", 
                 reportType, exceptions.size(), connections.size());

        String subject = "Exception & Connection Report - " + reportType + " - " + 
                        (exceptions.size() + connections.size()) + " IP address(es) - " +
                        (exceptions.values().stream().mapToInt(List::size).sum() + totalConnections) + " total events";
        
        StringBuilder bodyBuilder = new StringBuilder();
        bodyBuilder.append("========================================\n");
        bodyBuilder.append("EXCEPTION & CONNECTION REPORT - ").append(reportType).append("\n");
        bodyBuilder.append("Generated at: ").append(java.time.LocalDateTime.now()).append("\n");
        bodyBuilder.append("========================================\n\n");

        // Collect all unique IP addresses from both exceptions and connections
        Set<String> allIpAddresses = new HashSet<>();
        allIpAddresses.addAll(exceptions.keySet());
        allIpAddresses.addAll(connections.keySet());

        int totalExceptions = 0;
        int totalConnectionEvents = 0;

        // Process each IP address
        for (String ipAddress : allIpAddresses) {
            List<ExceptionTrackingService.ExceptionInfo> exceptionList = exceptions.getOrDefault(ipAddress, List.of());
            List<ExceptionTrackingService.ConnectionInfo> connectionList = connections.getOrDefault(ipAddress, List.of());
            
            int exceptionCount = exceptionList.size();
            int connectionCount = connectionList.size();
            totalExceptions += exceptionCount;
            totalConnectionEvents += connectionCount;

            if (exceptionCount == 0 && connectionCount == 0) {
                continue;
            }

            // Lookup IP location and domain name
            IpGeolocationService.IPInfo ipInfo = ipGeolocationService.getCompleteIpInfo(ipAddress);

            bodyBuilder.append("========================================\n");
            bodyBuilder.append("IP ADDRESS: ").append(ipAddress).append("\n");
            if (ipInfo.getDomainName() != null && !ipInfo.getDomainName().isEmpty()) {
                bodyBuilder.append("Domain Name: ").append(ipInfo.getDomainName()).append("\n");
            }
            bodyBuilder.append("Location: ").append(ipInfo.getLocation()).append("\n");
            bodyBuilder.append("Number of exceptions: ").append(exceptionCount).append("\n");
            bodyBuilder.append("Number of connections: ").append(connectionCount).append("\n");
            bodyBuilder.append("========================================\n\n");

            // Report connections first (they're usually more interesting)
            if (connectionCount > 0) {
                bodyBuilder.append("--- USER CONNECTIONS ---\n\n");
                int index = 1;
                for (ExceptionTrackingService.ConnectionInfo info : connectionList) {
                    bodyBuilder.append("Connection #").append(index).append(" (").append(info.isNewUser() ? "NEW USER" : "EXISTING USER").append(")\n");
                    bodyBuilder.append("Timestamp: ").append(info.getTimestamp()).append("\n");
                    bodyBuilder.append("Username: ").append(info.getUsername() != null ? info.getUsername() : "N/A").append("\n");
                    bodyBuilder.append("Full Name: ").append(info.getFirstName() != null ? info.getFirstName() : "").append(" ")
                               .append(info.getLastName() != null ? info.getLastName() : "").append("\n");
                    bodyBuilder.append("Email: ").append(info.getEmail() != null ? info.getEmail() : "N/A").append("\n");
                    bodyBuilder.append("Member ID: ").append(info.getMemberId() != null ? info.getMemberId() : "N/A").append("\n");
                    bodyBuilder.append("Keycloak ID: ").append(info.getKeycloakId() != null ? info.getKeycloakId() : "N/A").append("\n");
                    if (info.getRoles() != null) {
                        bodyBuilder.append("Roles: ").append(info.getRoles()).append("\n");
                    }
                    bodyBuilder.append("Request Method: ").append(info.getRequestMethod() != null ? info.getRequestMethod() : "N/A").append("\n");
                    bodyBuilder.append("Request URI: ").append(info.getRequestUri() != null ? info.getRequestUri() : "N/A").append("\n");
                    if (info.getUserAgent() != null) {
                        bodyBuilder.append("User-Agent: ").append(info.getUserAgent()).append("\n");
                    }
                    if (info.getReferer() != null) {
                        bodyBuilder.append("Referer: ").append(info.getReferer()).append("\n");
                    }
                    bodyBuilder.append("\n");
                    index++;
                }
                bodyBuilder.append("\n");
            }

            // Then report exceptions
            if (exceptionCount > 0) {
                bodyBuilder.append("--- EXCEPTIONS ---\n\n");
                int index = 1;
                for (ExceptionTrackingService.ExceptionInfo info : exceptionList) {
                    bodyBuilder.append("Exception #").append(index).append("\n");
                    bodyBuilder.append("Timestamp: ").append(info.getTimestamp()).append("\n");
                    bodyBuilder.append("Type: ").append(info.getExceptionType()).append("\n");
                    bodyBuilder.append("Message: ").append(info.getMessage() != null ? info.getMessage() : "N/A").append("\n");
                    bodyBuilder.append("Request Method: ").append(info.getRequestMethod() != null ? info.getRequestMethod() : "N/A").append("\n");
                    bodyBuilder.append("Request URI: ").append(info.getRequestUri() != null ? info.getRequestUri() : "N/A").append("\n");
                    
                    if (info.getStackTrace() != null && !info.getStackTrace().isEmpty()) {
                        bodyBuilder.append("Stack Trace:\n").append(info.getStackTrace()).append("\n");
                    }
                    
                    bodyBuilder.append("\n");
                    index++;
                }
                bodyBuilder.append("\n");
            }
        }

        bodyBuilder.append("========================================\n");
        bodyBuilder.append("SUMMARY\n");
        bodyBuilder.append("Total IP addresses: ").append(allIpAddresses.size()).append("\n");
        bodyBuilder.append("Total connections: ").append(totalConnectionEvents).append("\n");
        bodyBuilder.append("Total exceptions: ").append(totalExceptions).append("\n");
        bodyBuilder.append("Total events: ").append(totalConnectionEvents + totalExceptions).append("\n");
        bodyBuilder.append("========================================\n");

        String body = bodyBuilder.toString();
        
        log.info("Sending {} email with {} connections and {} exceptions from {} IP addresses", 
                 reportType, totalConnectionEvents, totalExceptions, allIpAddresses.size());
        
        mailController.sendMail(subject, body);
    }
}
