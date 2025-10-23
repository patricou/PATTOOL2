package com.pat.repo.domain;

import org.springframework.data.mongodb.core.mapping.DBRef;
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
    @DBRef
    private Member owner;
    
    @NotNull
    private String commentary;
    
    @NotNull
    private Date dateCreation;

    // Constructors
    public Commentary() {
    }

    public Commentary(Member owner, String commentary, Date dateCreation) {
        this.owner = owner;
        this.commentary = commentary;
        this.dateCreation = dateCreation;
    }

    // Getters and Setters
    public Member getOwner() {
        return owner;
    }

    public void setOwner(Member owner) {
        this.owner = owner;
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
                "owner=" + owner +
                ", commentary='" + commentary + '\'' +
                ", dateCreation=" + dateCreation +
                '}';
    }
}
