package com.pat.service;

import com.pat.repo.DiscussionRepository;
import com.pat.repo.EvenementsRepository;
import com.pat.repo.FriendGroupRepository;
import com.pat.repo.FriendRepository;
import com.pat.repo.MembersRepository;
import com.pat.repo.UserConnectionLogRepository;
import com.pat.repo.domain.Discussion;
import com.pat.repo.domain.DiscussionItemDTO;
import com.pat.repo.domain.DiscussionMessage;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.Friend;
import com.pat.repo.domain.DiscussionStatisticsDTO;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.Date;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;

/**
 * Service for managing discussions and messages
 */
@Service
public class DiscussionService {

    private static final Logger log = LoggerFactory.getLogger(DiscussionService.class);

    @Autowired
    private DiscussionRepository discussionRepository;

    @Autowired
    private MembersRepository membersRepository;

    @Autowired
    private EvenementsRepository evenementsRepository;

    @Autowired
    private FriendGroupRepository friendGroupRepository;

    @Autowired
    private UserConnectionLogRepository userConnectionLogRepository;

    @Autowired
    private FriendRepository friendRepository;

    @Value("${app.discussion.default.id:}")
    private String defaultDiscussionId;

    /**
     * Get all discussions ordered by creation date (newest first)
     */
    public List<Discussion> getAllDiscussions() {
        return discussionRepository.findAllByOrderByCreationDateDesc();
    }

    /**
     * Get the default discussion (Discussion Generale)
     * Uses the ID from application.properties, or falls back to the newest discussion
     */
    public Discussion getDefaultDiscussion() {
        if (defaultDiscussionId != null && !defaultDiscussionId.isEmpty()) {
            return discussionRepository.findById(defaultDiscussionId).orElse(null);
        }
        // Fallback: return the newest discussion
        List<Discussion> discussions = discussionRepository.findAllByOrderByCreationDateDesc();
        return discussions.isEmpty() ? null : discussions.get(0);
    }

    /**
     * Get a discussion by ID
     */
    public Discussion getDiscussionById(String id) {
        return discussionRepository.findById(id).orElse(null);
    }

    /**
     * Create a new discussion
     */
    public Discussion createDiscussion(String createdByUserName, String title) {
        Member creator = membersRepository.findByUserName(createdByUserName);
        if (creator == null) {
            throw new IllegalArgumentException("Member not found: " + createdByUserName);
        }

        Discussion discussion = new Discussion(creator, title);
        return discussionRepository.save(discussion);
    }

    /**
     * Add a message to a discussion
     */
    public DiscussionMessage addMessage(String discussionId, String authorUserName, String message, 
                                        String imageUrl, String imageFileName, 
                                        String videoUrl, String videoFileName) {
        Discussion discussion = discussionRepository.findById(discussionId)
                .orElseThrow(() -> new IllegalArgumentException("Discussion not found: " + discussionId));

        Member author = membersRepository.findByUserName(authorUserName);
        if (author == null) {
            throw new IllegalArgumentException("Member not found: " + authorUserName);
        }

        DiscussionMessage discussionMessage = new DiscussionMessage();
        discussionMessage.setId(UUID.randomUUID().toString());
        discussionMessage.setAuthor(author);
        discussionMessage.setDateTime(new Date());
        discussionMessage.setMessage(message);
        
        if (imageUrl != null && !imageUrl.isEmpty()) {
            discussionMessage.setImageUrl(imageUrl);
            discussionMessage.setImageFileName(imageFileName);
        }
        
        if (videoUrl != null && !videoUrl.isEmpty()) {
            discussionMessage.setVideoUrl(videoUrl);
            discussionMessage.setVideoFileName(videoFileName);
        }

        if (discussion.getMessages() == null) {
            discussion.setMessages(new java.util.ArrayList<>());
        }
        discussion.getMessages().add(discussionMessage);
        
        discussionRepository.save(discussion);
        
        log.debug("Message added to discussion {} by user {}", discussionId, authorUserName);
        return discussionMessage;
    }

    /**
     * Delete a message from a discussion
     */
    public boolean deleteMessage(String discussionId, String messageId, String userName) {
        Discussion discussion = discussionRepository.findById(discussionId)
                .orElseThrow(() -> new IllegalArgumentException("Discussion not found: " + discussionId));

        if (discussion.getMessages() == null) {
            return false;
        }

        DiscussionMessage messageToDelete = discussion.getMessages().stream()
                .filter(msg -> msg.getId().equals(messageId))
                .findFirst()
                .orElse(null);

        if (messageToDelete == null) {
            return false;
        }

        // Only allow deletion if the user is the author
        if (messageToDelete.getAuthor() != null && 
            messageToDelete.getAuthor().getUserName().equals(userName)) {
            discussion.getMessages().remove(messageToDelete);
            discussionRepository.save(discussion);
            log.debug("Message {} deleted from discussion {} by user {}", messageId, discussionId, userName);
            return true;
        }

        return false;
    }

    /**
     * Update a message in a discussion
     */
    public DiscussionMessage updateMessage(String discussionId, String messageId, String newMessage, String userName) {
        Discussion discussion = discussionRepository.findById(discussionId)
                .orElseThrow(() -> new IllegalArgumentException("Discussion not found: " + discussionId));

        if (discussion.getMessages() == null) {
            throw new IllegalArgumentException("No messages in discussion");
        }

        DiscussionMessage messageToUpdate = discussion.getMessages().stream()
                .filter(msg -> msg.getId().equals(messageId))
                .findFirst()
                .orElse(null);

        if (messageToUpdate == null) {
            throw new IllegalArgumentException("Message not found: " + messageId);
        }

        // Only allow update if the user is the author
        if (messageToUpdate.getAuthor() != null && 
            messageToUpdate.getAuthor().getUserName().equals(userName)) {
            messageToUpdate.setMessage(newMessage);
            discussionRepository.save(discussion);
            log.info("Message {} updated in discussion {} by user {}", messageId, discussionId, userName);
            return messageToUpdate;
        }

        throw new SecurityException("User not authorized to update this message");
    }

