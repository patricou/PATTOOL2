package com.pat.controller;

import com.pat.repo.domain.Evenement;
import com.pat.repo.EvenementsRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/migration")
@CrossOrigin(origins = "*")
public class MigrationController {

    @Autowired
    private EvenementsRepository evenementsRepository;
    
    @Autowired
    private MongoTemplate mongoTemplate;

    @PostMapping("/photosUrl")
    public String migratePhotosUrl() {
        try {
            // Utiliser MongoTemplate pour accéder directement aux données brutes
            List<org.bson.Document> allEvenements = mongoTemplate.getCollection("evenements").find().into(new java.util.ArrayList<>());
            int migratedCount = 0;
            
            for (org.bson.Document doc : allEvenements) {
                Object photosUrlField = doc.get("photosUrl");
                
                // Vérifier si photosUrl est une string (ancien format)
                if (photosUrlField instanceof String) {
                    String photosUrlString = (String) photosUrlField;
                    if (!photosUrlString.trim().isEmpty()) {
                        // Diviser par les virgules et nettoyer
                        String[] urls = photosUrlString.split(",");
                        java.util.List<String> photosUrlList = new java.util.ArrayList<>();
                        
                        for (String url : urls) {
                            String cleanUrl = url.trim();
                            if (!cleanUrl.isEmpty()) {
                                photosUrlList.add(cleanUrl);
                            }
                        }
                        
                        // Mettre à jour le document dans MongoDB
                        Query query = new Query(Criteria.where("_id").is(doc.get("_id")));
                        Update update = new Update().set("photosUrl", photosUrlList);
                        mongoTemplate.updateFirst(query, update, "evenements");
                        
                        migratedCount++;
                        System.out.println("Migrated event: " + doc.get("evenementName") + " - Photos: " + photosUrlList);
                    }
                }
            }
            
            return "Migration completed successfully. Migrated " + migratedCount + " events.";
            
        } catch (Exception e) {
            e.printStackTrace();
            return "Migration failed: " + e.getMessage();
        }
    }

    @GetMapping("/status")
    public String getMigrationStatus() {
        try {
            List<Evenement> allEvenements = evenementsRepository.findAll();
            int totalEvents = allEvenements.size();
            int eventsWithPhotos = 0;
            int eventsWithMultiplePhotos = 0;
            
            for (Evenement evenement : allEvenements) {
                if (evenement.getPhotosUrl() != null && !evenement.getPhotosUrl().isEmpty()) {
                    eventsWithPhotos++;
                    if (evenement.getPhotosUrl().size() > 1) {
                        eventsWithMultiplePhotos++;
                    }
                }
            }
            
            return String.format("Total events: %d, Events with photos: %d, Events with multiple photos: %d", 
                                totalEvents, eventsWithPhotos, eventsWithMultiplePhotos);
                                
        } catch (Exception e) {
            e.printStackTrace();
            return "Error getting status: " + e.getMessage();
        }
    }
}