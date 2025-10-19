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

    @PutMapping(value="/visibility")
    public ResponseEntity<UrlLink> updatevisibilty(@RequestBody UrlLink urlLink) {

        log.info("Update visibility :"+ urlLink.toString());

        UrlLink urlLink1 = urlLinkRepository.save(urlLink);
        HttpHeaders httpHeaders = new HttpHeaders();
        return new ResponseEntity<>(urlLink1, HttpStatus.OK);
    }
}