    /**
     * Get all messages for a discussion
     * If the discussion doesn't exist, try to find the associated event and create the discussion
     */
    public List<DiscussionMessage> getMessages(String discussionId) {
        Discussion discussion = discussionRepository.findById(discussionId).orElse(null);
        
        if (discussion == null) {
            // Discussion doesn't exist, try to find associated event or friend group and create it
            log.warn("Discussion {} does not exist, attempting to find associated event or friend group and create discussion", discussionId);
            
            // First, try to find an associated event
            java.util.Optional<com.pat.repo.domain.Evenement> eventOpt = evenementsRepository.findByDiscussionId(discussionId);
            if (eventOpt.isPresent()) {
                com.pat.repo.domain.Evenement event = eventOpt.get();
                if (event.getAuthor() != null && event.getAuthor().getUserName() != null) {
                    String discussionTitle = "Discussion - " + (event.getEvenementName() != null ? event.getEvenementName() : "Event");
                    String creatorUserName = event.getAuthor().getUserName();
                    Discussion newDiscussion = createDiscussion(creatorUserName, discussionTitle);
                    
                    // Update the event with the new discussionId
                    event.setDiscussionId(newDiscussion.getId());
                    evenementsRepository.save(event);
                    
                    log.info("Created discussion {} for event {} and updated event", newDiscussion.getId(), event.getEvenementName());
                    discussion = newDiscussion;
                } else {
                    throw new IllegalArgumentException("Cannot create discussion: event author is null or has no userName");
                }
            } else {
                // If no event found, try to find an associated friend group
                List<com.pat.repo.domain.FriendGroup> friendGroups = friendGroupRepository.findByDiscussionId(discussionId);
                if (friendGroups != null && !friendGroups.isEmpty()) {
                    com.pat.repo.domain.FriendGroup group = friendGroups.get(0); // Use the first one found
                    if (group.getOwner() != null && group.getOwner().getUserName() != null) {
                        String discussionTitle = "Discussion - " + (group.getName() != null ? group.getName() : "Friend Group");
                        String creatorUserName = group.getOwner().getUserName();
                        Discussion newDiscussion = createDiscussion(creatorUserName, discussionTitle);
                        
                        // Update the friend group with the new discussionId
                        group.setDiscussionId(newDiscussion.getId());
                        friendGroupRepository.save(group);
                        
                        log.info("Created discussion {} for friend group {} and updated friend group", newDiscussion.getId(), group.getName());
                        discussion = newDiscussion;
                    } else {
                        throw new IllegalArgumentException("Cannot create discussion: friend group owner is null or has no userName");
                    }
                } else {
                    throw new IllegalArgumentException("Discussion not found: " + discussionId + " and no associated event or friend group found");
                }
            }
        }
        
        return discussion.getMessages() != null ? discussion.getMessages() : new java.util.ArrayList<>();
    }

    /**
     * Delete a discussion
     * Only the creator can delete the discussion
     * Also removes the discussionId from all associated events and friend groups
     */
    public boolean deleteDiscussion(String discussionId, String userName) {
        Discussion discussion = discussionRepository.findById(discussionId)
                .orElseThrow(() -> new IllegalArgumentException("Discussion not found: " + discussionId));

        // Only allow deletion if the user is the creator
        if (discussion.getCreatedBy() != null && 
            discussion.getCreatedBy().getUserName() != null &&
            discussion.getCreatedBy().getUserName().equals(userName)) {
            
            // Find all events with this discussionId and remove it
            List<com.pat.repo.domain.Evenement> events = evenementsRepository.findAllByDiscussionId(discussionId);
            if (events != null && !events.isEmpty()) {
                for (com.pat.repo.domain.Evenement event : events) {
                    event.setDiscussionId(null);
                    evenementsRepository.save(event);
                    log.debug("Removed discussionId {} from event {}", discussionId, event.getId());
                }
                log.debug("Updated {} event(s) to remove discussionId {}", events.size(), discussionId);
            }
            
            // Find all friend groups with this discussionId and remove it
            List<com.pat.repo.domain.FriendGroup> friendGroups = friendGroupRepository.findByDiscussionId(discussionId);
            if (friendGroups != null && !friendGroups.isEmpty()) {
                for (com.pat.repo.domain.FriendGroup group : friendGroups) {
                    group.setDiscussionId(null);
                    friendGroupRepository.save(group);
                    log.debug("Removed discussionId {} from friend group {}", discussionId, group.getId());
                }
                log.debug("Updated {} friend group(s) to remove discussionId {}", friendGroups.size(), discussionId);
            }
            
            // Find all user connection logs with this discussionId and remove it
            List<com.pat.repo.domain.UserConnectionLog> connectionLogs = userConnectionLogRepository.findByDiscussionId(discussionId);
            if (connectionLogs != null && !connectionLogs.isEmpty()) {
                for (com.pat.repo.domain.UserConnectionLog logEntry : connectionLogs) {
                    logEntry.setDiscussionId(null);
                    logEntry.setDiscussionTitle(null);
                    userConnectionLogRepository.save(logEntry);
                    log.debug("Removed discussionId {} from user connection log {}", discussionId, logEntry.getId());
                }
                log.debug("Updated {} user connection log(s) to remove discussionId {}", connectionLogs.size(), discussionId);
            }
            
            // Delete the discussion
            discussionRepository.delete(discussion);
            log.debug("Discussion {} deleted by user {}", discussionId, userName);
            return true;
        }

        throw new SecurityException("User not authorized to delete this discussion");
    }

    /**
     * Get or create a discussion
     * If discussionId is provided and exists, return it
     * If discussionId is provided but doesn't exist, create a new one
     * If discussionId is null, create a new one
     */
    public Discussion getOrCreateDiscussion(String discussionId, String createdByUserName, String title) {
        // If discussionId is provided, try to get it
        if (discussionId != null && !discussionId.trim().isEmpty()) {
            Discussion existingDiscussion = discussionRepository.findById(discussionId).orElse(null);
            if (existingDiscussion != null) {
                return existingDiscussion;
            }
            // Discussion doesn't exist, will create a new one below
            log.warn("Discussion {} does not exist, creating new one", discussionId);
        }
        
        // Create a new discussion
        return createDiscussion(createdByUserName, title);
    }

