package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.DBRef;
import org.springframework.data.mongodb.core.mapping.Document;

import jakarta.validation.constraints.NotNull;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * Discussion entity for user discussions
 * Created for PatTool application
 */
@Document(collection = "discussions")
public class Discussion {

    @Id
    private String id;

    @NotNull
    @DBRef
    private Member createdBy;

    @NotNull
    private Date creationDate;

    private String title; // Optional title for the discussion

    private List<DiscussionMessage> messages = new ArrayList<>();

    // Constructors
    public Discussion() {
        this.creationDate = new Date();
    }

    public Discussion(Member createdBy, String title) {
        this.createdBy = createdBy;
        this.title = title;
        this.creationDate = new Date();
        this.messages = new ArrayList<>();
    }

    // Getters and Setters
    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public Member getCreatedBy() {
        return createdBy;
    }

    public void setCreatedBy(Member createdBy) {
        this.createdBy = createdBy;
    }

    public Date getCreationDate() {
        return creationDate;
    }

    public void setCreationDate(Date creationDate) {
        this.creationDate = creationDate;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public List<DiscussionMessage> getMessages() {
        return messages;
    }

    public void setMessages(List<DiscussionMessage> messages) {
        this.messages = messages;
    }

    @Override
    public String toString() {
        return "Discussion{" +
                "id='" + id + '\'' +
                ", createdBy=" + (createdBy != null ? createdBy.getUserName() : "null") +
                ", creationDate=" + creationDate +
                ", title='" + title + '\'' +
                ", messagesCount=" + (messages != null ? messages.size() : 0) +
                '}';
    }
}

