# Streaming Performance Analysis - Why It's Slow

## 🔴 Problem: Slow Metadata Streaming

Even though we're only sending JSON metadata (no binary files), the streaming can still be slow. Here's why:

---

## 🐛 Root Causes

### 1. **@DBRef Lazy Loading (N+1 Query Problem)**

The `Evenement` class uses `@DBRef` which can cause performance issues:

```java
// Evenement.java
@DBRef
private Member author;  // ← DBRef

@DBRef
private List<Member> members;  // ← DBRef List

// In FileUploaded.java
@DBRef
private Member uploaderMember;  // ← Another DBRef
```

**Problem:**
- When `objectMapper.writeValueAsString(event)` serializes the event, Spring Data MongoDB may try to resolve each `@DBRef`
- This causes **N+1 queries**: 1 query per event + 1 query per DBRef
- Example: 50 events × 2 DBRefs each = **100+ database queries** instead of 1!

**Evidence:**
- Each `@DBRef` requires a separate database lookup
- `List<Member> members` might trigger multiple queries (one per member)
- `Member uploaderMember` in each `FileUploaded` requires a query

### 2. **Large Embedded Collections**

Events can contain large embedded lists:

```java
private List<FileUploaded> fileUploadeds;        // Could be 50+ files
private List<Commentary> commentaries;           // Could be 100+ comments
private List<UrlEvent> urlEvents;                // Could be 20+ URLs
private List<Member> members;                    // Could be 30+ members
private List<String> photosUrl;                  // Could be 50+ URLs
```

**Problem:**
- If an event has 100 comments, each with author info, the JSON can be **50-100 KB per event**
- 50 events × 50 KB = **2.5 MB of JSON** to serialize and send
- Serialization (`objectMapper.writeValueAsString()`) can be slow for large objects

### 3. **Full Object Serialization**

```java
// EvenementRestController.java line 164
String eventJson = objectMapper.writeValueAsString(event);
```

**Problem:**
- Serializes the **entire** event object, including:
  - All files metadata
  - All comments (potentially large)
  - All members (with full Member objects if DBRef is resolved)
  - All URLs
  - All embedded data

### 4. **MongoDB Stream Processing**

```java
// EvenementRestController.java line 137
try (java.util.stream.Stream<Evenement> eventStream = 
        mongoTemplate.stream(query, Evenement.class)) {
    eventStream.forEach(event -> {
        // Process each event one by one
        String eventJson = objectMapper.writeValueAsString(event);
        emitter.send(...);
    });
}
```

**Problem:**
- Stream processes events **one by one** (not in batches)
- Each event requires:
  1. MongoDB document fetch
  2. DBRef resolution (potential N+1 queries)
  3. JSON serialization
  4. SSE send

### 5. **No Field Projection**

The query fetches **all fields** from MongoDB:

```java
Query query = new Query();
// No field projection - fetches everything!
```

**Problem:**
- Fetches all fields even if frontend doesn't need them all
- Larger documents = more network overhead
- More data to serialize

---

## 📊 Performance Impact Estimate

### Scenario: 50 Events with Average Data

**Per Event:**
- 20 files → ~2 KB JSON for file metadata
- 50 comments → ~10 KB JSON (if comments include author info via DBRef)
- 10 members → ~3 KB JSON (if members resolved via DBRef)
- 5 URLs → ~0.5 KB JSON
- Base event data → ~1 KB JSON
- **Total per event: ~16.5 KB JSON**

**For 50 Events:**
- Total JSON size: **~825 KB**
- DBRef queries: **~100-150 queries** (author + members + uploaderMembers)
- Serialization time: **~2-5 seconds** (depending on CPU)
- Network transfer: **~1-2 seconds** (depending on connection)

**Total time: 3-7 seconds just for metadata!**

---

## ✅ Solutions

### Solution 1: Create a Lightweight DTO

