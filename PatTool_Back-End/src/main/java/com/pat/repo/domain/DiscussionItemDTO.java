package com.pat.repo.domain;

/**
 * DTO for discussion items returned to the frontend
 * Contains discussion information along with associated event or friend group
 */
public class DiscussionItemDTO {
    private String id;
    private String title;
    private String type; // "general", "event", or "friendGroup"
    private Discussion discussion;
    private Evenement event;
    private FriendGroup friendGroup;
    private Long messageCount;
    private java.util.Date lastMessageDate;

    public DiscussionItemDTO() {
    }

    public DiscussionItemDTO(String id, String title, String type, Discussion discussion) {
        this.id = id;
        this.title = title;
        this.type = type;
        this.discussion = discussion;
    }

    // Getters and Setters
    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public Discussion getDiscussion() {
        return discussion;
    }

    public void setDiscussion(Discussion discussion) {
        this.discussion = discussion;
    }

    public Evenement getEvent() {
        return event;
    }

    public void setEvent(Evenement event) {
        this.event = event;
    }

    public FriendGroup getFriendGroup() {
        return friendGroup;
    }

    public void setFriendGroup(FriendGroup friendGroup) {
        this.friendGroup = friendGroup;
    }

    public Long getMessageCount() {
        return messageCount;
    }

    public void setMessageCount(Long messageCount) {
        this.messageCount = messageCount;
    }

    public java.util.Date getLastMessageDate() {
        return lastMessageDate;
    }

    public void setLastMessageDate(java.util.Date lastMessageDate) {
        this.lastMessageDate = lastMessageDate;
    }
}

