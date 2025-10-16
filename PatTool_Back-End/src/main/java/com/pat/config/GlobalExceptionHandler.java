package com.pat.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.multipart.MaxUploadSizeExceededException;

/**
 * Global exception handler for the application
 * Note: Not extending ResponseEntityExceptionHandler to avoid conflicts
 */
@ControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<String> handleMaxSizeException(MaxUploadSizeExceededException exc) {
        log.error("File upload size exceeded: {}", exc.getMessage());
        
        String errorMessage = "File size exceeds the maximum allowed limit. " +
                             "Maximum file size: 100MB, Maximum request size: 350MB. " +
                             "Please reduce the file size and try again.";
        
        return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE)
                .body(errorMessage);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<String> handleGenericException(Exception exc) {
        log.error("Unexpected error occurred: {}", exc.getMessage(), exc);
        
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body("An unexpected error occurred. Please try again later.");
    }
}
