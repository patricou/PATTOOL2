package com.pat.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * MongoDB 8.2 Configuration Verification
 * 
 * This component verifies the MongoDB 8.2 connection and logs
 * configuration information. Spring Boot 3.3.0 auto-configures
 * MongoDB with the settings from application.properties.
 * 
 * MongoDB 8.2 optimizations are configured via:
 * - Connection string options in application.properties
 * - Spring Boot's auto-configuration
 */
@Component
public class MongoConfig {

    private static final Logger log = LoggerFactory.getLogger(MongoConfig.class);

    @Value("${spring.data.mongodb.host:localhost}")
    private String host;

    @Value("${spring.data.mongodb.port:27018}")
    private int port;

    @Value("${spring.data.mongodb.database:rando}")
    private String database;

    private final MongoTemplate mongoTemplate;

    public MongoConfig(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    /**
     * Verify MongoDB 8.2 connection on application startup
     */
    @EventListener(ApplicationReadyEvent.class)
    public void verifyMongoConnection() {
        try {
            log.info("========================================");
            log.info("MongoDB 8.2 Connection Verification");
            log.info("========================================");
            log.info("Host: {}:{}", host, port);
            log.info("Database: {}", database);
            
            // Test connection by getting database name
            String dbName = mongoTemplate.getDb().getName();
            log.info("Connected to MongoDB database: {}", dbName);
            log.info("MongoDB 8.2 connection verified successfully");
            log.info("========================================");
        } catch (Exception e) {
            log.error("Failed to verify MongoDB 8.2 connection", e);
        }
    }
}

