package com.pat.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.index.Index;
import org.springframework.data.mongodb.core.index.IndexOperations;
import org.springframework.stereotype.Component;

/**
 * MongoDB Index Configuration
 * 
 * Creates indexes on the Evenement collection to optimize query performance,
 * especially when events have many FileUploaded files.
 * 
 * Indexes are created automatically on application startup.
 */
@Component
public class MongoIndexConfig {

    private static final Logger log = LoggerFactory.getLogger(MongoIndexConfig.class);
    private final MongoTemplate mongoTemplate;

    public MongoIndexConfig(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    /**
     * Create all necessary indexes on application startup
     */
    @EventListener(ApplicationReadyEvent.class)
    public void createIndexes() {
        try {
            log.info("========================================");
            log.info("Creating MongoDB indexes for Evenement collection");
            log.info("========================================");
            
            // First, list existing indexes for verification
            listExistingIndexes();

            // 1. Index on beginEventDate (most common sort field)
            // Used for sorting events by date (DESC order)
            createIndexIfNotExists("beginEventDate", Sort.Direction.DESC, 
                "Index on beginEventDate for efficient sorting");

            // 1b. Index on creationDate (alternative sort field)
            // Used for sorting events by creation date (DESC order)
            createIndexIfNotExists("creationDate", Sort.Direction.DESC, 
                "Index on creationDate for efficient sorting by creation date");

            // 2. Index on visibility (used in access criteria)
            // Used to filter public events
            createIndexIfNotExists("visibility", Sort.Direction.ASC, 
                "Index on visibility for access control filtering");

            // 3. Index on author.$id (DBRef ObjectId)
            // Used to find events by author
            createIndexIfNotExists("author.$id", Sort.Direction.ASC, 
                "Index on author.$id for finding events by author (ObjectId)");

            // 4. Index on author.id (string fallback)
            // Used as fallback when author is not ObjectId
            createIndexIfNotExists("author.id", Sort.Direction.ASC, 
                "Index on author.id for finding events by author (string)");

            // 5. Compound index: visibility + beginEventDate
            // Optimizes queries that filter by visibility and sort by date
            createCompoundIndexIfNotExists(
                new String[]{"visibility", "beginEventDate"},
                new Sort.Direction[]{Sort.Direction.ASC, Sort.Direction.DESC},
                "Compound index on visibility + beginEventDate for filtered and sorted queries");

            // 6. Compound index: author.$id + beginEventDate
            // Optimizes queries for user's events sorted by date
            createCompoundIndexIfNotExists(
                new String[]{"author.$id", "beginEventDate"},
                new Sort.Direction[]{Sort.Direction.ASC, Sort.Direction.DESC},
                "Compound index on author.$id + beginEventDate for user events");

            // 6b. Compound index: author.$id + creationDate
            // Optimizes queries for user's events sorted by creation date
            createCompoundIndexIfNotExists(
                new String[]{"author.$id", "creationDate"},
                new Sort.Direction[]{Sort.Direction.ASC, Sort.Direction.DESC},
                "Compound index on author.$id + creationDate for user events by creation date");

            // 7. Index on type (used in filtering)
            // Used to filter events by type
            createIndexIfNotExists("type", Sort.Direction.ASC, 
                "Index on type for filtering events by type");

            // 8. Text index on evenementName and comments
            // Used for text search (case-insensitive regex queries)
            // Note: MongoDB text indexes support $text queries, but we use regex
            // Still useful for partial matching performance
            createIndexIfNotExists("evenementName", Sort.Direction.ASC, 
                "Index on evenementName for text search performance");

            createIndexIfNotExists("comments", Sort.Direction.ASC, 
                "Index on comments for text search performance");

            // 9. Indexes on FileUploaded array fields
            // These indexes help when querying or filtering within the fileUploadeds array
            // Especially important when events have many files (50+)
            
            // Index on fileUploadeds.fieldId - for finding files by ID
            createIndexIfNotExists("fileUploadeds.fieldId", Sort.Direction.ASC, 
                "Index on fileUploadeds.fieldId for efficient file lookup by ID");

            // Index on fileUploadeds.fileName - for finding files by name
            // Especially optimized for finding files with "thumbnail" in their name
            // Used in EvenementsRepositoryImpl and EvenementRestController to filter thumbnail files
            createIndexIfNotExists("fileUploadeds.fileName", Sort.Direction.ASC, 
                "Index on fileUploadeds.fileName for efficient file lookup by name (including thumbnail search)");

            // Index on fileUploadeds.fileType - for filtering files by type
            createIndexIfNotExists("fileUploadeds.fileType", Sort.Direction.ASC, 
                "Index on fileUploadeds.fileType for filtering files by type");

            // Index on fileUploadeds.uploaderMember.$id - for finding files by uploader
            createIndexIfNotExists("fileUploadeds.uploaderMember.$id", Sort.Direction.ASC, 
                "Index on fileUploadeds.uploaderMember.$id for finding files by uploader");

            // Index on thumbnail.fieldId - for finding events by thumbnail ID
            // Optimizes queries that need to find events with a specific thumbnail
            createIndexIfNotExists("thumbnail.fieldId", Sort.Direction.ASC, 
                "Index on thumbnail.fieldId for efficient thumbnail lookup");

            // 10. Compound index for common access pattern: visibility + type + beginEventDate
            // Optimizes filtered queries with sorting
            createCompoundIndexIfNotExists(
                new String[]{"visibility", "type", "beginEventDate"},
                new Sort.Direction[]{Sort.Direction.ASC, Sort.Direction.ASC, Sort.Direction.DESC},
                "Compound index on visibility + type + beginEventDate for complex filtered queries");

            // 10b. Compound index: visibility + beginEventDate + creationDate
            // Optimizes queries that might sort by either date field
            createCompoundIndexIfNotExists(
                new String[]{"visibility", "beginEventDate", "creationDate"},
                new Sort.Direction[]{Sort.Direction.ASC, Sort.Direction.DESC, Sort.Direction.DESC},
                "Compound index on visibility + beginEventDate + creationDate for flexible date sorting");

            log.info("========================================");
            log.info("MongoDB indexes created successfully");
            log.info("========================================");
            
            // List indexes again to verify they were created
            listExistingIndexes();
        } catch (Exception e) {
            log.error("Error creating MongoDB indexes", e);
        }
    }
    
    /**
     * List all existing indexes on the evenements collection for verification
     */
    private void listExistingIndexes() {
        try {
            IndexOperations indexOps = mongoTemplate.indexOps("evenements");
            var indexes = indexOps.getIndexInfo();
            log.info("Existing indexes on 'evenements' collection: {}", indexes.size());
            for (var indexInfo : indexes) {
                log.info("  - {}: {}", indexInfo.getName(), indexInfo.toString());
            }
        } catch (Exception e) {
            log.warn("Could not list existing indexes: {}", e.getMessage());
        }
    }

    /**
     * Create a simple index if it doesn't already exist
     */
    private void createIndexIfNotExists(String field, Sort.Direction direction, String description) {
        try {
            IndexOperations indexOps = mongoTemplate.indexOps("evenements");
            Index index = new Index().on(field, direction).named(field.replace(".", "_") + "_idx");
            String indexName = indexOps.ensureIndex(index);
            if (indexName != null && !indexName.isEmpty()) {
                log.info("✓ Created index: {} ({})", indexName, description);
            } else {
                log.info("✓ Index on {} already exists or was created ({})", field, description);
            }
        } catch (Exception e) {
            log.error("Error creating index on {}: {}", field, e.getMessage(), e);
        }
    }

    /**
     * Create a compound index if it doesn't already exist
     */
    private void createCompoundIndexIfNotExists(String[] fields, Sort.Direction[] directions, String description) {
        try {
            if (fields.length != directions.length) {
                log.warn("Fields and directions arrays must have the same length");
                return;
            }

            IndexOperations indexOps = mongoTemplate.indexOps("evenements");
            Index index = new Index();
            for (int i = 0; i < fields.length; i++) {
                index.on(fields[i], directions[i]);
            }
            
            // Create index name from fields
            String indexName = String.join("_", fields).replace(".", "_") + "_idx";
            index.named(indexName);
            
            String createdIndexName = indexOps.ensureIndex(index);
            if (createdIndexName != null && !createdIndexName.isEmpty()) {
                log.info("✓ Created compound index: {} ({})", createdIndexName, description);
            } else {
                log.info("✓ Compound index on {} already exists or was created ({})", String.join(", ", fields), description);
            }
        } catch (Exception e) {
            log.error("Error creating compound index on {}: {}", 
                String.join(", ", fields), e.getMessage(), e);
        }
    }
}