    /**
     * Get all accessible discussions for a user
     * Validates discussionIds in events and friend groups, creates missing discussions
     * Filters based on user visibility (events and friend groups)
     * Ignores discussions without associated event or friend group (except default/general discussion)
     * OPTIMIZED VERSION: Batch loads discussions to avoid N+1 query problem
     */
    public List<DiscussionItemDTO> getAccessibleDiscussions(Member user) {
        List<DiscussionItemDTO> result = new java.util.ArrayList<>();
        // Track discussion IDs already added to avoid duplicates
        java.util.Set<String> addedDiscussionIds = new java.util.HashSet<>();
        
        // Get user's friend groups for access checking
        List<com.pat.repo.domain.FriendGroup> userFriendGroups = friendGroupRepository.findByMembersContaining(user);
        List<com.pat.repo.domain.FriendGroup> userOwnedGroups = friendGroupRepository.findByOwner(user);
        List<com.pat.repo.domain.FriendGroup> userAuthorizedGroups = friendGroupRepository.findByAuthorizedUsersContaining(user);
        
        // Combine all accessible friend groups
        java.util.Map<String, com.pat.repo.domain.FriendGroup> accessibleGroupsMap = new java.util.HashMap<>();
        for (com.pat.repo.domain.FriendGroup group : userFriendGroups) {
            if (group.getId() != null) {
                accessibleGroupsMap.put(group.getId(), group);
            }
        }
        for (com.pat.repo.domain.FriendGroup group : userOwnedGroups) {
            if (group.getId() != null) {
                accessibleGroupsMap.put(group.getId(), group);
            }
        }
        for (com.pat.repo.domain.FriendGroup group : userAuthorizedGroups) {
            if (group.getId() != null && !accessibleGroupsMap.containsKey(group.getId())) {
                accessibleGroupsMap.put(group.getId(), group);
            }
        }
        
        // Get user's friends for event visibility checking
        List<Friend> friendships = friendRepository.findByUser1OrUser2(user, user);
        java.util.Set<String> friendIds = new java.util.HashSet<>();
        for (Friend friendship : friendships) {
            if (friendship.getUser1() != null && !friendship.getUser1().getId().equals(user.getId())) {
                friendIds.add(friendship.getUser1().getId());
            }
            if (friendship.getUser2() != null && !friendship.getUser2().getId().equals(user.getId())) {
                friendIds.add(friendship.getUser2().getId());
            }
        }
        
        // OPTIMIZATION: Get default discussion FIRST and add immediately (most important)
        // This ensures the default discussion appears instantly
        Discussion defaultDiscussion = getDefaultDiscussion();
        if (defaultDiscussion != null) {
            DiscussionItemDTO defaultItem = createDiscussionItemDTO(
                defaultDiscussion.getId(),
                defaultDiscussion.getTitle() != null ? defaultDiscussion.getTitle() : "Discussion Générale",
                "general",
                defaultDiscussion,
                null,
                null
            );
            result.add(defaultItem);
            addedDiscussionIds.add(defaultDiscussion.getId());
        }
        
        // OPTIMIZATION: Only query events/groups that have discussionId and user can access
        // This reduces the dataset significantly compared to loading everything
        java.util.Set<String> discussionIdsToLoad = new java.util.HashSet<>();
        java.util.Map<String, com.pat.repo.domain.Evenement> eventByDiscussionId = new java.util.HashMap<>();
        java.util.Map<String, com.pat.repo.domain.FriendGroup> groupByDiscussionId = new java.util.HashMap<>();
        
        // OPTIMIZATION: Query only events with discussionId (using MongoDB query)
        // We'll filter by discussionId != null, then check access
        // Note: MongoDB doesn't support "not null" queries directly, so we query all and filter
        // But we can optimize by checking user's own events first (most common case)
        List<com.pat.repo.domain.Evenement> userOwnEvents = evenementsRepository.findByAuthorId(user.getId());
        for (com.pat.repo.domain.Evenement event : userOwnEvents) {
            if (event.getDiscussionId() != null && !event.getDiscussionId().trim().isEmpty()) {
                discussionIdsToLoad.add(event.getDiscussionId());
                eventByDiscussionId.put(event.getDiscussionId(), event);
            }
        }
        
        // Then check public events and events from friends (smaller subset)
        // Query all events but only process those with discussionId
        List<com.pat.repo.domain.Evenement> allEvents = evenementsRepository.findAll();
        for (com.pat.repo.domain.Evenement event : allEvents) {
            // Skip if already processed or no discussionId
            if (event.getDiscussionId() == null || event.getDiscussionId().trim().isEmpty() 
                || eventByDiscussionId.containsKey(event.getDiscussionId())) {
                continue;
            }
            
            // Check if user can access this event
            if (canUserAccessEvent(event, user, friendIds, accessibleGroupsMap)) {
                discussionIdsToLoad.add(event.getDiscussionId());
                eventByDiscussionId.put(event.getDiscussionId(), event);
            }
        }
        
        // OPTIMIZATION: Query only friend groups user can access (already have these from earlier)
        // Process accessible groups that have discussionId
        for (com.pat.repo.domain.FriendGroup group : accessibleGroupsMap.values()) {
            if (group.getDiscussionId() != null && !group.getDiscussionId().trim().isEmpty()) {
                discussionIdsToLoad.add(group.getDiscussionId());
                groupByDiscussionId.put(group.getDiscussionId(), group);
            }
        }
        
        // OPTIMIZATION: Batch load all discussions at once (single query instead of N queries)
        // Use projection to exclude messages field for better performance (we'll calculate count/date separately)
        java.util.Map<String, Discussion> discussionMap = new java.util.HashMap<>();
        if (!discussionIdsToLoad.isEmpty()) {
            List<String> discussionIdList = new java.util.ArrayList<>(discussionIdsToLoad);
            // Load discussions - messages will be loaded but we'll optimize processing
            List<Discussion> discussions = (List<Discussion>) discussionRepository.findAllById(discussionIdList);
            for (Discussion discussion : discussions) {
                if (discussion != null && discussion.getId() != null) {
                    discussionMap.put(discussion.getId(), discussion);
                }
            }
        }
        
        // Process events - discussions are already loaded
        for (java.util.Map.Entry<String, com.pat.repo.domain.Evenement> entry : eventByDiscussionId.entrySet()) {
            String discussionId = entry.getKey();
            com.pat.repo.domain.Evenement event = entry.getValue();
            
            Discussion discussion = discussionMap.get(discussionId);
            if (discussion == null) {
                // Discussion doesn't exist, create it
                log.warn("Discussion {} for event {} does not exist, creating new one", discussionId, event.getEvenementName());
                String discussionTitle = "Discussion - " + (event.getEvenementName() != null ? event.getEvenementName() : "Event");
                String creatorUserName = event.getAuthor() != null && event.getAuthor().getUserName() != null 
                    ? event.getAuthor().getUserName() 
                    : user.getUserName();
                discussion = createDiscussion(creatorUserName, discussionTitle);
                
                // Update the event with the new discussionId
                event.setDiscussionId(discussion.getId());
                evenementsRepository.save(event);
                log.info("Created discussion {} for event {} and updated event", discussion.getId(), event.getEvenementName());
                
                // Add to map for later use
                discussionMap.put(discussion.getId(), discussion);
            }
            
            // Add to result
            DiscussionItemDTO item = createDiscussionItemDTO(
                discussion.getId(),
                "Discussion - " + (event.getEvenementName() != null ? event.getEvenementName() : "Event"),
                "event",
                discussion,
                event,
                null
            );
            result.add(item);
            addedDiscussionIds.add(discussion.getId());
        }
        
        // Process friend groups - discussions are already loaded
        for (java.util.Map.Entry<String, com.pat.repo.domain.FriendGroup> entry : groupByDiscussionId.entrySet()) {
            String discussionId = entry.getKey();
            com.pat.repo.domain.FriendGroup group = entry.getValue();
            
            // Skip if already added (avoid duplicates)
            if (addedDiscussionIds.contains(discussionId)) {
                continue;
            }
            
            Discussion discussion = discussionMap.get(discussionId);
            if (discussion == null) {
                // Discussion doesn't exist, create it
                log.warn("Discussion {} for group {} does not exist, creating new one", discussionId, group.getName());
                String discussionTitle = "Discussion - " + (group.getName() != null ? group.getName() : "Friend Group");
                String creatorUserName = group.getOwner() != null && group.getOwner().getUserName() != null 
                    ? group.getOwner().getUserName() 
                    : user.getUserName();
                discussion = createDiscussion(creatorUserName, discussionTitle);
                
                // Update the group with the new discussionId
                group.setDiscussionId(discussion.getId());
                friendGroupRepository.save(group);
                log.info("Created discussion {} for friend group {} and updated group", discussion.getId(), group.getName());
                
                // Add to map for later use
                discussionMap.put(discussion.getId(), discussion);
            }
            
            // Add to result
            DiscussionItemDTO item = createDiscussionItemDTO(
                discussion.getId(),
                "Discussion - " + (group.getName() != null ? group.getName() : "Friend Group"),
                "friendGroup",
                discussion,
                null,
                group
            );
            result.add(item);
            addedDiscussionIds.add(discussion.getId());
        }
        
        return result;
    }
    
