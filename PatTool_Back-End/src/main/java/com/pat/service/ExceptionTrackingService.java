package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Service to track exceptions and user connections with IP addresses for periodic email reporting
 */
@Service
public class ExceptionTrackingService {

    private static final Logger log = LoggerFactory.getLogger(ExceptionTrackingService.class);

    // Thread-safe map to store exception information
    // Key: IP address, Value: List of exception details
    private final Map<String, List<ExceptionInfo>> exceptionMap = new ConcurrentHashMap<>();

    // Thread-safe map to store connection information
    // Key: IP address, Value: List of connection details
    private final Map<String, List<ConnectionInfo>> connectionMap = new ConcurrentHashMap<>();

    /**
     * Store exception information with IP address
     */
    public void addException(String ipAddress, String exceptionType, String message, 
                            String requestUri, String requestMethod, String stackTrace) {
        if (ipAddress == null) {
            ipAddress = "unknown";
        }

        ExceptionInfo exceptionInfo = new ExceptionInfo(
            LocalDateTime.now(),
            exceptionType,
            message,
            requestUri,
            requestMethod,
            stackTrace
        );

        exceptionMap.computeIfAbsent(ipAddress, k -> Collections.synchronizedList(new ArrayList<>()))
                   .add(exceptionInfo);

        log.debug("Exception tracked for IP {}: {} - {}", ipAddress, exceptionType, message);
    }

    /**
     * Store user connection information with IP address
     */
    public void addConnection(String ipAddress, String username, String firstName, String lastName,
                             String email, String keycloakId, String memberId, String roles,
                             String requestUri, String requestMethod, String userAgent, String referer,
                             boolean isNewUser) {
        if (ipAddress == null) {
            ipAddress = "unknown";
        }

        ConnectionInfo connectionInfo = new ConnectionInfo(
            LocalDateTime.now(),
            username,
            firstName,
            lastName,
            email,
            keycloakId,
            memberId,
            roles,
            requestUri,
            requestMethod,
            userAgent,
            referer,
            isNewUser
        );

        connectionMap.computeIfAbsent(ipAddress, k -> Collections.synchronizedList(new ArrayList<>()))
                    .add(connectionInfo);

        log.debug("Connection tracked for IP {}: User {} ({})", ipAddress, username, isNewUser ? "NEW" : "EXISTING");
    }

    /**
     * Get all tracked exceptions and clear the map
     * @return Map of IP addresses to their exception lists
     */
    public Map<String, List<ExceptionInfo>> getAndClearExceptions() {
        Map<String, List<ExceptionInfo>> snapshot = new ConcurrentHashMap<>();
        
        // Create a snapshot of all exceptions
        for (Map.Entry<String, List<ExceptionInfo>> entry : exceptionMap.entrySet()) {
            snapshot.put(entry.getKey(), new ArrayList<>(entry.getValue()));
        }
        
        // Clear the original map
        exceptionMap.clear();
        
        log.info("Retrieved {} IP addresses with exceptions, map cleared", snapshot.size());
        return snapshot;
    }

    /**
     * Get all tracked connections and clear the map
     * @return Map of IP addresses to their connection lists
     */
    public Map<String, List<ConnectionInfo>> getAndClearConnections() {
        Map<String, List<ConnectionInfo>> snapshot = new ConcurrentHashMap<>();
        
        // Create a snapshot of all connections
        for (Map.Entry<String, List<ConnectionInfo>> entry : connectionMap.entrySet()) {
            snapshot.put(entry.getKey(), new ArrayList<>(entry.getValue()));
        }
        
        // Clear the original map
        connectionMap.clear();
        
        log.info("Retrieved {} IP addresses with connections, map cleared", snapshot.size());
        return snapshot;
    }

    /**
     * Get all tracked exceptions without clearing (for inspection)
     */
    public Map<String, List<ExceptionInfo>> getExceptions() {
        Map<String, List<ExceptionInfo>> snapshot = new ConcurrentHashMap<>();
        for (Map.Entry<String, List<ExceptionInfo>> entry : exceptionMap.entrySet()) {
            snapshot.put(entry.getKey(), new ArrayList<>(entry.getValue()));
        }
        return snapshot;
    }

    /**
     * Get exceptions from the last N hours without clearing
     * @param hours Number of hours to look back
     * @return Map of IP addresses to their exception lists
     */
    public Map<String, List<ExceptionInfo>> getExceptionsFromLastHours(int hours) {
        LocalDateTime cutoff = LocalDateTime.now().minusHours(hours);
        Map<String, List<ExceptionInfo>> snapshot = new ConcurrentHashMap<>();
        
        for (Map.Entry<String, List<ExceptionInfo>> entry : exceptionMap.entrySet()) {
            List<ExceptionInfo> filtered = entry.getValue().stream()
                .filter(info -> info.getTimestamp().isAfter(cutoff))
                .collect(Collectors.toList());
            
            if (!filtered.isEmpty()) {
                snapshot.put(entry.getKey(), filtered);
            }
        }
        
        return snapshot;
    }

