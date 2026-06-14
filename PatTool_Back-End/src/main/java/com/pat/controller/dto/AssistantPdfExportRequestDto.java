package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;

import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public record AssistantPdfExportRequestDto(
        @Size(max = 300) String title,
        @Size(max = 200) String exportedAt,
        @Size(max = 120) String youLabel,
        @Size(max = 120) String assistantLabel,
        @Size(max = 120) String authorUserName,
        @Size(max = 120) String authorFirstName,
        @Size(max = 120) String authorLastName,
        Boolean showFooter,
        @NotEmpty @Size(max = 400) @Valid List<AssistantPdfExportTurnDto> turns) {}