    /**
     * Stream accessible discussions for a user (reactive - sends as soon as available)
     * Processes and sends discussions one by one via callback
     */
    public void streamAccessibleDiscussions(Member user, Consumer<DiscussionItemDTO> onDiscussion) {
        // Track discussion IDs already added to avoid duplicates
        java.util.Set<String> addedDiscussionIds = new java.util.HashSet<>();
        
        // Get user's friend groups for access checking
        List<com.pat.repo.domain.FriendGroup> userFriendGroups = friendGroupRepository.findByMembersContaining(user);
        List<com.pat.repo.domain.FriendGroup> userOwnedGroups = friendGroupRepository.findByOwner(user);
        List<com.pat.repo.domain.FriendGroup> userAuthorizedGroups = friendGroupRepository.findByAuthorizedUsersContaining(user);
        
        // Combine all accessible friend groups
        java.util.Map<String, com.pat.repo.domain.FriendGroup> accessibleGroupsMap = new java.util.HashMap<>();
        for (com.pat.repo.domain.FriendGroup group : userFriendGroups) {
            if (group.getId() != null) {
                accessibleGroupsMap.put(group.getId(), group);
            }
        }
        for (com.pat.repo.domain.FriendGroup group : userOwnedGroups) {
            if (group.getId() != null) {
                accessibleGroupsMap.put(group.getId(), group);
            }
        }
        for (com.pat.repo.domain.FriendGroup group : userAuthorizedGroups) {
            if (group.getId() != null && !accessibleGroupsMap.containsKey(group.getId())) {
                accessibleGroupsMap.put(group.getId(), group);
            }
        }
        
        // Get user's friends for event visibility checking
        List<Friend> friendships = friendRepository.findByUser1OrUser2(user, user);
        java.util.Set<String> friendIds = new java.util.HashSet<>();
        for (Friend friendship : friendships) {
            if (friendship.getUser1() != null && !friendship.getUser1().getId().equals(user.getId())) {
                friendIds.add(friendship.getUser1().getId());
            }
            if (friendship.getUser2() != null && !friendship.getUser2().getId().equals(user.getId())) {
                friendIds.add(friendship.getUser2().getId());
            }
        }
        
        // OPTIMIZATION: Send default discussion FIRST (most important, appears instantly)
        // Only send if it has messages
        Discussion defaultDiscussion = getDefaultDiscussion();
        if (defaultDiscussion != null) {
            // Check if discussion has messages before sending
            if (defaultDiscussion.getMessages() != null && !defaultDiscussion.getMessages().isEmpty()) {
                DiscussionItemDTO defaultItem = createDiscussionItemDTO(
                    defaultDiscussion.getId(),
                    defaultDiscussion.getTitle() != null ? defaultDiscussion.getTitle() : "Discussion Générale",
                    "general",
                    defaultDiscussion,
                    null,
                    null
                );
                onDiscussion.accept(defaultItem);
                addedDiscussionIds.add(defaultDiscussion.getId());
            }
        }
        
        // OPTIMIZATION: Collect all discussion IDs first, then batch load them
        java.util.Set<String> discussionIdsToLoad = new java.util.HashSet<>();
        java.util.Map<String, com.pat.repo.domain.Evenement> eventByDiscussionId = new java.util.HashMap<>();
        java.util.Map<String, com.pat.repo.domain.FriendGroup> groupByDiscussionId = new java.util.HashMap<>();
        
        // Process user's own events first (fastest path)
        List<com.pat.repo.domain.Evenement> userOwnEvents = evenementsRepository.findByAuthorId(user.getId());
        for (com.pat.repo.domain.Evenement event : userOwnEvents) {
            if (event.getDiscussionId() != null && !event.getDiscussionId().trim().isEmpty()) {
                discussionIdsToLoad.add(event.getDiscussionId());
                eventByDiscussionId.put(event.getDiscussionId(), event);
            }
        }
        
        // Then check public events and events from friends
        List<com.pat.repo.domain.Evenement> allEvents = evenementsRepository.findAll();
        for (com.pat.repo.domain.Evenement event : allEvents) {
            if (event.getDiscussionId() == null || event.getDiscussionId().trim().isEmpty() 
                || eventByDiscussionId.containsKey(event.getDiscussionId())) {
                continue;
            }
            
            if (canUserAccessEvent(event, user, friendIds, accessibleGroupsMap)) {
                discussionIdsToLoad.add(event.getDiscussionId());
                eventByDiscussionId.put(event.getDiscussionId(), event);
            }
        }
        
        // Process accessible friend groups
        for (com.pat.repo.domain.FriendGroup group : accessibleGroupsMap.values()) {
            if (group.getDiscussionId() != null && !group.getDiscussionId().trim().isEmpty()) {
                discussionIdsToLoad.add(group.getDiscussionId());
                groupByDiscussionId.put(group.getDiscussionId(), group);
            }
        }
        
        // OPTIMIZATION: Batch load all discussions at once
        java.util.Map<String, Discussion> discussionMap = new java.util.HashMap<>();
        if (!discussionIdsToLoad.isEmpty()) {
            List<String> discussionIdList = new java.util.ArrayList<>(discussionIdsToLoad);
            List<Discussion> discussions = (List<Discussion>) discussionRepository.findAllById(discussionIdList);
            for (Discussion discussion : discussions) {
                if (discussion != null && discussion.getId() != null) {
                    discussionMap.put(discussion.getId(), discussion);
                }
            }
        }
        
        // Process events - send immediately as processed
        for (java.util.Map.Entry<String, com.pat.repo.domain.Evenement> entry : eventByDiscussionId.entrySet()) {
            String discussionId = entry.getKey();
            com.pat.repo.domain.Evenement event = entry.getValue();
            
            Discussion discussion = discussionMap.get(discussionId);
            if (discussion == null) {
                log.warn("Discussion {} for event {} does not exist, creating new one", discussionId, event.getEvenementName());
                String discussionTitle = "Discussion - " + (event.getEvenementName() != null ? event.getEvenementName() : "Event");
                String creatorUserName = event.getAuthor() != null && event.getAuthor().getUserName() != null 
                    ? event.getAuthor().getUserName() 
                    : user.getUserName();
                discussion = createDiscussion(creatorUserName, discussionTitle);
                event.setDiscussionId(discussion.getId());
                evenementsRepository.save(event);
                discussionMap.put(discussion.getId(), discussion);
            }
            
            // Only send discussion if it has messages
            if (discussion.getMessages() != null && !discussion.getMessages().isEmpty()) {
                DiscussionItemDTO item = createDiscussionItemDTO(
                    discussion.getId(),
                    "Discussion - " + (event.getEvenementName() != null ? event.getEvenementName() : "Event"),
                    "event",
                    discussion,
                    event,
                    null
                );
                onDiscussion.accept(item); // Send immediately
                addedDiscussionIds.add(discussion.getId());
            }
        }
        
        // Process friend groups - send immediately as processed
        for (java.util.Map.Entry<String, com.pat.repo.domain.FriendGroup> entry : groupByDiscussionId.entrySet()) {
            String discussionId = entry.getKey();
            com.pat.repo.domain.FriendGroup group = entry.getValue();
            
            if (addedDiscussionIds.contains(discussionId)) {
                continue;
            }
            
            Discussion discussion = discussionMap.get(discussionId);
            if (discussion == null) {
                log.warn("Discussion {} for group {} does not exist, creating new one", discussionId, group.getName());
                String discussionTitle = "Discussion - " + (group.getName() != null ? group.getName() : "Friend Group");
                String creatorUserName = group.getOwner() != null && group.getOwner().getUserName() != null 
                    ? group.getOwner().getUserName() 
                    : user.getUserName();
                discussion = createDiscussion(creatorUserName, discussionTitle);
                group.setDiscussionId(discussion.getId());
                friendGroupRepository.save(group);
                discussionMap.put(discussion.getId(), discussion);
            }
            
            // Only send discussion if it has messages
            if (discussion.getMessages() != null && !discussion.getMessages().isEmpty()) {
                DiscussionItemDTO item = createDiscussionItemDTO(
                    discussion.getId(),
                    "Discussion - " + (group.getName() != null ? group.getName() : "Friend Group"),
                    "friendGroup",
                    discussion,
                    null,
                    group
                );
                onDiscussion.accept(item); // Send immediately
                addedDiscussionIds.add(discussion.getId());
            }
        }
    }
    
