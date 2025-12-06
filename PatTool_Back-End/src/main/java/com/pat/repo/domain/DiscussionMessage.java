package com.pat.repo.domain;

import org.springframework.data.mongodb.core.mapping.DBRef;

import jakarta.validation.constraints.NotNull;
import java.util.Date;

/**
 * DiscussionMessage entity for messages within a discussion
 * Created for PatTool application
 */
public class DiscussionMessage {

    private String id; // Unique ID for the message

    @NotNull
    @DBRef
    private Member author;

    @NotNull
    private Date dateTime;

    private String message; // Text message (optional if image or video is present)

    private String imageUrl; // URL or path to image (optional)

    private String videoUrl; // URL or path to video (optional)

    private String imageFileName; // Original image filename

    private String videoFileName; // Original video filename

    // Constructors
    public DiscussionMessage() {
        this.dateTime = new Date();
    }

    public DiscussionMessage(Member author, String message) {
        this.author = author;
        this.message = message;
        this.dateTime = new Date();
    }

    public DiscussionMessage(Member author, String message, String imageUrl, String imageFileName) {
        this.author = author;
        this.message = message;
        this.imageUrl = imageUrl;
        this.imageFileName = imageFileName;
        this.dateTime = new Date();
    }

    public DiscussionMessage(Member author, String message, String videoUrl, String videoFileName, boolean isVideo) {
        this.author = author;
        this.message = message;
        if (isVideo) {
            this.videoUrl = videoUrl;
            this.videoFileName = videoFileName;
        } else {
            this.imageUrl = videoUrl; // Reuse parameter for image
            this.imageFileName = videoFileName;
        }
        this.dateTime = new Date();
    }

    // Getters and Setters
    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public Member getAuthor() {
        return author;
    }

    public void setAuthor(Member author) {
        this.author = author;
    }

    public Date getDateTime() {
        return dateTime;
    }

    public void setDateTime(Date dateTime) {
        this.dateTime = dateTime;
    }

    public String getMessage() {
        return message;
    }

    public void setMessage(String message) {
        this.message = message;
    }

    public String getImageUrl() {
        return imageUrl;
    }

    public void setImageUrl(String imageUrl) {
        this.imageUrl = imageUrl;
    }

    public String getVideoUrl() {
        return videoUrl;
    }

    public void setVideoUrl(String videoUrl) {
        this.videoUrl = videoUrl;
    }

    public String getImageFileName() {
        return imageFileName;
    }

    public void setImageFileName(String imageFileName) {
        this.imageFileName = imageFileName;
    }

    public String getVideoFileName() {
        return videoFileName;
    }

    public void setVideoFileName(String videoFileName) {
        this.videoFileName = videoFileName;
    }

    public boolean hasImage() {
        return imageUrl != null && !imageUrl.isEmpty();
    }

    public boolean hasVideo() {
        return videoUrl != null && !videoUrl.isEmpty();
    }

    @Override
    public String toString() {
        return "DiscussionMessage{" +
                "id='" + id + '\'' +
                ", author=" + (author != null ? author.getUserName() : "null") +
                ", dateTime=" + dateTime +
                ", message='" + message + '\'' +
                ", imageUrl='" + imageUrl + '\'' +
                ", videoUrl='" + videoUrl + '\'' +
                '}';
    }
}

