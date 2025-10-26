package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import jakarta.validation.constraints.NotNull;

@Document(collection = "categorylink")
public class CategoryLink {
    @Id
    private String id;
    @NotNull
    private String categoryLinkID;
    @NotNull
    private String categoryName;
    @NotNull
    private String categoryDescription;

    // Default constructor for MongoDB
    public CategoryLink() {
    }

    public CategoryLink(String categoryLinkID, String categoryName, String categoryDescription) {
        this.categoryLinkID = categoryLinkID;
        this.categoryName = categoryName;
        this.categoryDescription = categoryDescription;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getCategoryLinkID() {
        return categoryLinkID;
    }

    public void setCategoryLinkID(String categoryLinkID) {
        this.categoryLinkID = categoryLinkID;
    }

    public String getCategoryName() {
        return categoryName;
    }

    public void setCategoryName(String categoryName) {
        this.categoryName = categoryName;
    }

    public String getCategoryDescription() {
        return categoryDescription;
    }

    public void setCategoryDescription(String categoryDescription) {
        this.categoryDescription = categoryDescription;
    }
}
