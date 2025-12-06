package com.pat.controller;

import com.pat.repo.domain.Member;
import com.pat.repo.domain.UserConnectionLog;
import com.pat.repo.MembersRepository;
import com.pat.repo.UserConnectionLogRepository;
import com.pat.service.ExceptionTrackingService;
import com.pat.service.IpGeolocationService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;


import jakarta.servlet.http.HttpServletRequest;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Date;
import java.util.Enumeration;
import java.util.List;

/**
 * Created by patricou on 4/20/2017.
 */
@RestController
@RequestMapping("/api/memb")
public class MemberRestController {

    private static final Logger log = LoggerFactory.getLogger(MemberRestController.class);

    @Autowired
    private MembersRepository membersRepository;

    @Autowired
    private MailController mailController;

    @Autowired
    private ExceptionTrackingService exceptionTrackingService;

    @Autowired
    private IpGeolocationService ipGeolocationService;

    @Autowired
    private UserConnectionLogRepository userConnectionLogRepository;

    @Value("${app.connection.email.enabled:false}")
    private boolean connectionEmailEnabled;

    @RequestMapping(method = RequestMethod.GET)
    public List<Member> getListMembers(){
        return membersRepository.findAll();
    }

    @RequestMapping(
            value = "/user",
            method = RequestMethod.POST,
            consumes = {"application/json"},
            produces = { "application/json"}
    )
    @ResponseBody
    public Member getMemberbyUserNameAndRetrieveId(@RequestBody Member member, HttpServletRequest request){
        log.debug("=== USER CONNECTION REQUEST ===");
        log.debug("Member Received - Username: {}, KeycloakId: {}", member.getUserName(), member.getKeycloakId());
        member.setId(null);
        // retrieve Mlab Id by userName ( would have been better by keycloakId )
        Member memberWithId = membersRepository.findByUserName(member.getUserName());
        log.debug("User lookup result: {}", memberWithId != null ? "FOUND (existing user)" : "NOT FOUND (new user)");
        // Update the ID
        Date now = new Date();
        if (memberWithId != null ) {
            log.debug("Existing user found - Member ID: {}", memberWithId.getId());
            member.setId(memberWithId.getId());
            // Preserve registration date from existing member
            if (memberWithId.getRegistrationDate() != null) {
                member.setRegistrationDate(memberWithId.getRegistrationDate());
            }
            // Update last connection date
            member.setLastConnectionDate(now);
            // Update locale if provided, otherwise preserve existing
            if (member.getLocale() == null || member.getLocale().trim().isEmpty()) {
                if (memberWithId.getLocale() != null) {
                    member.setLocale(memberWithId.getLocale());
                }
            }

            String ipAddress = request.getHeader("X-Forwarded-For");
            if (ipAddress == null) {
                ipAddress = request.getRemoteAddr();
            }

            String subject = "Connection User " + member.getUserName() + " ( "+ member.getFirstName()+ " "+member.getLastName() +" )";
            
            String userAgent = request.getHeader("User-Agent");
            String referer = request.getHeader("Referer");
            String body = generateConnectionEmailHtml(member, request, ipAddress, false);
            
            // Check if IP should be excluded from email notifications (client or server IP)
            if (connectionEmailEnabled) {
                if (!shouldExcludeEmail(ipAddress)) {
                    // Send email for all users (including patricou)
                    log.debug("Attempting to send connection email for user: {}", member.getUserName());
                    mailController.sendMail(subject, body, true); // true = HTML format
                    log.debug("Connection notification - Subject: '{}' From IP: {}", subject, getIp());
                } else {
                    log.debug("Email notification skipped - Client IP: {}, Server IP: {} (excluded IP)", ipAddress, getIp());
                }
            } else {
                log.debug("Connection email disabled via configuration - skipping send for user: {}", member.getUserName());
            }
            
            // Track connection for periodic reporting
            String rolesStr = (member.getRoles() != null && !member.getRoles().isEmpty()) ? member.getRoles().toString() : null;
            exceptionTrackingService.addConnection(
                ipAddress,
                member.getUserName(),
                member.getFirstName(),
                member.getLastName(),
                member.getAddressEmail(),
                member.getKeycloakId(),
                member.getId() != null ? member.getId() : null,
                rolesStr,
                request.getRequestURI(),
                request.getMethod(),
                userAgent,
                referer,
                false // existing user
            );
        } else {
            // New user - set registration date
            member.setRegistrationDate(now);
            member.setLastConnectionDate(now);
            // New user - still send email notification
            log.debug("New user connection detected - Username: {}", member.getUserName());
            
            String ipAddress = request.getHeader("X-Forwarded-For");
            if (ipAddress == null) {
                ipAddress = request.getRemoteAddr();
            }

            String subject = "NEW USER Connection " + member.getUserName() + " ( "+ member.getFirstName()+ " "+member.getLastName() +" )";
            
            String userAgent = request.getHeader("User-Agent");
            String referer = request.getHeader("Referer");
            String body = generateConnectionEmailHtml(member, request, ipAddress, true);
            
            // Check if IP should be excluded from email notifications (client or server IP)
            if (connectionEmailEnabled) {
                if (!shouldExcludeEmail(ipAddress)) {
                    // Send email for all users including new users (including patricou)
                    log.debug("Attempting to send NEW USER connection email for: {}", member.getUserName());
                    mailController.sendMail(subject, body, true); // true = HTML format
                    log.debug("NEW USER connection notification - Subject: '{}' From IP: {}", subject, getIp());
                } else {
                    log.debug("Email notification skipped for NEW USER - Client IP: {}, Server IP: {} (excluded IP)", ipAddress, getIp());
                }
            } else {
                log.debug("Connection email disabled via configuration - skipping NEW USER notification for: {}", member.getUserName());
            }
            
            // Track connection for periodic reporting
            String rolesStr = (member.getRoles() != null && !member.getRoles().isEmpty()) ? member.getRoles().toString() : null;
            exceptionTrackingService.addConnection(
                ipAddress,
                member.getUserName(),
                member.getFirstName(),
                member.getLastName(),
                member.getAddressEmail(),
                member.getKeycloakId(),
                null, // no ID yet for new user
                rolesStr,
                request.getRequestURI(),
                request.getMethod(),
                userAgent,
                referer,
                true // new user
            );
        }

        // Save the member in Mlab ( if modif ( like email or... ) ( userName is unqiue )
        log.debug("Saving member to database...");
        Member newMember = membersRepository.save(member);
        log.debug("Member saved - ID: {}", newMember.getId());
        
        // Save connection log to MongoDB
        try {
            String ipAddress = request.getHeader("X-Forwarded-For");
            if (ipAddress == null) {
                ipAddress = request.getRemoteAddr();
            }
            
            // Get IP information (domain name and location)
            IpGeolocationService.IPInfo ipInfo = ipGeolocationService.getCompleteIpInfo(ipAddress);
            String domainName = ipInfo.getDomainName() != null ? ipInfo.getDomainName() : "N/A";
            String location = ipInfo.getLocation() != null ? ipInfo.getLocation() : "N/A";
            
            // Create and save connection log
            UserConnectionLog connectionLog = new UserConnectionLog(
                newMember,
                now,
                ipAddress,
                domainName,
                location
            );
            userConnectionLogRepository.save(connectionLog);
            log.debug("Connection log saved for user: {}", newMember.getUserName());
        } catch (Exception e) {
            log.error("Error saving connection log for user: {}", newMember.getUserName(), e);
            // Don't fail the connection if logging fails
        }
        
        log.debug("=== END USER CONNECTION REQUEST ===\n");
        return newMember;
    }

