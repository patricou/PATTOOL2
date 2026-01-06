package com.pat.controller;

import com.pat.repo.UserConnectionLogRepository;
import com.pat.service.MemoryMonitoringService;
import com.pat.service.ImageCompressionService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import com.pat.repo.domain.Member;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.bson.Document;
import com.mongodb.DBRef;

import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.ArrayList;
import java.util.Set;
import java.util.HashSet;
import java.util.Map;
import java.util.Objects;

/**
 * System information controller
 * Provides endpoints for system monitoring and diagnostics
 */
@RestController
@RequestMapping("/api/system")
public class SystemController {

    private static final Logger log = LoggerFactory.getLogger(SystemController.class);
    
    @Autowired
    private MemoryMonitoringService memoryMonitoringService;
    
    @Autowired(required = false)
    private ImageCompressionService imageCompressionService;
    
    @Autowired
    private UserConnectionLogRepository userConnectionLogRepository;

    @Autowired
    private MongoTemplate mongoTemplate;

    private static final int DEFAULT_CONNECTION_LOGS_PAGE_SIZE = 100;
    private static final int MAX_CONNECTION_LOGS_PAGE_SIZE = 5000;
    
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
     * Get JVM memory information
     * Returns detailed memory usage statistics
     */
    @GetMapping("/memory")
    public ResponseEntity<Map<String, Object>> getMemoryInfo() {
        try {
            Runtime runtime = Runtime.getRuntime();
            long maxMemory = runtime.maxMemory();
            long totalMemory = runtime.totalMemory();
            long freeMemory = runtime.freeMemory();
            long usedMemory = totalMemory - freeMemory;
            long availableMemory = maxMemory - usedMemory;
            
            double usagePercent = memoryMonitoringService.getMemoryUsagePercent();
            
            Map<String, Object> memoryInfo = new HashMap<>();
            memoryInfo.put("usedMB", usedMemory / (1024 * 1024));
            memoryInfo.put("totalMB", totalMemory / (1024 * 1024));
            memoryInfo.put("maxMB", maxMemory / (1024 * 1024));
            memoryInfo.put("freeMB", freeMemory / (1024 * 1024));
            memoryInfo.put("availableMB", availableMemory / (1024 * 1024));
            memoryInfo.put("totalGB", maxMemory / (1024 * 1024 * 1024));
            memoryInfo.put("usagePercent", Math.round(usagePercent * 100.0) / 100.0);
            memoryInfo.put("memoryInfo", memoryMonitoringService.getMemoryInfo());
            
            // Add JVM memory settings
            memoryInfo.put("maxHeapMB", maxMemory / (1024 * 1024));
            memoryInfo.put("initialHeapMB", runtime.totalMemory() / (1024 * 1024));
            
            // Add memory status
            String status = "OK";
            if (usagePercent >= 90) {
                status = "CRITICAL";
            } else if (usagePercent >= 85) {
                status = "WARNING";
            }
            memoryInfo.put("status", status);
            
            // Add compression cache statistics if available
            // Always recalculate to ensure real-time values
            if (imageCompressionService != null) {
                Map<String, Object> cacheStats = imageCompressionService.getCacheStatistics();
                memoryInfo.put("compressionCache", cacheStats);
                log.debug("Memory info request - Compression cache: {} entries, {} MB (enabled: {})", 
                        cacheStats.get("entryCount"), cacheStats.get("totalSizeMB"), cacheStats.get("enabled"));
            } else {
                log.warn("ImageCompressionService is not available - compression cache statistics cannot be retrieved");
                // Return empty cache stats
                Map<String, Object> emptyCacheStats = new HashMap<>();
                emptyCacheStats.put("enabled", false);
                emptyCacheStats.put("entryCount", 0);
                emptyCacheStats.put("totalSizeMB", 0.0);
                memoryInfo.put("compressionCache", emptyCacheStats);
            }
            
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                    .header(HttpHeaders.CACHE_CONTROL, "no-cache, no-store, must-revalidate")
                    .header(HttpHeaders.PRAGMA, "no-cache")
                    .header(HttpHeaders.EXPIRES, "0")
                    .body(memoryInfo);
        } catch (Exception e) {
            log.error("Error retrieving memory information", e);
            Map<String, Object> error = new HashMap<>();
            error.put("error", "Failed to retrieve memory information: " + e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(error);
        }
    }
    
    /**
     * Get compression cache statistics only
     * Returns cache entry count and total size
     */
    @GetMapping("/cache")
    public ResponseEntity<Map<String, Object>> getCacheInfo() {
        try {
            Map<String, Object> cacheInfo = new HashMap<>();
            
            // Get compression cache statistics if available
            if (imageCompressionService != null) {
                Map<String, Object> cacheStats = imageCompressionService.getCacheStatistics();
                cacheInfo.putAll(cacheStats);
                log.debug("Cache info request - Compression cache: {} entries, {} MB (enabled: {}, totalBytes: {})", 
                        cacheStats.get("entryCount"), cacheStats.get("totalSizeMB"), cacheStats.get("enabled"), cacheStats.get("totalSizeBytes"));
            } else {
                log.warn("ImageCompressionService is not available - compression cache statistics cannot be retrieved");
                cacheInfo.put("enabled", false);
                cacheInfo.put("entryCount", 0);
                cacheInfo.put("totalSizeMB", 0.0);
                cacheInfo.put("totalSizeBytes", 0L);
                cacheInfo.put("maxEntries", 0);
            }
            
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                    .header(HttpHeaders.CACHE_CONTROL, "no-cache, no-store, must-revalidate")
                    .header(HttpHeaders.PRAGMA, "no-cache")
                    .header(HttpHeaders.EXPIRES, "0")
                    .body(cacheInfo);
        } catch (Exception e) {
            log.error("Error retrieving cache information", e);
            Map<String, Object> error = new HashMap<>();
            error.put("error", "Failed to retrieve cache information: " + e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(error);
        }
    }
    
    /**
     * Speed test endpoint - returns test data for network speed measurement
     * Returns 100MB of data for speed testing
     */
    @GetMapping("/speedtest")
    public ResponseEntity<byte[]> speedTest() {
        try {
            // Generate 100MB of test data
            int dataSizeMB = 100;
            int dataSizeBytes = dataSizeMB * 1024 * 1024;
            byte[] testData = new byte[dataSizeBytes];
            
            // Fill with pattern data (not zeros to avoid compression)
            for (int i = 0; i < testData.length; i++) {
                testData[i] = (byte) (i % 256);
            }
            
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_OCTET_STREAM);
            headers.setContentLength(dataSizeBytes);
            headers.set("Content-Disposition", "attachment; filename=speedtest.dat");
            
            return ResponseEntity.ok()
                    .headers(headers)
                    .body(testData);
        } catch (OutOfMemoryError e) {
            log.error("OutOfMemoryError generating speed test data", e);
            // Return smaller data if OOM
            byte[] smallData = new byte[1024 * 1024]; // 1MB
            for (int i = 0; i < smallData.length; i++) {
                smallData[i] = (byte) (i % 256);
            }
            return ResponseEntity.ok()
                    .header("Content-Type", "application/octet-stream")
                    .body(smallData);
        } catch (Exception e) {
            log.error("Error generating speed test data", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }
    
    /**
     * Get user connection logs with optional date filtering
     * @param startDate Optional start date (defaults to 5 days ago if not provided)
     * @param endDate Optional end date (defaults to now if not provided)
     * @return List of connection logs
     */
    @GetMapping("/connection-logs")
    public ResponseEntity<Map<String, Object>> getConnectionLogs(
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Date startDate,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Date endDate,
            @RequestParam(required = false, defaultValue = "0") int page,
            @RequestParam(required = false) Integer size,
            @RequestParam(required = false, defaultValue = "false") boolean includeCount,
            @RequestParam(required = false, defaultValue = "false") boolean includeUsernames) {
        try {
            Date start = startDate;
            Date end = endDate;
            
            // Default to 1 day ago if startDate is not provided (reduced from 5 days for better performance)
            if (start == null) {
                long oneDayAgo = System.currentTimeMillis() - (1L * 24 * 60 * 60 * 1000);
                start = new Date(oneDayAgo);
            }
            
            // Default to now if endDate is not provided
            if (end == null) {
                end = new Date();
            }

            int effectiveSize = size == null ? DEFAULT_CONNECTION_LOGS_PAGE_SIZE : Math.min(Math.max(size, 1), MAX_CONNECTION_LOGS_PAGE_SIZE);
            int safePage = Math.max(page, 0);

            // Query raw documents to avoid DBRef (Member) hydration/serialization overhead.
            Query q = new Query();
            q.addCriteria(Criteria.where("connectionDate").gte(start).lte(end));
            q.with(Sort.by(Sort.Direction.DESC, "connectionDate"));
            q.skip((long) safePage * effectiveSize);
            q.limit(effectiveSize);
            // Projection: only fetch required fields to reduce payload/serialization
            q.fields()
                .include("_id")
                .include("connectionDate")
                .include("ipAddress")
                .include("domainName")
                .include("location")
                .include("type")
                .include("discussionId")
                .include("discussionTitle")
                .include("member");

            List<Document> docs = mongoTemplate.find(q, Document.class, "userConnectionLogs");

            // Count total docs in range only if requested (can be expensive on large datasets)
            long totalInRange = -1;
            if (includeCount) {
                Query countQuery = new Query();
                countQuery.addCriteria(Criteria.where("connectionDate").gte(start).lte(end));
                totalInRange = mongoTemplate.count(countQuery, "userConnectionLogs");
            }

            // Collect Member IDs from DBRefs for batch username lookup (ONLY if includeUsernames=true)
            Map<String, String> memberIdToUserName = new HashMap<>();
            if (includeUsernames) {
                Set<String> memberIds = new HashSet<>();
                for (Document d : docs) {
                    Object memberObj = d.get("member");
                    if (memberObj instanceof DBRef) {
                        Object idObj = ((DBRef) memberObj).getId();
                        if (idObj != null) {
                            memberIds.add(String.valueOf(idObj));
                        }
                    } else if (memberObj instanceof Document) {
                        Document memberRef = (Document) memberObj;
                        Object idObj = memberRef.get("$id");
                        if (idObj != null) {
                            memberIds.add(String.valueOf(idObj));
                        }
                    }
                }

                if (!memberIds.isEmpty()) {
                    Query memberQuery = new Query(Criteria.where("_id").in(memberIds));
                    memberQuery.fields().include("_id").include("userName");
                    List<Document> memberDocs = mongoTemplate.find(memberQuery, Document.class, "members");
                    for (Document md : memberDocs) {
                        Object id = md.get("_id");
                        Object userName = md.get("userName");
                        if (id != null && userName != null) {
                            memberIdToUserName.put(String.valueOf(id), String.valueOf(userName));
                        }
                    }
                }
            }

            // Build lightweight response logs (no embedded Member object)
            List<Map<String, Object>> logs = new ArrayList<>(docs.size());
            for (Document d : docs) {
                String ipAddress = d.getString("ipAddress");
                // Filter out connection logs with invalid IP addresses (containing 0:0:0:0:0:0, ::, etc.)
                if (ipAddress != null && !ipAddress.isEmpty()) {
                    if (ipAddress.contains("0:0:0:0:0:0") ||
                        Objects.equals(ipAddress, "::") ||
                        Objects.equals(ipAddress, "0:0:0:0:0:0:0:0") ||
                        Objects.equals(ipAddress, "::1") ||
                        ipAddress.startsWith("0:0:0:0:0:0")) {
                        continue;
                    }
                }

                Map<String, Object> item = new HashMap<>();
                item.put("id", d.get("_id"));
                item.put("connectionDate", d.get("connectionDate"));
                item.put("ipAddress", ipAddress);
                item.put("domainName", d.getString("domainName"));
                item.put("location", d.getString("location"));
                item.put("type", d.getString("type"));
                item.put("discussionId", d.getString("discussionId"));
                item.put("discussionTitle", d.getString("discussionTitle"));

                // Only extract member info if usernames are requested (skip expensive lookup by default)
                Object memberObj = d.get("member");
                if (includeUsernames && memberObj != null) {
                    String memberId = null;
                    if (memberObj instanceof DBRef) {
                        Object idObj = ((DBRef) memberObj).getId();
                        if (idObj != null) {
                            memberId = String.valueOf(idObj);
                        }
                    } else if (memberObj instanceof Document) {
                        Document memberRef = (Document) memberObj;
                        Object idObj = memberRef.get("$id");
                        if (idObj != null) {
                            memberId = String.valueOf(idObj);
                        }
                    }
                    if (memberId != null) {
                        item.put("memberId", memberId);
                        item.put("memberUserName", memberIdToUserName.getOrDefault(memberId, "N/A"));
                    } else {
                        item.put("memberUserName", "N/A");
                    }
                } else {
                    // Skip member lookup for speed - just show memberId if available
                    if (memberObj instanceof DBRef) {
                        Object idObj = ((DBRef) memberObj).getId();
                        if (idObj != null) {
                            item.put("memberId", String.valueOf(idObj));
                        }
                    } else if (memberObj instanceof Document) {
                        Document memberRef = (Document) memberObj;
                        Object idObj = memberRef.get("$id");
                        if (idObj != null) {
                            item.put("memberId", String.valueOf(idObj));
                        }
                    }
                    item.put("memberUserName", null); // Will be shown as "N/A" in frontend
                }

                logs.add(item);
            }
            
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("logs", logs);
            response.put("startDate", start);
            response.put("endDate", end);
            // Keep previous behavior: count == returned rows
            response.put("count", logs.size());
            // Additional paging metadata for the UI (optional)
            response.put("page", safePage);
            response.put("size", effectiveSize);
            if (includeCount) {
                response.put("totalInRange", totalInRange);
                response.put("hasMore", ((long) (safePage + 1) * effectiveSize) < totalInRange);
            } else {
                // Infer hasMore from page size when count not requested
                response.put("hasMore", docs.size() >= effectiveSize);
            }
            
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                    .header(HttpHeaders.CACHE_CONTROL, "no-cache, no-store, must-revalidate")
                    .header(HttpHeaders.PRAGMA, "no-cache")
                    .header(HttpHeaders.EXPIRES, "0")
                    .body(response);
        } catch (Exception e) {
            log.error("Error retrieving connection logs", e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to retrieve connection logs: " + e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(error);
        }
    }
    
    /**
     * Check if current user is authorized to delete connection logs.
     */
    @PostMapping("/connection-logs/authorized")
    public ResponseEntity<Map<String, Object>> isDeleteConnectionLogsAuthorized(@RequestBody Member member) {
        log.info("Delete connection logs authorization check requested for user: {}", member.getId());
        try {
            boolean isAuthorized = hasAdminRole();
            
            Map<String, Object> response = new HashMap<>();
            response.put("authorized", isAuthorized);
            response.put("success", true);
            
            if (!isAuthorized) {
                response.put("message", member.getUserName() + " : You are not authorized to delete connection logs. Admin role required.");
            }
            
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error checking delete connection logs authorization", e);
            Map<String, Object> response = new HashMap<>();
            response.put("authorized", false);
            response.put("success", false);
            response.put("message", "Error: " + e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }
    
    /**
     * Delete all user connection logs from the database
     * @return Response indicating success or failure
     */
    @PostMapping("/connection-logs/delete")
    public ResponseEntity<Map<String, Object>> deleteAllConnectionLogs(@RequestBody Member member) {
        log.info("Delete connection logs requested by user: {}", member.getId());
        try {
            // Check authorization - must have Admin role
            if (!hasAdminRole()) {
                Map<String, Object> response = new HashMap<>();
                response.put("success", false);
                response.put("authorized", false);
                response.put("error", member.getUserName() + " : You are not authorized to delete connection logs. Admin role required.");
                log.warn("Unauthorized delete connection logs attempt by user: {}", member.getId());
                return ResponseEntity.status(HttpStatus.FORBIDDEN).body(response);
            }
            
            long countBefore = userConnectionLogRepository.count();
            userConnectionLogRepository.deleteAll();
            
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("authorized", true);
            response.put("deletedCount", countBefore);
            response.put("message", "Successfully deleted " + countBefore + " connection log(s)");
            
            log.info("Deleted {} connection logs from database by user: {}", countBefore, member.getId());
            
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                    .body(response);
        } catch (Exception e) {
            log.error("Error deleting connection logs", e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to delete connection logs: " + e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(error);
        }
    }
}

