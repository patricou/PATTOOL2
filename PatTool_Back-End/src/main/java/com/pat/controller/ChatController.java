package com.pat.controller;

import com.pat.repo.domain.ChatRequest;
import com.pat.service.ChatService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
@Validated
public class ChatController {

    @Autowired
    private ChatService chatService;

    private static final Logger log = LoggerFactory.getLogger(ChatController.class);

    @PostMapping( value="/chat/{withHistoricalContext}/{withLastXQuestions}")
    public ResponseEntity<String> getResponse(@RequestBody ChatRequest chatRequest,
                                              @PathVariable boolean withHistoricalContext,
                                              @PathVariable boolean withLastXQuestions) {

        //log.info("Question {}, ( with historical : {} )", chatRequest.getUserInput(),hist);

        String response = chatService.getChatResponse(chatRequest.getUserInput(),withHistoricalContext,withLastXQuestions);

        HttpHeaders headers = new HttpHeaders();
        headers.set("Content-Type", "application/json; charset=UTF-8");

        return new ResponseEntity<>(response, headers, HttpStatus.OK);
    }

    @RequestMapping( value = "/delchat",
            method = RequestMethod.DELETE )
    public ResponseEntity<String> deletePatGPTHistorical() {

        //log.info("Delete historical chat request");

        chatService.deletePatGptHistorical();

        HttpHeaders headers = new HttpHeaders();
        headers.set("Content-Type", "application/json; charset=UTF-8");

        return new ResponseEntity<>("Historical Deleted", headers, HttpStatus.OK);
    }
}