    /**
     * Helper method to create DiscussionItemDTO with optimized message count and date calculation
     * OPTIMIZED: Only processes messages if they exist, avoids unnecessary iterations
     */
    private DiscussionItemDTO createDiscussionItemDTO(
            String discussionId,
            String title,
            String type,
            Discussion discussion,
            com.pat.repo.domain.Evenement event,
            com.pat.repo.domain.FriendGroup friendGroup) {
        
        DiscussionItemDTO item = new DiscussionItemDTO(discussionId, title, type, discussion);
        
        if (event != null) {
            item.setEvent(event);
        }
        if (friendGroup != null) {
            item.setFriendGroup(friendGroup);
        }
        
        // OPTIMIZATION: Calculate message count and last message date efficiently
        // Only process if messages exist and are loaded
        java.util.List<DiscussionMessage> messages = discussion.getMessages();
        if (messages != null && !messages.isEmpty()) {
            item.setMessageCount((long) messages.size());
            
            // Find last message date efficiently (single pass, skip null dates)
            Date lastMessageDate = null;
            for (DiscussionMessage message : messages) {
                Date msgDate = message.getDateTime();
                if (msgDate != null) {
                    if (lastMessageDate == null || msgDate.after(lastMessageDate)) {
                        lastMessageDate = msgDate;
                    }
                }
            }
            item.setLastMessageDate(lastMessageDate);
        } else {
            item.setMessageCount(0L);
            item.setLastMessageDate(null);
        }
        
        return item;
    }
    
    /**
     * Check if user can access an event based on visibility rules
     * Creators (authors) can always see their own events regardless of visibility
     * Public events are accessible to everyone (even without user authentication)
     */
    private boolean canUserAccessEvent(com.pat.repo.domain.Evenement event, Member user, 
                                      java.util.Set<String> friendIds, 
                                      java.util.Map<String, com.pat.repo.domain.FriendGroup> accessibleGroups) {
        if (event == null) {
            return false;
        }
        
        String visibility = event.getVisibility();
        
        // Public events are accessible to everyone (even if user is null)
        if (visibility == null || "public".equals(visibility)) {
            return true;
        }
        
        // For non-public events, user must be provided
        if (user == null) {
            return false;
        }
        
        // Creators (authors) can always see their own events
        if (event.getAuthor() != null && event.getAuthor().getId() != null 
            && event.getAuthor().getId().equals(user.getId())) {
            return true;
        }
        
        // Private events: only author can see (already handled above)
        if ("private".equals(visibility)) {
            return false;
        }
        
        // Friends visibility: author must be a friend
        if ("friends".equals(visibility)) {
            if (event.getAuthor() == null || event.getAuthor().getId() == null) {
                return false;
            }
            return friendIds.contains(event.getAuthor().getId());
        }
        
        // Friend group visibility: user must be in the friend group (as member, owner, or authorized)
        if (event.getFriendGroupId() != null && !event.getFriendGroupId().trim().isEmpty()) {
            // First check if already in accessible groups map
            if (accessibleGroups.containsKey(event.getFriendGroupId())) {
                return true;
            }
            // If not in map, directly check the group to ensure we check members and authorizedUsers
            java.util.Optional<com.pat.repo.domain.FriendGroup> groupOpt = friendGroupRepository.findById(event.getFriendGroupId());
            if (groupOpt.isPresent()) {
                com.pat.repo.domain.FriendGroup group = groupOpt.get();
                // Check if user is owner
                if (group.getOwner() != null && group.getOwner().getId() != null && user != null
                    && group.getOwner().getId().equals(user.getId())) {
                    return true;
                }
                // Check if user is a member
                if (group.getMembers() != null && user != null) {
                    for (Member member : group.getMembers()) {
                        if (member != null && member.getId() != null && member.getId().equals(user.getId())) {
                            return true;
                        }
                    }
                }
                // Check if user is authorized
                if (group.getAuthorizedUsers() != null && user != null) {
                    for (Member authorizedUser : group.getAuthorizedUsers()) {
                        if (authorizedUser != null && authorizedUser.getId() != null && authorizedUser.getId().equals(user.getId())) {
                            return true;
                        }
                    }
                }
            }
            return false;
        }
        
        // If visibility matches a friend group name (backward compatibility)
        // Check if any of the accessible groups have this name
        if (visibility != null && !"public".equals(visibility) && !"private".equals(visibility) && !"friends".equals(visibility)) {
            for (com.pat.repo.domain.FriendGroup group : accessibleGroups.values()) {
                if (group.getName() != null && group.getName().equals(visibility)) {
                    // User already has access to this group (it's in accessibleGroups)
                    return true;
                }
            }
        }
        
        return false;
    }
    
