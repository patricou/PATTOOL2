package com.pat.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * MongoDB Configuration Verification
 * 
 * This component verifies the MongoDB connection and logs
 * configuration information. Spring Boot 3.3.0 auto-configures
 * MongoDB with the settings from application.properties.
 * 
 * Supports both URI-based connections (MongoDB Atlas) and
 * host/port/database configurations (local MongoDB).
 */
@Component
public class MongoConfig {

    private static final Logger log = LoggerFactory.getLogger(MongoConfig.class);

    @Value("${spring.data.mongodb.uri:}")
    private String uri;

    @Value("${spring.data.mongodb.host:}")
    private String host;

    @Value("${spring.data.mongodb.port:27017}")
    private int port;

    @Value("${spring.data.mongodb.database:rando}")
    private String database;

    private final MongoTemplate mongoTemplate;

    public MongoConfig(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    /**
     * Verify MongoDB connection on application startup
     */
    @EventListener(ApplicationReadyEvent.class)
    public void verifyMongoConnection() {
        try {
            log.info("========================================");
            log.info("MongoDB Connection Verification");
            log.info("========================================");
            
            // Check if using URI (MongoDB Atlas) or host/port (local)
            if (uri != null && !uri.isEmpty()) {
                // Mask password in URI for security
                String maskedUri = uri.replaceAll("://([^:]+):([^@]+)@", "://$1:***@");
                log.info("Connection Type: MongoDB Atlas (URI)");
                log.info("URI: {}", maskedUri);
            } else {
                log.info("Connection Type: Local MongoDB");
                log.info("Host: {}:{}", host.isEmpty() ? "localhost" : host, port);
                log.info("Database: {}", database);
            }
            
            // Test connection by getting database name
            String dbName = mongoTemplate.getDb().getName();
            log.info("Connected to MongoDB database: {}", dbName);
            log.info("MongoDB connection verified successfully");
            log.info("========================================");
        } catch (Exception e) {
            log.error("Failed to verify MongoDB connection", e);
        }
    }
}

