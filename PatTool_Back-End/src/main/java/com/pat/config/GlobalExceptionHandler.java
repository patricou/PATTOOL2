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

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<String> handleMaxSizeException(MaxUploadSizeExceededException exc) {
        log.error("File upload size exceeded: {}", exc.getMessage());
        
        String errorMessage = "File size exceeds the maximum allowed limit. " +
                             "Maximum file size: 100MB, Maximum request size: 350MB. " +
                             "Please reduce the file size and try again.";
        
        return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE)
                .body(errorMessage);
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<String> handleNoResourceFoundException(NoResourceFoundException exc) {
        String resourcePath = exc.getResourcePath();
        
        // Check if this is a common bot/scanner request - don't log as error
        boolean shouldIgnore = IGNORED_PATTERNS.stream()
            .anyMatch(pattern -> resourcePath != null && resourcePath.contains(pattern));
        
        if (shouldIgnore) {
            // Log at debug level instead of error for scanner/bot requests
            log.debug("Ignored scanner/bot request: {}", resourcePath);
        } else {
            log.warn("Static resource not found: {}", resourcePath);
        }
        
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body("Resource not found");
    }

    /**
     * Handle AsyncRequestNotUsableException - occurs when client closes connection
     * during async request processing (e.g., closing photo slideshow)
     */
    @ExceptionHandler(AsyncRequestNotUsableException.class)
    public ResponseEntity<Void> handleAsyncRequestNotUsableException(AsyncRequestNotUsableException exc) {
        // This is a normal situation when client closes connection (e.g., closing modal/slideshow)
        // Log at debug level to avoid noise in production logs
        String message = exc.getMessage();
        if (message != null && (message.contains("Connection reset") || 
                                 message.contains("failed to write") ||
                                 message.contains("Connection closed"))) {
            log.debug("Client closed connection during async request (likely normal): {}", message);
        } else {
            log.debug("AsyncRequestNotUsableException: {}", message);
        }
        
        // Return void response - connection is already closed
        return null;
    }
    
    /**
     * Handle IOException related to connection reset - occurs when client closes connection
     * during file streaming
     */
    @ExceptionHandler(IOException.class)
    public ResponseEntity<Void> handleIOException(IOException exc) {
        String message = exc.getMessage();
        
        // Check if this is a connection reset (client closed connection)
        if (message != null && (message.contains("Connection reset by peer") ||
                                 message.contains("Broken pipe") ||
                                 message.contains("Connection closed"))) {
            // This is normal when client closes connection (e.g., closing photo slideshow)
            // Log at debug level to avoid noise in production logs
            log.debug("Client closed connection during file transfer (likely normal): {}", message);
            return null; // Connection already closed, return void
        }
        
        // For other IOExceptions, log as error and handle normally
        log.error("IO Exception occurred: {}", message, exc);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<String> handleGenericException(Exception exc) {
        // Check if this exception is related to missing static resources from scanners
        String message = exc.getMessage();
        if (message != null && message.contains("No static resource")) {
            boolean shouldIgnore = IGNORED_PATTERNS.stream()
                .anyMatch(pattern -> message.contains(pattern));
            
            if (shouldIgnore) {
                log.debug("Ignored scanner/bot static resource request: {}", message);
                return ResponseEntity.status(HttpStatus.NOT_FOUND).body("Not found");
            }
        }
        
        // Check if this is a connection reset wrapped in another exception
        if (message != null && (message.contains("Connection reset") ||
                                 message.contains("Broken pipe") ||
                                 message.contains("AsyncRequestNotUsableException"))) {
            log.debug("Client closed connection (likely normal): {}", message);
            return null; // Connection already closed
        }
        
        log.error("Unexpected error occurred: {}", exc.getMessage(), exc);
        
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body("An unexpected error occurred. Please try again later.");
    }
}
