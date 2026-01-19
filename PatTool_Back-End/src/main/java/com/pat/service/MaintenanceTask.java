package com.pat.service;

import com.pat.controller.MailController;
import com.pat.repo.GoveeThermometerHistoryRepository;
import com.pat.repo.domain.GoveeThermometerHistory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

/**
 * Scheduled task to save the image compression cache to file system daily at 6:00 AM
 * and clean up old Govee thermometer history records.
 */
@Component
public class MaintenanceTask {

    private static final Logger log = LoggerFactory.getLogger(MaintenanceTask.class);
    
    @Autowired
    private CachePersistenceService cachePersistenceService;
    
    @Autowired
    private GoveeThermometerHistoryRepository goveeThermometerHistoryRepository;
    
    @Autowired
    private MongoTemplate mongoTemplate;
    
    @Autowired(required = false)
    private MailController mailController;
    
    @Value("${govee.thermometer.history.retention.days:30}")
    private int retentionDays;
    
    /**
     * Main scheduled maintenance task that runs every day at 6:00 AM.
     * Cron format: second, minute, hour, day, month, weekday
     * 0 0 6 * * * = every day at 6:00:00 AM
     * Executes all maintenance tasks: cache save and cleanup of old records.
     */
    @Scheduled(cron = "0 0 6 * * *")
    public void executeMaintenanceTasks() {
        log.debug("========== STARTING DAILY MAINTENANCE TASKS AT 6:00 AM ==========");
        CachePersistenceService.CacheSaveResult cacheResult = null;
        long goveeDeletedCount = 0;
        long goveeRemainingCount = 0;
        boolean goveeCleanupSuccess = false;
        
        try {
            // Execute cache save
            cacheResult = saveCacheDaily();
            
            // Execute cleanup of old Govee thermometer history
            GoveeCleanupResult goveeResult = cleanupOldGoveeThermometerHistory();
            if (goveeResult != null) {
                goveeDeletedCount = goveeResult.getDeletedCount();
                goveeRemainingCount = goveeResult.getRemainingCount();
                goveeCleanupSuccess = goveeResult.isSuccess();
            }
            
            // Send email notification with both cache and Govee cleanup results
            if (cacheResult != null) {
                sendMaintenanceEmail(cacheResult, goveeDeletedCount, goveeRemainingCount, goveeCleanupSuccess);
            }
            
            log.debug("========== DAILY MAINTENANCE TASKS COMPLETED ==========");
        } catch (Exception e) {
            log.error("Error during daily maintenance tasks execution", e);
        }
    }
    
    /**
     * Save cache to file system.
     * @return Cache save result, or null if failed
     */
    private CachePersistenceService.CacheSaveResult saveCacheDaily() {
        log.debug("Starting scheduled cache save");
        try {
            CachePersistenceService.CacheSaveResult result = cachePersistenceService.saveCache();
            if (result.isSuccess()) {
                log.debug("Scheduled cache save completed: {} entries, {} bytes", 
                        result.getEntryCount(), result.getSavedSizeBytes());
            } else {
                log.error("Scheduled cache save failed: {}", result.getMessage());
            }
            return result;
        } catch (Exception e) {
            log.error("Error during scheduled cache save", e);
            return null;
        }
    }
    
    /**
     * Delete old Govee thermometer history records.
     * Deletes records older than the configured retention period (default: 30 days).
     * @return Govee cleanup result with statistics, or null if failed
     */
    private GoveeCleanupResult cleanupOldGoveeThermometerHistory() {
        log.debug("Starting cleanup of old Govee thermometer history records (retention: {} days)", retentionDays);
        try {
            // Calculate the cutoff date (retentionDays ago from now)
            LocalDateTime cutoffDate = LocalDateTime.now().minusDays(retentionDays);
            
            log.debug("Deleting Govee thermometer history records older than: {}", cutoffDate);
            
            // Delete all records older than cutoff date using MongoTemplate
            Query query = new Query(Criteria.where("timestamp").lt(cutoffDate));
            long deletedCount = mongoTemplate.remove(query, GoveeThermometerHistory.class, "govee_thermometer_history").getDeletedCount();
            
            long countAfter = goveeThermometerHistoryRepository.count();
            
            log.debug("Govee thermometer history cleanup completed: {} records deleted, {} records remaining", 
                    deletedCount, countAfter);
            
            return new GoveeCleanupResult(true, deletedCount, countAfter, null);
                    
        } catch (Exception e) {
            log.error("Error during cleanup of old Govee thermometer history records", e);
            return new GoveeCleanupResult(false, 0, 0, e.getMessage());
        }
    }
    
