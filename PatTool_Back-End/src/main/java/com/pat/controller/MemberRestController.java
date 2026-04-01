package com.pat.controller;

import com.pat.repo.domain.Member;
import com.pat.repo.domain.UserConnectionLog;
import com.pat.repo.MembersRepository;
import com.pat.repo.UserConnectionLogRepository;
import com.pat.service.ExceptionTrackingService;
import com.pat.service.IpGeolocationService;
import com.pat.service.KeycloakService;
import com.pat.service.PositionService;
import com.pat.service.UserConnectionLogPolicy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import org.springframework.http.HttpStatus;

import jakarta.servlet.http.HttpServletRequest;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.Duration;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Optional;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

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

    @Autowired
    private KeycloakService keycloakService;

    @Autowired
    private UserConnectionLogPolicy userConnectionLogPolicy;

    @Autowired
    private PositionService positionService;

    @Value("${app.connection.email.enabled:false}")
    private boolean connectionEmailEnabled;

    @Value("${app.connection.email.min-interval-minutes:30}")
    private long connectionEmailMinIntervalMinutes;

    // In-memory throttling: last time a connection email was sent per username
    private final Map<String, LocalDateTime> lastConnectionEmailByUser = new ConcurrentHashMap<>();

    /**
     * Check if the current user has Admin role (case-insensitive)
     */
    private boolean hasAdminRole() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null) {
            return false;
        }
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(authority -> authority.equalsIgnoreCase("ROLE_Admin") || 
                                     authority.equalsIgnoreCase("ROLE_admin"));
    }

    /**
     * Get current user ID from authentication token
     */
    private String getCurrentUserId() {
        try {
            Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
            if (authentication != null && authentication.getPrincipal() instanceof Jwt) {
                Jwt jwt = (Jwt) authentication.getPrincipal();
                String keycloakId = jwt.getSubject();
                if (keycloakId != null) {
                    // Find member by keycloakId
                    List<Member> members = membersRepository.findAll();
                    Optional<Member> memberOpt = members.stream()
                            .filter(m -> keycloakId.equals(m.getKeycloakId()))
                            .findFirst();
                    if (memberOpt.isPresent()) {
                        return memberOpt.get().getId();
                    }
                }
            }
        } catch (Exception e) {
            log.debug("Error getting current user ID: {}", e.getMessage());
        }
        return null;
    }

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
        
        // CRITICAL FIX: Search by keycloakId first (more reliable and unique)
        // This prevents duplicate user creation when multiple requests arrive simultaneously
        Member memberWithId = null;
        
        if (member.getKeycloakId() != null && !member.getKeycloakId().trim().isEmpty()) {
            memberWithId = membersRepository.findByKeycloakId(member.getKeycloakId());
            log.debug("User lookup by keycloakId: {}", memberWithId != null ? "FOUND (existing user)" : "NOT FOUND");
        }
        
        // Fallback: if not found by keycloakId, try by userName (for backward compatibility)
        if (memberWithId == null && member.getUserName() != null && !member.getUserName().trim().isEmpty()) {
            memberWithId = membersRepository.findByUserName(member.getUserName());
            log.debug("User lookup by userName (fallback): {}", memberWithId != null ? "FOUND (existing user)" : "NOT FOUND");
        }
        
        log.debug("Final user lookup result: {}", memberWithId != null ? "FOUND (existing user)" : "NOT FOUND (new user)");
        
        // Update the ID
        Date now = new Date();
        if (memberWithId != null ) {
            log.debug("Existing user found - Member ID: {}", memberWithId.getId());
            member.setId(memberWithId.getId());
            
            // Preserve registration date from existing member (never overwrite)
            if (memberWithId.getRegistrationDate() != null) {
                member.setRegistrationDate(memberWithId.getRegistrationDate());
            }
            
            // Preserve keycloakId from existing member if not provided in request
            if (member.getKeycloakId() == null || member.getKeycloakId().trim().isEmpty()) {
                if (memberWithId.getKeycloakId() != null) {
                    member.setKeycloakId(memberWithId.getKeycloakId());
                }
            }
            
            // Preserve firstName from existing member if not provided in request
            if (member.getFirstName() == null || member.getFirstName().trim().isEmpty()) {
                if (memberWithId.getFirstName() != null) {
                    member.setFirstName(memberWithId.getFirstName());
                }
            }
            
            // Preserve lastName from existing member if not provided in request
            if (member.getLastName() == null || member.getLastName().trim().isEmpty()) {
                if (memberWithId.getLastName() != null) {
                    member.setLastName(memberWithId.getLastName());
                }
            }
            
            // Preserve addressEmail from existing member if not provided in request
            if (member.getAddressEmail() == null || member.getAddressEmail().trim().isEmpty()) {
                if (memberWithId.getAddressEmail() != null) {
                    member.setAddressEmail(memberWithId.getAddressEmail());
                }
            }
            
            // Update last connection date only if this is a real user connection (not an admin update)
            // If it's an admin update and the user being updated is different from the current user,
            // preserve the existing lastConnectionDate
            boolean isAdminUpdate = hasAdminRole() && 
                                   (member.getId() != null && !member.getId().equals(getCurrentUserId()));
            if (!isAdminUpdate) {
                // Normal user connection - update last connection date
                member.setLastConnectionDate(now);
            } else {
                // Admin updating another user - preserve existing lastConnectionDate
                if (memberWithId.getLastConnectionDate() != null) {
                    member.setLastConnectionDate(memberWithId.getLastConnectionDate());
                }
                log.debug("Admin update detected - preserving lastConnectionDate for user {}", member.getUserName());
            }
            
            // Preserve locale from existing member if not provided in request
            if (member.getLocale() == null || member.getLocale().trim().isEmpty()) {
                if (memberWithId.getLocale() != null) {
                    member.setLocale(memberWithId.getLocale());
                }
            }
            
            // Preserve whatsappLink from existing member if not provided in request
            // This prevents the whatsappLink from being cleared when user logs in/connects
            if (member.getWhatsappLink() == null || member.getWhatsappLink().trim().isEmpty()) {
                if (memberWithId.getWhatsappLink() != null) {
                    member.setWhatsappLink(memberWithId.getWhatsappLink());
                }
            }
            
            // Preserve visible flag from existing member if not provided in request
            // This prevents the visible flag from being reset when user logs in/connects
            if (member.getVisible() == null) {
                // If visible is not provided in request, preserve the existing value from DB
                // If existing value is null (old record without field), default to true
                Boolean existingVisible = memberWithId.getVisible();
                member.setVisible(existingVisible != null ? existingVisible : true);
            }
            // If visible is provided in request (admin update), use the provided value
            
            // CRITICAL: Preserve existing positions from database before adding new one
            if (memberWithId.getPositions() != null && !memberWithId.getPositions().isEmpty()) {
                member.setPositions(new java.util.ArrayList<>(memberWithId.getPositions()));
                log.debug("Preserved {} existing positions for user {}", memberWithId.getPositions().size(), member.getUserName());
            }
            
            // Handle roles: preserve from request if provided (admin update), otherwise preserve existing or fetch from Keycloak
            if (member.getRoles() != null && !member.getRoles().trim().isEmpty()) {
                // Roles are provided in the request (likely from admin update), preserve them
                log.debug("Preserving roles from request for user {}: {}", member.getUserName(), member.getRoles());
            } else if (memberWithId.getRoles() != null && !memberWithId.getRoles().trim().isEmpty()) {
                // No roles in request but existing member has roles, preserve existing roles
                member.setRoles(memberWithId.getRoles());
                log.debug("Preserving existing roles for user {}: {}", member.getUserName(), member.getRoles());
            } else {
                // No roles in request and no existing roles, fetch from Keycloak (normal user connection)
                updateMemberRolesFromKeycloak(member);
            }

            String ipAddress = request.getHeader("X-Forwarded-For");
            if (ipAddress == null) {
                ipAddress = request.getRemoteAddr();
            }

            maybeSendConnectionEmail(member, ipAddress, false);
            
            // Track connection for periodic reporting
            String rolesStr = (member.getRoles() != null && !member.getRoles().isEmpty()) ? member.getRoles().toString() : null;
            String userAgent = request.getHeader("User-Agent");
            String referer = request.getHeader("Referer");
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
            // Set visibility to true by default for new users
            if (member.getVisible() == null) {
                member.setVisible(true);
            }
            
            // Handle roles: preserve from request if provided (admin creating user), otherwise fetch from Keycloak
            if (member.getRoles() != null && !member.getRoles().trim().isEmpty()) {
                // Roles are provided in the request (likely from admin), preserve them
                log.debug("Preserving roles from request for new user {}: {}", member.getUserName(), member.getRoles());
            } else {
                // No roles in request, fetch from Keycloak (normal new user connection)
                updateMemberRolesFromKeycloak(member);
            }
            
            // New user - still send email notification
            log.debug("New user connection detected - Username: {}", member.getUserName());
            
            String ipAddress = request.getHeader("X-Forwarded-For");
            if (ipAddress == null) {
                ipAddress = request.getRemoteAddr();
            }

            maybeSendConnectionEmail(member, ipAddress, true);
            
            // Track connection for periodic reporting
            String rolesStr = (member.getRoles() != null && !member.getRoles().isEmpty()) ? member.getRoles().toString() : null;
            String userAgent = request.getHeader("User-Agent");
            String referer = request.getHeader("Referer");
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

        // CRITICAL FIX: Double-check for race condition before saving
        // If another request created the user between our lookup and save, find and update it instead
        Member existingMember = null;
        if (member.getKeycloakId() != null && !member.getKeycloakId().trim().isEmpty()) {
            existingMember = membersRepository.findByKeycloakId(member.getKeycloakId());
        }
        if (existingMember == null && member.getUserName() != null && !member.getUserName().trim().isEmpty()) {
            existingMember = membersRepository.findByUserName(member.getUserName());
        }
        
        if (existingMember != null && memberWithId == null) {
            // Race condition detected: user was created by another request between our lookup and save
            log.warn("Race condition detected: User {} (keycloakId: {}) was created by another request. Updating existing user instead of creating duplicate.", 
                    member.getUserName(), member.getKeycloakId());
            member.setId(existingMember.getId());
            // Preserve existing registration date
            if (existingMember.getRegistrationDate() != null) {
                member.setRegistrationDate(existingMember.getRegistrationDate());
            }
            // Update last connection date
            member.setLastConnectionDate(now);
            // Preserve other existing fields if not provided
            if (member.getFirstName() == null || member.getFirstName().trim().isEmpty()) {
                if (existingMember.getFirstName() != null) {
                    member.setFirstName(existingMember.getFirstName());
                }
            }
            if (member.getLastName() == null || member.getLastName().trim().isEmpty()) {
                if (existingMember.getLastName() != null) {
                    member.setLastName(existingMember.getLastName());
                }
            }
            if (member.getAddressEmail() == null || member.getAddressEmail().trim().isEmpty()) {
                if (existingMember.getAddressEmail() != null) {
                    member.setAddressEmail(existingMember.getAddressEmail());
                }
            }
            if (member.getLocale() == null || member.getLocale().trim().isEmpty()) {
                if (existingMember.getLocale() != null) {
                    member.setLocale(existingMember.getLocale());
                }
            }
            if (member.getWhatsappLink() == null || member.getWhatsappLink().trim().isEmpty()) {
                if (existingMember.getWhatsappLink() != null) {
                    member.setWhatsappLink(existingMember.getWhatsappLink());
                }
            }
            // Preserve visible flag from existing member
            if (member.getVisible() == null) {
                member.setVisible(existingMember.getVisible());
            }
            // CRITICAL: Preserve existing positions from database before adding new one
            if (existingMember.getPositions() != null && !existingMember.getPositions().isEmpty()) {
                member.setPositions(new java.util.ArrayList<>(existingMember.getPositions()));
                log.debug("Preserved {} existing positions for user {}", existingMember.getPositions().size(), member.getUserName());
            }
            // Handle roles
            if (member.getRoles() == null || member.getRoles().trim().isEmpty()) {
                if (existingMember.getRoles() != null && !existingMember.getRoles().trim().isEmpty()) {
                    member.setRoles(existingMember.getRoles());
                } else {
                    updateMemberRolesFromKeycloak(member);
                }
            }
        }

        // Handle position storage before saving member
        try {
            String ipAddress = request.getHeader("X-Forwarded-For");
            if (ipAddress == null) {
                ipAddress = request.getRemoteAddr();
            }
            
            // Check if GPS coordinates were provided in the request
            if (member.getRequestLatitude() != null && member.getRequestLongitude() != null) {
                // GPS position provided - use it
                positionService.addGpsPosition(member, member.getRequestLatitude(), member.getRequestLongitude());
                log.debug("Added GPS position for user {}: lat={}, lon={}", member.getUserName(), 
                    member.getRequestLatitude(), member.getRequestLongitude());
            } else if (ipAddress != null && !ipAddress.trim().isEmpty() && !shouldSkipConnectionLog(ipAddress)) {
                // No GPS coordinates - try to get position from IP
                positionService.addIpPosition(member, ipAddress);
                log.debug("Attempted to add IP position for user {} from IP: {}", member.getUserName(), ipAddress);
            }
        } catch (Exception e) {
            log.warn("Error adding position for user {}: {}", member.getUserName(), e.getMessage());
            // Don't fail the connection if position storage fails
        }

        // Save the member in Mlab ( if modif ( like email or... ) ( userName is unqiue )
        log.debug("Saving member to database...");
        Member newMember = membersRepository.save(member);
        log.debug("Member saved - ID: {}", newMember.getId());
        
        // Save connection log to MongoDB (skip if IP contains 0:0:0:0:0:0 or similar invalid patterns)
        try {
            // Skip saving connection log for excluded users (e.g., patricou)
            if (!userConnectionLogPolicy.shouldLog(newMember)) {
                log.debug("Skipping connection log save for excluded user: {}", newMember.getUserName());
            } else {
            String ipAddress = request.getHeader("X-Forwarded-For");
            if (ipAddress == null) {
                ipAddress = request.getRemoteAddr();
            }
            
            // Skip saving connection log if IP contains invalid patterns (0:0:0:0:0:0, ::, etc.)
            if (shouldSkipConnectionLog(ipAddress)) {
                log.debug("Skipping connection log save for user: {} - Invalid IP pattern: {}", newMember.getUserName(), ipAddress);
            } else {
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
            }
            }
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

    /**
     * Delete a single position for a member by index
     * Users can only delete their own positions, unless they are admin
     */
    @RequestMapping(
            value = "/{memberId}/positions/{positionIndex}",
            method = RequestMethod.DELETE,
            produces = { "application/json"}
    )
    public ResponseEntity<?> deletePosition(@PathVariable String memberId, @PathVariable int positionIndex) {
        log.debug("Delete position {} for member: {}", positionIndex, memberId);

        try {
            Member member = membersRepository.findById(memberId).orElse(null);
            if (member == null) {
                log.warn("Member not found: {}", memberId);
                return ResponseEntity.status(HttpStatus.NOT_FOUND).body("Member not found");
            }

            String currentUserId = getCurrentUserId();
            boolean isAdmin = hasAdminRole();
            if (!isAdmin && (currentUserId == null || !currentUserId.equals(memberId))) {
                log.warn("Unauthorized attempt to delete position for member {} by user {}", memberId, currentUserId);
                return ResponseEntity.status(HttpStatus.FORBIDDEN).body("You can only delete your own positions");
            }

            if (member.getPositions() == null || positionIndex < 0 || positionIndex >= member.getPositions().size()) {
                log.warn("Invalid position index {} for member {}", positionIndex, memberId);
                return ResponseEntity.status(HttpStatus.BAD_REQUEST).body("Invalid position index");
            }

            member.getPositions().remove(positionIndex);
            membersRepository.save(member);
            log.info("Deleted position {} for member {}", positionIndex, memberId);

            return ResponseEntity.ok(member);

        } catch (Exception e) {
            log.error("Error deleting position for member {}: {}", memberId, e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("Error deleting position: " + e.getMessage());
        }
    }

    /**
     * Delete all positions for a member
     * Users can only delete their own positions, unless they are admin
     * @param memberId The ID of the member whose positions should be deleted
     * @return ResponseEntity with the updated member or error status
     */
    @RequestMapping(
            value = "/{memberId}/positions",
            method = RequestMethod.DELETE,
            produces = { "application/json"}
    )
    public ResponseEntity<?> deleteAllPositions(@PathVariable String memberId) {
        log.debug("Delete all positions for member: {}", memberId);
        
        try {
            // Get the member
            Member member = membersRepository.findById(memberId).orElse(null);
            if (member == null) {
                log.warn("Member not found: {}", memberId);
                return ResponseEntity.status(HttpStatus.NOT_FOUND).body("Member not found");
            }
            
            // Check authorization: user can only delete their own positions, unless they are admin
            String currentUserId = getCurrentUserId();
            boolean isAdmin = hasAdminRole();
            
            if (!isAdmin && (currentUserId == null || !currentUserId.equals(memberId))) {
                log.warn("Unauthorized attempt to delete positions for member {} by user {}", memberId, currentUserId);
                return ResponseEntity.status(HttpStatus.FORBIDDEN).body("You can only delete your own positions");
            }
            
            // Clear all positions
            if (member.getPositions() != null) {
                int positionCount = member.getPositions().size();
                member.setPositions(new ArrayList<>());
                membersRepository.save(member);
                log.info("Deleted {} positions for member {}", positionCount, memberId);
            } else {
                log.debug("No positions to delete for member {}", memberId);
            }
            
            return ResponseEntity.ok(member);
            
        } catch (Exception e) {
            log.error("Error deleting positions for member {}: {}", memberId, e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("Error deleting positions: " + e.getMessage());
        }
    }

    /**
     * Update member roles from Keycloak
     * Primary method: Extract from JWT token (more reliable, no additional config needed)
     * Fallback: Try Admin API if JWT doesn't have roles
     * @param member The member to update
     */
    private void updateMemberRolesFromKeycloak(Member member) {
        if (member.getKeycloakId() == null || member.getKeycloakId().trim().isEmpty()) {
            log.debug("No Keycloak ID available, skipping role update");
            member.setRoles("");
            return;
        }

        List<String> roles = new ArrayList<>();
        
        // PRIMARY METHOD: Try to extract from JWT token first (most reliable)
        try {
            Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
            if (authentication != null && authentication.getPrincipal() instanceof Jwt) {
                Jwt jwt = (Jwt) authentication.getPrincipal();
                log.debug("Attempting to extract roles from JWT token for user: {}", member.getKeycloakId());
                List<String> jwtRoles = keycloakService.extractRolesFromJwt(jwt);
                if (jwtRoles != null && !jwtRoles.isEmpty()) {
                    roles = jwtRoles;
                    log.debug("Successfully extracted {} roles from JWT token: {}", roles.size(), roles);
                } else {
                    log.warn("JWT token contains no roles for user: {}", member.getKeycloakId());
                }
            } else {
                log.debug("No JWT token available in SecurityContext for user: {}", member.getKeycloakId());
            }
        } catch (Exception e) {
            log.error("Error extracting roles from JWT token for user {}: {}", member.getKeycloakId(), e.getMessage(), e);
        }
        
        // FALLBACK: If JWT didn't provide roles, try Admin API (requires service account configuration)
        if (roles.isEmpty()) {
            try {
                log.debug("JWT extraction failed, attempting to fetch roles from Keycloak Admin API for user: {}", member.getKeycloakId());
                List<String> adminRoles = keycloakService.getUserRoles(member.getKeycloakId());
                if (adminRoles != null && !adminRoles.isEmpty()) {
                    roles = adminRoles;
                    log.debug("Successfully fetched {} roles from Admin API: {}", roles.size(), roles);
                } else {
                    log.warn("Admin API returned no roles for user: {}", member.getKeycloakId());
                }
            } catch (Exception e) {
                log.warn("Admin API failed for user {} (this is expected if service account is not configured): {}", 
                        member.getKeycloakId(), e.getMessage());
                // Don't log full stack trace for 401 errors as they're expected without proper config
                if (!e.getMessage().contains("401") && !e.getMessage().contains("Unauthorized")) {
                    log.error("Unexpected error from Admin API: {}", e.getMessage(), e);
                }
            }
        }
        
        // Update member roles
        if (!roles.isEmpty()) {
            String rolesString = String.join(", ", roles);
            member.setRoles(rolesString);
            log.debug("Updated member roles for user {}: {}", member.getKeycloakId(), rolesString);
        } else {
            log.warn("No roles found for user {} - ensure roles are included in JWT token or configure Admin API service account", member.getKeycloakId());
            member.setRoles("");
        }
    }


    private String getIp(){
        try{
            return InetAddress.getLocalHost().getHostAddress().toString();
        }catch(UnknownHostException e){

            return "UnknownHostException.";

        }
    }

    /**
     * Decide if we should actually send a connection email and do throttling.
     */
    private void maybeSendConnectionEmail(Member member, String ipAddress, boolean isNewUser) {
        if (!connectionEmailEnabled) {
            log.debug("Connection email disabled via configuration - skipping send for user: {}", member != null ? member.getUserName() : "null");
            return;
        }

        if (member == null || member.getUserName() == null) {
            log.debug("Connection email skipped - member or username is null");
            return;
        }

        if (isConnectionEmailExcludedForUser(member)) {
            log.debug("Connection email skipped for excluded user: {}", member.getUserName());
            return;
        }

        if (shouldExcludeEmail(ipAddress)) {
            log.debug("Connection email skipped for user {} - excluded IP: {}", member.getUserName(), ipAddress);
            return;
        }

        String username = member.getUserName();
        LocalDateTime nowTime = LocalDateTime.now();
        LocalDateTime lastSent = lastConnectionEmailByUser.get(username);

        if (!isNewUser && lastSent != null) {
            long minutesSinceLast = Duration.between(lastSent, nowTime).toMinutes();
            if (minutesSinceLast < connectionEmailMinIntervalMinutes) {
                log.debug("Connection email throttled for user {} (last sent {} minutes ago, min interval {} minutes)",
                        username, minutesSinceLast, connectionEmailMinIntervalMinutes);
                return;
            }
        }

        String subjectPrefix = isNewUser ? "PatTool - New User Connection - " : "PatTool - User Connection - ";
        String subject = subjectPrefix + formatDateTime(nowTime);
        String body = generateConnectionEmailBody(member, ipAddress, isNewUser);

        log.debug("Attempting to send connection email for user: {}", username);
        mailController.sendMail(subject, body, false);
        lastConnectionEmailByUser.put(username, nowTime);
        log.debug("Connection notification sent for user {} - Subject: '{}'", username, subject);
    }

    /**
     * Generate a simplified plain text email body for user connection notifications.
     */
    private String generateConnectionEmailBody(Member member, String ipAddress, boolean isNewUser) {
        StringBuilder bodyBuilder = new StringBuilder();

        bodyBuilder.append(isNewUser ? "NEW USER CONNECTION" : "USER CONNECTION").append("\n");
        bodyBuilder.append("====================================\n\n");

        // User Information Section (short)
        bodyBuilder.append("User\n");
        bodyBuilder.append("----\n");
        bodyBuilder.append("Username : ").append(member.getUserName() != null ? member.getUserName() : "N/A").append("\n");
        bodyBuilder.append("First    : ").append(member.getFirstName() != null ? member.getFirstName() : "N/A").append("\n");
        bodyBuilder.append("Last     : ").append(member.getLastName() != null ? member.getLastName() : "N/A").append("\n");
        bodyBuilder.append("Email    : ").append(member.getAddressEmail() != null ? member.getAddressEmail() : "N/A").append("\n");
        bodyBuilder.append("\n");

        // Connection Information Section (condensed, no Google Maps link)
        bodyBuilder.append("Connection\n");
        bodyBuilder.append("----------\n");
        bodyBuilder.append("Timestamp : ").append(formatDateTime(LocalDateTime.now())).append("\n");
        bodyBuilder.append("Client IP : ").append(ipAddress).append("\n");
        
        IpGeolocationService.ExtendedIPInfo ipInfo = ipGeolocationService.getCompleteIpInfoWithCoordinates(ipAddress);
        String locationText = ipInfo != null ? ipInfo.getLocation() : null;
        String domainName = ipInfo != null ? ipInfo.getDomainName() : null;
        bodyBuilder.append("Location  : ").append(locationText != null ? locationText : "N/A").append("\n");
        bodyBuilder.append("Domain    : ").append(domainName != null && !domainName.isEmpty() ? domainName : "N/A").append("\n");

        // GPS / coordinates details: prefer smartphone GPS, fallback to IP-based coordinates
        Double lat = member.getRequestLatitude();
        Double lon = member.getRequestLongitude();
        String gpsCoords = null;
        String googleMapsLink = null;
        String coordsSourceLabel = null;

        if (lat != null && lon != null) {
            gpsCoords = String.format(java.util.Locale.ENGLISH, "%.6f, %.6f", lat, lon);
            googleMapsLink = "https://www.google.com/maps?q=" + lat + "," + lon;
            coordsSourceLabel = "GPS from browser (smartphone)";
        } else if (ipInfo != null && ipInfo.getLatitude() != null && ipInfo.getLongitude() != null) {
            lat = ipInfo.getLatitude();
            lon = ipInfo.getLongitude();
            gpsCoords = String.format(java.util.Locale.ENGLISH, "%.6f, %.6f", lat, lon);
            googleMapsLink = "https://www.google.com/maps?q=" + lat + "," + lon;
            coordsSourceLabel = "Approximate location from IP";
        }

        if (gpsCoords != null && googleMapsLink != null && coordsSourceLabel != null) {
            bodyBuilder.append("Coords   : ").append(gpsCoords)
                    .append("  (").append(coordsSourceLabel).append(")").append("\n");
            bodyBuilder.append("Map     : ").append(googleMapsLink).append("\n");

            // Try to reverse geocode GPS coordinates to a human readable address
            String fullAddress = ipGeolocationService.getAddressFromCoordinates(lat, lon);
            if (fullAddress != null && !fullAddress.isEmpty()) {
                bodyBuilder.append("Address  : ").append(fullAddress).append("\n");
            }
        }

        bodyBuilder.append("\nThis is an automated notification from the PatTool application.");
        if (isNewUser) {
            bodyBuilder.append(" User was created on first connection.");
        }

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
     * Whether connection email should not be sent for this user.
     * Currently, connection emails are sent for all users.
     */
    private boolean isConnectionEmailExcludedForUser(Member member) {
        return false;
    }

    /**
     * Check if USER CONNECTION email should be excluded based on client IP.
     * NOTE: This method is ONLY used for user connection emails, NOT for exception reports.
     * Exception reports are sent independently and are not affected by this check.
     *
     * @param clientIpAddress The client IP address to check (may contain multiple IPs separated by commas)
     * @return true if email should be excluded, false otherwise
     */
    private boolean shouldExcludeEmail(String clientIpAddress) {
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

    /**
     * Check if connection log should be skipped based on IP address
     * Skips IPs containing invalid patterns like 0:0:0:0:0:0, ::, 0:0:0:0:0:0:0:0, etc.
     * @param ipAddress The IP address to check (may contain multiple IPs separated by commas)
     * @return true if connection log should be skipped, false otherwise
     */
    private boolean shouldSkipConnectionLog(String ipAddress) {
        if (ipAddress == null || ipAddress.isEmpty()) {
            return false;
        }
        
        // Handle X-Forwarded-For which may contain multiple IPs separated by commas
        String[] ips = ipAddress.split(",");
        for (String ip : ips) {
            String trimmedIp = ip.trim();
            // Check for IPv6 patterns containing 0:0:0:0:0:0 or similar invalid patterns
            if (trimmedIp.contains("0:0:0:0:0:0") || 
                trimmedIp.equals("::") || 
                trimmedIp.equals("0:0:0:0:0:0:0:0") ||
                trimmedIp.equals("::1") ||
                trimmedIp.startsWith("0:0:0:0:0:0")) {
                return true;
            }
        }
        
        return false;
    }

}
