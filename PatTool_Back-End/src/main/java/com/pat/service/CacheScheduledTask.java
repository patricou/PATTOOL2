package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Scheduled task to save the image compression cache to file system daily at 6:00 AM.
 */
@Component
public class CacheScheduledTask {

    private static final Logger log = LoggerFactory.getLogger(CacheScheduledTask.class);
    
    @Autowired
    private CachePersistenceService cachePersistenceService;
    
    /**
     * Save cache every day at 6:00 AM.
     * Cron format: second, minute, hour, day, month, weekday
     * 0 0 6 * * * = every day at 6:00:00 AM
     */
    @Scheduled(cron = "0 0 6 * * *")
    public void saveCacheDaily() {
        log.info("Starting scheduled cache save at 6:00 AM");
        try {
            CachePersistenceService.CacheSaveResult result = cachePersistenceService.saveCache();
            if (result.isSuccess()) {
                log.info("Scheduled cache save completed: {} entries, {} bytes", 
                        result.getEntryCount(), result.getSavedSizeBytes());
                // Send email notification
                cachePersistenceService.sendCacheSaveEmail(result);
            } else {
                log.warn("Scheduled cache save failed: {}", result.getMessage());
            }
        } catch (Exception e) {
            log.error("Error during scheduled cache save", e);
        }
    }
}

