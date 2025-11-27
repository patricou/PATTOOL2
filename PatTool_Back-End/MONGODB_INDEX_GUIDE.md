# MongoDB Index Configuration Guide

## Overview

This document explains the MongoDB indexes created for the `evenements` collection and how to verify they're working.

## Indexes Created

The `MongoIndexConfig` class automatically creates the following indexes on application startup:

### Single-Field Indexes
1. **beginEventDate** (DESC) - For sorting events by start date
2. **creationDate** (DESC) - For sorting events by creation date
3. **visibility** (ASC) - For filtering public/private events
4. **author.$id** (ASC) - For finding events by author (ObjectId)
5. **author.id** (ASC) - For finding events by author (string fallback)
6. **type** (ASC) - For filtering events by type
7. **evenementName** (ASC) - For text search performance
8. **comments** (ASC) - For text search performance

### FileUploaded Array Indexes
9. **fileUploadeds.fieldId** (ASC) - For finding files by ID
10. **fileUploadeds.fileName** (ASC) - For finding files by name, especially optimized for finding files with "thumbnail" in their name
11. **fileUploadeds.fileType** (ASC) - For filtering files by type
12. **fileUploadeds.uploaderMember.$id** (ASC) - For finding files by uploader

### Thumbnail Index
13. **thumbnail.fieldId** (ASC) - For finding events by thumbnail ID, optimizes queries that need to find events with a specific thumbnail

### Compound Indexes
13. **visibility + beginEventDate** - Optimizes filtered and sorted queries
14. **author.$id + beginEventDate** - Optimizes user events sorted by date
15. **author.$id + creationDate** - Optimizes user events sorted by creation date
16. **visibility + type + beginEventDate** - Complex filtered queries
17. **visibility + beginEventDate + creationDate** - Flexible date sorting

## Verifying Indexes Were Created

### 1. Check Application Logs

When the application starts, you should see log messages like:
```
========================================
Creating MongoDB indexes for Evenement collection
========================================
Existing indexes on 'evenements' collection: X
  - _id_: ...
  - beginEventDate_idx: ...
✓ Created index: beginEventDate_idx (Index on beginEventDate for efficient sorting)
...
========================================
MongoDB indexes created successfully
========================================
```

### 2. Check MongoDB Directly

Connect to MongoDB and run:
```javascript
use rando
db.evenements.getIndexes()
```

This will show all indexes on the collection.

### 3. Verify Index Usage

To see if MongoDB is using indexes for queries, you can use `explain()`:
```javascript
db.evenements.find({visibility: "public"}).sort({beginEventDate: -1}).explain("executionStats")
```

Look for:
- `"stage": "IXSCAN"` (index scan) - Good! Using index
- `"stage": "COLLSCAN"` (collection scan) - Bad! Not using index
- `"executionTimeMillis"` - Should be low when using indexes

## Important Note: Indexes vs. Document Size

**Indexes help with FINDING documents, but NOT with LOADING large documents.**

If an event has 50+ `FileUploaded` files, MongoDB still needs to:
1. Load the entire document from disk
2. Deserialize all the `fileUploadeds` array
3. Transfer it over the network

### Solution: Use Projection

To improve performance when listing events, exclude `fileUploadeds` from the initial query:

```java
// In EvenementRestController.streamEvenements()
query.fields().exclude("fileUploadeds");
query.fields().exclude("commentaries"); // Also exclude if not needed
```

Then load `fileUploadeds` only when viewing event details:
```java
// In getEvenement() - load full document with files
Evenement event = evenementsRepository.findById(id).orElse(null);
```

## Performance Tips

1. **For List Queries**: Exclude large arrays (`fileUploadeds`, `commentaries`) using projection
2. **For Detail Queries**: Load full document including all fields
3. **Index Direction**: DESC indexes match DESC sorting for optimal performance
4. **Compound Indexes**: Order matters - put equality filters first, then sort fields

## Troubleshooting

### Indexes Not Created
- Check application logs for errors
- Verify MongoDB connection is working
- Ensure `@EventListener(ApplicationReadyEvent.class)` is firing

### Indexes Created But Not Used
- Check query patterns match index fields
- Verify sort direction matches index direction
- Use `explain()` to see query execution plan

### Still Slow With Many Files
- Use projection to exclude `fileUploadeds` from list queries
- Load files only when needed (lazy loading)
- Consider pagination for files if there are many

