package com.pat.service;

import com.mongodb.client.gridfs.model.GridFSFile;
import org.bson.types.ObjectId;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.gridfs.GridFsResource;
import org.springframework.data.mongodb.gridfs.GridFsTemplate;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Service for handling video operations
 */
@Service
public class VideoService {

    private static final Logger log = LoggerFactory.getLogger(VideoService.class);

    @Autowired
    private GridFsTemplate gridFsTemplate;
    
    // Compression service disabled - requires FFmpeg
    // @Autowired(required = false)
    // private VideoCompressionService videoCompressionService;

    /**
     * Check if a file is a video based on its filename
     */
    public boolean isVideoFile(String filename) {
        if (filename == null || filename.isEmpty()) {
            return false;
        }
        
        String extension = filename.toLowerCase();
        return extension.endsWith(".mp4") ||
               extension.endsWith(".webm") ||
               extension.endsWith(".ogg") ||
               extension.endsWith(".ogv") ||
               extension.endsWith(".mov") ||
               extension.endsWith(".avi") ||
               extension.endsWith(".mkv") ||
               extension.endsWith(".flv") ||
               extension.endsWith(".wmv") ||
               extension.endsWith(".m4v") ||
               extension.endsWith(".3gp");
    }

    /**
     * Get video content type from filename
     */
    public String getVideoContentType(String filename) {
        if (filename == null || filename.isEmpty()) {
            return "video/mp4"; // Default
        }
        
        String extension = filename.toLowerCase();
        if (extension.endsWith(".mp4")) {
            return "video/mp4";
        } else if (extension.endsWith(".webm")) {
            return "video/webm";
        } else if (extension.endsWith(".ogg") || extension.endsWith(".ogv")) {
            return "video/ogg";
        } else if (extension.endsWith(".mov")) {
            return "video/quicktime";
        } else if (extension.endsWith(".avi")) {
            return "video/x-msvideo";
        } else if (extension.endsWith(".mkv")) {
            return "video/x-matroska";
        } else if (extension.endsWith(".flv")) {
            return "video/x-flv";
        } else if (extension.endsWith(".wmv")) {
            return "video/x-ms-wmv";
        } else if (extension.endsWith(".m4v")) {
            return "video/x-m4v";
        } else if (extension.endsWith(".3gp")) {
            return "video/3gpp";
        }
        
        return "video/mp4"; // Default
    }

    /**
     * Video quality levels
     */
    public enum VideoQuality {
        AUTO("auto"),      // Let browser decide
        HIGH("high"),      // Original/high quality
        MEDIUM("medium"),  // Medium quality (compressed)
        LOW("low");        // Low quality (highly compressed)
        
        private final String value;
        
        VideoQuality(String value) {
            this.value = value;
        }
        
        public String getValue() {
            return value;
        }
        
        public static VideoQuality fromString(String value) {
            if (value == null) return AUTO;
            for (VideoQuality quality : VideoQuality.values()) {
                if (quality.value.equalsIgnoreCase(value)) {
                    return quality;
                }
            }
            return AUTO;
        }
    }

    /**
     * Get video file from GridFS by ID with optional quality parameter
     */
    public GridFsResource getVideoResource(String fileId) {
        return getVideoResource(fileId, VideoQuality.AUTO);
    }

    /**
     * Get video file from GridFS by ID with quality selection
     * Quality selection works by looking for files with quality suffix in metadata or filename
     * Format: original_file_high.mp4, original_file_medium.mp4, original_file_low.mp4
     */
    public GridFsResource getVideoResource(String fileId, VideoQuality quality) {
        try {
            // Check if GridFsTemplate is available
            if (gridFsTemplate == null) {
                log.debug("GridFsTemplate is null - MongoDB GridFS not properly configured");
                return null;
            }

            // Convert string ID to ObjectId for validation
            ObjectId objectId;
            try {
                objectId = new ObjectId(fileId);
            } catch (IllegalArgumentException e) {
                log.debug("Invalid ObjectId format: " + fileId, e);
                return null;
            }
            
            // First, get the original file to check its metadata and filename
            GridFSFile originalFile = gridFsTemplate.findOne(new Query(Criteria.where("_id").is(objectId)));
            
            if (originalFile == null) {
                log.debug("Video file not found: " + fileId);
                return null;
            }
            
            // If AUTO or HIGH, return original file
            if (quality == VideoQuality.AUTO || quality == VideoQuality.HIGH) {
                return gridFsTemplate.getResource(originalFile);
            }
            
            // For MEDIUM and LOW, try to find a compressed version
            // Strategy: Look for files with quality suffix in metadata or related files
            String originalFilename = originalFile.getFilename();
            if (originalFilename == null) {
                // No filename, return original
                return gridFsTemplate.getResource(originalFile);
            }
            
            // Try to find a compressed version by looking for files with quality suffix
            // This assumes files are stored with naming convention: filename_quality.ext
            String qualitySuffix = "_" + quality.getValue();
            String baseFilename = originalFilename;
            
            // Remove existing quality suffix if present
            if (baseFilename.contains("_high") || baseFilename.contains("_medium") || baseFilename.contains("_low")) {
                baseFilename = baseFilename.replaceAll("_(high|medium|low)(\\.)", "$2");
            }
            
            // Try to find compressed version
            String compressedFilename = baseFilename.replaceFirst("(\\.)", qualitySuffix + "$1");
            
            // Look for compressed version by filename
            GridFSFile compressedFile = gridFsTemplate.findOne(
                new Query(Criteria.where("filename").is(compressedFilename))
            );
            
            if (compressedFile != null) {
                log.debug("Found compressed video version: " + compressedFilename + " for quality: " + quality);
                return gridFsTemplate.getResource(compressedFile);
            }
            
            // Compression disabled - requires FFmpeg installation
            // If you need compression, install FFmpeg and enable VideoCompressionService
            // For now, we rely on pre-compressed versions or serve original
            
            // If compressed version not found, return original
            log.debug("Compressed version not found for quality: " + quality + ", returning original");
            return gridFsTemplate.getResource(originalFile);
            
        } catch (Exception e) {
            log.error("Error retrieving video file: " + fileId + " with quality: " + quality, e);
            return null;
        }
    }

