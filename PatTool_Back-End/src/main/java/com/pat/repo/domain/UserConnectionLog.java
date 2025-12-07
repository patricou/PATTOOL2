package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.DBRef;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.Date;

/**
 * User connection log entity
 * Stores information about each user connection: member, date/time, IP, domain name, and location
 */
@Document(collection = "userConnectionLogs")
public class UserConnectionLog {

    @Id
    private String id;

    @DBRef
    private Member member;

    private Date connectionDate;

    private String ipAddress;

    private String domainName;

    private String location;

    private String type; // "login" or "discussion"

    private String discussionId; // ID of the discussion (if type is "discussion")

    private String discussionTitle; // Title of the discussion (if type is "discussion")

    public UserConnectionLog() {
    }

    public UserConnectionLog(Member member, Date connectionDate, String ipAddress, String domainName, String location) {
        this.member = member;
        this.connectionDate = connectionDate;
        this.ipAddress = ipAddress;
        this.domainName = domainName;
        this.location = location;
        this.type = "login"; // Default to login for backward compatibility
    }

    public UserConnectionLog(Member member, Date connectionDate, String ipAddress, String domainName, String location, String type, String discussionId, String discussionTitle) {
        this.member = member;
        this.connectionDate = connectionDate;
        this.ipAddress = ipAddress;
        this.domainName = domainName;
        this.location = location;
        this.type = type;
        this.discussionId = discussionId;
        this.discussionTitle = discussionTitle;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public Member getMember() {
        return member;
    }

    public void setMember(Member member) {
        this.member = member;
    }

    public Date getConnectionDate() {
        return connectionDate;
    }

    public void setConnectionDate(Date connectionDate) {
        this.connectionDate = connectionDate;
    }

    public String getIpAddress() {
        return ipAddress;
    }

    public void setIpAddress(String ipAddress) {
        this.ipAddress = ipAddress;
    }

    public String getDomainName() {
        return domainName;
    }

    public void setDomainName(String domainName) {
        this.domainName = domainName;
    }

    public String getLocation() {
        return location;
    }

    public void setLocation(String location) {
        this.location = location;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

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
}

