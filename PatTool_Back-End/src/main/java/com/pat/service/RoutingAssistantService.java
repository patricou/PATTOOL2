package com.pat.service;

import com.pat.controller.dto.AssistantChatRequestDto;
import com.pat.controller.dto.AssistantChatResponseDto;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * Routage de l’assistant latéral selon {@code assistant.provider} ({@code openai} par défaut,
 * {@code anthropic} pour Claude).
 */
@Service
public class RoutingAssistantService {

    @Value("${assistant.provider:openai}")
    private String assistantProvider;

    private final OpenAiAssistantService openAiAssistantService;
    private final AnthropicAssistantService anthropicAssistantService;

    public RoutingAssistantService(
            OpenAiAssistantService openAiAssistantService,
            AnthropicAssistantService anthropicAssistantService) {
        this.openAiAssistantService = openAiAssistantService;
        this.anthropicAssistantService = anthropicAssistantService;
    }

    public AssistantChatResponseDto complete(AssistantChatRequestDto request) {
        if (effectiveAnthropic(request)) {
            return anthropicAssistantService.complete(request);
        }
        return openAiAssistantService.complete(request);
    }

    public String getConfiguredProviderLabel() {
        if (configuredAnthropic()) {
            return anthropicAssistantService.getConfiguredProviderLabel();
        }
        return openAiAssistantService.getConfiguredProviderLabel();
    }

    public String getConfiguredModel() {
        if (configuredAnthropic()) {
            return anthropicAssistantService.getConfiguredModel();
        }
        return openAiAssistantService.getConfiguredModel();
    }

    /** {@code openai} ou {@code anthropic}, jamais vide (défaut {@code openai}). */
    public String getConfiguredRoutingSlug() {
        return configuredAnthropic() ? "anthropic" : "openai";
    }

    private boolean effectiveAnthropic(AssistantChatRequestDto request) {
        String slug = normalizeRoutingSlug(request != null ? request.provider() : null);
        if ("openai".equals(slug)) {
            return false;
        }
        if ("anthropic".equals(slug)) {
            return true;
        }
        return configuredAnthropic();
    }

    private boolean configuredAnthropic() {
        return isAnthropicProperty(assistantProvider);
    }

    /**
     * Valeur reconnue pour le corps de requête : {@code openai}, {@code anthropic}, {@code claude}
     * (alias). Toute autre valeur est ignorée pour retomber sur la config serveur.
     */
    static String normalizeRoutingSlug(String provider) {
        if (provider == null || provider.isBlank()) {
            return null;
        }
        String p = provider.trim().toLowerCase();
        if ("claude".equals(p) || "anthropic".equals(p)) {
            return "anthropic";
        }
        if ("openai".equals(p)) {
            return "openai";
        }
        return null;
    }

    static boolean isAnthropicProperty(String assistantProvider) {
        if (assistantProvider == null) {
            return false;
        }
        String p = assistantProvider.trim();
        return p.equalsIgnoreCase("anthropic") || p.equalsIgnoreCase("claude");
    }
}
