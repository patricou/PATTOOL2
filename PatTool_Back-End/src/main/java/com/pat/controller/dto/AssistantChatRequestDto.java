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
        @Size(max = 8000) String system
) {}
