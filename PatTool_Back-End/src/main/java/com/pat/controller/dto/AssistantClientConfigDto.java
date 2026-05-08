package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Valeurs par défaut côté serveur : libellés + routage ({@code openai} ou {@code anthropic}, selon
 * {@code assistant.provider}).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AssistantClientConfigDto(
        String provider,
        String model,
        /** {@code openai} ou {@code anthropic} — état configuré dans application.properties. */
        String routingDefault,
        /** Préférence utilisateur persistée (Mongo {@code appParameters}) ; absent si jamais enregistrée. */
        AssistantRoutingPreferenceDto persistedRouting) {}
