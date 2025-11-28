package com.pat.service;

import com.pat.controller.MailController;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Map;

/**
 * Service for persisting and loading the image compression cache to/from the file system.
 */
@Service
public class CachePersistenceService {

    private static final Logger log = LoggerFactory.getLogger(CachePersistenceService.class);
    
    @Autowired
    private ImageCompressionService imageCompressionService;
    
    @Autowired(required = false)
    private MailController mailController;
    
    @Value("${app.cache.persistence.dir:./cache}")
    private String cacheDir;
    
    @Value("${app.cache.persistence.filename:image-cache.dat}")
    private String cacheFilename;
    
    /**
     * Save the current cache to the file system.
     * @return Statistics about the saved cache
     */
    public CacheSaveResult saveCache() {
        try {
            Path cachePath = getCacheFilePath();
            Files.createDirectories(cachePath.getParent());
            
            Map<String, Object> stats = imageCompressionService.getCacheStatistics();
            int entryCount = (Integer) stats.get("entryCount");
            
            if (entryCount == 0) {
                log.info("Cache is empty, nothing to save");
                return new CacheSaveResult(false, 0, 0, 0, "Cache is empty");
            }
            
            // Get the cache map
            Map<String, ImageCompressionService.CacheEntry> cacheMap = imageCompressionService.getAllCacheEntries();
            
            // First pass: count valid entries
            long now = System.currentTimeMillis();
            int validCount = 0;
            for (ImageCompressionService.CacheEntry cacheEntry : cacheMap.values()) {
                if (!isExpired(cacheEntry, now)) {
                    validCount++;
                }
            }
            
            if (validCount == 0) {
                log.info("No valid cache entries to save");
                return new CacheSaveResult(false, 0, 0, 0, "No valid cache entries to save");
            }
            
            // Second pass: write to file
            int savedCount = 0;
            long savedSize = 0;
            try (ObjectOutputStream oos = new ObjectOutputStream(
                    new BufferedOutputStream(Files.newOutputStream(cachePath)))) {
                oos.writeInt(validCount);
                
                for (Map.Entry<String, ImageCompressionService.CacheEntry> entry : cacheMap.entrySet()) {
                    ImageCompressionService.CacheEntry cacheEntry = entry.getValue();
                    // Only save non-expired entries
                    if (!isExpired(cacheEntry, now)) {
                        oos.writeUTF(entry.getKey());
                        oos.writeLong(cacheEntry.getCreatedAt());
                        ImageCompressionService.CompressionResult result = cacheEntry.getResult();
                        oos.writeLong(result.getOriginalSize());
                        oos.writeLong(result.getCompressedSize());
                        byte[] data = result.getData();
                        oos.writeInt(data.length);
                        oos.write(data);
                        // Write EXIF metadata
                        Map<String, String> exifMetadata = result.getExifMetadata();
                        oos.writeInt(exifMetadata.size());
                        for (Map.Entry<String, String> exifEntry : exifMetadata.entrySet()) {
                            oos.writeUTF(exifEntry.getKey());
                            oos.writeUTF(exifEntry.getValue());
                        }
                        savedCount++;
                        savedSize += data.length;
                    }
                }
            }
            
            long fileSize = Files.size(cachePath);
            log.info("Cache saved successfully: {} entries, {} bytes to file: {}", 
                    savedCount, fileSize, cachePath);
            
            return new CacheSaveResult(true, savedCount, savedSize, fileSize, 
                    "Cache saved successfully");
                    
        } catch (Exception e) {
            log.error("Failed to save cache to file system", e);
            return new CacheSaveResult(false, 0, 0, 0, 
                    "Error: " + e.getMessage());
        }
    }
    