    /**
     * Send email notification with maintenance tasks results (cache save and Govee cleanup).
     */
    private void sendMaintenanceEmail(CachePersistenceService.CacheSaveResult cacheResult, 
                                     long goveeDeletedCount, long goveeRemainingCount, boolean goveeCleanupSuccess) {
        if (mailController == null) {
            log.debug("MailController not available, skipping email notification");
            return;
        }
        
        try {
            String timestamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"));
            String subject = "PatTool Maintenance Tasks Report - " + timestamp;
            
            double sizeMB = cacheResult.getSavedSizeBytes() / (1024.0 * 1024.0);
            double fileSizeMB = cacheResult.getFileSizeBytes() / (1024.0 * 1024.0);
            
            // Build email body with both cache and Govee information
            StringBuilder bodyBuilder = new StringBuilder();
            bodyBuilder.append("<html><body style='font-family: Arial, sans-serif;'>");
            bodyBuilder.append("<h2 style='color: #2c3e50;'>Daily Maintenance Tasks Report</h2>");
            bodyBuilder.append("<p>Maintenance tasks completed at ").append(timestamp).append("</p>");
            
            // Cache Save Section
            bodyBuilder.append("<h3 style='color: #34495e; margin-top: 20px;'>Image Compression Cache Save</h3>");
            bodyBuilder.append("<table style='border-collapse: collapse; width: 100%%; max-width: 600px;'>");
            bodyBuilder.append(String.format(
                "<tr style='background-color: #f2f2f2;'><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>Status:</td><td style='padding: 8px; border: 1px solid #ddd;'>%s</td></tr>" +
                "<tr><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>Entries Saved:</td><td style='padding: 8px; border: 1px solid #ddd;'>%d</td></tr>" +
                "<tr style='background-color: #f2f2f2;'><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>Cache Size:</td><td style='padding: 8px; border: 1px solid #ddd;'>%.2f MB</td></tr>" +
                "<tr><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>File Size:</td><td style='padding: 8px; border: 1px solid #ddd;'>%.2f MB</td></tr>" +
                "<tr style='background-color: #f2f2f2;'><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>Message:</td><td style='padding: 8px; border: 1px solid #ddd;'>%s</td></tr>",
                cacheResult.isSuccess() ? "✅ Success" : "❌ Failed",
                cacheResult.getEntryCount(),
                sizeMB,
                fileSizeMB,
                cacheResult.getMessage()
            ));
            bodyBuilder.append("</table>");
            
            // Govee Cleanup Section
            bodyBuilder.append("<h3 style='color: #34495e; margin-top: 30px;'>Govee Thermometer History Cleanup</h3>");
            bodyBuilder.append("<table style='border-collapse: collapse; width: 100%%; max-width: 600px;'>");
            bodyBuilder.append(String.format(
                "<tr style='background-color: #f2f2f2;'><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>Status:</td><td style='padding: 8px; border: 1px solid #ddd;'>%s</td></tr>" +
                "<tr><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>Records Deleted:</td><td style='padding: 8px; border: 1px solid #ddd;'>%d</td></tr>" +
                "<tr style='background-color: #f2f2f2;'><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>Records Remaining:</td><td style='padding: 8px; border: 1px solid #ddd;'>%d</td></tr>",
                goveeCleanupSuccess ? "✅ Success" : "❌ Failed",
                goveeDeletedCount,
                goveeRemainingCount
            ));
            bodyBuilder.append("</table>");
            
            bodyBuilder.append("<p style='margin-top: 20px; color: #7f8c8d; font-size: 12px;'>This is an automated notification from the PatTool application.</p>");
            bodyBuilder.append("</body></html>");
            
            mailController.sendMail(subject, bodyBuilder.toString(), true);
            log.debug("Maintenance tasks notification email sent (Cache + Govee cleanup)");
        } catch (Exception e) {
            log.error("Failed to send maintenance tasks notification email", e);
        }
    }
    
    /**
     * Internal class to store Govee cleanup result
     */
    private static class GoveeCleanupResult {
        private final boolean success;
        private final long deletedCount;
        private final long remainingCount;
        private final String errorMessage;
        
        public GoveeCleanupResult(boolean success, long deletedCount, long remainingCount, String errorMessage) {
            this.success = success;
            this.deletedCount = deletedCount;
            this.remainingCount = remainingCount;
            this.errorMessage = errorMessage;
        }
        
        public boolean isSuccess() { return success; }
        public long getDeletedCount() { return deletedCount; }
        public long getRemainingCount() { return remainingCount; }
        public String getErrorMessage() { return errorMessage; }
    }
}
