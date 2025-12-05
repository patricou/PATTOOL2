package com.pat.service;

import com.pat.controller.MailController;
import com.pat.repo.domain.Friend;
import com.pat.repo.domain.FriendGroup;
import com.pat.repo.domain.FriendRequest;
import com.pat.repo.domain.Member;
import com.pat.repo.FriendGroupRepository;
import com.pat.repo.FriendRepository;
import com.pat.repo.FriendRequestRepository;
import com.pat.repo.MembersRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Service;

import java.util.Date;
import java.util.List;
import java.util.Optional;

@Service
public class FriendsService {

    private static final Logger log = LoggerFactory.getLogger(FriendsService.class);

    @Autowired
    private MembersRepository membersRepository;

    @Autowired
    private FriendRequestRepository friendRequestRepository;

    @Autowired
    private FriendRepository friendRepository;

    @Autowired
    private FriendGroupRepository friendGroupRepository;

    @Autowired
    private MailController mailController;

    /**
     * Get all users from MongoDB (synced from Keycloak)
     */
    public List<Member> getAllUsers() {
        log.debug("Getting all users");
        List<Member> allUsers = membersRepository.findAll();
        log.debug("Found {} users", allUsers.size());
        return allUsers;
    }

    /**
     * Get current user from authentication token
     */
    public Member getCurrentUser(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof Jwt)) {
            return null;
        }

        Jwt jwt = (Jwt) authentication.getPrincipal();
        String keycloakId = jwt.getSubject();
        
        if (keycloakId == null) {
            return null;
        }

        // Try to find by keycloakId first
        List<Member> members = membersRepository.findAll();
        Optional<Member> memberOpt = members.stream()
                .filter(m -> keycloakId.equals(m.getKeycloakId()))
                .findFirst();

        if (memberOpt.isPresent()) {
            return memberOpt.get();
        }

        // Fallback: try to get from username in token
        String username = jwt.getClaimAsString("preferred_username");
        if (username != null) {
            return membersRepository.findByUserName(username);
        }

        return null;
    }

    /**
     * Check if two users are already friends
     */
    public boolean areFriends(Member user1, Member user2) {
        return friendRepository.existsByUser1AndUser2(user1, user2) ||
               friendRepository.existsByUser2AndUser1(user1, user2);
    }

    /**
     * Send a friend request
     */
    public FriendRequest sendFriendRequest(String recipientId, Member requester) {
        // Get recipient
        Optional<Member> recipientOpt = membersRepository.findById(recipientId);
        if (recipientOpt.isEmpty()) {
            throw new IllegalArgumentException("Recipient not found");
        }
        Member recipient = recipientOpt.get();

        // Check if already friends
        if (areFriends(requester, recipient)) {
            throw new IllegalStateException("Users are already friends");
        }

        // Check if request already exists
        Optional<FriendRequest> existingRequest = friendRequestRepository
                .findByRequesterAndRecipientAndStatus(requester, recipient, "PENDING");
        if (existingRequest.isPresent()) {
            return existingRequest.get();
        }

        // Check if reverse request exists
        Optional<FriendRequest> reverseRequest = friendRequestRepository
                .findByRequesterAndRecipientAndStatus(recipient, requester, "PENDING");
        if (reverseRequest.isPresent()) {
            // Auto-accept if reverse request exists
            approveFriendRequest(reverseRequest.get().getId(), requester);
            // Return the original reverse request (now accepted)
            reverseRequest.get().setStatus("ACCEPTED");
            reverseRequest.get().setResponseDate(new Date());
            friendRequestRepository.save(reverseRequest.get());
            return reverseRequest.get();
        }

        // Create new request
        FriendRequest friendRequest = new FriendRequest();
        friendRequest.setRequester(requester);
        friendRequest.setRecipient(recipient);
        friendRequest.setStatus("PENDING");
        friendRequest.setRequestDate(new Date());

        FriendRequest saved = friendRequestRepository.save(friendRequest);
        log.debug("Friend request created: {} -> {}", requester.getUserName(), recipient.getUserName());
        
        // Send email notification to recipient
        sendFriendRequestEmail(requester, recipient);
        
        return saved;
    }

    /**
     * Get pending friend requests (incoming)
     */
    public List<FriendRequest> getPendingRequests(Member currentUser) {
        return friendRequestRepository.findByRecipientAndStatus(currentUser, "PENDING");
    }

    /**
     * Get sent friend requests (outgoing)
     */
    public List<FriendRequest> getSentRequests(Member currentUser) {
        return friendRequestRepository.findByRequesterAndStatus(currentUser, "PENDING");
    }

    /**
     * Approve a friend request
     */
    public Friend approveFriendRequest(String requestId, Member currentUser) {
        Optional<FriendRequest> requestOpt = friendRequestRepository.findById(requestId);
        if (requestOpt.isEmpty()) {
            throw new IllegalArgumentException("Friend request not found");
        }

        FriendRequest request = requestOpt.get();
        if (!request.getRecipient().getId().equals(currentUser.getId())) {
            throw new IllegalStateException("User is not the recipient of this request");
        }

        // Update request status
        request.setStatus("ACCEPTED");
        request.setResponseDate(new Date());
        friendRequestRepository.save(request);

        // Create friendship
        Friend friendship = new Friend();
        friendship.setUser1(request.getRequester());
        friendship.setUser2(request.getRecipient());
        friendship.setFriendshipDate(new Date());
        Friend saved = friendRepository.save(friendship);

        log.debug("Friend request approved: {} <-> {}", 
                request.getRequester().getUserName(), 
                request.getRecipient().getUserName());
        return saved;
    }

    /**
     * Reject a friend request
     */
    public void rejectFriendRequest(String requestId, Member currentUser) {
        Optional<FriendRequest> requestOpt = friendRequestRepository.findById(requestId);
        if (requestOpt.isEmpty()) {
            throw new IllegalArgumentException("Friend request not found");
        }

        FriendRequest request = requestOpt.get();
        if (!request.getRecipient().getId().equals(currentUser.getId())) {
            throw new IllegalStateException("User is not the recipient of this request");
        }

        request.setStatus("REJECTED");
        request.setResponseDate(new Date());
        friendRequestRepository.save(request);

        log.debug("Friend request rejected: {} -> {}", 
                request.getRequester().getUserName(), 
                request.getRecipient().getUserName());
    }

    /**
     * Get all friends of the current user
     */
    public List<Friend> getFriends(Member currentUser) {
        return friendRepository.findByUser1OrUser2(currentUser, currentUser);
    }

    /**
     * Remove a friend
     */
    public void removeFriend(String friendId, Member currentUser) {
        Optional<Friend> friendOpt = friendRepository.findById(friendId);
        if (friendOpt.isEmpty()) {
            throw new IllegalArgumentException("Friendship not found");
        }

        Friend friend = friendOpt.get();
        if (!friend.getUser1().getId().equals(currentUser.getId()) && 
            !friend.getUser2().getId().equals(currentUser.getId())) {
            throw new IllegalStateException("User is not part of this friendship");
        }

        friendRepository.delete(friend);
        log.debug("Friendship removed: {} <-> {}", 
                friend.getUser1().getUserName(), 
                friend.getUser2().getUserName());
    }

    /**
     * Send email notification when a friend request is received
     */
    private void sendFriendRequestEmail(Member requester, Member recipient) {
        try {
            if (recipient.getAddressEmail() == null || recipient.getAddressEmail().trim().isEmpty()) {
                log.debug("Cannot send friend request email - recipient {} has no email address", recipient.getUserName());
                return;
            }

            // Determine language preference for recipient from stored locale
            String language = "en";
            boolean isFrench = false;
            
            // Get locale from recipient's Member record (stored when they log in)
            String recipientLocale = recipient.getLocale();
            if (recipientLocale != null && recipientLocale.toLowerCase().startsWith("fr")) {
                isFrench = true;
                language = "fr";
            }
            
            log.debug("Friend request email language for recipient {}: {} (locale: {})", 
                    recipient.getUserName(), language, recipientLocale);
            
            String subject;
            String body;
            if (isFrench) {
                subject = "Nouvelle demande d'ami de " + requester.getFirstName() + " " + requester.getLastName();
                body = generateFriendRequestEmailHtml(requester, recipient, true);
            } else {
                subject = "New friend request from " + requester.getFirstName() + " " + requester.getLastName();
                body = generateFriendRequestEmailHtml(requester, recipient, false);
            }
            
            mailController.sendMailToRecipient(recipient.getAddressEmail(), subject, body, true);
            log.debug("Friend request email sent to {} in language {}", recipient.getAddressEmail(), language);
        } catch (Exception e) {
            log.error("Error sending friend request email to {}: {}", recipient.getAddressEmail(), e.getMessage(), e);
            // Don't throw exception - email failure shouldn't break the friend request
        }
    }

    /**
     * Generate HTML email body for friend request notification
     * @param isFrench true for French, false for English
     */
    private String generateFriendRequestEmailHtml(Member requester, Member recipient, boolean isFrench) {
        // Language-specific strings
        String headerTitle = isFrench ? "Nouvelle Demande d'Ami" : "New Friend Request";
        String greeting = isFrench ? "Bonjour" : "Hello";
        String messageText = isFrench ? 
            " vous a envoyé une demande d'ami." : 
            " has sent you a friend request.";
        String userInfoTitle = isFrench ? "👤 Informations de l'utilisateur" : "👤 User Information";
        String nameLabel = isFrench ? "Nom:" : "Name:";
        String usernameLabel = isFrench ? "Nom d'utilisateur:" : "Username:";
        String emailLabel = isFrench ? "Email:" : "Email:";
        String callToAction = isFrench ? 
            "Connectez-vous à l'application pour accepter ou refuser cette demande d'ami." : 
            "Log in to the application to accept or decline this friend request.";
        String siteUrl = "https://www.patrickdeschamps.com/#/friends";
        String buttonText = isFrench ? "Accéder à l'application" : "Go to Application";
        String footerText1 = isFrench ? 
            "Cet email a été envoyé automatiquement par PatTool." : 
            "This email was automatically sent by PatTool.";
        String footerText2 = isFrench ? 
            "Vous recevez cet email car quelqu'un vous a envoyé une demande d'ami." : 
            "You are receiving this email because someone sent you a friend request.";
        
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
        bodyBuilder.append(".user-info { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }");
        bodyBuilder.append(".user-info h3 { margin: 0 0 15px 0; color: #333; font-weight: 600; }");
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
        bodyBuilder.append("<div class='header-icon'>👤</div>");
        bodyBuilder.append("<h1>").append(escapeHtml(headerTitle)).append("</h1>");
        bodyBuilder.append("</div>");
        
        // Content
        bodyBuilder.append("<div class='content'>");
        bodyBuilder.append("<div class='message'>");
        bodyBuilder.append("<p>").append(escapeHtml(greeting)).append(" <strong>").append(escapeHtml(recipient.getFirstName())).append(" ").append(escapeHtml(recipient.getLastName())).append("</strong>,</p>");
        bodyBuilder.append("<p><strong>").append(escapeHtml(requester.getFirstName())).append(" ").append(escapeHtml(requester.getLastName())).append("</strong>").append(escapeHtml(messageText)).append("</p>");
        bodyBuilder.append("</div>");
        
        // User Information
        bodyBuilder.append("<div class='user-info'>");
        bodyBuilder.append("<h3>").append(escapeHtml(userInfoTitle)).append("</h3>");
        bodyBuilder.append("<div class='info-item'>");
        bodyBuilder.append("<span class='info-label'>").append(escapeHtml(nameLabel)).append("</span>");
        bodyBuilder.append("<span class='info-value'>").append(escapeHtml(requester.getFirstName())).append(" ").append(escapeHtml(requester.getLastName())).append("</span>");
        bodyBuilder.append("</div>");
        bodyBuilder.append("<div class='info-item'>");
        bodyBuilder.append("<span class='info-label'>").append(escapeHtml(usernameLabel)).append("</span>");
        bodyBuilder.append("<span class='info-value'>").append(escapeHtml(requester.getUserName() != null ? requester.getUserName() : "N/A")).append("</span>");
        bodyBuilder.append("</div>");
        if (requester.getAddressEmail() != null) {
            bodyBuilder.append("<div class='info-item'>");
            bodyBuilder.append("<span class='info-label'>").append(escapeHtml(emailLabel)).append("</span>");
            bodyBuilder.append("<span class='info-value'>").append(escapeHtml(requester.getAddressEmail())).append("</span>");
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

    // ========== Friend Groups Methods ==========

    /**
     * Create a new friend group
     */
    public FriendGroup createFriendGroup(String name, List<String> memberIds, Member owner) {
        if (name == null || name.trim().isEmpty()) {
            throw new IllegalArgumentException("Group name cannot be empty");
        }

        // Validate that all memberIds are friends of the owner
        List<Member> members = new java.util.ArrayList<>();
        for (String memberId : memberIds) {
            Optional<Member> memberOpt = membersRepository.findById(memberId);
            if (memberOpt.isEmpty()) {
                throw new IllegalArgumentException("Member not found: " + memberId);
            }
            Member member = memberOpt.get();
            
            // Check if member is a friend of the owner
            if (!areFriends(owner, member)) {
                throw new IllegalStateException("Member " + member.getUserName() + " is not a friend of the owner");
            }
            
            members.add(member);
        }

        FriendGroup group = new FriendGroup();
        group.setName(name.trim());
        group.setMembers(members);
        group.setOwner(owner);
        group.setCreationDate(new Date());

        FriendGroup saved = friendGroupRepository.save(group);
        log.debug("Friend group created: {} by {}", name, owner.getUserName());
        return saved;
    }

    /**
     * Get all friend groups for a user (owned by the user)
     */
    public List<FriendGroup> getFriendGroups(Member owner) {
        return friendGroupRepository.findByOwner(owner);
    }

    /**
     * Get a specific friend group by ID
     */
    public FriendGroup getFriendGroup(String groupId) {
        Optional<FriendGroup> groupOpt = friendGroupRepository.findById(groupId);
        if (groupOpt.isEmpty()) {
            throw new IllegalArgumentException("Friend group not found");
        }
        return groupOpt.get();
    }

    /**
     * Update a friend group
     */
    public FriendGroup updateFriendGroup(String groupId, String name, List<String> memberIds, Member owner) {
        Optional<FriendGroup> groupOpt = friendGroupRepository.findById(groupId);
        if (groupOpt.isEmpty()) {
            throw new IllegalArgumentException("Friend group not found");
        }

        FriendGroup group = groupOpt.get();
        
        // Verify ownership
        if (!group.getOwner().getId().equals(owner.getId())) {
            throw new IllegalStateException("User is not the owner of this group");
        }

        if (name != null && !name.trim().isEmpty()) {
            group.setName(name.trim());
        }

        // Validate and set members
        if (memberIds != null) {
            List<Member> members = new java.util.ArrayList<>();
            for (String memberId : memberIds) {
                Optional<Member> memberOpt = membersRepository.findById(memberId);
                if (memberOpt.isEmpty()) {
                    throw new IllegalArgumentException("Member not found: " + memberId);
                }
                Member member = memberOpt.get();
                
                // Check if member is a friend of the owner
                if (!areFriends(owner, member)) {
                    throw new IllegalStateException("Member " + member.getUserName() + " is not a friend of the owner");
                }
                
                members.add(member);
            }
            group.setMembers(members);
        }

        FriendGroup saved = friendGroupRepository.save(group);
        log.debug("Friend group updated: {} by {}", group.getName(), owner.getUserName());
        return saved;
    }

    /**
     * Delete a friend group
     */
    public void deleteFriendGroup(String groupId, Member owner) {
        Optional<FriendGroup> groupOpt = friendGroupRepository.findById(groupId);
        if (groupOpt.isEmpty()) {
            throw new IllegalArgumentException("Friend group not found");
        }

        FriendGroup group = groupOpt.get();
        
        // Verify ownership
        if (!group.getOwner().getId().equals(owner.getId())) {
            throw new IllegalStateException("User is not the owner of this group");
        }

        friendGroupRepository.delete(group);
        log.debug("Friend group deleted: {} by {}", group.getName(), owner.getUserName());
    }
}