    /**
     * Load the cache from the file system.
     * @return Statistics about the loaded cache
     */
    public CacheLoadResult loadCache() {
        try {
            Path cachePath = getCacheFilePath();
            
            if (!Files.exists(cachePath)) {
                log.info("Cache file does not exist: {}", cachePath);
                return new CacheLoadResult(false, 0, 0, "Cache file does not exist");
            }
            
            try (ObjectInputStream ois = new ObjectInputStream(
                    new BufferedInputStream(Files.newInputStream(cachePath)))) {
                
                int entryCount = ois.readInt();
                int loadedCount = 0;
                long loadedSize = 0;
                
                for (int i = 0; i < entryCount; i++) {
                    try {
                        String key = ois.readUTF();
                        long createdAt = ois.readLong();
                        long originalSize = ois.readLong();
                        ois.readLong(); // Skip compressedSize (we'll calculate it from data length)
                        int dataLength = ois.readInt();
                        byte[] data = new byte[dataLength];
                        ois.readFully(data);
                        
                        // Read EXIF metadata
                        int metadataSize = ois.readInt();
                        Map<String, String> exifMetadata = new java.util.LinkedHashMap<>();
                        for (int j = 0; j < metadataSize; j++) {
                            String exifKey = ois.readUTF();
                            String exifValue = ois.readUTF();
                            exifMetadata.put(exifKey, exifValue);
                        }
                        
                        // Create CompressionResult
                        ImageCompressionService.CompressionResult result = 
                            createCompressionResult(data, originalSize, exifMetadata);
                        
                        // Add to cache using the service method
                        imageCompressionService.addCacheEntry(key, result, createdAt);
                        loadedCount++;
                        loadedSize += data.length;
                        
                    } catch (Exception e) {
                        log.warn("Failed to load cache entry {}: {}", i, e.getMessage());
                        // Continue loading other entries
                    }
                }
                
                log.info("Cache loaded successfully: {} entries, {} bytes from file: {}", 
                        loadedCount, loadedSize, cachePath);
                
                return new CacheLoadResult(true, loadedCount, loadedSize, 
                        "Cache loaded successfully");
                        
            } catch (EOFException e) {
                log.warn("Cache file appears to be corrupted or incomplete: {}", e.getMessage());
                return new CacheLoadResult(false, 0, 0, 
                        "Cache file is corrupted: " + e.getMessage());
            }
            
        } catch (Exception e) {
            log.error("Failed to load cache from file system", e);
            return new CacheLoadResult(false, 0, 0, 
                    "Error: " + e.getMessage());
        }
    }
    
    /**
     * Clear the cache from both memory and file system.
     */
    public CacheClearResult clearCache() {
        try {
            // Clear from memory
            Map<String, ImageCompressionService.CacheEntry> cacheMap = imageCompressionService.getAllCacheEntries();
            int memoryEntries = cacheMap.size();
            imageCompressionService.clearAllCacheEntries();
            
            // Clear from file system
            Path cachePath = getCacheFilePath();
            boolean fileDeleted = false;
            if (Files.exists(cachePath)) {
                Files.delete(cachePath);
                fileDeleted = true;
            }
            
            log.info("Cache cleared: {} entries from memory, file deleted: {}", 
                    memoryEntries, fileDeleted);
            
            return new CacheClearResult(true, memoryEntries, fileDeleted, 
                    "Cache cleared successfully");
                    
        } catch (Exception e) {
            log.error("Failed to clear cache", e);
            return new CacheClearResult(false, 0, false, 
                    "Error: " + e.getMessage());
        }
    }
    
    /**
     * Check if cache file exists.
     * @return true if cache file exists, false otherwise
     */
    public boolean cacheFileExists() {
        try {
            Path cachePath = getCacheFilePath();
            return Files.exists(cachePath) && Files.isRegularFile(cachePath);
        } catch (Exception e) {
            log.warn("Error checking if cache file exists", e);
            return false;
        }
    }
    
    /**
     * Get cache file path.
     */
    private Path getCacheFilePath() {
        return Paths.get(cacheDir, cacheFilename).toAbsolutePath().normalize();
    }
    
    /**
     * Check if cache entry is expired.
     */
    private boolean isExpired(ImageCompressionService.CacheEntry entry, long now) {
        try {
            java.lang.reflect.Field ttlField = ImageCompressionService.class.getDeclaredField("cacheTtlMillis");
            ttlField.setAccessible(true);
            long cacheTtlMillis = ttlField.getLong(imageCompressionService);
            
            if (cacheTtlMillis <= 0) {
                return false;
            }
            
            return (now - entry.getCreatedAt()) >= cacheTtlMillis;
        } catch (Exception e) {
            log.warn("Could not check expiration, assuming not expired", e);
            return false;
        }
    }
    
    /**
     * Create CompressionResult using reflection.
     */
    private ImageCompressionService.CompressionResult createCompressionResult(
            byte[] data, long originalSize, Map<String, String> exifMetadata) {
        try {
            java.lang.reflect.Constructor<?> constructor = 
                ImageCompressionService.CompressionResult.class.getDeclaredConstructor(
                    byte[].class, long.class, Map.class);
            constructor.setAccessible(true);
            return (ImageCompressionService.CompressionResult) constructor.newInstance(
                data, originalSize, exifMetadata);
        } catch (Exception e) {
            log.error("Failed to create CompressionResult", e);
            throw new RuntimeException("Failed to create CompressionResult", e);
        }
    }
    
