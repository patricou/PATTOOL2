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
import com.mongodb.client.MongoCollection;
import org.bson.Document;
import java.util.List;

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
            // IMPORTANT: Drop any existing unique index on evenementName first
            dropUniqueIndexIfExists("evenementName");
            createIndexIfNotExists("evenementName", Sort.Direction.ASC, 
                "Index on evenementName for text search performance (non-unique)");

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

            // 11. Index on discussionId - CRITICAL for discussion queries
            // Used to find events by their associated discussion ID
            // This is used frequently in DiscussionService.getAccessibleDiscussions()
            createIndexIfNotExists("discussionId", Sort.Direction.ASC, 
                "Index on discussionId for efficient event lookup by discussion");

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
            log.info("MongoDB indexes for 'evenements' collection created successfully");
            log.info("========================================");
            
            // List indexes again to verify they were created
            listExistingIndexes();
            
            // Create indexes for FriendGroup collection
            createFriendGroupIndexes();

            // Create indexes for UserConnectionLog collection
            createUserConnectionLogIndexes();
        } catch (Exception e) {
            log.error("Error creating MongoDB indexes", e);
        }
    }

    /**
     * Create indexes for the userConnectionLogs collection
     */
    private void createUserConnectionLogIndexes() {
        try {
            log.info("========================================");
            log.info("Creating MongoDB indexes for UserConnectionLog collection");
            log.info("========================================");

            // List existing indexes
            listExistingIndexes("userConnectionLogs");

            // 1. Index on connectionDate (CRITICAL for date range filter + sort DESC)
            createIndexIfNotExists("userConnectionLogs", "connectionDate", Sort.Direction.DESC,
                    "Index on connectionDate for efficient date filtering and sorting");

            // 2. Index on discussionId (used for cleanup / linking)
            createIndexIfNotExists("userConnectionLogs", "discussionId", Sort.Direction.ASC,
                    "Index on discussionId for efficient log lookup by discussion");

            // 3. Index on member.$id (useful for user-specific diagnostics if needed)
            createIndexIfNotExists("userConnectionLogs", "member.$id", Sort.Direction.ASC,
                    "Index on member.$id for efficient log lookup by member");

            log.info("========================================");
            log.info("MongoDB indexes for 'userConnectionLogs' collection created successfully");
            log.info("========================================");

            // List indexes again to verify they were created
            listExistingIndexes("userConnectionLogs");
        } catch (Exception e) {
            log.error("Error creating UserConnectionLog indexes", e);
        }
    }

    /**
     * Create indexes for the friendgroups collection
     */
    private void createFriendGroupIndexes() {
        try {
            log.info("========================================");
            log.info("Creating MongoDB indexes for FriendGroup collection");
            log.info("========================================");
            
            // List existing indexes
            listExistingIndexes("friendgroups");

            // 1. Index on discussionId - CRITICAL for discussion queries
            // Used to find friend groups by their associated discussion ID
            // This is used frequently in DiscussionService.getAccessibleDiscussions()
            createIndexIfNotExists("friendgroups", "discussionId", Sort.Direction.ASC, 
                "Index on discussionId for efficient friend group lookup by discussion");

            // 2. Index on owner.$id (DBRef ObjectId)
            // Used to find friend groups by owner
            createIndexIfNotExists("friendgroups", "owner.$id", Sort.Direction.ASC, 
                "Index on owner.$id for finding friend groups by owner (ObjectId)");

            // 3. Index on owner.id (string fallback)
            // Used as fallback when owner is not ObjectId
            createIndexIfNotExists("friendgroups", "owner.id", Sort.Direction.ASC, 
                "Index on owner.id for finding friend groups by owner (string)");

            // 4. Index on members.$id (DBRef ObjectId array)
            // Used to find friend groups where a member is in the members list
            createIndexIfNotExists("friendgroups", "members.$id", Sort.Direction.ASC, 
                "Index on members.$id for finding friend groups by member");

            // 5. Index on authorizedUsers.$id (DBRef ObjectId array)
            // Used to find friend groups where a user is in the authorizedUsers list
            createIndexIfNotExists("friendgroups", "authorizedUsers.$id", Sort.Direction.ASC, 
                "Index on authorizedUsers.$id for finding friend groups by authorized user");

            log.info("========================================");
            log.info("MongoDB indexes for 'friendgroups' collection created successfully");
            log.info("========================================");
            
            // List indexes again to verify they were created
            listExistingIndexes("friendgroups");
            
            // Create indexes for Discussion collection
            createDiscussionIndexes();
        } catch (Exception e) {
            log.error("Error creating FriendGroup indexes", e);
        }
    }

    /**
     * Create indexes for the discussions collection
     */
    private void createDiscussionIndexes() {
        try {
            log.info("========================================");
            log.info("Creating MongoDB indexes for Discussion collection");
            log.info("========================================");
            
            // List existing indexes
            listExistingIndexes("discussions");

            // 1. Index on creationDate - CRITICAL for getDefaultDiscussion() fallback
            // Used for sorting discussions by creation date (DESC order)
            // This is used when defaultDiscussionId is not set - uses limit(1) with this index
            createIndexIfNotExists("discussions", "creationDate", Sort.Direction.DESC, 
                "Index on creationDate for efficient sorting (used in getDefaultDiscussion fallback)");

            // 2. Index on _id is automatic in MongoDB, but ensure it exists
            // This is already the default, but we log it for completeness
            log.info("✓ _id index exists by default (used for findById queries)");

            log.info("========================================");
            log.info("MongoDB indexes for 'discussions' collection created successfully");
            log.info("========================================");
            
            // List indexes again to verify they were created
            listExistingIndexes("discussions");
        } catch (Exception e) {
            log.error("Error creating Discussion indexes", e);
        }
    }
    
    /**
     * List all existing indexes on a collection for verification
     */
    private void listExistingIndexes() {
        listExistingIndexes("evenements");
    }

    /**
     * List all existing indexes on a specific collection for verification
     */
    private void listExistingIndexes(String collectionName) {
        try {
            IndexOperations indexOps = mongoTemplate.indexOps(collectionName);
            var indexes = indexOps.getIndexInfo();
            log.info("Existing indexes on '{}' collection: {}", collectionName, indexes.size());
            for (var indexInfo : indexes) {
                log.info("  - {}: {}", indexInfo.getName(), indexInfo.toString());
            }
        } catch (Exception e) {
            log.warn("Could not list existing indexes for collection '{}': {}", collectionName, e.getMessage());
        }
    }

    /**
     * Create a simple index if it doesn't already exist (for evenements collection)
     */
    private void createIndexIfNotExists(String field, Sort.Direction direction, String description) {
        createIndexIfNotExists("evenements", field, direction, description);
    }

    /**
     * Create a simple index if it doesn't already exist (for a specific collection)
     */
    private void createIndexIfNotExists(String collectionName, String field, Sort.Direction direction, String description) {
        try {
            IndexOperations indexOps = mongoTemplate.indexOps(collectionName);
            Index index = new Index().on(field, direction).named(field.replace(".", "_") + "_idx");
            String indexName = indexOps.ensureIndex(index);
            if (indexName != null && !indexName.isEmpty()) {
                log.info("✓ Created index on '{}': {} ({})", collectionName, indexName, description);
            } else {
                log.info("✓ Index on '{}'.{} already exists or was created ({})", collectionName, field, description);
            }
        } catch (Exception e) {
            log.error("Error creating index on '{}'.{}: {}", collectionName, field, e.getMessage(), e);
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

    /**
     * Drop a unique index on a field if it exists
     * This is used to remove unique constraints that prevent duplicate values
     */
    private void dropUniqueIndexIfExists(String field) {
        try {
            MongoCollection<Document> collection = mongoTemplate.getCollection("evenements");
            List<Document> indexes = collection.listIndexes().into(new java.util.ArrayList<>());
            
            for (Document indexDoc : indexes) {
                String indexName = indexDoc.getString("name");
                Document keyDoc = indexDoc.get("key", Document.class);
                
                // Check if this index is on the specified field and is unique
                if (keyDoc != null && keyDoc.size() == 1 && keyDoc.containsKey(field)) {
                    Boolean isUnique = indexDoc.getBoolean("unique", false);
                    if (Boolean.TRUE.equals(isUnique)) {
                        log.info("Found unique index '{}' on field '{}', dropping it to allow duplicate values", indexName, field);
                        try {
                            collection.dropIndex(indexName);
                            log.info("✓ Dropped unique index '{}' on field '{}'", indexName, field);
                        } catch (Exception dropException) {
                            log.warn("Could not drop unique index '{}': {}", indexName, dropException.getMessage());
                        }
                    }
                }
            }
        } catch (Exception e) {
            log.warn("Error checking/dropping unique index on field '{}': {}", field, e.getMessage());
        }
    }
}

