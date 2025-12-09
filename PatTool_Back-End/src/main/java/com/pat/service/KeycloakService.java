package com.pat.service;

import org.keycloak.admin.client.Keycloak;
import org.keycloak.admin.client.KeycloakBuilder;
import org.keycloak.admin.client.resource.RealmResource;
import org.keycloak.admin.client.resource.UserResource;
import org.keycloak.representations.idm.RoleRepresentation;
import org.keycloak.representations.idm.UserRepresentation;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Service for interacting with Keycloak Admin API
 */
@Service
public class KeycloakService {

    private static final Logger log = LoggerFactory.getLogger(KeycloakService.class);

    @Value("${keycloak.auth-server-url}")
    private String keycloakServerUrl;

    @Value("${keycloak.realm}")
    private String realm;

    @Value("${keycloak.resource}")
    private String clientId;

    @Value("${keycloak.credentials.secret}")
    private String clientSecret;

    /**
     * Get user roles from Keycloak by keycloakId
     * @param keycloakId The Keycloak user ID (subject from JWT)
     * @return List of role names (realm roles and client roles)
     */
    public List<String> getUserRoles(String keycloakId) {
        List<String> roles = new ArrayList<>();
        
        log.debug("Attempting to fetch roles from Keycloak for user ID: {}", keycloakId);
        log.debug("Keycloak configuration - Server: {}, Realm: {}, ClientId: {}", keycloakServerUrl, realm, clientId);
        
        try {
            // Create Keycloak admin client
            log.debug("Creating Keycloak admin client...");
            Keycloak keycloak = KeycloakBuilder.builder()
                    .serverUrl(keycloakServerUrl)
                    .realm(realm)
                    .clientId(clientId)
                    .clientSecret(clientSecret)
                    .grantType("client_credentials")
                    .build();

            log.debug("Keycloak admin client created successfully");

            // Get realm resource
            RealmResource realmResource = keycloak.realm(realm);
            log.debug("Realm resource obtained for realm: {}", realm);
            
            // Find user by ID
            UserResource userResource;
            try {
                log.debug("Attempting to get user resource for ID: {}", keycloakId);
                userResource = realmResource.users().get(keycloakId);
                
                // Try to get user representation to verify user exists
                log.debug("Getting user representation...");
                UserRepresentation userRep = userResource.toRepresentation();
                if (userRep == null) {
                    log.warn("User not found in Keycloak with ID: {}", keycloakId);
                    return roles;
                }
                log.debug("User found - Username: {}, Email: {}", userRep.getUsername(), userRep.getEmail());
            } catch (Exception e) {
                // Check if it's an authentication/authorization error (expected when service account is not configured)
                String errorMsg = e.getMessage() != null ? e.getMessage() : "";
                String exceptionName = e.getClass().getSimpleName();
                boolean isAuthError = errorMsg.contains("401") || errorMsg.contains("403") || 
                                     errorMsg.contains("Unauthorized") || errorMsg.contains("Forbidden") ||
                                     exceptionName.contains("NotAuthorized") || exceptionName.contains("Forbidden");
                
                if (isAuthError) {
                    log.debug("Admin API authentication failed for user {} (expected if service account not configured): {}", 
                            keycloakId, exceptionName);
                } else if (errorMsg.contains("404") || errorMsg.contains("Not Found")) {
                    log.warn("User not found in Keycloak with ID: {} (404 error)", keycloakId);
                } else {
                    log.error("Error accessing user in Keycloak with ID {}: {}", keycloakId, e.getMessage(), e);
                }
                return roles;
            }

            // Get realm roles
            try {
                log.debug("Fetching realm-level roles...");
                List<RoleRepresentation> realmRoles = userResource.roles().realmLevel().listAll();
                if (realmRoles != null) {
                    log.debug("Found {} realm roles", realmRoles.size());
                    roles.addAll(realmRoles.stream()
                            .map(RoleRepresentation::getName)
                            .peek(roleName -> log.debug("  - Realm role: {}", roleName))
                            .collect(Collectors.toList()));
                } else {
                    log.debug("No realm roles found (list is null)");
                }
            } catch (Exception e) {
                String errorMsg = e.getMessage() != null ? e.getMessage() : "";
                boolean isAuthError = errorMsg.contains("401") || errorMsg.contains("403") || 
                                     errorMsg.contains("Unauthorized") || errorMsg.contains("Forbidden");
                if (isAuthError) {
                    log.debug("Admin API authentication failed while fetching realm roles (expected): {}", 
                            e.getClass().getSimpleName());
                } else {
                    log.error("Could not fetch realm roles for user {}: {}", keycloakId, e.getMessage(), e);
                }
            }

            // Get client roles - try all clients, not just the main client
            try {
                log.debug("Fetching client-level roles...");
                
                // First, try the configured client
                String clientUuid = realmResource.clients()
                        .findByClientId(clientId)
                        .stream()
                        .findFirst()
                        .map(client -> {
                            log.debug("Found client {} with UUID: {}", clientId, client.getId());
                            return client.getId();
                        })
                        .orElse(null);

                if (clientUuid != null) {
                    log.debug("Fetching roles for client: {} (UUID: {})", clientId, clientUuid);
                    List<RoleRepresentation> clientRoles = userResource.roles()
                            .clientLevel(clientUuid)
                            .listAll();
                    if (clientRoles != null) {
                        log.debug("Found {} client roles for client {}", clientRoles.size(), clientId);
                        roles.addAll(clientRoles.stream()
                                .map(RoleRepresentation::getName)
                                .peek(roleName -> log.debug("  - Client role ({}): {}", clientId, roleName))
                                .collect(Collectors.toList()));
                    }
                } else {
                    log.warn("Client {} not found in realm", clientId);
                }
                
                // Also try to get roles from realm-management client (admin roles)
                try {
                    String realmManagementUuid = realmResource.clients()
                            .findByClientId("realm-management")
                            .stream()
                            .findFirst()
                            .map(client -> client.getId())
                            .orElse(null);
                    
                    if (realmManagementUuid != null) {
                        log.debug("Fetching roles from realm-management client...");
                        List<RoleRepresentation> adminRoles = userResource.roles()
                                .clientLevel(realmManagementUuid)
                                .listAll();
                        if (adminRoles != null && !adminRoles.isEmpty()) {
                            log.debug("Found {} admin roles", adminRoles.size());
                            roles.addAll(adminRoles.stream()
                                    .map(RoleRepresentation::getName)
                                    .peek(roleName -> log.debug("  - Admin role: {}", roleName))
                                    .collect(Collectors.toList()));
                        }
                    }
                } catch (Exception e) {
                    log.debug("Could not fetch realm-management roles: {}", e.getMessage());
                }
                
            } catch (Exception e) {
                String errorMsg = e.getMessage() != null ? e.getMessage() : "";
                boolean isAuthError = errorMsg.contains("401") || errorMsg.contains("403") || 
                                     errorMsg.contains("Unauthorized") || errorMsg.contains("Forbidden");
                if (isAuthError) {
                    log.debug("Admin API authentication failed while fetching client roles (expected): {}", 
                            e.getClass().getSimpleName());
                } else {
                    log.error("Could not fetch client roles for user {}: {}", keycloakId, e.getMessage(), e);
                }
            }

            log.debug("Total roles found for user {}: {}", keycloakId, roles.size());
            if (roles.isEmpty()) {
                log.warn("No roles found for user {} - this might indicate a configuration issue", keycloakId);
            }
            
        } catch (Exception e) {
            // Check if it's an authentication/authorization error (expected when service account is not configured)
            String errorMsg = e.getMessage() != null ? e.getMessage() : "";
            String exceptionName = e.getClass().getSimpleName();
            boolean isAuthError = errorMsg.contains("401") || errorMsg.contains("403") || 
                                 errorMsg.contains("Unauthorized") || errorMsg.contains("Forbidden") ||
                                 exceptionName.contains("NotAuthorized") || exceptionName.contains("Forbidden");
            
            if (isAuthError) {
                log.debug("Admin API authentication failed for user {} (expected if service account not configured): {}", 
                        keycloakId, exceptionName);
            } else {
                log.error("Error fetching roles from Keycloak for user {}: {}", keycloakId, e.getMessage(), e);
                log.error("Exception type: {}, Cause: {}", e.getClass().getName(), 
                        e.getCause() != null ? e.getCause().getMessage() : "none");
            }
        }
        
        return roles;
    }

