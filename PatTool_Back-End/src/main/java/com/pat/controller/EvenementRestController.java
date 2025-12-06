package com.pat.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.repo.domain.Evenement;
import com.pat.repo.domain.FileUploaded;
import com.pat.repo.domain.Friend;
import com.pat.repo.domain.FriendGroup;
import com.pat.repo.domain.Member;
import com.pat.repo.EvenementsRepository;
import com.pat.repo.FriendGroupRepository;
import com.pat.repo.FriendRepository;
import com.pat.repo.MembersRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.gridfs.GridFsTemplate;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;
import org.bson.types.ObjectId;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicInteger;
import jakarta.annotation.PreDestroy;

/**
 * Created by patricou on 4/20/2017.
 */
@RestController
@RequestMapping("/api/even")
public class EvenementRestController {

    private static final Logger log = LoggerFactory.getLogger(EvenementRestController.class);

    @Autowired
    private EvenementsRepository evenementsRepository;
    
    @Autowired
    private GridFsTemplate gridFsTemplate;
    
    @Autowired
    private MongoTemplate mongoTemplate;
    
    @Autowired
    private ObjectMapper objectMapper;
    
    @Autowired
    private FriendRepository friendRepository;
    
    @Autowired
    private MembersRepository membersRepository;
    
    @Autowired
    private FriendGroupRepository friendGroupRepository;
    
    @Value("${app.admin.userid}")
    String authorizedUserId;
    
    // Use bounded thread pool to prevent memory leaks from unlimited thread creation
    // Max 50 threads, with 30 second keep-alive time for idle threads
    // This prevents memory leaks from CachedThreadPool which can create unlimited threads
    private final ExecutorService executorService = new ThreadPoolExecutor(
        5,  // Core pool size
        50, // Maximum pool size (bounded to prevent memory issues)
        30L, TimeUnit.SECONDS, // Keep-alive time for idle threads
        new LinkedBlockingQueue<>(1000), // Bounded queue to prevent unbounded memory growth
        new ThreadPoolExecutor.CallerRunsPolicy() // Reject policy: run in caller thread if queue is full
    );

