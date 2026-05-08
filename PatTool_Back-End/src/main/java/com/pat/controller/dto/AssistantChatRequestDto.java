package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;

import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public record AssistantChatRequestDto(
        @NotEmpty(message = "messages must not be empty")
        @Valid
        List<AssistantTurnDto> messages,
        /** Optional Claude system prompt (short). */
        @Size(max = 8000) String system,
        /** Recherche web, génération d’images, MCP — active l’API Responses avec outils. */
        AssistantToolFlagsDto tools,
        /** Image analysée avec le dernier tour « user » (vision). */
        @Valid AssistantAttachedImageDto attachedImage,
        /**
         * Surcharge facultative du fournisseur pour ce tour : {@code openai}, {@code anthropic}, {@code claude}.
         * Si absent, le serveur utilise {@code assistant.provider}.
         */
        @Size(max = 32) String provider,
        /**
         * Surcharge facultative du modèle pour ce tour (sinon {@code openai.assistant.model} ou
         * {@code anthropic.model} selon le fournisseur effectif).
         */
        @Size(max = 160) String model
) {}