    /**
     * Get all tracked connections without clearing (for inspection)
     */
    public Map<String, List<ConnectionInfo>> getConnections() {
        Map<String, List<ConnectionInfo>> snapshot = new ConcurrentHashMap<>();
        for (Map.Entry<String, List<ConnectionInfo>> entry : connectionMap.entrySet()) {
            snapshot.put(entry.getKey(), new ArrayList<>(entry.getValue()));
        }
        return snapshot;
    }

    /**
     * Get connections from the last N hours without clearing
     * @param hours Number of hours to look back
     * @return Map of IP addresses to their connection lists
     */
    public Map<String, List<ConnectionInfo>> getConnectionsFromLastHours(int hours) {
        LocalDateTime cutoff = LocalDateTime.now().minusHours(hours);
        Map<String, List<ConnectionInfo>> snapshot = new ConcurrentHashMap<>();
        
        for (Map.Entry<String, List<ConnectionInfo>> entry : connectionMap.entrySet()) {
            List<ConnectionInfo> filtered = entry.getValue().stream()
                .filter(info -> info.getTimestamp().isAfter(cutoff))
                .collect(Collectors.toList());
            
            if (!filtered.isEmpty()) {
                snapshot.put(entry.getKey(), filtered);
            }
        }
        
        return snapshot;
    }

    /**
     * Get count of tracked exceptions
     */
    public int getExceptionCount() {
        return exceptionMap.values().stream()
                          .mapToInt(List::size)
                          .sum();
    }

    /**
     * Get count of tracked connections
     */
    public int getConnectionCount() {
        return connectionMap.values().stream()
                           .mapToInt(List::size)
                           .sum();
    }

    /**
     * Inner class to store exception information
     */
    public static class ExceptionInfo {
        private final LocalDateTime timestamp;
        private final String exceptionType;
        private final String message;
        private final String requestUri;
        private final String requestMethod;
        private final String stackTrace;

        public ExceptionInfo(LocalDateTime timestamp, String exceptionType, String message,
                           String requestUri, String requestMethod, String stackTrace) {
            this.timestamp = timestamp;
            this.exceptionType = exceptionType;
            this.message = message;
            this.requestUri = requestUri;
            this.requestMethod = requestMethod;
            this.stackTrace = stackTrace;
        }

        public LocalDateTime getTimestamp() {
            return timestamp;
        }

        public String getExceptionType() {
            return exceptionType;
        }

        public String getMessage() {
            return message;
        }

        public String getRequestUri() {
            return requestUri;
        }

        public String getRequestMethod() {
            return requestMethod;
        }

        public String getStackTrace() {
            return stackTrace;
        }
    }

    /**
     * Inner class to store connection information
     */
    public static class ConnectionInfo {
        private final LocalDateTime timestamp;
        private final String username;
        private final String firstName;
        private final String lastName;
        private final String email;
        private final String keycloakId;
        private final String memberId;
        private final String roles;
        private final String requestUri;
        private final String requestMethod;
        private final String userAgent;
        private final String referer;
        private final boolean isNewUser;

        public ConnectionInfo(LocalDateTime timestamp, String username, String firstName, String lastName,
                             String email, String keycloakId, String memberId, String roles,
                             String requestUri, String requestMethod, String userAgent, String referer,
                             boolean isNewUser) {
            this.timestamp = timestamp;
            this.username = username;
            this.firstName = firstName;
            this.lastName = lastName;
            this.email = email;
            this.keycloakId = keycloakId;
            this.memberId = memberId;
            this.roles = roles;
            this.requestUri = requestUri;
            this.requestMethod = requestMethod;
            this.userAgent = userAgent;
            this.referer = referer;
            this.isNewUser = isNewUser;
        }

        public LocalDateTime getTimestamp() {
            return timestamp;
        }

        public String getUsername() {
            return username;
        }

        public String getFirstName() {
            return firstName;
        }

        public String getLastName() {
            return lastName;
        }

        public String getEmail() {
            return email;
        }

        public String getKeycloakId() {
            return keycloakId;
        }

        public String getMemberId() {
            return memberId;
        }

        public String getRoles() {
            return roles;
        }

        public String getRequestUri() {
            return requestUri;
        }

        public String getRequestMethod() {
            return requestMethod;
        }

        public String getUserAgent() {
            return userAgent;
        }

        public String getReferer() {
            return referer;
        }

        public boolean isNewUser() {
            return isNewUser;
        }
    }
}
