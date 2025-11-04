package com.pat.controller;

import com.pat.repo.domain.Member;
import com.pat.repo.MembersRepository;
import com.pat.service.ExceptionTrackingService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;


import jakarta.servlet.http.HttpServletRequest;
import java.net.InetAddress;
import java.net.UnknownHostException;
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
        log.info("=== USER CONNECTION REQUEST ===");
        log.info("Member Received - Username: {}, KeycloakId: {}", member.getUserName(), member.getKeycloakId());
        member.setId(null);
        // retrieve Mlab Id by userName ( would have been better by keycloakId )
        Member memberWithId = membersRepository.findByUserName(member.getUserName());
        log.info("User lookup result: {}", memberWithId != null ? "FOUND (existing user)" : "NOT FOUND (new user)");
        // Update the ID
        if (memberWithId != null ) {
            log.info("Existing user found - Member ID: {}", memberWithId.getId());
            member.setId(memberWithId.getId());

            String ipAddress = request.getHeader("X-Forwarded-For");
            if (ipAddress == null) {
                ipAddress = request.getRemoteAddr();
            }

            String subject = "Connection User " + member.getUserName() + " ( "+ member.getFirstName()+ " "+member.getLastName() +" )";
            
            // Build comprehensive email body with all user information
            StringBuilder bodyBuilder = new StringBuilder();
            bodyBuilder.append("========================================\n");
            bodyBuilder.append("USER CONNECTION NOTIFICATION\n");
            bodyBuilder.append("========================================\n\n");
            
            // User Information
            bodyBuilder.append("--- USER INFORMATION ---\n");
            bodyBuilder.append("ID: ").append(member.getId() != null ? member.getId() : "N/A").append("\n");
            bodyBuilder.append("Username: ").append(member.getUserName() != null ? member.getUserName() : "N/A").append("\n");
            bodyBuilder.append("First Name: ").append(member.getFirstName() != null ? member.getFirstName() : "N/A").append("\n");
            bodyBuilder.append("Last Name: ").append(member.getLastName() != null ? member.getLastName() : "N/A").append("\n");
            bodyBuilder.append("Email: ").append(member.getAddressEmail() != null ? member.getAddressEmail() : "N/A").append("\n");
            bodyBuilder.append("Keycloak ID: ").append(member.getKeycloakId() != null ? member.getKeycloakId() : "N/A").append("\n");
            if (member.getRoles() != null && !member.getRoles().isEmpty()) {
                bodyBuilder.append("Roles: ").append(member.getRoles()).append("\n");
            }
            bodyBuilder.append("\n");
            
            // Connection Information
            bodyBuilder.append("--- CONNECTION INFORMATION ---\n");
            bodyBuilder.append("Timestamp: ").append(java.time.LocalDateTime.now()).append("\n");
            bodyBuilder.append("Server IP: ").append(getIp()).append("\n");
            bodyBuilder.append("Client IP: ").append(ipAddress).append("\n");
            bodyBuilder.append("Request Method: ").append(request.getMethod()).append("\n");
            bodyBuilder.append("Request URI: ").append(request.getRequestURI()).append("\n");
            bodyBuilder.append("Request URL: ").append(request.getRequestURL().toString()).append("\n");
            bodyBuilder.append("Query String: ").append(request.getQueryString() != null ? request.getQueryString() : "N/A").append("\n");
            bodyBuilder.append("Protocol: ").append(request.getProtocol()).append("\n");
            bodyBuilder.append("Scheme: ").append(request.getScheme()).append("\n");
            bodyBuilder.append("Server Name: ").append(request.getServerName()).append("\n");
            bodyBuilder.append("Server Port: ").append(request.getServerPort()).append("\n");
            bodyBuilder.append("Remote Host: ").append(request.getRemoteHost()).append("\n");
            bodyBuilder.append("Remote Port: ").append(request.getRemotePort()).append("\n");
            bodyBuilder.append("\n");
            
            // Request Headers
            bodyBuilder.append("--- REQUEST HEADERS ---\n");
            Enumeration<String> headerNames = request.getHeaderNames();
            while (headerNames.hasMoreElements()) {
                String headerName = headerNames.nextElement();
                String headerValue = request.getHeader(headerName);
                // Skip sensitive authorization header
                if (!"authorization".equalsIgnoreCase(headerName)) {
                    bodyBuilder.append(headerName).append(": ").append(headerValue).append("\n");
                }
            }
            bodyBuilder.append("\n");
            
            // User-Agent Information
            String userAgent = request.getHeader("User-Agent");
            if (userAgent != null) {
                bodyBuilder.append("--- BROWSER/CLIENT INFORMATION ---\n");
                bodyBuilder.append("User-Agent: ").append(userAgent).append("\n");
                bodyBuilder.append("\n");
            }
            
            // Referer Information
            String referer = request.getHeader("Referer");
            if (referer != null) {
                bodyBuilder.append("--- REFERRER INFORMATION ---\n");
                bodyBuilder.append("Referer: ").append(referer).append("\n");
                bodyBuilder.append("\n");
            }
            
            bodyBuilder.append("========================================\n");
            String body = bodyBuilder.toString();
            
            // Send email for all users (including patricou)
            log.info("Attempting to send connection email for user: {}", member.getUserName());
            mailController.sendMail(subject, body);
            log.info("Connection notification - Subject: '{}' From IP: {}", subject, getIp());
            
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
            // New user - still send email notification
            log.info("New user connection detected - Username: {}", member.getUserName());
            
            String ipAddress = request.getHeader("X-Forwarded-For");
            if (ipAddress == null) {
                ipAddress = request.getRemoteAddr();
            }

            String subject = "NEW USER Connection " + member.getUserName() + " ( "+ member.getFirstName()+ " "+member.getLastName() +" )";
            
            // Build comprehensive email body with all user information
            StringBuilder bodyBuilder = new StringBuilder();
            bodyBuilder.append("========================================\n");
            bodyBuilder.append("NEW USER CONNECTION NOTIFICATION\n");
            bodyBuilder.append("========================================\n\n");
            
            // User Information
            bodyBuilder.append("--- USER INFORMATION (NEW USER) ---\n");
            bodyBuilder.append("Username: ").append(member.getUserName() != null ? member.getUserName() : "N/A").append("\n");
            bodyBuilder.append("First Name: ").append(member.getFirstName() != null ? member.getFirstName() : "N/A").append("\n");
            bodyBuilder.append("Last Name: ").append(member.getLastName() != null ? member.getLastName() : "N/A").append("\n");
            bodyBuilder.append("Email: ").append(member.getAddressEmail() != null ? member.getAddressEmail() : "N/A").append("\n");
            bodyBuilder.append("Keycloak ID: ").append(member.getKeycloakId() != null ? member.getKeycloakId() : "N/A").append("\n");
            if (member.getRoles() != null && !member.getRoles().isEmpty()) {
                bodyBuilder.append("Roles: ").append(member.getRoles()).append("\n");
            }
            bodyBuilder.append("\n");
            
            // Connection Information
            bodyBuilder.append("--- CONNECTION INFORMATION ---\n");
            bodyBuilder.append("Timestamp: ").append(java.time.LocalDateTime.now()).append("\n");
            bodyBuilder.append("Server IP: ").append(getIp()).append("\n");
            bodyBuilder.append("Client IP: ").append(ipAddress).append("\n");
            bodyBuilder.append("Request Method: ").append(request.getMethod()).append("\n");
            bodyBuilder.append("Request URI: ").append(request.getRequestURI()).append("\n");
            bodyBuilder.append("Request URL: ").append(request.getRequestURL().toString()).append("\n");
            bodyBuilder.append("Query String: ").append(request.getQueryString() != null ? request.getQueryString() : "N/A").append("\n");
            bodyBuilder.append("Protocol: ").append(request.getProtocol()).append("\n");
            bodyBuilder.append("Scheme: ").append(request.getScheme()).append("\n");
            bodyBuilder.append("Server Name: ").append(request.getServerName()).append("\n");
            bodyBuilder.append("Server Port: ").append(request.getServerPort()).append("\n");
            bodyBuilder.append("Remote Host: ").append(request.getRemoteHost()).append("\n");
            bodyBuilder.append("Remote Port: ").append(request.getRemotePort()).append("\n");
            bodyBuilder.append("\n");
            
            // Request Headers
            bodyBuilder.append("--- REQUEST HEADERS ---\n");
            Enumeration<String> headerNames = request.getHeaderNames();
            while (headerNames.hasMoreElements()) {
                String headerName = headerNames.nextElement();
                String headerValue = request.getHeader(headerName);
                // Skip sensitive authorization header
                if (!"authorization".equalsIgnoreCase(headerName)) {
                    bodyBuilder.append(headerName).append(": ").append(headerValue).append("\n");
                }
            }
            bodyBuilder.append("\n");
            
            // User-Agent Information
            String userAgent = request.getHeader("User-Agent");
            if (userAgent != null) {
                bodyBuilder.append("--- BROWSER/CLIENT INFORMATION ---\n");
                bodyBuilder.append("User-Agent: ").append(userAgent).append("\n");
                bodyBuilder.append("\n");
            }
            
            // Referer Information
            String referer = request.getHeader("Referer");
            if (referer != null) {
                bodyBuilder.append("--- REFERRER INFORMATION ---\n");
                bodyBuilder.append("Referer: ").append(referer).append("\n");
                bodyBuilder.append("\n");
            }
            
            bodyBuilder.append("========================================\n");
            String body = bodyBuilder.toString();
            
            // Send email for all users including new users (including patricou)
            log.info("Attempting to send NEW USER connection email for: {}", member.getUserName());
            mailController.sendMail(subject, body);
            log.info("NEW USER connection notification - Subject: '{}' From IP: {}", subject, getIp());
            
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
        log.info("Saving member to database...");
        Member newMember = membersRepository.save(member);
        log.info("Member saved - ID: {}", newMember.getId());
        log.info("=== END USER CONNECTION REQUEST ===\n");
        return newMember;
    }

    @RequestMapping(
            value = "/{id}",
            method = RequestMethod.GET,
            produces = { "application/json"}
            )
    public Member getMember(@PathVariable String id) {
        log.info("Get Member : " +  id );
        return membersRepository.findById(id).orElse(null);
    }

    private String getIp(){
        try{
            return InetAddress.getLocalHost().getHostAddress().toString();
        }catch(UnknownHostException e){

            return "UnknownHostException.";

        }
    }

}
