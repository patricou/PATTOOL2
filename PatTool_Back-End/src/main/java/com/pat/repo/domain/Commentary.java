package com.pat.repo.domain;

import org.springframework.data.mongodb.core.mapping.Document;

import jakarta.validation.constraints.NotNull;
import java.util.Date;

/**
 * Commentary entity for Evenement comments
 * Created for PatTool application
 */
@Document(collection = "commentaries")
public class Commentary {

    @NotNull
    private String commentOwner;
    
    @NotNull
    private String commentary;
    
    @NotNull
    private Date dateCreation;

    // Constructors
    public Commentary() {
    }

    public Commentary(String commentOwner, String commentary, Date dateCreation) {
        this.commentOwner = commentOwner;
        this.commentary = commentary;
        this.dateCreation = dateCreation;
    }

    // Getters and Setters
    public String getCommentOwner() {
        return commentOwner;
    }

    public void setCommentOwner(String commentOwner) {
        this.commentOwner = commentOwner;
    }

    public String getCommentary() {
        return commentary;
    }

    public void setCommentary(String commentary) {
        this.commentary = commentary;
    }

    public Date getDateCreation() {
        return dateCreation;
    }

    public void setDateCreation(Date dateCreation) {
        this.dateCreation = dateCreation;
    }

    @Override
    public String toString() {
        return "Commentary{" +
                "commentOwner='" + commentOwner + '\'' +
                ", commentary='" + commentary + '\'' +
                ", dateCreation=" + dateCreation +
                '}';
    }
}