Create a lightweight EventDTO that only includes necessary fields:

```java
public class EventStreamDTO {
    private String id;
    private String evenementName;
    private Date beginEventDate;
    private String authorId;  // Just ID, not full Member object
    private int fileCount;     // Count, not full list
    private int commentCount;  // Count, not full list
    // ... only essential fields
}
```

**Benefits:**
- Much smaller JSON (~1-2 KB per event instead of 16 KB)
- Faster serialization
- Faster network transfer

### Solution 2: Disable DBRef Resolution

Configure MongoDB to NOT resolve DBRefs automatically:

```java
// In streaming method, use a custom ObjectMapper or configure it
ObjectMapper mapper = new ObjectMapper();
// Don't resolve DBRefs, just send IDs
```

Or use field projection to avoid fetching referenced documents:

```java
Query query = new Query();
query.fields().exclude("members.$*");  // Don't fetch member details
```

### Solution 3: Batch Processing

Process and send events in batches:

```java
List<Evenement> batch = new ArrayList<>();
eventStream.forEach(event -> {
    batch.add(event);
    if (batch.size() >= 10) {
        sendBatch(batch);
        batch.clear();
    }
});
```

### Solution 4: Use Field Projection

Only fetch fields you need:

```java
Query query = new Query();
query.fields()
    .include("id")
    .include("evenementName")
    .include("beginEventDate")
    .include("author.$id")  // Only author ID, not full object
    .exclude("commentaries")  // Exclude large collections
    .exclude("fileUploadeds")  // Exclude file list
    // ... only include what's needed for list view
```

### Solution 5: Parallelize DBRef Resolution

If you need DBRef data, resolve them in parallel:

```java
// Batch fetch all unique member IDs
Set<String> memberIds = events.stream()
    .flatMap(e -> e.getMembers().stream())
    .map(Member::getId)
    .collect(Collectors.toSet());

// Single query to fetch all members
Map<String, Member> membersMap = membersRepository.findAllById(memberIds)
    .stream()
    .collect(Collectors.toMap(Member::getId, m -> m));

// Then populate in memory (much faster)
```

### Solution 6: Paginate Instead of Stream All

Don't stream ALL events at once. Stream in pages:

```java
// Stream first 20 events
// Frontend requests next page when scrolling
// Much faster initial load
```

---

## 🎯 Recommended Approach

### Short-term Fix:
1. **Create EventListDTO** with minimal fields
2. **Disable DBRef resolution** or use field projection
3. **Exclude large collections** (commentaries, fileUploadeds) from initial stream

### Long-term Fix:
1. **Pagination with streaming** - stream 20 events at a time
2. **Separate endpoints** for full event details
3. **Caching** for frequently accessed events
4. **Database indexes** on frequently queried fields

---

## 🔍 How to Diagnose

Add logging to see where time is spent:

```java
long start = System.currentTimeMillis();
Evenement event = // fetch from MongoDB
long fetchTime = System.currentTimeMillis() - start;

start = System.currentTimeMillis();
String json = objectMapper.writeValueAsString(event);
long serializeTime = System.currentTimeMillis() - start;

log.debug("Event {} - Fetch: {}ms, Serialize: {}ms", 
    event.getId(), fetchTime, serializeTime);
```

This will show if the bottleneck is:
- MongoDB queries (high fetchTime)
- JSON serialization (high serializeTime)
- Network transfer (check browser network tab)

---

## 📝 Summary

**Why it's slow:**
1. ❌ DBRef resolution causes N+1 queries
2. ❌ Large embedded collections increase JSON size
3. ❌ Full object serialization (includes everything)
4. ❌ No field projection (fetches all data)
5. ❌ Processing events one by one (not batched)

**Quick wins:**
- ✅ Create lightweight DTO
- ✅ Use field projection to exclude large collections
- ✅ Disable DBRef resolution for list view
- ✅ Add performance logging to identify bottlenecks

