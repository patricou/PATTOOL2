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
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Scheduled task to send exception reports via email daily at 8:00 AM
 */
@Service
public class ExceptionReportScheduler {

    private static final Logger log = LoggerFactory.getLogger(ExceptionReportScheduler.class);
    private static final int MAX_DETAIL_LINES = 500;

    @Autowired
    private ExceptionTrackingService exceptionTrackingService;

    @Autowired
    private MailController mailController;

    @Autowired
    private IpGeolocationService ipGeolocationService;

    private static final int MANUAL_REPORT_HOURS = 24 * 7; // last 7 days for manual/preview reports

    /**
     * Send exception report email daily at 8:00 AM
     * Cron expression: "0 0 8 * * ?" = every day at 8:00 AM
     * Uses last 7 days data without clearing to ensure manual reports always have 7 days of data
     */
    @Scheduled(cron = "0 0 8 * * ?")
    public void sendExceptionReport() {
        // Get data from last 7 days without clearing (same as manual report)
        // This ensures manual reports always have 7 days of data available
        Map<String, List<ExceptionTrackingService.ExceptionInfo>> exceptions = 
            exceptionTrackingService.getExceptionsFromLastHours(MANUAL_REPORT_HOURS);
        
        Map<String, List<ExceptionTrackingService.ConnectionInfo>> connections = 
            exceptionTrackingService.getConnectionsFromLastHours(MANUAL_REPORT_HOURS);

        Map<String, List<ExceptionTrackingService.LogInfo>> logs = 
            exceptionTrackingService.getLogsFromLastHours(MANUAL_REPORT_HOURS);

        if (exceptions.isEmpty() && connections.isEmpty() && logs.isEmpty()) {
            log.debug("No exceptions or connections to report - skipping email");
            return;
        }

        generateAndSendReport(exceptions, connections, logs, "Daily Report (8:00 AM - Last 7 days)");
    }

    /**
     * Manually trigger exception report for the last 24 hours (called from REST endpoint)
     * This does NOT clear the tracked data
     * @return true if email was sent, false if no data to report
     */
    public boolean sendExceptionReportNow() {
        // Get data from last 24 hours without clearing
        Map<String, List<ExceptionTrackingService.ExceptionInfo>> exceptions = 
            exceptionTrackingService.getExceptionsFromLastHours(MANUAL_REPORT_HOURS);
        
        Map<String, List<ExceptionTrackingService.ConnectionInfo>> connections = 
            exceptionTrackingService.getConnectionsFromLastHours(MANUAL_REPORT_HOURS);

        Map<String, List<ExceptionTrackingService.LogInfo>> logs = 
            exceptionTrackingService.getLogsFromLastHours(MANUAL_REPORT_HOURS);

        if (exceptions.isEmpty() && connections.isEmpty() && logs.isEmpty()) {
            return false;
        }
        
        generateAndSendReport(exceptions, connections, logs, "Manual Report (Last 7 days)");
        return true;
    }

    public Optional<String> buildExceptionReportPreview() {
        Map<String, List<ExceptionTrackingService.ExceptionInfo>> exceptions =
                exceptionTrackingService.getExceptionsFromLastHours(MANUAL_REPORT_HOURS);

        Map<String, List<ExceptionTrackingService.ConnectionInfo>> connections =
                exceptionTrackingService.getConnectionsFromLastHours(MANUAL_REPORT_HOURS);

        Map<String, List<ExceptionTrackingService.LogInfo>> logs =
                exceptionTrackingService.getLogsFromLastHours(MANUAL_REPORT_HOURS);

        if (exceptions.isEmpty() && connections.isEmpty() && logs.isEmpty()) {
            return Optional.empty();
        }

        return Optional.of(buildReport(exceptions, connections, logs, "Manual Report (Last 7 days)").body());
    }

