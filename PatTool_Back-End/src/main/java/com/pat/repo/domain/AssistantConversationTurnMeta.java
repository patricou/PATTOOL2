package com.pat.repo.domain;

/**
 * Métadonnées optionnelles d’un tour « assistant » (tokens, durée, fournisseur / modèle effectifs).
 */
public class AssistantConversationTurnMeta {

    private Integer elapsedMs;
    private Integer inputTokens;
    private Integer outputTokens;
    private String provider;
    private String model;

    public Integer getElapsedMs() {
        return elapsedMs;
    }

    public void setElapsedMs(Integer elapsedMs) {
        this.elapsedMs = elapsedMs;
    }

    public Integer getInputTokens() {
        return inputTokens;
    }

    public void setInputTokens(Integer inputTokens) {
        this.inputTokens = inputTokens;
    }

    public Integer getOutputTokens() {
        return outputTokens;
    }

    public void setOutputTokens(Integer outputTokens) {
        this.outputTokens = outputTokens;
    }

    public String getProvider() {
        return provider;
    }

    public void setProvider(String provider) {
        this.provider = provider;
    }

    public String getModel() {
        return model;
    }

    public void setModel(String model) {
        this.model = model;
    }
}
