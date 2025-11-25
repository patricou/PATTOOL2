package com.pat.controller;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.HashMap;
import java.util.Map;
import com.sun.management.OperatingSystemMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;

@RestController
@RequestMapping("/api/system")
public class SystemInfoController {

    private static final Logger log = LoggerFactory.getLogger(SystemInfoController.class);

    @GetMapping("/ping")
    public ResponseEntity<Map<String, Object>> ping() {
        try {
            Map<String, Object> response = new HashMap<>();
            response.put("status", "ok");
            response.put("timestamp", System.currentTimeMillis());
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error in ping endpoint", e);
            Map<String, Object> error = new HashMap<>();
            error.put("error", "Ping failed: " + e.getMessage());
            return ResponseEntity.status(500).body(error);
        }
    }

    // Speed test endpoint removed - use /api/system/speedtest from SystemController instead

    @GetMapping("/physical-memory")
    public ResponseEntity<Map<String, Object>> getSystemMemory() {
        try {
            Map<String, Object> memoryInfo = new HashMap<>();
            
            // Get JVM memory info
            MemoryMXBean memoryBean = ManagementFactory.getMemoryMXBean();
            long heapUsed = memoryBean.getHeapMemoryUsage().getUsed();
            long heapMax = memoryBean.getHeapMemoryUsage().getMax();
            long heapCommitted = memoryBean.getHeapMemoryUsage().getCommitted();
            
            // Get system memory info (requires com.sun.management)
            OperatingSystemMXBean osBean = (OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();
            
            // Total physical memory
            // Note: Methods may be deprecated in Java 14+, but we use them for compatibility
            @SuppressWarnings("deprecation")
            long totalPhysicalMemory = osBean.getTotalPhysicalMemorySize();
            
            // Free physical memory
            @SuppressWarnings("deprecation")
            long freePhysicalMemory = osBean.getFreePhysicalMemorySize();
            
            // Used physical memory (total - free)
            long usedPhysicalMemory = totalPhysicalMemory - freePhysicalMemory;
            
            // Convert to MB
            long totalMB = totalPhysicalMemory / (1024 * 1024);
            long usedMB = usedPhysicalMemory / (1024 * 1024);
            long freeMB = freePhysicalMemory / (1024 * 1024);
            
            memoryInfo.put("totalMB", totalMB);
            memoryInfo.put("usedMB", usedMB);
            memoryInfo.put("freeMB", freeMB);
            memoryInfo.put("totalGB", String.format("%.2f", totalMB / 1024.0));
            memoryInfo.put("usedGB", String.format("%.2f", usedMB / 1024.0));
            memoryInfo.put("freeGB", String.format("%.2f", freeMB / 1024.0));
            memoryInfo.put("usagePercent", Math.round((usedPhysicalMemory * 100.0) / totalPhysicalMemory));
            
            // JVM heap info (for reference)
            memoryInfo.put("heapUsedMB", heapUsed / (1024 * 1024));
            memoryInfo.put("heapMaxMB", heapMax / (1024 * 1024));
            memoryInfo.put("heapCommittedMB", heapCommitted / (1024 * 1024));
            
            log.debug("System memory info retrieved - Used: {} MB / Total: {} MB", usedMB, totalMB);
            
            return ResponseEntity.ok(memoryInfo);
        } catch (Exception e) {
            log.error("Error retrieving system memory info", e);
            Map<String, Object> error = new HashMap<>();
            error.put("error", "Unable to retrieve system memory information: " + e.getMessage());
            return ResponseEntity.status(500).body(error);
        }
    }
}

