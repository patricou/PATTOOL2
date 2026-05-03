package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record AssistantChatResponseDto(
        String id,
        String model,
        /** Libellé fournisseur (ex. configuré dans {@code openai.provider}) */
        String provider,
        String role,
        String content,
        String error,
        Integer inputTokens,
        Integer outputTokens,
        /** Temps entre l’envoi HTTP vers OpenAI et la réponse reçue (ms), côté serveur PatTool */
        Integer elapsedMs
) {
    public static AssistantChatResponseDto ok(String id, String model, String provider, String role, String content,
                                            Integer inputTokens, Integer outputTokens) {
        return new AssistantChatResponseDto(id, model, provider, role, content, null, inputTokens, outputTokens, null);
    }

    public static AssistantChatResponseDto okTimed(String id, String model, String provider, String role, String content,
                                                   Integer inputTokens, Integer outputTokens, int elapsedMs) {
        return new AssistantChatResponseDto(id, model, provider, role, content, null, inputTokens, outputTokens,
                elapsedMs);
    }

    public static AssistantChatResponseDto err(String message) {
        return new AssistantChatResponseDto(null, null, null, null, null, message, null, null, null);
    }
}
