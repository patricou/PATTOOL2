package com.pat.controller;

import com.pat.repo.domain.Discussion;
import com.pat.repo.domain.DiscussionItemDTO;
import com.pat.repo.domain.DiscussionMessage;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.DiscussionStatisticsDTO;
import com.pat.repo.MembersRepository;
import com.pat.service.DiscussionConnectionService;
import com.pat.service.DiscussionService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.File;
import java.io.IOException;
import java.util.concurrent.CompletableFuture;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * REST Controller for Discussion management
 */
@RestController
@RequestMapping("/api/discussions")
@Validated
public class DiscussionRestController {

    private static final Logger log = LoggerFactory.getLogger(DiscussionRestController.class);

    @Autowired
    private DiscussionService discussionService;

    @Autowired
    private DiscussionConnectionService connectionService;

    @Autowired
    private SimpMessagingTemplate messagingTemplate;

    @Autowired
    private MembersRepository membersRepository;

    // Get upload directory from application properties
    @org.springframework.beans.factory.annotation.Value("${app.uploaddir:./uploads}")
    private String uploadDir;

    /**
     * Get all discussions
     */
    @GetMapping
    public ResponseEntity<List<Discussion>> getAllDiscussions() {
        try {
            List<Discussion> discussions = discussionService.getAllDiscussions();
            return ResponseEntity.ok(discussions);
        } catch (Exception e) {
            log.error("Error getting discussions", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Get all accessible discussions for the current user
     * Returns discussions for events and friend groups the user can access
     * Validates and creates missing discussions automatically
     * Excludes discussions without associated event or friend group (except default discussion)
     */
    @GetMapping("/accessible")
    public ResponseEntity<List<DiscussionItemDTO>> getAccessibleDiscussions(Authentication authentication) {
        try {
            String userName = extractUserName(authentication);
            if (userName == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            Member user = membersRepository.findByUserName(userName);
            if (user == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            List<DiscussionItemDTO> discussions = discussionService.getAccessibleDiscussions(user);
            HttpHeaders headers = new HttpHeaders();
            headers.set("Content-Type", "application/json; charset=UTF-8");
            return ResponseEntity.ok().headers(headers).body(discussions);
        } catch (Exception e) {
            log.error("Error getting accessible discussions", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Stream accessible discussions using Server-Sent Events (SSE)
     * Streams discussions one by one as they are processed (truly reactive)
     * Sends data immediately when 1 discussion is available
     */
    @GetMapping(value = "/accessible/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamAccessibleDiscussions(Authentication authentication) {
        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE); // No timeout
        
        try {
            String userName = extractUserName(authentication);
            if (userName == null) {
                emitter.completeWithError(new RuntimeException("Unauthorized"));
                return emitter;
            }

            Member user = membersRepository.findByUserName(userName);
            if (user == null) {
                emitter.completeWithError(new RuntimeException("Unauthorized"));
                return emitter;
            }

            // Process discussions asynchronously and stream them
            // Use a dedicated executor for better control (or default ForkJoinPool)
            CompletableFuture.runAsync(() -> {
                try {
                    // Track if connection is still alive
                    java.util.concurrent.atomic.AtomicBoolean connectionAlive = new java.util.concurrent.atomic.AtomicBoolean(true);
                    
                    // Stream discussions - default discussion will be sent FIRST and IMMEDIATELY
                    discussionService.streamAccessibleDiscussions(user, (discussion) -> {
                        // Only send if connection is still alive
                        if (!connectionAlive.get()) {
                            return;
                        }
                        
                        try {
                            emitter.send(SseEmitter.event()
                                .name("discussion")
                                .data(discussion));
                        } catch (org.springframework.web.context.request.async.AsyncRequestNotUsableException e) {
                            // Connection aborted - client disconnected, this is normal
                            connectionAlive.set(false);
                            log.debug("SSE connection aborted by client");
                        } catch (IOException e) {
                            // Connection closed by client - this is normal, don't log as error
                            connectionAlive.set(false);
                            log.debug("SSE connection closed by client while sending discussion");
                        } catch (Exception e) {
                            // Other errors - log but don't fail
                            connectionAlive.set(false);
                            log.debug("Error sending discussion via SSE: {}", e.getMessage());
                        }
                    });
                    
                    // Send completion event only if connection is still alive
                    if (connectionAlive.get()) {
                        try {
                            emitter.send(SseEmitter.event()
                                .name("complete")
                                .data(""));
                            emitter.complete();
                        } catch (Exception e) {
                            log.debug("Connection already closed, cannot send completion event");
                            emitter.complete();
                        }
                    } else {
                        emitter.complete();
                    }
                } catch (Exception e) {
                    log.error("Error streaming discussions", e);
                    try {
                        if (emitter != null) {
                            emitter.send(SseEmitter.event()
                                .name("error")
                                .data(e.getMessage()));
                            emitter.complete();
                        }
                    } catch (Exception ex) {
                        log.debug("Error sending error via SSE, connection likely closed: {}", ex.getMessage());
                        if (emitter != null) {
                            emitter.complete();
                        }
                    }
                }
            });
        } catch (Exception e) {
            log.error("Error setting up discussion stream", e);
            emitter.completeWithError(e);
        }
        
        return emitter;
    }

    /**
     * Get the default discussion (Discussion Generale)
     */
    @GetMapping("/default")
    public ResponseEntity<Discussion> getDefaultDiscussion() {
        try {
            Discussion discussion = discussionService.getDefaultDiscussion();
            if (discussion != null) {
                return ResponseEntity.ok(discussion);
            } else {
                return ResponseEntity.notFound().build();
            }
        } catch (Exception e) {
            log.error("Error getting default discussion", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Get a discussion by ID
     */
    @GetMapping("/{id}")
    public ResponseEntity<Discussion> getDiscussionById(@PathVariable String id) {
        try {
            Discussion discussion = discussionService.getDiscussionById(id);
            if (discussion != null) {
                return ResponseEntity.ok(discussion);
            } else {
                return ResponseEntity.notFound().build();
            }
        } catch (Exception e) {
            log.error("Error getting discussion {}", id, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Create a new discussion
     */
    @PostMapping
    public ResponseEntity<Discussion> createDiscussion(
            @RequestParam(required = false) String title,
            Authentication authentication) {
        try {
            String userName = extractUserName(authentication);
            if (userName == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            Discussion discussion = discussionService.createDiscussion(userName, title != null ? title : "");
            return ResponseEntity.status(HttpStatus.CREATED).body(discussion);
        } catch (Exception e) {
            log.error("Error creating discussion", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Add a text message to a discussion
     */
    @PostMapping("/{discussionId}/messages")
    public ResponseEntity<DiscussionMessage> addMessage(
            @PathVariable String discussionId,
            @RequestParam String message,
            @RequestParam(required = false) MultipartFile image,
            @RequestParam(required = false) MultipartFile video,
            Authentication authentication) {
        try {
            String userName = extractUserName(authentication);
            if (userName == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            String imageUrl = null;
            String imageFileName = null;
            String videoUrl = null;
            String videoFileName = null;

            // Handle image upload
            if (image != null && !image.isEmpty()) {
                String[] result = saveFile(image, discussionId, "images");
                imageUrl = result[0];
                imageFileName = result[1];
            }

            // Handle video upload
            if (video != null && !video.isEmpty()) {
                String[] result = saveFile(video, discussionId, "videos");
                videoUrl = result[0];
                videoFileName = result[1];
            }

            DiscussionMessage discussionMessage = discussionService.addMessage(
                    discussionId, userName, message, imageUrl, imageFileName, videoUrl, videoFileName);

            // Broadcast the new message to all subscribers of this discussion
            Map<String, Object> payload = new HashMap<>();
            payload.put("discussionId", discussionId);
            payload.put("message", discussionMessage);
            messagingTemplate.convertAndSend("/topic/discussion/" + discussionId, payload);

            HttpHeaders headers = new HttpHeaders();
            headers.set("Content-Type", "application/json; charset=UTF-8");
            return ResponseEntity.status(HttpStatus.CREATED).headers(headers).body(discussionMessage);
        } catch (Exception e) {
            log.error("Error adding message to discussion {}", discussionId, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Get all messages for a discussion
     */
    @GetMapping("/{discussionId}/messages")
    public ResponseEntity<List<DiscussionMessage>> getMessages(@PathVariable String discussionId) {
        try {
            List<DiscussionMessage> messages = discussionService.getMessages(discussionId);
            return ResponseEntity.ok(messages);
        } catch (Exception e) {
            log.error("Error getting messages for discussion {}", discussionId, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Update a message in a discussion
     */
    @PutMapping("/{discussionId}/messages/{messageId}")
    public ResponseEntity<DiscussionMessage> updateMessage(
            @PathVariable String discussionId,
            @PathVariable String messageId,
            @RequestParam String message,
            Authentication authentication) {
        try {
            String userName = extractUserName(authentication);
            if (userName == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            DiscussionMessage updatedMessage = discussionService.updateMessage(discussionId, messageId, message, userName);

            // Broadcast the updated message to all subscribers
            Map<String, Object> payload = new HashMap<>();
            payload.put("discussionId", discussionId);
            payload.put("message", updatedMessage);
            payload.put("action", "update");
            messagingTemplate.convertAndSend("/topic/discussion/" + discussionId, payload);

            HttpHeaders headers = new HttpHeaders();
            headers.set("Content-Type", "application/json; charset=UTF-8");
            return ResponseEntity.ok().headers(headers).body(updatedMessage);
        } catch (SecurityException e) {
            log.warn("Unauthorized update attempt: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        } catch (Exception e) {
            log.error("Error updating message {} in discussion {}", messageId, discussionId, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Delete a message from a discussion
     */
    @DeleteMapping("/{discussionId}/messages/{messageId}")
    public ResponseEntity<Void> deleteMessage(
            @PathVariable String discussionId,
            @PathVariable String messageId,
            Authentication authentication) {
        try {
            String userName = extractUserName(authentication);
            if (userName == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            boolean deleted = discussionService.deleteMessage(discussionId, messageId, userName);
            if (deleted) {
                // Broadcast message deletion
                Map<String, Object> payload = new HashMap<>();
                payload.put("discussionId", discussionId);
                payload.put("messageId", messageId);
                payload.put("action", "delete");
                messagingTemplate.convertAndSend("/topic/discussion/" + discussionId, payload);
                return ResponseEntity.noContent().build();
            } else {
                return ResponseEntity.notFound().build();
            }
        } catch (Exception e) {
            log.error("Error deleting message {} from discussion {}", messageId, discussionId, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Extract username from authentication token
     */
    private String extractUserName(Authentication authentication) {
        if (authentication == null || authentication.getPrincipal() == null) {
            return null;
        }

        if (authentication.getPrincipal() instanceof Jwt) {
            Jwt jwt = (Jwt) authentication.getPrincipal();
            // Try different possible claim names for username
            String userName = jwt.getClaimAsString("preferred_username");
            if (userName == null) {
                userName = jwt.getClaimAsString("username");
            }
            if (userName == null) {
                userName = jwt.getClaimAsString("sub");
            }
            return userName;
        }

        return authentication.getName();
    }

    /**
     * Save uploaded file and return URL and filename
     */
    private String[] saveFile(MultipartFile file, String discussionId, String subfolder) throws IOException {
        // Create directory structure: uploadDir/discussions/discussionId/images or videos
        Path discussionDir = Paths.get(uploadDir, "discussions", discussionId, subfolder);
        Files.createDirectories(discussionDir);

        // Generate unique filename
        String originalFilename = file.getOriginalFilename();
        String baseName = "file";
        String extension = "";
        if (originalFilename != null && originalFilename.contains(".")) {
            int lastDotIndex = originalFilename.lastIndexOf(".");
            baseName = originalFilename.substring(0, lastDotIndex);
            extension = originalFilename.substring(lastDotIndex); // Includes the dot
        } else if (originalFilename != null) {
            baseName = originalFilename;
        }
        String filename = System.currentTimeMillis() + "_" + baseName + extension;
        Path filePath = discussionDir.resolve(filename);

        // Save file
        file.transferTo(filePath.toFile());

        // Return URL path (relative to server)
        String url = "/api/discussions/files/" + discussionId + "/" + subfolder + "/" + filename;
        return new String[]{url, originalFilename};
    }

    /**
     * Serve discussion files (images/videos)
     */
    @GetMapping("/files/{discussionId}/{subfolder}/{filename:.+}")
    public ResponseEntity<byte[]> getFile(
            @PathVariable String discussionId,
            @PathVariable String subfolder,
            @PathVariable String filename) {
        try {
            Path filePath = Paths.get(uploadDir, "discussions", discussionId, subfolder, filename);
            File file = filePath.toFile();

            if (!file.exists() || !file.isFile()) {
                return ResponseEntity.notFound().build();
            }

            byte[] fileContent = Files.readAllBytes(filePath);
            String contentType = Files.probeContentType(filePath);
            if (contentType == null) {
                contentType = "application/octet-stream";
            }

            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(org.springframework.http.MediaType.parseMediaType(contentType));
            headers.setContentLength(fileContent.length);

            return ResponseEntity.ok().headers(headers).body(fileContent);
        } catch (Exception e) {
            log.error("Error serving file {}/{}/{}", discussionId, subfolder, filename, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Delete a discussion
     */
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteDiscussion(
            @PathVariable String id,
            Authentication authentication) {
        try {
            String userName = extractUserName(authentication);
            if (userName == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            boolean deleted = discussionService.deleteDiscussion(id, userName);
            if (deleted) {
                return ResponseEntity.noContent().build();
            } else {
                return ResponseEntity.notFound().build();
            }
        } catch (SecurityException e) {
            log.warn("Unauthorized delete attempt: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        } catch (Exception e) {
            log.error("Error deleting discussion {}", id, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Get active WebSocket connections for discussions
     */
    @GetMapping("/active-connections")
    public ResponseEntity<List<DiscussionConnectionService.ActiveConnectionDTO>> getActiveConnections() {
        try {
            List<DiscussionConnectionService.ActiveConnectionDTO> connections = connectionService.getActiveConnections();
            HttpHeaders headers = new HttpHeaders();
            headers.set("Content-Type", "application/json; charset=UTF-8");
            return ResponseEntity.ok().headers(headers).body(connections);
        } catch (Exception e) {
            log.error("Error getting active connections", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }
    
    /**
     * Get discussion statistics for all users (Admin only)
     * Returns statistics showing for each user: how many discussions they can see and why
     * @param userId Optional filter to get statistics for a specific user only
     */
    @GetMapping("/statistics")
    public ResponseEntity<List<DiscussionStatisticsDTO>> getDiscussionStatistics(
            @RequestParam(required = false) String userId,
            Authentication authentication) {
        try {
            // Check if user has admin role
            String userName = extractUserName(authentication);
            if (userName == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }
            
            Member user = membersRepository.findByUserName(userName);
            if (user == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }
            
            // Check admin role (you may need to adjust this based on your role checking mechanism)
            // For now, we'll allow it - you can add role checking here if needed
            
            List<DiscussionStatisticsDTO> statistics = discussionService.getDiscussionStatisticsForAllUsers(userId);
            HttpHeaders headers = new HttpHeaders();
            headers.set("Content-Type", "application/json; charset=UTF-8");
            return ResponseEntity.ok().headers(headers).body(statistics);
        } catch (Exception e) {
            log.error("Error getting discussion statistics", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }
}

