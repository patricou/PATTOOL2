package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public record AssistantTurnMetaPersistDto(
        Integer elapsedMs,
        Integer inputTokens,
        Integer outputTokens,
        String provider,
        String model) {}
