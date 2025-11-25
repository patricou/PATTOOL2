package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryUsage;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Service to monitor JVM memory usage and prevent OutOfMemoryError
 * by detecting high memory usage early and potentially rejecting requests
 */
@Service
public class MemoryMonitoringService {

    private static final Logger log = LoggerFactory.getLogger(MemoryMonitoringService.class);
    
    // Default threshold: 85% of max heap
    @Value("${app.memory.warning-threshold:85}")
    private int warningThresholdPercent;
    
    // Critical threshold: 90% of max heap - reject new requests
    @Value("${app.memory.critical-threshold:90}")
    private int criticalThresholdPercent;
    
    private final AtomicLong lastWarningTime = new AtomicLong(0);
    private final AtomicLong lastCriticalTime = new AtomicLong(0);
    
    // Cached memory values from last check to ensure consistency
    private volatile long lastCheckedUsedMemory = 0;
    private volatile long lastCheckedMaxMemory = 0;
    private volatile double lastCheckedUsagePercent = 0.0;
    private volatile long lastCheckedCommittedMemory = 0;
    
    // Executor for async GC suggestion (single thread to avoid overhead)
    private final ExecutorService gcExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "memory-gc-suggestor");
        t.setDaemon(true);
        return t;
    });
    
    // Minimum interval between warnings (5 minutes)
    private static final long WARNING_INTERVAL_MS = 5 * 60 * 1000;
    
    // Minimum interval between critical alerts (1 minute)
    private static final long CRITICAL_INTERVAL_MS = 60 * 1000;
    
    @PostConstruct
    public void init() {
        log.info("MemoryMonitoringService initialized. Warning threshold: {}%, Critical threshold: {}%", 
                warningThresholdPercent, criticalThresholdPercent);
    }
    
    /**
     * Check current memory usage and log warning if above threshold
     * Uses MemoryMXBean for more accurate memory metrics
     * @return true if memory usage is acceptable, false if critical
     */
    public boolean checkMemoryUsage() {
        try {
            // Use MemoryMXBean for more accurate memory metrics
            MemoryMXBean memoryBean = ManagementFactory.getMemoryMXBean();
            MemoryUsage heapUsage = memoryBean.getHeapMemoryUsage();
            
            // Get accurate memory metrics
            long usedMemory = heapUsage.getUsed();      // Memory currently used
            long maxMemory = heapUsage.getMax();        // Maximum memory available (-1 if unbounded)
            
            // If max is -1 (unbounded), fall back to Runtime.getRuntime().maxMemory()
            if (maxMemory == -1) {
                maxMemory = Runtime.getRuntime().maxMemory();
            }
            
            // Calculate usage percentage: (used / max) * 100
            // This is the percentage of max heap that is currently used
            double usagePercent = (usedMemory * 100.0) / maxMemory;
            
            // Cache the values to ensure consistency across multiple method calls
            // This prevents race conditions where GC occurs between checkMemoryUsage() and getMemoryInfo()
            long committedMemory = heapUsage.getCommitted();
            this.lastCheckedUsedMemory = usedMemory;
            this.lastCheckedMaxMemory = maxMemory;
            this.lastCheckedUsagePercent = usagePercent;
            this.lastCheckedCommittedMemory = committedMemory;
            
            long currentTime = System.currentTimeMillis();
            
            // Check critical threshold
            if (usagePercent >= criticalThresholdPercent) {
                long lastCritical = lastCriticalTime.get();
                if (currentTime - lastCritical > CRITICAL_INTERVAL_MS) {
                    if (lastCriticalTime.compareAndSet(lastCritical, currentTime)) {
                        log.error("CRITICAL: Memory usage at {}% ({} MB / {} MB). " +
                                "Server may reject requests to prevent OutOfMemoryError.",
                                String.format("%.1f", usagePercent),
                                usedMemory / (1024 * 1024),
                                maxMemory / (1024 * 1024));
                        
                        // Suggest garbage collection asynchronously to avoid race conditions
                        // This runs in a separate thread so it doesn't affect the current memory check
                        gcExecutor.submit(() -> {
                            try {
                                Thread.sleep(100); // Small delay to ensure check completes first
                                System.gc();
                            } catch (InterruptedException e) {
                                Thread.currentThread().interrupt();
                            } catch (Throwable t) {
                                // Ignore - GC suggestion failed
                            }
                        });
                    }
                }
                return false; // Critical - should reject requests
            }
            
            // Check warning threshold
            if (usagePercent >= warningThresholdPercent) {
                long lastWarning = lastWarningTime.get();
                if (currentTime - lastWarning > WARNING_INTERVAL_MS) {
                    if (lastWarningTime.compareAndSet(lastWarning, currentTime)) {
                        log.warn("WARNING: High memory usage detected: {}% ({} MB / {} MB). " +
                                "Consider increasing heap size or investigating memory leaks.",
                                String.format("%.1f", usagePercent),
                                usedMemory / (1024 * 1024),
                                maxMemory / (1024 * 1024));
                    }
                }
            }
            
            return true; // Memory usage is acceptable
        } catch (Throwable t) {
            // If we can't check memory, assume it's OK (better than blocking)
            log.debug("Error checking memory usage", t);
            return true;
        }
    }
    
    /**
     * Get current memory usage percentage
     * Uses cached values from last checkMemoryUsage() call for consistency
     * @return memory usage percentage (0-100)
     */
    public double getMemoryUsagePercent() {
        // Return cached value from last check to ensure consistency
        // This prevents race conditions where GC occurs between check and display
        if (lastCheckedUsagePercent > 0) {
            return lastCheckedUsagePercent;
        }
        
        // Fallback: calculate fresh if no cached value available
        try {
            MemoryMXBean memoryBean = ManagementFactory.getMemoryMXBean();
            MemoryUsage heapUsage = memoryBean.getHeapMemoryUsage();
            
            long usedMemory = heapUsage.getUsed();
            long maxMemory = heapUsage.getMax();
            
            // If max is -1 (unbounded), fall back to Runtime.getRuntime().maxMemory()
            if (maxMemory == -1) {
                maxMemory = Runtime.getRuntime().maxMemory();
            }
            
            return (usedMemory * 100.0) / maxMemory;
        } catch (Throwable t) {
            return 0.0;
        }
    }
    
    /**
     * Get memory information as a string
     * Uses cached values from last checkMemoryUsage() call for consistency
     */
    public String getMemoryInfo() {
        // Use cached values from last check to ensure consistency
        // This prevents race conditions where GC occurs between check and display
        if (lastCheckedUsedMemory > 0 && lastCheckedMaxMemory > 0) {
            long freeMemory = lastCheckedMaxMemory - lastCheckedUsedMemory;
            return String.format("Memory: %.1f%% used (%d MB / %d MB max, %d MB free, %d MB committed)",
                    lastCheckedUsagePercent,
                    lastCheckedUsedMemory / (1024 * 1024),
                    lastCheckedMaxMemory / (1024 * 1024),
                    freeMemory / (1024 * 1024),
                    lastCheckedCommittedMemory / (1024 * 1024));
        }
        
        // Fallback: calculate fresh if no cached values available
        try {
            MemoryMXBean memoryBean = ManagementFactory.getMemoryMXBean();
            MemoryUsage heapUsage = memoryBean.getHeapMemoryUsage();
            
            long usedMemory = heapUsage.getUsed();
            long committedMemory = heapUsage.getCommitted();
            long maxMemory = heapUsage.getMax();
            
            // If max is -1 (unbounded), fall back to Runtime.getRuntime().maxMemory()
            if (maxMemory == -1) {
                maxMemory = Runtime.getRuntime().maxMemory();
            }
            
            long freeMemory = maxMemory - usedMemory;
            double usagePercent = (usedMemory * 100.0) / maxMemory;
            
            return String.format("Memory: %.1f%% used (%d MB / %d MB max, %d MB free, %d MB committed)",
                    usagePercent,
                    usedMemory / (1024 * 1024),
                    maxMemory / (1024 * 1024),
                    freeMemory / (1024 * 1024),
                    committedMemory / (1024 * 1024));
        } catch (Throwable t) {
            return "Unable to retrieve memory info";
        }
    }
    
    /**
     * Force garbage collection (non-blocking suggestion)
     */
    public void suggestGarbageCollection() {
        try {
            System.gc();
        } catch (Throwable t) {
            // Ignore
        }
    }
}

