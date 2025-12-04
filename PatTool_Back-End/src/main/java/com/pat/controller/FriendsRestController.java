package com.pat.controller;

import com.pat.repo.domain.Friend;
import com.pat.repo.domain.FriendRequest;
import com.pat.repo.domain.Member;
import com.pat.service.FriendsService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/friends")
public class FriendsRestController {

    private static final Logger log = LoggerFactory.getLogger(FriendsRestController.class);

    @Autowired
    private FriendsService friendsService;

    /**
     * Get all users from MongoDB (synced from Keycloak)
     */
    @GetMapping(value = "/users", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<List<Member>> getAllUsers(Authentication authentication) {
        try {
            List<Member> allUsers = friendsService.getAllUsers();
            return ResponseEntity.ok(allUsers);
        } catch (Exception e) {
            log.error("Error getting users", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Send a friend request
     */
    @PostMapping(value = "/request", consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<FriendRequest> sendFriendRequest(
            @RequestBody Map<String, String> requestBody,
            Authentication authentication) {
        try {
            String recipientId = requestBody.get("recipientId");
            if (recipientId == null || recipientId.isEmpty()) {
                return ResponseEntity.badRequest().build();
            }

            Member requester = friendsService.getCurrentUser(authentication);
            if (requester == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            FriendRequest friendRequest = friendsService.sendFriendRequest(recipientId, requester);
            return ResponseEntity.ok(friendRequest);
        } catch (IllegalArgumentException e) {
            log.error("Invalid request: {}", e.getMessage());
            return ResponseEntity.notFound().build();
        } catch (IllegalStateException e) {
            log.error("Invalid state: {}", e.getMessage());
            return ResponseEntity.badRequest().build();
        } catch (Exception e) {
            log.error("Error sending friend request", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Get pending friend requests (incoming)
     */
    @GetMapping(value = "/requests/pending", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<List<FriendRequest>> getPendingRequests(Authentication authentication) {
        try {
            Member currentUser = friendsService.getCurrentUser(authentication);
            if (currentUser == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            List<FriendRequest> requests = friendsService.getPendingRequests(currentUser);
            return ResponseEntity.ok(requests);
        } catch (Exception e) {
            log.error("Error getting pending requests", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Get sent friend requests (outgoing)
     */
    @GetMapping(value = "/requests/sent", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<List<FriendRequest>> getSentRequests(Authentication authentication) {
        try {
            Member currentUser = friendsService.getCurrentUser(authentication);
            if (currentUser == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            List<FriendRequest> requests = friendsService.getSentRequests(currentUser);
            return ResponseEntity.ok(requests);
        } catch (Exception e) {
            log.error("Error getting sent requests", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Approve a friend request
     */
    @PutMapping(value = "/request/{requestId}/approve", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Friend> approveFriendRequest(
            @PathVariable String requestId,
            Authentication authentication) {
        try {
            Member currentUser = friendsService.getCurrentUser(authentication);
            if (currentUser == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            Friend friendship = friendsService.approveFriendRequest(requestId, currentUser);
            return ResponseEntity.ok(friendship);
        } catch (IllegalArgumentException e) {
            log.error("Invalid request: {}", e.getMessage());
            return ResponseEntity.notFound().build();
        } catch (IllegalStateException e) {
            log.error("Invalid state: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        } catch (Exception e) {
            log.error("Error approving friend request", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Reject a friend request
     */
    @PutMapping(value = "/request/{requestId}/reject", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Void> rejectFriendRequest(
            @PathVariable String requestId,
            Authentication authentication) {
        try {
            Member currentUser = friendsService.getCurrentUser(authentication);
            if (currentUser == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            friendsService.rejectFriendRequest(requestId, currentUser);
            return ResponseEntity.ok().build();
        } catch (IllegalArgumentException e) {
            log.error("Invalid request: {}", e.getMessage());
            return ResponseEntity.notFound().build();
        } catch (IllegalStateException e) {
            log.error("Invalid state: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        } catch (Exception e) {
            log.error("Error rejecting friend request", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Get all friends of the current user
     */
    @GetMapping(produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<List<Friend>> getFriends(Authentication authentication) {
        try {
            Member currentUser = friendsService.getCurrentUser(authentication);
            if (currentUser == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            List<Friend> friends = friendsService.getFriends(currentUser);
            return ResponseEntity.ok(friends);
        } catch (Exception e) {
            log.error("Error getting friends", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Remove a friend
     */
    @DeleteMapping(value = "/{friendId}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Void> removeFriend(
            @PathVariable String friendId,
            Authentication authentication) {
        try {
            Member currentUser = friendsService.getCurrentUser(authentication);
            if (currentUser == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            friendsService.removeFriend(friendId, currentUser);
            return ResponseEntity.ok().build();
        } catch (IllegalArgumentException e) {
            log.error("Invalid request: {}", e.getMessage());
            return ResponseEntity.notFound().build();
        } catch (IllegalStateException e) {
            log.error("Invalid state: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        } catch (Exception e) {
            log.error("Error removing friend", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }
}

