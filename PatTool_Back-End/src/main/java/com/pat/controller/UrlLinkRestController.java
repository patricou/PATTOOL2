package com.pat.controller;

import com.pat.repo.domain.UrlLink;
import com.pat.repo.UrlLinkRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Optional;

@RestController
@RequestMapping("/api")
public class UrlLinkRestController {

    private static final Logger log = LoggerFactory.getLogger(UrlLinkRestController.class);

    @Autowired
    UrlLinkRepository urlLinkRepository;

    @GetMapping(value="/urllink/{userid}", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<UrlLink> getUrlLink(@PathVariable("userid") String userId){
        log.info("Get urlLink / User Id : "+ userId);
        Sort sort = Sort.by(Sort.Direction.ASC, "linkName");
        return urlLinkRepository.findByVisibilityOrAuthor_Id(sort,"public",userId);
    }

    @GetMapping(value="/urllink/id/{id}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<UrlLink> getUrlLinkById(@PathVariable("id") String id) {
        log.info("Get urlLink by id: {}", id);
        Optional<UrlLink> urlLink = urlLinkRepository.findById(id);
        return urlLink.map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping(value="/urllink", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<UrlLink> createUrlLink(@RequestBody UrlLink urlLink) {
        log.info("Create urlLink: {}", urlLink.getLinkName());
        try {
            // Capitalize first letter of linkName
            if (urlLink.getLinkName() != null && !urlLink.getLinkName().isEmpty()) {
                String name = urlLink.getLinkName();
                urlLink.setLinkName(name.substring(0, 1).toUpperCase() + name.substring(1).toLowerCase());
            }
            
            // Capitalize first letter of linkDescription
            if (urlLink.getLinkDescription() != null && !urlLink.getLinkDescription().isEmpty()) {
                String description = urlLink.getLinkDescription();
                urlLink.setLinkDescription(description.substring(0, 1).toUpperCase() + description.substring(1).toLowerCase());
            }
            
            // Generate next urlLinkID if needed
            if (urlLink.getUrlLinkID() == null || urlLink.getUrlLinkID().isEmpty()) {
                // Find the maximum urlLinkID and increment by 1
                List<UrlLink> allLinks = urlLinkRepository.findAll();
                long maxId = 0;
                for (UrlLink link : allLinks) {
                    try {
                        long id = Long.parseLong(link.getUrlLinkID());
                        if (id > maxId) {
                            maxId = id;
                        }
                    } catch (NumberFormatException e) {
                        // Skip invalid urlLinkID values
                    }
                }
                urlLink.setUrlLinkID(String.valueOf(maxId + 1));
            }
            // Don't set MongoDB _id manually, let MongoDB generate it
            urlLink.setId(null);
            UrlLink savedUrlLink = urlLinkRepository.save(urlLink);
            return new ResponseEntity<>(savedUrlLink, HttpStatus.CREATED);
        } catch (Exception e) {
            log.error("Error creating urlLink: ", e);
            return new ResponseEntity<>(null, HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    @PutMapping(value="/urllink/{id}")
    public ResponseEntity<UrlLink> updateUrlLink(@PathVariable String id, @RequestBody UrlLink urlLinkDetails) {
        log.info("Update urlLink with id: {}", id);
        Optional<UrlLink> urlLinkOptional = urlLinkRepository.findById(id);
        
        if (urlLinkOptional.isPresent()) {
            UrlLink urlLink = urlLinkOptional.get();
            
            // Capitalize first letter of linkName if provided
            if (urlLinkDetails.getLinkName() != null && !urlLinkDetails.getLinkName().isEmpty()) {
                String name = urlLinkDetails.getLinkName();
                urlLink.setLinkName(name.substring(0, 1).toUpperCase() + name.substring(1).toLowerCase());
            }
            
            urlLink.setUrl(urlLinkDetails.getUrl());
            
            // Capitalize first letter of linkDescription if provided
            if (urlLinkDetails.getLinkDescription() != null && !urlLinkDetails.getLinkDescription().isEmpty()) {
                String description = urlLinkDetails.getLinkDescription();
                urlLink.setLinkDescription(description.substring(0, 1).toUpperCase() + description.substring(1).toLowerCase());
            }
            
            urlLink.setCategoryLinkID(urlLinkDetails.getCategoryLinkID());
            urlLink.setVisibility(urlLinkDetails.getVisibility());
            urlLink.setAuthor(urlLinkDetails.getAuthor());
            
            UrlLink updatedUrlLink = urlLinkRepository.save(urlLink);
            return ResponseEntity.ok(updatedUrlLink);
        } else {
            return ResponseEntity.notFound().build();
        }
    }

    @PutMapping(value="/visibility")
    public ResponseEntity<UrlLink> updatevisibilty(@RequestBody UrlLink urlLink) {
        log.info("Update visibility :"+ urlLink.toString());
        UrlLink urlLink1 = urlLinkRepository.save(urlLink);
        HttpHeaders httpHeaders = new HttpHeaders();
        return new ResponseEntity<>(urlLink1, HttpStatus.OK);
    }

    @DeleteMapping(value="/urllink/{id}")
    public ResponseEntity<HttpStatus> deleteUrlLink(@PathVariable String id) {
        log.info("Delete urlLink with id: {}", id);
        try {
            urlLinkRepository.deleteById(id);
            return new ResponseEntity<>(HttpStatus.NO_CONTENT);
        } catch (Exception e) {
            log.error("Error deleting urlLink: ", e);
            return new ResponseEntity<>(HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }
}
