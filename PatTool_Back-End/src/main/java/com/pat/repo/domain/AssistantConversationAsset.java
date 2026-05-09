package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

/**
 * Image générée par l’assistant, stockée hors document de conversation pour éviter les payloads JSON énormes.
 */
@Document(collection = "assistant_conversation_assets")
public class AssistantConversationAsset {

    @Id
    private String id;

    /** JWT subject Keycloak — seul le propriétaire peut lire ou supprimer l’asset. */
    private String ownerSubject;

    private String mimeType;

    private byte[] data;

    private Instant createdAt;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getOwnerSubject() {
        return ownerSubject;
    }

    public void setOwnerSubject(String ownerSubject) {
        this.ownerSubject = ownerSubject;
    }

    public String getMimeType() {
        return mimeType;
    }

    public void setMimeType(String mimeType) {
        this.mimeType = mimeType;
    }

    public byte[] getData() {
        return data;
    }

    public void setData(byte[] data) {
        this.data = data;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(Instant createdAt) {
        this.createdAt = createdAt;
    }
}