    /**
     * Extract roles from JWT token claims
     * This is the primary method as it doesn't require Admin API configuration
     * @param jwt The JWT token
     * @return List of role names
     */
    public List<String> extractRolesFromJwt(Jwt jwt) {
        List<String> roles = new ArrayList<>();
        
        if (jwt == null) {
            log.warn("JWT token is null");
            return roles;
        }
        
        try {
            log.debug("Extracting roles from JWT token. Available claims: {}", jwt.getClaims().keySet());
            
            // Get realm roles from realm_access claim
            Object realmAccess = jwt.getClaim("realm_access");
            if (realmAccess != null) {
                log.debug("Found realm_access claim in JWT");
                if (realmAccess instanceof java.util.Map) {
                    @SuppressWarnings("unchecked")
                    java.util.Map<String, Object> realmAccessMap = (java.util.Map<String, Object>) realmAccess;
                    Object rolesObj = realmAccessMap.get("roles");
                    if (rolesObj instanceof java.util.List) {
                        @SuppressWarnings("unchecked")
                        java.util.List<String> realmRoles = (java.util.List<String>) rolesObj;
                        roles.addAll(realmRoles);
                        log.debug("Extracted {} realm roles from JWT: {}", realmRoles.size(), realmRoles);
                    } else {
                        log.debug("realm_access.roles is not a List (type: {})", 
                                rolesObj != null ? rolesObj.getClass().getName() : "null");
                    }
                } else {
                    log.debug("realm_access is not a Map (type: {})", realmAccess.getClass().getName());
                }
            } else {
                log.debug("No realm_access claim found in JWT token");
            }
            
            // Get client roles from resource_access claim
            Object resourceAccess = jwt.getClaim("resource_access");
            if (resourceAccess != null) {
                log.debug("Found resource_access claim in JWT");
                if (resourceAccess instanceof java.util.Map) {
                    @SuppressWarnings("unchecked")
                    java.util.Map<String, Object> resourceAccessMap = (java.util.Map<String, Object>) resourceAccess;
                    
                    log.debug("Found {} clients in resource_access", resourceAccessMap.size());
                    
                    // Check all clients in resource_access
                    for (java.util.Map.Entry<String, Object> entry : resourceAccessMap.entrySet()) {
                        String clientId = entry.getKey();
                        Object clientValue = entry.getValue();
                        
                        if (clientValue instanceof java.util.Map) {
                            @SuppressWarnings("unchecked")
                            java.util.Map<String, Object> clientAccess = (java.util.Map<String, Object>) clientValue;
                            Object rolesObj = clientAccess.get("roles");
                            if (rolesObj instanceof java.util.List) {
                                @SuppressWarnings("unchecked")
                                java.util.List<String> clientRoles = (java.util.List<String>) rolesObj;
                                roles.addAll(clientRoles);
                                log.debug("Extracted {} roles from client '{}' in JWT: {}", 
                                        clientRoles.size(), clientId, clientRoles);
                            } else {
                                log.debug("Client '{}' has no roles list (type: {})", 
                                        clientId, rolesObj != null ? rolesObj.getClass().getName() : "null");
                            }
                        } else {
                            log.debug("Client '{}' value is not a Map (type: {})", 
                                    clientId, clientValue.getClass().getName());
                        }
                    }
                } else {
                    log.debug("resource_access is not a Map (type: {})", resourceAccess.getClass().getName());
                }
            } else {
                log.debug("No resource_access claim found in JWT token");
            }
            
            // Also check for direct 'roles' claim (some configurations)
            Object directRoles = jwt.getClaim("roles");
            if (directRoles instanceof java.util.List) {
                @SuppressWarnings("unchecked")
                java.util.List<String> directRolesList = (java.util.List<String>) directRoles;
                roles.addAll(directRolesList);
                log.debug("Extracted {} roles from direct 'roles' claim: {}", 
                        directRolesList.size(), directRolesList);
            }
            
            // Filter out default Keycloak system roles if desired
            List<String> filteredRoles = filterSystemRoles(roles);
            
            log.debug("Total roles extracted from JWT token: {} ({} after filtering system roles) - {}", 
                    roles.size(), filteredRoles.size(), filteredRoles);
            
            if (filteredRoles.isEmpty() && !roles.isEmpty()) {
                log.debug("All extracted roles were filtered out as system roles");
            } else if (filteredRoles.isEmpty()) {
                log.warn("No roles found in JWT token. Available claims: {}. " +
                        "Ensure 'roles' scope is included in client configuration and mappers are set up correctly.", 
                        jwt.getClaims().keySet());
            }
            
            return filteredRoles;
            
        } catch (Exception e) {
            log.error("Error extracting roles from JWT: {}", e.getMessage(), e);
        }
        
        return roles;
    }

