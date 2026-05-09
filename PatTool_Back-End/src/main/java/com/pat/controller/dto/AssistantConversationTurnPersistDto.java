package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public record AssistantConversationTurnPersistDto(
        @NotBlank String role,
        @Size(max = 500_000) String content,
        Boolean hasImage,
        String imageDataUrl,
        List<String> generatedImageAssetIds,
        @Valid AssistantTurnMetaPersistDto meta) {}
