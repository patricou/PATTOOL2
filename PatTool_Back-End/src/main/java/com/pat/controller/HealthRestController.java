package com.pat.controller;

import com.pat.controller.dto.MongoHealthDto;
import com.pat.service.MongoHealthService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Public health probes (no authentication) for the Angular UI.
 */
@RestController
@RequestMapping("/api/health")
public class HealthRestController {

    private final MongoHealthService mongoHealthService;

    public HealthRestController(MongoHealthService mongoHealthService) {
        this.mongoHealthService = mongoHealthService;
    }

    /** Returns {@code status=UP} when MongoDB answers a ping, otherwise {@code status=DOWN}. */
    @GetMapping("/mongodb")
    public MongoHealthDto mongodbHealth() {
        return mongoHealthService.check();
    }
}