    /**
     * Generate and send the exception/connection report email in HTML format
     * Simplified version: Only shows user connections and IPs with exceptions/connection attempts
     * @param exceptions Map of exceptions by IP address
     * @param connections Map of connections by IP address
     * @param logs Map of log messages by IP address (not used in simplified report)
     * @param reportType Type of report (for subject line)
     */
    private ReportBuildResult buildReport(
            Map<String, List<ExceptionTrackingService.ExceptionInfo>> exceptions,
            Map<String, List<ExceptionTrackingService.ConnectionInfo>> connections,
            Map<String, List<ExceptionTrackingService.LogInfo>> logs,
            String reportType) {
        
        int totalConnections = connections.values().stream().mapToInt(List::size).sum();
        int totalExceptions = exceptions.values().stream().mapToInt(List::size).sum();
        Map<String, IpGeolocationService.IPInfo> ipInfoCache = new HashMap<>();
        LocalDateTime reportStart = null;
        LocalDateTime reportEnd = null;

        // Build user connections list grouped by user, date, and hour
        Map<UserDateHourKey, GroupedUserConnection> groupedConnectionsMap = new LinkedHashMap<>();
        for (Map.Entry<String, List<ExceptionTrackingService.ConnectionInfo>> entry : connections.entrySet()) {
            String ipAddress = entry.getKey();
            List<ExceptionTrackingService.ConnectionInfo> connectionList = entry.getValue();
            if (connectionList == null || connectionList.isEmpty()) {
                continue;
            }

            IpGeolocationService.IPInfo ipInfo = getIpInfo(ipInfoCache, ipAddress);
            String domainName = formatDomainName(ipInfo);
            String location = formatLocation(ipInfo);
            String country = extractCountry(location);

            for (ExceptionTrackingService.ConnectionInfo info : connectionList) {
                if (info == null) {
                    continue;
                }
                LocalDateTime timestamp = info.getTimestamp();
                if (timestamp != null) {
                    if (reportStart == null || timestamp.isBefore(reportStart)) {
                        reportStart = timestamp;
                    }
                    if (reportEnd == null || timestamp.isAfter(reportEnd)) {
                        reportEnd = timestamp;
                    }
                }

                String normalizedUserRaw = normalizeUser(info);
                String normalizedUser = (normalizedUserRaw == null || normalizedUserRaw.isEmpty()) ? "N/A" : normalizedUserRaw;

                // Create key for grouping by user, date, hour, and IP (to separate connections from different IPs)
                UserDateHourKey key = new UserDateHourKey(normalizedUser, ipAddress, timestamp);
                
                // Get or create grouped connection
                GroupedUserConnection groupedConnection = groupedConnectionsMap.computeIfAbsent(
                    key,
                    k -> new GroupedUserConnection(normalizedUser, ipAddress, domainName, location, country, timestamp)
                );
                
                // Add this connection to the group
                groupedConnection.addConnection(timestamp);
            }
        }
        
        // Convert map to sorted list
        List<GroupedUserConnection> userConnectionRows = new ArrayList<>(groupedConnectionsMap.values());
        userConnectionRows.sort(Comparator.comparing(GroupedUserConnection::getFirstTimestamp).reversed());

        // Build IP exception/attempt summary (grouped by IP with count)
        Map<String, IPAttemptData> ipAttemptMap = new LinkedHashMap<>();
        
        // Add exceptions
        for (Map.Entry<String, List<ExceptionTrackingService.ExceptionInfo>> entry : exceptions.entrySet()) {
            String ipAddress = entry.getKey();
            List<ExceptionTrackingService.ExceptionInfo> exceptionList = entry.getValue();
            if (exceptionList == null || exceptionList.isEmpty()) {
                continue;
            }

            IpGeolocationService.IPInfo ipInfo = getIpInfo(ipInfoCache, ipAddress);
            String domainName = formatDomainName(ipInfo);
            String location = formatLocation(ipInfo);
            String country = extractCountry(location);

            IPAttemptData attemptData = ipAttemptMap.computeIfAbsent(
                ipAddress,
                k -> new IPAttemptData(ipAddress, domainName, location, country)
            );

            for (ExceptionTrackingService.ExceptionInfo info : exceptionList) {
                if (info == null) {
                    continue;
                }
                LocalDateTime timestamp = info.getTimestamp();
                if (timestamp != null) {
                    if (reportStart == null || timestamp.isBefore(reportStart)) {
                        reportStart = timestamp;
                    }
                    if (reportEnd == null || timestamp.isAfter(reportEnd)) {
                        reportEnd = timestamp;
                    }
                    attemptData.addTimestamp(timestamp);
                }
            }
        }
        
        // Add connection attempts from logs (IPs that tried to connect but may not have succeeded)
        for (Map.Entry<String, List<ExceptionTrackingService.LogInfo>> entry : logs.entrySet()) {
            String ipAddress = entry.getKey();
            List<ExceptionTrackingService.LogInfo> logList = entry.getValue();
            if (logList == null || logList.isEmpty()) {
                continue;
            }

            IpGeolocationService.IPInfo ipInfo = getIpInfo(ipInfoCache, ipAddress);
            String domainName = formatDomainName(ipInfo);
            String location = formatLocation(ipInfo);
            String country = extractCountry(location);

            IPAttemptData attemptData = ipAttemptMap.computeIfAbsent(
                ipAddress,
                k -> new IPAttemptData(ipAddress, domainName, location, country)
            );

            for (ExceptionTrackingService.LogInfo info : logList) {
                if (info == null) {
                    continue;
                }
                LocalDateTime timestamp = info.getTimestamp();
                if (timestamp != null) {
                    if (reportStart == null || timestamp.isBefore(reportStart)) {
                        reportStart = timestamp;
                    }
                    if (reportEnd == null || timestamp.isAfter(reportEnd)) {
                        reportEnd = timestamp;
                    }
                    attemptData.addTimestamp(timestamp);
                }
            }
        }
        
        List<IPAttemptData> ipAttemptList = new ArrayList<>(ipAttemptMap.values());
        ipAttemptList.sort(Comparator.comparingInt(IPAttemptData::getCount).reversed());

        String reportFrom = reportStart != null ? escapeHtml(formatDateTime(reportStart)) : "N/A";
        String reportTo = reportEnd != null ? escapeHtml(formatDateTime(reportEnd)) : "N/A";

        // Create a clear, non-spam subject line
        String subject = "[PatTool] " + reportType + " - " + 
                        totalConnections + " connections, " + totalExceptions + " exceptions";
        
        // Generate simplified HTML email body
        StringBuilder bodyBuilder = new StringBuilder();
        bodyBuilder.append("<!DOCTYPE html>");
        bodyBuilder.append("<html lang='en'>");
        bodyBuilder.append("<head>");
        bodyBuilder.append("<meta charset='UTF-8'>");
        bodyBuilder.append("<meta name='viewport' content='width=device-width, initial-scale=1.0'>");
        bodyBuilder.append("<meta http-equiv='Content-Type' content='text/html; charset=UTF-8'>");
        bodyBuilder.append("<title>").append(escapeHtml(subject)).append("</title>");
        bodyBuilder.append("<style type='text/css'>");
        bodyBuilder.append("body { font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.6; color: #333333; background-color: #f5f5f5; margin: 0; padding: 10px; }");
        bodyBuilder.append(".header { background-color: #667eea; color: #ffffff; padding: 15px; border-radius: 5px; margin-bottom: 15px; }");
        bodyBuilder.append(".header h1 { margin: 0; font-size: 18px; font-weight: bold; }");
        bodyBuilder.append(".section { background-color: #ffffff; margin: 15px 0; padding: 15px; border-radius: 5px; border: 1px solid #e0e0e0; }");
        bodyBuilder.append(".section-header { background-color: #667eea; color: #ffffff; padding: 10px; margin: -15px -15px 15px -15px; border-radius: 5px 5px 0 0; font-weight: bold; }");
        bodyBuilder.append(".connection-section { border-left: 4px solid #28a745; }");
        bodyBuilder.append(".exception-section { border-left: 4px solid #dc3545; }");
        bodyBuilder.append("table { width: 100%; border-collapse: collapse; margin: 10px 0; }");
        bodyBuilder.append("th, td { padding: 8px; border: 1px solid #dddddd; text-align: left; word-wrap: break-word; }");
        bodyBuilder.append("th { background-color: #667eea; color: #ffffff; font-weight: bold; }");
        bodyBuilder.append("tr:nth-child(even) { background-color: #f8f9fa; }");
        bodyBuilder.append("</style>");
        bodyBuilder.append("</head>");
        bodyBuilder.append("<body>");
        
        // Header
        bodyBuilder.append("<div class='header'><h1>📊 RAPPORT DE CONNEXIONS ET TENTATIVES (7 Derniers Jours)</h1></div>");
        bodyBuilder.append("<div style='margin: 10px 0;'><strong>Type:</strong> ").append(escapeHtml(reportType)).append("</div>");
        bodyBuilder.append("<div style='margin: 10px 0;'><strong>Généré le:</strong> ").append(escapeHtml(formatDateTime(LocalDateTime.now()))).append("</div>");
        bodyBuilder.append("<div style='margin: 10px 0;'><strong>Période:</strong> ").append(reportFrom).append(" → ").append(reportTo).append("</div>");

        // ========== SECTION 1: USER CONNECTIONS ==========
        if (!userConnectionRows.isEmpty()) {
            bodyBuilder.append("<div class='section connection-section'>");
            bodyBuilder.append("<div class='section-header'>🔵 UTILISATEURS CONNECTÉS (7 Derniers Jours)</div>");
            bodyBuilder.append("<table>");
            bodyBuilder.append("<tr>");
            bodyBuilder.append("<th>Utilisateur</th>");
            bodyBuilder.append("<th>Date/Heure</th>");
            bodyBuilder.append("<th>Nombre</th>");
            bodyBuilder.append("<th>IP</th>");
            bodyBuilder.append("<th>Local</th>");
            bodyBuilder.append("<th>Domaine</th>");
            bodyBuilder.append("<th>Pays</th>");
            bodyBuilder.append("</tr>");
            
            for (GroupedUserConnection row : userConnectionRows) {
                bodyBuilder.append("<tr>");
                bodyBuilder.append("<td>").append(escapeHtml(row.getUser())).append("</td>");
                bodyBuilder.append("<td>").append(escapeHtml(row.formatDateHour())).append("</td>");
                bodyBuilder.append("<td><strong>").append(row.getConnectionCount()).append("</strong></td>");
                bodyBuilder.append("<td>").append(escapeHtml(row.getIp())).append("</td>");
                bodyBuilder.append("<td>").append(escapeHtml(row.getLocation())).append("</td>");
                bodyBuilder.append("<td>").append(escapeHtml(row.getDomain())).append("</td>");
                bodyBuilder.append("<td>").append(escapeHtml(row.getCountry())).append("</td>");
                bodyBuilder.append("</tr>");
            }
            bodyBuilder.append("</table>");
            bodyBuilder.append("</div>");
        }

        // ========== SECTION 2: IP ATTEMPTS/EXCEPTIONS ==========
        if (!ipAttemptList.isEmpty()) {
            bodyBuilder.append("<div class='section exception-section'>");
            bodyBuilder.append("<div class='section-header'>🔴 IPs AVEC TENTATIVES/CONNEXIONS OU EXCEPTIONS</div>");
            bodyBuilder.append("<table>");
            bodyBuilder.append("<tr>");
            bodyBuilder.append("<th>Date</th>");
            bodyBuilder.append("<th>IP</th>");
            bodyBuilder.append("<th>Local</th>");
            bodyBuilder.append("<th>Pays</th>");
            bodyBuilder.append("<th>Domaine</th>");
            bodyBuilder.append("<th>Date/Heure</th>");
            bodyBuilder.append("<th>Nombre</th>");
            bodyBuilder.append("</tr>");
            
            for (IPAttemptData attemptData : ipAttemptList) {
                String firstDate = attemptData.getFirstDate();
                String allTimestamps = attemptData.formatTimestamps(this::formatDateTime, this::escapeHtml);
                bodyBuilder.append("<tr>");
                bodyBuilder.append("<td>").append(escapeHtml(firstDate)).append("</td>");
                bodyBuilder.append("<td>").append(escapeHtml(attemptData.getIp())).append("</td>");
                bodyBuilder.append("<td>").append(escapeHtml(attemptData.getLocation())).append("</td>");
                bodyBuilder.append("<td>").append(escapeHtml(attemptData.getCountry())).append("</td>");
                bodyBuilder.append("<td>").append(escapeHtml(attemptData.getDomain())).append("</td>");
                bodyBuilder.append("<td>").append(allTimestamps).append("</td>");
                bodyBuilder.append("<td>").append(attemptData.getCount()).append("</td>");
                bodyBuilder.append("</tr>");
            }
            bodyBuilder.append("</table>");
            bodyBuilder.append("</div>");
        }

        // Footer
        bodyBuilder.append("<div style='margin-top: 20px; padding: 15px; background-color: #f8f9fa; border-top: 2px solid #e0e0e0; font-size: 12px; color: #666666;'>");
        bodyBuilder.append("<p style='margin: 5px 0;'>Rapport automatique généré par l'application PatTool.</p>");
        bodyBuilder.append("</div>");

        bodyBuilder.append("</body></html>");
        String body = bodyBuilder.toString();
        return new ReportBuildResult(subject, body);
    }

