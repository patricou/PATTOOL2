package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;

import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public record AssistantPdfExportRequestDto(
        @Size(max = 300) String title,
        @Size(max = 200) String exportedAt,
        @NotBlank @Size(max = 120) String youLabel,
        @NotBlank @Size(max = 120) String assistantLabel,
        @NotEmpty @Size(max = 400) @Valid List<AssistantPdfExportTurnDto> turns) {}