    /**
     * Send email notification with cache save statistics.
     */
    public void sendCacheSaveEmail(CacheSaveResult result) {
        if (mailController == null) {
            log.debug("MailController not available, skipping email notification");
            return;
        }
        
        try {
            String timestamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"));
            String subject = "PatTool Cache Save Notification - " + timestamp;
            
            double sizeMB = result.getSavedSizeBytes() / (1024.0 * 1024.0);
            double fileSizeMB = result.getFileSizeBytes() / (1024.0 * 1024.0);
            
            String body = String.format(
                "<html><body style='font-family: Arial, sans-serif;'>" +
                "<h2 style='color: #2c3e50;'>Image Compression Cache Save Report</h2>" +
                "<p>Cache save operation completed at %s</p>" +
                "<table style='border-collapse: collapse; width: 100%%; max-width: 600px;'>" +
                "<tr style='background-color: #f2f2f2;'><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>Status:</td><td style='padding: 8px; border: 1px solid #ddd;'>%s</td></tr>" +
                "<tr><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>Entries Saved:</td><td style='padding: 8px; border: 1px solid #ddd;'>%d</td></tr>" +
                "<tr style='background-color: #f2f2f2;'><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>Cache Size:</td><td style='padding: 8px; border: 1px solid #ddd;'>%.2f MB</td></tr>" +
                "<tr><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>File Size:</td><td style='padding: 8px; border: 1px solid #ddd;'>%.2f MB</td></tr>" +
                "<tr style='background-color: #f2f2f2;'><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>Message:</td><td style='padding: 8px; border: 1px solid #ddd;'>%s</td></tr>" +
                "</table>" +
                "<p style='margin-top: 20px; color: #7f8c8d; font-size: 12px;'>This is an automated notification from the PatTool application.</p>" +
                "</body></html>",
                timestamp,
                result.isSuccess() ? "✅ Success" : "❌ Failed",
                result.getEntryCount(),
                sizeMB,
                fileSizeMB,
                result.getMessage()
            );
            
            mailController.sendMail(subject, body, true);
            log.info("Cache save notification email sent");
        } catch (Exception e) {
            log.error("Failed to send cache save notification email", e);
        }
    }
    
    // Result classes
    public static class CacheSaveResult {
        private final boolean success;
        private final int entryCount;
        private final long savedSizeBytes;
        private final long fileSizeBytes;
        private final String message;
        
        public CacheSaveResult(boolean success, int entryCount, long savedSizeBytes, 
                             long fileSizeBytes, String message) {
            this.success = success;
            this.entryCount = entryCount;
            this.savedSizeBytes = savedSizeBytes;
            this.fileSizeBytes = fileSizeBytes;
            this.message = message;
        }
        
        public boolean isSuccess() { return success; }
        public int getEntryCount() { return entryCount; }
        public long getSavedSizeBytes() { return savedSizeBytes; }
        public long getFileSizeBytes() { return fileSizeBytes; }
        public String getMessage() { return message; }
    }
    
    public static class CacheLoadResult {
        private final boolean success;
        private final int entryCount;
        private final long loadedSizeBytes;
        private final String message;
        
        public CacheLoadResult(boolean success, int entryCount, long loadedSizeBytes, String message) {
            this.success = success;
            this.entryCount = entryCount;
            this.loadedSizeBytes = loadedSizeBytes;
            this.message = message;
        }
        
        public boolean isSuccess() { return success; }
        public int getEntryCount() { return entryCount; }
        public long getLoadedSizeBytes() { return loadedSizeBytes; }
        public String getMessage() { return message; }
    }
    
    public static class CacheClearResult {
        private final boolean success;
        private final int memoryEntries;
        private final boolean fileDeleted;
        private final String message;
        
        public CacheClearResult(boolean success, int memoryEntries, boolean fileDeleted, String message) {
            this.success = success;
            this.memoryEntries = memoryEntries;
            this.fileDeleted = fileDeleted;
            this.message = message;
        }
        
        public boolean isSuccess() { return success; }
        public int getMemoryEntries() { return memoryEntries; }
        public boolean isFileDeleted() { return fileDeleted; }
        public String getMessage() { return message; }
    }
}

