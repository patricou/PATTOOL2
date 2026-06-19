package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Valeurs par défaut côté serveur : libellés + routage ({@code openai}, {@code anthropic}, {@code gemini}
 * ou {@code mistral}, selon {@code assistant.provider}).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AssistantClientConfigDto(
        String provider,
        String model,
        /** {@code openai}, {@code anthropic}, {@code gemini} ou {@code mistral} — état configuré dans application.properties. */
        String routingDefault,
        /** Préférence utilisateur persistée (Mongo {@code appParameters}) ; absent si jamais enregistrée. */
        AssistantRoutingPreferenceDto persistedRouting,
        /** Valeur {@code openai.assistant.model} (non sensible). */
        String openaiDefaultModel,
        /** Valeur {@code anthropic.model} (non sensible). */
        String anthropicDefaultModel,
        /** Valeur {@code gemini.model} (non sensible). */
        String geminiDefaultModel,
        /** Valeur {@code mistral.model} (non sensible). */
        String mistralDefaultModel,
        /**
         * Liens du bandeau assistant (voir {@code assistant.billing.openai-billing-url},
         * {@code assistant.billing.openai-usage-url}).
         */
        String billingOpenaiBillingUrl,
        String billingOpenaiUsageUrl,
        /** {@code assistant.billing.anthropic-url}. */
        String billingAnthropicUrl,
        /** {@code assistant.billing.gemini-rate-limit-url} — quotas / consommation. */
        String billingGeminiRateLimitUrl,
        /** {@code assistant.billing.gemini-api-keys-url}. */
        String billingGeminiApiKeysUrl,
        /** {@code assistant.billing.mistral-url}. */
        String billingMistralUrl,
        /** {@code gemini.image-generation-model} (non sensible). */
        String geminiImageGenerationModel) {}
