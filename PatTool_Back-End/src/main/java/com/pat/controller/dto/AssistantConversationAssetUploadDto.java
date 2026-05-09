package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

@JsonIgnoreProperties(ignoreUnknown = true)
public record AssistantConversationAssetUploadDto(
        @NotBlank @Size(max = 80) String mimeType,
        @NotBlank String base64) {}