    private void generateAndSendReport(
            Map<String, List<ExceptionTrackingService.ExceptionInfo>> exceptions,
            Map<String, List<ExceptionTrackingService.ConnectionInfo>> connections,
            Map<String, List<ExceptionTrackingService.LogInfo>> logs,
            String reportType) {
        ReportBuildResult result = buildReport(exceptions, connections, logs, reportType);
        try {
            mailController.sendMail(result.subject(), result.body(), true); // true = HTML format
        } catch (Exception e) {
            log.error("Failed to send email for report type {}: {}", reportType, e.getMessage(), e);
            throw e;
        }
    }

    private static class ReportBuildResult {
        private final String subject;
        private final String body;

        ReportBuildResult(String subject, String body) {
            this.subject = subject;
            this.body = body;
        }

        public String subject() {
            return subject;
        }

        public String body() {
            return body;
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

    private IpGeolocationService.IPInfo getIpInfo(Map<String, IpGeolocationService.IPInfo> cache, String ipAddress) {
        if (ipAddress == null) {
            return new IpGeolocationService.IPInfo("N/A", "N/A", "N/A");
        }
        return cache.computeIfAbsent(ipAddress, ip -> {
            IpGeolocationService.IPInfo info = ipGeolocationService.getCompleteIpInfo(ip);
            if (info == null) {
                return new IpGeolocationService.IPInfo(ip, "N/A", "N/A");
            }
            return info;
        });
    }

    private String formatDomainName(IpGeolocationService.IPInfo ipInfo) {
        if (ipInfo == null || ipInfo.getDomainName() == null || ipInfo.getDomainName().trim().isEmpty()) {
            return "N/A";
        }
        return ipInfo.getDomainName().trim();
    }

    private String formatLocation(IpGeolocationService.IPInfo ipInfo) {
        if (ipInfo == null || ipInfo.getLocation() == null || ipInfo.getLocation().trim().isEmpty()) {
            return "N/A";
        }
        return ipInfo.getLocation().trim();
    }

    /**
     * Extract country from location string (format: "City, Region, Country" or "Country")
     */
    private String extractCountry(String location) {
        if (location == null || location.trim().isEmpty() || "N/A".equals(location)) {
            return "N/A";
        }
        // Location format is typically "City, Region, Country" or "Country"
        // Try to extract the last part after the last comma
        int lastComma = location.lastIndexOf(',');
        if (lastComma > 0 && lastComma < location.length() - 1) {
            String country = location.substring(lastComma + 1).trim();
            // Remove any parentheses content (like ISP info)
            int parenIndex = country.indexOf('(');
            if (parenIndex > 0) {
                country = country.substring(0, parenIndex).trim();
            }
            return country.isEmpty() ? location : country;
        }
        // If no comma, assume the whole string is the country
        int parenIndex = location.indexOf('(');
        if (parenIndex > 0) {
            return location.substring(0, parenIndex).trim();
        }
        return location;
    }

    /**
     * Format date only (without time)
     */
    private String formatDate(LocalDateTime dateTime) {
        if (dateTime == null) {
            return "N/A";
        }
        DateTimeFormatter formatter = DateTimeFormatter.ofPattern("dd-MM-yyyy");
        return dateTime.format(formatter);
    }

    private String normalizeUser(ExceptionTrackingService.ConnectionInfo info) {
        if (info == null) {
            return null;
        }
        if (info.getUsername() != null && !info.getUsername().trim().isEmpty()) {
            return info.getUsername().trim();
        }
        if (info.getEmail() != null && !info.getEmail().trim().isEmpty()) {
            return info.getEmail().trim();
        }
        StringBuilder fullNameBuilder = new StringBuilder();
        if (info.getFirstName() != null && !info.getFirstName().trim().isEmpty()) {
            fullNameBuilder.append(info.getFirstName().trim());
        }
        if (info.getLastName() != null && !info.getLastName().trim().isEmpty()) {
            if (fullNameBuilder.length() > 0) {
                fullNameBuilder.append(" ");
            }
            fullNameBuilder.append(info.getLastName().trim());
        }
        if (fullNameBuilder.length() > 0) {
            return fullNameBuilder.toString();
        }
        if (info.getMemberId() != null && !info.getMemberId().trim().isEmpty()) {
            return info.getMemberId().trim();
        }
        return null;
    }

    private static String buildFullName(String firstName, String lastName) {
        StringBuilder builder = new StringBuilder();
        if (firstName != null && !firstName.trim().isEmpty()) {
            builder.append(firstName.trim());
        }
        if (lastName != null && !lastName.trim().isEmpty()) {
            if (builder.length() > 0) {
                builder.append(" ");
            }
            builder.append(lastName.trim());
        }
        return builder.toString();
    }

    private static String valueOrNA(String value) {
        return value != null && !value.trim().isEmpty() ? value.trim() : "N/A";
    }

    private static String sanitizeNullable(String value) {
        return value != null ? value.trim() : "";
    }

    private static final class ConnectionDetailKey {
        private final String username;
        private final String fullName;
        private final String email;
        private final String roles;
        private final boolean newUser;

        private ConnectionDetailKey(String username, String fullName, String email, String roles, boolean newUser) {
            this.username = sanitizeNullable(username);
            this.fullName = sanitizeNullable(fullName);
            this.email = sanitizeNullable(email);
            this.roles = sanitizeNullable(roles);
            this.newUser = newUser;
        }

        static ConnectionDetailKey from(ExceptionTrackingService.ConnectionInfo info) {
            String fullName = buildFullName(info.getFirstName(), info.getLastName());
            return new ConnectionDetailKey(
                    info.getUsername(),
                    fullName,
                    info.getEmail(),
                    info.getRoles(),
                    info.isNewUser()
            );
        }

        String getUsernameDisplay() {
            return valueOrNA(username);
        }

        boolean hasFullName() {
            return !fullName.isEmpty();
        }

        String getFullNameDisplay() {
            return valueOrNA(fullName);
        }

        boolean hasEmail() {
            return !email.isEmpty();
        }

        String getEmailDisplay() {
            return valueOrNA(email);
        }

        boolean hasRoles() {
            return !roles.isEmpty();
        }

        String getRolesDisplay() {
            return valueOrNA(roles);
        }

        boolean isNewUser() {
            return newUser;
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (!(o instanceof ConnectionDetailKey)) return false;
            ConnectionDetailKey that = (ConnectionDetailKey) o;
            return newUser == that.newUser
                    && Objects.equals(username, that.username)
                    && Objects.equals(fullName, that.fullName)
                    && Objects.equals(email, that.email)
                    && Objects.equals(roles, that.roles);
        }

        @Override
        public int hashCode() {
            return Objects.hash(username, fullName, email, roles, newUser);
        }
    }

    private static final class AggregatedConnectionDetail {
        private final ConnectionDetailKey key;
        private final List<LocalDateTime> timestamps = new ArrayList<>();

        AggregatedConnectionDetail(ConnectionDetailKey key) {
            this.key = key;
        }

        void addTimestamp(LocalDateTime timestamp) {
            if (timestamp != null) {
                timestamps.add(timestamp);
            }
        }

        List<LocalDateTime> getTimestamps() {
            return timestamps;
        }

        boolean isNewUser() {
            return key.isNewUser();
        }

        String getUsername() {
            return key.getUsernameDisplay();
        }

        boolean hasFullName() {
            return key.hasFullName();
        }

        String getFullName() {
            return key.getFullNameDisplay();
        }

        boolean hasEmail() {
            return key.hasEmail();
        }

        String getEmail() {
            return key.getEmailDisplay();
        }

        boolean hasRoles() {
            return key.hasRoles();
        }

        String getRoles() {
            return key.getRolesDisplay();
        }

        String formatTimestamps(Function<LocalDateTime, String> formatter, Function<String, String> escaper) {
            if (timestamps.isEmpty()) {
                return "N/A";
            }
            return timestamps.stream()
                    .map(formatter)
                    .map(escaper)
                    .collect(Collectors.joining(", "));
        }
    }

    private static final class ExceptionDetailKey {
        private final String type;
        private final String message;
        private final String logMessage;
        private final String requestMethod;
        private final String requestUri;

        private ExceptionDetailKey(String type, String message, String logMessage, String requestMethod, String requestUri) {
            this.type = sanitizeNullable(type);
            this.message = sanitizeNullable(message);
            this.logMessage = sanitizeNullable(logMessage);
            this.requestMethod = sanitizeNullable(requestMethod);
            this.requestUri = sanitizeNullable(requestUri);
        }

        static ExceptionDetailKey from(ExceptionTrackingService.ExceptionInfo info) {
            return new ExceptionDetailKey(
                    info.getExceptionType(),
                    info.getMessage(),
                    info.getLogMessage(),
                    info.getRequestMethod(),
                    info.getRequestUri()
            );
        }

        String getType() {
            return valueOrNA(type);
        }

        String getMessage() {
            return valueOrNA(message);
        }

        String getLogMessage() {
            return valueOrNA(logMessage);
        }

        String getRequestMethod() {
            return valueOrNA(requestMethod);
        }

        String getRequestUri() {
            return valueOrNA(requestUri);
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (!(o instanceof ExceptionDetailKey)) return false;
            ExceptionDetailKey that = (ExceptionDetailKey) o;
            return Objects.equals(type, that.type)
                    && Objects.equals(message, that.message)
                    && Objects.equals(logMessage, that.logMessage)
                    && Objects.equals(requestMethod, that.requestMethod)
                    && Objects.equals(requestUri, that.requestUri);
        }

        @Override
        public int hashCode() {
            return Objects.hash(type, message, logMessage, requestMethod, requestUri);
        }
    }

    private static final class AggregatedExceptionDetail {
        private final ExceptionDetailKey key;
        private final List<LocalDateTime> timestamps = new ArrayList<>();

        AggregatedExceptionDetail(ExceptionDetailKey key) {
            this.key = key;
        }

        void addTimestamp(LocalDateTime timestamp) {
            if (timestamp != null) {
                timestamps.add(timestamp);
            }
        }

        List<LocalDateTime> getTimestamps() {
            return timestamps;
        }

        String getType() {
            return key.getType();
        }

        String getMessage() {
            return key.getMessage();
        }

        String getLogMessage() {
            return key.getLogMessage();
        }

        String getRequestMethod() {
            return key.getRequestMethod();
        }

        String getRequestUri() {
            return key.getRequestUri();
        }

        String formatTimestamps(Function<LocalDateTime, String> formatter, Function<String, String> escaper) {
            if (timestamps.isEmpty()) {
                return "N/A";
            }
            return timestamps.stream()
                    .map(formatter)
                    .map(escaper)
                    .collect(Collectors.joining(", "));
        }
    }

    private static final class AggregatedLogDetail {
        private final String message;
        private final List<LocalDateTime> timestamps = new ArrayList<>();

        AggregatedLogDetail(String message) {
            this.message = valueOrNA(message);
        }

        void addTimestamp(LocalDateTime timestamp) {
            if (timestamp != null) {
                timestamps.add(timestamp);
            }
        }

        List<LocalDateTime> getTimestamps() {
            return timestamps;
        }

        String getMessage() {
            return message;
        }

        String formatTimestamps(Function<LocalDateTime, String> formatter, Function<String, String> escaper) {
            if (timestamps.isEmpty()) {
                return "N/A";
            }
            return timestamps.stream()
                    .map(formatter)
                    .map(escaper)
                    .collect(Collectors.joining(", "));
        }
    }

    private static class UserConnectionSummary {
        private final String user;
        private int totalCount = 0;
        private final Map<String, IpSummary> ipSummaries = new LinkedHashMap<>();

        UserConnectionSummary(String user) {
            this.user = user;
        }

        public String getUser() {
            return user != null ? user : "N/A";
        }

        public int getTotalCount() {
            return totalCount;
        }

        public void incrementTotalCount() {
            totalCount++;
        }

        public void addIp(String ip, String location, String domainName) {
            String safeIp = (ip != null && !ip.trim().isEmpty()) ? ip.trim() : "N/A";
            IpSummary ipSummary = ipSummaries.computeIfAbsent(safeIp, key -> new IpSummary(safeIp, location, domainName));
            ipSummary.incrementCount();
        }

        public List<IpSummary> getIpSummaries() {
            List<IpSummary> list = new ArrayList<>(ipSummaries.values());
            list.sort(Comparator.comparingInt(IpSummary::getCount).reversed());
            return list;
        }
    }

    private static class IpSummary {
        private final String ip;
        private final String location;
        private final String domainName;
        private int count = 0;

        IpSummary(String ip, String location, String domainName) {
            this.ip = ip;
            this.location = location;
            this.domainName = domainName;
        }

        public void incrementCount() {
            count++;
        }

        public String getIp() {
            return ip != null ? ip : "N/A";
        }

        public String getLocation() {
            return location != null ? location : "N/A";
        }

        public String getDomainName() {
            return domainName != null ? domainName : "N/A";
        }

        public int getCount() {
            return count;
        }
    }

    private static class ExceptionSummary {
        private final String ip;
        private final String location;
        private final String domainName;
        private final int count;

        ExceptionSummary(String ip, String location, String domainName, int count) {
            this.ip = ip;
            this.location = location;
            this.domainName = domainName;
            this.count = count;
        }

        public String getIp() {
            return ip != null ? ip : "N/A";
        }

        public String getLocation() {
            return location != null ? location : "N/A";
        }

        public String getDomainName() {
            return domainName != null ? domainName : "N/A";
        }

        public int getCount() {
            return count;
        }
    }

    /**
     * Data class to hold user connection information (factorized by user)
     */
    private static class UserConnectionData {
        private final String user;
        private final List<ConnectionEntry> connections = new ArrayList<>();

        UserConnectionData(String user) {
            this.user = user;
        }

        public String getUser() {
            return user != null ? user : "N/A";
        }

        public void addConnection(String ip, String domainName, String location, LocalDateTime timestamp) {
            if (ip == null || ip.trim().isEmpty()) {
                return;
            }
            
            // Find existing connection entry for this IP
            ConnectionEntry entry = connections.stream()
                    .filter(e -> e.getIp().equals(ip))
                    .findFirst()
                    .orElse(null);
            
            if (entry == null) {
                entry = new ConnectionEntry(ip, domainName, location);
                connections.add(entry);
            }
            
            if (timestamp != null) {
                entry.addTimestamp(timestamp);
            }
        }

        public List<ConnectionEntry> getConnections() {
            return connections;
        }

        public int getTotalConnections() {
            return connections.stream().mapToInt(ConnectionEntry::getTimestampCount).sum();
        }

        /**
         * Inner class to hold connection entry with IP, domain, location, and timestamps
         */
        private static class ConnectionEntry {
            private final String ip;
            private final String domainName;
            private final String location;
            private final List<LocalDateTime> timestamps = new ArrayList<>();

            ConnectionEntry(String ip, String domainName, String location) {
                this.ip = ip;
                this.domainName = domainName != null ? domainName : "N/A";
                this.location = location != null ? location : "N/A";
            }

            public String getIp() {
                return ip;
            }

            public String getDomainName() {
                return domainName;
            }

            public String getLocation() {
                return location;
            }

            public void addTimestamp(LocalDateTime timestamp) {
                if (timestamp != null) {
                    timestamps.add(timestamp);
                }
            }

            public int getTimestampCount() {
                return timestamps.size();
            }

            public String formatTimestamps(Function<LocalDateTime, String> formatter, Function<String, String> escaper) {
                if (timestamps.isEmpty()) {
                    return "N/A";
                }
                return timestamps.stream()
                        .map(formatter)
                        .map(escaper)
                        .collect(Collectors.joining(", "));
            }
        }
    }

    /**
     * Data class to hold exception information (factorized by IP)
     */
    private static class ExceptionIPData {
        private final String ip;
        private final String domainName;
        private final String location;
        private final List<LocalDateTime> timestamps = new ArrayList<>();

        ExceptionIPData(String ip, String domainName, String location) {
            this.ip = ip;
            this.domainName = domainName != null ? domainName : "N/A";
            this.location = location != null ? location : "N/A";
        }

        public String getIp() {
            return ip != null ? ip : "N/A";
        }

        public String getDomainName() {
            return domainName;
        }

        public String getLocation() {
            return location;
        }

        public void addTimestamp(LocalDateTime timestamp) {
            if (timestamp != null) {
                timestamps.add(timestamp);
            }
        }

        public int getCount() {
            return timestamps.size();
        }

        public String formatTimestamps(Function<LocalDateTime, String> formatter, Function<String, String> escaper) {
            if (timestamps.isEmpty()) {
                return "N/A";
            }
            return timestamps.stream()
                    .map(formatter)
                    .map(escaper)
                    .collect(Collectors.joining(", "));
        }
    }

    /**
     * Data class for user connection row
     */
    private static class UserConnectionRow {
        private final String user;
        private final String ip;
        private final String domain;
        private final String location;
        private final String country;
        private final LocalDateTime timestamp;

        UserConnectionRow(String user, String ip, String domain, String location, String country, LocalDateTime timestamp) {
            this.user = user != null ? user : "N/A";
            this.ip = ip != null ? ip : "N/A";
            this.domain = domain != null ? domain : "N/A";
            this.location = location != null ? location : "N/A";
            this.country = country != null ? country : "N/A";
            this.timestamp = timestamp;
        }

        public String getUser() { return user; }
        public String getIp() { return ip; }
        public String getDomain() { return domain; }
        public String getLocation() { return location; }
        public String getCountry() { return country; }
        public LocalDateTime getTimestamp() { return timestamp; }
    }

    /**
     * Data class for IP attempt/exception data
     */
    private static class IPAttemptData {
        private final String ip;
        private final String domain;
        private final String location;
        private final String country;
        private final List<LocalDateTime> timestamps = new ArrayList<>();

        IPAttemptData(String ip, String domain, String location, String country) {
            this.ip = ip != null ? ip : "N/A";
            this.domain = domain != null ? domain : "N/A";
            this.location = location != null ? location : "N/A";
            this.country = country != null ? country : "N/A";
        }

        public void addTimestamp(LocalDateTime timestamp) {
            if (timestamp != null) {
                timestamps.add(timestamp);
            }
        }

        public String getIp() { return ip; }
        public String getDomain() { return domain; }
        public String getLocation() { return location; }
        public String getCountry() { return country; }
        public int getCount() { return timestamps.size(); }

        public String getFirstDate() {
            if (timestamps.isEmpty()) {
                return "N/A";
            }
            LocalDateTime first = timestamps.stream()
                    .min(Comparator.naturalOrder())
                    .orElse(null);
            if (first == null) {
                return "N/A";
            }
            DateTimeFormatter formatter = DateTimeFormatter.ofPattern("dd-MM-yyyy");
            return first.format(formatter);
        }

        public String formatTimestamps(Function<LocalDateTime, String> formatter, Function<String, String> escaper) {
            if (timestamps.isEmpty()) {
                return "N/A";
            }
            return timestamps.stream()
                    .sorted()
                    .map(formatter)
                    .map(escaper)
                    .collect(Collectors.joining(", "));
        }
    }

    /**
     * Key class for grouping connections by user, IP, date, and hour
     */
    private static class UserDateHourKey {
        private final String user;
        private final String ip;
        private final LocalDateTime dateHour;

        UserDateHourKey(String user, String ip, LocalDateTime timestamp) {
            this.user = user != null ? user : "N/A";
            this.ip = ip != null ? ip : "N/A";
            // Round down to the hour: set minutes, seconds, and nanoseconds to 0
            if (timestamp != null) {
                this.dateHour = timestamp.withMinute(0).withSecond(0).withNano(0);
            } else {
                this.dateHour = null;
            }
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (o == null || getClass() != o.getClass()) return false;
            UserDateHourKey that = (UserDateHourKey) o;
            return Objects.equals(user, that.user) 
                    && Objects.equals(ip, that.ip)
                    && Objects.equals(dateHour, that.dateHour);
        }

        @Override
        public int hashCode() {
            return Objects.hash(user, ip, dateHour);
        }
    }

    /**
     * Data class for grouped user connections by date/hour
     */
    private static class GroupedUserConnection {
        private final String user;
        private final String ip;
        private final String domain;
        private final String location;
        private final String country;
        private final List<LocalDateTime> timestamps = new ArrayList<>();
        private LocalDateTime firstTimestamp;

        GroupedUserConnection(String user, String ip, String domain, String location, String country, LocalDateTime firstTimestamp) {
            this.user = user != null ? user : "N/A";
            this.ip = ip != null ? ip : "N/A";
            this.domain = domain != null ? domain : "N/A";
            this.location = location != null ? location : "N/A";
            this.country = country != null ? country : "N/A";
            if (firstTimestamp != null) {
                this.firstTimestamp = firstTimestamp;
                timestamps.add(firstTimestamp);
            }
        }

        public void addConnection(LocalDateTime timestamp) {
            if (timestamp != null) {
                timestamps.add(timestamp);
                if (firstTimestamp == null || timestamp.isBefore(firstTimestamp)) {
                    firstTimestamp = timestamp;
                }
            }
        }

        public String getUser() {
            return user;
        }

        public String getIp() {
            return ip;
        }

        public String getDomain() {
            return domain;
        }

        public String getLocation() {
            return location;
        }

        public String getCountry() {
            return country;
        }

        public int getConnectionCount() {
            return timestamps.size();
        }

        public LocalDateTime getFirstTimestamp() {
            return firstTimestamp;
        }

        public String formatDateHour() {
            if (firstTimestamp == null) {
                return "N/A";
            }
            // Format as: dd-MM-yyyy HH:00 (rounded down to the hour)
            LocalDateTime rounded = firstTimestamp.withMinute(0).withSecond(0).withNano(0);
            DateTimeFormatter formatter = DateTimeFormatter.ofPattern("dd-MM-yyyy HH:mm");
            return rounded.format(formatter);
        }
    }
}
