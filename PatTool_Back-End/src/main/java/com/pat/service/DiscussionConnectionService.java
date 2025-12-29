package com.pat.service;

import com.pat.repo.DiscussionRepository;
import com.pat.repo.MembersRepository;
import com.pat.repo.UserConnectionLogRepository;
import com.pat.repo.domain.Discussion;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.UserConnectionLog;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Date;

/**
 * Service to track active WebSocket connections for discussions
 */
@Service
public class DiscussionConnectionService {

    private static final Logger log = LoggerFactory.getLogger(DiscussionConnectionService.class);

    @Autowired
    private MembersRepository membersRepository;

    @Autowired
    private DiscussionRepository discussionRepository;

    @Autowired
    private UserConnectionLogRepository userConnectionLogRepository;

    // Maximum number of connections to keep in memory (default: 1000)
    @Value("${app.websocket.max-connections:1000}")
    private int maxConnections;
    
    // Maximum age for connections in minutes (default: 30 minutes)
    @Value("${app.websocket.connection-max-age-minutes:30}")
    private int connectionMaxAgeMinutes;

    // Map of sessionId -> ConnectionInfo
    private final Map<String, ConnectionInfo> activeConnections = new ConcurrentHashMap<>();

    /**
     * Add a new connection
     */
    public void addConnection(String sessionId, String userName, String ipAddress, String domain, String location) {
        // Enforce size limit before adding new connection
        enforceConnectionLimit();
        
        ConnectionInfo info = new ConnectionInfo();
        info.sessionId = sessionId;
        info.userName = userName;
        info.ipAddress = ipAddress;
        info.domain = domain;
        info.location = location;
        info.connectedAt = LocalDateTime.now();
        info.discussionId = null;
        
        activeConnections.put(sessionId, info);
        log.debug("Added connection: {} for user {} (total connections: {})", sessionId, userName, activeConnections.size());
    }

    /**
     * Remove a connection
     */
    public void removeConnection(String sessionId) {
        ConnectionInfo removed = activeConnections.remove(sessionId);
        if (removed != null) {
            log.debug("Removed connection: {} for user {}", sessionId, removed.userName);
        }
    }

    /**
     * Update the discussion ID for a connection and log the connection
     */
    public void updateConnectionDiscussion(String sessionId, String discussionId) {
        ConnectionInfo info = activeConnections.get(sessionId);
        if (info != null) {
            String previousDiscussionId = info.discussionId;
            info.discussionId = discussionId;
            log.debug("Updated discussion for session {}: {}", sessionId, discussionId);
            
            // Log the discussion connection if this is a new subscription (not just an update)
            // Only log if discussionId is not null (skip logging for unsubscribes)
            if (discussionId != null && !discussionId.isEmpty() && 
                (previousDiscussionId == null || !previousDiscussionId.equals(discussionId))) {
                logDiscussionConnection(sessionId, discussionId, info);
            }
        }
    }

    /**
     * Log a discussion connection to userConnectionLogs
     */
    private void logDiscussionConnection(String sessionId, String discussionId, ConnectionInfo info) {
        try {
            // Validate discussionId is not null or empty
            if (discussionId == null || discussionId.isEmpty()) {
                log.debug("Skipping discussion connection log - discussionId is null or empty");
                return;
            }

            // Only log if we have a valid user (not anonymous)
            if (info.userName == null || info.userName.equals("anonymous") || info.userName.equals("unknown")) {
                log.debug("Skipping discussion connection log - user is anonymous or unknown");
                return;
            }

            // Get member
            Member member = membersRepository.findByUserName(info.userName);
            if (member == null) {
                log.warn("Cannot log discussion connection - member not found for user: {}", info.userName);
                return;
            }

            // Validate that member has a valid ID (required for @DBRef)
            if (member.getId() == null || member.getId().isEmpty()) {
                log.warn("Cannot log discussion connection - member has null or empty ID for user: {}", info.userName);
                return;
            }

            // Get discussion
            Discussion discussion = discussionRepository.findById(discussionId).orElse(null);
            String discussionTitle = "Unknown Discussion";
            if (discussion != null) {
                discussionTitle = discussion.getTitle() != null ? discussion.getTitle() : "Untitled Discussion";
            }

            // Create connection log
            UserConnectionLog connectionLog = new UserConnectionLog(
                member,
                new Date(),
                info.ipAddress != null ? info.ipAddress : "unknown",
                info.domain != null ? info.domain : "unknown",
                info.location != null ? info.location : "Unknown location",
                "discussion",
                discussionId,
                discussionTitle
            );

            // Save to database
            userConnectionLogRepository.save(connectionLog);
            log.debug("Logged discussion connection - User: {}, Discussion: {} ({})", 
                info.userName, discussionTitle, discussionId);
        } catch (Exception e) {
            log.error("Error logging discussion connection for session {}: {}", sessionId, e.getMessage(), e);
            // Don't fail the connection if logging fails
        }
    }

    /**
     * Update user information for a connection (if it was missing or anonymous)
     */
    public void updateConnectionUser(String sessionId, String userName, String ipAddress, String domain, String location) {
        ConnectionInfo info = activeConnections.get(sessionId);
        if (info != null) {
            // Only update if current user is anonymous or unknown
            if (info.userName == null || info.userName.equals("anonymous") || info.userName.equals("unknown")) {
                info.userName = userName;
            }
            // Update IP if it was unknown
            if (info.ipAddress == null || info.ipAddress.equals("unknown")) {
                info.ipAddress = ipAddress;
            }
            // Update domain if it was unknown
            if (info.domain == null || info.domain.equals("unknown")) {
                info.domain = domain;
            }
            // Update location if it was not set
            if (info.location == null || info.location.equals("Unknown location")) {
                info.location = location;
            }
            log.debug("Updated user info for session {}: user={}, ip={}, domain={}", sessionId, userName, ipAddress, domain);
        }
    }

