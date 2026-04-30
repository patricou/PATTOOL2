package com.pat.repo.domain;

import com.fasterxml.jackson.annotation.JsonProperty;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.Date;

/**
 * Configured LAN upstream exposed through authenticated HTTP proxy + optional signed URL for browsers.
 */
@Document(collection = "iot_proxy_targets")
public class IotProxyTarget {

    @Id
    private String id;

    /** Opaque slug used only in URLs (UUID). Immutable after creation. */
    @Indexed(unique = true)
    private String publicSlug;

    private String description;

    /** User key (preferred_username header style) — must match JWT when using Bearer forwarding. */
    private String owner;

    private Date creationDate;
    private Date updateDate;

    /**
     * Base URL of device on LAN, e.g. http://192.168.1.78/ — validated to private/loopback only.
     */
    private String upstreamBaseUrl;

    private String upstreamUsername;

    @JsonProperty(access = JsonProperty.Access.WRITE_ONLY)
    private String upstreamPassword;

    public IotProxyTarget() {}

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getPublicSlug() {
        return publicSlug;
    }

    public void setPublicSlug(String publicSlug) {
        this.publicSlug = publicSlug;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public String getOwner() {
        return owner;
    }

    public void setOwner(String owner) {
        this.owner = owner;
    }

    public Date getCreationDate() {
        return creationDate;
    }

    public void setCreationDate(Date creationDate) {
        this.creationDate = creationDate;
    }

    public Date getUpdateDate() {
        return updateDate;
    }

    public void setUpdateDate(Date updateDate) {
        this.updateDate = updateDate;
    }

    public String getUpstreamBaseUrl() {
        return upstreamBaseUrl;
    }

    public void setUpstreamBaseUrl(String upstreamBaseUrl) {
        this.upstreamBaseUrl = upstreamBaseUrl;
    }

    public String getUpstreamUsername() {
        return upstreamUsername;
    }

    public void setUpstreamUsername(String upstreamUsername) {
        this.upstreamUsername = upstreamUsername;
    }

    public String getUpstreamPassword() {
        return upstreamPassword;
    }

    public void setUpstreamPassword(String upstreamPassword) {
        this.upstreamPassword = upstreamPassword;
    }

    /** Exposed as {@code hasUpstreamPassword} — never exposes the secret. */
    public boolean isHasUpstreamPassword() {
        return upstreamPassword != null && !upstreamPassword.isEmpty();
    }
}