    /**
     * Check if user can access a friend group
     * User can access if they are owner, member, or authorized user
     */
    private boolean canUserAccessFriendGroup(com.pat.repo.domain.FriendGroup group, Member user) {
        if (group == null || user == null) {
            return false;
        }
        
        // Check if user is owner
        if (group.getOwner() != null && group.getOwner().getId() != null 
            && group.getOwner().getId().equals(user.getId())) {
            return true;
        }
        
        // Check if user is a member
        if (group.getMembers() != null) {
            for (Member member : group.getMembers()) {
                if (member != null && member.getId() != null && member.getId().equals(user.getId())) {
                    return true;
                }
            }
        }
        
        // Check if user is authorized
        if (group.getAuthorizedUsers() != null) {
            for (Member authorizedUser : group.getAuthorizedUsers()) {
                if (authorizedUser != null && authorizedUser.getId() != null 
                    && authorizedUser.getId().equals(user.getId())) {
                    return true;
                }
            }
        }
        
        return false;
    }
    
    /**
     * Get discussion statistics for all users
     * Returns a list showing for each user: how many discussions they can see and why
     * Fully optimized version that pre-loads ALL data and processes in-memory
     * @param userId Optional filter to get statistics for a specific user only (null = all users)
     */
    public List<DiscussionStatisticsDTO> getDiscussionStatisticsForAllUsers(String userId) {
        List<DiscussionStatisticsDTO> result = new java.util.ArrayList<>();
        
        // Get all users or filter by userId if provided
        List<Member> allUsers;
        if (userId != null && !userId.trim().isEmpty()) {
            java.util.Optional<Member> userOpt = membersRepository.findById(userId);
            if (userOpt.isPresent()) {
                allUsers = java.util.Collections.singletonList(userOpt.get());
            } else {
                return result;
            }
        } else {
            allUsers = membersRepository.findAll();
        }
        
        // Pre-load ALL data once - this is the key optimization
        List<Discussion> allDiscussions = discussionRepository.findAll();
        List<com.pat.repo.domain.Evenement> allEvents = evenementsRepository.findAll();
        List<com.pat.repo.domain.FriendGroup> allFriendGroups = friendGroupRepository.findAll();
        List<Friend> allFriendships = friendRepository.findAll(); // Load all friendships at once
        
        // Build comprehensive maps for O(1) lookups
        java.util.Map<String, Discussion> discussionMap = new java.util.HashMap<>();
        for (Discussion d : allDiscussions) {
            if (d.getId() != null) {
                discussionMap.put(d.getId(), d);
            }
        }
        
        // Map: discussionId -> event
        java.util.Map<String, com.pat.repo.domain.Evenement> eventByDiscussionIdMap = new java.util.HashMap<>();
        // Map: eventId -> event
        java.util.Map<String, com.pat.repo.domain.Evenement> eventByIdMap = new java.util.HashMap<>();
        for (com.pat.repo.domain.Evenement e : allEvents) {
            if (e.getId() != null) {
                eventByIdMap.put(e.getId(), e);
            }
            if (e.getDiscussionId() != null) {
                eventByDiscussionIdMap.put(e.getDiscussionId(), e);
            }
        }
        
        // Map: discussionId -> friendGroup
        java.util.Map<String, com.pat.repo.domain.FriendGroup> friendGroupByDiscussionIdMap = new java.util.HashMap<>();
        // Map: groupId -> friendGroup
        java.util.Map<String, com.pat.repo.domain.FriendGroup> friendGroupByIdMap = new java.util.HashMap<>();
        for (com.pat.repo.domain.FriendGroup g : allFriendGroups) {
            if (g.getId() != null) {
                friendGroupByIdMap.put(g.getId(), g);
            }
            if (g.getDiscussionId() != null) {
                friendGroupByDiscussionIdMap.put(g.getDiscussionId(), g);
            }
        }
        
        // Build user -> friends map (bidirectional)
        java.util.Map<String, java.util.Set<String>> userFriendsMap = new java.util.HashMap<>();
        for (Member user : allUsers) {
            if (user != null && user.getId() != null) {
                userFriendsMap.put(user.getId(), new java.util.HashSet<>());
            }
        }
        for (Friend friendship : allFriendships) {
            if (friendship.getUser1() != null && friendship.getUser2() != null) {
                String id1 = friendship.getUser1().getId();
                String id2 = friendship.getUser2().getId();
                if (id1 != null && id2 != null) {
                    userFriendsMap.computeIfAbsent(id1, k -> new java.util.HashSet<>()).add(id2);
                    userFriendsMap.computeIfAbsent(id2, k -> new java.util.HashSet<>()).add(id1);
                }
            }
        }
        
        // Build user -> accessible groups map (member, owner, authorized)
        java.util.Map<String, java.util.Map<String, com.pat.repo.domain.FriendGroup>> userAccessibleGroupsMap = new java.util.HashMap<>();
        for (Member user : allUsers) {
            if (user != null && user.getId() != null) {
                userAccessibleGroupsMap.put(user.getId(), new java.util.HashMap<>());
            }
        }
        // Process all groups once and build reverse indexes
        for (com.pat.repo.domain.FriendGroup group : allFriendGroups) {
            if (group.getId() == null) continue;
            
            // Check owner
            if (group.getOwner() != null && group.getOwner().getId() != null) {
                userAccessibleGroupsMap.computeIfAbsent(group.getOwner().getId(), k -> new java.util.HashMap<>())
                    .put(group.getId(), group);
            }
            
            // Check members
            if (group.getMembers() != null) {
                for (Member member : group.getMembers()) {
                    if (member != null && member.getId() != null) {
                        userAccessibleGroupsMap.computeIfAbsent(member.getId(), k -> new java.util.HashMap<>())
                            .put(group.getId(), group);
                    }
                }
            }
            
            // Check authorized users
            if (group.getAuthorizedUsers() != null) {
                for (Member authorized : group.getAuthorizedUsers()) {
                    if (authorized != null && authorized.getId() != null) {
                        userAccessibleGroupsMap.computeIfAbsent(authorized.getId(), k -> new java.util.HashMap<>())
                            .put(group.getId(), group);
                    }
                }
            }
        }
        
        // Get default discussion once
        Discussion defaultDiscussion = getDefaultDiscussion();
        
        // Process each user using pre-loaded data (NO database queries in loop)
        for (Member user : allUsers) {
            if (user == null || user.getId() == null) {
                continue;
            }
            
            String userIdStr = user.getId();
            java.util.Set<String> friendIds = userFriendsMap.getOrDefault(userIdStr, new java.util.HashSet<>());
            java.util.Map<String, com.pat.repo.domain.FriendGroup> accessibleGroups = userAccessibleGroupsMap.getOrDefault(userIdStr, new java.util.HashMap<>());
            
            // Build accessible discussions in-memory
            java.util.Set<String> addedDiscussionIds = new java.util.HashSet<>();
            List<DiscussionStatisticsDTO.DiscussionAccessInfo> accessInfoList = new java.util.ArrayList<>();
            
            // Add default discussion
            if (defaultDiscussion != null && defaultDiscussion.getId() != null) {
                DiscussionStatisticsDTO.DiscussionAccessInfo defaultInfo = new DiscussionStatisticsDTO.DiscussionAccessInfo(
                    defaultDiscussion.getId(),
                    defaultDiscussion.getTitle() != null ? defaultDiscussion.getTitle() : "Discussion Générale",
                    "general",
                    java.util.Arrays.asList("general")
                );
                accessInfoList.add(defaultInfo);
                addedDiscussionIds.add(defaultDiscussion.getId());
            }
            
            // Process events
            for (com.pat.repo.domain.Evenement event : allEvents) {
                if (event.getDiscussionId() == null || event.getDiscussionId().trim().isEmpty()) {
                    continue;
                }
                
                // Check access using pre-loaded data
                if (!canUserAccessEventOptimized(event, user, friendIds, accessibleGroups)) {
                    continue;
                }
                
                String discussionId = event.getDiscussionId();
                Discussion discussion = discussionMap.get(discussionId);
                if (discussion == null) {
                    // Discussion doesn't exist - skip for statistics (don't create here)
                    continue;
                }
                
                if (addedDiscussionIds.contains(discussionId)) {
                    continue;
                }
                
                List<String> accessReasons = determineAccessReasonsOptimized(
                    discussion, event, null, user, friendIds, accessibleGroups, null);
                
                DiscussionStatisticsDTO.DiscussionAccessInfo accessInfo = new DiscussionStatisticsDTO.DiscussionAccessInfo(
                    discussionId,
                    "Discussion - " + (event.getEvenementName() != null ? event.getEvenementName() : "Event"),
                    "event",
                    accessReasons
                );
                accessInfo.setEventName(event.getEvenementName());
                accessInfoList.add(accessInfo);
                addedDiscussionIds.add(discussionId);
            }
            
            // Process friend groups
            for (com.pat.repo.domain.FriendGroup group : allFriendGroups) {
                if (group.getDiscussionId() == null || group.getDiscussionId().trim().isEmpty()) {
                    continue;
                }
                
                // Check access using pre-loaded data
                if (!canUserAccessFriendGroupOptimized(group, user)) {
                    continue;
                }
                
                String discussionId = group.getDiscussionId();
                Discussion discussion = discussionMap.get(discussionId);
                if (discussion == null) {
                    // Discussion doesn't exist - skip for statistics
                    continue;
                }
                
                if (addedDiscussionIds.contains(discussionId)) {
                    continue;
                }
                
                List<String> accessReasons = determineAccessReasonsOptimized(
                    discussion, null, group, user, friendIds, accessibleGroups, group.getName());
                
                DiscussionStatisticsDTO.DiscussionAccessInfo accessInfo = new DiscussionStatisticsDTO.DiscussionAccessInfo(
                    discussionId,
                    "Discussion - " + (group.getName() != null ? group.getName() : "Friend Group"),
                    "friendGroup",
                    accessReasons
                );
                accessInfo.setFriendGroupName(group.getName());
                accessInfoList.add(accessInfo);
                addedDiscussionIds.add(discussionId);
            }
            
            DiscussionStatisticsDTO stats = new DiscussionStatisticsDTO(
                user.getId(),
                user.getUserName() != null ? user.getUserName() : "Unknown",
                user.getFirstName() != null ? user.getFirstName() : "",
                user.getLastName() != null ? user.getLastName() : "",
                (long) accessInfoList.size(),
                accessInfoList
            );
            
            result.add(stats);
        }
        
        // Sort by username
        result.sort((a, b) -> {
            String nameA = a.getUserName() != null ? a.getUserName() : "";
            String nameB = b.getUserName() != null ? b.getUserName() : "";
            return nameA.compareToIgnoreCase(nameB);
        });
        
        return result;
    }
    
