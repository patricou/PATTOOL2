package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Options d’outils OpenAI (API Responses). Le navigateur n’envoie que des drapeaux ;
 * MCP est résolu côté serveur ({@code openai.mcp.*}).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record AssistantToolFlagsDto(Boolean webSearch, Boolean imageGeneration, Boolean mcp) {}