    /**
     * Filter out default Keycloak system roles that are not meaningful user roles
     * @param roles List of all roles
     * @return Filtered list with only meaningful user roles
     */
    private List<String> filterSystemRoles(List<String> roles) {
        if (roles == null || roles.isEmpty()) {
            return new ArrayList<>();
        }
        
        // Default Keycloak system roles to filter out
        List<String> systemRoles = List.of(
            "uma_authorization",
            "manage-account",
            "manage-account-links",
            "view-profile",
            "offline_access"  // OAuth2 offline access token role
        );
        
        return roles.stream()
                .filter(role -> !systemRoles.contains(role))
                .collect(Collectors.toList());
    }

    /**
     * Get user roles from Keycloak by username
     * @param username The Keycloak username
     * @return List of role names (realm roles and client roles)
     */
    public List<String> getUserRolesByUsername(String username) {
        List<String> roles = new ArrayList<>();
        
        try {
            // Create Keycloak admin client
            Keycloak keycloak = KeycloakBuilder.builder()
                    .serverUrl(keycloakServerUrl)
                    .realm(realm)
                    .clientId(clientId)
                    .clientSecret(clientSecret)
                    .grantType("client_credentials")
                    .build();

            // Get realm resource
            RealmResource realmResource = keycloak.realm(realm);
            
            // Find user by username
            List<UserRepresentation> users = realmResource.users().searchByUsername(username, true);
            if (users == null || users.isEmpty()) {
                log.warn("User not found in Keycloak with username: {}", username);
                return roles;
            }

            UserRepresentation user = users.get(0);
            String keycloakId = user.getId();
            
            // Get roles using the keycloakId
            return getUserRoles(keycloakId);
            
        } catch (Exception e) {
            log.error("Error fetching roles from Keycloak for username {}: {}", username, e.getMessage(), e);
        }
        
        return roles;
    }

