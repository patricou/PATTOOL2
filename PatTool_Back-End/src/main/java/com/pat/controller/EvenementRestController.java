package com.pat.controller;

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
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;
import org.bson.types.ObjectId;

import java.util.List;

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

    @RequestMapping(value = "/{evenementName}/{page}/{size}", method = RequestMethod.GET)
    public Page<Evenement> getListEvenement(@PathVariable("evenementName") String evenementName,
                                            @PathVariable("page") int page,
                                            @PathVariable("size") int size,
                                            @RequestHeader(value = "user-id", required = false) String userId) {
        //log.info("Get evenement : "+evenementName+" / page : "+ page +" / size : " +size+ " / User Id : "+ userId );

        Pageable pageable = PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "beginEventDate"));

        return evenementsRepository.searchByFilter(evenementName, userId, pageable);
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
