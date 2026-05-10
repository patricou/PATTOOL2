package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Drapeaux d’outils pour l’assistant. Comportement dépend du fournisseur (recherche web Anthropic / Gemini,
 * images OpenAI / Gemini, MCP OpenAI uniquement — résolu côté serveur via {@code openai.mcp.*}).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record AssistantToolFlagsDto(Boolean webSearch, Boolean imageGeneration, Boolean mcp) {}