    /**
     * Optimized version of canUserAccessEvent that uses pre-loaded data
     */
    private boolean canUserAccessEventOptimized(com.pat.repo.domain.Evenement event, Member user,
            java.util.Set<String> friendIds, java.util.Map<String, com.pat.repo.domain.FriendGroup> accessibleGroups) {
        if (event == null || user == null) {
            return false;
        }
        
        // Public events are accessible to everyone
        String visibility = event.getVisibility();
        if (visibility == null || "public".equals(visibility)) {
            return true;
        }
        
        // Creators can always see their own events
        if (event.getAuthor() != null && event.getAuthor().getId() != null 
            && event.getAuthor().getId().equals(user.getId())) {
            return true;
        }
        
        // Private events: only author can see (already handled above)
        if ("private".equals(visibility)) {
            return false;
        }
        
        // Friends visibility: author must be a friend
        if ("friends".equals(visibility)) {
            if (event.getAuthor() != null && event.getAuthor().getId() != null) {
                return friendIds.contains(event.getAuthor().getId());
            }
            return false;
        }
        
        // Friend group visibility: user must be in the friend group
        if (event.getFriendGroupId() != null && !event.getFriendGroupId().trim().isEmpty()) {
            return accessibleGroups.containsKey(event.getFriendGroupId());
        }
        
        // If visibility matches a friend group name (backward compatibility)
        if (visibility != null && !"public".equals(visibility) && !"private".equals(visibility) && !"friends".equals(visibility)) {
            return accessibleGroups.values().stream()
                .anyMatch(g -> g.getName() != null && g.getName().equals(visibility));
        }
        
        return false;
    }
    
    /**
     * Optimized version of canUserAccessFriendGroup that uses pre-loaded data
     */
    private boolean canUserAccessFriendGroupOptimized(com.pat.repo.domain.FriendGroup group, Member user) {
        if (group == null || user == null) {
            return false;
        }
        
        // Check if user is owner
        if (group.getOwner() != null && group.getOwner().getId() != null 
            && group.getOwner().getId().equals(user.getId())) {
            return true;
        }
        
        // Check if user is a member
        if (group.getMembers() != null) {
            for (Member member : group.getMembers()) {
                if (member != null && member.getId() != null && member.getId().equals(user.getId())) {
                    return true;
                }
            }
        }
        
        // Check if user is authorized
        if (group.getAuthorizedUsers() != null) {
            for (Member authorizedUser : group.getAuthorizedUsers()) {
                if (authorizedUser != null && authorizedUser.getId() != null 
                    && authorizedUser.getId().equals(user.getId())) {
                    return true;
                }
            }
        }
        
        return false;
    }
    
