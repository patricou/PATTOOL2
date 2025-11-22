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
     * Streaming endpoint for events using Server-Sent Events (SSE)
     * Streams events one by one as they are processed
     */
    @GetMapping(value = "/stream/{evenementName}", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamEvenements(@PathVariable("evenementName") String evenementName,
                                      @RequestHeader(value = "user-id", required = false) String userId) {
        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE); // No timeout
        
        CompletableFuture.runAsync(() -> {
            try {
                // Get all events matching the filter (without pagination)
                List<Evenement> allEvents = evenementsRepository.searchByFilterStream(evenementName, userId);
                
                // Send total count first
                emitter.send(SseEmitter.event()
                    .name("total")
                    .data(String.valueOf(allEvents.size())));
                
                // Stream events one by one
                for (Evenement event : allEvents) {
                    try {
                        // Check if emitter is still valid (client might have disconnected)
                        // Send event as JSON
                        String eventJson = objectMapper.writeValueAsString(event);
                        emitter.send(SseEmitter.event()
                            .name("event")
                            .data(eventJson));
                        
                        // Small delay to prevent overwhelming the client
                        Thread.sleep(10);
                    } catch (IOException e) {
                        // Client likely disconnected
                        log.debug("Client disconnected during streaming", e);
                        return;
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        emitter.completeWithError(e);
                        return;
                    } catch (Exception e) {
                        log.error("Error sending event", e);
                        // Continue with next event instead of failing completely
                    }
                }
                
                // Send completion signal
                emitter.send(SseEmitter.event()
                    .name("complete")
                    .data(""));
                emitter.complete();
                
            } catch (Exception e) {
                log.error("Error streaming events", e);
                emitter.completeWithError(e);
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
