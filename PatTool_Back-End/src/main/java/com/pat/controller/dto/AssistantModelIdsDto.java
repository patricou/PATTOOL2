package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * Identifiants de modèles exposés par le fournisseur (API {@code /v1/models} ou équivalent),
 * pour alimenter le sélecteur de l’assistant.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AssistantModelIdsDto(List<String> models) {}
