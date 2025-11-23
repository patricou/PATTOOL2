package com.pat.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.repo.domain.Evenement;
import com.pat.repo.EvenementsRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.gridfs.GridFsTemplate;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;
import org.bson.types.ObjectId;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Created by patricou on 4/20/2017.
 */
@RestController
@RequestMapping("/api/even")
public class EvenementRestController {

    private static final Logger log = LoggerFactory.getLogger(EvenementRestController.class);

    @Autowired
    private EvenementsRepository evenementsRepository;
    
    @Autowired
    private GridFsTemplate gridFsTemplate;
    
    @Autowired
    private MongoTemplate mongoTemplate;
    
    @Autowired
    private ObjectMapper objectMapper;
    
    private final ExecutorService executorService = Executors.newCachedThreadPool();

    @RequestMapping(value = "/{evenementName}/{page}/{size}", method = RequestMethod.GET)
    public Page<Evenement> getListEvenement(@PathVariable("evenementName") String evenementName,
                                            @PathVariable("page") int page,
                                            @PathVariable("size") int size,
                                            @RequestHeader(value = "user-id", required = false) String userId) {
        //log.info("Get evenement : "+evenementName+" / page : "+ page +" / size : " +size+ " / User Id : "+ userId );

        Pageable pageable = PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "beginEventDate"));

        return evenementsRepository.searchByFilter(evenementName, userId, pageable);
    }

    /**
     * Reactive streaming endpoint for events using Server-Sent Events (SSE)
     * Streams events one by one as they are fetched from MongoDB Atlas
     * Sends data immediately when 1 record is available (truly reactive approach)
     */
    @GetMapping(value = "/stream/{evenementName}", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamEvenements(@PathVariable("evenementName") String evenementName,
                                      @RequestHeader(value = "user-id", required = false) String userId) {
        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE); // No timeout
        
        CompletableFuture.runAsync(() -> {
            try {
                // Build query with access criteria (same as repository)
                Query query = new Query();
                
                // Build all criteria first, then combine them properly
                Criteria accessCriteria = buildAccessCriteria(userId);
                
                // Add MongoDB-level filtering for text fields to reduce fetched documents
                // This significantly improves performance by filtering at database level
                String normalizedFilter = normalizeFilter(evenementName);
                
                if (!normalizedFilter.isEmpty()) {
                    // Add regex criteria for evenementName and comments to MongoDB query
                    // This reduces the number of documents fetched from MongoDB
                    java.util.List<Criteria> textCriteria = new java.util.ArrayList<>();
                    
                    // Escape special regex characters to prevent errors, but allow substring matching
                    // The pattern will match any string containing the filter text (case-insensitive)
                    String escapedFilter = escapeRegex(normalizedFilter);
                    
                    // Case-insensitive regex for evenementName (substring match)
                    textCriteria.add(Criteria.where("evenementName")
                        .regex(escapedFilter, "i"));
                    
                    // Case-insensitive regex for comments (substring match)
                    textCriteria.add(Criteria.where("comments")
                        .regex(escapedFilter, "i"));
                    
                    // Combine text criteria with OR - match if filter is in name OR comments
                    Criteria textFilter = new Criteria().orOperator(textCriteria.toArray(new Criteria[0]));
                    
                    // Combine access criteria AND text filter using andOperator
                    // This properly combines multiple criteria without conflicts
                    Criteria combinedCriteria = new Criteria().andOperator(
                        accessCriteria,
                        textFilter
                    );
                    query.addCriteria(combinedCriteria);
                } else {
                    // No text filter, just use access criteria
                    query.addCriteria(accessCriteria);
                }
                
                // Sort by beginEventDate descending (most recent first) - MongoDB will sort efficiently
                // Events with null dates will be at the end of the sorted results
                query.with(Sort.by(Sort.Direction.DESC, "beginEventDate"));
                
                log.debug("Starting truly reactive stream from MongoDB Atlas for filter: {} (sorted by date DESC, most recent first)", evenementName);
                
                AtomicInteger sentCount = new AtomicInteger(0);
                AtomicInteger totalCount = new AtomicInteger(0);
                // Flag to track if client is still connected
                java.util.concurrent.atomic.AtomicBoolean clientConnected = new java.util.concurrent.atomic.AtomicBoolean(true);
                // Only collect events with null dates to send them at the end
                List<Evenement> nullDateEvents = new java.util.ArrayList<>();
                
                // Use stream() which returns a Stream backed by a MongoDB cursor
                // MongoDB will return results sorted by beginEventDate DESC (nulls last)
                try (java.util.stream.Stream<Evenement> eventStream = 
                        mongoTemplate.stream(query, Evenement.class)) {
                    
                    // Process and send events immediately as they arrive from MongoDB
                    eventStream.forEach(event -> {
                        // Check if client is still connected before processing
                        if (!clientConnected.get()) {
                            return; // Stop processing if client disconnected
                        }
                        
                        try {
                            // Apply filter if needed (in-memory filtering for complex logic)
                            if (normalizedFilter.isEmpty() || matchesFilter(event, normalizedFilter)) {
                                totalCount.incrementAndGet();
                                
                                // Check if event has a null date
                                if (event.getBeginEventDate() == null) {
                                    // Collect null-dated events to send at the end
                                    nullDateEvents.add(event);
                                } else {
                                    // Send events with dates immediately (they're already sorted by MongoDB)
                                    try {
                                        // Check connection before sending
                                        if (!clientConnected.get()) {
                                            return; // Stop if client disconnected
                                        }
                                        
                                        String eventJson = objectMapper.writeValueAsString(event);
                                        emitter.send(SseEmitter.event()
                                            .name("event")
                                            .data(eventJson));
                                        
                                        int currentCount = sentCount.incrementAndGet();
                                        
                                        // Log first few events for debugging
                                        if (currentCount <= 3) {
                                            log.debug("✅ Sent event {} immediately (reactive): {} - Date: {}", 
                                                currentCount, event.getId(), event.getBeginEventDate());
                                        }
                                    } catch (IOException e) {
                                        // Client disconnected - mark as disconnected and stop processing
                                        log.debug("Client disconnected during streaming", e);
                                        clientConnected.set(false);
                                        return; // Stop processing stream
                                    } catch (IllegalStateException e) {
                                        // Emitter already completed/closed
                                        log.debug("Emitter already closed, stopping stream", e);
                                        clientConnected.set(false);
                                        return; // Stop processing stream
                                    } catch (Exception e) {
                                        log.error("Error sending event", e);
                                        // Continue with next event instead of failing completely
                                    }
                                }
                            }
                        } catch (Exception e) {
                            log.error("Error processing event from MongoDB stream", e);
                            // Continue with next event instead of failing completely
                        }
                    });
                }
                
                // Send null-dated events at the end (they were collected separately)
                // Only if client is still connected
                if (clientConnected.get()) {
                    for (Evenement event : nullDateEvents) {
                        try {
                            // Check connection before sending
                            if (!clientConnected.get()) {
                                break; // Stop if client disconnected
                            }
                            
                            String eventJson = objectMapper.writeValueAsString(event);
                            emitter.send(SseEmitter.event()
                                .name("event")
                                .data(eventJson));
                            
                            int currentCount = sentCount.incrementAndGet();
                            log.debug("✅ Sent null-dated event {} at end: {}", currentCount, event.getId());
                        } catch (IOException e) {
                            // Client disconnected - stop sending
                            log.debug("Client disconnected during streaming null-dated events", e);
                            clientConnected.set(false);
                            break;
                        } catch (IllegalStateException e) {
                            // Emitter already completed/closed
                            log.debug("Emitter already closed, stopping null-dated events", e);
                            clientConnected.set(false);
                            break;
                        } catch (Exception e) {
                            log.error("Error sending null-dated event", e);
                            // Continue with next event instead of failing completely
                        }
                    }
                }
                
                // Send total count and completion signal only if client is still connected
                if (clientConnected.get()) {
                    try {
                        // Send total count (after we've processed all events)
                        emitter.send(SseEmitter.event()
                            .name("total")
                            .data(String.valueOf(totalCount.get())));
                        
                        // Send completion signal
                        emitter.send(SseEmitter.event()
                            .name("complete")
                            .data(""));
                        emitter.complete();
                        
                        log.debug("✅ Truly reactive streaming completed: {} events sent ({} with dates immediately, {} null-dated at end)", 
                            sentCount.get(), sentCount.get() - nullDateEvents.size(), nullDateEvents.size());
                    } catch (IOException e) {
                        log.debug("Client disconnected while sending completion signal", e);
                        clientConnected.set(false);
                    } catch (IllegalStateException e) {
                        log.debug("Emitter already closed while sending completion signal", e);
                        clientConnected.set(false);
                    } catch (Exception e) {
                        log.error("Error sending completion signal", e);
                    }
                } else {
                    log.debug("Streaming stopped early due to client disconnection. Sent {} events before disconnect.", sentCount.get());
                }
                
            } catch (Exception e) {
                log.error("Error streaming events reactively from MongoDB Atlas", e);
                try {
                    emitter.send(SseEmitter.event()
                        .name("error")
                        .data("Error: " + e.getMessage()));
                    emitter.completeWithError(e);
                } catch (IOException ioException) {
                    log.error("Error sending error event", ioException);
                    emitter.completeWithError(e);
                }
            }
        }, executorService);
        
        // Handle client disconnection
        emitter.onCompletion(() -> log.debug("SSE connection completed"));
        emitter.onTimeout(() -> {
            log.debug("SSE connection timeout");
            emitter.complete();
        });
        emitter.onError((ex) -> {
            log.error("SSE connection error", ex);
            emitter.completeWithError(ex);
        });
        
        return emitter;
    }
    
    // Helper methods for filtering (extracted from repository logic)
    private Criteria buildAccessCriteria(String userId) {
        java.util.List<Criteria> accessCriteria = new java.util.ArrayList<>();
        accessCriteria.add(Criteria.where("visibility").is("public"));
        
        if (userId != null && !userId.isEmpty()) {
            accessCriteria.add(buildAuthorCriteria(userId));
        }
        
        if (accessCriteria.size() == 1) {
            return accessCriteria.get(0);
        }
        
        return new Criteria().orOperator(accessCriteria.toArray(new Criteria[0]));
    }
    
    private Criteria buildAuthorCriteria(String userId) {
        java.util.List<Criteria> authorCriteria = new java.util.ArrayList<>();
        try {
            authorCriteria.add(Criteria.where("author.$id").is(new ObjectId(userId)));
        } catch (IllegalArgumentException ex) {
            // not an ObjectId, fall back to string comparison
        }
        authorCriteria.add(Criteria.where("author.id").is(userId));
        return new Criteria().orOperator(authorCriteria.toArray(new Criteria[0]));
    }
    
    private String normalizeFilter(String filter) {
        if (filter == null || filter.trim().isEmpty() || "*".equals(filter.trim())) {
            return "";
        }
        return normalizeForSearch(filter.trim());
    }
    
    private String normalizeForSearch(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        String lower = value.toLowerCase(java.util.Locale.ROOT);
        String normalized = java.text.Normalizer.normalize(lower, java.text.Normalizer.Form.NFD);
        return normalized.replaceAll("\\p{M}", "");
    }
    
    /**
     * Escape special regex characters in the filter string to prevent regex errors
     */
    private String escapeRegex(String pattern) {
        if (pattern == null || pattern.isEmpty()) {
            return pattern;
        }
        // Escape special regex characters: . ^ $ * + ? { } [ ] \ | ( )
        return pattern.replaceAll("([\\\\\\[\\]{}()*+?.^$|])", "\\\\$1");
    }
    
    private boolean matchesFilter(Evenement event, String normalizedFilter) {
        if (normalizedFilter.isEmpty()) {
            return true;
        }
        String eventName = event.getEvenementName() != null ? 
            normalizeForSearch(event.getEvenementName()) : "";
        String comments = event.getComments() != null ? 
            normalizeForSearch(event.getComments()) : "";
        
        return eventName.contains(normalizedFilter) || comments.contains(normalizedFilter);
    }

    @RequestMapping(value = "/{id}", method = RequestMethod.GET)
    public Evenement getEvenement(@PathVariable String id) {
        //log.info("Get evenement {id} : " + id );
        return evenementsRepository.findById(id).orElse(null);
    }

    @RequestMapping( method = RequestMethod.POST)
    public ResponseEntity<Evenement> addEvenement(@RequestBody Evenement evenement){

        evenement.setId(null);

        Evenement eventSaved = evenementsRepository.save(evenement);

        //log.info("Evenements POST " + eventSaved +" Saved !");

        HttpHeaders httpHeaders = new HttpHeaders();
        httpHeaders.setLocation(ServletUriComponentsBuilder
                .fromCurrentRequest().path("/{id}")
                .buildAndExpand(eventSaved.getId()).toUri());

        return new ResponseEntity<>(null, httpHeaders, HttpStatus.CREATED);
    }

    @RequestMapping( method = RequestMethod.PUT)
    public ResponseEntity<Evenement> updateEvenement(@RequestBody Evenement evenement){

        Evenement eventSaved = evenementsRepository.save(evenement);

        //log.info("Evenements PUT " + eventSaved.getEvenementName()+" Updated ! ( Visbility "+ eventSaved.getVisibility() +") ");

        HttpHeaders httpHeaders = new HttpHeaders();
        httpHeaders.setLocation(ServletUriComponentsBuilder
                .fromCurrentRequest().path("/{id}")
                .buildAndExpand(eventSaved.getId()).toUri());

        return new ResponseEntity<>(null, httpHeaders, HttpStatus.OK);
    }

    @RequestMapping(value = "/{id}", method = RequestMethod.DELETE)
    public  ResponseEntity<Evenement>  deleteEvenement(@PathVariable String id) {

        //log.info("Delete evenement id " + id );
        
        // Retrieve the event first to get associated files
        Evenement evenement = evenementsRepository.findById(id).orElse(null);
        
        if (evenement != null) {
            // Delete all associated files from GridFS
            if (evenement.getFileUploadeds() != null && !evenement.getFileUploadeds().isEmpty()) {
                //log.info("Deleting " + evenement.getFileUploadeds().size() + " associated files from GridFS");
                for (var fileUploaded : evenement.getFileUploadeds()) {
                    try {
                        ObjectId fileObjectId = new ObjectId(fileUploaded.getFieldId());
                        gridFsTemplate.delete(new Query(Criteria.where("_id").is(fileObjectId)));
                        //log.info("Deleted file from GridFS: " + fileUploaded.getFileName() + " (ID: " + fileUploaded.getFieldId() + ")");
                    } catch (Exception e) {
                        log.error("Error deleting file from GridFS: " + fileUploaded.getFieldId(), e);
                    }
                }
            }
            
            // Delete urlEvents, commentaries are embedded in the event document and will be deleted with it
            //log.info("Deleting event with " + (evenement.getUrlEvents() != null ? evenement.getUrlEvents().size() : 0) + " URL(s) and " +
            //         (evenement.getCommentaries() != null ? evenement.getCommentaries().size() : 0) + " commentarie(s)");
        }
        
        // Delete the event (which also deletes embedded urlEvents and commentaries)
        evenementsRepository.deleteById(id);

        return new ResponseEntity<>( HttpStatus.OK );
    }

    // Additional endpoint to match frontend expectations
    @RequestMapping(value = "/evenements", method = RequestMethod.GET)
    public ResponseEntity<List<Evenement>> getAllEvenements() {
        //log.info("Get all evenements");
        List<Evenement> evenements = evenementsRepository.findAll();
        return ResponseEntity.ok(evenements);
    }

    @RequestMapping(value = "/evenements/{id}", method = RequestMethod.GET)
    public ResponseEntity<Evenement> getEvenementById(@PathVariable String id) {
        //log.info("Get evenement by id: " + id);
        Evenement evenement = evenementsRepository.findById(id).orElse(null);
        if (evenement != null) {
            return ResponseEntity.ok(evenement);
        } else {
            return ResponseEntity.notFound().build();
        }
    }

    @RequestMapping(value = "/evenements", method = RequestMethod.POST)
    public ResponseEntity<Evenement> addEvenementViaEvenements(@RequestBody Evenement evenement) {
        return addEvenement(evenement);
    }

    @RequestMapping(value = "/evenements/{id}", method = RequestMethod.PUT)
    public ResponseEntity<Evenement> updateEvenementViaEvenements(@PathVariable String id, @RequestBody Evenement evenement) {
        evenement.setId(id);
        return updateEvenement(evenement);
    }

    @RequestMapping(value = "/evenements/{id}", method = RequestMethod.DELETE)
    public ResponseEntity<Evenement> deleteEvenementViaEvenements(@PathVariable String id) {
        return deleteEvenement(id);
    }


}
