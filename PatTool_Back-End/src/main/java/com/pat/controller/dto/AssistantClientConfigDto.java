package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Libellés affichables côté client, issus de {@code openai.provider} et {@code openai.assistant.model}.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AssistantClientConfigDto(String provider, String model) {}
