package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Valeurs par défaut côté serveur : libellés + routage ({@code openai}, {@code anthropic} ou {@code gemini},
 * selon {@code assistant.provider}).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AssistantClientConfigDto(
        String provider,
        String model,
        /** {@code openai}, {@code anthropic} ou {@code gemini} — état configuré dans application.properties. */
        String routingDefault,
        /** Préférence utilisateur persistée (Mongo {@code appParameters}) ; absent si jamais enregistrée. */
        AssistantRoutingPreferenceDto persistedRouting) {}
