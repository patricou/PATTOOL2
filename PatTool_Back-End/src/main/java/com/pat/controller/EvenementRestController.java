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
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

/**
 * Created by patricou on 4/20/2017.
 */
@RestController
@RequestMapping("/api/even")
public class EvenementRestController {

    private static final Logger log = LoggerFactory.getLogger(EvenementRestController.class);

    @Autowired
    private EvenementsRepository evenementsRepository;

    @RequestMapping(value = "/{evenementName}/{page}/{size}/{userid}", method = RequestMethod.GET)
    public Page<Evenement> getListEvenement(@PathVariable("evenementName") String evenementName,
                                            @PathVariable("page") int page,
                                            @PathVariable("size") int size,
                                            @PathVariable("userid") String userId) {
        log.info("Get evenement : "+evenementName+" / page : "+ page +" / size : " +size+ " / User Id : "+ userId );

        Pageable pageable = PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "beginEventDate"));

        Page<Evenement> evenements = evenementsRepository.findByEvenementNameLikeIgnoreCaseAndAuthor_idOrEvenementNameLikeIgnoreCaseAndVisibility(pageable, evenementName, userId,evenementName,"public" );;


        return evenements;
    }

    @RequestMapping(value = "/{id}", method = RequestMethod.GET)
    public Evenement getEvenement(@PathVariable String id) {
        log.info("Get evenement {id} : " + id );
        return evenementsRepository.findById(id).orElse(null);
    }

    @RequestMapping( method = RequestMethod.POST)
    public ResponseEntity<Evenement> addEvenement(@RequestBody Evenement evenement){

        evenement.setId(null);

        Evenement eventSaved = evenementsRepository.save(evenement);

        log.info("Evenements POST " + eventSaved +" Saved !");

        HttpHeaders httpHeaders = new HttpHeaders();
        httpHeaders.setLocation(ServletUriComponentsBuilder
                .fromCurrentRequest().path("/{id}")
                .buildAndExpand(eventSaved.getId()).toUri());

        return new ResponseEntity<>(null, httpHeaders, HttpStatus.CREATED);
    }

    @RequestMapping( method = RequestMethod.PUT)
    public ResponseEntity<Evenement> updateEvenement(@RequestBody Evenement evenement){

        Evenement eventSaved = evenementsRepository.save(evenement);

        log.info("Evenements PUT " + eventSaved.getEvenementName()+" Updated ! ( Visbility "+ eventSaved.getVisibility() +") ");

        HttpHeaders httpHeaders = new HttpHeaders();
        httpHeaders.setLocation(ServletUriComponentsBuilder
                .fromCurrentRequest().path("/{id}")
                .buildAndExpand(eventSaved.getId()).toUri());

        return new ResponseEntity<>(null, httpHeaders, HttpStatus.OK);
    }

    @RequestMapping(value = "/{id}", method = RequestMethod.DELETE)
    public  ResponseEntity<Evenement>  deleteEvenement(@PathVariable String id) {

        log.info("Delete evenement id " + id );
        evenementsRepository.deleteById(id);

        return new ResponseEntity<>( HttpStatus.OK );
    }


}
