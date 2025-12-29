package com.pat.config;

import com.pat.service.DiscussionConnectionService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;

import java.security.Principal;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Channel interceptor to capture authentication from STOMP CONNECT frames
 */
@Component
public class WebSocketChannelInterceptor implements ChannelInterceptor {

    private static final Logger log = LoggerFactory.getLogger(WebSocketChannelInterceptor.class);

    @Autowired
    private DiscussionConnectionService connectionService;

    @Autowired
    private JwtDecoder jwtDecoder;

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        
        if (accessor != null && accessor.getCommand() == StompCommand.CONNECT) {
            String sessionId = accessor.getSessionId();
            log.debug("STOMP CONNECT received for session: {}", sessionId);
            
            // Extract JWT token and create Authentication
            Jwt jwt = extractJwtFromConnectHeaders(accessor);
            if (jwt != null) {
                // Create JwtAuthenticationToken and set it as the user
                JwtAuthenticationToken authentication = new JwtAuthenticationToken(
                    jwt, 
                    Collections.emptyList() // Authorities can be extracted from JWT if needed
                );
                accessor.setUser(authentication);
                log.debug("Set authentication for session {} with user: {}", sessionId, 
                    jwt.getClaimAsString("preferred_username"));
            }
            
            // Extract user name for connection tracking
            String userName = extractUserNameFromConnectHeaders(accessor);
            
            if (userName != null && !userName.equals("anonymous")) {
                // Update connection with user info
                Map<String, Object> sessionAttributes = accessor.getSessionAttributes();
                String ipAddress = sessionAttributes != null ? (String) sessionAttributes.get("ipAddress") : "unknown";
                String domain = sessionAttributes != null ? (String) sessionAttributes.get("domain") : "unknown";
                String location = extractLocation(ipAddress);
                
                log.debug("Updating connection {} with user: {}", sessionId, userName);
                connectionService.updateConnectionUser(sessionId, userName, ipAddress, domain, location);
            }
        }
        
        return message;
    }

    /**
     * Extract JWT from STOMP CONNECT headers
     */
    private Jwt extractJwtFromConnectHeaders(StompHeaderAccessor accessor) {
        try {
            // Get native headers which contain STOMP connect headers
            Map<String, List<String>> nativeHeaders = accessor.toNativeHeaderMap();
            if (nativeHeaders != null) {
                // Check for Authorization header (case insensitive)
                for (String key : nativeHeaders.keySet()) {
                    if (key != null && key.toLowerCase().equals("authorization")) {
                        List<String> authHeaders = nativeHeaders.get(key);
                        if (authHeaders != null && !authHeaders.isEmpty()) {
                            String authHeader = authHeaders.get(0);
                            if (authHeader != null && authHeader.startsWith("Bearer ")) {
                                String token = authHeader.substring(7);
                                try {
                                    Jwt jwt = jwtDecoder.decode(token);
                                    log.debug("Successfully decoded JWT from STOMP CONNECT headers");
                                    return jwt;
                                } catch (Exception e) {
                                    log.warn("Error decoding JWT token from STOMP CONNECT headers: {}", e.getMessage());
                                }
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            log.warn("Error extracting JWT from CONNECT headers", e);
        }
        
        return null;
    }

    /**
     * Extract user name from STOMP CONNECT headers or Principal
     */
    private String extractUserNameFromConnectHeaders(StompHeaderAccessor accessor) {
        try {
            // First try to get from Principal (which we just set)
            Principal principal = accessor.getUser();
            if (principal != null) {
                if (principal instanceof Authentication) {
                    Authentication auth = (Authentication) principal;
                    Object authPrincipal = auth.getPrincipal();
                    
                    if (authPrincipal instanceof Jwt) {
                        Jwt jwt = (Jwt) authPrincipal;
                        String userName = jwt.getClaimAsString("preferred_username");
                        if (userName == null) {
                            userName = jwt.getClaimAsString("username");
                        }
                        if (userName == null) {
                            userName = jwt.getClaimAsString("sub");
                        }
                        if (userName != null) {
                            log.debug("Extracted user from Principal: {}", userName);
                            return userName;
                        }
                    }
                }
                return principal.getName();
            }
            
            // Fallback: try to extract directly from headers
            Jwt jwt = extractJwtFromConnectHeaders(accessor);
            if (jwt != null) {
                String userName = jwt.getClaimAsString("preferred_username");
                if (userName == null) {
                    userName = jwt.getClaimAsString("username");
                }
                if (userName == null) {
                    userName = jwt.getClaimAsString("sub");
                }
                if (userName != null) {
                    log.debug("Extracted user from JWT: {}", userName);
                    return userName;
                }
            }
        } catch (Exception e) {
            log.warn("Error extracting user name from CONNECT headers", e);
        }
        
        return "anonymous";
    }

    private String extractLocation(String ipAddress) {
        if (ipAddress == null || ipAddress.equals("unknown") || ipAddress.equals("localhost") || ipAddress.equals("127.0.0.1")) {
            return "Local";
        }
        return "Location lookup not implemented";
    }
}

