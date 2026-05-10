package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

@JsonIgnoreProperties(ignoreUnknown = true)
public record AssistantTurnDto(
        @NotBlank String role,
        /** Contenu du message ; plafond élevé pour autoriser des jeux de données joints (ex. export JSON volumineux). */
        @NotBlank @Size(max = 500_000) String content
) {}
