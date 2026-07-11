package com.pat.service;

import com.pat.controller.dto.MongoHealthDto;
import org.bson.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Service;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Lightweight MongoDB ping used by {@code GET /api/health/mongodb}.
 */
@Service
public class MongoHealthService {

    private static final Logger log = LoggerFactory.getLogger(MongoHealthService.class);
    private static final int PING_TIMEOUT_SECONDS = 4;

    private final MongoTemplate mongoTemplate;

    @Value("${spring.data.mongodb.uri:}")
    private String uri;

    @Value("${spring.data.mongodb.host:}")
    private String host;

    @Value("${spring.data.mongodb.port:27017}")
    private int port;

    @Value("${spring.data.mongodb.database:rando}")
    private String database;

    public MongoHealthService(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    public MongoHealthDto check() {
        String displayHost = resolveDisplayHost();
        int displayPort = port > 0 ? port : 27017;
        String displayDatabase = database != null && !database.isBlank() ? database : "rando";

        try {
            CompletableFuture<Void> ping = CompletableFuture.runAsync(() ->
                    mongoTemplate.getDb().runCommand(new Document("ping", 1)));
            ping.get(PING_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            return new MongoHealthDto("UP", null, displayHost, displayPort, displayDatabase);
        } catch (TimeoutException e) {
            log.debug("MongoDB health ping timed out after {}s", PING_TIMEOUT_SECONDS);
            return down(displayHost, displayPort, displayDatabase, "timeout");
        } catch (Exception e) {
            log.debug("MongoDB health ping failed: {}", e.getMessage());
            return down(displayHost, displayPort, displayDatabase, e.getMessage());
        }
    }

    private MongoHealthDto down(String displayHost, int displayPort, String displayDatabase, String detail) {
        String message = detail != null && !detail.isBlank() ? detail : "unavailable";
        return new MongoHealthDto("DOWN", message, displayHost, displayPort, displayDatabase);
    }

    private String resolveDisplayHost() {
        if (uri != null && !uri.isBlank()) {
            return "MongoDB (URI)";
        }
        if (host != null && !host.isBlank()) {
            return host;
        }
        return "localhost";
    }
}
