package com.pat.controller;

import com.pat.service.ExceptionReportScheduler;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
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
            log.debug("Manual exception report trigger requested");
            boolean emailSent = exceptionReportScheduler.sendExceptionReportNow();
            
            if (emailSent) {
                return ResponseEntity.ok("Exception report sent successfully");
            } else {
                return ResponseEntity.ok("No exceptions or connections to report in the last 24 hours. Email not sent.");
            }
        } catch (Exception e) {
            log.error("Error sending exception report: {}", e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body("Error sending exception report: " + e.getMessage());
        }
    }

    @GetMapping(value = "/exception-report/preview", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> previewExceptionReport() {
        try {
            log.debug("Preview exception report requested");
            return exceptionReportScheduler.buildExceptionReportPreview()
                    .map(ResponseEntity::ok)
                    .orElseGet(() -> ResponseEntity.ok("<div style='font-family: Arial, sans-serif; padding: 16px; background: #f8f9fa; border: 1px solid #ced4da; border-radius: 6px;'>"
                            + "<strong>Aucune donnée disponible pour les 7 derniers jours.</strong></div>"));
        } catch (Exception e) {
            log.error("Error building exception report preview: {}", e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body("<div style='font-family: Arial, sans-serif; padding: 16px; background: #f8d7da; border: 1px solid #f5c2c7; border-radius: 6px; color: #842029;'>"
                            + "<strong>Erreur lors de la génération du rapport :</strong> " + e.getMessage() + "</div>");
        }
    }
}
