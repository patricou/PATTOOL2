package com.pat.repo.domain;

import jakarta.validation.constraints.NotNull;
import java.util.Date;

/**
 * UrlEvent entity for storing event-related URLs
 * Created for PatTool application
 * Note: This is an embedded document, not a separate collection
 */
public class UrlEvent {
    
    @NotNull
    private String typeUrl;
    
    @NotNull
    private Date dateCreation;
    
    @NotNull
    private String owner;
    
    @NotNull
    private String link;
    
    private String urlDescription;

    // Constructors
    public UrlEvent() {
    }

    public UrlEvent(String typeUrl, Date dateCreation, String owner, String link, String urlDescription) {
        this.typeUrl = typeUrl;
        this.dateCreation = dateCreation;
        this.owner = owner;
        this.link = link;
        this.urlDescription = urlDescription;
    }


    // Getters and Setters
    public String getTypeUrl() {
        return typeUrl;
    }

    public void setTypeUrl(String typeUrl) {
        this.typeUrl = typeUrl;
    }

    public Date getDateCreation() {
        return dateCreation;
    }

    public void setDateCreation(Date dateCreation) {
        this.dateCreation = dateCreation;
    }

    public String getOwner() {
        return owner;
    }

    public void setOwner(String owner) {
        this.owner = owner;
    }

    public String getLink() {
        return link;
    }

    public void setLink(String link) {
        this.link = link;
    }

    public String getUrlDescription() {
        return urlDescription;
    }

    public void setUrlDescription(String urlDescription) {
        this.urlDescription = urlDescription;
    }

    @Override
    public String toString() {
        return "UrlEvent{" +
                "typeUrl='" + typeUrl + '\'' +
                ", dateCreation=" + dateCreation +
                ", owner='" + owner + '\'' +
                ", link='" + link + '\'' +
                ", urlDescription='" + urlDescription + '\'' +
                '}';
    }
}
