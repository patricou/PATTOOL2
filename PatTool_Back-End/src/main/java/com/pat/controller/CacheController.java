package com.pat.controller;

import com.pat.repo.domain.Member;
import com.pat.service.CachePersistenceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ApplicationContext;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

/**
 * REST controller for cache management operations.
 */
@RestController
@RequestMapping("/api/cache")
public class CacheController {

    private static final Logger log = LoggerFactory.getLogger(CacheController.class);
    
    @Autowired
    private CachePersistenceService cachePersistenceService;
    
    @Autowired
    private com.pat.service.ImageCompressionService imageCompressionService;
    
    @Autowired
    private ApplicationContext applicationContext;
    
    @Value("${app.admin.userid}")
    private String authorizedUserId;
    
    /**
     * Save cache to file system.
     */
    @PostMapping("/save")
    public ResponseEntity<Map<String, Object>> saveCache() {
        log.info("Cache save requested via REST API");
        try {
            CachePersistenceService.CacheSaveResult result = cachePersistenceService.saveCache();
            
            Map<String, Object> response = new HashMap<>();
            response.put("success", result.isSuccess());
            response.put("entryCount", result.getEntryCount());
            response.put("savedSizeBytes", result.getSavedSizeBytes());
            response.put("fileSizeBytes", result.getFileSizeBytes());
            response.put("message", result.getMessage());
            
            if (result.isSuccess()) {
                // Send email notification
                cachePersistenceService.sendCacheSaveEmail(result);
                return ResponseEntity.ok(response);
            } else {
                return ResponseEntity.badRequest().body(response);
            }
        } catch (Exception e) {
            log.error("Error saving cache via REST API", e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", "Error: " + e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }
    
    /**
     * Load cache from file system.
     */
    @PostMapping("/load")
    public ResponseEntity<Map<String, Object>> loadCache() {
        log.info("Cache load requested via REST API");
        try {
            CachePersistenceService.CacheLoadResult result = cachePersistenceService.loadCache();
            
            Map<String, Object> response = new HashMap<>();
            response.put("success", result.isSuccess());
            response.put("entryCount", result.getEntryCount());
            response.put("loadedSizeBytes", result.getLoadedSizeBytes());
            response.put("message", result.getMessage());
            
            if (result.isSuccess()) {
                return ResponseEntity.ok(response);
            } else {
                return ResponseEntity.badRequest().body(response);
            }
        } catch (Exception e) {
            log.error("Error loading cache via REST API", e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", "Error: " + e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }
    
    /**
     * Clear cache from both memory and file system.
     */
    @PostMapping("/clear")
    public ResponseEntity<Map<String, Object>> clearCache() {
        log.info("Cache clear requested via REST API");
        try {
            CachePersistenceService.CacheClearResult result = cachePersistenceService.clearCache();
            
            Map<String, Object> response = new HashMap<>();
            response.put("success", result.isSuccess());
            response.put("memoryEntries", result.getMemoryEntries());
            response.put("fileDeleted", result.isFileDeleted());
            response.put("message", result.getMessage());
            
            if (result.isSuccess()) {
                return ResponseEntity.ok(response);
            } else {
                return ResponseEntity.badRequest().body(response);
            }
        } catch (Exception e) {
            log.error("Error clearing cache via REST API", e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", "Error: " + e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }
    
    /**
     * Check if cache file exists.
     */
    @GetMapping("/exists")
    public ResponseEntity<Map<String, Object>> cacheFileExists() {
        log.debug("Cache file existence check requested via REST API");
        try {
            boolean exists = cachePersistenceService.cacheFileExists();
            
            Map<String, Object> response = new HashMap<>();
            response.put("exists", exists);
            response.put("success", true);
            
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error checking cache file existence via REST API", e);
            Map<String, Object> response = new HashMap<>();
            response.put("exists", false);
            response.put("success", false);
            response.put("message", "Error: " + e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }
    
    /**
     * Check if current user is authorized to shutdown the application.
     */
    @PostMapping("/shutdown/authorized")
    public ResponseEntity<Map<String, Object>> isShutdownAuthorized(@RequestBody Member member) {
        log.info("Shutdown authorization check requested for user: {}", member.getId());
        try {
            boolean isAuthorized = this.authorizedUserId.equals(member.getId());
            
            Map<String, Object> response = new HashMap<>();
            response.put("authorized", isAuthorized);
            response.put("success", true);
            
            if (!isAuthorized) {
                response.put("message", member.getUserName() + " : You are not authorized to shutdown the application");
            }
            
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error checking shutdown authorization", e);
            Map<String, Object> response = new HashMap<>();
            response.put("authorized", false);
            response.put("success", false);
            response.put("message", "Error: " + e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }
    
    /**
     * Shutdown application after saving cache.
     */
    @PostMapping("/shutdown")
    public ResponseEntity<Map<String, Object>> shutdownApplication(@RequestBody Member member) {
        log.info("Application shutdown requested via REST API by user: {}", member.getId());
        
        // Check authorization
        if (!this.authorizedUserId.equals(member.getId())) {
            log.warn("Unauthorized shutdown attempt by user: {} ({})", member.getUserName(), member.getId());
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("authorized", false);
            response.put("message", member.getUserName() + " : You are not authorized to shutdown the application");
            return ResponseEntity.status(403).body(response);
        }
        
        try {
            // First, save the cache
            log.info("Saving cache before shutdown...");
            CachePersistenceService.CacheSaveResult saveResult = cachePersistenceService.saveCache();
            
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("cacheSaved", saveResult.isSuccess());
            response.put("cacheEntryCount", saveResult.getEntryCount());
            response.put("message", "Cache saved. Application will shutdown in a few seconds.");
            
            // Send email notification if cache was saved successfully
            if (saveResult.isSuccess()) {
                cachePersistenceService.sendCacheSaveEmail(saveResult);
            }
            
            // Schedule graceful shutdown in a separate thread to allow response to be sent
            new Thread(() -> {
                try {
                    Thread.sleep(2000); // Wait 2 seconds to allow response to be sent
                    log.info("Initiating graceful application shutdown...");
                    
                    // Use Spring Boot's graceful shutdown mechanism
                    int exitCode = SpringApplication.exit(applicationContext, () -> 0);
                    log.info("Application shutdown initiated with exit code: {}", exitCode);
                    System.exit(exitCode);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    log.error("Shutdown thread interrupted", e);
                    System.exit(1);
                } catch (Exception e) {
                    log.error("Error during graceful shutdown, forcing exit", e);
                    System.exit(1);
                }
            }).start();
            
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error during shutdown process", e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", "Error: " + e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }
    
    /**
     * Get cache statistics.
     */
    @GetMapping("/stats")
    public ResponseEntity<Map<String, Object>> getCacheStats() {
        try {
            Map<String, Object> cacheStats = imageCompressionService.getCacheStatistics();
            
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("enabled", cacheStats.get("enabled"));
            response.put("entryCount", cacheStats.get("entryCount"));
            response.put("totalSizeBytes", cacheStats.get("totalSizeBytes"));
            response.put("totalSizeMB", cacheStats.get("totalSizeMB"));
            response.put("maxEntries", cacheStats.get("maxEntries"));
            response.put("cacheSize", cacheStats.get("cacheSize"));
            
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error getting cache stats", e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", "Error: " + e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }
}

