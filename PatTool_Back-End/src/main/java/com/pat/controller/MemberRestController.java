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
import java.time.format.FormatStyle;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
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

    /** Per-username lock so parallel POST /memb/user cannot send two connection emails in the same burst. */
    private final Map<String, Object> connectionEmailLocks = new ConcurrentHashMap<>();

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

            if (!isAdminUpdate) {
                maybeSendConnectionEmail(member, ipAddress, false, request);
            }
            
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

            maybeSendConnectionEmail(member, ipAddress, true, request);
            
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
     * Locale for the connection email: member profile first, then browser Accept-Language.
     */
    private static String resolveMailLocale(Member member, HttpServletRequest request) {
        if (member != null && member.getLocale() != null && !member.getLocale().isBlank()) {
            return member.getLocale().trim();
        }
        return parseAcceptLanguageFirstTag(request);
    }

    /**
     * First language tag from Accept-Language (e.g. {@code fr-FR,fr;q=0.9} → {@code fr-FR}).
     */
    private static String parseAcceptLanguageFirstTag(HttpServletRequest request) {
        if (request == null) {
            return null;
        }
        String al = request.getHeader("Accept-Language");
        if (al == null || al.isBlank()) {
            return null;
        }
        String first = al.split(",")[0].trim().split(";")[0].trim();
        return first.isEmpty() ? null : first;
    }

    /**
     * Decide if we should actually send a connection email and do throttling.
     * Serialized per username so concurrent logins cannot produce duplicate emails; throttling applies to new and returning users.
     */
    private void maybeSendConnectionEmail(Member member, String ipAddress, boolean isNewUser,
            HttpServletRequest request) {
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
        Object lock = connectionEmailLocks.computeIfAbsent(username, k -> new Object());
        synchronized (lock) {
            LocalDateTime nowTime = LocalDateTime.now();
            LocalDateTime lastSent = lastConnectionEmailByUser.get(username);
            if (lastSent != null) {
                long minutesSinceLast = Duration.between(lastSent, nowTime).toMinutes();
                if (minutesSinceLast < connectionEmailMinIntervalMinutes) {
                    log.debug("Connection email throttled for user {} (last sent {} minutes ago, min interval {} minutes)",
                            username, minutesSinceLast, connectionEmailMinIntervalMinutes);
                    return;
                }
            }
            lastConnectionEmailByUser.put(username, nowTime);

            String mailLocale = resolveMailLocale(member, request);
            ConnectionEmailI18n.Bundle emailI18n = ConnectionEmailI18n.bundleForMemberLocale(mailLocale);
            ConnectionEmailI18n.Texts t = emailI18n.texts();
            String subjectPrefix = isNewUser ? t.subjectPrefixNewUser() : t.subjectPrefixExistingUser();
            String subject = subjectPrefix + formatDateTime(nowTime, emailI18n.dateLocale(), t.na());
            ConnectionEmailPayload payload = buildConnectionEmailPayload(member, ipAddress, isNewUser, emailI18n, mailLocale);

            log.debug("Attempting to send connection email for user: {} (mailLocale={})", username, mailLocale);
            mailController.sendMailPlainAndHtml(subject, connectionEmailPlain(payload), connectionEmailHtml(payload));
            log.debug("Connection notification sent for user {} - Subject: '{}'", username, subject);
        }
    }

    /** Immutable content for connection notification (plain + HTML). */
    private record ConnectionEmailPayload(
            ConnectionEmailI18n.Texts texts,
            String htmlLang,
            String headline,
            String userName,
            String firstName,
            String lastName,
            String email,
            String timestamp,
            String clientIp,
            String location,
            String domain,
            String coordsLine,
            String mapUrl,
            String extraAddress,
            String footer
    ) {}

    private ConnectionEmailPayload buildConnectionEmailPayload(Member member, String ipAddress, boolean isNewUser,
            ConnectionEmailI18n.Bundle emailI18n, String mailLocale) {
        ConnectionEmailI18n.Texts t = emailI18n.texts();
        String na = t.na();
        String headline = isNewUser ? t.headlineNewUser() : t.headlineExistingUser();
        String userName = nz(member.getUserName(), na);
        String firstName = nz(member.getFirstName(), na);
        String lastName = nz(member.getLastName(), na);
        String email = nz(member.getAddressEmail(), na);
        String timestamp = formatDateTime(LocalDateTime.now(), emailI18n.dateLocale(), na);
        String clientIp = ipAddress != null ? ipAddress : na;

        IpGeolocationService.ExtendedIPInfo ipInfo = ipGeolocationService.getCompleteIpInfoWithCoordinates(ipAddress);
        String ipLocationText = ipInfo != null ? ipInfo.getLocation() : null;
        String domainName = ipInfo != null ? ipInfo.getDomainName() : null;

        Double reqLat = member.getRequestLatitude();
        Double reqLon = member.getRequestLongitude();
        String addressFromGps = null;
        if (reqLat != null && reqLon != null) {
            addressFromGps = ipGeolocationService.getAddressFromCoordinates(reqLat, reqLon);
        }
        String locationText = (addressFromGps != null && !addressFromGps.isEmpty()) ? addressFromGps : ipLocationText;
        String location = locationText != null ? locationText : na;
        String domain;
        if (domainName != null && !domainName.isEmpty()) {
            String trimmedDomain = domainName.trim();
            if (ConnectionEmailI18n.shouldReplaceConnectionEmailDomain(trimmedDomain)) {
                String lang = ConnectionEmailI18n.normalizeLangCode(mailLocale);
                domain = ConnectionEmailI18n.CONNECTION_EMAIL_PUBLIC_DOMAIN + " "
                        + ConnectionEmailI18n.domainReplacementNote(lang);
            } else {
                domain = trimmedDomain;
            }
        } else {
            domain = na;
        }

        Double lat = reqLat;
        Double lon = reqLon;
        String coordsLine = null;
        String mapUrl = null;

        if (lat != null && lon != null) {
            coordsLine = String.format(Locale.ENGLISH, "%.6f, %.6f  (%s)", lat, lon, t.coordsGpsBrowser());
            mapUrl = "https://www.google.com/maps?q=" + lat + "," + lon;
        } else if (ipInfo != null && ipInfo.getLatitude() != null && ipInfo.getLongitude() != null) {
            lat = ipInfo.getLatitude();
            lon = ipInfo.getLongitude();
            coordsLine = String.format(Locale.ENGLISH, "%.6f, %.6f  (%s)", lat, lon, t.coordsApproxFromIp());
            mapUrl = "https://www.google.com/maps?q=" + lat + "," + lon;
        }

        String extraAddress = null;
        if (coordsLine != null && mapUrl != null && lat != null && lon != null) {
            String fullAddress;
            if (reqLat != null && reqLon != null
                    && Objects.equals(lat, reqLat) && Objects.equals(lon, reqLon)
                    && addressFromGps != null && !addressFromGps.isEmpty()) {
                fullAddress = addressFromGps;
            } else {
                fullAddress = ipGeolocationService.getAddressFromCoordinates(lat, lon);
            }
            if (fullAddress != null && !fullAddress.isEmpty()
                    && (locationText == null || !fullAddress.equals(locationText))) {
                extraAddress = fullAddress;
            }
        }

        String footer = t.footerAutomated() + (isNewUser ? t.footerNewUserSuffix() : "");

        return new ConnectionEmailPayload(
                t, emailI18n.htmlLang(), headline, userName, firstName, lastName, email,
                timestamp, clientIp, location, domain, coordsLine, mapUrl, extraAddress, footer);
    }

    private static String nz(String s, String naLiteral) {
        return (s != null && !s.isEmpty()) ? s : naLiteral;
    }

    private String connectionEmailPlain(ConnectionEmailPayload p) {
        ConnectionEmailI18n.Texts t = p.texts();
        StringBuilder b = new StringBuilder();
        b.append(p.headline()).append("\n");
        b.append("====================================\n\n");
        b.append(t.sectionUser()).append("\n----\n");
        b.append(t.labelUsername()).append(" : ").append(p.userName()).append("\n");
        b.append(t.labelFirstName()).append(" : ").append(p.firstName()).append("\n");
        b.append(t.labelLastName()).append(" : ").append(p.lastName()).append("\n");
        b.append(t.labelEmail()).append(" : ").append(p.email()).append("\n\n");
        b.append(t.sectionConnection()).append("\n----------\n");
        b.append(t.labelTimestamp()).append(" : ").append(p.timestamp()).append("\n");
        b.append(t.labelClientIp()).append(" : ").append(p.clientIp()).append("\n");
        b.append(t.labelLocation()).append(" : ").append(p.location()).append("\n");
        b.append(t.labelDomain()).append(" : ").append(p.domain()).append("\n");
        if (p.coordsLine() != null) {
            b.append(t.labelCoordinates()).append(" : ").append(p.coordsLine()).append("\n");
        }
        if (p.mapUrl() != null) {
            b.append(t.labelMap()).append(" : ").append(p.mapUrl()).append("\n");
        }
        if (p.extraAddress() != null) {
            b.append(t.labelAddress()).append(" : ").append(p.extraAddress()).append("\n");
        }
        b.append("\n").append(p.footer());
        return b.toString();
    }

    /**
     * Mobile-friendly HTML: single column, readable font size, tap target for map link.
     */
    private String connectionEmailHtml(ConnectionEmailPayload p) {
        ConnectionEmailI18n.Texts t = p.texts();
        String mapButton = "";
        if (p.mapUrl() != null) {
            String safeUrl = escapeHtml(p.mapUrl());
            mapButton = "<a href=\"" + safeUrl + "\" style=\"display:inline-block;margin-top:12px;padding:14px 22px;"
                    + "background-color:#2563eb;color:#ffffff !important;text-decoration:none;border-radius:10px;"
                    + "font-size:16px;font-weight:600;line-height:1.2;\">" + escapeHtml(t.mapButton()) + "</a>";
        }
        String coordsBlock = "";
        if (p.coordsLine() != null) {
            coordsBlock = "<tr><td style=\"padding:6px 0 0 0;font-size:15px;line-height:1.45;color:#374151;\">"
                    + "<strong style=\"color:#111827;\">" + escapeHtml(t.labelCoordinates()) + "</strong><br/>"
                    + "<span style=\"word-break:break-all;\">" + escapeHtml(p.coordsLine()) + "</span></td></tr>";
        }
        String extraAddrBlock = "";
        if (p.extraAddress() != null) {
            extraAddrBlock = "<tr><td style=\"padding:10px 0 0 0;font-size:15px;line-height:1.45;color:#374151;\">"
                    + "<strong style=\"color:#111827;\">" + escapeHtml(t.labelAddress()) + "</strong><br/>"
                    + "<span style=\"word-break:break-word;\">" + escapeHtml(p.extraAddress()) + "</span></td></tr>";
        }

        return "<!DOCTYPE html><html lang=\"" + escapeHtml(p.htmlLang()) + "\"><head><meta charset=\"UTF-8\"/>"
                + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"/>"
                + "<meta http-equiv=\"X-UA-Compatible\" content=\"IE=edge\"/>"
                + "<title>" + escapeHtml(p.headline()) + "</title></head>"
                + "<body style=\"margin:0;padding:0;background-color:#f3f4f6;"
                + "-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;\">"
                + "<div style=\"display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;\">"
                + escapeHtml(p.userName() + " — " + p.headline()) + "</div>"
                + "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" "
                + "style=\"background-color:#f3f4f6;padding:16px 12px;\">"
                + "<tr><td align=\"center\">"
                + "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" "
                + "style=\"max-width:560px;margin:0 auto;background-color:#ffffff;border-radius:12px;"
                + "overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);\">"
                + "<tr><td style=\"padding:20px 20px 16px 20px;background:linear-gradient(135deg,#1e40af 0%,#2563eb 100%);\">"
                + "<h1 style=\"margin:0;font-size:20px;line-height:1.3;color:#ffffff;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;\">"
                + escapeHtml(p.headline()) + "</h1>"
                + "<p style=\"margin:8px 0 0 0;font-size:14px;line-height:1.4;color:#e0e7ff;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;\">"
                + "PatTool</p></td></tr>"
                + "<tr><td style=\"padding:20px 20px 8px 20px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;\">"
                + "<h2 style=\"margin:0 0 12px 0;font-size:15px;line-height:1.3;color:#6b7280;text-transform:uppercase;"
                + "letter-spacing:0.04em;\">" + escapeHtml(t.sectionUser()) + "</h2>"
                + "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\">"
                + rowLabelValue(t.labelUsername(), p.userName())
                + rowLabelValue(t.labelFirstName(), p.firstName())
                + rowLabelValue(t.labelLastName(), p.lastName())
                + rowLabelValue(t.labelEmail(), p.email())
                + "</table></td></tr>"
                + "<tr><td style=\"padding:8px 20px 20px 20px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;\">"
                + "<h2 style=\"margin:0 0 12px 0;font-size:15px;line-height:1.3;color:#6b7280;text-transform:uppercase;"
                + "letter-spacing:0.04em;\">" + escapeHtml(t.sectionConnection()) + "</h2>"
                + "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\">"
                + rowLabelValue(t.labelTimestamp(), p.timestamp())
                + rowLabelValue(t.labelClientIp(), p.clientIp())
                + rowLabelValue(t.labelLocation(), p.location())
                + rowLabelValue(t.labelDomain(), p.domain())
                + "</table>"
                + "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin-top:8px;\">"
                + coordsBlock
                + extraAddrBlock
                + "</table>"
                + (p.mapUrl() != null
                        ? "<div style=\"margin-top:16px;text-align:left;\">" + mapButton + "</div>"
                        : "")
                + "<p style=\"margin:20px 0 0 0;font-size:13px;line-height:1.5;color:#9ca3af;\">"
                + escapeHtml(p.footer()) + "</p>"
                + "</td></tr></table></td></tr></table></body></html>";
    }

    private String rowLabelValue(String label, String value) {
        return "<tr><td style=\"padding:8px 0;border-bottom:1px solid #f3f4f6;\">"
                + "<span style=\"display:block;font-size:13px;color:#6b7280;margin-bottom:2px;\">"
                + escapeHtml(label) + "</span>"
                + "<span style=\"display:block;font-size:16px;line-height:1.4;color:#111827;word-break:break-word;\">"
                + escapeHtml(value) + "</span></td></tr>";
    }

    private static String escapeHtml(String text) {
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
     * Format date and time using the user's locale (server timezone suffix preserved).
     */
    private String formatDateTime(LocalDateTime dateTime, Locale locale, String naLiteral) {
        if (dateTime == null) {
            return naLiteral;
        }
        ZoneId zoneId = ZoneId.systemDefault();
        String zone = zoneId.toString();
        DateTimeFormatter formatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.MEDIUM)
                .withLocale(locale);
        return dateTime.atZone(zoneId).format(formatter) + " +" + zone;
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