    @RequestMapping(
            value = "/{id}",
            method = RequestMethod.GET,
            produces = { "application/json"}
            )
    public Member getMember(@PathVariable String id) {
        log.debug("Get Member : " +  id );
        return membersRepository.findById(id).orElse(null);
    }

    private String getIp(){
        try{
            return InetAddress.getLocalHost().getHostAddress().toString();
        }catch(UnknownHostException e){

            return "UnknownHostException.";

        }
    }

    /**
     * Generate HTML email body for user connection notifications
     */
    private String generateConnectionEmailHtml(Member member, HttpServletRequest request, String ipAddress, boolean isNewUser) {
        StringBuilder bodyBuilder = new StringBuilder();
        bodyBuilder.append("<!DOCTYPE html><html><head><meta charset='UTF-8'>");
        bodyBuilder.append("<style>");
        bodyBuilder.append("body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 15px; line-height: 1.8; color: #2c3e50; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); margin: 0; padding: 20px; }");
        bodyBuilder.append(".container { max-width: 800px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); overflow: hidden; }");
        bodyBuilder.append(".header { background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; padding: 25px; text-align: center; border-bottom: 4px solid #1e7e34; }");
        bodyBuilder.append(".header-new { background: linear-gradient(135deg, #ffc107 0%, #fd7e14 100%); color: white; padding: 25px; text-align: center; border-bottom: 4px solid #ff8c00; }");
        bodyBuilder.append(".header h1 { margin: 0; font-size: 24px; font-weight: 700; text-shadow: 2px 2px 4px rgba(0,0,0,0.2); letter-spacing: 1px; }");
        bodyBuilder.append(".header-icon { font-size: 32px; margin-bottom: 10px; }");
        bodyBuilder.append(".section { background: white; margin: 20px; padding: 0; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); overflow: hidden; border: 2px solid #e0e0e0; }");
        bodyBuilder.append(".section-header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 20px; font-weight: 700; font-size: 16px; border-bottom: 3px solid #5568d3; display: flex; align-items: center; gap: 10px; }");
        bodyBuilder.append(".section-content { padding: 20px; background: #fafafa; }");
        bodyBuilder.append(".info-item { margin: 12px 0; padding: 12px; background: white; border-radius: 6px; border-left: 4px solid #667eea; box-shadow: 0 2px 4px rgba(0,0,0,0.05); display: flex; align-items: center; }");
        bodyBuilder.append(".label { font-weight: 700; color: #495057; min-width: 140px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; }");
        bodyBuilder.append(".value { color: #212529; font-weight: 500; flex: 1; font-size: 15px; }");
        bodyBuilder.append(".new-user-badge { background: linear-gradient(135deg, #ffc107 0%, #ff9800 100%); color: #000; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; display: inline-block; margin-left: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }");
        bodyBuilder.append(".ip-highlight { color: #007bff; font-weight: bold !important; font-size: 16px; background: #e7f3ff; padding: 4px 8px; border-radius: 4px; display: inline-block; }");
        bodyBuilder.append(".domain-highlight { color: #28a745; font-weight: bold !important; font-size: 15px; background: #d4edda; padding: 4px 8px; border-radius: 4px; display: inline-block; }");
        bodyBuilder.append(".location-highlight { color: #dc3545; font-weight: bold !important; font-size: 15px; background: #f8d7da; padding: 4px 8px; border-radius: 4px; display: inline-block; }");
        bodyBuilder.append(".separator { height: 3px; background: linear-gradient(90deg, #667eea 0%, #764ba2 50%, #667eea 100%); margin: 20px 0; border-radius: 2px; }");
        bodyBuilder.append(".icon { font-size: 20px; margin-right: 8px; }");
        bodyBuilder.append("</style></head><body>");
        bodyBuilder.append("<div class='container'>");
        
        // Header
        if (isNewUser) {
            bodyBuilder.append("<div class='header-new'>");
            bodyBuilder.append("<div class='header-icon'>🆕</div>");
            bodyBuilder.append("<h1>NEW USER CONNECTION</h1>");
            bodyBuilder.append("</div>");
        } else {
            bodyBuilder.append("<div class='header'>");
            bodyBuilder.append("<div class='header-icon'>👤</div>");
            bodyBuilder.append("<h1>USER CONNECTION</h1>");
            bodyBuilder.append("</div>");
        }
        
        // User Information Section
        bodyBuilder.append("<div class='section'>");
        bodyBuilder.append("<div class='section-header'><span class='icon'>" + (isNewUser ? "🆕" : "👤") + "</span>USER INFORMATION" + (isNewUser ? " <span class='new-user-badge'>NEW</span>" : "") + "</div>");
        bodyBuilder.append("<div class='section-content'>");
        if (member.getId() != null && !isNewUser) {
            bodyBuilder.append("<div class='info-item'><span class='label'>🆔 ID:</span> <span class='value'>").append(escapeHtml(member.getId())).append("</span></div>");
        }
        bodyBuilder.append("<div class='info-item'><span class='label'>👤 Username:</span> <span class='value'>").append(escapeHtml(member.getUserName() != null ? member.getUserName() : "N/A")).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>📝 First Name:</span> <span class='value'>").append(escapeHtml(member.getFirstName() != null ? member.getFirstName() : "N/A")).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>📝 Last Name:</span> <span class='value'>").append(escapeHtml(member.getLastName() != null ? member.getLastName() : "N/A")).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>📧 Email:</span> <span class='value'>").append(escapeHtml(member.getAddressEmail() != null ? member.getAddressEmail() : "N/A")).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>🔑 Keycloak ID:</span> <span class='value'>").append(escapeHtml(member.getKeycloakId() != null ? member.getKeycloakId() : "N/A")).append("</span></div>");
        if (member.getRoles() != null && !member.getRoles().isEmpty()) {
            bodyBuilder.append("<div class='info-item'><span class='label'>🎭 Roles:</span> <span class='value'>").append(escapeHtml(member.getRoles())).append("</span></div>");
        }
        bodyBuilder.append("</div></div>");
        
        bodyBuilder.append("<div class='separator'></div>");
        
        // Connection Information Section
        bodyBuilder.append("<div class='section'>");
        bodyBuilder.append("<div class='section-header'><span class='icon'>🌐</span>CONNECTION INFORMATION</div>");
        bodyBuilder.append("<div class='section-content'>");
        bodyBuilder.append("<div class='info-item'><span class='label'>🕐 Timestamp:</span> <span class='value'>").append(escapeHtml(formatDateTime(LocalDateTime.now()))).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>🖥️ <strong>Server IP:</strong></span> <span class='value'><span class='ip-highlight'>").append(escapeHtml(getIp())).append("</span></span></div>");
        
        // Get IP geolocation information
        IpGeolocationService.IPInfo ipInfo = ipGeolocationService.getCompleteIpInfo(ipAddress);
        bodyBuilder.append("<div class='info-item'><span class='label'>📍 <strong>Client IP:</strong></span> <span class='value'><span class='ip-highlight'>").append(escapeHtml(ipAddress)).append("</span></span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>🌍 <strong>Domain Name:</strong></span> <span class='value'><span class='domain-highlight'>").append(escapeHtml(ipInfo.getDomainName() != null && !ipInfo.getDomainName().isEmpty() ? ipInfo.getDomainName() : "N/A")).append("</span></span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>🗺️ <strong>Location:</strong></span> <span class='value'><span class='location-highlight'>").append(escapeHtml(ipInfo.getLocation())).append("</span></span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>⚡ Request Method:</span> <span class='value'>").append(escapeHtml(request.getMethod())).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>🔗 Request URI:</span> <span class='value'>").append(escapeHtml(request.getRequestURI())).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>🔗 Request URL:</span> <span class='value'>").append(escapeHtml(request.getRequestURL().toString())).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>❓ Query String:</span> <span class='value'>").append(escapeHtml(request.getQueryString() != null ? request.getQueryString() : "N/A")).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>🔒 Protocol:</span> <span class='value'>").append(escapeHtml(request.getProtocol())).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>🌐 Scheme:</span> <span class='value'>").append(escapeHtml(request.getScheme())).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>🖥️ Server Name:</span> <span class='value'>").append(escapeHtml(request.getServerName())).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>🔌 Server Port:</span> <span class='value'>").append(request.getServerPort()).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>🏠 Remote Host:</span> <span class='value'>").append(escapeHtml(request.getRemoteHost())).append("</span></div>");
        bodyBuilder.append("<div class='info-item'><span class='label'>🔌 Remote Port:</span> <span class='value'>").append(request.getRemotePort()).append("</span></div>");
        bodyBuilder.append("</div></div>");
        
        bodyBuilder.append("<div class='separator'></div>");
        
        // Request Headers Section
        bodyBuilder.append("<div class='section'>");
        bodyBuilder.append("<div class='section-header'><span class='icon'>📋</span>REQUEST HEADERS</div>");
        bodyBuilder.append("<div class='section-content'>");
        Enumeration<String> headerNames = request.getHeaderNames();
        while (headerNames.hasMoreElements()) {
            String headerName = headerNames.nextElement();
            String headerValue = request.getHeader(headerName);
            if (!"authorization".equalsIgnoreCase(headerName)) {
                bodyBuilder.append("<div class='info-item'><span class='label'>📄 ").append(escapeHtml(headerName)).append(":</span> <span class='value'>").append(escapeHtml(headerValue)).append("</span></div>");
            }
        }
        bodyBuilder.append("</div></div>");
        
        // User-Agent Information
        String userAgent = request.getHeader("User-Agent");
        if (userAgent != null) {
            bodyBuilder.append("<div class='separator'></div>");
            bodyBuilder.append("<div class='section'>");
            bodyBuilder.append("<div class='section-header'><span class='icon'>🌐</span>BROWSER/CLIENT INFORMATION</div>");
            bodyBuilder.append("<div class='section-content'>");
            bodyBuilder.append("<div class='info-item'><span class='label'>🌐 User-Agent:</span> <span class='value'>").append(escapeHtml(userAgent)).append("</span></div>");
            bodyBuilder.append("</div></div>");
        }
        
        // Referer Information
        String referer = request.getHeader("Referer");
        if (referer != null) {
            bodyBuilder.append("<div class='separator'></div>");
            bodyBuilder.append("<div class='section'>");
            bodyBuilder.append("<div class='section-header'><span class='icon'>🔗</span>REFERRER INFORMATION</div>");
            bodyBuilder.append("<div class='section-content'>");
            bodyBuilder.append("<div class='info-item'><span class='label'>🔗 Referer:</span> <span class='value'>").append(escapeHtml(referer)).append("</span></div>");
            bodyBuilder.append("</div></div>");
        }
        
        bodyBuilder.append("</div></body></html>");
        return bodyBuilder.toString();
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
     * Check if USER CONNECTION email should be excluded based on client IP or server IP
     * NOTE: This method is ONLY used for user connection emails, NOT for exception reports
     * Exception reports are sent independently and are not affected by this check
     * @param clientIpAddress The client IP address to check (may contain multiple IPs separated by commas)
     * @return true if email should be excluded, false otherwise
     */
    private boolean shouldExcludeEmail(String clientIpAddress) {
        // Check server IP first
        String serverIp = getIp();
        if ("192.168.1.33".equals(serverIp)) {
            return true; // Exclude connection emails only, not reports
        }
        
        // Check client IP
        if (clientIpAddress == null || clientIpAddress.isEmpty()) {
            return false;
        }
        
        // Handle X-Forwarded-For which may contain multiple IPs separated by commas
        String[] ips = clientIpAddress.split(",");
        for (String ip : ips) {
            String trimmedIp = ip.trim();
            // Check if this IP should be excluded
            if ("192.168.1.33".equals(trimmedIp)) {
                return true; // Exclude connection emails only, not reports
            }
        }
        
        return false;
    }

}
