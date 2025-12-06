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

    public UserConnectionLog() {
    }

    public UserConnectionLog(Member member, Date connectionDate, String ipAddress, String domainName, String location) {
        this.member = member;
        this.connectionDate = connectionDate;
        this.ipAddress = ipAddress;
        this.domainName = domainName;
        this.location = location;
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
}

