package com.pat.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;

/**
 * WebSocket handshake interceptor to capture authentication and connection info
 */
@Component
public class WebSocketHandshakeInterceptor implements HandshakeInterceptor {

    private static final Logger log = LoggerFactory.getLogger(WebSocketHandshakeInterceptor.class);

    @Autowired
    private JwtDecoder jwtDecoder;

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                                   WebSocketHandler wsHandler, Map<String, Object> attributes) throws Exception {
        
        if (request instanceof ServletServerHttpRequest) {
            ServletServerHttpRequest servletRequest = (ServletServerHttpRequest) request;
            HttpServletRequest httpRequest = servletRequest.getServletRequest();
            
            // Extract IP address
            String ipAddress = getClientIpAddress(httpRequest);
            
            // Extract domain
            String domain = getDomain(httpRequest);
            
            // Extract user info from JWT token in request
            String userName = extractUserNameFromRequest(httpRequest);
            
            // Store in session attributes for later use
            attributes.put("ipAddress", ipAddress);
            attributes.put("domain", domain);
            attributes.put("userName", userName);
            
            if (!userName.equals("anonymous")) {
                log.debug("WebSocket handshake - User: {}, IP: {}, Domain: {}", userName, ipAddress, domain);
            } else {
                log.warn("WebSocket handshake - User is anonymous. IP: {}, Domain: {}. Check if token is being sent.", ipAddress, domain);
            }
        }
        
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                               WebSocketHandler wsHandler, Exception exception) {
        // Nothing to do after handshake
    }

    private String getClientIpAddress(HttpServletRequest request) {
        if (request == null) {
            return "unknown";
        }
        
        // Check X-Forwarded-For header (for proxies)
        String xForwardedFor = request.getHeader("X-Forwarded-For");
        if (xForwardedFor != null && !xForwardedFor.isEmpty()) {
            // X-Forwarded-For can contain multiple IPs, take the first one
            String[] ips = xForwardedFor.split(",");
            if (ips.length > 0) {
                return ips[0].trim();
            }
        }
        
        // Check X-Real-IP header (commonly used by nginx)
        String xRealIp = request.getHeader("X-Real-IP");
        if (xRealIp != null && !xRealIp.isEmpty()) {
            return xRealIp.trim();
        }
        
        // Fall back to remote address
        String remoteAddr = request.getRemoteAddr();
        if (remoteAddr != null && !remoteAddr.isEmpty()) {
            return remoteAddr;
        }
        
        return "unknown";
    }

    private String getDomain(HttpServletRequest request) {
        if (request == null) {
            return "unknown";
        }
        
        // Try to get from Origin header
        String origin = request.getHeader("Origin");
        if (origin != null && !origin.isEmpty()) {
            // Extract domain from origin (e.g., "https://example.com" -> "example.com")
            if (origin.startsWith("http://") || origin.startsWith("https://")) {
                String domain = origin.replaceFirst("https?://", "");
                if (domain.contains("/")) {
                    domain = domain.substring(0, domain.indexOf("/"));
                }
                if (domain.contains(":")) {
                    domain = domain.substring(0, domain.indexOf(":"));
                }
                return domain;
            }
            return origin;
        }
        
        // Try Host header
        String host = request.getHeader("Host");
        if (host != null && !host.isEmpty()) {
            // Remove port if present
            if (host.contains(":")) {
                host = host.substring(0, host.indexOf(":"));
            }
            return host;
        }
        
        // Fall back to server name
        String serverName = request.getServerName();
        if (serverName != null && !serverName.isEmpty()) {
            return serverName;
        }
        
        return "unknown";
    }

    private String extractUserNameFromRequest(HttpServletRequest request) {
        try {
            // First try to get from SecurityContext (if available)
            Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
            if (authentication != null && authentication.getPrincipal() != null) {
                Object principal = authentication.getPrincipal();
                
                if (principal instanceof Jwt) {
                    Jwt jwt = (Jwt) principal;
                    String userName = jwt.getClaimAsString("preferred_username");
                    if (userName == null) {
                        userName = jwt.getClaimAsString("username");
                    }
                    if (userName == null) {
                        userName = jwt.getClaimAsString("sub");
                    }
                    if (userName != null && !userName.equals("anonymous")) {
                        log.debug("Extracted user from SecurityContext: {}", userName);
                        return userName;
                    }
                }
            }
            
            // Try to extract token from Authorization header
            String authHeader = request.getHeader("Authorization");
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
                        log.debug("Extracted user from Authorization header: {}", userName);
                        return userName;
                    } else {
                        log.warn("JWT token decoded but no username claim found. Available claims: {}", jwt.getClaims().keySet());
                    }
                } catch (Exception e) {
                    log.warn("Error decoding JWT token from Authorization header: {}", e.getMessage());
                }
            } else {
                log.debug("No Authorization header found in WebSocket handshake request");
            }
            
            // Try to extract token from query parameter (for SockJS)
            String tokenParam = request.getParameter("token");
            if (tokenParam != null && !tokenParam.isEmpty()) {
                try {
                    Jwt jwt = jwtDecoder.decode(tokenParam);
                    String userName = jwt.getClaimAsString("preferred_username");
                    if (userName == null) {
                        userName = jwt.getClaimAsString("username");
                    }
                    if (userName == null) {
                        userName = jwt.getClaimAsString("sub");
                    }
                    if (userName != null) {
                        log.debug("Extracted user from token query parameter: {}", userName);
                        return userName;
                    } else {
                        log.warn("JWT token decoded but no username claim found. Available claims: {}", jwt.getClaims().keySet());
                    }
                } catch (Exception e) {
                    log.warn("Error decoding JWT token from query parameter: {}", e.getMessage());
                }
            } else {
                log.debug("No token query parameter found in WebSocket handshake request");
            }
            
        } catch (Exception e) {
            log.warn("Error extracting user name from request", e);
        }
        
        return "anonymous";
    }
}

