package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;

import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public record AssistantConversationSaveRequestDto(
        @NotEmpty @Size(max = 40) @Valid List<AssistantConversationTurnPersistDto> turns,
        @NotBlank @Size(max = 32) String routingProvider,
        @Size(max = 160) String providerLabel,
        @NotBlank @Size(max = 200) String model) {}
