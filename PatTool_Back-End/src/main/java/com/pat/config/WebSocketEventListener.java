package com.pat.config;

import com.pat.service.DiscussionConnectionService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.GenericMessage;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.messaging.SessionConnectedEvent;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;
import org.springframework.web.socket.messaging.SessionSubscribeEvent;
import org.springframework.web.socket.messaging.SessionUnsubscribeEvent;
import org.springframework.web.socket.WebSocketSession;

import java.net.InetSocketAddress;
import java.security.Principal;
import java.util.List;
import java.util.Map;

/**
 * WebSocket event listener to track discussion connections
 */
@Component
public class WebSocketEventListener {

    private static final Logger log = LoggerFactory.getLogger(WebSocketEventListener.class);

    @Autowired
    private DiscussionConnectionService connectionService;

    @Autowired
    private JwtDecoder jwtDecoder;

    @EventListener
    public void handleWebSocketConnectListener(SessionConnectedEvent event) {
        StompHeaderAccessor headerAccessor = StompHeaderAccessor.wrap(event.getMessage());
        String sessionId = headerAccessor.getSessionId();
        
        log.debug("WebSocket connection established: {}", sessionId);
        
        // First try to get from session attributes (set by handshake interceptor)
        Map<String, Object> sessionAttributes = headerAccessor.getSessionAttributes();
        String userName = "anonymous";
        String ipAddress = "unknown";
        String domain = "unknown";
        
        if (sessionAttributes != null) {
            Object userNameAttr = sessionAttributes.get("userName");
            if (userNameAttr != null) {
                userName = userNameAttr.toString();
            }
            
            Object ipAttr = sessionAttributes.get("ipAddress");
            if (ipAttr != null) {
                ipAddress = ipAttr.toString();
            }
            
            Object domainAttr = sessionAttributes.get("domain");
            if (domainAttr != null) {
                domain = domainAttr.toString();
            }
        }
        
        // Fall back to extracting from authentication if not in session
        if (userName.equals("anonymous")) {
            Principal principal = headerAccessor.getUser();
            String extractedUserName = extractUserName(principal);
            if (extractedUserName != null && !extractedUserName.equals("anonymous")) {
                userName = extractedUserName;
            }
        }
        
        // Fall back to extracting from headers if not in session
        if (ipAddress.equals("unknown")) {
            ipAddress = extractIpAddressFromSession(event, headerAccessor);
        }
        
        if (domain.equals("unknown")) {
            domain = extractDomain(headerAccessor);
        }
        
        String location = extractLocation(ipAddress);
        
        log.debug("Connection details - User: {}, IP: {}, Domain: {}", userName, ipAddress, domain);
        
        // Store connection info (will be updated when user subscribes to a discussion)
        connectionService.addConnection(sessionId, userName, ipAddress, domain, location);
    }

    @EventListener
    public void handleWebSocketDisconnectListener(SessionDisconnectEvent event) {
        StompHeaderAccessor headerAccessor = StompHeaderAccessor.wrap(event.getMessage());
        String sessionId = headerAccessor.getSessionId();
        
        log.debug("WebSocket connection closed: {}", sessionId);
        connectionService.removeConnection(sessionId);
    }

    @EventListener
    public void handleWebSocketSubscribeListener(SessionSubscribeEvent event) {
        StompHeaderAccessor headerAccessor = StompHeaderAccessor.wrap(event.getMessage());
        String sessionId = headerAccessor.getSessionId();
        String destination = headerAccessor.getDestination();
        
        // Check if this is a discussion subscription
        if (destination != null && destination.startsWith("/topic/discussion/")) {
            String discussionId = destination.substring("/topic/discussion/".length());
            
            // Try to extract user from token in STOMP headers
            String userName = extractUserNameFromStompHeaders(headerAccessor);
            
            // Fall back to Principal if available
            if (userName == null || userName.equals("anonymous")) {
                Principal principal = headerAccessor.getUser();
                userName = extractUserName(principal);
            }
            
            log.debug("User {} subscribed to discussion {} (session: {})", userName, discussionId, sessionId);
            
            // Update connection with discussion ID and also update user info if we now have it
            connectionService.updateConnectionDiscussion(sessionId, discussionId);
            
            // If we now have user info and it was anonymous before, update it
            if (userName != null && !userName.equals("anonymous")) {
                // Try to update user info if it was missing
                String ipAddress = extractIpAddressFromSession(event, headerAccessor);
                String domain = extractDomain(headerAccessor);
                String location = extractLocation(ipAddress);
                connectionService.updateConnectionUser(sessionId, userName, ipAddress, domain, location);
            }
        }
    }

