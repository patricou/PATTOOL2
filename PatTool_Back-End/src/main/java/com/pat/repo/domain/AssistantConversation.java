package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Historique de conversation assistant PatTool, propriété de l’utilisateur ({@link #ownerSubject}
 * = {@code sub} JWT Keycloak).
 */
@Document(collection = "assistant_conversations")
public class AssistantConversation {

    @Id
    private String id;

    /** JWT subject Keycloak */
    private String ownerSubject;

    /** {@code preferred_username} JWT à la création (affichage UI ; peut être null pour les anciens documents). */
    private String ownerPreferredUsername;

    private Instant createdAt;
    private Instant updatedAt;

    /** {@code openai}, {@code anthropic} ou {@code gemini} */
    private String routingProvider;

    /** Libellé fournisseur (réponse API ou défaut UI) */
    private String providerLabel;

    /** Modèle effectif */
    private String model;

    private List<AssistantConversationTurn> turns = new ArrayList<>();

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

    public String getOwnerPreferredUsername() {
        return ownerPreferredUsername;
    }

    public void setOwnerPreferredUsername(String ownerPreferredUsername) {
        this.ownerPreferredUsername = ownerPreferredUsername;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(Instant createdAt) {
        this.createdAt = createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(Instant updatedAt) {
        this.updatedAt = updatedAt;
    }

    public String getRoutingProvider() {
        return routingProvider;
    }

    public void setRoutingProvider(String routingProvider) {
        this.routingProvider = routingProvider;
    }

    public String getProviderLabel() {
        return providerLabel;
    }

    public void setProviderLabel(String providerLabel) {
        this.providerLabel = providerLabel;
    }

    public String getModel() {
        return model;
    }

    public void setModel(String model) {
        this.model = model;
    }

    public List<AssistantConversationTurn> getTurns() {
        return turns;
    }

    public void setTurns(List<AssistantConversationTurn> turns) {
        this.turns = turns != null ? turns : new ArrayList<>();
    }
}
