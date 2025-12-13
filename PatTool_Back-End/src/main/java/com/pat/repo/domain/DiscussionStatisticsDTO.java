package com.pat.repo.domain;

import java.util.List;

/**
 * DTO for discussion statistics per user
 */
public class DiscussionStatisticsDTO {
    private String userId;
    private String userName;
    private String firstName;
    private String lastName;
    private Long totalDiscussions;
    private List<DiscussionAccessInfo> discussions;
    
    public DiscussionStatisticsDTO() {
    }
    
    public DiscussionStatisticsDTO(String userId, String userName, String firstName, String lastName, Long totalDiscussions, List<DiscussionAccessInfo> discussions) {
        this.userId = userId;
        this.userName = userName;
        this.firstName = firstName;
        this.lastName = lastName;
        this.totalDiscussions = totalDiscussions;
        this.discussions = discussions;
    }
    
    public static class DiscussionAccessInfo {
        private String discussionId;
        private String discussionTitle;
        private String type; // "general", "event", "friendGroup"
        private List<String> accessReasons; // e.g., "public", "owner", "creator", "member", "authorized", "friend"
        private String eventName;
        private String friendGroupName;
        
        public DiscussionAccessInfo() {
        }
        
        public DiscussionAccessInfo(String discussionId, String discussionTitle, String type, List<String> accessReasons) {
            this.discussionId = discussionId;
            this.discussionTitle = discussionTitle;
            this.type = type;
            this.accessReasons = accessReasons;
        }
        
        // Getters and setters
        public String getDiscussionId() {
            return discussionId;
        }
        
        public void setDiscussionId(String discussionId) {
            this.discussionId = discussionId;
        }
        
        public String getDiscussionTitle() {
            return discussionTitle;
        }
        
        public void setDiscussionTitle(String discussionTitle) {
            this.discussionTitle = discussionTitle;
        }
        
        public String getType() {
            return type;
        }
        
        public void setType(String type) {
            this.type = type;
        }
        
        public List<String> getAccessReasons() {
            return accessReasons;
        }
        
        public void setAccessReasons(List<String> accessReasons) {
            this.accessReasons = accessReasons;
        }
        
        public String getEventName() {
            return eventName;
        }
        
        public void setEventName(String eventName) {
            this.eventName = eventName;
        }
        
        public String getFriendGroupName() {
            return friendGroupName;
        }
        
        public void setFriendGroupName(String friendGroupName) {
            this.friendGroupName = friendGroupName;
        }
    }
    
    // Getters and setters
    public String getUserId() {
        return userId;
    }
    
    public void setUserId(String userId) {
        this.userId = userId;
    }
    
    public String getUserName() {
        return userName;
    }
    
    public void setUserName(String userName) {
        this.userName = userName;
    }
    
    public String getFirstName() {
        return firstName;
    }
    
    public void setFirstName(String firstName) {
        this.firstName = firstName;
    }
    
    public String getLastName() {
        return lastName;
    }
    
    public void setLastName(String lastName) {
        this.lastName = lastName;
    }
    
    public Long getTotalDiscussions() {
        return totalDiscussions;
    }
    
    public void setTotalDiscussions(Long totalDiscussions) {
        this.totalDiscussions = totalDiscussions;
    }
    
    public List<DiscussionAccessInfo> getDiscussions() {
        return discussions;
    }
    
    public void setDiscussions(List<DiscussionAccessInfo> discussions) {
        this.discussions = discussions;
    }
}

