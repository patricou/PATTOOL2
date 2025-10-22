package com.pat.service;

import com.pat.repo.EvenementsRepository;
import com.pat.repo.domain.Evenement;
import com.pat.repo.domain.UrlEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.Date;
import java.util.List;

/**
 * Service for handling data migrations
 * Created for PatTool application
 */
@Service
public class MigrationService {

    private static final Logger log = LoggerFactory.getLogger(MigrationService.class);

    @Autowired
    private EvenementsRepository evenementsRepository;

    /**
     * Migrate photosUrl field to urlEvents for all events
     * @return Migration result message
     */
    public String migratePhotosToUrlEvents() {
        log.info("Starting migration of photosUrl to urlEvents");
        
        List<Evenement> events = evenementsRepository.findAll();
        int migratedCount = 0;
        
        for (Evenement event : events) {
            if (event.getPhotosUrl() != null && !event.getPhotosUrl().isEmpty()) {
                // Initialize urlEvents list if null
                if (event.getUrlEvents() == null) {
                    event.setUrlEvents(new java.util.ArrayList<>());
                }
                
                // Create UrlEvent for each photo URL
                for (String photoUrl : event.getPhotosUrl()) {
                    if (photoUrl != null && !photoUrl.trim().isEmpty()) {
                        UrlEvent photoUrlEvent = new UrlEvent(
                            "Photos",                       // typeUrl
                            new Date(),                     // dateCreation
                            "Patricou",                     // owner
                            photoUrl.trim(),                // link
                            "Photos"                        // urlDescription
                        );
                        event.getUrlEvents().add(photoUrlEvent);
                    }
                }
                
                // Clear the photosUrl field
                event.setPhotosUrl(new java.util.ArrayList<>());
                
                // Save the updated event
                evenementsRepository.save(event);
                migratedCount++;
                
                log.info("Migrated photos for event: {} - {} photos migrated", 
                    event.getEvenementName(), event.getUrlEvents().size());
            }
        }
        
        String result = String.format("Migration des photos terminée avec succès. %d événements migrés.", migratedCount);
        log.info(result);
        return result;
    }

    /**
     * Migrate map field to urlEvents for all events
     * @return Migration result message
     */
    public String migrateMapToUrlEvents() {
        log.info("Starting migration of map to urlEvents");
        
        List<Evenement> events = evenementsRepository.findAll();
        int migratedCount = 0;
        
        for (Evenement event : events) {
            if (event.getMap() != null && !event.getMap().trim().isEmpty()) {
                // Initialize urlEvents list if null
                if (event.getUrlEvents() == null) {
                    event.setUrlEvents(new java.util.ArrayList<>());
                }
                
                // Create UrlEvent from map data
                UrlEvent mapUrlEvent = new UrlEvent(
                    "MAP",                           // typeUrl
                    new Date(),                      // dateCreation
                    "Patricou",                      // owner
                    event.getMap().trim(),           // link
                    "Carte"                         // urlDescription
                );
                
                // Add the UrlEvent to the list
                event.getUrlEvents().add(mapUrlEvent);
                
                // Clear the map field
                event.setMap("");
                
                // Save the updated event
                evenementsRepository.save(event);
                migratedCount++;
                
                log.info("Migrated map for event: {} - map URL: {}", 
                    event.getEvenementName(), mapUrlEvent.getLink());
            }
        }
        
        String result = String.format("Migration des cartes terminée avec succès. %d événements migrés.", migratedCount);
        log.info(result);
        return result;
    }

    /**
     * Get migration status for photos
     * @return Status message
     */
    public String getPhotosMigrationStatus() {
        List<Evenement> events = evenementsRepository.findAll();
        int totalEvents = events.size();
        int eventsWithPhotos = 0;
        int eventsWithUrlEvents = 0;
        
        for (Evenement event : events) {
            if (event.getPhotosUrl() != null && !event.getPhotosUrl().isEmpty()) {
                eventsWithPhotos++;
            }
            if (event.getUrlEvents() != null && !event.getUrlEvents().isEmpty()) {
                eventsWithUrlEvents++;
            }
        }
        
        return String.format(
            "Statut de la migration des photos:\n" +
            "Total événements: %d\n" +
            "Événements avec photosUrl: %d\n" +
            "Événements avec urlEvents: %d\n" +
            "Événements prêts pour migration des photos: %d",
            totalEvents, eventsWithPhotos, eventsWithUrlEvents, eventsWithPhotos
        );
    }

    /**
     * Get migration status for maps
     * @return Status message
     */
    public String getMapMigrationStatus() {
        List<Evenement> events = evenementsRepository.findAll();
        int totalEvents = events.size();
        int eventsWithMap = 0;
        int eventsWithUrlEvents = 0;
        
        for (Evenement event : events) {
            if (event.getMap() != null && !event.getMap().trim().isEmpty()) {
                eventsWithMap++;
            }
            if (event.getUrlEvents() != null && !event.getUrlEvents().isEmpty()) {
                eventsWithUrlEvents++;
            }
        }
        
        return String.format(
            "Statut de la migration des cartes:\n" +
            "Total événements: %d\n" +
            "Événements avec champ map: %d\n" +
            "Événements avec urlEvents: %d\n" +
            "Événements prêts pour migration: %d",
            totalEvents, eventsWithMap, eventsWithUrlEvents, eventsWithMap
        );
    }
}
