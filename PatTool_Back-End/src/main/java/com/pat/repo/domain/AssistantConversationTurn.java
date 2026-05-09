package com.pat.repo.domain;

import java.util.ArrayList;
import java.util.List;

/**
 * Tour de conversation embarqué (utilisateur ou assistant).
 * Les images utilisateur peuvent être stockées en data URL dans {@link #imageDataUrl}.
 * Les images générées par le modèle sont référencées par {@link #generatedImageAssetIds}
 * ({@link AssistantConversationAsset}), le texte restant dans {@link #content}.
 */
public class AssistantConversationTurn {

    private String role;
    private String content;
    private Boolean hasImage;
    private String imageDataUrl;
    private AssistantConversationTurnMeta meta;

    /** IDs Mongo {@link AssistantConversationAsset}, ordre conservé. */
    private List<String> generatedImageAssetIds = new ArrayList<>();

    public String getRole() {
        return role;
    }

    public void setRole(String role) {
        this.role = role;
    }

    public String getContent() {
        return content;
    }

    public void setContent(String content) {
        this.content = content;
    }

    public Boolean getHasImage() {
        return hasImage;
    }

    public void setHasImage(Boolean hasImage) {
        this.hasImage = hasImage;
    }

    public String getImageDataUrl() {
        return imageDataUrl;
    }

    public void setImageDataUrl(String imageDataUrl) {
        this.imageDataUrl = imageDataUrl;
    }

    public AssistantConversationTurnMeta getMeta() {
        return meta;
    }

    public void setMeta(AssistantConversationTurnMeta meta) {
        this.meta = meta;
    }

    public List<String> getGeneratedImageAssetIds() {
        return generatedImageAssetIds;
    }

    public void setGeneratedImageAssetIds(List<String> generatedImageAssetIds) {
        this.generatedImageAssetIds =
                generatedImageAssetIds != null ? generatedImageAssetIds : new ArrayList<>();
    }
}
