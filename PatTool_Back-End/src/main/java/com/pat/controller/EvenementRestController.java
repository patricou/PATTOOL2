package com.pat.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.repo.domain.Commentary;
import com.pat.repo.domain.Evenement;
import com.pat.repo.domain.FileUploaded;
import com.pat.repo.domain.Friend;
import com.pat.repo.domain.FriendGroup;
import com.pat.repo.domain.Member;
import com.pat.repo.EvenementsRepository;
import com.pat.repo.FriendGroupRepository;
import com.pat.repo.FriendRepository;
import com.pat.repo.MembersRepository;
import com.pat.repo.DiscussionRepository;
import com.pat.repo.UserConnectionLogRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
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
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;
import org.bson.types.ObjectId;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.HashSet;
import java.util.stream.Collectors;
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
    
    @Autowired
    private com.pat.service.DiscussionService discussionService;
    
    @Autowired
    private com.pat.repo.DiscussionRepository discussionRepository;
    
    @Autowired
    private com.pat.repo.UserConnectionLogRepository userConnectionLogRepository;
    
    @Autowired
    private com.pat.controller.MailController mailController;
    
    /**
     * Check if the current user has Admin role (case-insensitive)
     */
    private boolean hasAdminRole() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null) {
            return false;
        }
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(authority -> authority.equalsIgnoreCase("ROLE_Admin") || 
                                     authority.equalsIgnoreCase("ROLE_admin"));
    }

    /**
     * Check if the current user has FileSystem role (case-insensitive)
     */
    private boolean hasFileSystemRole() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null) {
            return false;
        }
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(authority -> authority.equalsIgnoreCase("ROLE_FileSystem") || 
                                     authority.equalsIgnoreCase("ROLE_filesystem") ||
                                     authority.equalsIgnoreCase("ROLE_FileSystem"));
    }
    
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
                                      @RequestHeader(value = "visibility-filter", required = false) String visibilityFilter,
                                      @RequestHeader(value = "admin-override", required = false) String adminOverride) {
        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE); // No timeout
        
        log.debug("Stream events request - filter: {}, visibilityFilter: {}, userId: {}, adminOverride: {}", evenementName, visibilityFilter, userId, adminOverride);
        
        // Validate admin override: if set to true, user must have admin role
        boolean isAdminOverride = "true".equalsIgnoreCase(adminOverride);
        if (isAdminOverride && !hasAdminRole()) {
            log.warn("Admin override requested but user does not have admin role. userId: {}", userId);
            try {
                emitter.send(SseEmitter.event()
                    .name("error")
                    .data("{\"error\":\"Admin override requires admin role\"}"));
                emitter.complete();
            } catch (Exception e) {
                log.error("Error sending admin override error", e);
            }
            return emitter;
        }
        
        CompletableFuture.runAsync(() -> {
            try {
                // Build query with access criteria (same as repository)
                Query query = new Query();
                
                // Get normalized filter for matching (title, description, and type)
                String normalizedFilter = normalizeFilter(evenementName);
                
                // Build access criteria - if admin override is enabled, skip access criteria
                // Build list of all criteria to combine with AND
                java.util.List<Criteria> allCriteriaList = new java.util.ArrayList<>();
                
                if (!isAdminOverride) {
                    // Only add access criteria if admin override is not enabled
                    Criteria accessCriteria;
                    if (visibilityFilter != null && !visibilityFilter.trim().isEmpty() && !"all".equals(visibilityFilter.trim())) {
                        // Build access criteria that only includes the selected visibility type
                        String filterValue = visibilityFilter.trim();
                        log.debug("Building access criteria for visibility filter: {}", filterValue);
                        accessCriteria = buildAccessCriteriaForVisibility(filterValue, userId);
                        log.debug("Access criteria built for visibility filter: {}", filterValue);
                    } else {
                        // Use standard access criteria (all visible events)
                        accessCriteria = buildAccessCriteria(userId);
                    }
                    allCriteriaList.add(accessCriteria);
                } else {
                    // Admin override: no access criteria, return all events
                    log.debug("Admin override enabled - skipping access criteria");
                }
                
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
                if (allCriteriaList.isEmpty()) {
                    // No criteria - return all events (admin override with no filter)
                    log.debug("Query criteria (empty): returning all events");
                } else if (allCriteriaList.size() == 1) {
                    query.addCriteria(allCriteriaList.get(0));
                    log.debug("Query criteria (single): {}", allCriteriaList.get(0).getCriteriaObject().toJson());
                } else {
                    Criteria finalCriteria = new Criteria().andOperator(allCriteriaList.toArray(new Criteria[0]));
                    query.addCriteria(finalCriteria);
                    log.debug("Query criteria (combined): {}", finalCriteria.getCriteriaObject().toJson());
                }
                
                // Log the full query for debugging
                log.debug("Full query: {}", query.getQueryObject().toJson());
                
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
                
                
                // Use stream() which returns a Stream backed by a MongoDB cursor
                // MongoDB will return results sorted by beginEventDate DESC (nulls last)
                // With batch size 1, each document is fetched and sent immediately
                try (java.util.stream.Stream<Evenement> eventStream = 
                        mongoTemplate.stream(query, Evenement.class)) {
                    
                    // Process and send events immediately as they arrive from MongoDB
                    eventStream.forEach(event -> {
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
                
                log.debug("Built friends visibility criteria including user's own events and friends' events");
                return combinedCriteria;
            } else {
                // No userId, can't show friends visibility events
                log.debug("No userId provided for friends filter, returning no match");
                return Criteria.where("_id").is("__NO_MATCH__");
            }
        } else {
            // Assume it's a friend group ID or name
            // Only return events for this specific friend group that user can access
            log.debug("Processing friend group filter: {}", filterValue);
            if (userId != null && !userId.isEmpty()) {
                // Get friend groups where user is a member
                try {
                    log.debug("Looking up user {} for friend group filtering", userId);
                    java.util.Optional<Member> currentUserOpt = membersRepository.findById(userId);
                    if (currentUserOpt.isPresent()) {
                        Member currentUser = currentUserOpt.get();
                        log.debug("User found, getting friend groups...");
                        java.util.List<FriendGroup> userFriendGroups = friendGroupRepository.findByMembersContaining(currentUser);
                        log.debug("User is a member of {} friend groups", userFriendGroups.size());
                        
                        // Check if the filter value matches any of the user's friend groups (by ID or name)
                        boolean isUserMember = false;
                        String matchedGroupId = null;
                        String matchedGroupName = null;
                        
                        for (FriendGroup group : userFriendGroups) {
                            log.debug("Checking friend group - id: {}, name: {}, filterValue: {}", 
                                group.getId(), group.getName(), filterValue);
                            // Check by ID first
                            if (group.getId() != null && group.getId().equals(filterValue)) {
                                isUserMember = true;
                                matchedGroupId = group.getId();
                                if (group.getName() != null) {
                                    matchedGroupName = group.getName();
                                }
                                log.debug("Matched friend group by ID: {}", matchedGroupId);
                                break;
                            }
                            // Also check by name (for backward compatibility)
                            if (group.getName() != null && group.getName().equals(filterValue)) {
                                isUserMember = true;
                                if (group.getId() != null) {
                                    matchedGroupId = group.getId();
                                }
                                matchedGroupName = group.getName();
                                log.debug("Matched friend group by name: {}", matchedGroupName);
                                break;
                            }
                        }
                        
                        log.debug("isUserMember: {}, matchedGroupId: {}, matchedGroupName: {}", 
                            isUserMember, matchedGroupId, matchedGroupName);
                        
                        // Try to find the group by ID even if user is not a member (for user's own events)
                        if (!isUserMember) {
                            log.debug("User is not a member of any groups, trying to find group by ID: {}", filterValue);
                            try {
                                java.util.Optional<FriendGroup> groupOpt = friendGroupRepository.findById(filterValue);
                                if (groupOpt.isPresent()) {
                                    FriendGroup group = groupOpt.get();
                                    matchedGroupId = group.getId();
                                    if (group.getName() != null) {
                                        matchedGroupName = group.getName();
                                    }
                                    log.debug("Found group by ID - id: {}, name: {}", matchedGroupId, matchedGroupName);
                                } else {
                                    log.debug("Group not found by ID: {}", filterValue);
                                }
                            } catch (Exception e) {
                                log.debug("Error finding group by ID: {}", e.getMessage());
                            }
                        }
                        
                        // Build criteria for friend group events
                        // Include events where friendGroupId matches OR friendGroupIds contains the ID OR visibility matches group name
                        // Also include user's own events with this friendGroupId (even if not a member)
                        java.util.List<Criteria> groupCriteriaList = new java.util.ArrayList<>();
                        
                            // Match by friendGroupId if we have it
                            if (matchedGroupId != null) {
                                groupCriteriaList.add(Criteria.where("friendGroupId").is(matchedGroupId));
                                log.debug("Added friendGroupId criteria: {}", matchedGroupId);
                                // Also check if matchedGroupId is in the friendGroupIds array
                                groupCriteriaList.add(Criteria.where("friendGroupIds").is(matchedGroupId));
                                log.debug("Added friendGroupIds criteria for matchedGroupId: {}", matchedGroupId);
                            }
                            
                            // Also match by visibility matching the group name (for backward compatibility)
                            if (matchedGroupName != null) {
                                groupCriteriaList.add(Criteria.where("visibility").is(matchedGroupName));
                                log.debug("Added visibility criteria for group name: {}", matchedGroupName);
                            }
                            
                            // Also try direct match with filter value (in case events use the filter value directly)
                            groupCriteriaList.add(Criteria.where("friendGroupId").is(filterValue));
                            // Also check if filterValue is in the friendGroupIds array
                            groupCriteriaList.add(Criteria.where("friendGroupIds").is(filterValue));
                            groupCriteriaList.add(Criteria.where("visibility").is(filterValue));
                            log.debug("Added direct match criteria for filter value: {}", filterValue);
                            
                            if (groupCriteriaList.isEmpty()) {
                                // No valid criteria, return no match
                                log.debug("No group criteria found, returning no match");
                                return Criteria.where("_id").is("__NO_MATCH__");
                            }
                            
                            // Combine all group criteria with OR (match if any of them match)
                            Criteria groupCriteria = groupCriteriaList.size() == 1 
                                ? groupCriteriaList.get(0)
                                : new Criteria().orOperator(groupCriteriaList.toArray(new Criteria[0]));
                            
                            log.debug("Built friend group criteria for filter: {}, matchedGroupId: {}, matchedGroupName: {}", 
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
            log.debug("Built friends visibility criteria for user {} with {} friend IDs", 
                userId, friendIds.size());
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
            
            // CRITICAL FIX: Also get all friend groups where the user is the owner
            // The creator/owner is not automatically a member, so they need separate handling
            java.util.List<FriendGroup> ownedFriendGroups = friendGroupRepository.findByOwner(currentUser);
            
            // Get all friend groups where the user is authorized
            java.util.List<FriendGroup> authorizedFriendGroups = friendGroupRepository.findByAuthorizedUsersContaining(currentUser);
            
            // Build criteria list for events where user has access to the group
            java.util.List<Criteria> groupCriteriaList = new java.util.ArrayList<>();
            
            // Collect all friend group IDs where the user has access (member, owner, or authorized)
            java.util.Set<String> friendGroupIds = new java.util.HashSet<>();
            java.util.Map<String, String> groupIdToName = new java.util.HashMap<>();
            
            // Add groups where user is a member
            for (FriendGroup group : userFriendGroups) {
                if (group.getId() != null) {
                    friendGroupIds.add(group.getId());
                    if (group.getName() != null) {
                        groupIdToName.put(group.getId(), group.getName());
                    }
                }
            }
            
            // Add groups where user is the owner (CRITICAL FIX for the reported issue)
            for (FriendGroup group : ownedFriendGroups) {
                if (group.getId() != null) {
                    friendGroupIds.add(group.getId());
                    if (group.getName() != null) {
                        groupIdToName.put(group.getId(), group.getName());
                    }
                }
            }
            
            // Add groups where user is authorized
            for (FriendGroup group : authorizedFriendGroups) {
                if (group.getId() != null) {
                    friendGroupIds.add(group.getId());
                    if (group.getName() != null) {
                        groupIdToName.put(group.getId(), group.getName());
                    }
                }
            }
            
            // Match by friendGroupId (for backward compatibility with old format)
            for (String groupId : friendGroupIds) {
                try {
                    groupCriteriaList.add(Criteria.where("friendGroupId").is(groupId));
                } catch (Exception ex) {
                    // Skip invalid group ID
                }
            }
            
            // Match by friendGroupIds (new format - check if user is member of any group in the list)
            for (String groupId : friendGroupIds) {
                try {
                    // Check if event has this groupId in its friendGroupIds list
                    // MongoDB automatically searches in arrays when using .is()
                    groupCriteriaList.add(Criteria.where("friendGroupIds").is(groupId));
                } catch (Exception ex) {
                    // Skip invalid group ID
                }
            }
            
            // Also match by visibility matching the group name (for backward compatibility)
            for (String groupName : groupIdToName.values()) {
                if (groupName != null && !groupName.trim().isEmpty()) {
                    groupCriteriaList.add(Criteria.where("visibility").is(groupName));
                }
            }
            
            // CRITICAL FIX: Always include events created by the user with friend group visibility
            // regardless of whether the user is a member/owner/authorized of that group
            // This ensures user-created events are always visible when "all" is selected
            Criteria authorCriteria = buildAuthorCriteria(userId);
            Criteria userCreatedFriendGroupEvents = new Criteria().andOperator(
                Criteria.where("visibility").nin("public", "private", "friends"),
                authorCriteria
            );
            
            // Build final criteria list
            java.util.List<Criteria> finalCriteriaList = new java.util.ArrayList<>();
            
            // Add events where user has access to the group (member, owner, or authorized)
            if (!groupCriteriaList.isEmpty()) {
                Criteria groupMatch = groupCriteriaList.size() == 1
                    ? groupCriteriaList.get(0)
                    : new Criteria().orOperator(groupCriteriaList.toArray(new Criteria[0]));
                finalCriteriaList.add(
                    new Criteria().andOperator(
                        Criteria.where("visibility").nin("public", "private", "friends"),
                        groupMatch
                    )
                );
            }
            
            // Always add user's own events with friend group visibility
            finalCriteriaList.add(userCreatedFriendGroupEvents);
            
            if (finalCriteriaList.isEmpty()) {
                return null;
            }
            
            // Combine with OR: (has access to group) OR (user created with friend group visibility)
            return finalCriteriaList.size() == 1
                ? finalCriteriaList.get(0)
                : new Criteria().orOperator(finalCriteriaList.toArray(new Criteria[0]));
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
        Evenement evenement = evenementsRepository.findById(id).orElse(null);
        
        // Handle discussionId: if it exists but the discussion doesn't, create it (like for FriendGroup)
        if (evenement != null && evenement.getDiscussionId() != null && !evenement.getDiscussionId().trim().isEmpty()) {
            if (evenement.getAuthor() != null && evenement.getAuthor().getUserName() != null) {
                // Check if discussion exists
                com.pat.repo.domain.Discussion discussion = discussionService.getDiscussionById(evenement.getDiscussionId());
                if (discussion == null) {
                    // Discussion doesn't exist, create it and update the event
                    log.warn("Discussion {} for event {} does not exist, creating new one", evenement.getDiscussionId(), evenement.getEvenementName());
                    String discussionTitle = "Discussion - " + (evenement.getEvenementName() != null ? evenement.getEvenementName() : "Event");
                    String creatorUserName = evenement.getAuthor().getUserName();
                    com.pat.repo.domain.Discussion newDiscussion = discussionService.getOrCreateDiscussion(null, creatorUserName, discussionTitle);
                    
                    // Update the event with the new discussionId
                    evenement.setDiscussionId(newDiscussion.getId());
                    evenementsRepository.save(evenement);
                    log.info("Created discussion {} for event {} and updated event", newDiscussion.getId(), evenement.getEvenementName());
                }
            }
        }
        
        return evenement;
    }
    
    /**
     * Get all files for an event (loaded on-demand when user clicks file management button)
     * This endpoint is called separately to avoid loading all files in list queries
     * Uses MongoTemplate directly to ensure we get the complete document with all files
     */
    @RequestMapping(value = "/{id}/files", method = RequestMethod.GET)
    public ResponseEntity<List<FileUploaded>> getEventFiles(@PathVariable String id) {
        try {
            // Use repository to fetch the complete document from MongoDB
            // This ensures all fileUploadeds are properly loaded including DBRefs
            Evenement evenement = evenementsRepository.findById(id).orElse(null);
            
            if (evenement == null) {
                log.warn("Event not found for ID: {}", id);
                return ResponseEntity.notFound().build();
            }
            
            List<FileUploaded> files = evenement.getFileUploadeds();
            if (files == null) {
                files = new ArrayList<>();
            }
            
            // Always include thumbnail in files list if it exists and isn't already included
            if (evenement.getThumbnail() != null) {
                boolean thumbnailInList = files.stream()
                    .anyMatch(f -> f != null && f.getFieldId() != null && 
                        f.getFieldId().equals(evenement.getThumbnail().getFieldId()));
                if (!thumbnailInList) {
                    log.debug("Thumbnail not in fileUploadeds list, adding it for event {}", id);
                    files.add(evenement.getThumbnail());
                }
            }
            
            log.debug("Returning {} files for event {} (event exists: true, includes thumbnail: {})", 
                files.size(), id, evenement.getThumbnail() != null);
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
                // Fetch the complete event document to ensure fileUploadeds are properly loaded
                // Using findById instead of query with fields() to avoid potential DBRef loading issues
                Evenement evenement = evenementsRepository.findById(id).orElse(null);
                
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
                    log.debug("fileUploadeds is null for event {}, initializing empty list", id);
                } else {
                    log.debug("Found {} files for event {} (event exists: true)", files.size(), id);
                    if (files.isEmpty()) {
                        log.warn("Event {} exists but fileUploadeds array is empty. Event name: {}", id, evenement.getEvenementName());
                        
                        // Check if thumbnail exists - if fileUploadeds is empty but thumbnail exists,
                        // include the thumbnail in the files list
                        if (evenement.getThumbnail() != null) {
                            log.info("fileUploadeds is empty but thumbnail exists for event {}. Adding thumbnail to files list.", id);
                            files.add(evenement.getThumbnail());
                        }
                        
                        // Diagnostic: Check if files exist in GridFS
                        // This helps determine if files were uploaded but not linked to the event
                        try {
                            long gridFsFileCount = mongoTemplate.getCollection("fs.files").countDocuments();
                            log.debug("Diagnostic: GridFS contains {} total files", gridFsFileCount);
                        } catch (Exception e) {
                            log.debug("Could not check GridFS for diagnostic purposes", e);
                        }
                    }
                }
                
                // Always include thumbnail in files list if it exists and isn't already included
                if (evenement.getThumbnail() != null) {
                    boolean thumbnailInList = files.stream()
                        .anyMatch(f -> f != null && f.getFieldId() != null && 
                            f.getFieldId().equals(evenement.getThumbnail().getFieldId()));
                    if (!thumbnailInList) {
                        log.debug("Thumbnail not in fileUploadeds list, adding it for event {}", id);
                        files.add(evenement.getThumbnail());
                    }
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
    public ResponseEntity<?> addEvenement(@RequestBody Evenement evenement){

        // Check if event contains PHOTOFROMFS links and validate authorization
        // Only check if urlEvents is not null and not empty, and contains actual PHOTOFROMFS links
        if (evenement.getUrlEvents() != null && !evenement.getUrlEvents().isEmpty()) {
            boolean hasPhotoFromFs = evenement.getUrlEvents().stream()
                .filter(urlEvent -> urlEvent != null) // Filter out null entries
                .filter(urlEvent -> urlEvent.getTypeUrl() != null && !urlEvent.getTypeUrl().trim().isEmpty()) // Filter out entries with null/empty typeUrl
                .anyMatch(urlEvent -> "PHOTOFROMFS".equalsIgnoreCase(urlEvent.getTypeUrl().trim()));
            
            if (hasPhotoFromFs) {
                // Check if the user has FileSystem role
                if (!hasFileSystemRole()) {
                    log.warn("Unauthorized attempt to create PHOTOFROMFS link. User does not have FileSystem role.");
                    // Return error with specific message to differentiate from friend group error
                    java.util.Map<String, String> errorBody = new java.util.HashMap<>();
                    errorBody.put("error", "PHOTOFROMFS_UNAUTHORIZED");
                    errorBody.put("message", "You are not authorized to create events with 'Photo from File System' type links. Only the authorized user can create this type of link.");
                    return new ResponseEntity<java.util.Map<String, String>>(errorBody, HttpStatus.FORBIDDEN);
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
            // Check if user is owner or authorized user
            boolean isOwner = group.getOwner() != null && group.getOwner().getId().equals(evenement.getAuthor().getId());
            boolean isAuthorized = group.getAuthorizedUsers() != null && 
                group.getAuthorizedUsers().stream().anyMatch(u -> u != null && u.getId().equals(evenement.getAuthor().getId()));
            
            if (!isOwner && !isAuthorized) {
                log.warn("User {} attempted to use friend group {} owned by {} (not owner or authorized)", 
                    evenement.getAuthor().getId(), 
                    evenement.getFriendGroupId(),
                    group.getOwner() != null ? group.getOwner().getId() : "null");
                // Return error with specific message to differentiate from PHOTOFROMFS error
                java.util.Map<String, String> errorBody = new java.util.HashMap<>();
                errorBody.put("error", "FRIEND_GROUP_UNAUTHORIZED");
                errorBody.put("message", "You are not authorized to use this friend group. Only the owner or authorized users can use it.");
                return new ResponseEntity<java.util.Map<String, String>>(errorBody, HttpStatus.FORBIDDEN);
            }
        }
        
        // Validate friend group ownership if friendGroupIds is set (new format)
        if (evenement.getFriendGroupIds() != null && !evenement.getFriendGroupIds().isEmpty()) {
            if (evenement.getAuthor() == null || evenement.getAuthor().getId() == null) {
                log.warn("Cannot validate friend group ownership: author is null");
                return new ResponseEntity<>(HttpStatus.BAD_REQUEST);
            }
            
            for (String groupId : evenement.getFriendGroupIds()) {
                if (groupId == null || groupId.trim().isEmpty()) {
                    continue;
                }
                
                java.util.Optional<FriendGroup> groupOpt = friendGroupRepository.findById(groupId);
                if (groupOpt.isEmpty()) {
                    log.warn("Friend group not found: {}", groupId);
                    return new ResponseEntity<>(HttpStatus.BAD_REQUEST);
                }
                
                FriendGroup group = groupOpt.get();
                // Check if user is owner or authorized user
                boolean isOwner = group.getOwner() != null && group.getOwner().getId().equals(evenement.getAuthor().getId());
                boolean isAuthorized = group.getAuthorizedUsers() != null && 
                    group.getAuthorizedUsers().stream().anyMatch(u -> u != null && u.getId().equals(evenement.getAuthor().getId()));
                
                if (!isOwner && !isAuthorized) {
                    log.warn("User {} attempted to use friend group {} owned by {} (not owner or authorized)", 
                        evenement.getAuthor().getId(), 
                        groupId,
                        group.getOwner() != null ? group.getOwner().getId() : "null");
                    // Return error with specific message to differentiate from PHOTOFROMFS error
                    java.util.Map<String, String> errorBody = new java.util.HashMap<>();
                    errorBody.put("error", "FRIEND_GROUP_UNAUTHORIZED");
                    errorBody.put("message", "You are not authorized to use this friend group. Only the owner or authorized users can use it.");
                    return new ResponseEntity<java.util.Map<String, String>>(errorBody, HttpStatus.FORBIDDEN);
                }
            }
        }

        // Handle discussionId: if it exists but the discussion doesn't, create it (like for FriendGroup)
        if (evenement.getDiscussionId() != null && !evenement.getDiscussionId().trim().isEmpty()) {
            if (evenement.getAuthor() == null || evenement.getAuthor().getUserName() == null) {
                log.warn("Cannot create discussion: author is null or has no userName");
                return new ResponseEntity<>(HttpStatus.BAD_REQUEST);
            }
            
            // Check if discussion exists
            com.pat.repo.domain.Discussion discussion = discussionService.getDiscussionById(evenement.getDiscussionId());
            if (discussion == null) {
                // Discussion doesn't exist, create it and update the event
                log.warn("Discussion {} for event {} does not exist, creating new one", evenement.getDiscussionId(), evenement.getEvenementName());
                String discussionTitle = "Discussion - " + (evenement.getEvenementName() != null ? evenement.getEvenementName() : "Event");
                String creatorUserName = evenement.getAuthor().getUserName();
                com.pat.repo.domain.Discussion newDiscussion = discussionService.getOrCreateDiscussion(null, creatorUserName, discussionTitle);
                
                // Update the event with the new discussionId
                evenement.setDiscussionId(newDiscussion.getId());
                log.info("Created discussion {} for event {} and updated event", newDiscussion.getId(), evenement.getEvenementName());
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
    public ResponseEntity<?> updateEvenement(@RequestBody Evenement evenement){

        // CRITICAL: Preserve fileUploadeds if they're missing or empty in the request
        // This prevents accidentally clearing files when updating other event fields
        Evenement existingEvent = null;
        if (evenement.getId() != null) {
            existingEvent = evenementsRepository.findById(evenement.getId()).orElse(null);
            if (existingEvent != null) {
                // If request has no files or empty files, but existing event has files, preserve them
                if ((evenement.getFileUploadeds() == null || evenement.getFileUploadeds().isEmpty()) 
                    && existingEvent.getFileUploadeds() != null && !existingEvent.getFileUploadeds().isEmpty()) {
                    log.debug("Preserving {} existing files for event {} during update", 
                        existingEvent.getFileUploadeds().size(), evenement.getId());
                    evenement.setFileUploadeds(existingEvent.getFileUploadeds());
                }
                // Also preserve thumbnail if it's missing in the request
                if (evenement.getThumbnail() == null && existingEvent.getThumbnail() != null) {
                    evenement.setThumbnail(existingEvent.getThumbnail());
                }
                
                // Handle discussionId: allow explicit clearing when set to null or empty string
                // When discussionId is null or empty, it means we want to clear it (explicit clearing)
                // We don't preserve it anymore to allow clearing when discussion is deleted
                // If evenement.getDiscussionId() is not null and not empty, it will be saved as-is
                
                // Preserve original author to prevent ownership changes
                // This ensures that only the original owner can make changes
                if (existingEvent.getAuthor() != null) {
                    evenement.setAuthor(existingEvent.getAuthor());
                }
                
                // Validate ownership if status is being changed
                // Only the owner of the event should be able to change its status
                if (existingEvent.getStatus() != null && evenement.getStatus() != null 
                    && !existingEvent.getStatus().equals(evenement.getStatus())) {
                    // Status is being changed - verify ownership
                    if (existingEvent.getAuthor() == null) {
                        log.warn("Cannot validate status change ownership: existing author is null. Event ID: {}", evenement.getId());
                        return new ResponseEntity<>(HttpStatus.BAD_REQUEST);
                    }
                    
                    // Since we preserve the original author above, any status change attempt must come from
                    // a request that includes the correct author. The frontend validation ensures non-owners
                    // cannot trigger status changes, and this backend validation ensures the author is preserved.
                    // If someone tries to bypass the frontend and change both author and status, the author
                    // preservation will prevent the author change, maintaining ownership integrity.
                    log.debug("Status change validated for event {}: {} -> {} (author preserved: {})", 
                        evenement.getId(), existingEvent.getStatus(), evenement.getStatus(), 
                        existingEvent.getAuthor().getId());
                }
            }
        }

        // Check if event contains PHOTOFROMFS links and validate authorization
        if (evenement.getUrlEvents() != null && !evenement.getUrlEvents().isEmpty()) {
            boolean hasPhotoFromFs = evenement.getUrlEvents().stream()
                .filter(urlEvent -> urlEvent != null) // Filter out null entries
                .filter(urlEvent -> urlEvent.getTypeUrl() != null && !urlEvent.getTypeUrl().trim().isEmpty()) // Filter out entries with null/empty typeUrl
                .anyMatch(urlEvent -> "PHOTOFROMFS".equalsIgnoreCase(urlEvent.getTypeUrl().trim()));
            
            if (hasPhotoFromFs) {
                // Check if the user has FileSystem role
                if (!hasFileSystemRole()) {
                    log.warn("Unauthorized attempt to update PHOTOFROMFS link. User does not have FileSystem role.");
                    // Return error with specific message to differentiate from friend group error
                    java.util.Map<String, String> errorBody = new java.util.HashMap<>();
                    errorBody.put("error", "PHOTOFROMFS_UNAUTHORIZED");
                    errorBody.put("message", "You are not authorized to update events with 'Photo from File System' type links. Only the authorized user can modify this type of link.");
                    return new ResponseEntity<java.util.Map<String, String>>(errorBody, HttpStatus.FORBIDDEN);
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
            // Check if user is owner or authorized user
            boolean isOwner = group.getOwner() != null && group.getOwner().getId().equals(evenement.getAuthor().getId());
            boolean isAuthorized = group.getAuthorizedUsers() != null && 
                group.getAuthorizedUsers().stream().anyMatch(u -> u != null && u.getId().equals(evenement.getAuthor().getId()));
            
            if (!isOwner && !isAuthorized) {
                log.warn("User {} attempted to use friend group {} owned by {} (not owner or authorized)",
                    evenement.getAuthor().getId(), 
                    evenement.getFriendGroupId(),
                    group.getOwner() != null ? group.getOwner().getId() : "null");
                return new ResponseEntity<>(HttpStatus.FORBIDDEN);
            }
        }

        // Handle discussionId: if it exists but the discussion doesn't, create it (like for FriendGroup)
        if (evenement.getDiscussionId() != null && !evenement.getDiscussionId().trim().isEmpty()) {
            if (evenement.getAuthor() == null || evenement.getAuthor().getUserName() == null) {
                log.warn("Cannot create discussion: author is null or has no userName");
                return new ResponseEntity<>(HttpStatus.BAD_REQUEST);
            }
            
            // Check if discussion exists
            com.pat.repo.domain.Discussion discussion = discussionService.getDiscussionById(evenement.getDiscussionId());
            if (discussion == null) {
                // Discussion doesn't exist, create it and update the event
                log.warn("Discussion {} for event {} does not exist, creating new one", evenement.getDiscussionId(), evenement.getEvenementName());
                String discussionTitle = "Discussion - " + (evenement.getEvenementName() != null ? evenement.getEvenementName() : "Event");
                String creatorUserName = evenement.getAuthor().getUserName();
                com.pat.repo.domain.Discussion newDiscussion = discussionService.getOrCreateDiscussion(null, creatorUserName, discussionTitle);
                
                // Update the event with the new discussionId
                evenement.setDiscussionId(newDiscussion.getId());
                log.info("Created discussion {} for event {} and updated event", newDiscussion.getId(), evenement.getEvenementName());
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

        log.info("=== STARTING DELETION OF EVENT {} ===", id);
        
        // Retrieve the event first to get associated files
        Evenement evenement = evenementsRepository.findById(id).orElse(null);
        
        if (evenement == null) {
            log.warn("Event {} not found, cannot delete", id);
            return new ResponseEntity<>(HttpStatus.NOT_FOUND);
        }
        
        log.info("Event found: {} - '{}'", id, evenement.getEvenementName());
        
        // Count embedded objects
        int urlEventsCount = (evenement.getUrlEvents() != null) ? evenement.getUrlEvents().size() : 0;
        int commentariesCount = (evenement.getCommentaries() != null) ? evenement.getCommentaries().size() : 0;
        int membersCount = (evenement.getMembers() != null) ? evenement.getMembers().size() : 0;
        
        log.info("Event contains: {} URL event(s), {} commentarie(s), {} member reference(s)", 
                 urlEventsCount, commentariesCount, membersCount);
        
        // Delete all associated files from GridFS
        int deletedFilesCount = 0;
        if (evenement.getFileUploadeds() != null && !evenement.getFileUploadeds().isEmpty()) {
            log.info("Deleting {} file(s) from GridFS", evenement.getFileUploadeds().size());
            for (var fileUploaded : evenement.getFileUploadeds()) {
                try {
                    ObjectId fileObjectId = new ObjectId(fileUploaded.getFieldId());
                    gridFsTemplate.delete(new Query(Criteria.where("_id").is(fileObjectId)));
                    deletedFilesCount++;
                    log.info("✓ DELETED FILE from GridFS: {} (ID: {})", fileUploaded.getFileName(), fileUploaded.getFieldId());
                } catch (Exception e) {
                    log.error("✗ ERROR deleting file from GridFS: {} (ID: {})", fileUploaded.getFileName(), fileUploaded.getFieldId(), e);
                }
            }
            log.info("Successfully deleted {}/{} file(s) from GridFS", deletedFilesCount, evenement.getFileUploadeds().size());
        } else {
            log.info("No files to delete from GridFS");
        }
        
        // Delete associated discussion if it exists
        if (evenement.getDiscussionId() != null && !evenement.getDiscussionId().trim().isEmpty()) {
            String discussionId = evenement.getDiscussionId();
            log.info("Deleting associated discussion: {}", discussionId);
            try {
                // Check if discussion exists
                java.util.Optional<com.pat.repo.domain.Discussion> discussionOpt = discussionRepository.findById(discussionId);
                if (discussionOpt.isPresent()) {
                    com.pat.repo.domain.Discussion discussion = discussionOpt.get();
                    int messagesCount = (discussion.getMessages() != null) ? discussion.getMessages().size() : 0;
                    log.info("Discussion found: {} - '{}' with {} message(s)", discussionId, discussion.getTitle(), messagesCount);
                    
                    // Find all friend groups with this discussionId and remove it
                    java.util.List<com.pat.repo.domain.FriendGroup> friendGroups = friendGroupRepository.findByDiscussionId(discussionId);
                    if (friendGroups != null && !friendGroups.isEmpty()) {
                        log.info("Removing discussionId from {} friend group(s)", friendGroups.size());
                        for (com.pat.repo.domain.FriendGroup group : friendGroups) {
                            group.setDiscussionId(null);
                            friendGroupRepository.save(group);
                            log.info("✓ Removed discussionId {} from friend group {} ({})", discussionId, group.getId(), group.getName());
                        }
                    }
                    
                    // Find all user connection logs with this discussionId and remove it
                    java.util.List<com.pat.repo.domain.UserConnectionLog> connectionLogs = userConnectionLogRepository.findByDiscussionId(discussionId);
                    if (connectionLogs != null && !connectionLogs.isEmpty()) {
                        log.info("Removing discussionId from {} user connection log(s)", connectionLogs.size());
                        for (com.pat.repo.domain.UserConnectionLog logEntry : connectionLogs) {
                            logEntry.setDiscussionId(null);
                            logEntry.setDiscussionTitle(null);
                            userConnectionLogRepository.save(logEntry);
                            log.info("✓ Removed discussionId {} from user connection log {}", discussionId, logEntry.getId());
                        }
                    }
                    
                    // Delete the discussion (this will also delete all embedded messages)
                    discussionRepository.deleteById(discussionId);
                    log.info("✓ DELETED DISCUSSION: {} - '{}' (with {} embedded message(s))", discussionId, discussion.getTitle(), messagesCount);
                } else {
                    log.warn("Discussion {} not found (may have been already deleted)", discussionId);
                }
            } catch (Exception e) {
                log.error("✗ ERROR deleting discussion {} for event {}", discussionId, id, e);
                // Continue with event deletion even if discussion deletion fails
            }
        } else {
            log.info("No associated discussion to delete");
        }
        
        // Send deletion notification email to event owner and app.mailsentto
        sendEventDeletionEmail(evenement, deletedFilesCount, urlEventsCount, commentariesCount);
        
        // Delete the event (which also deletes embedded urlEvents and commentaries)
        log.info("Deleting event document: {} - '{}'", id, evenement.getEvenementName());
        log.info("This will also delete {} embedded URL event(s) and {} embedded commentarie(s)", urlEventsCount, commentariesCount);
        evenementsRepository.deleteById(id);
        log.info("✓ DELETED EVENT: {} - '{}'", id, evenement.getEvenementName());
        
        log.info("=== DELETION COMPLETE FOR EVENT {} ===", id);
        log.info("Summary: Event deleted, {} file(s) deleted from GridFS, {} URL event(s) deleted, {} commentarie(s) deleted", 
                 deletedFilesCount, urlEventsCount, commentariesCount);

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
    public ResponseEntity<?> addEvenementViaEvenements(@RequestBody Evenement evenement) {
        return addEvenement(evenement);
    }

    @RequestMapping(value = "/evenements/{id}", method = RequestMethod.PUT)
    public ResponseEntity<?> updateEvenementViaEvenements(@PathVariable String id, @RequestBody Evenement evenement) {
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
    /**
     * Get current user name from authentication token
     */
    private String getCurrentUserName() {
        try {
            Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
            if (authentication != null && authentication.getPrincipal() instanceof org.springframework.security.oauth2.jwt.Jwt) {
                org.springframework.security.oauth2.jwt.Jwt jwt = (org.springframework.security.oauth2.jwt.Jwt) authentication.getPrincipal();
                String keycloakId = jwt.getSubject();
                if (keycloakId != null) {
                    // Find member by keycloakId
                    List<Member> members = membersRepository.findAll();
                    java.util.Optional<Member> memberOpt = members.stream()
                            .filter(m -> keycloakId.equals(m.getKeycloakId()))
                            .findFirst();
                    if (memberOpt.isPresent()) {
                        return memberOpt.get().getUserName();
                    }
                }
            }
        } catch (Exception e) {
            log.debug("Error getting current user name: {}", e.getMessage());
        }
        return null;
    }

    /**
     * Add a commentary to an event
     * POST /api/even/{eventId}/commentaries
     */
    @RequestMapping(value = "/{eventId}/commentaries", method = RequestMethod.POST)
    public ResponseEntity<Evenement> addCommentary(@PathVariable String eventId, @RequestBody Commentary commentary) {
        try {
            Evenement evenement = evenementsRepository.findById(eventId).orElse(null);
            if (evenement == null) {
                return new ResponseEntity<>(HttpStatus.NOT_FOUND);
            }

            String currentUserName = getCurrentUserName();
            if (currentUserName == null) {
                return new ResponseEntity<>(HttpStatus.UNAUTHORIZED);
            }

            // Set the comment owner to current user
            commentary.setCommentOwner(currentUserName);
            commentary.setDateCreation(new Date());
            
            // Generate a unique ID for the commentary
            if (commentary.getId() == null || commentary.getId().isEmpty()) {
                commentary.setId(new ObjectId().toString());
            }

            // Initialize commentaries list if null
            if (evenement.getCommentaries() == null) {
                evenement.setCommentaries(new ArrayList<>());
            }

            // Add the commentary
            evenement.getCommentaries().add(commentary);
            Evenement savedEvent = evenementsRepository.save(evenement);

            return new ResponseEntity<>(savedEvent, HttpStatus.OK);
        } catch (Exception e) {
            log.error("Error adding commentary to event {}: {}", eventId, e.getMessage(), e);
            return new ResponseEntity<>(HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    /**
     * Update a commentary in an event
     * PUT /api/even/{eventId}/commentaries/{commentId}
     */
    @RequestMapping(value = "/{eventId}/commentaries/{commentId}", method = RequestMethod.PUT)
    public ResponseEntity<Evenement> updateCommentary(@PathVariable String eventId, 
                                                       @PathVariable String commentId, 
                                                       @RequestBody Commentary commentary) {
        try {
            Evenement evenement = evenementsRepository.findById(eventId).orElse(null);
            if (evenement == null) {
                return new ResponseEntity<>(HttpStatus.NOT_FOUND);
            }

            if (evenement.getCommentaries() == null) {
                return new ResponseEntity<>(HttpStatus.BAD_REQUEST);
            }

            // Find the commentary by ID
            Commentary existingCommentary = null;
            for (Commentary c : evenement.getCommentaries()) {
                if (c.getId() != null && c.getId().equals(commentId)) {
                    existingCommentary = c;
                    break;
                }
            }

            if (existingCommentary == null) {
                return new ResponseEntity<>(HttpStatus.NOT_FOUND);
            }

            String currentUserName = getCurrentUserName();
            
            // Only the owner can update their commentary
            if (currentUserName == null || !currentUserName.equals(existingCommentary.getCommentOwner())) {
                return new ResponseEntity<>(HttpStatus.FORBIDDEN);
            }

            // Update the commentary content
            existingCommentary.setCommentary(commentary.getCommentary());
            // Keep the original dateCreation, commentOwner, and id
            Evenement savedEvent = evenementsRepository.save(evenement);

            return new ResponseEntity<>(savedEvent, HttpStatus.OK);
        } catch (Exception e) {
            log.error("Error updating commentary in event {} with id {}: {}", eventId, commentId, e.getMessage(), e);
            return new ResponseEntity<>(HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    /**
     * Delete a commentary from an event
     * DELETE /api/even/{eventId}/commentaries/{commentId}
     */
    @RequestMapping(value = "/{eventId}/commentaries/{commentId}", method = RequestMethod.DELETE)
    public ResponseEntity<Evenement> deleteCommentary(@PathVariable String eventId, @PathVariable String commentId) {
        try {
            Evenement evenement = evenementsRepository.findById(eventId).orElse(null);
            if (evenement == null) {
                return new ResponseEntity<>(HttpStatus.NOT_FOUND);
            }

            if (evenement.getCommentaries() == null) {
                return new ResponseEntity<>(HttpStatus.BAD_REQUEST);
            }

            // Find the commentary by ID
            Commentary existingCommentary = null;
            int commentIndex = -1;
            for (int i = 0; i < evenement.getCommentaries().size(); i++) {
                Commentary c = evenement.getCommentaries().get(i);
                if (c.getId() != null && c.getId().equals(commentId)) {
                    existingCommentary = c;
                    commentIndex = i;
                    break;
                }
            }

            if (existingCommentary == null) {
                return new ResponseEntity<>(HttpStatus.NOT_FOUND);
            }

            String currentUserName = getCurrentUserName();
            
            // Only the owner can delete their commentary
            if (currentUserName == null || !currentUserName.equals(existingCommentary.getCommentOwner())) {
                return new ResponseEntity<>(HttpStatus.FORBIDDEN);
            }

            // Remove the commentary
            evenement.getCommentaries().remove(commentIndex);
            Evenement savedEvent = evenementsRepository.save(evenement);

            return new ResponseEntity<>(savedEvent, HttpStatus.OK);
        } catch (Exception e) {
            log.error("Error deleting commentary from event {} with id {}: {}", eventId, commentId, e.getMessage(), e);
            return new ResponseEntity<>(HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

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

    /**
     * Get current user ID from authentication token
     */
    private String getCurrentUserId() {
        try {
            Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
            if (authentication != null && authentication.getPrincipal() instanceof org.springframework.security.oauth2.jwt.Jwt) {
                org.springframework.security.oauth2.jwt.Jwt jwt = (org.springframework.security.oauth2.jwt.Jwt) authentication.getPrincipal();
                String keycloakId = jwt.getSubject();
                if (keycloakId != null) {
                    // Find member by keycloakId
                    List<Member> members = membersRepository.findAll();
                    Optional<Member> memberOpt = members.stream()
                            .filter(m -> keycloakId.equals(m.getKeycloakId()))
                            .findFirst();
                    if (memberOpt.isPresent()) {
                        return memberOpt.get().getId();
                    }
                }
            }
        } catch (Exception e) {
            log.debug("Error getting current user ID: {}", e.getMessage());
        }
        return null;
    }

    /**
     * Get users with access to an event
     * For admin: returns all users with access based on visibility
     * For non-admin: returns only users with access who are also friends of the current user
     * 
     * @param eventId The event ID
     * @return List of members with access to the event
     */
    @GetMapping(value = "/{eventId}/access-users", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<List<Member>> getEventAccessUsers(@PathVariable String eventId) {
        try {
            // Get event
            Optional<Evenement> eventOpt = evenementsRepository.findById(eventId);
            if (!eventOpt.isPresent()) {
                return ResponseEntity.notFound().build();
            }
            Evenement event = eventOpt.get();
            
            // Get current user
            String currentUserId = getCurrentUserId();
            if (currentUserId == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }
            
            Optional<Member> currentUserOpt = membersRepository.findById(currentUserId);
            if (!currentUserOpt.isPresent()) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }
            Member currentUser = currentUserOpt.get();
            
            // Check if admin
            boolean isAdmin = hasAdminRole();
            
            // Get visibility and normalize (trim and lowercase for comparison)
            String visibility = event.getVisibility() != null ? event.getVisibility().trim().toLowerCase() : "public";
            
            log.debug("Getting access users for event {} - Visibility: '{}' (normalized), IsAdmin: {}", eventId, visibility, isAdmin);
            
            List<Member> accessibleUsers = new ArrayList<>();
            
            // Handle each visibility type explicitly
            if ("private".equals(visibility)) {
                // Private: only author has access
                log.debug("Private visibility detected - IsAdmin: {}", isAdmin);
                if (event.getAuthor() != null) {
                    if (isAdmin) {
                        // Admin: return only the author
                        accessibleUsers.add(event.getAuthor());
                        log.debug("Admin - Returning author only: {}", event.getAuthor().getId());
                    } else {
                        // Non-admin: return author only if they are a friend
                        List<Friend> friendships = friendRepository.findByUser1OrUser2(currentUser, currentUser);
                        boolean isFriend = friendships.stream()
                            .anyMatch(f -> {
                                if (f == null) return false;
                                Member u1 = f.getUser1();
                                Member u2 = f.getUser2();
                                return (u1 != null && u1.getId().equals(event.getAuthor().getId())) ||
                                       (u2 != null && u2.getId().equals(event.getAuthor().getId()));
                            });
                        if (isFriend) {
                            accessibleUsers.add(event.getAuthor());
                            log.debug("Non-admin - Author is a friend, returning author");
                        } else {
                            log.debug("Non-admin - Author is not a friend, returning empty list");
                        }
                    }
                } else {
                    log.debug("Private visibility but no author found - returning empty list");
                }
            } else if ("friendgroups".equals(visibility)) {
                // Friend groups: get members from friend groups
                List<String> groupIds = event.getFriendGroupIds() != null ? 
                    event.getFriendGroupIds() : 
                    (event.getFriendGroupId() != null ? java.util.Arrays.asList(event.getFriendGroupId()) : new ArrayList<>());
                
                log.debug("FriendGroups visibility detected - Group IDs: {}, IsAdmin: {}", groupIds, isAdmin);
                
                if (!groupIds.isEmpty()) {
                    List<FriendGroup> groups = friendGroupRepository.findAllById(groupIds);
                    log.debug("Found {} friend groups", groups.size());
                    
                    List<Member> groupMembers = new ArrayList<>();
                    Set<String> seenMemberIds = new HashSet<>(); // To remove duplicates by ID
                    
                    for (FriendGroup group : groups) {
                        if (group != null && group.getMembers() != null) {
                            for (Member member : group.getMembers()) {
                                if (member != null && member.getId() != null && !seenMemberIds.contains(member.getId())) {
                                    seenMemberIds.add(member.getId());
                                    groupMembers.add(member);
                                }
                            }
                        }
                    }
                    
                    log.debug("Total unique members in friend groups: {}", groupMembers.size());
                    
                    if (isAdmin) {
                        // Admin: return all members of the friend groups
                        accessibleUsers = groupMembers;
                        log.debug("Admin - Returning {} members from friend groups", accessibleUsers.size());
                    } else {
                        // Non-admin: filter to only show friends
                        List<Friend> friendships = friendRepository.findByUser1OrUser2(currentUser, currentUser);
                        Set<String> friendIds = new HashSet<>();
                        for (Friend f : friendships) {
                            if (f != null) {
                                if (f.getUser1() != null && !f.getUser1().getId().equals(currentUserId)) {
                                    friendIds.add(f.getUser1().getId());
                                }
                                if (f.getUser2() != null && !f.getUser2().getId().equals(currentUserId)) {
                                    friendIds.add(f.getUser2().getId());
                                }
                            }
                        }
                        
                        log.debug("Non-admin - Found {} friends, filtering {} group members", friendIds.size(), groupMembers.size());
                        
                        accessibleUsers = groupMembers.stream()
                            .filter(m -> m != null && m.getId() != null && friendIds.contains(m.getId()))
                            .collect(Collectors.toList());
                        
                        log.debug("Non-admin - Returning {} members (friends in groups)", accessibleUsers.size());
                    }
                } else {
                    log.debug("FriendGroups visibility but no group IDs found - returning empty list");
                    accessibleUsers = new ArrayList<>(); // No groups, return empty
                }
            } else if ("friends".equals(visibility) || "friend".equals(visibility)) {
                // Friends: all friends of the author (admin) or all my friends (non-admin)
                log.debug("Friends visibility detected - IsAdmin: {}", isAdmin);
                if (isAdmin) {
                    // Admin: get all friends of the author
                    if (event.getAuthor() != null) {
                        List<Friend> authorFriendships = friendRepository.findByUser1OrUser2(event.getAuthor(), event.getAuthor());
                        Set<String> authorFriendIds = new HashSet<>();
                        for (Friend f : authorFriendships) {
                            if (f != null) {
                                if (f.getUser1() != null && !f.getUser1().getId().equals(event.getAuthor().getId())) {
                                    authorFriendIds.add(f.getUser1().getId());
                                }
                                if (f.getUser2() != null && !f.getUser2().getId().equals(event.getAuthor().getId())) {
                                    authorFriendIds.add(f.getUser2().getId());
                                }
                            }
                        }
                        if (!authorFriendIds.isEmpty()) {
                            accessibleUsers = new ArrayList<>();
                            for (String friendId : authorFriendIds) {
                                Optional<Member> memberOpt = membersRepository.findById(friendId);
                                if (memberOpt.isPresent()) {
                                    accessibleUsers.add(memberOpt.get());
                                }
                            }
                        }
                        log.debug("Admin - Returning {} friends of author", accessibleUsers.size());
                    } else {
                        log.debug("Admin - No author found, returning empty list");
                    }
                } else {
                    // Non-admin: get my friends
                    List<Friend> friendships = friendRepository.findByUser1OrUser2(currentUser, currentUser);
                    Set<String> friendIds = new HashSet<>();
                    for (Friend f : friendships) {
                        if (f != null) {
                            if (f.getUser1() != null && !f.getUser1().getId().equals(currentUserId)) {
                                friendIds.add(f.getUser1().getId());
                            }
                            if (f.getUser2() != null && !f.getUser2().getId().equals(currentUserId)) {
                                friendIds.add(f.getUser2().getId());
                            }
                        }
                    }
                    if (!friendIds.isEmpty()) {
                        accessibleUsers = new ArrayList<>();
                        for (String friendId : friendIds) {
                            Optional<Member> memberOpt = membersRepository.findById(friendId);
                            if (memberOpt.isPresent()) {
                                accessibleUsers.add(memberOpt.get());
                            }
                        }
                    }
                    log.debug("Non-admin - Returning {} of my friends", accessibleUsers.size());
                }
            } else if ("public".equals(visibility)) {
                // Public: all users (admin) or all my friends (non-admin)
                log.debug("Public visibility detected - IsAdmin: {}", isAdmin);
                if (isAdmin) {
                    accessibleUsers = membersRepository.findAll();
                    log.debug("Admin - Returning all {} users", accessibleUsers.size());
                } else {
                    // Non-admin: get my friends
                    List<Friend> friendships = friendRepository.findByUser1OrUser2(currentUser, currentUser);
                    Set<String> friendIds = new HashSet<>();
                    for (Friend f : friendships) {
                        if (f != null) {
                            if (f.getUser1() != null && !f.getUser1().getId().equals(currentUserId)) {
                                friendIds.add(f.getUser1().getId());
                            }
                            if (f.getUser2() != null && !f.getUser2().getId().equals(currentUserId)) {
                                friendIds.add(f.getUser2().getId());
                            }
                        }
                    }
                    if (!friendIds.isEmpty()) {
                        accessibleUsers = new ArrayList<>();
                        for (String friendId : friendIds) {
                            Optional<Member> memberOpt = membersRepository.findById(friendId);
                            if (memberOpt.isPresent()) {
                                accessibleUsers.add(memberOpt.get());
                            }
                        }
                    }
                    log.debug("Non-admin - Returning {} of my friends", accessibleUsers.size());
                }
            } else {
                // Check if visibility is a friend group name (for backward compatibility)
                // Some old events may have the group name as visibility instead of "friendGroups"
                log.debug("Visibility '{}' is not a standard type, checking if it's a friend group name", visibility);
                
                // Try to find a friend group by name (case-insensitive)
                List<FriendGroup> allGroups = friendGroupRepository.findAll();
                FriendGroup matchingGroup = null;
                for (FriendGroup group : allGroups) {
                    if (group != null && group.getName() != null && 
                        group.getName().trim().toLowerCase().equals(visibility)) {
                        matchingGroup = group;
                        break;
                    }
                }
                
                if (matchingGroup != null) {
                    log.debug("Found friend group '{}' matching visibility '{}'", matchingGroup.getName(), visibility);
                    
                    List<Member> groupMembers = new ArrayList<>();
                    if (matchingGroup.getMembers() != null) {
                        Set<String> seenMemberIds = new HashSet<>();
                        for (Member member : matchingGroup.getMembers()) {
                            if (member != null && member.getId() != null && !seenMemberIds.contains(member.getId())) {
                                seenMemberIds.add(member.getId());
                                groupMembers.add(member);
                            }
                        }
                    }
                    
                    if (isAdmin) {
                        // Admin: return all members of the friend group
                        accessibleUsers = groupMembers;
                        log.debug("Admin - Returning {} members from friend group '{}'", accessibleUsers.size(), matchingGroup.getName());
                    } else {
                        // Non-admin: filter to only show friends
                        List<Friend> friendships = friendRepository.findByUser1OrUser2(currentUser, currentUser);
                        Set<String> friendIds = new HashSet<>();
                        for (Friend f : friendships) {
                            if (f != null) {
                                if (f.getUser1() != null && !f.getUser1().getId().equals(currentUserId)) {
                                    friendIds.add(f.getUser1().getId());
                                }
                                if (f.getUser2() != null && !f.getUser2().getId().equals(currentUserId)) {
                                    friendIds.add(f.getUser2().getId());
                                }
                            }
                        }
                        
                        accessibleUsers = groupMembers.stream()
                            .filter(m -> m != null && m.getId() != null && friendIds.contains(m.getId()))
                            .collect(Collectors.toList());
                        
                        log.debug("Non-admin - Returning {} members (friends in group '{}')", accessibleUsers.size(), matchingGroup.getName());
                    }
                } else {
                    // Not a friend group name either - return empty list for safety
                    log.warn("Unknown visibility type: '{}' - not a standard type and not a friend group name. Returning empty list", visibility);
                    accessibleUsers = new ArrayList<>();
                }
            }
            
            log.debug("Returning {} accessible users for event {} (visibility: '{}', isAdmin: {})", 
                accessibleUsers.size(), eventId, visibility, isAdmin);
            return ResponseEntity.ok(accessibleUsers);
            
        } catch (Exception e) {
            log.error("Error getting event access users: {}", e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }
    
    /**
     * Send deletion notification email to event owner and app.mailsentto
     */
    private void sendEventDeletionEmail(Evenement evenement, int deletedFilesCount, int urlEventsCount, int commentariesCount) {
        try {
            if (evenement == null || evenement.getAuthor() == null) {
                log.debug("Cannot send deletion email - event or author is null");
                return;
            }
            
            Member author = evenement.getAuthor();
            String ownerEmail = author.getAddressEmail();
            
            if (ownerEmail == null || ownerEmail.trim().isEmpty()) {
                log.debug("Cannot send deletion email - owner email is empty");
                return;
            }
            
            if (!mailController.isValidEmail(ownerEmail)) {
                log.warn("Owner email address '{}' has invalid format, skipping deletion email", ownerEmail);
                return;
            }
            
            // Determine language based on author's locale (default to French)
            boolean isFrench = true;
            
            String authorLocale = author.getLocale();
            if (authorLocale != null && !authorLocale.toLowerCase().startsWith("fr")) {
                isFrench = false;
            }
            
            String subject;
            String body;
            if (isFrench) {
                subject = "Suppression de l'événement '" + evenement.getEvenementName() + "'";
                body = generateEventDeletionEmailHtml(evenement, author, deletedFilesCount, urlEventsCount, commentariesCount, true);
            } else {
                subject = "Event deletion: '" + evenement.getEvenementName() + "'";
                body = generateEventDeletionEmailHtml(evenement, author, deletedFilesCount, urlEventsCount, commentariesCount, false);
            }
            
            // Send email to owner with BCC to app.mailsentto
            mailController.sendMailToRecipient(ownerEmail, subject, body, true, null, mailController.getMailSentTo());
            log.info("Event deletion email sent to owner {} (BCC: {})", ownerEmail, mailController.getMailSentTo());
            
        } catch (Exception e) {
            log.error("Error sending event deletion email: {}", e.getMessage(), e);
            // Don't throw - continue with deletion even if email fails
        }
    }
    
    /**
     * Generate HTML email body for event deletion notification
     */
    private String generateEventDeletionEmailHtml(Evenement evenement, Member owner, int deletedFilesCount, int urlEventsCount, int commentariesCount, boolean isFrench) {
        String headerTitle = isFrench ? "Suppression d'événement" : "Event Deletion";
        String greeting = isFrench ? "Bonjour" : "Hello";
        String messageText = isFrench ? 
            "Nous vous informons que l'événement suivant a été supprimé de PATTOOL :" : 
            "We inform you that the following event has been deleted from PATTOOL:";
        String eventInfo = isFrench ? "Événement supprimé:" : "Deleted event:";
        String deletedItems = isFrench ? "Éléments supprimés:" : "Deleted items:";
        String filesDeleted = isFrench ? "Fichiers supprimés:" : "Files deleted:";
        String linksDeleted = isFrench ? "Liens supprimés:" : "Links deleted:";
        String commentsDeleted = isFrench ? "Commentaires supprimés:" : "Comments deleted:";
        String footerText1 = isFrench ? 
            "Cet email a été envoyé automatiquement par PATTOOL." : 
            "This email was automatically sent by PATTOOL.";
        String footerText2 = isFrench ?
            "Vous recevez cet email car vous êtes le propriétaire de cet événement." : 
            "You are receiving this email because you are the owner of this event.";
        
        StringBuilder bodyBuilder = new StringBuilder();
        bodyBuilder.append("<!DOCTYPE html><html><head><meta charset='UTF-8'>");
        bodyBuilder.append("<style>");
        bodyBuilder.append("body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 15px; line-height: 1.8; color: #2c3e50; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); margin: 0; padding: 20px; }");
        bodyBuilder.append(".container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); overflow: hidden; }");
        bodyBuilder.append(".header { background: linear-gradient(135deg, #dc3545 0%, #c82333 100%); color: white; padding: 25px; text-align: center; border-bottom: 4px solid #bd2130; }");
        bodyBuilder.append(".header h1 { margin: 0; font-size: 24px; font-weight: 700; text-shadow: 2px 2px 4px rgba(0,0,0,0.2); letter-spacing: 1px; }");
        bodyBuilder.append(".header-icon { font-size: 32px; margin-bottom: 10px; }");
        bodyBuilder.append(".content { padding: 30px; background: #fafafa; }");
        bodyBuilder.append(".message { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #dc3545; }");
        bodyBuilder.append(".event-info { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }");
        bodyBuilder.append(".event-info h3 { margin: 0 0 15px 0; color: #333; font-weight: 600; }");
        bodyBuilder.append(".info-item { margin: 10px 0; padding: 10px; background: #f8f9fa; border-radius: 6px; }");
        bodyBuilder.append(".info-label { font-weight: 700; color: #495057; margin-right: 10px; }");
        bodyBuilder.append(".info-value { color: #212529; }");
        bodyBuilder.append(".deleted-items { background: #fff3cd; padding: 20px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #ffc107; }");
        bodyBuilder.append(".deleted-items h3 { margin: 0 0 15px 0; color: #856404; font-weight: 600; }");
        bodyBuilder.append(".deleted-items ul { margin: 0; padding-left: 20px; }");
        bodyBuilder.append(".deleted-items li { margin: 8px 0; color: #856404; }");
        bodyBuilder.append(".footer { background: #e9ecef; padding: 20px; text-align: center; color: #6c757d; font-size: 12px; }");
        bodyBuilder.append("</style></head><body>");
        bodyBuilder.append("<div class='container'>");
        
        // Header
        bodyBuilder.append("<div class='header'>");
        bodyBuilder.append("<div class='header-icon'>🗑️</div>");
        bodyBuilder.append("<h1>").append(escapeHtml(headerTitle)).append("</h1>");
        bodyBuilder.append("</div>");
        
        // Content
        bodyBuilder.append("<div class='content'>");
        bodyBuilder.append("<div class='message'>");
        bodyBuilder.append("<p>").append(escapeHtml(greeting)).append(" ").append(escapeHtml(owner.getFirstName())).append(",</p>");
        bodyBuilder.append("<p>").append(escapeHtml(messageText)).append("</p>");
        bodyBuilder.append("</div>");
        
        // Event Information
        bodyBuilder.append("<div class='event-info'>");
        bodyBuilder.append("<h3>").append(escapeHtml(eventInfo)).append("</h3>");
        bodyBuilder.append("<div class='info-item'>");
        bodyBuilder.append("<span class='info-label'>").append(escapeHtml(isFrench ? "Nom:" : "Name:")).append("</span>");
        bodyBuilder.append("<span class='info-value'>").append(escapeHtml(evenement.getEvenementName())).append("</span>");
        bodyBuilder.append("</div>");
        if (evenement.getBeginEventDate() != null) {
            bodyBuilder.append("<div class='info-item'>");
            bodyBuilder.append("<span class='info-label'>").append(escapeHtml(isFrench ? "Date de début:" : "Start date:")).append("</span>");
            bodyBuilder.append("<span class='info-value'>").append(escapeHtml(evenement.getBeginEventDate().toString())).append("</span>");
            bodyBuilder.append("</div>");
        }
        bodyBuilder.append("</div>");
        
        // Deleted Items Summary
        bodyBuilder.append("<div class='deleted-items'>");
        bodyBuilder.append("<h3>").append(escapeHtml(deletedItems)).append("</h3>");
        bodyBuilder.append("<ul>");
        if (deletedFilesCount > 0) {
            bodyBuilder.append("<li>").append(escapeHtml(filesDeleted)).append(" ").append(deletedFilesCount).append("</li>");
        }
        if (urlEventsCount > 0) {
            bodyBuilder.append("<li>").append(escapeHtml(linksDeleted)).append(" ").append(urlEventsCount).append("</li>");
        }
        if (commentariesCount > 0) {
            bodyBuilder.append("<li>").append(escapeHtml(commentsDeleted)).append(" ").append(commentariesCount).append("</li>");
        }
        bodyBuilder.append("</ul>");
        bodyBuilder.append("</div>");
        
        bodyBuilder.append("</div>");
        
        // Footer
        bodyBuilder.append("<div class='footer'>");
        bodyBuilder.append("<p>").append(escapeHtml(footerText1)).append("</p>");
        bodyBuilder.append("<p>").append(escapeHtml(footerText2)).append("</p>");
        bodyBuilder.append("</div>");
        
        bodyBuilder.append("</div></body></html>");
        return bodyBuilder.toString();
    }
    
    /**
     * Escape HTML special characters
     */
    private String escapeHtml(String text) {
        if (text == null) {
            return "";
        }
        return text.replace("&", "&amp;")
                   .replace("<", "&lt;")
                   .replace(">", "&gt;")
                   .replace("\"", "&quot;")
                   .replace("'", "&#39;");
    }

}