    /**
     * Get video metadata
     */
    public Map<String, Object> getVideoMetadata(String fileId) {
        Map<String, Object> metadata = new HashMap<>();
        
        GridFsResource resource = getVideoResource(fileId);
        if (resource == null) {
            return metadata;
        }
        
        try {
            GridFSFile gridFsFile = resource.getGridFSFile();
            if (gridFsFile != null) {
                metadata.put("fileId", fileId);
                metadata.put("filename", resource.getFilename());
                metadata.put("contentType", getContentType(resource));
                metadata.put("length", gridFsFile.getLength());
                metadata.put("uploadDate", gridFsFile.getUploadDate());
                
                // Add size in KB
                long length = gridFsFile.getLength();
                if (length > 0) {
                    metadata.put("sizeKB", Math.max(1, length / 1024));
                    metadata.put("sizeBytes", length);
                }
            }
        } catch (Exception e) {
            log.error("Error getting video metadata: " + fileId, e);
        }
        
        return metadata;
    }

    /**
     * Get content type from resource with fallback
     */
    private String getContentType(GridFsResource resource) {
        try {
            String contentType = resource.getContentType();
            if (contentType != null && !contentType.isEmpty()) {
                return contentType;
            }
        } catch (Exception e) {
            // Ignore
        }
        
        // Fallback to filename-based detection
        String filename = resource.getFilename();
        if (filename != null) {
            return getVideoContentType(filename);
        }
        
        return "video/mp4"; // Default
    }
    
    /**
     * Build Content-Disposition header value with proper RFC 5987 encoding for Unicode filenames
     * @param disposition "inline" or "attachment"
     * @param filename The filename (may contain Unicode characters)
     * @return Properly encoded Content-Disposition header value
     */
    private String buildContentDispositionHeader(String disposition, String filename) {
        if (filename == null || filename.isEmpty()) {
            return disposition;
        }
        
        // Create ASCII-safe fallback filename (replace non-ASCII with underscore)
        String asciiFilename = filename.replaceAll("[^\\x20-\\x7E]", "_");
        // Ensure the fallback is properly quoted
        String quotedAscii = "\"" + asciiFilename.replace("\"", "\\\"") + "\"";
        
        // Encode filename for filename* parameter (RFC 5987)
        try {
            String encodedFilename = URLEncoder.encode(filename, StandardCharsets.UTF_8.toString())
                .replace("+", "%20"); // URLEncoder uses + for spaces, but RFC 5987 uses %20
            
            // Build the header value with both filename (ASCII fallback) and filename* (UTF-8)
            return disposition + "; filename=" + quotedAscii + "; filename*=UTF-8''" + encodedFilename;
        } catch (Exception e) {
            log.warn("Error encoding filename for Content-Disposition header: " + filename, e);
            // Fallback to ASCII version only if encoding fails
            return disposition + "; filename=" + quotedAscii;
        }
    }

    /**
     * Build HTTP headers for video response
     */
    public HttpHeaders buildVideoHeaders(GridFsResource resource) {
        HttpHeaders headers = new HttpHeaders();
        
        try {
            String contentType = getContentType(resource);
            headers.setContentType(MediaType.parseMediaType(contentType));
            
            String filename = resource.getFilename();
            if (filename == null || filename.isEmpty()) {
                filename = "video.mp4";
            }
            
            // Build properly encoded Content-Disposition header (RFC 5987 compliant)
            headers.set("Content-Disposition", buildContentDispositionHeader("inline", filename));
            
            // Add content length if available
            try {
                long contentLength = resource.contentLength();
                if (contentLength > 0) {
                    headers.set("Content-Length", Long.toString(contentLength));
                    // Add custom headers for frontend
                    headers.set("X-Pat-Video-Size-Bytes", Long.toString(contentLength));
                    headers.set("X-Pat-Video-Size-KB", Long.toString(Math.max(1, contentLength / 1024)));
                }
            } catch (Exception e) {
                log.debug("Could not determine content length", e);
            }
            
            // Add range support for video streaming
            headers.set("Accept-Ranges", "bytes");
            
        } catch (Exception e) {
            log.error("Error building video headers", e);
        }
        
        return headers;
    }
    
    // Compression storage methods disabled - requires FFmpeg
    // If you need compression, install FFmpeg and enable VideoCompressionService
}

