package com.pat.service;

import com.pat.controller.dto.AssistantChatRequestDto;
import com.pat.controller.dto.AssistantChatResponseDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * Routage de l’assistant latéral selon {@code assistant.provider} ({@code openai} par défaut,
 * {@code anthropic} pour Claude, {@code gemini} pour Google Gemini).
 */
@Service
public class RoutingAssistantService {

    private static final Logger log = LoggerFactory.getLogger(RoutingAssistantService.class);

    @Value("${assistant.provider:openai}")
    private String assistantProvider;

    private final OpenAiAssistantService openAiAssistantService;
    private final AnthropicAssistantService anthropicAssistantService;
    private final GeminiAssistantService geminiAssistantService;

    public RoutingAssistantService(
            OpenAiAssistantService openAiAssistantService,
            AnthropicAssistantService anthropicAssistantService,
            GeminiAssistantService geminiAssistantService) {
        this.openAiAssistantService = openAiAssistantService;
        this.anthropicAssistantService = anthropicAssistantService;
        this.geminiAssistantService = geminiAssistantService;
    }

    public AssistantChatResponseDto complete(AssistantChatRequestDto request) {
        String slug = resolveEffectiveSlug(request);
        log.debug(
                "Assistant chat routing: effectiveSlug={} requestProvider={} serverPropertyAssistantProvider={}",
                slug,
                request != null ? request.provider() : null,
                assistantProvider);
        return switch (slug) {
            case "anthropic" -> anthropicAssistantService.complete(request);
            case "gemini" -> geminiAssistantService.complete(request);
            default -> openAiAssistantService.complete(request);
        };
    }

    public String getConfiguredProviderLabel() {
        return switch (configuredServerSlug()) {
            case "anthropic" -> anthropicAssistantService.getConfiguredProviderLabel();
            case "gemini" -> geminiAssistantService.getConfiguredProviderLabel();
            default -> openAiAssistantService.getConfiguredProviderLabel();
        };
    }

    public String getConfiguredModel() {
        return switch (configuredServerSlug()) {
            case "anthropic" -> anthropicAssistantService.getConfiguredModel();
            case "gemini" -> geminiAssistantService.getConfiguredModel();
            default -> openAiAssistantService.getConfiguredModel();
        };
    }

    /** {@code openai}, {@code anthropic} ou {@code gemini}, jamais vide (défaut {@code openai}). */
    public String getConfiguredRoutingSlug() {
        return configuredServerSlug();
    }

    /**
     * Modèle configuré dans {@code application.properties} pour le fournisseur donné
     * (indépendamment de {@code assistant.provider}).
     */
    public String getDefaultModelForRoutingSlug(String slug) {
        String s = normalizeRoutingSlug(slug);
        if (s == null) {
            s = "openai";
        }
        return switch (s) {
            case "anthropic" -> anthropicAssistantService.getConfiguredModel();
            case "gemini" -> geminiAssistantService.getConfiguredModel();
            default -> openAiAssistantService.getConfiguredModel();
        };
    }

    private String resolveEffectiveSlug(AssistantChatRequestDto request) {
        String fromReq = normalizeRoutingSlug(request != null ? request.provider() : null);
        if (fromReq != null) {
            return fromReq;
        }
        return configuredServerSlug();
    }

    private String configuredServerSlug() {
        return normalizeAssistantProviderProperty(assistantProvider);
    }

    /**
     * Valeur de {@code assistant.provider} : {@code openai} (défaut), {@code anthropic}/{@code claude},
     * {@code gemini}/{@code google}.
     */
    static String normalizeAssistantProviderProperty(String assistantProvider) {
        if (assistantProvider == null || assistantProvider.isBlank()) {
            return "openai";
        }
        String p = assistantProvider.trim().toLowerCase();
        if ("anthropic".equals(p) || "claude".equals(p)) {
            return "anthropic";
        }
        if ("gemini".equals(p) || "google".equals(p)) {
            return "gemini";
        }
        return "openai";
    }

    /**
     * Valeur reconnue pour le corps de requête : {@code openai}, {@code anthropic}, {@code claude}
     * (alias), {@code gemini}, {@code google} (alias). Toute autre valeur est ignorée pour retomber sur
     * la config serveur.
     */
    static String normalizeRoutingSlug(String provider) {
        if (provider == null || provider.isBlank()) {
            return null;
        }
        String p = provider.trim().toLowerCase();
        if ("claude".equals(p) || "anthropic".equals(p)) {
            return "anthropic";
        }
        if ("gemini".equals(p) || "google".equals(p)) {
            return "gemini";
        }
        if ("openai".equals(p)) {
            return "openai";
        }
        return null;
    }
}
