package com.pat.controller;

import com.pat.service.MemoryMonitoringService;
import com.pat.service.ImageCompressionService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.HashMap;
import java.util.Map;

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
}

