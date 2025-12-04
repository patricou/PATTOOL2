package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.DBRef;
import org.springframework.data.mongodb.core.mapping.Document;

import jakarta.validation.constraints.NotNull;
import java.util.Date;

@Document(collection = "friendRequests")
public class FriendRequest {
    
    @Id
    private String id;
    
    @NotNull
    @DBRef
    private Member requester;
    
    @NotNull
    @DBRef
    private Member recipient;
    
    @NotNull
    private String status; // PENDING, ACCEPTED, REJECTED
    
    @NotNull
    private Date requestDate;
    
    private Date responseDate;

    public FriendRequest() {
    }

    public FriendRequest(Member requester, Member recipient, String status, Date requestDate) {
        this.requester = requester;
        this.recipient = recipient;
        this.status = status;
        this.requestDate = requestDate;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public Member getRequester() {
        return requester;
    }

    public void setRequester(Member requester) {
        this.requester = requester;
    }

    public Member getRecipient() {
        return recipient;
    }

    public void setRecipient(Member recipient) {
        this.recipient = recipient;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public Date getRequestDate() {
        return requestDate;
    }

    public void setRequestDate(Date requestDate) {
        this.requestDate = requestDate;
    }

    public Date getResponseDate() {
        return responseDate;
    }

    public void setResponseDate(Date responseDate) {
        this.responseDate = responseDate;
    }
}

