package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** Image jointe au dernier message utilisateur (vision). Base64 sans préfixe data: de préférence. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record AssistantAttachedImageDto(String mimeType, String base64) {}
