package com.pat.controller;

import com.pat.service.ExceptionReportScheduler;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * REST controller for manually triggering exception reports
 */
@RestController
@RequestMapping("/api")
public class ExceptionReportController {

    private static final Logger log = LoggerFactory.getLogger(ExceptionReportController.class);

    @Autowired
    private ExceptionReportScheduler exceptionReportScheduler;

    @PostMapping("/exception-report/send")
    public ResponseEntity<String> sendExceptionReport() {
        try {
            log.info("Manual exception report trigger requested");
            exceptionReportScheduler.sendExceptionReportNow();
            return ResponseEntity.ok("Exception report sent successfully");
        } catch (Exception e) {
            log.error("Error sending exception report: {}", e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body("Error sending exception report: " + e.getMessage());
        }
    }
}
