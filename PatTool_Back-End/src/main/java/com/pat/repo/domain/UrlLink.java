package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.DBRef;
import org.springframework.data.mongodb.core.mapping.Document;

import jakarta.validation.constraints.NotNull;

@Document(collection = "urllink")
public class UrlLink {
    @Id
    private String id;
    private String urlLinkID;
    @NotNull
    private String linkDescription;
    @NotNull
    private String linkName;
    @NotNull
    private String url;
    @NotNull
    private String categoryLinkID;
    @NotNull
    private String visibility;
    /** When true, opening the link uses the IoT LAN proxy signed URL (same path as proxy "open in browser"). */
    private boolean openByProxyLan;
    @NotNull
    @DBRef
    private Member author;

    public UrlLink() {}

public UrlLink(String id, String urlLinkID, String linkDescription, String linkName, String url, String categoryLinkID, String visibility, boolean openByProxyLan, Member author) {
        this.id = id;
        this.urlLinkID = urlLinkID;
        this.linkDescription = linkDescription;
        this.linkName = linkName;
        this.url = url;
        this.categoryLinkID = categoryLinkID;
        this.visibility = visibility;
        this.openByProxyLan = openByProxyLan;
        this.author = author;
    }

    @Override
    public String toString() {
        return "UrlLink{" +
                "id='" + id + '\'' +
                ", urlLinkID='" + urlLinkID + '\'' +
                ", linkDescription='" + linkDescription + '\'' +
                ", linkName='" + linkName + '\'' +
                ", url='" + url + '\'' +
                ", categoryLinkID='" + categoryLinkID + '\'' +
                ", visibility='" + visibility + '\'' +
                ", openByProxyLan=" + openByProxyLan +
                ", author=" + author +
                '}';
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getUrlLinkID() {
        return urlLinkID;
    }

    public void setUrlLinkID(String urlLinkID) {
        this.urlLinkID = urlLinkID;
    }

    public String getLinkDescription() {
        return linkDescription;
    }

    public void setLinkDescription(String linkDescription) {
        this.linkDescription = linkDescription;
    }

    public String getLinkName() {
        return linkName;
    }

    public void setLinkName(String linkName) {
        this.linkName = linkName;
    }

    public String getUrl() {
        return url;
    }

    public void setUrl(String url) {
        this.url = url;
    }

    public String getCategoryLinkID() {
        return categoryLinkID;
    }

    public void setCategoryLinkID(String categoryLinkID) {
        this.categoryLinkID = categoryLinkID;
    }

    public String getVisibility() {
        return visibility;
    }

    public void setVisibility(String visibility) {
        this.visibility = visibility;
    }

    public boolean isOpenByProxyLan() {
        return openByProxyLan;
    }

    public void setOpenByProxyLan(boolean openByProxyLan) {
        this.openByProxyLan = openByProxyLan;
    }

    public Member getAuthor() {
        return author;
    }

    public void setAuthor(Member author) {
        this.author = author;
    }
}
