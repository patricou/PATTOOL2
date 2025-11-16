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
     * Simplified version: Only shows user connections (factorized by user) and exceptions (factorized by IP)
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

        // Build user connection summary (factorized by user)
        Map<String, UserConnectionData> userConnectionMap = new LinkedHashMap<>();
        for (Map.Entry<String, List<ExceptionTrackingService.ConnectionInfo>> entry : connections.entrySet()) {
            String ipAddress = entry.getKey();
            List<ExceptionTrackingService.ConnectionInfo> connectionList = entry.getValue();
            if (connectionList == null || connectionList.isEmpty()) {
                continue;
            }

            IpGeolocationService.IPInfo ipInfo = getIpInfo(ipInfoCache, ipAddress);
            String domainName = formatDomainName(ipInfo);
            String location = formatLocation(ipInfo);

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

                UserConnectionData userData = userConnectionMap.computeIfAbsent(
                        normalizedUser,
                        k -> new UserConnectionData(normalizedUser)
                );
                userData.addConnection(ipAddress, domainName, location, timestamp);
            }
        }
        List<UserConnectionData> userConnections = new ArrayList<>(userConnectionMap.values());
        userConnections.sort(Comparator.comparingInt(UserConnectionData::getTotalConnections).reversed());

        // Build exception summary (factorized by IP)
        List<ExceptionIPData> exceptionIPList = new ArrayList<>();
        for (Map.Entry<String, List<ExceptionTrackingService.ExceptionInfo>> entry : exceptions.entrySet()) {
            String ipAddress = entry.getKey();
            List<ExceptionTrackingService.ExceptionInfo> exceptionList = entry.getValue();
            if (exceptionList == null || exceptionList.isEmpty()) {
                continue;
            }

            IpGeolocationService.IPInfo ipInfo = getIpInfo(ipInfoCache, ipAddress);
            String domainName = formatDomainName(ipInfo);
            String location = formatLocation(ipInfo);

            ExceptionIPData exceptionData = new ExceptionIPData(ipAddress, domainName, location);
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
                    exceptionData.addTimestamp(timestamp);
                }
            }
            exceptionIPList.add(exceptionData);
        }
        exceptionIPList.sort(Comparator.comparingInt(ExceptionIPData::getCount).reversed());

        String reportFrom = reportStart != null ? escapeHtml(formatDateTime(reportStart)) : "N/A";
        String reportTo = reportEnd != null ? escapeHtml(formatDateTime(reportEnd)) : "N/A";

        // Create a clear, non-spam subject line
        String subject = "[PatTool] " + reportType + " - " + 
                        totalConnections + " connections, " + totalExceptions + " exceptions";
        
        // Generate simplified HTML email body with anti-spam best practices
        StringBuilder bodyBuilder = new StringBuilder();
        bodyBuilder.append("<!DOCTYPE html>");
        bodyBuilder.append("<html lang='en'>");
        bodyBuilder.append("<head>");
        bodyBuilder.append("<meta charset='UTF-8'>");
        bodyBuilder.append("<meta name='viewport' content='width=device-width, initial-scale=1.0'>");
        bodyBuilder.append("<meta http-equiv='Content-Type' content='text/html; charset=UTF-8'>");
        bodyBuilder.append("<title>").append(escapeHtml(subject)).append("</title>");
        bodyBuilder.append("<style type='text/css'>");
        // Inline styles for better email client compatibility
        bodyBuilder.append("body { font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.6; color: #333333; background-color: #f5f5f5; margin: 0; padding: 10px; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }");
        bodyBuilder.append(".header { background-color: #667eea; color: #ffffff; padding: 15px; border-radius: 5px; margin-bottom: 15px; }");
        bodyBuilder.append(".header h1 { margin: 0; font-size: 18px; font-weight: bold; }");
        bodyBuilder.append(".section { background-color: #ffffff; margin: 15px 0; padding: 15px; border-radius: 5px; border: 1px solid #e0e0e0; }");
        bodyBuilder.append(".section-header { background-color: #667eea; color: #ffffff; padding: 10px; margin: -15px -15px 15px -15px; border-radius: 5px 5px 0 0; font-weight: bold; }");
        bodyBuilder.append(".connection-section { border-left: 4px solid #28a745; }");
        bodyBuilder.append(".exception-section { border-left: 4px solid #dc3545; }");
        bodyBuilder.append(".info-item { margin: 5px 0; padding: 5px 0; }");
        bodyBuilder.append(".label { font-weight: bold; color: #555555; }");
        bodyBuilder.append(".value { color: #333333; }");
        bodyBuilder.append("table { width: 100%; border-collapse: collapse; margin: 10px 0; max-width: 100%; }");
        bodyBuilder.append("th, td { padding: 8px; border: 1px solid #dddddd; text-align: left; word-wrap: break-word; }");
        bodyBuilder.append("th { background-color: #667eea; color: #ffffff; font-weight: bold; }");
        bodyBuilder.append("tr:nth-child(even) { background-color: #f8f9fa; }");
        bodyBuilder.append(".timestamp { color: #6c757d; font-size: 12px; }");
        bodyBuilder.append("@media only screen and (max-width: 600px) { table { width: 100% !important; } }");
        bodyBuilder.append("</style>");
        bodyBuilder.append("</head>");
        bodyBuilder.append("<body>");
        
        // Header
        bodyBuilder.append("<div class='header'><h1>📊 USER CONNECTIONS & EXCEPTIONS REPORT (Last 7 Days)</h1></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>Type:</span> <span class='value'>").append(escapeHtml(reportType)).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>Generated on:</span> <span class='value'>").append(escapeHtml(formatDateTime(LocalDateTime.now()))).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>Report period:</span> <span class='value'>").append(reportFrom).append(" → ").append(reportTo).append("</span></div>");

        // ========== SECTION 1: USER CONNECTIONS (Factorized by User) ==========
        if (!userConnections.isEmpty()) {
            bodyBuilder.append("<div class='section connection-section'>");
            bodyBuilder.append("<div class='section-header'>🔵 USER CONNECTIONS (Factorized by User)</div>");
            bodyBuilder.append("<table>");
            bodyBuilder.append("<tr>");
            bodyBuilder.append("<th>User</th>");
            bodyBuilder.append("<th>IP</th>");
            bodyBuilder.append("<th>Domain Name</th>");
            bodyBuilder.append("<th>Location</th>");
            bodyBuilder.append("<th>DateTimes</th>");
            bodyBuilder.append("</tr>");
            
            for (UserConnectionData userData : userConnections) {
                for (UserConnectionData.ConnectionEntry entry : userData.getConnections()) {
                    bodyBuilder.append("<tr>");
                    bodyBuilder.append("<td>").append(escapeHtml(userData.getUser())).append("</td>");
                    bodyBuilder.append("<td>").append(escapeHtml(entry.getIp())).append("</td>");
                    bodyBuilder.append("<td>").append(escapeHtml(entry.getDomainName())).append("</td>");
                    bodyBuilder.append("<td>").append(escapeHtml(entry.getLocation())).append("</td>");
                    bodyBuilder.append("<td class='timestamp'>").append(entry.formatTimestamps(this::formatDateTime, this::escapeHtml)).append("</td>");
                    bodyBuilder.append("</tr>");
                }
            }
            bodyBuilder.append("</table>");
            bodyBuilder.append("</div>");
        }

        // ========== SECTION 2: EXCEPTIONS (Factorized by IP) ==========
        if (!exceptionIPList.isEmpty()) {
            bodyBuilder.append("<div class='section exception-section'>");
            bodyBuilder.append("<div class='section-header'>🔴 EXCEPTIONS (Factorized by IP)</div>");
            bodyBuilder.append("<table>");
            bodyBuilder.append("<tr>");
            bodyBuilder.append("<th>IP</th>");
            bodyBuilder.append("<th>Domain Name</th>");
            bodyBuilder.append("<th>Location</th>");
            bodyBuilder.append("<th>DateTimes</th>");
            bodyBuilder.append("<th>Count</th>");
            bodyBuilder.append("</tr>");
            
            for (ExceptionIPData exceptionData : exceptionIPList) {
                bodyBuilder.append("<tr>");
                bodyBuilder.append("<td>").append(escapeHtml(exceptionData.getIp())).append("</td>");
                bodyBuilder.append("<td>").append(escapeHtml(exceptionData.getDomainName())).append("</td>");
                bodyBuilder.append("<td>").append(escapeHtml(exceptionData.getLocation())).append("</td>");
                bodyBuilder.append("<td class='timestamp'>").append(exceptionData.formatTimestamps(this::formatDateTime, this::escapeHtml)).append("</td>");
                bodyBuilder.append("<td>").append(exceptionData.getCount()).append("</td>");
                bodyBuilder.append("</tr>");
            }
            bodyBuilder.append("</table>");
            bodyBuilder.append("</div>");
        }

        // Add footer with proper email etiquette
        bodyBuilder.append("<div style='margin-top: 20px; padding: 15px; background-color: #f8f9fa; border-top: 2px solid #e0e0e0; font-size: 12px; color: #666666;'>");
        bodyBuilder.append("<p style='margin: 5px 0;'>This is an automated system report from PatTool Application.</p>");
        bodyBuilder.append("<p style='margin: 5px 0;'>Report generated automatically on ").append(escapeHtml(formatDateTime(LocalDateTime.now()))).append("</p>");
        bodyBuilder.append("<p style='margin: 5px 0;'>This email contains system monitoring information for the last 7 days.</p>");
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
}