    @RequestMapping(value = "/{evenementName}/{page}/{size}", method = RequestMethod.GET)
    public Page<Evenement> getListEvenement(@PathVariable("evenementName") String evenementName,
                                            @PathVariable("page") int page,
                                            @PathVariable("size") int size,
                                            @RequestHeader(value = "user-id", required = false) String userId) {
        //log.info("Get evenement : "+evenementName+" / page : "+ page +" / size : " +size+ " / User Id : "+ userId );

        Pageable pageable = PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "beginEventDate"));

        return evenementsRepository.searchByFilter(evenementName, userId, pageable);
    }

    /**
     * Reactive streaming endpoint for events using Server-Sent Events (SSE)
     * Streams events one by one as they are fetched from MongoDB Atlas
     * Sends data immediately when 1 record is available (truly reactive approach)
     */
    @GetMapping(value = "/stream/{evenementName}", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamEvenements(@PathVariable("evenementName") String evenementName,
                                      @RequestHeader(value = "user-id", required = false) String userId,
                                      @RequestHeader(value = "visibility-filter", required = false) String visibilityFilter) {
        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE); // No timeout
        
        log.info("Stream events request - filter: {}, visibilityFilter: {}, userId: {}", evenementName, visibilityFilter, userId);
        
        CompletableFuture.runAsync(() -> {
            try {
                // Build query with access criteria (same as repository)
                Query query = new Query();
                
                // Get normalized filter for matching (title, description, and type)
                String normalizedFilter = normalizeFilter(evenementName);
                
                // Build access criteria - if visibility filter is provided, use filtered access criteria
                Criteria accessCriteria;
                if (visibilityFilter != null && !visibilityFilter.trim().isEmpty() && !"all".equals(visibilityFilter.trim())) {
                    // Build access criteria that only includes the selected visibility type
                    String filterValue = visibilityFilter.trim();
                    log.info("Building access criteria for visibility filter: {}", filterValue);
                    accessCriteria = buildAccessCriteriaForVisibility(filterValue, userId);
                    log.info("Access criteria built for visibility filter: {}", filterValue);
                } else {
                    // Use standard access criteria (all visible events)
                    accessCriteria = buildAccessCriteria(userId);
                }
                
                // Build list of all criteria to combine with AND
                java.util.List<Criteria> allCriteriaList = new java.util.ArrayList<>();
                allCriteriaList.add(accessCriteria);
                
                // Build MongoDB query criteria for efficient database-level filtering
                java.util.List<Criteria> filterCriteriaList = new java.util.ArrayList<>();
                
                if (!normalizedFilter.isEmpty()) {
                    // Resolve filter to type number if it's a keyword (e.g., "velo" -> "5")
                    String resolvedTypeNumber = resolveCanonicalType(normalizedFilter);
                    
                    // Build text search criteria for title and description
                    String escapedFilter = escapeRegex(normalizedFilter);
                    java.util.List<Criteria> textCriteria = new java.util.ArrayList<>();
                    textCriteria.add(Criteria.where("evenementName").regex(escapedFilter, "i"));
                    textCriteria.add(Criteria.where("comments").regex(escapedFilter, "i"));
                    
                    // Combine text criteria with OR
                    Criteria textFilter = new Criteria().orOperator(textCriteria.toArray(new Criteria[0]));
                    filterCriteriaList.add(textFilter);
                    
                    // If filter resolves to a type number, add type filter
                    if (resolvedTypeNumber != null) {
                        filterCriteriaList.add(Criteria.where("type").is(resolvedTypeNumber));
                    }
                    
                    // Combine all filters with OR (match if text matches OR type matches)
                    Criteria combinedFilter = new Criteria().orOperator(filterCriteriaList.toArray(new Criteria[0]));
                    allCriteriaList.add(combinedFilter);
                }
                
                // Combine all criteria with AND
                if (allCriteriaList.size() == 1) {
                    query.addCriteria(allCriteriaList.get(0));
                    log.info("Query criteria (single): {}", allCriteriaList.get(0).getCriteriaObject().toJson());
                } else {
                    Criteria finalCriteria = new Criteria().andOperator(allCriteriaList.toArray(new Criteria[0]));
                    query.addCriteria(finalCriteria);
                    log.info("Query criteria (combined): {}", finalCriteria.getCriteriaObject().toJson());
                }
                
                // Log the full query for debugging
                log.info("Full query: {}", query.getQueryObject().toJson());
                
                // Sort by beginEventDate descending (most recent first) - MongoDB will sort efficiently
                // Events with null dates will be at the end of the sorted results
                query.with(Sort.by(Sort.Direction.DESC, "beginEventDate"));
                
                // CRITICAL PERFORMANCE OPTIMIZATION: Exclude fileUploadeds from query results
                // All files will be loaded on-demand via /api/even/{id}/files endpoint
                // This dramatically reduces document size for events with many files (50+)
                query.fields().exclude("fileUploadeds");
                
                // Configure cursor batch size to 8 for optimal MongoDB efficiency
                // With batch size 8, MongoDB fetches 8 documents at once, significantly reducing round trips
                // This helps eliminate delays caused by MongoDB's internal processing and network latency
                // The events are still sent immediately as they're processed, maintaining reactive streaming
                // Larger batch size reduces the number of round trips to MongoDB, which is especially important
                // when there are delays between certain documents (e.g., between 4th and 5th event)
                query.cursorBatchSize(8);
                
                AtomicInteger sentCount = new AtomicInteger(0);
                AtomicInteger totalCount = new AtomicInteger(0);
                // Flag to track if client is still connected
                java.util.concurrent.atomic.AtomicBoolean clientConnected = new java.util.concurrent.atomic.AtomicBoolean(true);
                // Only collect events with null dates to send them at the end
                // Limit size to prevent excessive memory usage (max 1000 null-dated events)
                List<Evenement> nullDateEvents = new java.util.ArrayList<>(1000);
                
                // Count total matching events before streaming (for debugging)
                long totalMatchingEvents = mongoTemplate.count(query, Evenement.class);
                log.info("Total events matching query: {}", totalMatchingEvents);
                
                // Diagnostic: Check if there are ANY events with visibility="friends"
                Query friendsOnlyQuery = new Query(Criteria.where("visibility").is("friends"));
                long totalFriendsEvents = mongoTemplate.count(friendsOnlyQuery, Evenement.class);
                log.info("Total events with visibility='friends' in database: {}", totalFriendsEvents);
                
                // Diagnostic: Get one friends visibility event to see its structure
                if (totalFriendsEvents > 0) {
                    log.info("Attempting to find sample friends event...");
                    try {
                        Evenement sampleEvent = mongoTemplate.findOne(friendsOnlyQuery, Evenement.class);
                        if (sampleEvent != null) {
                            log.info("Sample friends event found - id: {}, visibility: {}", 
                                sampleEvent.getId(), 
                                sampleEvent.getVisibility());
                            if (sampleEvent.getAuthor() != null) {
                                log.info("Sample event author is not null, author.id: {}", 
                                    sampleEvent.getAuthor().getId() != null ? sampleEvent.getAuthor().getId() : "null");
                            } else {
                                log.info("Sample event author is null");
                            }
                            
                            // Also check the raw document structure
                            String collectionName = mongoTemplate.getCollectionName(Evenement.class);
                            log.info("Collection name: {}", collectionName);
                            org.bson.Document queryDoc = new org.bson.Document("visibility", "friends");
                            org.bson.Document rawDoc = mongoTemplate.getCollection(collectionName)
                                .find(queryDoc)
                                .first();
                            if (rawDoc != null) {
                                Object authorObj = rawDoc.get("author");
                                log.info("Raw author field: {}", authorObj);
                                if (authorObj != null) {
                                    log.info("Raw author field class: {}", authorObj.getClass().getName());
                                    if (authorObj instanceof org.bson.Document) {
                                        org.bson.Document authorDoc = (org.bson.Document) authorObj;
                                        log.info("Author document: {}", authorDoc.toJson());
                                    }
                                }
                            } else {
                                log.warn("Raw document is null");
                            }
                        } else {
                            log.warn("Sample event is null");
                        }
                    } catch (Exception e) {
                        log.error("Error in diagnostic query: {}", e.getMessage(), e);
                    }
                } else {
                    log.info("No friends events found for diagnostic");
                }
                
                // Diagnostic: Check if there are events authored by the friends
                if (visibilityFilter != null && visibilityFilter.trim().equals("friends") && userId != null) {
                    try {
                        java.util.Optional<Member> currentUserOpt = membersRepository.findById(userId);
                        if (currentUserOpt.isPresent()) {
                            Member currentUser = currentUserOpt.get();
                            java.util.List<Friend> friendships = friendRepository.findByUser1OrUser2(currentUser, currentUser);
                            java.util.List<String> friendIds = new java.util.ArrayList<>();
                            for (Friend friendship : friendships) {
                                if (friendship.getUser1() != null && !friendship.getUser1().getId().equals(userId)) {
                                    friendIds.add(friendship.getUser1().getId());
                                }
                                if (friendship.getUser2() != null && !friendship.getUser2().getId().equals(userId)) {
                                    friendIds.add(friendship.getUser2().getId());
                                }
                            }
                            for (String friendId : friendIds) {
                                // Check all events by this friend
                                java.util.List<Criteria> friendAuthorCriteria = new java.util.ArrayList<>();
                                try {
                                    friendAuthorCriteria.add(Criteria.where("author.$id").is(new ObjectId(friendId)));
                                } catch (IllegalArgumentException ex) {
                                }
                                friendAuthorCriteria.add(Criteria.where("author.$id").is(friendId));
                                friendAuthorCriteria.add(Criteria.where("author.id").is(friendId));
                                Query friendAuthorQuery = new Query(new Criteria().orOperator(friendAuthorCriteria.toArray(new Criteria[0])));
                                long friendEvents = mongoTemplate.count(friendAuthorQuery, Evenement.class);
                                log.info("Events authored by friend {}: {}", friendId, friendEvents);
                                
                                // Check events by this friend with visibility="friends"
                                Query friendFriendsQuery = new Query(new Criteria().andOperator(
                                    new Criteria().orOperator(friendAuthorCriteria.toArray(new Criteria[0])),
                                    Criteria.where("visibility").is("friends")
                                ));
                                long friendFriendsEvents = mongoTemplate.count(friendFriendsQuery, Evenement.class);
                                log.info("Events authored by friend {} with visibility='friends': {}", friendId, friendFriendsEvents);
                            }
                        }
                    } catch (Exception e) {
                        log.debug("Error in diagnostic query: {}", e.getMessage());
                    }
                }
                
                // Use stream() which returns a Stream backed by a MongoDB cursor
                // MongoDB will return results sorted by beginEventDate DESC (nulls last)
                // With batch size 1, each document is fetched and sent immediately
                try (java.util.stream.Stream<Evenement> eventStream = 
                        mongoTemplate.stream(query, Evenement.class)) {
                    
                    // Process and send events immediately as they arrive from MongoDB
                    eventStream.forEach(event -> {
                        log.debug("Processing event: id={}, visibility={}, author={}", 
                            event.getId(), event.getVisibility(), 
                            event.getAuthor() != null ? event.getAuthor().getId() : "null");
                        // Check if client is still connected before processing
                        if (!clientConnected.get()) {
                            return; // Stop processing if client disconnected
                        }
                        
                        try {
                            // Apply filter if needed (in-memory filtering for complex logic)
                            // If filter is empty, MongoDB already filtered correctly, so we accept all events
                            // If filter exists, do in-memory filtering to match complex logic (short-circuit: matchesFilter() only called when filter is not empty)
                            boolean shouldIncludeEvent = normalizedFilter.isEmpty() || matchesFilter(event, normalizedFilter);
                            if (shouldIncludeEvent) {
                                totalCount.incrementAndGet();
                                
                                // Check if event has a null date
                                if (event.getBeginEventDate() == null) {
                                    
                                    // Collect null-dated events to send at the end
                                    // Limit accumulation to prevent memory issues
                                    if (nullDateEvents.size() < 1000) {
                                        nullDateEvents.add(event);
                                    } else {
                                        // If too many null-dated events, send immediately to prevent memory buildup
                                        
                                        try {
                                            if (!clientConnected.get()) {
                                                return;
                                            }
                                            String eventJson = objectMapper.writeValueAsString(event);
                                            emitter.send(SseEmitter.event()
                                                .name("event")
                                                .data(eventJson));
                                            sentCount.incrementAndGet();
                                            log.debug("Sent null-dated event immediately (limit reached): {}", event.getId());
                                        } catch (IOException | IllegalStateException e) {
                                            log.debug("Client disconnected or emitter closed while sending null-dated event", e);
                                            clientConnected.set(false);
                                            return;
                                        } catch (Exception e) {
                                            log.error("Error sending null-dated event immediately", e);
                                        }
                                    }
                                } else {
                                    // Send events with dates immediately (they're already sorted by MongoDB)
                                    try {
                                        // Check connection before sending
                                        if (!clientConnected.get()) {
                                            return; // Stop if client disconnected
                                        }
                                        
                                        // Preload DBRef to avoid lazy loading during serialization
                                        // This ensures DBRef resolution happens before serialization, not during
                                        if (event.getAuthor() != null) {
                                            // Trigger DBRef resolution by accessing the object
                                            event.getAuthor().getId();
                                        }
                                        if (event.getMembers() != null && !event.getMembers().isEmpty()) {
                                            // Trigger DBRef resolution for all members
                                            event.getMembers().forEach(member -> {
                                                if (member != null) {
                                                    member.getId();
                                                }
                                            });
                                        }
                                        
                                        String eventJson = objectMapper.writeValueAsString(event);
                                        emitter.send(SseEmitter.event()
                                            .name("event")
                                            .data(eventJson));
                                        
                                        sentCount.incrementAndGet();
                                    } catch (IOException e) {
                                        // Client disconnected - mark as disconnected and stop processing
                                        log.debug("Client disconnected during streaming", e);
                                        clientConnected.set(false);
                                        return; // Stop processing stream
                                    } catch (IllegalStateException e) {
                                        // Emitter already completed/closed
                                        log.debug("Emitter already closed, stopping stream", e);
                                        clientConnected.set(false);
                                        return; // Stop processing stream
                                    } catch (Exception e) {
                                        log.error("Error sending event", e);
                                        // Continue with next event instead of failing completely
                                    }
                                }
                            }
                        } catch (Exception e) {
                            log.error("Error processing event from MongoDB stream", e);
                            // Continue with next event instead of failing completely
                        }
                    });
                }
                
                // Send null-dated events at the end (they were collected separately)
                // Only if client is still connected
                if (clientConnected.get()) {
                    for (Evenement event : nullDateEvents) {
                        try {
                            // Check connection before sending
                            if (!clientConnected.get()) {
                                break; // Stop if client disconnected
                            }
                            
                            // Ensure only thumbnail file is included (should already be done, but double-check)
                            if (event.getFileUploadeds() != null && !event.getFileUploadeds().isEmpty()) {
                                List<FileUploaded> thumbnailOnly = event.getFileUploadeds().stream()
                                    .filter(file -> file.getFileName() != null && 
                                            file.getFileName().toLowerCase().contains("thumbnail"))
                                    .collect(java.util.stream.Collectors.toList());
                                event.setFileUploadeds(thumbnailOnly);
                            }
                            
                            String eventJson = objectMapper.writeValueAsString(event);
                            emitter.send(SseEmitter.event()
                                .name("event")
                                .data(eventJson));
                            
                            int currentCount = sentCount.incrementAndGet();
                            log.debug("✅ Sent null-dated event {} at end: {}", currentCount, event.getId());
                        } catch (IOException e) {
                            // Client disconnected - stop sending
                            log.debug("Client disconnected during streaming null-dated events", e);
                            clientConnected.set(false);
                            break;
                        } catch (IllegalStateException e) {
                            // Emitter already completed/closed
                            log.debug("Emitter already closed, stopping null-dated events", e);
                            clientConnected.set(false);
                            break;
                        } catch (Exception e) {
                            log.error("Error sending null-dated event", e);
                            // Continue with next event instead of failing completely
                        }
                    }
                }
                
                // Send total count and completion signal only if client is still connected
                if (clientConnected.get()) {
                    try {
                        // Send total count (after we've processed all events)
                        emitter.send(SseEmitter.event()
                            .name("total")
                            .data(String.valueOf(totalCount.get())));
                        
                        // Send completion signal
                        emitter.send(SseEmitter.event()
                            .name("complete")
                            .data(""));
                        emitter.complete();
                        
                        log.debug("✅ Truly reactive streaming completed: {} events sent ({} with dates immediately, {} null-dated at end)", 
                            sentCount.get(), sentCount.get() - nullDateEvents.size(), nullDateEvents.size());
                    } catch (IOException e) {
                        log.debug("Client disconnected while sending completion signal", e);
                        clientConnected.set(false);
                    } catch (IllegalStateException e) {
                        log.debug("Emitter already closed while sending completion signal", e);
                        clientConnected.set(false);
                    } catch (Exception e) {
                        log.error("Error sending completion signal", e);
                    }
                } else {
                    log.debug("Streaming stopped early due to client disconnection. Sent {} events before disconnect.", sentCount.get());
                }
                
            } catch (Exception e) {
                log.error("Error streaming events reactively from MongoDB Atlas", e);
                try {
                    emitter.send(SseEmitter.event()
                        .name("error")
                        .data("Error: " + e.getMessage()));
                    emitter.completeWithError(e);
                } catch (IOException ioException) {
                    log.error("Error sending error event", ioException);
                    emitter.completeWithError(e);
                }
            }
        }, executorService);
        
        // Handle client disconnection
        emitter.onCompletion(() -> log.debug("SSE connection completed"));
        emitter.onTimeout(() -> {
            log.debug("SSE connection timeout");
            emitter.complete();
        });
        emitter.onError((ex) -> {
            // Check if this is a normal client disconnection (connection abort)
            String errorMessage = ex.getMessage();
            boolean isConnectionAbort = false;
            
            if (errorMessage != null) {
                isConnectionAbort = errorMessage.contains("An established connection was aborted by the software in your host machine") ||
                                   errorMessage.contains("Une connexion établie a été abandonnée par un logiciel de votre ordinateur hôte") ||
                                   errorMessage.contains("Connection reset") ||
                                   errorMessage.contains("Broken pipe") ||
                                   errorMessage.contains("Connection closed");
            }
            
            // Also check the cause chain
            if (!isConnectionAbort && ex.getCause() != null) {
                String causeMessage = ex.getCause().getMessage();
                if (causeMessage != null) {
                    isConnectionAbort = causeMessage.contains("An established connection was aborted by the software in your host machine") ||
                                       causeMessage.contains("Une connexion établie a été abandonnée par un logiciel de votre ordinateur hôte") ||
                                       causeMessage.contains("Connection reset") ||
                                       causeMessage.contains("Broken pipe");
                }
            }
            
            if (isConnectionAbort) {
                // Normal client disconnection - log at debug level without stack trace
                log.debug("SSE connection closed by client (normal)");
            } else {
                // Real error - log with stack trace
                log.error("SSE connection error", ex);
            }
            emitter.completeWithError(ex);
        });
        
        return emitter;
    }
    
    // Helper methods for filtering (extracted from repository logic)
    private Criteria buildAccessCriteria(String userId) {
        java.util.List<Criteria> accessCriteria = new java.util.ArrayList<>();
        accessCriteria.add(Criteria.where("visibility").is("public"));
        
        if (userId != null && !userId.isEmpty()) {
            accessCriteria.add(buildAuthorCriteria(userId));
            // Add friends visibility criteria
            Criteria friendsCriteria = buildFriendsVisibilityCriteria(userId);
            if (friendsCriteria != null) {
                accessCriteria.add(friendsCriteria);
            }
            // Add friend group visibility criteria
            Criteria friendGroupCriteria = buildFriendGroupVisibilityCriteria(userId);
            if (friendGroupCriteria != null) {
                accessCriteria.add(friendGroupCriteria);
            }
        }
        
        if (accessCriteria.size() == 1) {
            return accessCriteria.get(0);
        }
        
        return new Criteria().orOperator(accessCriteria.toArray(new Criteria[0]));
    }
    
    /**
     * Build access criteria for a specific visibility type
     * This is used when filtering by visibility - only returns events of the selected type that user can access
     */
    private Criteria buildAccessCriteriaForVisibility(String visibilityFilter, String userId) {
        String filterValue = visibilityFilter.trim();
        java.util.List<Criteria> accessCriteria = new java.util.ArrayList<>();
        
        if ("public".equals(filterValue)) {
            // For public filter, only return public events
            accessCriteria.add(Criteria.where("visibility").is("public"));
        } else if ("private".equals(filterValue)) {
            // For private filter, only return private events where user is the author
            if (userId != null && !userId.isEmpty()) {
                Criteria authorCriteria = buildAuthorCriteria(userId);
                accessCriteria.add(new Criteria().andOperator(
                    Criteria.where("visibility").is("private"),
                    authorCriteria
                ));
            }
        } else if ("friends".equals(filterValue)) {
            // For friends filter, return friends visibility events authored by:
            // 1. The user's friends (events created by friends with friends visibility)
            // 2. The current user (user's own events with friends visibility)
            if (userId != null && !userId.isEmpty()) {
                java.util.List<Criteria> friendsCriteriaList = new java.util.ArrayList<>();
                
                // Add user's own events with friends visibility
                Criteria userOwnEvents = new Criteria().andOperator(
                    Criteria.where("visibility").is("friends"),
                    buildAuthorCriteria(userId)
                );
                friendsCriteriaList.add(userOwnEvents);
                
                // Add friends' events with friends visibility
                Criteria friendsEvents = buildFriendsVisibilityCriteria(userId);
                if (friendsEvents != null) {
                    friendsCriteriaList.add(friendsEvents);
                }
                
                if (friendsCriteriaList.isEmpty()) {
                    log.debug("User {} has no friends and no own events, returning no match for friends filter", userId);
                    return Criteria.where("_id").is("__NO_MATCH__");
                }
                
                // Combine with OR: user's own events OR friends' events
                Criteria combinedCriteria = friendsCriteriaList.size() == 1
                    ? friendsCriteriaList.get(0)
                    : new Criteria().orOperator(friendsCriteriaList.toArray(new Criteria[0]));
                
                log.info("Built friends visibility criteria including user's own events and friends' events");
                return combinedCriteria;
            } else {
                // No userId, can't show friends visibility events
                log.debug("No userId provided for friends filter, returning no match");
                return Criteria.where("_id").is("__NO_MATCH__");
            }
        } else {
            // Assume it's a friend group ID or name
            // Only return events for this specific friend group that user can access
            log.info("Processing friend group filter: {}", filterValue);
            if (userId != null && !userId.isEmpty()) {
                // Get friend groups where user is a member
                try {
                    log.info("Looking up user {} for friend group filtering", userId);
                    java.util.Optional<Member> currentUserOpt = membersRepository.findById(userId);
                    if (currentUserOpt.isPresent()) {
                        Member currentUser = currentUserOpt.get();
                        log.info("User found, getting friend groups...");
                        java.util.List<FriendGroup> userFriendGroups = friendGroupRepository.findByMembersContaining(currentUser);
                        log.info("User is a member of {} friend groups", userFriendGroups.size());
                        
                        // Check if the filter value matches any of the user's friend groups (by ID or name)
                        boolean isUserMember = false;
                        String matchedGroupId = null;
                        String matchedGroupName = null;
                        
                        for (FriendGroup group : userFriendGroups) {
                            log.info("Checking friend group - id: {}, name: {}, filterValue: {}", 
                                group.getId(), group.getName(), filterValue);
                            // Check by ID first
                            if (group.getId() != null && group.getId().equals(filterValue)) {
                                isUserMember = true;
                                matchedGroupId = group.getId();
                                if (group.getName() != null) {
                                    matchedGroupName = group.getName();
                                }
                                log.info("Matched friend group by ID: {}", matchedGroupId);
                                break;
                            }
                            // Also check by name (for backward compatibility)
                            if (group.getName() != null && group.getName().equals(filterValue)) {
                                isUserMember = true;
                                if (group.getId() != null) {
                                    matchedGroupId = group.getId();
                                }
                                matchedGroupName = group.getName();
                                log.info("Matched friend group by name: {}", matchedGroupName);
                                break;
                            }
                        }
                        
                        log.info("isUserMember: {}, matchedGroupId: {}, matchedGroupName: {}", 
                            isUserMember, matchedGroupId, matchedGroupName);
                        
                        // Try to find the group by ID even if user is not a member (for user's own events)
                        if (!isUserMember) {
                            log.info("User is not a member of any groups, trying to find group by ID: {}", filterValue);
                            try {
                                java.util.Optional<FriendGroup> groupOpt = friendGroupRepository.findById(filterValue);
                                if (groupOpt.isPresent()) {
                                    FriendGroup group = groupOpt.get();
                                    matchedGroupId = group.getId();
                                    if (group.getName() != null) {
                                        matchedGroupName = group.getName();
                                    }
                                    log.info("Found group by ID - id: {}, name: {}", matchedGroupId, matchedGroupName);
                                } else {
                                    log.info("Group not found by ID: {}", filterValue);
                                }
                            } catch (Exception e) {
                                log.debug("Error finding group by ID: {}", e.getMessage());
                            }
                        }
                        
                        // Build criteria for friend group events
                        // Include events where friendGroupId matches OR visibility matches group name
                        // Also include user's own events with this friendGroupId (even if not a member)
                        java.util.List<Criteria> groupCriteriaList = new java.util.ArrayList<>();
                        
                        // Match by friendGroupId if we have it
                        if (matchedGroupId != null) {
                            groupCriteriaList.add(Criteria.where("friendGroupId").is(matchedGroupId));
                            log.info("Added friendGroupId criteria: {}", matchedGroupId);
                        }
                        
                        // Also match by visibility matching the group name (for backward compatibility)
                        if (matchedGroupName != null) {
                            groupCriteriaList.add(Criteria.where("visibility").is(matchedGroupName));
                            log.info("Added visibility criteria for group name: {}", matchedGroupName);
                        }
                        
                        // Also try direct match with filter value (in case events use the filter value directly)
                        groupCriteriaList.add(Criteria.where("friendGroupId").is(filterValue));
                        groupCriteriaList.add(Criteria.where("visibility").is(filterValue));
                        log.info("Added direct match criteria for filter value: {}", filterValue);
                        
                        if (groupCriteriaList.isEmpty()) {
                            // No valid criteria, return no match
                            log.warn("No group criteria found, returning no match");
                            return Criteria.where("_id").is("__NO_MATCH__");
                        }
                        
                        // Combine all group criteria with OR (match if any of them match)
                        Criteria groupCriteria = groupCriteriaList.size() == 1 
                            ? groupCriteriaList.get(0)
                            : new Criteria().orOperator(groupCriteriaList.toArray(new Criteria[0]));
                        
                        // Diagnostic: Check how many events match this group criteria
                        Query groupQuery = new Query(groupCriteria);
                        long groupEventsCount = mongoTemplate.count(groupQuery, Evenement.class);
                        log.info("Events matching friend group criteria (friendGroupId={}, visibility={}): {}", 
                            matchedGroupId, matchedGroupName, groupEventsCount);
                        
                        log.info("Built friend group criteria for filter: {}, matchedGroupId: {}, matchedGroupName: {}", 
                            filterValue, matchedGroupId, matchedGroupName);
                        
                        return groupCriteria;
                    } else {
                        // User not found, return no match
                        return Criteria.where("_id").is("__NO_MATCH__");
                    }
                } catch (Exception e) {
                    log.debug("Error building friend group access criteria for visibility filter: {}", e.getMessage());
                    // On error, return no match
                    return Criteria.where("_id").is("__NO_MATCH__");
                }
            } else {
                // No userId, can't show friend group events
                return Criteria.where("_id").is("__NO_MATCH__");
            }
        }
        
        if (accessCriteria.isEmpty()) {
            // No matching criteria, return a criteria that matches nothing
            return Criteria.where("_id").is("__NO_MATCH__");
        }
        
        if (accessCriteria.size() == 1) {
            return accessCriteria.get(0);
        }
        
        return new Criteria().orOperator(accessCriteria.toArray(new Criteria[0]));
    }
    
    private Criteria buildFriendsVisibilityCriteria(String userId) {
        try {
            log.debug("Building friends visibility criteria for userId: {}", userId);
            // Get current user
            java.util.Optional<Member> currentUserOpt = membersRepository.findById(userId);
            if (currentUserOpt.isEmpty()) {
                log.debug("User not found: {}", userId);
                return null;
            }
            Member currentUser = currentUserOpt.get();
            
            // Get all friends of current user
            java.util.List<Friend> friendships = friendRepository.findByUser1OrUser2(currentUser, currentUser);
            log.debug("Found {} friendships for user {}", friendships.size(), userId);
            if (friendships.isEmpty()) {
                // No friends, so no friends visibility events should be shown
                log.debug("User {} has no friends", userId);
                return null;
            }
            
            // Collect all friend IDs (both user1 and user2 from friendships)
            java.util.List<String> friendIds = new java.util.ArrayList<>();
            for (Friend friendship : friendships) {
                if (friendship.getUser1() != null && !friendship.getUser1().getId().equals(userId)) {
                    friendIds.add(friendship.getUser1().getId());
                }
                if (friendship.getUser2() != null && !friendship.getUser2().getId().equals(userId)) {
                    friendIds.add(friendship.getUser2().getId());
                }
            }
            
            log.debug("Collected {} friend IDs: {}", friendIds.size(), friendIds);
            if (friendIds.isEmpty()) {
                log.debug("No friend IDs collected for user {}", userId);
                return null;
            }
            
            // Build criteria: visibility="friends" AND author is in friend list
            // The author field is stored as DBRef: { "$ref" : "members", "$id" : "..." }
            // The $id can be stored as ObjectId or as string, so we need to try both
            java.util.List<Criteria> friendAuthorCriteria = new java.util.ArrayList<>();
            for (String friendId : friendIds) {
                java.util.List<Criteria> friendIdCriteria = new java.util.ArrayList<>();
                
                // DBRef format: The $id in DBRef can be ObjectId or string
                // Try ObjectId format first (most common)
                try {
                    ObjectId friendObjectId = new ObjectId(friendId);
                    // DBRef with ObjectId $id
                    friendIdCriteria.add(Criteria.where("author.$id").is(friendObjectId));
                    // DBRef with ObjectId $id and $ref check
                    friendIdCriteria.add(new Criteria().andOperator(
                        Criteria.where("author.$ref").is("members"),
                        Criteria.where("author.$id").is(friendObjectId)
                    ));
                } catch (IllegalArgumentException ex) {
                    // Not a valid ObjectId format
                }
                
                // Try string format for DBRef $id (in case it's stored as string)
                friendIdCriteria.add(Criteria.where("author.$id").is(friendId));
                // DBRef with string $id and $ref check
                friendIdCriteria.add(new Criteria().andOperator(
                    Criteria.where("author.$ref").is("members"),
                    Criteria.where("author.$id").is(friendId)
                ));
                
                // Combine all formats with OR (match if any format matches)
                if (friendIdCriteria.size() == 1) {
                    friendAuthorCriteria.add(friendIdCriteria.get(0));
                } else {
                    friendAuthorCriteria.add(new Criteria().orOperator(friendIdCriteria.toArray(new Criteria[0])));
                }
            }
            
            if (friendAuthorCriteria.isEmpty()) {
                log.warn("No friend author criteria built for user {}", userId);
                return null;
            }
            
            // Combine all friend author criteria with OR (match if author is any of the friends)
            Criteria authorInFriends = friendAuthorCriteria.size() == 1 
                ? friendAuthorCriteria.get(0)
                : new Criteria().orOperator(friendAuthorCriteria.toArray(new Criteria[0]));
            
            // Final criteria: visibility="friends" AND author is in friend list
            Criteria friendsCriteria = new Criteria().andOperator(
                Criteria.where("visibility").is("friends"),
                authorInFriends
            );
            log.info("Built friends visibility criteria for user {} with {} friend IDs. Criteria: {}", 
                userId, friendIds.size(), friendsCriteria.getCriteriaObject().toJson());
            return friendsCriteria;
        } catch (Exception e) {
            // If any error occurs, return null (don't include friends visibility)
            log.error("Error building friends visibility criteria for user {}: {}", userId, e.getMessage(), e);
            return null;
        }
    }
    
    private Criteria buildFriendGroupVisibilityCriteria(String userId) {
        try {
            // Get current user
            java.util.Optional<Member> currentUserOpt = membersRepository.findById(userId);
            if (currentUserOpt.isEmpty()) {
                return null;
            }
            Member currentUser = currentUserOpt.get();
            
            // Get all friend groups where the user is a member
            java.util.List<FriendGroup> userFriendGroups = friendGroupRepository.findByMembersContaining(currentUser);
            if (userFriendGroups.isEmpty()) {
                // User is not a member of any friend group, so no friend group visibility events should be shown
                return null;
            }
            
            // Collect all friend group IDs where the user is a member
            java.util.List<String> friendGroupIds = new java.util.ArrayList<>();
            for (FriendGroup group : userFriendGroups) {
                if (group.getId() != null) {
                    friendGroupIds.add(group.getId());
                }
            }
            
            if (friendGroupIds.isEmpty()) {
                return null;
            }
            
            // Build criteria: visibility is NOT "public", "private", or "friends" 
            // AND friendGroupId is in the list of groups where user is a member
            // OR visibility matches the friend group name (for backward compatibility)
            java.util.List<Criteria> friendGroupCriteriaList = new java.util.ArrayList<>();
            
            // Match by friendGroupId
            for (String groupId : friendGroupIds) {
                try {
                    friendGroupCriteriaList.add(Criteria.where("friendGroupId").is(groupId));
                } catch (Exception ex) {
                    // Skip invalid group ID
                }
            }
            
            // Also match by visibility matching the group name (for backward compatibility)
            for (FriendGroup group : userFriendGroups) {
                if (group.getName() != null && !group.getName().trim().isEmpty()) {
                    friendGroupCriteriaList.add(
                        Criteria.where("visibility").is(group.getName())
                    );
                }
            }
            
            if (friendGroupCriteriaList.isEmpty()) {
                return null;
            }
            
            Criteria friendGroupMatch = new Criteria().orOperator(friendGroupCriteriaList.toArray(new Criteria[0]));
            
            // Visibility should not be "public", "private", or "friends" (it should be the group name)
            return new Criteria().andOperator(
                Criteria.where("visibility").nin("public", "private", "friends"),
                friendGroupMatch
            );
        } catch (Exception e) {
            // If any error occurs, return null (don't include friend group visibility)
            log.debug("Error building friend group visibility criteria: {}", e.getMessage());
            return null;
        }
    }
    
    private Criteria buildAuthorCriteria(String userId) {
        java.util.List<Criteria> authorCriteria = new java.util.ArrayList<>();
        try {
            authorCriteria.add(Criteria.where("author.$id").is(new ObjectId(userId)));
        } catch (IllegalArgumentException ex) {
            // not an ObjectId, fall back to string comparison
        }
        authorCriteria.add(Criteria.where("author.id").is(userId));
        return new Criteria().orOperator(authorCriteria.toArray(new Criteria[0]));
    }
    
    private String normalizeFilter(String filter) {
        if (filter == null || filter.trim().isEmpty() || "*".equals(filter.trim())) {
            return "";
        }
        return normalizeForSearch(filter.trim());
    }
    
    private String normalizeForSearch(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        String lower = value.toLowerCase(java.util.Locale.ROOT);
        String normalized = java.text.Normalizer.normalize(lower, java.text.Normalizer.Form.NFD);
        return normalized.replaceAll("\\p{M}", "");
    }
    
    /**
     * Escape special regex characters in the filter string to prevent regex errors
     */
    private String escapeRegex(String pattern) {
        if (pattern == null || pattern.isEmpty()) {
            return pattern;
        }
        // Escape special regex characters: . ^ $ * + ? { } [ ] \ | ( )
        return pattern.replaceAll("([\\\\\\[\\]{}()*+?.^$|])", "\\\\$1");
    }
    
    private boolean matchesFilter(Evenement event, String normalizedFilter) {
        if (normalizedFilter.isEmpty()) {
            return true;
        }
        
        // Check title (evenementName) - search for the word itself
        String eventName = event.getEvenementName() != null ? 
            normalizeForSearch(event.getEvenementName()) : "";
        boolean titleMatch = eventName.contains(normalizedFilter);
        
        // Check description (comments) - search for the word itself
        String comments = event.getComments() != null ? 
            normalizeForSearch(event.getComments()) : "";
        boolean descriptionMatch = comments.contains(normalizedFilter);
        
        // Check type - resolve keyword to numeric type and check if event type equals that number
        // e.g., "velo" → "5", then check if event.type == "5"
        boolean typeMatch = matchesType(event.getType(), normalizedFilter);
        
        // OR condition: match if title OR description OR type matches
        return titleMatch || descriptionMatch || typeMatch;
    }
    
    // Type alias lookup - maps keywords to canonical type numbers (e.g., "vtt" -> "1", "ski" -> "2")
    private static final java.util.Map<String, String> TYPE_ALIAS_LOOKUP = new java.util.HashMap<>();
    // Type keywords for all languages - matches repository implementation
    private static final java.util.Map<String, java.util.List<String>> TYPE_KEYWORDS_MAP = new java.util.HashMap<>();
    
    static {
        // Build the lookup maps - matches repository implementation exactly
        registerType("1", new String[]{"vtt", "mountain bike", "mountain biking", "mtb", "bicicleta de montana", "bicicleta de montaña", "bicicletta da montagna", "btt", "mountainbike", "горный велосипед", "山地车"},
                "1", "VTT", "EVENTCREATION.TYPE.VTT");
        registerType("2", new String[]{"ski", "skiing", "esqui", "esquiar", "sci", "sci alpino", "sciare", "skifahren", "lyzhi", "лыжи", "катание на лыжах", "горные лыжи", "スキー", "スキ", "스키", "滑雪"},
                "2", "SKI", "EVENTCREATION.TYPE.SKI");
        registerType("3", new String[]{"run", "running", "course", "course a pied", "jogging", "footing", "correr", "carrera", "corrida", "correre", "laufen", "lauf", "rennen", "marathon", "race", "бег", "бегать"},
                "3", "RUN", "COURSE", "EVENTCREATION.TYPE.RUN");
        registerType("4", new String[]{"walk", "walking", "marche", "promenade", "balade", "andar", "caminar", "paseo", "passeggiata", "spaziergang", "wandern", "步行", "散歩"},
                "4", "WALK", "MARCHE", "EVENTCREATION.TYPE.WALK");
        registerType("5", new String[]{"bike", "biking", "velo", "vélo", "cycling", "cyclisme", "bicycle", "bicicleta", "bicicletta", "radfahren", "fahrrad", "自転車", "骑行"},
                "5", "BIKE", "VELO", "VÉLO", "EVENTCREATION.TYPE.BIKE");
        registerType("6", new String[]{"party", "fete", "fête", "fiesta", "soirée", "celebration", "fest", "festen", "festivity", "festlichkeit", "celebracion", "celebración"},
                "6", "PARTY", "FETE", "FÊTE", "EVENTCREATION.TYPE.PARTY");
        registerType("7", new String[]{"vacation", "vacances", "vacaciones", "vacanza", "urlaub", "holiday", "holidays", "ferie", "ferias", "праздники"},
                "7", "VACATION", "VACANCES", "EVENTCREATION.TYPE.VACATION");
        registerType("8", new String[]{"travel", "voyage", "viaje", "viaggio", "reise", "trip", "journey", "viajar", "traveling", "travelling", "旅行", "旅"},
                "8", "TRAVEL", "VOYAGE", "EVENTCREATION.TYPE.TRAVEL");
        registerType("9", new String[]{"rando", "randonnée", "randonnee", "hike", "hiking", "trek", "trekking", "senderismo", "excursion", "escursionismo", "wanderung", "wandern", "徒步", "ハイキング"},
                "9", "RANDO", "EVENTCREATION.TYPE.RANDO");
        registerType("10", new String[]{"photos", "photo", "picture", "pictures", "imagenes", "immagini", "bilder", "fotografie", "fotos", "photoes", "写真", "照片"},
                "10", "PHOTOS", "EVENTCREATION.TYPE.PHOTOS");
        registerType("11", new String[]{"documents", "document", "docs", "documentos", "documenti", "dokumente", "documentacion", "documentación", "documentation", "资料"},
                "11", "DOCUMENTS", "EVENTCREATION.TYPE.DOCUMENTS");
        registerType("12", new String[]{"fiche", "sheet", "fact sheet", "datasheet", "scheda", "hoja", "blatt", "schede", "ficha", "schede informative"},
                "12", "FICHE", "EVENTCREATION.TYPE.FICHE");
        registerType("13", new String[]{"wine", "vin", "vino", "wein", "vino", "wijn", "вино", "ワイン", "葡萄酒", "יין", "κρασί", "نبيذ"},
                "13", "WINE", "VIN", "EVENTCREATION.TYPE.WINE");
        registerType("14", new String[]{"other", "autre", "otro", "altro", "andere", "其他", "その他", "أخرى", "אחר", "अन्य", "Другое", "Άλλο"},
                "14", "OTHER", "AUTRE", "EVENTCREATION.TYPE.OTHER");
        registerType("15", new String[]{"visit", "visite", "visita", "besuch", "访问", "訪問", "زيارة", "ביקור", "यात्रा", "Визит", "Επίσκεψη"},
                "15", "VISIT", "VISITE", "EVENTCREATION.TYPE.VISIT");
        registerType("16", new String[]{"work", "travaux", "trabajos", "lavori", "arbeiten", "工作", "作業", "أعمال", "עבודה", "काम", "Работы", "Εργασίες"},
                "16", "WORK", "TRAVAUX", "EVENTCREATION.TYPE.WORK");
        registerType("17", new String[]{"family", "famille", "familia", "famiglia", "familie", "家庭", "家族", "عائلة", "משפחה", "परिवार", "Семья", "Οικογένεια"},
                "17", "FAMILY", "FAMILLE", "EVENTCREATION.TYPE.FAMILY");
    }
    
    private static void registerType(String canonicalKey, String[] keywords, String... aliases) {
        java.util.List<String> normalizedKeywords = new java.util.ArrayList<>();
        
        registerAlias(canonicalKey, canonicalKey);
        for (String alias : aliases) {
            registerAlias(alias, canonicalKey);
        }
        
        for (String keyword : keywords) {
            if (keyword == null || keyword.trim().isEmpty()) {
                continue;
            }
            registerAlias(keyword, canonicalKey);
            String normalized = normalizeForSearchStatic(keyword);
            if (normalized != null && !normalized.isEmpty()) {
                normalizedKeywords.add(normalized);
                registerAlias(normalized, canonicalKey);
            }
        }
        
        TYPE_KEYWORDS_MAP.put(canonicalKey, normalizedKeywords);
    }
    
    private static void registerAlias(String alias, String canonicalKey) {
        if (alias == null || alias.trim().isEmpty()) {
            return;
        }
        TYPE_ALIAS_LOOKUP.putIfAbsent(alias, canonicalKey);
        TYPE_ALIAS_LOOKUP.putIfAbsent(alias.toUpperCase(java.util.Locale.ROOT), canonicalKey);
        TYPE_ALIAS_LOOKUP.putIfAbsent(alias.toLowerCase(java.util.Locale.ROOT), canonicalKey);
        String normalized = normalizeForSearchStatic(alias);
        if (normalized != null && !normalized.isEmpty()) {
            TYPE_ALIAS_LOOKUP.putIfAbsent(normalized, canonicalKey);
        }
    }
    
    private static String normalizeForSearchStatic(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        String lower = value.toLowerCase(java.util.Locale.ROOT);
        String normalized = java.text.Normalizer.normalize(lower, java.text.Normalizer.Form.NFD);
        return normalized.replaceAll("\\p{M}", "");
    }
    
    private String resolveCanonicalType(String value) {
        if (value == null || value.trim().isEmpty()) {
            return null;
        }
        
        String trimmed = value.trim();
        
        String canonical = TYPE_ALIAS_LOOKUP.get(trimmed);
        if (canonical != null) {
            return canonical;
        }
        
        canonical = TYPE_ALIAS_LOOKUP.get(trimmed.toUpperCase(java.util.Locale.ROOT));
        if (canonical != null) {
            return canonical;
        }
        
        canonical = TYPE_ALIAS_LOOKUP.get(trimmed.toLowerCase(java.util.Locale.ROOT));
        if (canonical != null) {
            return canonical;
        }
        
        String normalized = normalizeForSearch(value);
        return TYPE_ALIAS_LOOKUP.get(normalized);
    }
    
    private boolean matchesType(String type, String normalizedFilter) {
        if (type == null || type.trim().isEmpty() || normalizedFilter.isEmpty()) {
            return false;
        }
        
        String typeTrimmed = type.trim();
        
        // First, check if filter is a direct numeric type match (e.g., searching "5" matches type "5")
        String normalizedTypeValue = normalizeForSearch(typeTrimmed);
        if (normalizedTypeValue.equals(normalizedFilter) || normalizedFilter.equals(normalizedTypeValue)) {
            return true;
        }
        
        // Resolve the filter keyword to its canonical type number (e.g., "velo" → "5", "vtt" → "1")
        String canonicalFilterType = resolveCanonicalType(normalizedFilter);
        
        // If the filter resolves to a type number, check if the event's type equals that number
        // e.g., if filter "velo" resolves to "5", check if event.type == "5"
        if (canonicalFilterType != null && typeTrimmed.equals(canonicalFilterType)) {
            return true;
        }
        
        return false;
    }

    @RequestMapping(value = "/{id}", method = RequestMethod.GET)
    public Evenement getEvenement(@PathVariable String id) {
        //log.info("Get evenement {id} : " + id );
        return evenementsRepository.findById(id).orElse(null);
    }
    
    /**
     * Get all files for an event (loaded on-demand when user clicks file management button)
     * This endpoint is called separately to avoid loading all files in list queries
     * Uses MongoTemplate directly to ensure we get the complete document with all files
     */
    @RequestMapping(value = "/{id}/files", method = RequestMethod.GET)
    public ResponseEntity<List<FileUploaded>> getEventFiles(@PathVariable String id) {
        try {
            // Use MongoTemplate directly to fetch the complete document from MongoDB
            // This bypasses any potential caching and ensures we get all fileUploadeds
            Query query = new Query(Criteria.where("_id").is(id));
            Evenement evenement = mongoTemplate.findOne(query, Evenement.class);
            
            if (evenement == null) {
                log.warn("Event not found for ID: {}", id);
                return ResponseEntity.notFound().build();
            }
            
            List<FileUploaded> files = evenement.getFileUploadeds();
            if (files == null) {
                files = new ArrayList<>();
            }
            
            log.debug("Returning {} files for event {}", files.size(), id);
            return ResponseEntity.ok(files);
        } catch (Exception e) {
            log.error("Error loading files for event {}", id, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Reactive streaming endpoint for files using Server-Sent Events (SSE)
     * Streams files one by one as they are found in the database
     * Sends data immediately when 1 file is available (truly reactive approach)
     * Optimized to fetch only fileUploadeds field for faster response
     */
    @GetMapping(value = "/{id}/files/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamEventFiles(@PathVariable String id) {
        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE); // No timeout
        
        CompletableFuture.runAsync(() -> {
            try {
                // Optimize query: only fetch fileUploadeds field to minimize data transfer
                Query query = new Query(Criteria.where("_id").is(id));
                query.fields().include("fileUploadeds"); // Only fetch fileUploadeds field
                
                Evenement evenement = mongoTemplate.findOne(query, Evenement.class);
                
                if (evenement == null) {
                    log.warn("Event not found for ID: {}", id);
                    try {
                        emitter.send(SseEmitter.event()
                            .name("error")
                            .data("Event not found"));
                        emitter.complete();
                    } catch (Exception e) {
                        emitter.completeWithError(new RuntimeException("Event not found"));
                    }
                    return;
                }
                
                List<FileUploaded> files = evenement.getFileUploadeds();
                if (files == null) {
                    files = new ArrayList<>();
                }
                
                // Send total count first (before any files)
                try {
                    emitter.send(SseEmitter.event()
                        .name("total")
                        .data(String.valueOf(files.size())));
                } catch (IOException e) {
                    log.debug("Client disconnected while sending total count", e);
                    emitter.completeWithError(e);
                    return;
                }
                
                // Stream files one by one immediately - no delays
                AtomicInteger sentCount = new AtomicInteger(0);
                for (FileUploaded file : files) {
                    try {
                        // Pre-resolve DBRef for uploaderMember to avoid lazy loading during serialization
                        if (file.getUploaderMember() != null) {
                            file.getUploaderMember().getId(); // Trigger DBRef resolution
                        }
                        
                        // Serialize file to JSON (fast operation)
                        String fileJson = objectMapper.writeValueAsString(file);
                        
                        // Send file immediately - no artificial delays
                        emitter.send(SseEmitter.event()
                            .name("file")
                            .data(fileJson));
                        
                        sentCount.incrementAndGet();
                        
                        // Log only for first file and last file to reduce logging overhead
                        if (sentCount.get() == 1) {
                            log.debug("Started streaming files for event {} (total: {})", id, files.size());
                        }
                        
                    } catch (IOException e) {
                        // Client disconnected
                        log.debug("Client disconnected during file streaming at file {}", sentCount.get(), e);
                        emitter.completeWithError(e);
                        return;
                    } catch (IllegalStateException e) {
                        // Emitter already completed/closed
                        log.debug("Emitter already closed, stopping file stream at file {}", sentCount.get(), e);
                        return;
                    } catch (Exception e) {
                        log.error("Error sending file {}: {}", sentCount.get(), file.getFileName(), e);
                        // Continue with next file instead of failing completely
                    }
                }
                
                // Send completion event
                try {
                    emitter.send(SseEmitter.event()
                        .name("complete")
                        .data(""));
                    emitter.complete();
                    log.debug("Completed streaming {} files for event {}", sentCount.get(), id);
                } catch (Exception e) {
                    log.debug("Error sending completion event", e);
                    emitter.complete();
                }
                
            } catch (Exception e) {
                log.error("Error streaming files for event {}", id, e);
                try {
                    emitter.send(SseEmitter.event()
                        .name("error")
                        .data("Error loading files: " + e.getMessage()));
                    emitter.complete();
                } catch (Exception ex) {
                    emitter.completeWithError(e);
                }
            }
        }, executorService);
        
        return emitter;
    }

    @RequestMapping( method = RequestMethod.POST)
    public ResponseEntity<Evenement> addEvenement(@RequestBody Evenement evenement){

        // Check if event contains PHOTOFROMFS links and validate authorization
        if (evenement.getUrlEvents() != null && !evenement.getUrlEvents().isEmpty()) {
            boolean hasPhotoFromFs = evenement.getUrlEvents().stream()
                .anyMatch(urlEvent -> urlEvent != null && 
                    "PHOTOFROMFS".equalsIgnoreCase(urlEvent.getTypeUrl()));
            
            if (hasPhotoFromFs) {
                // Check if the author is authorized
                if (evenement.getAuthor() == null || 
                    evenement.getAuthor().getId() == null ||
                    !this.authorizedUserId.equals(evenement.getAuthor().getId())) {
                    log.warn("Unauthorized attempt to create PHOTOFROMFS link. User ID: {}, Authorized ID: {}", 
                        evenement.getAuthor() != null ? evenement.getAuthor().getId() : "null", 
                        this.authorizedUserId);
                    return new ResponseEntity<>(HttpStatus.FORBIDDEN);
                }
            }
        }

        // Validate friend group ownership if friendGroupId is set
        if (evenement.getFriendGroupId() != null && !evenement.getFriendGroupId().trim().isEmpty()) {
            if (evenement.getAuthor() == null || evenement.getAuthor().getId() == null) {
                log.warn("Cannot validate friend group ownership: author is null");
                return new ResponseEntity<>(HttpStatus.BAD_REQUEST);
            }
            
            java.util.Optional<FriendGroup> groupOpt = friendGroupRepository.findById(evenement.getFriendGroupId());
            if (groupOpt.isEmpty()) {
                log.warn("Friend group not found: {}", evenement.getFriendGroupId());
                return new ResponseEntity<>(HttpStatus.BAD_REQUEST);
            }
            
            FriendGroup group = groupOpt.get();
            if (group.getOwner() == null || !group.getOwner().getId().equals(evenement.getAuthor().getId())) {
                log.warn("User {} attempted to use friend group {} owned by {}", 
                    evenement.getAuthor().getId(), 
                    evenement.getFriendGroupId(),
                    group.getOwner() != null ? group.getOwner().getId() : "null");
                return new ResponseEntity<>(HttpStatus.FORBIDDEN);
            }
        }

        evenement.setId(null);

        Evenement eventSaved = evenementsRepository.save(evenement);

        //log.info("Evenements POST " + eventSaved +" Saved !");

        HttpHeaders httpHeaders = new HttpHeaders();
        httpHeaders.setLocation(ServletUriComponentsBuilder
                .fromCurrentRequest().path("/{id}")
                .buildAndExpand(eventSaved.getId()).toUri());

        return new ResponseEntity<>(null, httpHeaders, HttpStatus.CREATED);
    }

    @RequestMapping( method = RequestMethod.PUT)
    public ResponseEntity<Evenement> updateEvenement(@RequestBody Evenement evenement){

        // Check if event contains PHOTOFROMFS links and validate authorization
        if (evenement.getUrlEvents() != null && !evenement.getUrlEvents().isEmpty()) {
            boolean hasPhotoFromFs = evenement.getUrlEvents().stream()
                .anyMatch(urlEvent -> urlEvent != null && 
                    "PHOTOFROMFS".equalsIgnoreCase(urlEvent.getTypeUrl()));
            
            if (hasPhotoFromFs) {
                // Check if the author is authorized
                if (evenement.getAuthor() == null || 
                    evenement.getAuthor().getId() == null ||
                    !this.authorizedUserId.equals(evenement.getAuthor().getId())) {
                    log.warn("Unauthorized attempt to update PHOTOFROMFS link. User ID: {}, Authorized ID: {}", 
                        evenement.getAuthor() != null ? evenement.getAuthor().getId() : "null", 
                        this.authorizedUserId);
                    return new ResponseEntity<>(HttpStatus.FORBIDDEN);
                }
            }
        }

        // Validate friend group ownership if friendGroupId is set
        if (evenement.getFriendGroupId() != null && !evenement.getFriendGroupId().trim().isEmpty()) {
            if (evenement.getAuthor() == null || evenement.getAuthor().getId() == null) {
                log.warn("Cannot validate friend group ownership: author is null");
                return new ResponseEntity<>(HttpStatus.BAD_REQUEST);
            }
            
            java.util.Optional<FriendGroup> groupOpt = friendGroupRepository.findById(evenement.getFriendGroupId());
            if (groupOpt.isEmpty()) {
                log.warn("Friend group not found: {}", evenement.getFriendGroupId());
                return new ResponseEntity<>(HttpStatus.BAD_REQUEST);
            }
            
            FriendGroup group = groupOpt.get();
            if (group.getOwner() == null || !group.getOwner().getId().equals(evenement.getAuthor().getId())) {
                log.warn("User {} attempted to use friend group {} owned by {}", 
                    evenement.getAuthor().getId(), 
                    evenement.getFriendGroupId(),
                    group.getOwner() != null ? group.getOwner().getId() : "null");
                return new ResponseEntity<>(HttpStatus.FORBIDDEN);
            }
        }

        Evenement eventSaved = evenementsRepository.save(evenement);

        //log.info("Evenements PUT " + eventSaved.getEvenementName()+" Updated ! ( Visbility "+ eventSaved.getVisibility() +") ");

        HttpHeaders httpHeaders = new HttpHeaders();
        httpHeaders.setLocation(ServletUriComponentsBuilder
                .fromCurrentRequest().path("/{id}")
                .buildAndExpand(eventSaved.getId()).toUri());

        return new ResponseEntity<>(null, httpHeaders, HttpStatus.OK);
    }

    @RequestMapping(value = "/{id}", method = RequestMethod.DELETE)
    public  ResponseEntity<Evenement>  deleteEvenement(@PathVariable String id) {

        //log.info("Delete evenement id " + id );
        
        // Retrieve the event first to get associated files
        Evenement evenement = evenementsRepository.findById(id).orElse(null);
        
        if (evenement != null) {
            // Delete all associated files from GridFS
            if (evenement.getFileUploadeds() != null && !evenement.getFileUploadeds().isEmpty()) {
                //log.info("Deleting " + evenement.getFileUploadeds().size() + " associated files from GridFS");
                for (var fileUploaded : evenement.getFileUploadeds()) {
                    try {
                        ObjectId fileObjectId = new ObjectId(fileUploaded.getFieldId());
                        gridFsTemplate.delete(new Query(Criteria.where("_id").is(fileObjectId)));
                        //log.info("Deleted file from GridFS: " + fileUploaded.getFileName() + " (ID: " + fileUploaded.getFieldId() + ")");
                    } catch (Exception e) {
                        log.error("Error deleting file from GridFS: " + fileUploaded.getFieldId(), e);
                    }
                }
            }
            
            // Delete urlEvents, commentaries are embedded in the event document and will be deleted with it
            //log.info("Deleting event with " + (evenement.getUrlEvents() != null ? evenement.getUrlEvents().size() : 0) + " URL(s) and " +
            //         (evenement.getCommentaries() != null ? evenement.getCommentaries().size() : 0) + " commentarie(s)");
        }
        
        // Delete the event (which also deletes embedded urlEvents and commentaries)
        evenementsRepository.deleteById(id);

        return new ResponseEntity<>( HttpStatus.OK );
    }

    // Additional endpoint to match frontend expectations
    @RequestMapping(value = "/evenements", method = RequestMethod.GET)
    public ResponseEntity<List<Evenement>> getAllEvenements() {
        //log.info("Get all evenements");
        List<Evenement> evenements = evenementsRepository.findAll();
        return ResponseEntity.ok(evenements);
    }

    @RequestMapping(value = "/evenements/{id}", method = RequestMethod.GET)
    public ResponseEntity<Evenement> getEvenementById(@PathVariable String id) {
        //log.info("Get evenement by id: " + id);
        Evenement evenement = evenementsRepository.findById(id).orElse(null);
        if (evenement != null) {
            return ResponseEntity.ok(evenement);
        } else {
            return ResponseEntity.notFound().build();
        }
    }

    @RequestMapping(value = "/evenements", method = RequestMethod.POST)
    public ResponseEntity<Evenement> addEvenementViaEvenements(@RequestBody Evenement evenement) {
        return addEvenement(evenement);
    }

    @RequestMapping(value = "/evenements/{id}", method = RequestMethod.PUT)
    public ResponseEntity<Evenement> updateEvenementViaEvenements(@PathVariable String id, @RequestBody Evenement evenement) {
        evenement.setId(id);
        return updateEvenement(evenement);
    }

    @RequestMapping(value = "/evenements/{id}", method = RequestMethod.DELETE)
    public ResponseEntity<Evenement> deleteEvenementViaEvenements(@PathVariable String id) {
        return deleteEvenement(id);
    }

    /**
     * Cleanup method to properly shut down the executor service when the application stops.
     * This prevents memory leaks from threads that are never cleaned up.
     */
    @PreDestroy
    public void cleanup() {
        log.info("Shutting down executor service for event streaming...");
        executorService.shutdown();
        try {
            // Wait up to 30 seconds for tasks to complete
            if (!executorService.awaitTermination(30, TimeUnit.SECONDS)) {
                log.warn("Executor service did not terminate gracefully, forcing shutdown...");
                executorService.shutdownNow();
                // Wait again for forced shutdown
                if (!executorService.awaitTermination(10, TimeUnit.SECONDS)) {
                    log.error("Executor service did not terminate after forced shutdown");
                }
            } else {
                log.info("Executor service terminated gracefully");
            }
        } catch (InterruptedException e) {
            log.error("Interrupted while waiting for executor service to terminate", e);
            executorService.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

}
