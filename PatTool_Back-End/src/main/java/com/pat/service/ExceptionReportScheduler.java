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
     * @param exceptions Map of exceptions by IP address
     * @param connections Map of connections by IP address
     * @param logs Map of log messages by IP address
     * @param reportType Type of report (for subject line)
     */
    private ReportBuildResult buildReport(
            Map<String, List<ExceptionTrackingService.ExceptionInfo>> exceptions,
            Map<String, List<ExceptionTrackingService.ConnectionInfo>> connections,
            Map<String, List<ExceptionTrackingService.LogInfo>> logs,
            String reportType) {
        
        int totalConnections = connections.values().stream().mapToInt(List::size).sum();
        int totalExceptions = exceptions.values().stream().mapToInt(List::size).sum();
        int totalLogs = logs.values().stream().mapToInt(List::size).sum();
        int totalEvents = totalConnections + totalExceptions + totalLogs;
        int displayedEvents = Math.min(totalEvents, MAX_DETAIL_LINES);
        boolean truncated = totalEvents > MAX_DETAIL_LINES;
        int remainingDetailLines = MAX_DETAIL_LINES;
        boolean limitReached = false;
        boolean limitMessageAdded = false;
        Map<String, IpGeolocationService.IPInfo> ipInfoCache = new HashMap<>();
        LocalDateTime reportStart = null;
        LocalDateTime reportEnd = null;

        Map<String, UserConnectionSummary> userSummaryMap = new LinkedHashMap<>();
        for (Map.Entry<String, List<ExceptionTrackingService.ConnectionInfo>> entry : connections.entrySet()) {
            String ipAddress = entry.getKey();
            List<ExceptionTrackingService.ConnectionInfo> connectionList = entry.getValue();
            if (connectionList == null || connectionList.isEmpty()) {
                continue;
            }

            IpGeolocationService.IPInfo ipInfo = getIpInfo(ipInfoCache, ipAddress);
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

                UserConnectionSummary userSummary = userSummaryMap.computeIfAbsent(
                        normalizedUser,
                        UserConnectionSummary::new
                );
                userSummary.incrementTotalCount();
                userSummary.addIp(ipAddress, formatLocation(ipInfo), formatDomainName(ipInfo));
            }
        }
        List<UserConnectionSummary> userSummaries = new ArrayList<>(userSummaryMap.values());
        userSummaries.sort(Comparator.comparingInt(UserConnectionSummary::getTotalCount).reversed());

        List<ExceptionSummary> exceptionSummaries = new ArrayList<>();
        for (Map.Entry<String, List<ExceptionTrackingService.ExceptionInfo>> entry : exceptions.entrySet()) {
            String ipAddress = entry.getKey();
            List<ExceptionTrackingService.ExceptionInfo> exceptionList = entry.getValue();
            if (exceptionList == null || exceptionList.isEmpty()) {
                continue;
            }

            IpGeolocationService.IPInfo ipInfo = getIpInfo(ipInfoCache, ipAddress);
            String domainName = formatDomainName(ipInfo);
            String location = formatLocation(ipInfo);

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
                }
            }

            exceptionSummaries.add(new ExceptionSummary(
                    ipAddress,
                    location,
                    domainName,
                    exceptionList.size()
            ));
        }
        exceptionSummaries.sort(Comparator.comparingInt(ExceptionSummary::getCount).reversed());

        for (List<ExceptionTrackingService.LogInfo> logList : logs.values()) {
            if (logList == null) {
                continue;
            }
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
                }
            }
        }

        String reportFrom = reportStart != null ? escapeHtml(formatDateTime(reportStart)) : "N/A";
        String reportTo = reportEnd != null ? escapeHtml(formatDateTime(reportEnd)) : "N/A";

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
        bodyBuilder.append(".summary { background: #e9ecef; padding: 15px; border-radius: 8px; margin-top: 20px; box-shadow: 0 6px 18px rgba(0,0,0,0.08); }");
        bodyBuilder.append(".summary-item { margin: 5px 0; }");
        bodyBuilder.append(".summary-intro { background: #fff; border-left: 4px solid #007bff; margin-top: 15px; }");
        bodyBuilder.append(".summary-header { font-weight: 700; text-transform: uppercase; font-size: 18px; letter-spacing: 0.6px; color: #fff; padding: 16px 20px; margin-bottom: 12px; border-radius: 8px; background: linear-gradient(135deg, #0d6efd 0%, #6f42c1 100%); box-shadow: 0 8px 16px rgba(111, 66, 193, 0.25); }");
        bodyBuilder.append(".summary-section { background: #ffffff; border: 1px solid #d7dee9; border-radius: 10px; padding: 18px 20px; margin-top: 18px; box-shadow: 0 6px 16px rgba(15, 23, 42, 0.08); }");
        bodyBuilder.append(".summary-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; }");
        bodyBuilder.append(".summary-metric { background: #f8f9ff; border: 1px solid #d7dee9; border-radius: 10px; padding: 14px; box-shadow: 0 4px 12px rgba(13, 110, 253, 0.12); }");
        bodyBuilder.append(".summary-metric-label { font-size: 12px; font-weight: 600; text-transform: uppercase; color: #6c757d; letter-spacing: 0.7px; margin-bottom: 6px; }");
        bodyBuilder.append(".summary-metric-value { font-size: 18px; font-weight: 700; color: #212529; }");
        bodyBuilder.append(".metric-badge { display: inline-block; padding: 6px 12px; border-radius: 24px; font-weight: 700; font-size: 15px; }");
        bodyBuilder.append(".metric-badge-connections { background: #d1f8e4; color: #0f5132; }");
        bodyBuilder.append(".metric-badge-exceptions { background: #f8d7da; color: #842029; }");
        bodyBuilder.append(".metric-badge-logs { background: #fff3cd; color: #664d03; }");
        bodyBuilder.append(".metric-badge-details { background: #dbe4ff; color: #1d3b8b; }");
        bodyBuilder.append(".metric-arrow { font-weight: 700; color: #0d6efd; margin: 0 6px; }");
        bodyBuilder.append(".summary-subtitle { margin: 0 0 12px 0; font-weight: 700; text-transform: uppercase; color: #1f2d3d; letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px; font-size: 15px; }");
        bodyBuilder.append(".summary-subtitle::before { content: '\\25BA'; color: #0d6efd; font-size: 12px; }");
        bodyBuilder.append(".summary-table { width: 100%; border-collapse: collapse; margin: 8px 0 16px 0; border: 1px solid #ced4da; }");
        bodyBuilder.append(".summary-table th, .summary-table td { padding: 8px; border: 1px solid #ced4da; }");
        bodyBuilder.append(".summary-table th { color: #fff; text-align: left; }");
        bodyBuilder.append(".summary-table tr:nth-child(even) td { background: #f8f9fa; }");
        bodyBuilder.append(".summary-table-users th { background: linear-gradient(135deg, #28a745 0%, #20c997 100%); }");
        bodyBuilder.append(".summary-table-exceptions th { background: linear-gradient(135deg, #dc3545 0%, #ff6f61 100%); }");
        bodyBuilder.append(".summary-divider { height: 4px; background: linear-gradient(90deg, #0d6efd 0%, #6f42c1 100%); border-radius: 2px; margin: 26px 0; box-shadow: 0 4px 10px rgba(111, 66, 193, 0.25); }");
        bodyBuilder.append(".section-divider { height: 6px; background: linear-gradient(90deg, rgba(13,110,253,0.18) 0%, rgba(111,66,193,0.4) 50%, rgba(13,110,253,0.18) 100%); border-radius: 3px; margin: 40px 0 28px; box-shadow: 0 6px 18px rgba(79,70,229,0.2); }");
        bodyBuilder.append(".limit-note { margin-top: 10px; padding: 10px; background: #fff3cd; color: #856404; border-radius: 5px; border-left: 4px solid #ffc107; font-weight: bold; }");
        bodyBuilder.append(".limit-warning { margin: 15px 0; padding: 12px; background: #fff3cd; color: #856404; border-radius: 5px; border-left: 4px solid #ffc107; font-weight: bold; }");
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
        bodyBuilder.append("<div class='header'><h1>📊 USER CONNECTIONS & EXCEPTIONS REPORT</h1></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>Type:</span> <span class='value'>").append(escapeHtml(reportType)).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>Generated on:</span> <span class='value'>").append(escapeHtml(formatDateTime(LocalDateTime.now()))).append("</span></div>");
        bodyBuilder.append("<div class='summary summary-intro'>");
        bodyBuilder.append("<div class='summary-header'>📌 EXECUTIVE SUMMARY</div>");

        bodyBuilder.append("<div class='summary-section'>");
        bodyBuilder.append("<div class='summary-metrics'>");
        bodyBuilder.append("<div class='summary-metric'><div class='summary-metric-label'>Report period</div><div class='summary-metric-value'>").append(reportFrom).append("<span class='metric-arrow'>&rarr;</span>").append(reportTo).append("</div></div>");
        bodyBuilder.append("<div class='summary-metric'><div class='summary-metric-label'>Connections</div><div class='summary-metric-value'><span class='metric-badge metric-badge-connections'>").append(totalConnections).append("</span></div></div>");
        bodyBuilder.append("<div class='summary-metric'><div class='summary-metric-label'>Exceptions</div><div class='summary-metric-value'><span class='metric-badge metric-badge-exceptions'>").append(totalExceptions).append("</span></div></div>");
        bodyBuilder.append("<div class='summary-metric'><div class='summary-metric-label'>Logs</div><div class='summary-metric-value'><span class='metric-badge metric-badge-logs'>").append(totalLogs).append("</span></div></div>");
        bodyBuilder.append("<div class='summary-metric'><div class='summary-metric-label'>Details shown</div><div class='summary-metric-value'><span class='metric-badge metric-badge-details'>").append(displayedEvents).append(" / ").append(totalEvents).append("</span></div></div>");
        bodyBuilder.append("</div>");
        if (truncated) {
            bodyBuilder.append("<div class='limit-note'>Limit reached: only the first ").append(MAX_DETAIL_LINES).append(" detailed entries are displayed.</div>");
        }
        bodyBuilder.append("</div>");

        String tableBaseStyle = "width:100%;border-collapse:collapse;margin:8px 0 16px 0;border:1px solid #ced4da;";
        String headerUserStyle = "padding:8px;border:1px solid #ced4da;background:linear-gradient(135deg, #28a745 0%, #20c997 100%);color:#fff;text-align:left;";
        String headerExceptionStyle = "padding:8px;border:1px solid #ced4da;background:linear-gradient(135deg, #dc3545 0%, #ff6f61 100%);color:#fff;text-align:left;";
        String cellStyle = "padding:8px;border:1px solid #ced4da;";

        if (!userSummaries.isEmpty()) {
            bodyBuilder.append("<div class='summary-divider'></div>");
            bodyBuilder.append("<div class='summary-section'>");
            bodyBuilder.append("<div class='summary-subtitle'>Connected users</div>");
            bodyBuilder.append("<table style='").append(tableBaseStyle).append("' class='summary-table summary-table-users'>");
            bodyBuilder.append("<tr>");
            bodyBuilder.append("<th style='").append(headerUserStyle).append("'>User</th>");
            bodyBuilder.append("<th style='").append(headerUserStyle).append("'>Total connections</th>");
            bodyBuilder.append("<th style='").append(headerUserStyle).append("'>Connections (per IP)</th>");
            bodyBuilder.append("<th style='").append(headerUserStyle).append("'>IP</th>");
            bodyBuilder.append("<th style='").append(headerUserStyle).append("'>Location</th>");
            bodyBuilder.append("<th style='").append(headerUserStyle).append("'>Domain Name</th>");
            bodyBuilder.append("</tr>");
            for (UserConnectionSummary summaryData : userSummaries) {
                List<IpSummary> ipSummaries = summaryData.getIpSummaries();
                if (ipSummaries.isEmpty()) {
                    bodyBuilder.append("<tr>");
                    bodyBuilder.append("<td style='").append(cellStyle).append("'>").append(escapeHtml(summaryData.getUser())).append("</td>");
                    bodyBuilder.append("<td style='").append(cellStyle).append("'>").append(summaryData.getTotalCount()).append("</td>");
                    bodyBuilder.append("<td style='").append(cellStyle).append("' colspan='4'>N/A</td>");
                    bodyBuilder.append("</tr>");
                    continue;
                }
                for (IpSummary ipSummary : ipSummaries) {
                    bodyBuilder.append("<tr>");
                    bodyBuilder.append("<td style='").append(cellStyle).append("'>").append(escapeHtml(summaryData.getUser())).append("</td>");
                    bodyBuilder.append("<td style='").append(cellStyle).append("'>").append(summaryData.getTotalCount()).append("</td>");
                    bodyBuilder.append("<td style='").append(cellStyle).append("'>").append(ipSummary.getCount()).append("</td>");
                    bodyBuilder.append("<td style='").append(cellStyle).append("'>").append(escapeHtml(ipSummary.getIp())).append("</td>");
                    bodyBuilder.append("<td style='").append(cellStyle).append("'>").append(escapeHtml(ipSummary.getLocation())).append("</td>");
                    bodyBuilder.append("<td style='").append(cellStyle).append("'>").append(escapeHtml(ipSummary.getDomainName())).append("</td>");
                    bodyBuilder.append("</tr>");
                }
            }
            bodyBuilder.append("</table>");
            bodyBuilder.append("</div>");
        }
        if (!exceptionSummaries.isEmpty()) {
            bodyBuilder.append("<div class='summary-divider'></div>");
            bodyBuilder.append("<div class='summary-section'>");
            bodyBuilder.append("<div class='summary-subtitle'>Exceptions by IP</div>");
            bodyBuilder.append("<table style='").append(tableBaseStyle).append("' class='summary-table summary-table-exceptions'>");
            bodyBuilder.append("<tr>");
            bodyBuilder.append("<th style='").append(headerExceptionStyle).append("'>IP</th>");
            bodyBuilder.append("<th style='").append(headerExceptionStyle).append("'>Occurrences</th>");
            bodyBuilder.append("<th style='").append(headerExceptionStyle).append("'>Location</th>");
            bodyBuilder.append("<th style='").append(headerExceptionStyle).append("'>Domain Name</th>");
            bodyBuilder.append("</tr>");
            for (ExceptionSummary summaryData : exceptionSummaries) {
                bodyBuilder.append("<tr>");
                bodyBuilder.append("<td style='").append(cellStyle).append("'>").append(escapeHtml(summaryData.getIp())).append("</td>");
                bodyBuilder.append("<td style='").append(cellStyle).append("'>").append(summaryData.getCount()).append("</td>");
                bodyBuilder.append("<td style='").append(cellStyle).append("'>").append(escapeHtml(summaryData.getLocation())).append("</td>");
                bodyBuilder.append("<td style='").append(cellStyle).append("'>").append(escapeHtml(summaryData.getDomainName())).append("</td>");
                bodyBuilder.append("</tr>");
            }
            bodyBuilder.append("</table>");
            bodyBuilder.append("</div>");
        }
        bodyBuilder.append("</div>");

        // ========== SECTION 1: CONNEXIONS UTILISATEURS ==========
        if (totalConnections > 0 && remainingDetailLines > 0) {
            bodyBuilder.append("<div class='section-divider'></div>");
            bodyBuilder.append("<div class='section connection-section'>");
            bodyBuilder.append("<div class='section-header'>🔵 CONNEXIONS UTILISATEURS</div>");

            Set<String> connectionIpAddresses = new HashSet<>(connections.keySet());
            
            for (String ipAddress : connectionIpAddresses) {
                if (remainingDetailLines <= 0) {
                    limitReached = true;
                    break;
                }
                List<ExceptionTrackingService.ConnectionInfo> connectionList = connections.get(ipAddress);
                if (connectionList == null || connectionList.isEmpty()) {
                continue;
            }

                IpGeolocationService.IPInfo ipInfo = getIpInfo(ipInfoCache, ipAddress);
                String domainName = formatDomainName(ipInfo);
                String location = formatLocation(ipInfo);

                bodyBuilder.append("<div class='ip-block'>");
                bodyBuilder.append("<div class='ip-header'>📍 IP: ").append(escapeHtml(ipAddress)).append("</div>");
                bodyBuilder.append("<div class='info-item'><span class='label'>Domain Name:</span> <span class='value'>").append(escapeHtml(domainName)).append("</span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'>Location:</span> <span class='value'>").append(escapeHtml(location)).append("</span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'>Number of connections:</span> <span style='color: #28a745; font-weight: bold;'>").append(connectionList.size()).append("</span></div>");
                bodyBuilder.append("</div>");

                LinkedHashMap<ConnectionDetailKey, AggregatedConnectionDetail> aggregatedConnections = new LinkedHashMap<>();
                for (ExceptionTrackingService.ConnectionInfo info : connectionList) {
                    ConnectionDetailKey key = ConnectionDetailKey.from(info);
                    aggregatedConnections
                            .computeIfAbsent(key, AggregatedConnectionDetail::new)
                            .addTimestamp(info.getTimestamp());
                }

                for (AggregatedConnectionDetail aggregated : aggregatedConnections.values()) {
                    if (remainingDetailLines <= 0) {
                        limitReached = true;
                        break;
                    }
                    bodyBuilder.append("<div class='connection-item'>");
                    bodyBuilder.append("<strong>Connection");
                    if (aggregated.isNewUser()) {
                        bodyBuilder.append(" <span class='new-user'>NEW USER</span>");
                    }
                    bodyBuilder.append(" (").append(aggregated.getTimestamps().size()).append(")</strong><br>");
                    bodyBuilder.append("<div class='timestamp'>Times: ").append(aggregated.formatTimestamps(this::formatDateTime, this::escapeHtml)).append("</div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>IP:</strong></span> <span class='value'><span class='ip-highlight'>").append(escapeHtml(ipAddress)).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>Domain Name:</strong></span> <span class='value'><span class='domain-highlight'>").append(escapeHtml(domainName)).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>Location:</strong></span> <span class='value'><span class='location-highlight'>").append(escapeHtml(location)).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'>User:</span> <span class='value'>").append(escapeHtml(aggregated.getUsername())).append("</span></div>");
                    if (aggregated.hasFullName()) {
                        bodyBuilder.append("<div class='info-item'><span class='label'>Full name:</span> <span class='value'>").append(escapeHtml(aggregated.getFullName())).append("</span></div>");
                    }
                    if (aggregated.hasEmail()) {
                        bodyBuilder.append("<div class='info-item'><span class='label'>Email:</span> <span class='value'>").append(escapeHtml(aggregated.getEmail())).append("</span></div>");
                    }
                    if (aggregated.hasRoles()) {
                        bodyBuilder.append("<div class='info-item'><span class='label'>Roles:</span> <span class='value'>").append(escapeHtml(aggregated.getRoles())).append("</span></div>");
                    }
                    bodyBuilder.append("</div>");
                    remainingDetailLines--;
                }
                if (limitReached) {
                    break;
                }
            }
            bodyBuilder.append("</div>");
        }
        if (limitReached && !limitMessageAdded) {
            bodyBuilder.append("<div class='limit-warning'>The report shows only the first ").append(MAX_DETAIL_LINES).append(" detailed lines. Additional data has been omitted.</div>");
            limitMessageAdded = true;
        }

        // ========== SECTION 2: EXCEPTIONS ==========
        if (totalExceptions > 0 && remainingDetailLines > 0) {
            bodyBuilder.append("<div class='section-divider'></div>");
            bodyBuilder.append("<div class='section exception-section'>");
            bodyBuilder.append("<div class='section-header'>🔴 EXCEPTIONS</div>");

            Set<String> exceptionIpAddresses = new HashSet<>(exceptions.keySet());
            
            // List IPs with exceptions
            if (!exceptionIpAddresses.isEmpty()) {
                bodyBuilder.append("<div style='background: #fff5f5; padding: 10px; margin: 10px 0; border-radius: 4px;'><strong>--- IPs with exceptions ---</strong></div>");
                for (String ipAddress : exceptionIpAddresses) {
                    IpGeolocationService.IPInfo ipInfo = getIpInfo(ipInfoCache, ipAddress);
                    String domainName = formatDomainName(ipInfo);
                    String location = formatLocation(ipInfo);
                    int exceptionCount = exceptions.getOrDefault(ipAddress, List.of()).size();
                    
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>IP:</strong></span> <span class='value'><span class='ip-highlight'>").append(escapeHtml(ipAddress)).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>Domain Name:</strong></span> <span class='value'><span class='domain-highlight'>").append(escapeHtml(domainName)).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>Location:</strong></span> <span class='value'><span class='location-highlight'>").append(escapeHtml(location)).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'>Number of exceptions:</span> <span style='color: #dc3545; font-weight: bold;'>").append(exceptionCount).append("</span></div><br>");
                }
            }
            
            // Détails des exceptions
            for (String ipAddress : exceptionIpAddresses) {
                List<ExceptionTrackingService.ExceptionInfo> exceptionList = exceptions.get(ipAddress);
                if (exceptionList == null || exceptionList.isEmpty()) {
                    continue;
                }
                if (remainingDetailLines <= 0) {
                    limitReached = true;
                    break;
                }

                IpGeolocationService.IPInfo ipInfo = getIpInfo(ipInfoCache, ipAddress);
                String domainName = formatDomainName(ipInfo);
                String location = formatLocation(ipInfo);

                bodyBuilder.append("<div class='ip-block'>");
                bodyBuilder.append("<div class='ip-header'>📍 <strong>IP:</strong> <span class='ip-highlight'>").append(escapeHtml(ipAddress)).append("</span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'><strong>Domain Name:</strong></span> <span class='value'><span class='domain-highlight'>").append(escapeHtml(domainName)).append("</span></span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'><strong>Location:</strong></span> <span class='value'><span class='location-highlight'>").append(escapeHtml(location)).append("</span></span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'>Number of exceptions:</span> <span style='color: #dc3545; font-weight: bold;'>").append(exceptionList.size()).append("</span></div>");
                bodyBuilder.append("</div>");

                LinkedHashMap<ExceptionDetailKey, AggregatedExceptionDetail> aggregatedExceptions = new LinkedHashMap<>();
                for (ExceptionTrackingService.ExceptionInfo info : exceptionList) {
                    ExceptionDetailKey key = ExceptionDetailKey.from(info);
                    aggregatedExceptions.computeIfAbsent(key, AggregatedExceptionDetail::new)
                            .addTimestamp(info.getTimestamp());
                }

                for (AggregatedExceptionDetail aggregated : aggregatedExceptions.values()) {
                    if (remainingDetailLines <= 0) {
                        limitReached = true;
                        break;
                    }
                    bodyBuilder.append("<div class='exception-item'>");
                    bodyBuilder.append("<strong>Exception (").append(aggregated.getTimestamps().size()).append(")</strong><br>");
                    bodyBuilder.append("<div class='timestamp'>Times: ").append(aggregated.formatTimestamps(this::formatDateTime, this::escapeHtml)).append("</div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'>Type:</span> <span class='value' style='color: #dc3545;'>").append(escapeHtml(aggregated.getType())).append("</span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'>Message:</span> <span class='value'>").append(escapeHtml(aggregated.getMessage())).append("</span></div>");
                    if (!aggregated.getLogMessage().isEmpty()) {
                        bodyBuilder.append("<div class='info-item'><span class='label'>Log:</span> <span class='value'>").append(escapeHtml(aggregated.getLogMessage())).append("</span></div>");
                    }
                    bodyBuilder.append("<div class='info-item'><span class='label'>HTTP method:</span> <span class='value'>").append(escapeHtml(aggregated.getRequestMethod())).append("</span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'>URI:</span> <span class='value'>").append(escapeHtml(aggregated.getRequestUri())).append("</span></div>");
                    bodyBuilder.append("</div>");
                    remainingDetailLines--;
                }
                if (limitReached) {
                    break;
                }
            }
            bodyBuilder.append("</div>");
        }
        if (limitReached && !limitMessageAdded) {
            bodyBuilder.append("<div class='limit-warning'>The report shows only the first ").append(MAX_DETAIL_LINES).append(" detailed lines. Additional data has been omitted.</div>");
            limitMessageAdded = true;
        }

        // ========== SECTION 3: LOGS WITH IP ==========
        if (totalLogs > 0 && remainingDetailLines > 0) {
            bodyBuilder.append("<div class='section-divider'></div>");
            bodyBuilder.append("<div class='section log-section'>");
            bodyBuilder.append("<div class='section-header'>🟡 LOGS WITH IP</div>");

            Set<String> logIpAddresses = new HashSet<>(logs.keySet());
            
            // List IPs with logs
            if (!logIpAddresses.isEmpty()) {
                bodyBuilder.append("<div style='background: #fffbf0; padding: 10px; margin: 10px 0; border-radius: 4px;'><strong>--- IPs with logs ---</strong></div>");
                for (String ipAddress : logIpAddresses) {
                    IpGeolocationService.IPInfo ipInfo = getIpInfo(ipInfoCache, ipAddress);
                    String domainName = formatDomainName(ipInfo);
                    String location = formatLocation(ipInfo);
                    int logCount = logs.getOrDefault(ipAddress, List.of()).size();
                    
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>IP:</strong></span> <span class='value'><span class='ip-highlight'>").append(escapeHtml(ipAddress)).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>Domain Name:</strong></span> <span class='value'><span class='domain-highlight'>").append(escapeHtml(domainName)).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'><strong>Location:</strong></span> <span class='value'><span class='location-highlight'>").append(escapeHtml(location)).append("</span></span></div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'>Number of logs:</span> <span style='color: #ffc107; font-weight: bold;'>").append(logCount).append("</span></div><br>");
                }
            }
            
            // Détails des logs
            for (String ipAddress : logIpAddresses) {
                List<ExceptionTrackingService.LogInfo> logList = logs.get(ipAddress);
                if (logList == null || logList.isEmpty()) {
                    continue;
                }
                if (remainingDetailLines <= 0) {
                    limitReached = true;
                    break;
                }

                IpGeolocationService.IPInfo ipInfo = getIpInfo(ipInfoCache, ipAddress);
                String domainName = formatDomainName(ipInfo);
                String location = formatLocation(ipInfo);

                bodyBuilder.append("<div class='ip-block'>");
                bodyBuilder.append("<div class='ip-header'>📍 <strong>IP:</strong> <span class='ip-highlight'>").append(escapeHtml(ipAddress)).append("</span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'><strong>Domain Name:</strong></span> <span class='value'><span class='domain-highlight'>").append(escapeHtml(domainName)).append("</span></span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'><strong>Location:</strong></span> <span class='value'><span class='location-highlight'>").append(escapeHtml(location)).append("</span></span></div>");
                bodyBuilder.append("<div class='info-item'><span class='label'>Number of logs:</span> <span style='color: #ffc107; font-weight: bold;'>").append(logList.size()).append("</span></div>");
                bodyBuilder.append("</div>");

                LinkedHashMap<String, AggregatedLogDetail> aggregatedLogs = new LinkedHashMap<>();
                for (ExceptionTrackingService.LogInfo info : logList) {
                    String message = info.getLogMessage() != null ? info.getLogMessage() : "N/A";
                    aggregatedLogs.computeIfAbsent(message, AggregatedLogDetail::new)
                            .addTimestamp(info.getTimestamp());
                }

                for (AggregatedLogDetail aggregated : aggregatedLogs.values()) {
                    if (remainingDetailLines <= 0) {
                        limitReached = true;
                        break;
                    }
                    bodyBuilder.append("<div class='log-item'>");
                    bodyBuilder.append("<strong>Log (").append(aggregated.getTimestamps().size()).append(")</strong><br>");
                    bodyBuilder.append("<div class='timestamp'>Times: ").append(aggregated.formatTimestamps(this::formatDateTime, this::escapeHtml)).append("</div>");
                    bodyBuilder.append("<div class='info-item'><span class='label'>Message:</span> <span class='value'>").append(escapeHtml(aggregated.getMessage())).append("</span></div>");
                    bodyBuilder.append("</div>");
                    remainingDetailLines--;
                }
                if (limitReached) {
                    break;
                }
            }
            bodyBuilder.append("</div>");
        }
        if (limitReached && !limitMessageAdded) {
            bodyBuilder.append("<div class='limit-warning'>The report shows only the first ").append(MAX_DETAIL_LINES).append(" detailed lines. Additional data has been omitted.</div>");
            limitMessageAdded = true;
        }

        // ========== SUMMARY ==========
        Set<String> allIpAddresses = new HashSet<>();
        allIpAddresses.addAll(connections.keySet());
        allIpAddresses.addAll(exceptions.keySet());
        allIpAddresses.addAll(logs.keySet());
        
        bodyBuilder.append("<div class='summary'>");
        bodyBuilder.append("<div class='section-header' style='margin: -15px -15px 15px -15px; border-radius: 5px 5px 0 0;'>📋 SUMMARY</div>");
        bodyBuilder.append("<div class='summary-item'><span class='label'>Unique IP addresses:</span> <span style='font-weight: bold; color: #007bff;'>").append(allIpAddresses.size()).append("</span></div>");
        bodyBuilder.append("<div class='summary-item'><span class='label'>Total connections:</span> <span style='color: #28a745; font-weight: bold;'>").append(totalConnections).append("</span></div>");
        bodyBuilder.append("<div class='summary-item'><span class='label'>Total exceptions:</span> <span style='color: #dc3545; font-weight: bold;'>").append(totalExceptions).append("</span></div>");
        bodyBuilder.append("<div class='summary-item'><span class='label'>Total logs:</span> <span style='color: #ffc107; font-weight: bold;'>").append(totalLogs).append("</span></div>");
        bodyBuilder.append("<div class='summary-item'><span class='label'>Total events:</span> <span style='font-weight: bold;'>").append(totalEvents).append("</span></div>");
        bodyBuilder.append("<div class='summary-item'><span class='label'>Details shown:</span> <span style='font-weight: bold;'>").append(displayedEvents).append(" / ").append(totalEvents).append("</span></div>");
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
}
