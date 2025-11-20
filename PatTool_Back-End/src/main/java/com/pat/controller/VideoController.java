package com.pat.controller;

import com.pat.service.VideoService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.InputStreamResource;
import org.springframework.data.mongodb.gridfs.GridFsResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.io.ByteArrayInputStream;
import java.util.Map;

/**
 * REST Controller for video operations
 */
@RestController
@RequestMapping("/api/video")
public class VideoController {

    private static final Logger log = LoggerFactory.getLogger(VideoController.class);

    @Autowired
    private VideoService videoService;
    
    // Compression service disabled - requires FFmpeg
    // @Autowired(required = false)
    // private VideoCompressionService videoCompressionService;

    /**
     * Get video file by ID
     * Supports HTTP Range requests for video streaming
     * Supports quality parameter: auto, high, medium, low
     */
    @RequestMapping(value = "/{fileId}", method = RequestMethod.GET)
    public ResponseEntity<InputStreamResource> getVideo(
            @PathVariable String fileId,
            @RequestParam(value = "quality", required = false, defaultValue = "low") String quality,
            @RequestHeader(value = "Range", required = false) String rangeHeader) {
        
        log.debug("Attempting to retrieve video with ID: " + fileId + ", quality: " + quality);

        try {
            com.pat.service.VideoService.VideoQuality videoQuality = com.pat.service.VideoService.VideoQuality.fromString(quality);
            GridFsResource videoResource = videoService.getVideoResource(fileId, videoQuality);
            
            if (videoResource == null) {
                log.debug("Video not found: " + fileId);
                return ResponseEntity.notFound().build();
            }
            
            // Build headers
            HttpHeaders headers = videoService.buildVideoHeaders(videoResource);
            headers.set("X-Video-Quality", videoQuality.getValue());
            
            // Compression disabled - requires FFmpeg installation
            // The system will look for pre-compressed versions (e.g., video_low.mp4)
            // If not found, it serves the original with optimized streaming (Range requests)
            
            // Handle Range requests for video streaming
            if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
                return handleRangeRequest(videoResource, rangeHeader, headers);
            }
            
            // Return full video (original or pre-compressed)
            return ResponseEntity.ok()
                    .headers(headers)
                    .body(new InputStreamResource(videoResource.getInputStream()));
                    
        } catch (Exception e) {
            log.error("Error retrieving video: " + fileId, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(new InputStreamResource(new ByteArrayInputStream(
                            ("Error: " + e.getMessage()).getBytes())));
        }
    }

    /**
     * Get video metadata
     * Returns metadata for all available qualities
     */
    @RequestMapping(value = "/{fileId}/metadata", method = RequestMethod.GET)
    public ResponseEntity<Map<String, Object>> getVideoMetadata(@PathVariable String fileId) {
        
        log.debug("Getting metadata for video: " + fileId);
        
        try {
            Map<String, Object> metadata = videoService.getVideoMetadata(fileId);
            
            if (metadata.isEmpty()) {
                return ResponseEntity.notFound().build();
            }
            
            // Add available qualities information
            // For now, we assume all qualities are available (can be enhanced later)
            java.util.List<String> availableQualities = new java.util.ArrayList<>();
            availableQualities.add("auto");
            availableQualities.add("high");
            // Check if medium and low versions exist (would need to query GridFS)
            // For now, we'll add them as potentially available
            availableQualities.add("medium");
            availableQualities.add("low");
            
            metadata.put("availableQualities", availableQualities);
            metadata.put("currentQuality", "high"); // Default to high
            
            return ResponseEntity.ok(metadata);
            
        } catch (Exception e) {
            log.error("Error getting video metadata: " + fileId, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Check if a file is a video
     */
    @RequestMapping(value = "/check/{filename}", method = RequestMethod.GET)
    public ResponseEntity<Map<String, Boolean>> checkIfVideo(@PathVariable String filename) {
        
        boolean isVideo = videoService.isVideoFile(filename);
        
        Map<String, Boolean> response = new java.util.HashMap<>();
        response.put("isVideo", isVideo);
        
        return ResponseEntity.ok(response);
    }

    /**
     * Handle HTTP Range requests for video streaming
     */
    private ResponseEntity<InputStreamResource> handleRangeRequest(
            GridFsResource resource, 
            String rangeHeader, 
            HttpHeaders headers) {
        
        try {
            long fileSize = resource.contentLength();
            long rangeStart = 0;
            long rangeEnd = fileSize - 1;
            
            // Parse range header (e.g., "bytes=0-1023" or "bytes=1024-")
            String range = rangeHeader.substring(6);
            String[] ranges = range.split("-");
            
            if (ranges.length > 0 && !ranges[0].isEmpty()) {
                rangeStart = Long.parseLong(ranges[0]);
            }
            if (ranges.length > 1 && !ranges[1].isEmpty()) {
                rangeEnd = Long.parseLong(ranges[1]);
            }
            
            // Validate range
            if (rangeStart > rangeEnd || rangeStart < 0 || rangeEnd >= fileSize) {
                return ResponseEntity.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE).build();
            }
            
            long contentLength = rangeEnd - rangeStart + 1;
            
            // Update headers for partial content
            headers.set("Content-Range", 
                    String.format("bytes %d-%d/%d", rangeStart, rangeEnd, fileSize));
            headers.set("Content-Length", Long.toString(contentLength));
            headers.set("Accept-Ranges", "bytes");
            
            // Get input stream and skip to start position
            java.io.InputStream inputStream = resource.getInputStream();
            long skipped = inputStream.skip(rangeStart);
            if (skipped < rangeStart) {
                // If skip didn't work as expected, fallback to full content
                return ResponseEntity.ok()
                        .headers(headers)
                        .body(new InputStreamResource(resource.getInputStream()));
            }
            
            // Create a limited input stream that reads only the requested range
            java.io.InputStream limitedStream = new java.io.InputStream() {
                private long remaining = contentLength;
                private final java.io.InputStream baseStream = inputStream;
                
                @Override
                public int read() throws java.io.IOException {
                    if (remaining <= 0) {
                        return -1;
                    }
                    int result = baseStream.read();
                    if (result >= 0) {
                        remaining--;
                    }
                    return result;
                }
                
                @Override
                public int read(byte[] b, int off, int len) throws java.io.IOException {
                    if (remaining <= 0) {
                        return -1;
                    }
                    int toRead = (int) Math.min(len, remaining);
                    int read = baseStream.read(b, off, toRead);
                    if (read > 0) {
                        remaining -= read;
                    }
                    return read;
                }
                
                @Override
                public void close() throws java.io.IOException {
                    baseStream.close();
                }
            };
            
            return ResponseEntity.status(HttpStatus.PARTIAL_CONTENT)
                    .headers(headers)
                    .body(new InputStreamResource(limitedStream));
                    
        } catch (Exception e) {
            log.error("Error handling range request", e);
            // Fallback to full content
            try {
                return ResponseEntity.ok()
                        .headers(headers)
                        .body(new InputStreamResource(resource.getInputStream()));
            } catch (Exception ex) {
                log.error("Error in fallback", ex);
                return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
            }
        }
    }
}