    /**
     * Optimized version of determineAccessReasons that uses pre-loaded data
     */
    private List<String> determineAccessReasonsOptimized(
            Discussion discussion,
            com.pat.repo.domain.Evenement event,
            com.pat.repo.domain.FriendGroup friendGroup,
            Member user,
            java.util.Set<String> friendIds,
            java.util.Map<String, com.pat.repo.domain.FriendGroup> accessibleGroups,
            String groupName) {
        List<String> reasons = new java.util.ArrayList<>();
        
        // Check if user is creator
        if (discussion.getCreatedBy() != null && discussion.getCreatedBy().getId() != null 
            && discussion.getCreatedBy().getId().equals(user.getId())) {
            reasons.add("creator");
        }
        
        if (event != null) {
            // Check if user is event author
            if (event.getAuthor() != null && event.getAuthor().getId() != null 
                && event.getAuthor().getId().equals(user.getId())) {
                reasons.add("event_owner");
            }
            
            // Check visibility
            String visibility = event.getVisibility();
            if (visibility == null || "public".equals(visibility)) {
                reasons.add("public");
            } else if ("friends".equals(visibility)) {
                if (event.getAuthor() != null && event.getAuthor().getId() != null 
                    && friendIds.contains(event.getAuthor().getId())) {
                    reasons.add("friend_of_author");
                }
            } else if (event.getFriendGroupId() != null && !event.getFriendGroupId().trim().isEmpty()) {
                com.pat.repo.domain.FriendGroup group = accessibleGroups.get(event.getFriendGroupId());
                if (group != null) {
                    String gName = group.getName() != null ? group.getName() : "Unknown Group";
                    if (group.getOwner() != null && group.getOwner().getId() != null 
                        && group.getOwner().getId().equals(user.getId())) {
                        reasons.add("group_owner:" + gName);
                    } else if (group.getMembers() != null && group.getMembers().stream()
                        .anyMatch(m -> m != null && m.getId() != null && m.getId().equals(user.getId()))) {
                        reasons.add("group_member:" + gName);
                    } else if (group.getAuthorizedUsers() != null && group.getAuthorizedUsers().stream()
                        .anyMatch(m -> m != null && m.getId() != null && m.getId().equals(user.getId()))) {
                        reasons.add("group_authorized:" + gName);
                    }
                }
            }
        } else if (friendGroup != null) {
            String gName = groupName != null ? groupName : (friendGroup.getName() != null ? friendGroup.getName() : "Unknown Group");
            if (friendGroup.getOwner() != null && friendGroup.getOwner().getId() != null 
                && friendGroup.getOwner().getId().equals(user.getId())) {
                reasons.add("group_owner:" + gName);
            }
            if (friendGroup.getMembers() != null && friendGroup.getMembers().stream()
                .anyMatch(m -> m != null && m.getId() != null && m.getId().equals(user.getId()))) {
                reasons.add("group_member:" + gName);
            }
            if (friendGroup.getAuthorizedUsers() != null && friendGroup.getAuthorizedUsers().stream()
                .anyMatch(m -> m != null && m.getId() != null && m.getId().equals(user.getId()))) {
                reasons.add("group_authorized:" + gName);
            }
        } else {
            // General discussion
            reasons.add("general");
        }
        
        return reasons;
    }
    
    /**
     * Determine why a user can access a specific discussion
     */
    private List<String> determineAccessReasons(DiscussionItemDTO item, Member user) {
        List<String> reasons = new java.util.ArrayList<>();
        
        if (item.getDiscussion() != null && item.getDiscussion().getCreatedBy() != null) {
            if (item.getDiscussion().getCreatedBy().getId() != null && 
                item.getDiscussion().getCreatedBy().getId().equals(user.getId())) {
                reasons.add("creator");
            }
        }
        
        if ("general".equals(item.getType())) {
            reasons.add("general");
        } else if ("event".equals(item.getType()) && item.getEvent() != null) {
            com.pat.repo.domain.Evenement event = item.getEvent();
            
            // Check if user is event author
            if (event.getAuthor() != null && event.getAuthor().getId() != null 
                && event.getAuthor().getId().equals(user.getId())) {
                reasons.add("event_owner");
            }
            
            // Check visibility
            String visibility = event.getVisibility();
            if (visibility == null || "public".equals(visibility)) {
                reasons.add("public");
            } else if ("private".equals(visibility)) {
                // Already handled by event_owner check above
            } else if ("friends".equals(visibility)) {
                // Check if author is a friend
                List<Friend> friendships = friendRepository.findByUser1OrUser2(user, user);
                java.util.Set<String> friendIds = new java.util.HashSet<>();
                for (Friend friendship : friendships) {
                    if (friendship.getUser1() != null && !friendship.getUser1().getId().equals(user.getId())) {
                        friendIds.add(friendship.getUser1().getId());
                    }
                    if (friendship.getUser2() != null && !friendship.getUser2().getId().equals(user.getId())) {
                        friendIds.add(friendship.getUser2().getId());
                    }
                }
                if (event.getAuthor() != null && event.getAuthor().getId() != null 
                    && friendIds.contains(event.getAuthor().getId())) {
                    reasons.add("friend_of_author");
                }
            } else if (event.getFriendGroupId() != null && !event.getFriendGroupId().trim().isEmpty()) {
                // Check if user is in the friend group
                java.util.Optional<com.pat.repo.domain.FriendGroup> groupOpt = friendGroupRepository.findById(event.getFriendGroupId());
                if (groupOpt.isPresent()) {
                    com.pat.repo.domain.FriendGroup group = groupOpt.get();
                    String groupName = group.getName() != null ? group.getName() : "Unknown Group";
                    if (canUserAccessFriendGroup(group, user)) {
                        if (group.getOwner() != null && group.getOwner().getId() != null 
                            && group.getOwner().getId().equals(user.getId())) {
                            reasons.add("group_owner:" + groupName);
                        } else if (group.getMembers() != null && group.getMembers().stream()
                            .anyMatch(m -> m != null && m.getId() != null && m.getId().equals(user.getId()))) {
                            reasons.add("group_member:" + groupName);
                        } else if (group.getAuthorizedUsers() != null && group.getAuthorizedUsers().stream()
                            .anyMatch(m -> m != null && m.getId() != null && m.getId().equals(user.getId()))) {
                            reasons.add("group_authorized:" + groupName);
                        }
                    }
                }
            }
        } else if ("friendGroup".equals(item.getType()) && item.getFriendGroup() != null) {
            com.pat.repo.domain.FriendGroup group = item.getFriendGroup();
            String groupName = group.getName() != null ? group.getName() : "Unknown Group";
            
            if (group.getOwner() != null && group.getOwner().getId() != null 
                && group.getOwner().getId().equals(user.getId())) {
                reasons.add("group_owner:" + groupName);
            }
            
            if (group.getMembers() != null && group.getMembers().stream()
                .anyMatch(m -> m != null && m.getId() != null && m.getId().equals(user.getId()))) {
                reasons.add("group_member:" + groupName);
            }
            
            if (group.getAuthorizedUsers() != null && group.getAuthorizedUsers().stream()
                .anyMatch(m -> m != null && m.getId() != null && m.getId().equals(user.getId()))) {
                reasons.add("group_authorized:" + groupName);
            }
        }
        
        return reasons;
    }
}