    @EventListener
    public void handleWebSocketUnsubscribeListener(SessionUnsubscribeEvent event) {
        StompHeaderAccessor headerAccessor = StompHeaderAccessor.wrap(event.getMessage());
        String sessionId = headerAccessor.getSessionId();
        
        log.debug("User unsubscribed from discussion (session: {})", sessionId);
        
        // Clear discussion ID but keep connection (user might subscribe to another discussion)
        connectionService.updateConnectionDiscussion(sessionId, null);
    }

    private String extractUserName(Principal principal) {
        if (principal == null) {
            return "anonymous";
        }
        
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
                return userName != null ? userName : "unknown";
            }
        }
        
        return principal.getName();
    }

    private String extractIpAddressFromSession(SessionConnectedEvent event, StompHeaderAccessor headerAccessor) {
        try {
            // First try to get from WebSocket session directly
            if (event.getMessage() instanceof GenericMessage) {
                GenericMessage<?> genericMessage = (GenericMessage<?>) event.getMessage();
                Object payload = genericMessage.getPayload();
                
                // Try to access WebSocket session if available
                if (payload instanceof org.springframework.web.socket.WebSocketSession) {
                    WebSocketSession wsSession = (WebSocketSession) payload;
                    InetSocketAddress remoteAddress = wsSession.getRemoteAddress();
                    if (remoteAddress != null) {
                        String ip = remoteAddress.getAddress().getHostAddress();
                        log.debug("Extracted IP from WebSocket session: {}", ip);
                        return ip;
                    }
                }
            }
            
            // Try to get IP from native headers
            Map<String, List<String>> nativeHeaders = headerAccessor.toNativeHeaderMap();
            if (nativeHeaders != null) {
                // Check for X-Forwarded-For header (for proxies) - case insensitive
                for (String key : nativeHeaders.keySet()) {
                    if (key != null && key.toLowerCase().equals("x-forwarded-for")) {
                        List<String> forwardedFor = nativeHeaders.get(key);
                        if (forwardedFor != null && !forwardedFor.isEmpty()) {
                            String ip = forwardedFor.get(0);
                            if (ip.contains(",")) {
                                ip = ip.split(",")[0].trim();
                            }
                            log.debug("Extracted IP from X-Forwarded-For header: {}", ip);
                            return ip;
                        }
                    }
                    
                    if (key != null && key.toLowerCase().equals("x-real-ip")) {
                        List<String> realIp = nativeHeaders.get(key);
                        if (realIp != null && !realIp.isEmpty()) {
                            log.debug("Extracted IP from X-Real-IP header: {}", realIp.get(0));
                            return realIp.get(0);
                        }
                    }
                }
            }
            
            // Try to get from session attributes
            Map<String, Object> sessionAttributes = headerAccessor.getSessionAttributes();
            if (sessionAttributes != null) {
                Object ip = sessionAttributes.get("ipAddress");
                if (ip != null) {
                    log.debug("Extracted IP from session attributes: {}", ip);
                    return ip.toString();
                }
            }
        } catch (Exception e) {
            log.warn("Error extracting IP address", e);
        }
        
        return "unknown";
    }
    
    // Overloaded method for SessionSubscribeEvent
    private String extractIpAddressFromSession(SessionSubscribeEvent event, StompHeaderAccessor headerAccessor) {
        try {
            // Try to get IP from native headers
            Map<String, List<String>> nativeHeaders = headerAccessor.toNativeHeaderMap();
            if (nativeHeaders != null) {
                // Check for X-Forwarded-For header (for proxies) - case insensitive
                for (String key : nativeHeaders.keySet()) {
                    if (key != null && key.toLowerCase().equals("x-forwarded-for")) {
                        List<String> forwardedFor = nativeHeaders.get(key);
                        if (forwardedFor != null && !forwardedFor.isEmpty()) {
                            String ip = forwardedFor.get(0);
                            if (ip.contains(",")) {
                                ip = ip.split(",")[0].trim();
                            }
                            return ip;
                        }
                    }
                    
                    if (key != null && key.toLowerCase().equals("x-real-ip")) {
                        List<String> realIp = nativeHeaders.get(key);
                        if (realIp != null && !realIp.isEmpty()) {
                            return realIp.get(0);
                        }
                    }
                }
            }
            
            // Try to get from session attributes
            Map<String, Object> sessionAttributes = headerAccessor.getSessionAttributes();
            if (sessionAttributes != null) {
                Object ip = sessionAttributes.get("ipAddress");
                if (ip != null) {
                    return ip.toString();
                }
            }
        } catch (Exception e) {
            log.warn("Error extracting IP address", e);
        }
        
        return "unknown";
    }

    private String extractDomain(StompHeaderAccessor headerAccessor) {
        try {
            Map<String, List<String>> nativeHeaders = headerAccessor.toNativeHeaderMap();
            if (nativeHeaders != null) {
                // Try origin header (case insensitive)
                for (String key : nativeHeaders.keySet()) {
                    if (key != null && key.toLowerCase().equals("origin")) {
                        List<String> origin = nativeHeaders.get(key);
                        if (origin != null && !origin.isEmpty()) {
                            String originStr = origin.get(0);
                            // Extract domain from origin (e.g., "https://example.com" -> "example.com")
                            if (originStr.startsWith("http://") || originStr.startsWith("https://")) {
                                String domain = originStr.replaceFirst("https?://", "");
                                if (domain.contains("/")) {
                                    domain = domain.substring(0, domain.indexOf("/"));
                                }
                                if (domain.contains(":")) {
                                    domain = domain.substring(0, domain.indexOf(":"));
                                }
                                log.debug("Extracted domain from origin header: {}", domain);
                                return domain;
                            }
                            log.debug("Extracted domain from origin header: {}", originStr);
                            return originStr;
                        }
                    }
                    
                    // Try host header (case insensitive)
                    if (key != null && key.toLowerCase().equals("host")) {
                        List<String> host = nativeHeaders.get(key);
                        if (host != null && !host.isEmpty()) {
                            String hostStr = host.get(0);
                            // Remove port if present
                            if (hostStr.contains(":")) {
                                hostStr = hostStr.substring(0, hostStr.indexOf(":"));
                            }
                            log.debug("Extracted domain from host header: {}", hostStr);
                            return hostStr;
                        }
                    }
                }
            }
        } catch (Exception e) {
            log.warn("Error extracting domain", e);
        }
        
        return "unknown";
    }

    private String extractLocation(String ipAddress) {
        if (ipAddress == null || ipAddress.equals("unknown") || ipAddress.equals("localhost") || ipAddress.equals("127.0.0.1")) {
            return "Local";
        }
        
        // In a real implementation, you might use a GeoIP service
        // For now, return a placeholder
        try {
            // Could integrate with MaxMind GeoIP2 or similar service here
            // InetAddress addr = InetAddress.getByName(ipAddress);
            return "Location lookup not implemented";
        } catch (Exception e) {
            return "Unknown location";
        }
    }

    /**
     * Extract user name from STOMP connect headers (Authorization header)
     */
    private String extractUserNameFromStompHeaders(StompHeaderAccessor headerAccessor) {
        try {
            // Get native headers which contain STOMP connect headers
            Map<String, List<String>> nativeHeaders = headerAccessor.toNativeHeaderMap();
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
                                    String userName = jwt.getClaimAsString("preferred_username");
                                    if (userName == null) {
                                        userName = jwt.getClaimAsString("username");
                                    }
                                    if (userName == null) {
                                        userName = jwt.getClaimAsString("sub");
                                    }
                                    if (userName != null) {
                                        log.debug("Extracted user from STOMP Authorization header: {}", userName);
                                        return userName;
                                    }
                                } catch (Exception e) {
                                    log.warn("Error decoding JWT token from STOMP headers", e);
                                }
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            log.warn("Error extracting user name from STOMP headers", e);
        }
        
        return null;
    }
}

