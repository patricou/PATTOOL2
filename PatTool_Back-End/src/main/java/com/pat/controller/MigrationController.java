package com.pat.controller;

import com.pat.service.MigrationService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * Controller for handling data migrations
 * Created for PatTool application
 */
@RestController
@RequestMapping("/api/migration")
public class MigrationController {

    private static final Logger log = LoggerFactory.getLogger(MigrationController.class);

    @Autowired
    private MigrationService migrationService;

    /**
     * Execute migration from photosUrl field to urlEvents
     * POST /api/migration/migrate-photos-to-urlevents
     */
    @PostMapping(value = "/migrate-photos-to-urlevents", produces = "application/json")
    public ResponseEntity<String> migratePhotosToUrlEvents() {
        try {
            log.info("Received request to migrate photos to urlEvents");
            String result = migrationService.migratePhotosToUrlEvents();
            return ResponseEntity.ok()
                .header("Content-Type", "application/json")
                .body("\"" + result + "\"");
        } catch (Exception e) {
            log.error("Error during photos migration", e);
            return ResponseEntity.internalServerError()
                .header("Content-Type", "application/json")
                .body("\"Erreur lors de la migration des photos: " + e.getMessage() + "\"");
        }
    }

    /**
     * Execute migration from map field to urlEvents
     * POST /api/migration/migrate-map-to-urlevents
     */
    @PostMapping(value = "/migrate-map-to-urlevents", produces = "application/json")
    public ResponseEntity<String> migrateMapToUrlEvents() {
        try {
            log.info("Received request to migrate map to urlEvents");
            String result = migrationService.migrateMapToUrlEvents();
            return ResponseEntity.ok()
                .header("Content-Type", "application/json")
                .body("\"" + result + "\"");
        } catch (Exception e) {
            log.error("Error during map migration", e);
            return ResponseEntity.internalServerError()
                .header("Content-Type", "application/json")
                .body("\"Erreur lors de la migration des cartes: " + e.getMessage() + "\"");
        }
    }

    /**
     * Get migration status for photos
     * GET /api/migration/photos-migration-status
     */
    @GetMapping(value = "/photos-migration-status", produces = "application/json")
    public ResponseEntity<String> getPhotosMigrationStatus() {
        try {
            log.info("Received request for photos migration status");
            String status = migrationService.getPhotosMigrationStatus();
            return ResponseEntity.ok()
                .header("Content-Type", "application/json")
                .body("\"" + status.replace("\n", "\\n") + "\"");
        } catch (Exception e) {
            log.error("Error getting photos migration status", e);
            return ResponseEntity.internalServerError()
                .header("Content-Type", "application/json")
                .body("\"Erreur lors de la récupération du statut des photos: " + e.getMessage() + "\"");
        }
    }

    /**
     * Get migration status for maps
     * GET /api/migration/migration-status
     */
    @GetMapping(value = "/migration-status", produces = "application/json")
    public ResponseEntity<String> getMapMigrationStatus() {
        try {
            log.info("Received request for map migration status");
            String status = migrationService.getMapMigrationStatus();
            return ResponseEntity.ok()
                .header("Content-Type", "application/json")
                .body("\"" + status.replace("\n", "\\n") + "\"");
        } catch (Exception e) {
            log.error("Error getting map migration status", e);
            return ResponseEntity.internalServerError()
                .header("Content-Type", "application/json")
                .body("\"Erreur lors de la récupération du statut des cartes: " + e.getMessage() + "\"");
        }
    }
}
