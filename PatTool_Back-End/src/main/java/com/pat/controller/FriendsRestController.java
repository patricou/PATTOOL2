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
    
    @Autowired
    private com.pat.repo.MembersRepository membersRepository;
    
    @Autowired
    private com.pat.repo.FriendGroupRepository friendGroupRepository;
    
    @Autowired
    private com.pat.controller.MailController mailController;

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
     * Cancel a sent friend request (by the requester)
     */
    @DeleteMapping(value = "/request/{requestId}/cancel", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Void> cancelSentFriendRequest(
            @PathVariable String requestId,
            Authentication authentication) {
        try {
            Member currentUser = friendsService.getCurrentUser(authentication);
            if (currentUser == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            friendsService.cancelSentFriendRequest(requestId, currentUser);
            return ResponseEntity.ok().build();
        } catch (IllegalArgumentException e) {
            log.error("Invalid request: {}", e.getMessage());
            return ResponseEntity.notFound().build();
        } catch (IllegalStateException e) {
            log.error("Invalid state: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        } catch (Exception e) {
            log.error("Error canceling sent friend request", e);
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
    
    /**
     * Check if an email address belongs to an existing member
     */
    @GetMapping(value = "/check-email/{email}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> checkEmail(@PathVariable String email) {
        try {
            Member member = membersRepository.findByAddressEmail(email);
            Map<String, Object> response = new java.util.HashMap<>();
            response.put("exists", member != null);
            if (member != null) {
                response.put("memberId", member.getId());
                response.put("userName", member.getUserName());
            }
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error checking email", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }
    
    /**
     * Send invitation email to join PATTOOL
     */
    @PostMapping(value = "/invite", consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, String>> sendInvitation(
            @RequestBody Map<String, String> requestBody,
            Authentication authentication) {
        try {
            String email = requestBody.get("email");
            if (email == null || email.trim().isEmpty()) {
                return ResponseEntity.badRequest().build();
            }
            
            Member inviter = friendsService.getCurrentUser(authentication);
            if (inviter == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }
            
            // Check if email already exists
            Member existingMember = membersRepository.findByAddressEmail(email);
            if (existingMember != null) {
                Map<String, String> response = new java.util.HashMap<>();
                response.put("error", "Email already registered");
                return ResponseEntity.badRequest().body(response);
            }
            
            // Send invitation email
            sendInvitationEmail(inviter, email);
            
            Map<String, String> response = new java.util.HashMap<>();
            response.put("message", "Invitation sent successfully");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error sending invitation", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }
    
    /**
     * Send invitation email to join PATTOOL
     */
    private void sendInvitationEmail(Member inviter, String recipientEmail) {
        try {
            if (recipientEmail == null || recipientEmail.trim().isEmpty()) {
                log.debug("Cannot send invitation email - recipient email is empty");
                return;
            }
            
            // Determine language based on inviter's locale (default to English)
            String language = "en";
            boolean isFrench = false;
            
            String inviterLocale = inviter.getLocale();
            if (inviterLocale != null && inviterLocale.toLowerCase().startsWith("fr")) {
                isFrench = true;
                language = "fr";
            }
            
            String subject;
            String body;
            if (isFrench) {
                subject = "Invitation à rejoindre PATTOOL de " + inviter.getFirstName() + " " + inviter.getLastName();
                body = generateInvitationEmailHtml(inviter, recipientEmail, true);
            } else {
                subject = "Invitation to join PATTOOL from " + inviter.getFirstName() + " " + inviter.getLastName();
                body = generateInvitationEmailHtml(inviter, recipientEmail, false);
            }
            
            // Send invitation email with BCC to app.mailsentto
            mailController.sendMailToRecipient(recipientEmail, subject, body, true, mailController.getMailSentTo());
            log.debug("Invitation email sent to {} in language {} (BCC: {})", recipientEmail, language, mailController.getMailSentTo());
        } catch (Exception e) {
            log.error("Error sending invitation email to {}: {}", recipientEmail, e.getMessage(), e);
        }
    }
    
    /**
     * Generate HTML email body for invitation
     */
    private String generateInvitationEmailHtml(Member inviter, String recipientEmail, boolean isFrench) {
        String headerTitle = isFrench ? "Invitation à PATTOOL" : "Invitation to PATTOOL";
        String greeting = isFrench ? "Bonjour" : "Hello";
        String messageText = isFrench ? 
            " vous invite à rejoindre PATTOOL, une application pour partager et organiser vos activités." : 
            " invites you to join PATTOOL, an application to share and organize your activities.";
        String inviterInfo = isFrench ? "Invité par:" : "Invited by:";
        String callToAction = isFrench ? 
            "Rejoignez PATTOOL dès aujourd'hui et commencez à partager vos activités avec vos amis !" : 
            "Join PATTOOL today and start sharing your activities with your friends!";
        String siteUrl = "https://www.patrickdeschamps.com";
        String buttonText = isFrench ? "Rejoindre PATTOOL" : "Join PATTOOL";
        String footerText1 = isFrench ? 
            "Cet email a été envoyé automatiquement par PATTOOL." : 
            "This email was automatically sent by PATTOOL.";
        String footerText2 = isFrench ? 
            "Vous recevez cet email car " + inviter.getFirstName() + " " + inviter.getLastName() + " vous a invité à rejoindre l'application." : 
            "You are receiving this email because " + inviter.getFirstName() + " " + inviter.getLastName() + " invited you to join the application.";
        
        StringBuilder bodyBuilder = new StringBuilder();
        bodyBuilder.append("<!DOCTYPE html><html><head><meta charset='UTF-8'>");
        bodyBuilder.append("<style>");
        bodyBuilder.append("body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 15px; line-height: 1.8; color: #2c3e50; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); margin: 0; padding: 20px; }");
        bodyBuilder.append(".container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); overflow: hidden; }");
        bodyBuilder.append(".header { background: linear-gradient(135deg, #007bff 0%, #0056b3 100%); color: white; padding: 25px; text-align: center; border-bottom: 4px solid #004085; }");
        bodyBuilder.append(".header h1 { margin: 0; font-size: 24px; font-weight: 700; text-shadow: 2px 2px 4px rgba(0,0,0,0.2); letter-spacing: 1px; }");
        bodyBuilder.append(".header-icon { font-size: 32px; margin-bottom: 10px; }");
        bodyBuilder.append(".content { padding: 30px; background: #fafafa; }");
        bodyBuilder.append(".message { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #007bff; }");
        bodyBuilder.append(".inviter-info { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }");
        bodyBuilder.append(".inviter-info h3 { margin: 0 0 15px 0; color: #333; font-weight: 600; }");
        bodyBuilder.append(".info-item { margin: 10px 0; padding: 10px; background: #f8f9fa; border-radius: 6px; }");
        bodyBuilder.append(".info-label { font-weight: 700; color: #495057; margin-right: 10px; }");
        bodyBuilder.append(".info-value { color: #212529; }");
        bodyBuilder.append(".button-container { text-align: center; margin-top: 30px; }");
        bodyBuilder.append(".button { display: inline-block; padding: 12px 30px; background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 6px rgba(0,0,0,0.2); }");
        bodyBuilder.append(".button:hover { background: linear-gradient(135deg, #218838 0%, #1ea080 100%); }");
        bodyBuilder.append(".footer { background: #e9ecef; padding: 20px; text-align: center; color: #6c757d; font-size: 12px; }");
        bodyBuilder.append("</style></head><body>");
        bodyBuilder.append("<div class='container'>");
        
        // Header
        bodyBuilder.append("<div class='header'>");
        bodyBuilder.append("<div class='header-icon'>📧</div>");
        bodyBuilder.append("<h1>").append(escapeHtml(headerTitle)).append("</h1>");
        bodyBuilder.append("</div>");
        
        // Content
        bodyBuilder.append("<div class='content'>");
        bodyBuilder.append("<div class='message'>");
        bodyBuilder.append("<p>").append(escapeHtml(greeting)).append(",</p>");
        bodyBuilder.append("<p><strong>").append(escapeHtml(inviter.getFirstName())).append(" ").append(escapeHtml(inviter.getLastName())).append("</strong>").append(escapeHtml(messageText)).append("</p>");
        bodyBuilder.append("</div>");
        
        // Inviter Information
        bodyBuilder.append("<div class='inviter-info'>");
        bodyBuilder.append("<h3>").append(escapeHtml(inviterInfo)).append("</h3>");
        bodyBuilder.append("<div class='info-item'>");
        bodyBuilder.append("<span class='info-label'>").append(escapeHtml(isFrench ? "Nom:" : "Name:")).append("</span>");
        bodyBuilder.append("<span class='info-value'>").append(escapeHtml(inviter.getFirstName())).append(" ").append(escapeHtml(inviter.getLastName())).append("</span>");
        bodyBuilder.append("</div>");
        if (inviter.getAddressEmail() != null) {
            bodyBuilder.append("<div class='info-item'>");
            bodyBuilder.append("<span class='info-label'>").append(escapeHtml(isFrench ? "Email:" : "Email:")).append("</span>");
            bodyBuilder.append("<span class='info-value'>").append(escapeHtml(inviter.getAddressEmail())).append("</span>");
            bodyBuilder.append("</div>");
        }
        bodyBuilder.append("</div>");
        
        // Call to action with button
        bodyBuilder.append("<div class='button-container'>");
        bodyBuilder.append("<p>").append(escapeHtml(callToAction)).append("</p>");
        bodyBuilder.append("<a href='").append(siteUrl).append("' class='button'>").append(escapeHtml(buttonText)).append("</a>");
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

    // ========== Friend Groups Endpoints ==========

    /**
     * Create a new friend group
     */
    @PostMapping(value = "/groups", consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<com.pat.repo.domain.FriendGroup> createFriendGroup(
            @RequestBody Map<String, Object> requestBody,
            Authentication authentication) {
        try {
            Member owner = friendsService.getCurrentUser(authentication);
            if (owner == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            String name = (String) requestBody.get("name");
            @SuppressWarnings("unchecked")
            List<String> memberIds = (List<String>) requestBody.get("memberIds");

            if (name == null || name.trim().isEmpty()) {
                return ResponseEntity.badRequest().build();
            }

            com.pat.repo.domain.FriendGroup group = friendsService.createFriendGroup(name, memberIds != null ? memberIds : new java.util.ArrayList<>(), owner);
            return ResponseEntity.ok(group);
        } catch (IllegalArgumentException e) {
            log.error("Invalid request: {}", e.getMessage());
            return ResponseEntity.badRequest().build();
        } catch (IllegalStateException e) {
            log.error("Invalid state: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        } catch (Exception e) {
            log.error("Error creating friend group", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Get all friend groups for the current user
     */
    @GetMapping(value = "/groups", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<List<com.pat.repo.domain.FriendGroup>> getFriendGroups(Authentication authentication) {
        try {
            Member currentUser = friendsService.getCurrentUser(authentication);
            if (currentUser == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            List<com.pat.repo.domain.FriendGroup> groups = friendsService.getFriendGroups(currentUser);
            return ResponseEntity.ok(groups);
        } catch (Exception e) {
            log.error("Error getting friend groups", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Get a specific friend group by ID
     */
    @GetMapping(value = "/groups/{groupId}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<com.pat.repo.domain.FriendGroup> getFriendGroup(
            @PathVariable String groupId,
            Authentication authentication) {
        try {
            Member currentUser = friendsService.getCurrentUser(authentication);
            if (currentUser == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            com.pat.repo.domain.FriendGroup group = friendsService.getFriendGroup(groupId);
            
            // Verify ownership
            if (!group.getOwner().getId().equals(currentUser.getId())) {
                return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
            }

            return ResponseEntity.ok(group);
        } catch (IllegalArgumentException e) {
            log.error("Invalid request: {}", e.getMessage());
            return ResponseEntity.notFound().build();
        } catch (Exception e) {
            log.error("Error getting friend group", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Update a friend group
     */
    @PutMapping(value = "/groups/{groupId}", consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<com.pat.repo.domain.FriendGroup> updateFriendGroup(
            @PathVariable String groupId,
            @RequestBody Map<String, Object> requestBody,
            Authentication authentication) {
        try {
            Member owner = friendsService.getCurrentUser(authentication);
            if (owner == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            String name = (String) requestBody.get("name");
            @SuppressWarnings("unchecked")
            List<String> memberIds = (List<String>) requestBody.get("memberIds");
            String discussionId = (String) requestBody.get("discussionId");

            com.pat.repo.domain.FriendGroup group = friendsService.updateFriendGroup(groupId, name, memberIds, owner);
            
            // Set discussionId if provided
            if (discussionId != null && !discussionId.trim().isEmpty()) {
                group.setDiscussionId(discussionId);
                group = friendGroupRepository.save(group);
            }
            return ResponseEntity.ok(group);
        } catch (IllegalArgumentException e) {
            log.error("Invalid request: {}", e.getMessage());
            return ResponseEntity.badRequest().build();
        } catch (IllegalStateException e) {
            log.error("Invalid state: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        } catch (Exception e) {
            log.error("Error updating friend group", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Delete a friend group
     */
    @DeleteMapping(value = "/groups/{groupId}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Void> deleteFriendGroup(
            @PathVariable String groupId,
            Authentication authentication) {
        try {
            Member owner = friendsService.getCurrentUser(authentication);
            if (owner == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            friendsService.deleteFriendGroup(groupId, owner);
            return ResponseEntity.ok().build();
        } catch (IllegalArgumentException e) {
            log.error("Invalid request: {}", e.getMessage());
            return ResponseEntity.notFound().build();
        } catch (IllegalStateException e) {
            log.error("Invalid state: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        } catch (Exception e) {
            log.error("Error deleting friend group", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Authorize a user to use a friend group (but not to add members)
     */
    @PostMapping(value = "/groups/{groupId}/authorize/{userId}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<com.pat.repo.domain.FriendGroup> authorizeUserForGroup(
            @PathVariable String groupId,
            @PathVariable String userId,
            Authentication authentication) {
        try {
            Member owner = friendsService.getCurrentUser(authentication);
            if (owner == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            com.pat.repo.domain.FriendGroup group = friendsService.authorizeUserForGroup(groupId, userId, owner);
            return ResponseEntity.ok(group);
        } catch (IllegalArgumentException e) {
            log.error("Invalid request: {}", e.getMessage());
            return ResponseEntity.badRequest().build();
        } catch (IllegalStateException e) {
            log.error("Invalid state: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        } catch (Exception e) {
            log.error("Error authorizing user for group", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Remove authorization for a user from a friend group
     */
    @DeleteMapping(value = "/groups/{groupId}/authorize/{userId}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<com.pat.repo.domain.FriendGroup> unauthorizeUserForGroup(
            @PathVariable String groupId,
            @PathVariable String userId,
            Authentication authentication) {
        try {
            Member owner = friendsService.getCurrentUser(authentication);
            if (owner == null) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            }

            com.pat.repo.domain.FriendGroup group = friendsService.unauthorizeUserForGroup(groupId, userId, owner);
            return ResponseEntity.ok(group);
        } catch (IllegalArgumentException e) {
            log.error("Invalid request: {}", e.getMessage());
            return ResponseEntity.badRequest().build();
        } catch (IllegalStateException e) {
            log.error("Invalid state: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        } catch (Exception e) {
            log.error("Error unauthorizing user for group", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }
}

