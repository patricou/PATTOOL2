package com.pat.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.Arrays;
import java.util.List;

/**
 * Global exception handler for the application
 * Note: Not extending ResponseEntityExceptionHandler to avoid conflicts
 */
@ControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);
    
    // Common paths that bots/scanners probe - don't log errors for these
    private static final List<String> IGNORED_PATTERNS = Arrays.asList(
        ".git/",
        ".well-known/",
        ".php",
        "xmlrpc.php",
        "wp-admin/",
        "wp-login.php",
        "administrator/",
        "phpmyadmin/"
    );

    /**
     * Extract client IP address from request, handling proxy headers
     * @param request HttpServletRequest
     * @return Client IP address
     */
    private String getClientIpAddress(HttpServletRequest request) {
        if (request == null) {
            return "unknown";
        }
        
        // Check X-Forwarded-For header (first IP in chain is the original client)
        String xForwardedFor = request.getHeader("X-Forwarded-For");
        if (xForwardedFor != null && !xForwardedFor.isEmpty()) {
            // X-Forwarded-For can contain multiple IPs, take the first one
            String[] ips = xForwardedFor.split(",");
            if (ips.length > 0) {
                return ips[0].trim();
            }
        }
        
        // Check X-Real-IP header (commonly used by nginx)
        String xRealIp = request.getHeader("X-Real-IP");
        if (xRealIp != null && !xRealIp.isEmpty()) {
            return xRealIp.trim();
        }
        
        // Fall back to remote address
        return request.getRemoteAddr();
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<String> handleMaxSizeException(MaxUploadSizeExceededException exc, HttpServletRequest request) {
        String clientIp = getClientIpAddress(request);
        log.error("File upload size exceeded from IP [{}]: {}", clientIp, exc.getMessage());
        
        String errorMessage = "File size exceeds the maximum allowed limit. " +
                             "Maximum file size: 100MB, Maximum request size: 350MB. " +
                             "Please reduce the file size and try again.";
        
        return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE)
                .body(errorMessage);
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<String> handleNoResourceFoundException(NoResourceFoundException exc, HttpServletRequest request) {
        String resourcePath = exc.getResourcePath();
        String clientIp = getClientIpAddress(request);
        
        // Check if this is a common bot/scanner request - don't log as error
        boolean shouldIgnore = IGNORED_PATTERNS.stream()
            .anyMatch(pattern -> resourcePath != null && resourcePath.contains(pattern));
        
        if (shouldIgnore) {
            // Log at info level for scanner/bot requests
            log.info("Ignored scanner/bot request from IP [{}]: {}", clientIp, resourcePath);
        } else {
            log.warn("Static resource not found from IP [{}]: {}", clientIp, resourcePath);
        }
        
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body("Resource not found");
    }

    /**
     * Handle AsyncRequestNotUsableException - occurs when client closes connection
     * during async request processing (e.g., closing photo slideshow)
     */
    @ExceptionHandler(AsyncRequestNotUsableException.class)
    public ResponseEntity<Void> handleAsyncRequestNotUsableException(AsyncRequestNotUsableException exc, HttpServletRequest request) {
        // This is a normal situation when client closes connection (e.g., closing modal/slideshow)
        String clientIp = getClientIpAddress(request);
        String message = exc.getMessage();
        if (message != null && (message.contains("Connection reset") || 
                                 message.contains("failed to write") ||
                                 message.contains("Connection closed"))) {
            log.info("Client closed connection during async request (likely normal) from IP [{}]: {}", clientIp, message);
        } else {
            log.info("AsyncRequestNotUsableException from IP [{}]: {}", clientIp, message);
        }
        
        // Return void response - connection is already closed
        return null;
    }
    
    /**
     * Handle IOException related to connection reset - occurs when client closes connection
     * during file streaming
     */
    @ExceptionHandler(IOException.class)
    public ResponseEntity<Void> handleIOException(IOException exc, HttpServletRequest request) {
        String clientIp = getClientIpAddress(request);
        String message = exc.getMessage();
        
        // Check if this is a connection reset (client closed connection)
        if (message != null && (message.contains("Connection reset by peer") ||
                                 message.contains("Broken pipe") ||
                                 message.contains("Connection closed"))) {
            // This is normal when client closes connection (e.g., closing photo slideshow)
            log.info("Client closed connection during file transfer (likely normal) from IP [{}]: {}", clientIp, message);
            return null; // Connection already closed, return void
        }
        
        // For other IOExceptions, log as error and handle normally
        log.error("IO Exception occurred from IP [{}]: {}", clientIp, message, exc);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<String> handleGenericException(Exception exc, HttpServletRequest request) {
        String clientIp = getClientIpAddress(request);
        // Check if this exception is related to missing static resources from scanners
        String message = exc.getMessage();
        if (message != null && message.contains("No static resource")) {
            boolean shouldIgnore = IGNORED_PATTERNS.stream()
                .anyMatch(pattern -> message.contains(pattern));
            
            if (shouldIgnore) {
                log.info("Ignored scanner/bot static resource request from IP [{}]: {}", clientIp, message);
                return ResponseEntity.status(HttpStatus.NOT_FOUND).body("Not found");
            }
        }
        
        // Check if this is a connection reset wrapped in another exception
        if (message != null && (message.contains("Connection reset") ||
                                 message.contains("Broken pipe") ||
                                 message.contains("AsyncRequestNotUsableException"))) {
            log.info("Client closed connection (likely normal) from IP [{}]: {}", clientIp, message);
            return null; // Connection already closed
        }
        
        log.error("Unexpected error occurred from IP [{}]: {}", clientIp, exc.getMessage(), exc);
        
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body("An unexpected error occurred. Please try again later.");
    }
}
