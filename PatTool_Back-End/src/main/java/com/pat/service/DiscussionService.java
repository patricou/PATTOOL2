package com.pat.service;

import com.pat.repo.DiscussionRepository;
import com.pat.repo.EvenementsRepository;
import com.pat.repo.FriendGroupRepository;
import com.pat.repo.MembersRepository;
import com.pat.repo.UserConnectionLogRepository;
import com.pat.repo.domain.Discussion;
import com.pat.repo.domain.DiscussionMessage;
import com.pat.repo.domain.Member;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.Date;
import java.util.List;
import java.util.UUID;

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
            // Discussion doesn't exist, try to find associated event and create it
            log.warn("Discussion {} does not exist, attempting to find associated event and create discussion", discussionId);
            
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
                throw new IllegalArgumentException("Discussion not found: " + discussionId + " and no associated event found");
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
                    log.info("Removed discussionId {} from event {}", discussionId, event.getId());
                }
                log.info("Updated {} event(s) to remove discussionId {}", events.size(), discussionId);
            }
            
            // Find all friend groups with this discussionId and remove it
            List<com.pat.repo.domain.FriendGroup> friendGroups = friendGroupRepository.findByDiscussionId(discussionId);
            if (friendGroups != null && !friendGroups.isEmpty()) {
                for (com.pat.repo.domain.FriendGroup group : friendGroups) {
                    group.setDiscussionId(null);
                    friendGroupRepository.save(group);
                    log.info("Removed discussionId {} from friend group {}", discussionId, group.getId());
                }
                log.info("Updated {} friend group(s) to remove discussionId {}", friendGroups.size(), discussionId);
            }
            
            // Find all user connection logs with this discussionId and remove it
            List<com.pat.repo.domain.UserConnectionLog> connectionLogs = userConnectionLogRepository.findByDiscussionId(discussionId);
            if (connectionLogs != null && !connectionLogs.isEmpty()) {
                for (com.pat.repo.domain.UserConnectionLog logEntry : connectionLogs) {
                    logEntry.setDiscussionId(null);
                    logEntry.setDiscussionTitle(null);
                    userConnectionLogRepository.save(logEntry);
                    log.info("Removed discussionId {} from user connection log {}", discussionId, logEntry.getId());
                }
                log.info("Updated {} user connection log(s) to remove discussionId {}", connectionLogs.size(), discussionId);
            }
            
            // Delete the discussion
            discussionRepository.delete(discussion);
            log.info("Discussion {} deleted by user {}", discussionId, userName);
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
}