    /**
     * Get all active connections with discussion information
     */
    public List<ActiveConnectionDTO> getActiveConnections() {
        List<ActiveConnectionDTO> result = new ArrayList<>();
        
        for (ConnectionInfo info : activeConnections.values()) {
            // Only include connections that are subscribed to a discussion
            if (info.discussionId != null && !info.discussionId.isEmpty()) {
                ActiveConnectionDTO dto = new ActiveConnectionDTO();
                dto.userName = info.userName;
                dto.connectedAt = info.connectedAt;
                dto.discussionId = info.discussionId;
                dto.ipAddress = info.ipAddress;
                dto.location = info.location;
                dto.domain = info.domain;
                
                // Try to get full member info
                try {
                    Member member = membersRepository.findByUserName(info.userName);
                    if (member != null) {
                        dto.member = member;
                    }
                } catch (Exception e) {
                    log.warn("Error fetching member for user {}", info.userName, e);
                }
                
                // Try to get discussion title
                try {
                    Discussion discussion = discussionRepository.findById(info.discussionId).orElse(null);
                    if (discussion != null) {
                        dto.discussionTitle = discussion.getTitle();
                    } else {
                        dto.discussionTitle = "Unknown Discussion";
                    }
                } catch (Exception e) {
                    log.warn("Error fetching discussion for ID {}", info.discussionId, e);
                    dto.discussionTitle = "Unknown Discussion";
                }
                
                result.add(dto);
            }
        }
        
        // Sort by connection time (newest first)
        result.sort((a, b) -> b.connectedAt.compareTo(a.connectedAt));
        
        return result;
    }

    /**
     * Get count of active connections
     */
    public int getActiveConnectionCount() {
        return (int) activeConnections.values().stream()
                .filter(info -> info.discussionId != null && !info.discussionId.isEmpty())
                .count();
    }

    /**
     * Periodic cleanup of expired connections (runs every 5 minutes)
     * This prevents memory leaks from connections that were not properly cleaned up
     */
    @Scheduled(fixedRate = 300000) // Every 5 minutes
    public void cleanupExpiredConnections() {
        try {
            LocalDateTime now = LocalDateTime.now();
            LocalDateTime maxAge = now.minusMinutes(connectionMaxAgeMinutes);
            
            int removedCount = 0;
            Iterator<Map.Entry<String, ConnectionInfo>> iterator = activeConnections.entrySet().iterator();
            
            while (iterator.hasNext()) {
                Map.Entry<String, ConnectionInfo> entry = iterator.next();
                ConnectionInfo info = entry.getValue();
                
                // Remove connections older than maxAge
                if (info.connectedAt.isBefore(maxAge)) {
                    iterator.remove();
                    removedCount++;
                    log.debug("Removed expired connection: {} (age: {} minutes)", 
                        entry.getKey(), 
                        java.time.Duration.between(info.connectedAt, now).toMinutes());
                }
            }
            
            // If still too many connections, remove oldest ones
            if (activeConnections.size() > maxConnections) {
                int toRemove = activeConnections.size() - maxConnections;
                List<Map.Entry<String, ConnectionInfo>> sorted = new ArrayList<>(activeConnections.entrySet());
                sorted.sort(Comparator.comparing(e -> e.getValue().connectedAt));
                
                for (int i = 0; i < toRemove && i < sorted.size(); i++) {
                    activeConnections.remove(sorted.get(i).getKey());
                    removedCount++;
                }
                
                log.info("Removed {} oldest connections to enforce limit (max: {})", toRemove, maxConnections);
            }
            
            if (removedCount > 0) {
                log.info("Cleaned up {} expired/old connections. Remaining: {}", removedCount, activeConnections.size());
            }
        } catch (Exception e) {
            log.error("Error during connection cleanup", e);
        }
    }

    /**
     * Enforce connection limit before adding new connection
     */
    private void enforceConnectionLimit() {
        if (activeConnections.size() >= maxConnections) {
            // Remove oldest connections to make room
            List<Map.Entry<String, ConnectionInfo>> sorted = new ArrayList<>(activeConnections.entrySet());
            sorted.sort(Comparator.comparing(e -> e.getValue().connectedAt));
            
            int toRemove = activeConnections.size() - maxConnections + 1; // +1 to make room for new connection
            for (int i = 0; i < toRemove && i < sorted.size(); i++) {
                activeConnections.remove(sorted.get(i).getKey());
            }
            
            log.debug("Enforced connection limit: removed {} oldest connections (max: {})", toRemove, maxConnections);
        }
    }

    /**
     * Internal class to store connection information
     */
    private static class ConnectionInfo {
        String sessionId;
        String userName;
        String ipAddress;
        String domain;
        String location;
        LocalDateTime connectedAt;
        String discussionId;
    }

    /**
     * DTO for active connection information
     */
    public static class ActiveConnectionDTO {
        public String userName;
        public LocalDateTime connectedAt;
        public String discussionId;
        public String discussionTitle;
        public String ipAddress;
        public String location;
        public String domain;
        public Member member;
    }
}

