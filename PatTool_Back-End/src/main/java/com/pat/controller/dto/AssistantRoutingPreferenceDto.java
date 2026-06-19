package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

/**
 * Fournisseur + choix de modèle persistés pour l'assistant (Mongo {@code appParameters},
 * une entrée par utilisateur).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AssistantRoutingPreferenceDto(
        @NotBlank
        @Pattern(regexp = "openai|anthropic|gemini|mistral")
        String provider,
        @NotBlank
        String modelPreset,
        String modelCustom
) {}