    /**
     * Check if a user is online (has active sessions) in Keycloak
     * @param keycloakId The Keycloak user ID
     * @return true if user has active sessions (online), false otherwise
     */
    public boolean isUserOnline(String keycloakId) {
        if (keycloakId == null || keycloakId.trim().isEmpty()) {
            log.debug("Keycloak ID is null or empty, cannot check user status");
            return false;
        }

        try {
            // Create Keycloak admin client
            Keycloak keycloak = KeycloakBuilder.builder()
                    .serverUrl(keycloakServerUrl)
                    .realm(realm)
                    .clientId(clientId)
                    .clientSecret(clientSecret)
                    .grantType("client_credentials")
                    .build();

            // Get realm resource
            RealmResource realmResource = keycloak.realm(realm);

            // Get user resource
            UserResource userResource = realmResource.users().get(keycloakId);
            
            // Check if user has active sessions
            // If getUserSessions() returns a non-empty list, user is online
            try {
                List<?> sessions = userResource.getUserSessions();
                
                boolean isOnline = sessions != null && !sessions.isEmpty();
                log.debug("User {} status: {} ({} active sessions)", keycloakId, isOnline ? "ONLINE" : "OFFLINE", 
                        sessions != null ? sessions.size() : 0);
                return isOnline;
            } catch (Exception e) {
                // If we can't get sessions, assume offline
                log.debug("Could not get user sessions for {}: {}", keycloakId, e.getMessage());
                return false;
            }

        } catch (Exception e) {
            // Check if it's an authentication/authorization error
            String errorMsg = e.getMessage() != null ? e.getMessage() : "";
            boolean isAuthError = errorMsg.contains("401") || errorMsg.contains("403") || 
                                 errorMsg.contains("Unauthorized") || errorMsg.contains("Forbidden");
            
            if (isAuthError) {
                log.debug("Admin API authentication failed while checking user status (expected): {}", 
                        e.getClass().getSimpleName());
            } else {
                log.error("Error checking user status for {}: {}", keycloakId, e.getMessage(), e);
            }
            return false;
        }
    }
}

